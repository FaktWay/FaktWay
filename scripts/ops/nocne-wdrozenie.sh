#!/usr/bin/env bash
# shellcheck disable=SC1111 # cudzysłowy „…” w komunikatach są celowe
# ════════════════════════════════════════════════════════════════
# Nocne wdrożenie: migracje po kontroli, worker, aplikacja, weryfikacja
# ────────────────────────────────────────────────────────────────
# Co noc uruchamia je timer na ops-1 (scripts/hetzner/systemd/
# faktway-nocne-wdrozenie.timer, instalacja: zainstaluj-nocne-wdrozenie.sh).
# Ręcznie, z katalogu repo (np. z Maca, bez skutków ubocznych):
#
#   ./scripts/ops/nocne-wdrozenie.sh --sucho          # tylko odczyty i plan
#   ./scripts/ops/nocne-wdrozenie.sh --teraz          # prawdziwy przebieg poza oknem nocnym
#   ./scripts/ops/nocne-wdrozenie.sh --sha <40 znaków> # ten SHA z main zamiast origin/main
#   ./scripts/ops/nocne-wdrozenie.sh --test-raportu    # jedna wiadomość próbna na Telegram
#
# Kolejność (docs/runbooks/nocne-wdrozenie.md):
#   1. wstrzymanie (plik STOP), okno nocne, blokada przed drugim przebiegiem;
#   2. SHA = origin/main pinowany na cały przebieg; jest już wdrożony? koniec;
#   3. bramki: CI na SHA zielone, obrazy w GHCR, brak wdrożeń w Coolify,
#      wolne miejsce na app-1; ktoś wdrożył nowszy kod ręcznie? koniec;
#   4. migracje oczekujące: kontrola (kontrola-migracji.mjs); cokolwiek
#      zablokowane albo zła kolejność = nic nie wgrywam i nic nie wdrażam;
#      kopia bazy nie starsza niż 26 h;
#   5. migracje „PRZED” (wgraj-migracje.sh, SHA przypięty WGRAJ_REF);
#   6. wdrożenie: wdroz-produkcje.sh --obraz SHA (worker, potem aplikacja,
#      kontrola); przy porażce ratunek: powrót na poprzedni SHA;
#   7. migracje „PO wdrożeniu”;
#   8. raport na Telegram (token w /etc/faktway-nocne.env) i ping Healthchecks.
#
# Kod wyjścia: 0 = nic do roboty, wstrzymane, bramka nie przepuściła (z raportem)
# albo wdrożone; 1 = coś poszło źle i potrzebny jest człowiek (raport 🔴).
# Nic nie jest kasowane ani cofane poza powrotem obrazów na poprzedni SHA.

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=scripts/ops/coolify-wspolne.sh
source "$ROOT/scripts/ops/coolify-wspolne.sh"

REPO=${NOCNE_REPO:-FaktWay/FaktWay}
NOCNE_STOP=${NOCNE_STOP:-/etc/faktway-nocne/STOP}
NOCNE_ENV=${NOCNE_ENV:-/etc/faktway-nocne.env}
NOCNE_LOG_DIR=${NOCNE_LOG_DIR:-/var/log/faktway-nocne}
NOCNE_MAX_KOPIA_H=${NOCNE_MAX_KOPIA_H:-26}
NOCNE_CI_CZEKAJ_MIN=${NOCNE_CI_CZEKAJ_MIN:-20}
NOCNE_OBRAZY_CZEKAJ_MIN=${NOCNE_OBRAZY_CZEKAJ_MIN:-25}
NOCNE_OKNO_OD=${NOCNE_OKNO_OD:-1}
NOCNE_OKNO_DO=${NOCNE_OKNO_DO:-5}
# Kontrole, bez których commit na main nie jest „zielony” (obecność, nie tylko brak czerwonych).
NOCNE_WYMAGANE_CI=${NOCNE_WYMAGANE_CI:-"Typecheck + Lint + Unit tests|Next build|RLS isolation (lokalny Supabase)"}

SUCHO=0
TERAZ=0
TEST_RAPORTU=0
SHA_ARG=""

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

# ── Raporty ──────────────────────────────────────────────────────

