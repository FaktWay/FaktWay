#!/usr/bin/env bash
# shellcheck disable=SC1111 # cudzysłowy „…” w komunikatach są celowe
# ════════════════════════════════════════════════════════════════
# Odświeżenie kontroli PR po włączeniu kolejki scalania (bez zmiany kodu)
# ────────────────────────────────────────────────────────────────
# PR otwarty przed włączeniem kolejki (`kolejka-scalania.sh --tak`) nie ma
# nowych wymaganych kontroli: „Mobile (typy i eslint)”, „Filtr: straż”,
# „Filtr: testy prawne”, „RLS isolation (lokalny Supabase)”. Ruleset czeka na
# nie w nieskończoność. Odświeżenie to zamknięcie i otwarcie PR: zdarzenie
# `reopened` uruchamia aktualne workflowy z `main`, a kod PR się nie zmienia.
#
#   ./scripts/ops/odswiez-pr.sh              # tylko lista PR z brakami (odczyt)
#   ./scripts/ops/odswiez-pr.sh 771 768      # odświeża wskazane PR
#
# Tylko REST (`gh api`), więc działa też w sesji chmurowej. Nie dotyka
# szkiców, PR z konfliktem (podaje polecenie `git merge origin/main`) ani PR
# z etykietą `scal` albo włączonym automatycznym scalaniem (np. `gh pr merge
# N --auto`): są w drodze do kolejki, a zamknięcie wyjęłoby je z niej.
# Czerwona „Filtr: straż” z braku etykiet zgody albo karty zostaje czerwona
# także po odświeżeniu: odświeżenie ocenia ją tylko według aktualnych reguł.

set -euo pipefail

REPO=FaktWay/FaktWay
WYMAGANE_NOWE='Mobile (typy i eslint)
Filtr: straż
Filtr: testy prawne
RLS isolation (lokalny Supabase)'

say() { printf '%s\n' "$*"; }
die() { printf '✘ %s\n' "$*" >&2; exit 1; }

for n in "$@"; do
  case "$n" in
    ''|*[!0-9]*) echo "To nie jest numer PR: „$n”. Użycie: $0 [N ...]" >&2; exit 2 ;;
  esac
done
command -v gh >/dev/null || die "Brak gh (GitHub CLI)."

# Najnowszy przebieg każdej kontroli (największe id) jako wiersze „nazwa|wynik”;
# wynik to conclusion albo status, gdy kontrola jeszcze trwa.
najnowsze() {
  gh api --paginate "repos/$REPO/commits/$1/check-runs?per_page=100" \
    --jq '.check_runs[] | "\(.name)|\(.id)|\(.conclusion // .status)"' \
    | awk -F'|' '{ if (!($1 in id) || $2 + 0 > id[$1] + 0) { id[$1] = $2; wynik[$1] = $3 } } END { for (n in id) print n "|" wynik[n] }'
}

# Dla PR wypisuje jedną linię: ok | szkic | scal | konflikt | nieczytelny |
# braki: … (kod zawsze 0). `scal` znaczy „w drodze do scalenia”: etykieta scal
# albo włączone automatyczne scalanie (np. `gh pr merge N --auto`); zamknięcie
# takiego PR wyjęłoby go z kolejki. Pola PR: szkic|SHA|stan scalalności|
# automatyczne scalanie|etykiety.
ocen() {
  local numer=$1 info szkic sha mstan automerge etykiety wiersze braki="" brak straz
  info=$(gh api "repos/$REPO/pulls/$numer" --jq '[(.draft | tostring), .head.sha, (.mergeable_state // "unknown"), ((.auto_merge != null) | tostring), ([.labels[].name] | join(","))] | join("|")') \
    || { echo "nieczytelny"; return 0; }
  IFS='|' read -r szkic sha mstan automerge etykiety <<<"$info"
  [ "$szkic" != true ] || { echo "szkic"; return 0; }
  [ "$automerge" != true ] || { echo "scal"; return 0; }
  case ",$etykiety," in *,scal,*) echo "scal"; return 0 ;; esac
  [ "$mstan" != dirty ] || { echo "konflikt"; return 0; }
  wiersze=$(najnowsze "$sha") || { echo "nieczytelny"; return 0; }
  while IFS= read -r brak; do
    printf '%s\n' "$wiersze" | grep -qF "$brak|" || braki="${braki:+$braki; }brak kontroli „$brak”"
  done <<<"$WYMAGANE_NOWE"
  straz=$(printf '%s\n' "$wiersze" | grep -F 'Filtr: straż|' | cut -d'|' -f2 || true)
  case "$straz" in
    failure|cancelled|timed_out) braki="${braki:+$braki; }„Filtr: straż”: $straz" ;;
  esac
  if [ -n "$braki" ]; then echo "braki: $braki"; else echo "ok"; fi
}

