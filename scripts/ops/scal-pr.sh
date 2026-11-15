#!/usr/bin/env bash
# shellcheck disable=SC1111 # cudzysłowy „…” w komunikatach są celowe
# ════════════════════════════════════════════════════════════════
# Scalanie PR przez etykietę `scal` (jedna ścieżka dla każdego środowiska)
# ────────────────────────────────────────────────────────────────
# Jedna linia, z dowolnego katalogu, tylko REST (`gh api`), bez GraphQL, więc
# działa też w sesji chmurowej, gdzie `gh pr merge` i `gh pr edit` nie działają:
#
#   ./scripts/ops/scal-pr.sh 776
#   ./scripts/ops/scal-pr.sh 776 --czekaj
#   ./scripts/ops/scal-pr.sh 757 --zgoda zmiana-filtra --po-drugim-czytelniku
#
# Co robi (docs/runbooks/scalanie-pr.md):
#   a. czyta PR: ma być otwarty, nie szkic, baza `main`, głowa z tego repo,
#      bez konfliktu z `main` i bez etykiety `wstrzymaj`;
#   b. sprawdza kontrole na SHA głowy: czerwonej, anulowanej albo przeterminowanej
#      NIE obchodzi (odmowa z jej nazwą), w toku jest w porządku, automat poczeka;
#   c. `--zgoda X` nadaje etykietę `zgoda:X` PRZED `scal`. Wymaga flagi
#      `--po-drugim-czytelniku`: potwierdzasz, że drugi czytelnik przeczytał zmianę
#      i nie ma otwartych uwag. Skrypt tego nie sprawdzi, ale wymusza ten krok;
#   d. nadaje etykietę `scal`. Workflow „Scalanie na etykietę” włącza wtedy
#      automatyczne scalanie: PR wchodzi do kolejki po zielonych kontrolach.
#      PR, który ma już włączone scalanie albo jest w kolejce, zostaje bez
#      zmian (ponowne nadanie etykiety wyjęłoby go z kolejki);
#   e. `--czekaj` odpytuje GitHuba co 30 s (do 45 min) i wypisuje MERGED albo
#      powód, dla którego PR nie wszedł.
# Nowy push zdejmuje `scal` i etykiety zgody: nadajesz je od nowa po przeglądzie.
#
# Nigdy nie scala szkiców ani PR z forków, nie używa `--admin`. Zmienne
# `SCAL_ODSTEP` (sekundy, 30) i `SCAL_LIMIT_MIN` (minuty, 45) zmieniają czekanie.

set -euo pipefail

REPO=FaktWay/FaktWay

say() { printf '%s\n' "$*"; }
die() { printf '✘ %s\n' "$*" >&2; exit 1; }

uzycie() {
  cat <<'TXT'
Użycie:
  ./scripts/ops/scal-pr.sh N [--zgoda zmiana-filtra|wiedza-prawna|wyjatek-filtra ...]
                             [--po-drugim-czytelniku] [--czekaj]
TXT
}

if [ "$#" -lt 1 ]; then uzycie >&2; exit 2; fi
case "$1" in
  -h|--help) uzycie; exit 0 ;;
esac
NUMER=$1
shift
case "$NUMER" in
  ''|*[!0-9]*) echo "Pierwszy argument to numer PR, jest: „$NUMER”." >&2; uzycie >&2; exit 2 ;;
esac

ZGODY=""
PO_DRUGIM=0
CZEKAJ=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --zgoda)
      [ "$#" -ge 2 ] || { uzycie >&2; exit 2; }
      case "$2" in
        zmiana-filtra|wiedza-prawna|wyjatek-filtra) ZGODY="$ZGODY $2" ;;
        *) echo "Nieznana zgoda „$2”. Dozwolone: zmiana-filtra, wiedza-prawna, wyjatek-filtra." >&2; exit 2 ;;
      esac
      shift 2
      ;;
    --po-drugim-czytelniku) PO_DRUGIM=1; shift ;;
    --czekaj) CZEKAJ=1; shift ;;
    -h|--help) uzycie; exit 0 ;;
    *) echo "Nieznana opcja „$1”." >&2; uzycie >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null || die "Brak gh (GitHub CLI)."

if [ -n "$ZGODY" ] && [ "$PO_DRUGIM" != 1 ]; then
  die "Etykiety zgody nadaje się po drugim czytelniku (osobny agent z listą docs/filtr/LISTA-KONTROLNA.md), który nie zostawił otwartych uwag. Potwierdź to flagą --po-drugim-czytelniku. Nic nie zmieniłem."
fi

ODSTEP=${SCAL_ODSTEP:-30}
LIMIT_MIN=${SCAL_LIMIT_MIN:-45}

# Pola PR oddzielone „|” (tylko wartości bez „|”): stan, scalony, szkic, baza,
# repozytorium głowy, SHA głowy, stan scalalności, czy włączone automatyczne
# scalanie, etykiety po przecinku (ostatnie, bo mogą być puste).
odczytaj_pr() {
  gh api "repos/$REPO/pulls/$NUMER" --jq '[.state, (.merged | tostring), (.draft | tostring), .base.ref, (.head.repo.full_name // "-"), .head.sha, (.mergeable_state // "unknown"), ((.auto_merge != null) | tostring), ([.labels[].name] | join(","))] | join("|")'
}