# Telegram: token idzie do curl przez stdin (`-K -`), nie w linii poleceń
# (lista procesów) i nigdy do logu.
telegram() {
  [ "$SUCHO" = 0 ] || return 0
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_IDS:-}" ] || return 0
  local tekst=${1:0:3900} id
  local -a ids
  IFS=',' read -r -a ids <<<"$TELEGRAM_CHAT_IDS"
  for id in "${ids[@]}"; do
    printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TELEGRAM_BOT_TOKEN" \
      | curl -fsS --max-time 20 -o /dev/null -K - --data-urlencode "chat_id=$id" --data-urlencode "text=$tekst" \
      || log "Telegram: nie wysłano raportu do jednego z adresatów (kod $?)."
  done
}

ping_hc() {
  [ "$SUCHO" = 0 ] || return 0
  [ -n "${NOCNE_HC_URL:-}" ] || return 0
  curl -fsS --max-time 15 -o /dev/null "${NOCNE_HC_URL}${1:-}" >/dev/null 2>&1 || true
}

# raport <ok|uwaga|blad> <tytuł> <treść>: do logu zawsze, na Telegram poza --sucho.
raport() {
  local poziom=$1 tytul=$2 tresc=${3:-} znak
  case "$poziom" in
    ok) znak="✅" ;;
    uwaga) znak="⚠️" ;;
    *) znak="🔴" ;;
  esac
  log "$znak $tytul"
  [ -z "$tresc" ] || printf '%s\n' "$tresc"
  telegram "$znak FaktWay, nocne wdrożenie: $tytul${tresc:+
$tresc}"
}

# ── Odczyty ──────────────────────────────────────────────────────

# Czas w Warszawie (godzina 0-23), przez TZ, bo serwer chodzi w UTC.
godzina_warszawa() { TZ=Europe/Warsaw date +%H | sed 's/^0//; s/^$/0/'; }

skrot() { printf '%s' "${1:0:8}"; }

