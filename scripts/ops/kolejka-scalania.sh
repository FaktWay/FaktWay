#!/usr/bin/env bash
# shellcheck disable=SC1111 # cudzysłowy „…” w komunikatach są celowe
# ════════════════════════════════════════════════════════════════
# Kolejka scalania w ochronie `main` (organizacja FaktWay, 14.11.2026)
# ────────────────────────────────────────────────────────────────
# Jedna linia, z katalogu repo, PO scaleniu PR, który dodaje `merge_group`
# do workflowów (inaczej wymagane kontrole nie zgłoszą się w kolejce i PR
# utkną):
#
#   ./scripts/ops/kolejka-scalania.sh            # pokazuje, co zmieni, i pyta
#   ./scripts/ops/kolejka-scalania.sh --tak      # bez pytania
#   ./scripts/ops/kolejka-scalania.sh --sprawdz  # tylko stan, bez zmian
#
# Zmienia ruleset „main - ochrona podstawowa”:
# - dodaje regułę kolejki (merge, do 3 grup budowanych naraz, czekanie na CI do
#   120 min: plan free ma 20 równoległych zadań, a grupa to ok. 15);
# - dopisuje wymagane kontrole: Filtr: straż, Filtr: testy prawne,
#   RLS isolation, Mobile (typy i eslint);
# - wyłącza „gałąź aktualna względem main” (to robi kolejka).
# Pozostałe reguły (zakaz usunięcia i force push, PR, obecne kontrole)
# zostają. Powrót: ten sam ruleset w panelu GitHuba albo `gh api` z kopią,
# którą skrypt zapisuje przed zmianą.
set -euo pipefail

REPO=FaktWay/FaktWay
NAZWA='main - ochrona podstawowa'
ACTIONS_APP=15368 # GitHub Actions: źródło wszystkich wymaganych kontroli
NOWE_KONTROLE='["Filtr: straż","Filtr: testy prawne","RLS isolation (lokalny Supabase)","Mobile (typy i eslint)"]'

TRYB=pytaj
case "${1:-}" in
  '') ;;
  --tak) TRYB=tak ;;
  --sprawdz) TRYB=sprawdz ;;
  *) echo "Nieznana opcja „$1”. Użycie: $0 [--tak|--sprawdz]" >&2; exit 2 ;;
esac

command -v gh >/dev/null || { echo "Brak gh (GitHub CLI)." >&2; exit 1; }
command -v jq >/dev/null || { echo "Brak jq." >&2; exit 1; }

id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$NAZWA\") | .id")
[ -n "$id" ] || { echo "Nie ma rulesetu „$NAZWA” w $REPO. Nic nie zmieniłem." >&2; exit 1; }

obecny=$(gh api "repos/$REPO/rulesets/$id")

pokaz() {
  jq -r '
    "kolejka: " + (if any(.rules[]; .type == "merge_queue") then "TAK" else "nie" end),
    "gałąź aktualna (strict): " + ((.rules[] | select(.type == "required_status_checks") | .parameters.strict_required_status_checks_policy) | tostring),
    "wymagane kontrole:",
    (.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[] | "  - " + .context)
  ' <<<"$1"
}

echo "── Ruleset $id ($NAZWA), teraz:"
pokaz "$obecny"
if [ "$TRYB" = sprawdz ]; then
  # Sekret z kontem człowieka: bez niego workflow „Scalanie na etykietę” niczego
  # nie włącza (token Actions nie uruchamia kontroli grupy kolejki).
  if gh secret list -R "$REPO" 2>/dev/null | cut -f1 | grep -qx SCAL_TOKEN; then
    echo "sekret SCAL_TOKEN: jest (workflow włącza scalanie kontem człowieka, także dla sesji chmurowych)"
  else
    echo "sekret SCAL_TOKEN: BRAK (sesje lokalne włączają scalanie same przez scal-pr.sh, sesje chmurowe potrzebują sekretu: docs/runbooks/scalanie-pr.md, „Sekret SCAL_TOKEN”)"
  fi
  exit 0
fi

nowy=$(jq --argjson nowe "$NOWE_KONTROLE" --argjson app "$ACTIONS_APP" '
  {
    name, target, enforcement, conditions, bypass_actors,
    rules: (
      [ .rules[]
        | select(.type != "merge_queue")
        | if .type == "required_status_checks" then
            .parameters.strict_required_status_checks_policy = false
            | .parameters.required_status_checks = (
                .parameters.required_status_checks
                + [ $nowe[] as $k | {context: $k, integration_id: $app} ]
                | unique_by(.context)
              )
          else . end
      ]
      + [ {
          type: "merge_queue",
          parameters: {
            merge_method: "MERGE",
            # ALLGREEN: każdy wpis kolejki ma własną ocenę (straż w kolejce
            # ocenia tylko ostatni PR grupy, filtr-straz.yml).
            grouping_strategy: "ALLGREEN",
            max_entries_to_build: 3,
            max_entries_to_merge: 3,
            min_entries_to_merge: 1,
            min_entries_to_merge_wait_minutes: 1,
            check_response_timeout_minutes: 120
          }
        } ]
    )
  }' <<<"$obecny")

echo "── Po zmianie:"
pokaz "$nowy"

if [ "$TRYB" = pytaj ]; then
  read -r -p "Zapisać tę ochronę main? [t/N] " odp
  [ "$odp" = t ] || [ "$odp" = T ] || { echo "Nic nie zmieniłem."; exit 0; }
fi

kopia="${TMPDIR:-/tmp}/ruleset-$id-przed-kolejka-$(date +%Y%m%d%H%M%S).json"
printf '%s\n' "$obecny" >"$kopia"
echo "── Kopia stanu sprzed zmiany: $kopia"

gh api -X PUT "repos/$REPO/rulesets/$id" --input - <<<"$nowy" >/dev/null
echo "── Zapisane. Stan z GitHuba:"
pokaz "$(gh api "repos/$REPO/rulesets/$id")"

# Etykiety scalania na etykietę (workflow „Scalanie na etykietę”): `scal` włącza
# automatyczne scalanie, `wstrzymaj` je wstrzymuje. Zakładane po zapisie ochrony.
gh label create "scal" --repo "$REPO" --force --color 0E8A16 \
  --description "Agent: scal, gdy kontrole będą zielone (wygasa po pushu)"
gh label create "wstrzymaj" --repo "$REPO" --force --color B60205 \
  --description "Nie scalaj: agenci i workflow wstrzymują scalanie"
echo "── Etykiety scal i wstrzymaj założone."
echo "Agent scala PR jedną linią (etykieta scal, działa też w chmurze): ./scripts/ops/scal-pr.sh N"
echo "Zapas lokalny: gh pr merge N --auto"
echo "PR otwarte przed zmianą nie mają nowych wymaganych kontroli: ./scripts/ops/odswiez-pr.sh pokazuje je, a z numerami odświeża."