# Najnowszy przebieg każdej kontroli (kontrola z tą samą nazwą bywa
# anulowana przez nowszy przebieg, więc liczy się ten z największym id):
# wiersze „nazwa (wynik)” tylko dla czerwonych.
czerwone() {
  gh api --paginate "repos/$REPO/commits/$1/check-runs?per_page=100" \
    --jq '.check_runs[] | "\(.name)|\(.id)|\(.conclusion // "")"' \
    | awk -F'|' '
        { if (!($1 in id) || $2 + 0 > id[$1] + 0) { id[$1] = $2; wynik[$1] = $3 } }
        END {
          for (n in id)
            if (wynik[n] == "failure" || wynik[n] == "timed_out" || wynik[n] == "cancelled" || wynik[n] == "action_required" || wynik[n] == "startup_failure")
              print n " (" wynik[n] ")"
        }' | sort
}

# Zdarzenia kolejki scalania tego PR po kolei (added_to_merge_queue albo
# removed_from_merge_queue), jedno na linię. Błąd odczytu to kod różny od 0.
zdarzenia_kolejki() {
  gh api --paginate "repos/$REPO/issues/$NUMER/events?per_page=100" \
    --jq '.[] | select(.event == "added_to_merge_queue" or .event == "removed_from_merge_queue") | .event'
}

# Ile razy PR wypadł z kolejki do tej pory.
liczba_wyrzucen() {
  local zdarzenia
  zdarzenia=$(zdarzenia_kolejki) || return 1
  printf '%s\n' "$zdarzenia" | grep -c '^removed_from_merge_queue$' || true
}

dodaj_etykiete() {
  gh api -X POST "repos/$REPO/issues/$NUMER/labels" -f "labels[]=$1" >/dev/null
}

# ─── a. PR ───────────────────────────────────────────────────────
info=$(odczytaj_pr) || die "Nie mogę odczytać PR #$NUMER w $REPO (brak PR albo brak dostępu)."
IFS='|' read -r stan scalony szkic baza glowa sha mstan automerge etykiety <<<"$info"
[ "$stan" = open ] || die "PR #$NUMER ma stan „$stan” (scalony: $scalony). Nic nie zmieniłem."
[ "$szkic" != true ] || die "PR #$NUMER jest szkicem. Szkiców się nie scala; oznacz go jako gotowy do przeglądu. Nic nie zmieniłem."
[ "$baza" = main ] || die "PR #$NUMER ma bazę „$baza”, a scalać wolno tylko do main (stos: po scaleniu poprzednika przestaw bazę: gh api -X PATCH repos/$REPO/pulls/$NUMER -f base=main). Nic nie zmieniłem."
[ "$glowa" = "$REPO" ] || die "Gałąź PR #$NUMER jest z „$glowa”, nie z $REPO (fork). Nic nie zmieniłem."
case ",$etykiety," in
  *,wstrzymaj,*) die "PR #$NUMER ma etykietę wstrzymaj. Zdejmij ją, gdy wolno scalać. Nic nie zmieniłem." ;;
esac
[ "$mstan" != dirty ] || die "PR #$NUMER ma konflikt z main. Na swojej gałęzi: git fetch origin && git merge origin/main, rozwiąż, push, potem skrypt od nowa. Nic nie zmieniłem."
say "✔ PR #$NUMER: otwarty, nie szkic, baza main, głowa ${sha:0:7}"

# ─── b. kontrole ─────────────────────────────────────────────────
red=$(czerwone "$sha") || die "Nie mogę odczytać kontroli PR #$NUMER."
if [ -n "$ZGODY" ]; then
  # Straż jest czerwona właśnie z braku etykiet, które za chwilę nadamy.
  red=$(printf '%s\n' "$red" | grep -v '^Filtr: straż ' || true)
fi
if [ -n "$red" ]; then
  printf '%s\n' "$red" | sed 's/^/   czerwona kontrola: /' >&2
  die "Czerwonej kontroli się nie obchodzi: napraw ją na swojej gałęzi (a brak etykiet zgody dla „Filtr: straż” uzupełnij flagą --zgoda … --po-drugim-czytelniku). Nic nie zmieniłem."
fi
say "✔ kontrole: żadna nie jest czerwona (te w toku automat poczeka)"

kolejka=$(zdarzenia_kolejki) || die "Nie mogę odczytać zdarzeń kolejki PR #$NUMER. Nic nie zmieniłem."
wyrzucen_przed=$(printf '%s\n' "$kolejka" | grep -c '^removed_from_merge_queue$' || true)
# Już w drodze do scalenia (włączone scalanie albo PR jest w kolejce): zdjęcie
# i ponowne nadanie scal wyjęłoby go z kolejki i oddało w niej miejsce.
w_drodze=0
if [ "$automerge" = true ] || [ "$(printf '%s\n' "$kolejka" | tail -n 1)" = added_to_merge_queue ]; then
  w_drodze=1