# stdout: „zielone”, „w-toku:N”, „czerwone:nazwy”, „brak” albo „brak-odpowiedzi”.
# Zielone = wszystkie kontrole ukończone bez czerwonych ORAZ obecne wymagane.
ci_stan() {
  local sha=$1 json naglowki=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then naglowki=(-H "Authorization: Bearer $GITHUB_TOKEN"); fi
  json=$(curl -fsS --max-time 30 -H 'Accept: application/vnd.github+json' "${naglowki[@]+"${naglowki[@]}"}" \
    "https://api.github.com/repos/$REPO/commits/$sha/check-runs?per_page=100") || { echo "brak-odpowiedzi"; return 0; }
  jq -r --arg wymagane "$NOCNE_WYMAGANE_CI" '
    [.check_runs[] | {n: .name, s: .status, c: (.conclusion // "")}] as $k
    | ($wymagane | split("|")) as $w
    | if ($k | length) == 0 then "brak"
      elif ([$k[] | select(.s != "completed")] | length) > 0 then "w-toku:" + ([$k[] | select(.s != "completed")] | length | tostring)
      elif ([$k[] | select(.c | IN("success", "skipped", "neutral") | not)] | length) > 0 then "czerwone:" + ([$k[] | select(.c | IN("success", "skipped", "neutral") | not) | .n] | join(","))
      elif ([$w[] as $n | select([$k[] | select(.n == $n and .c == "success")] | length == 0) | $n] | length) > 0 then "brak-wymaganych:" + ([$w[] as $n | select([$k[] | select(.n == $n and .c == "success")] | length == 0) | $n] | join(","))
      else "zielone" end' <<<"$json" 2>/dev/null || echo "brak-odpowiedzi"
}

czekaj_na_ci() {
  local sha=$1 minuty=$2 stan i=0
  while :; do
    stan=$(ci_stan "$sha")
    case "$stan" in
      w-toku:*|brak) ;;
      *) echo "$stan"; return 0 ;;
    esac
    [ "$i" -lt "$minuty" ] || { echo "$stan"; return 0; }
    i=$((i + 1))
    sleep 60
  done
}

on_db() { ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=20 root@"$DB" "$@"; }

psql_odczyt() {
  on_db "docker exec $PGC psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At -c \"$1\""
}

# Numery migracji z SHA, których nie ma w schema_migrations. Pusty wynik
# poprawnego odczytu = brak oczekujących. Błąd odczytu = kod 1 (NIE „wszystko
# oczekuje”: wgrywanie wszystkiego od zera byłoby katastrofą).
oczekujace_migracje() {
  local sha=$1 wersje repo
  wersje=$(psql_odczyt "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version") || return 1
  [ -n "$wersje" ] || return 1
  repo=$(git -C "$ROOT" ls-tree --name-only "$sha" supabase/migrations/ | sed -n 's#.*/\([0-9]\{5\}\)_.*\.sql$#\1#p' | sort) || return 1
  [ -n "$repo" ] || return 1
  comm -23 <(printf '%s\n' "$repo") <(printf '%s\n' "$wersje" | sort)
}

# Wiek ostatniej udanej kopii bazy w godzinach (całkowite) z backup_log; puste = brak odczytu.
wiek_kopii_h() {
  psql_odczyt "SELECT floor(extract(epoch FROM now() - max(started_at)) / 3600)::int FROM public.backup_log WHERE status = 'success'" 2>/dev/null | tr -dc '0-9' || true
}

# Liczba wdrożeń w kolejce Coolify (queued albo in_progress); puste = brak odczytu.
aktywne_wdrozenia() {
  tinker <<'PHP' | grep -o 'WD_AKTYWNE=[0-9]*' | tail -n 1 | cut -d= -f2 || true
echo "WD_" . "AKTYWNE=" . App\Models\ApplicationDeploymentQueue::whereIn('status', ['queued', 'in_progress'])->count() . "\n";
PHP
}

# ── Czynności (testy je podmieniają) ─────────────────────────────

# Kontrola migracji z SHA: JSON {przed, po, zablokowane, kolejnosc}. Kod 3 = blokada.
kontrola_migracji() {
  node "$ROOT/scripts/ops/kontrola-migracji.mjs" --json --git "$1" "${@:2}"
}

wgraj_migracje() {
  local sha=$1
  shift
  WGRAJ_REF=$sha WGRAJ_PGOPTIONS='-c lock_timeout=15s -c statement_timeout=900000' \
    "$ROOT/scripts/ops/wgraj-migracje.sh" "$@"
}

wdroz() {
  "$ROOT/scripts/ops/wdroz-produkcje.sh" --obraz "$1"
}

lista_zmian() {
  git -C "$ROOT" log --first-parent --format='• %s' "$1..$2" 2>/dev/null | head -20
}

# ── Przebieg ─────────────────────────────────────────────────────

uzycie() {
  cat <<'TXT'
Użycie: nocne-wdrozenie.sh [--sucho] [--teraz] [--sha <40 znaków>] [--test-raportu]
  --sucho  tylko odczyty i plan; nic nie zmienia, bez Telegramu i pingów
  --teraz  pomija okno nocne (01:00-05:59 czasu Warszawy)
  --sha    wdraża ten SHA z main zamiast origin/main
  --test-raportu  wysyła jedną wiadomość próbną na Telegram i kończy (sprawdza token i czaty)
TXT
}

glowna() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --sucho) SUCHO=1 ;;
      --teraz) TERAZ=1 ;;
      --test-raportu) TEST_RAPORTU=1 ;;
      --sha) SHA_ARG=${2:-}; shift ;;
      -h|--help) uzycie; return 0 ;;
      *) uzycie >&2; return 2 ;;
    esac
    shift
  done

  zaladuj_infra_env K OPS APP DB PGC RESTC APP_PREFIX WORKER_PREFIX
  # shellcheck source=/dev/null
  [ -f "$NOCNE_ENV" ] && source "$NOCNE_ENV"

  if [ "$TEST_RAPORTU" = 1 ]; then
    if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_IDS:-}" ]; then
      echo "Brak TELEGRAM_BOT_TOKEN albo TELEGRAM_CHAT_IDS w $NOCNE_ENV." >&2
      return 1
    fi
    telegram "✅ FaktWay, nocne wdrożenie: wiadomość próbna z ops-1 ($(date '+%F %T')). Raporty z nocnych wdrożeń będą przychodzić tutaj."
    log "Wiadomość próbna wysłana (jeśli nie widać błędu wyżej, powinna dojść)."
    return 0
  fi

  if [ "$SUCHO" = 0 ]; then
    mkdir -p "$NOCNE_LOG_DIR" 2>/dev/null || NOCNE_LOG_DIR="$ROOT/.tmp/nocne"
    mkdir -p "$NOCNE_LOG_DIR"
    LOG="$NOCNE_LOG_DIR/$(date +%F-%H%M).log"
    exec > >(tee -a "$LOG") 2>&1
    find "$NOCNE_LOG_DIR" -name '*.log' -mtime +30 -delete 2>/dev/null || true
    if command -v flock >/dev/null 2>&1; then
      exec 9>"${NOCNE_LOCK:-/run/faktway-nocne.lock}" 2>/dev/null || exec 9>"$NOCNE_LOG_DIR/.lock"
      flock -n 9 || { log "Inny przebieg nocnego wdrożenia już trwa. Koniec."; return 0; }
    fi
  fi
  log "Nocne wdrożenie, start$([ "$SUCHO" = 1 ] && echo ' (--sucho: tylko odczyty)')"

  if [ "$SUCHO" = 0 ] && [ -e "$NOCNE_STOP" ]; then
    raport uwaga "wstrzymane" "Plik $NOCNE_STOP istnieje, więc dziś nie wdrażam. Wznowienie: ./scripts/ops/zainstaluj-nocne-wdrozenie.sh --wznow"
    return 0
  fi
  if [ "$SUCHO" = 0 ] && [ "$TERAZ" = 0 ]; then
    local g
    g=$(godzina_warszawa)
    if [ "$g" -lt "$NOCNE_OKNO_OD" ] || [ "$g" -gt "$NOCNE_OKNO_DO" ]; then
      log "Poza oknem nocnym (godzina w Warszawie: $g, okno $NOCNE_OKNO_OD-$NOCNE_OKNO_DO). Koniec. Ręcznie: --teraz."
      return 0
    fi
  fi
  ping_hc /start

  # ── 2. SHA na cały przebieg ──
  git -C "$ROOT" fetch --quiet origin main || { raport blad "git fetch padł" "Nie sprawdzę, co jest na main. Nic nie zmieniłem."; ping_hc /fail; return 1; }
  local sha=${SHA_ARG:-$(git -C "$ROOT" rev-parse origin/main)}
  if ! jest_sha "$sha" || ! git -C "$ROOT" merge-base --is-ancestor "$sha" origin/main 2>/dev/null; then
    raport blad "SHA poza main" "„$sha” nie jest pełnym SHA z origin/main. Nic nie zmieniłem."
    ping_hc /fail
    return 1
  fi

  local web worker
  worker=$(sha_dzialajacego "$WORKER_ID")
  web=$(sha_dzialajacego "$WEB_ID")
  log "Na produkcji: worker=${worker:-?} aplikacja=${web:-?}; cel: $(skrot "$sha")"
  if [ -z "$worker" ] || [ -z "$web" ] || [[ "$worker" == *,* ]] || [[ "$web" == *,* ]]; then
    raport blad "stan produkcji niejasny" "Worker: „${worker:-brak}”, aplikacja: „${web:-brak}”. Brak jednego SHA na kontener (stary jeszcze nie zniknął albo kontenera nie ma). Nie wdrażam. Sprawdź: ./scripts/ops/coolify-zrodlo.sh stan"
    ping_hc /fail
    return 1
  fi
  if [ "$worker" = "$sha" ] && [ "$web" = "$sha" ]; then
    log "Produkcja już działa na $(skrot "$sha"). Nic do wdrożenia."
    ping_hc ""
    return 0
  fi
  if [ "$worker" != "$web" ]; then
    raport blad "worker i aplikacja na różnych commitach" "worker=$(skrot "$worker"), aplikacja=$(skrot "$web"). Stan mieszany po przerwanym wdrożeniu. Nie wdrażam; ./scripts/ops/wdroz-produkcje.sh --obraz <sha> ustawi oba."
    ping_hc /fail
    return 1
  fi
  local wdrozony=$web
  if [ "$wdrozony" != "$sha" ] && ! git -C "$ROOT" merge-base --is-ancestor "$wdrozony" "$sha" 2>/dev/null; then
    raport uwaga "wdrożony kod jest nowszy albo spoza historii main" "Produkcja: $(skrot "$wdrozony"), cel: $(skrot "$sha"). Nie cofam kodu nocą. Jeśli to zamierzone (np. ręczne wdrożenie), nic nie rób."
    ping_hc ""
    return 0
  fi

  # ── 3. Bramki ──
  local ci
  ci=$(czekaj_na_ci "$sha" "$NOCNE_CI_CZEKAJ_MIN")
  if [ "$ci" != zielone ]; then
    raport uwaga "CI na $(skrot "$sha") nie jest zielone: $ci" "Nie wdrażam. Jutro spróbuję ponownie z nowym main. Kontrole: https://github.com/$REPO/commit/$sha"
    ping_hc ""
    return 0
  fi
  log "CI na $(skrot "$sha"): zielone"
  if [ "$SUCHO" = 1 ]; then
    czekaj_na_obrazy "$sha" 0 || log "⚠️ obrazów $(skrot "$sha") nie ma w GHCR (--sucho): prawdziwy przebieg by nie wdrożył."
  else
    local obrazy_wynik
    if ! obrazy_wynik=$(czekaj_na_obrazy "$sha" "$NOCNE_OBRAZY_CZEKAJ_MIN" 2>&1); then
      printf '%s\n' "$obrazy_wynik"
      raport uwaga "obrazów $(skrot "$sha") nie ma w GHCR" "Nie wdrażam. $(printf '%s\n' "$obrazy_wynik" | tail -n 3)"
      ping_hc ""
      return 0
    fi
  fi
  local aktywne
  aktywne=$(aktywne_wdrozenia)
  if [ -z "$aktywne" ] || [ "$aktywne" != 0 ]; then
    raport uwaga "Coolify ma aktywne wdrożenia albo nie odpowiada" "Aktywnych: ${aktywne:-brak odczytu}. Nie wdrażam. Jutro ponowię."
    ping_hc ""
    return 0
  fi
  if ! (sprawdz_miejsce_app1); then
    raport uwaga "za mało miejsca na app-1" "Posprzątaj stare obrazy (docker image ls na app-1), zostaw poprzednią wersję do cofnięcia."
    ping_hc ""
    return 0
  fi

  # ── 4. Migracje oczekujące ──
  local oczekujace plan przed po zablokowane kolejnosc
  if ! oczekujace=$(oczekujace_migracje "$sha"); then
    raport blad "nie odczytałem migracji z bazy" "Bez listy wgranych migracji nie wdrażam (kod mógłby wymagać tabeli, której nie ma). Sprawdź dostęp do db-1."
    ping_hc /fail
    return 1
  fi
  przed=""
  po=""
  if [ -n "$oczekujace" ]; then
    # shellcheck disable=SC2086 # numery to pięć cyfr, rozdzielone białymi znakami
    plan=$(kontrola_migracji "$sha" $oczekujace) ; local kod=$?
    if [ "$kod" != 0 ] && [ "$kod" != 3 ] || [ -z "$plan" ]; then
      raport blad "kontrola migracji nie zadziałała (kod $kod)" "Nie wgrywam i nie wdrażam. Oczekujące: ${oczekujace//$'\n'/ }. Sprawdź node i scripts/ops/kontrola-migracji.mjs."
      ping_hc /fail
      return 1
    fi
    zablokowane=$(jq -r '.zablokowane[] | "• \(.numer // .plik): \(.powody | join("; "))"' <<<"$plan")
    kolejnosc=$(jq -r '.kolejnosc // empty' <<<"$plan")
    przed=$(jq -r '.przed | join(" ")' <<<"$plan")
    po=$(jq -r '.po | join(" ")' <<<"$plan")
    if [ -n "$zablokowane" ] || [ -n "$kolejnosc" ]; then
      raport blad "migracje czekają na człowieka, nie wdrażam niczego" "Oczekujące na main: ${oczekujace//$'\n'/ }