if [ "$#" -eq 0 ]; then
  # ─── Tryb odczytu: lista otwartych PR z brakami ──
  lista=$(gh api --paginate "repos/$REPO/pulls?state=open&per_page=100" --jq '.[] | "\(.number)|\(.title)"') \
    || die "Nie mogę odczytać listy otwartych PR."
  do_odswiezenia=""
  while IFS='|' read -r numer tytul; do
    [ -n "$numer" ] || continue
    wynik=$(ocen "$numer")
    case "$wynik" in
      ok) ;;
      szkic) say "  #$numer szkic, pomijam ($tytul)" ;;
      scal) say "  #$numer ma scal albo włączone scalanie (w drodze do kolejki), pomijam ($tytul)" ;;
      konflikt) say "✘ #$numer konflikt z main ($tytul): na jego gałęzi git fetch origin && git merge origin/main, rozwiąż, push" ;;
      nieczytelny) say "? #$numer nie mogę odczytać PR ($tytul)" ;;
      braki:*) say "✘ #$numer ${wynik#braki: } ($tytul)"; do_odswiezenia="$do_odswiezenia $numer" ;;
    esac
  done <<<"$lista"
  if [ -n "$do_odswiezenia" ]; then
    say ""
    say "Odświeżenie (zamknięcie i otwarcie, kod bez zmian):"
    say "  ./scripts/ops/odswiez-pr.sh$do_odswiezenia"
  else
    say "Żaden otwarty PR nie ma braków w kontrolach."
  fi
  exit 0
fi

# ─── Odświeżenie wskazanych PR ──
kod=0
for numer in "$@"; do
  wynik=$(ocen "$numer")
  case "$wynik" in
    szkic) say "  #$numer szkic: pomijam (oznacz jako gotowy do przeglądu, potem odśwież)"; continue ;;
    scal) say "  #$numer ma scal albo włączone scalanie: pomijam (zamknięcie wyjęłoby go z drogi do kolejki; zdejmij scal i wyłącz scalanie, jeśli chcesz odświeżyć)"; continue ;;
    konflikt) say "✘ #$numer ma konflikt z main: na jego gałęzi git fetch origin && git merge origin/main, rozwiąż, push (push uruchomi kontrole sam)"; kod=1; continue ;;
    nieczytelny) say "✘ #$numer: nie mogę odczytać PR"; kod=1; continue ;;
    ok) say "  #$numer nie ma braków w kontrolach; odświeżam mimo to na Twoje polecenie" ;;
  esac
  if gh api -X PATCH "repos/$REPO/pulls/$numer" -f state=closed >/dev/null && gh api -X PATCH "repos/$REPO/pulls/$numer" -f state=open >/dev/null; then
    say "✔ #$numer odświeżony (zamknięty i otwarty ponownie): kontrole ruszą od nowa"
  else
    # Zamknięty bez ponownego otwarcia to zła pozycja wyjściowa: dopinamy.
    gh api -X PATCH "repos/$REPO/pulls/$numer" -f state=open >/dev/null 2>&1 || true
    say "✘ #$numer: odświeżenie nie przeszło; sprawdź stan: gh api repos/$REPO/pulls/$numer --jq .state"
    kod=1
  fi
done
exit "$kod"