fi

# ─── c. etykiety zgody (przed scal) ──────────────────────────────
for z in $ZGODY; do
  dodaj_etykiete "zgoda:$z" || die "Nie nadałem etykiety zgoda:$z (brak uprawnień? konto musi być na liście filtr/zgody.json)."
  say "✔ etykieta zgoda:$z nadana"
done
if [ -n "$ZGODY" ]; then
  # Straż liczy się od nowa po zdarzeniu labeled: czekamy, aż nie będzie czerwona.
  zwlokaPrzedScal=${SCAL_ODSTEP_STRAZ:-10}
  for proba in 1 2 3 4 5 6 7 8 9; do
    sleep "$zwlokaPrzedScal"
    straz=$(czerwone "$sha" | grep '^Filtr: straż ' || true)
    [ -n "$straz" ] || break
    [ "$proba" != 9 ] || die "„Filtr: straż” jest nadal czerwona po nadaniu etykiet (${straz}). Sprawdź jej raport w zakładce Checks PR #$NUMER. Etykiety zgody zostały, etykiety scal nie nadałem."
  done
fi

# ─── d. etykieta scal ────────────────────────────────────────────
sprawdzaj_etykiete=1
if [ "$w_drodze" = 1 ]; then
  say "✔ PR #$NUMER ma już włączone scalanie albo jest w kolejce: etykiety scal nie ruszam, żeby nie stracić miejsca"
  case ",$etykiety," in *,scal,*) ;; *) sprawdzaj_etykiete=0 ;; esac
else
  case ",$etykiety," in
    *,scal,*)
      # GitHub nie wysyła zdarzenia, gdy etykieta już jest, a scalanie nie jest
      # włączone (np. po wyrzuceniu z kolejki): zdejmujemy i nadajemy od nowa.
      say "   etykieta scal już była, a scalanie nie jest włączone: ponawiam"
      gh api -X DELETE "repos/$REPO/issues/$NUMER/labels/scal" >/dev/null 2>&1 || true
      ;;
  esac
  dodaj_etykiete scal || die "Nie nadałem etykiety scal (brak uprawnień? konto musi być na liście filtr/zgody.json)."
  say "✔ etykieta scal nadana: workflow „Scalanie na etykietę” włączy scalanie, PR wejdzie do kolejki po zielonych kontrolach"
fi

if [ "$CZEKAJ" != 1 ]; then
  say "Stan: gh api repos/$REPO/pulls/$NUMER --jq '{state, merged}'; powód odmowy workflow: ostatni komentarz PR (gh api repos/$REPO/issues/$NUMER/comments --jq '.[-1].body')."
  exit 0
fi

# ─── e. czekanie ─────────────────────────────────────────────────
proby=$((LIMIT_MIN * 60 / ODSTEP))
[ "$proby" -ge 1 ] || proby=1
say "Czekam na scalenie (do $LIMIT_MIN min, sprawdzam co $ODSTEP s)…"
n=0
while [ "$n" -lt "$proby" ]; do
  sleep "$ODSTEP"
  n=$((n + 1))
  info=$(odczytaj_pr) || { echo "   $(date +%H:%M) brak odpowiedzi GitHuba, próbuję dalej" >&2; continue; }
  IFS='|' read -r stan scalony _szkic _baza _glowa sha _mstan _automerge etykiety <<<"$info"
  if [ "$scalony" = true ]; then
    say "MERGED PR #$NUMER: $(gh api "repos/$REPO/pulls/$NUMER" --jq '.merge_commit_sha // "-"')"
    exit 0
  fi
  [ "$stan" = open ] || die "PR #$NUMER zamknięty bez scalenia."
  if [ "$sprawdzaj_etykiete" = 1 ]; then
    case ",$etykiety," in
      *,scal,*) ;;
      *)
        echo "Etykieta scal została zdjęta (workflow odmówił albo był nowy push). Ostatni komentarz PR:" >&2
        gh api "repos/$REPO/issues/$NUMER/comments" --jq '.[-1].body // "(brak komentarza)"' >&2 || true
        exit 1
        ;;
    esac
  fi
  red=$(czerwone "$sha" || true)
  if [ -n "$red" ]; then
    printf '%s\n' "$red" | sed 's/^/   czerwona kontrola: /' >&2
    die "PR #$NUMER ma czerwoną kontrolę, więc nie wejdzie do kolejki. Napraw na swojej gałęzi, potem skrypt od nowa."
  fi
  if [ "$(liczba_wyrzucen || echo 0)" -gt "$wyrzucen_przed" ]; then
    die "PR #$NUMER wypadł z kolejki scalania (konflikt albo czerwony test na commicie grupy z main i PR przed nim). Napraw na swojej gałęzi (git merge origin/main), push i skrypt od nowa."
  fi
  echo "   $(date +%H:%M) PR #$NUMER czeka (kontrole w toku albo w kolejce)"
done
echo "PR #$NUMER nie został scalony w $LIMIT_MIN min. Sprawdź kolejkę: gh api repos/$REPO/pulls/$NUMER --jq '{state, merged}' i zakładkę Merge queue." >&2
exit 3