${zablokowane:+$zablokowane
}${kolejnosc:+Kolejność: $kolejnosc
}Co zrobić: przeczytaj plik, policz wiersze przy UPDATE/DELETE (docs/runbooks/wgrywanie-migracji.md), wgraj ręcznie psql-em, potem noc wdroży resztę. Albo popraw nagłówek („-- Wdrożenie: PRZED”) nowym PR-em."
      ping_hc /fail
      return 1
    fi
    local wiek
    wiek=$(wiek_kopii_h)
    if [ -z "$wiek" ] || [ "$wiek" -gt "$NOCNE_MAX_KOPIA_H" ]; then
      raport blad "kopia bazy nieświeża, nie wgrywam migracji" "Ostatnia udana kopia: ${wiek:-brak odczytu} h temu (limit $NOCNE_MAX_KOPIA_H h). Migracje czekają: ${oczekujace//$'\n'/ }. Sprawdź backup_log i docs/runbooks/backup-restore.md."
      ping_hc /fail
      return 1
    fi
    log "Migracje: przed=${przed:-—} po=${po:-—}; kopia sprzed ${wiek} h"
  else
    log "Migracje: brak oczekujących"
  fi

  log "Plan: $(skrot "$wdrozony") → $(skrot "$sha"); zmiany:"
  lista_zmian "$wdrozony" "$sha"
  if [ "$SUCHO" = 1 ]; then
    log "--sucho: koniec planu, niczego nie zmieniłem."
    return 0
  fi

  # ── 5. Migracje „przed” ──
  if [ -n "$przed" ]; then
    # shellcheck disable=SC2086
    if ! wgraj_migracje "$sha" $przed; then
      raport blad "migracja „przed” nie weszła" "Numery: $przed. Wgrywanie przerwane na pierwszym błędzie (wcześniejsze zostały), kodu NIE wdrożyłem. Log: $LOG"
      ping_hc /fail
      return 1
    fi
  fi

  # ── 6. Wdrożenie ──
  local wdr_kod=0
  wdroz "$sha" || wdr_kod=$?
  local po_wdr_worker po_wdr_web
  po_wdr_worker=$(sha_dzialajacego "$WORKER_ID")
  po_wdr_web=$(sha_dzialajacego "$WEB_ID")
  if [ "$wdr_kod" != 0 ] || [ "$po_wdr_worker" != "$sha" ] || [ "$po_wdr_web" != "$sha" ]; then
    log "Wdrożenie nie przeszło (kod $wdr_kod; worker=${po_wdr_worker:-?}, aplikacja=${po_wdr_web:-?}). Ratunek: powrót na $(skrot "$wdrozony")."
    local ratunek_kod=0
    wdroz "$wdrozony" || ratunek_kod=$?
    local r_worker r_web
    r_worker=$(sha_dzialajacego "$WORKER_ID")
    r_web=$(sha_dzialajacego "$WEB_ID")
    if [ "$ratunek_kod" = 0 ] && [ "$r_worker" = "$wdrozony" ] && [ "$r_web" = "$wdrozony" ]; then
      raport blad "wdrożenie $(skrot "$sha") padło, wróciłem na $(skrot "$wdrozony")" "Migracje „przed” (${przed:-brak}) zostały wgrane; są addytywne, stary kod z nimi działa. Migracje „po” (${po:-brak}) czekają. Log: $LOG"
    else
      raport blad "wdrożenie padło I ratunek się nie udał: potrzebny człowiek" "Teraz: worker=${r_worker:-?}, aplikacja=${r_web:-?}. Próbowałem wrócić na $(skrot "$wdrozony"). Sprawdź: ./scripts/ops/kontrola-faktur-ksef.sh i ./scripts/ops/coolify-zrodlo.sh stan. Log: $LOG"
    fi
    ping_hc /fail
    return 1
  fi

  # ── 7. Migracje „PO wdrożeniu” ──
  if [ -n "$po" ]; then
    # shellcheck disable=SC2086
    if ! wgraj_migracje "$sha" $po; then
      raport blad "wdrożono $(skrot "$sha"), ale migracja „po wdrożeniu” nie weszła" "Numery: $po. Kod działa; wgraj je ręcznie: ./scripts/ops/wgraj-migracje.sh $po. Log: $LOG"
      ping_hc /fail
      return 1
    fi
  fi

  # ── 8. Raport ──
  raport ok "wdrożono $(skrot "$sha")" "Było: $(skrot "$wdrozony"). Worker i aplikacja zweryfikowane na nowym SHA.
Migracje: przed=${przed:-brak}, po=${po:-brak}.
Zmiany:
$(lista_zmian "$wdrozony" "$sha")"
  ping_hc ""
  return 0
}

# Źródłowany (testy: NOCNE_BIBLIOTEKA=1) tylko definiuje funkcje.
if [ "${NOCNE_BIBLIOTEKA:-}" != 1 ]; then
  glowna "$@"
  exit $?
fi
