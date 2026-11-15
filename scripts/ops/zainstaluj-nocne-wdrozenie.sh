#!/usr/bin/env bash
# shellcheck disable=SC1111 # cudzysłowy „…” w komunikatach są celowe
# ════════════════════════════════════════════════════════════════
# Instalacja nocnego wdrożenia na ops-1 (uruchamia Bartosz, jednorazowo)
# ────────────────────────────────────────────────────────────────
# Jedna linia, z katalogu repo, PO scaleniu PR z nocnym wdrożeniem do `main`:
#
#   ./scripts/ops/zainstaluj-nocne-wdrozenie.sh               # instalacja + próba na sucho
#   ./scripts/ops/zainstaluj-nocne-wdrozenie.sh --sprawdz     # tylko odczyt: co jest na ops-1
#   ./scripts/ops/zainstaluj-nocne-wdrozenie.sh --wstrzymaj   # dziś i dalej nie wdrażaj (plik STOP)
#   ./scripts/ops/zainstaluj-nocne-wdrozenie.sh --wznow       # zdejmuje STOP
#   ./scripts/ops/zainstaluj-nocne-wdrozenie.sh --teraz       # to samo co w nocy, od razu (te same bramki, raport na Telegram)
#   ./scripts/ops/zainstaluj-nocne-wdrozenie.sh --odinstaluj  # timer, pliki i klucz
#   ... --bez-telegramu                                        # zgoda na przebieg bez raportów (nie zalecane)
#
# Raporty i pingi bierze z `.agents/infra.env` albo ze środowiska:
#   NOCNE_TELEGRAM_TOKEN=…        token bota (ten sam co TELEGRAM_BOT_TOKEN aplikacji)
#   NOCNE_TELEGRAM_CHAT_IDS=…     Id czatów po przecinku (TELEGRAM_ALERT_CHAT_IDS)
#   NOCNE_HC_URL=…                opcjonalnie: ping Healthchecks (alarm, gdy noc się nie odbyła)
# Sekrety idą na serwer strumieniem (stdin), nie w linii poleceń.
#
# Co robi:
#   ops-1:  apt: nodejs, git, jq, curl (kontrola migracji potrzebuje Node);
#           klucz SSH `faktway_nocne_ed25519` BEZ hasła, który działa tylko z ops-1
#           (from=, bez forwardingu i pty), dopisany do authorized_keys ops-1, app-1, db-1;
#           kopia repo w /opt/faktway-nocne/repo (publiczne, bez poświadczeń) i
#           .agents/infra.env z adresami prywatnymi (poza gitem);
#           /usr/local/sbin/faktway-nocne-wdrozenie, jednostki systemd, /etc/faktway-nocne.env (0600);
#           timer co noc 03:30 czasu Warszawy.
#   Nic nie zmienia na app-1 i db-1 poza jedną linią authorized_keys.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=scripts/ops/coolify-wspolne.sh
source "$ROOT/scripts/ops/coolify-wspolne.sh"

TOKEN_ENV=${NOCNE_TELEGRAM_TOKEN:-}
CHATY_ENV=${NOCNE_TELEGRAM_CHAT_IDS:-}
HC_ENV=${NOCNE_HC_URL:-}
zaladuj_infra_env K OPS APP DB PGC RESTC APP_PREFIX WORKER_PREFIX
TOKEN=${TOKEN_ENV:-${NOCNE_TELEGRAM_TOKEN:-}}
CHATY=${CHATY_ENV:-${NOCNE_TELEGRAM_CHAT_IDS:-}}
HC=${HC_ENV:-${NOCNE_HC_URL:-}}

UNIT=faktway-nocne-wdrozenie
KLUCZ=/root/.ssh/faktway_nocne_ed25519
KATALOG=/opt/faktway-nocne
REPO_URL=https://github.com/FaktWay/FaktWay.git

ssh_do() {
  local host=$1
  shift
  ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 "root@$host" "$@"
}

prywatny_ip() {
  ssh_do "$1" "ip -4 -o addr show | awk '{print \$4}' | cut -d/ -f1 | grep '^10\\.0\\.0\\.' | head -n 1"
}

TRYB=instaluj
BEZ_TELEGRAMU=0
for arg in "$@"; do
  case "$arg" in
    --sprawdz) TRYB=sprawdz ;;
    --wstrzymaj) TRYB=wstrzymaj ;;
    --wznow) TRYB=wznow ;;
    --odinstaluj) TRYB=odinstaluj ;;
    --teraz) TRYB=teraz ;;
    --bez-telegramu) BEZ_TELEGRAMU=1 ;;
    -h|--help) awk 'NR >= 3 && /^#/ { sub(/^# ?/, ""); print; next } NR >= 3 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "Nieznana opcja: $arg (dozwolone: --sprawdz, --wstrzymaj, --wznow, --teraz, --odinstaluj, --bez-telegramu)" ;;
  esac
done

case "$TRYB" in
  sprawdz)
    echo "Konfiguracja lokalna: NOCNE_TELEGRAM_TOKEN $([ -n "$TOKEN" ] && echo jest || echo brak), NOCNE_TELEGRAM_CHAT_IDS $([ -n "$CHATY" ] && echo jest || echo brak), NOCNE_HC_URL $([ -n "$HC" ] && echo jest || echo brak)"
    ssh_do "$OPS" "echo '── timer:'; systemctl list-timers --all --no-pager $UNIT.timer 2>&1 | head -4; \
      echo '── wstrzymanie:'; [ -e /etc/faktway-nocne/STOP ] && echo 'WSTRZYMANE (plik STOP)' || echo 'aktywne (brak pliku STOP)'; \
      echo '── env na ops-1 (tylko nazwy):'; sed 's/=.*//' /etc/faktway-nocne.env 2>/dev/null || echo '(brak)'; \
      echo '── repo:'; git -C $KATALOG/repo log -1 --format='%h %s' 2>&1 | head -1; \
      echo '── narzędzia:'; for t in node git jq curl flock; do printf '%s: ' \$t; command -v \$t || echo BRAK; done; \
      echo '── ostatni przebieg:'; ls -t /var/log/faktway-nocne/*.log 2>/dev/null | head -1 | xargs -r tail -n 15; true"
    exit 0 ;;
  wstrzymaj)
    ssh_do "$OPS" "mkdir -p /etc/faktway-nocne && touch /etc/faktway-nocne/STOP && echo 'Nocne wdrożenie WSTRZYMANE (plik /etc/faktway-nocne/STOP). Wznowienie: --wznow.'"
    exit 0 ;;
  wznow)
    ssh_do "$OPS" "rm -f /etc/faktway-nocne/STOP && echo 'Nocne wdrożenie WZNOWIONE (najbliższy przebieg wg timera).'"
    exit 0 ;;
  teraz)
    ssh_do "$OPS" "test -x /usr/local/sbin/faktway-nocne-wdrozenie" || die "Nocne wdrożenie nie jest zainstalowane na ops-1 (uruchom bez opcji)."
    ssh_do "$OPS" "[ ! -e /etc/faktway-nocne/STOP ]" || die "Nocne wdrożenie jest wstrzymane (plik STOP). Zdejmij: $0 --wznow"
    ssh_do "$OPS" "systemd-run --quiet --collect --unit=faktway-nocne-reczne-\$(date +%H%M%S) /usr/local/sbin/faktway-nocne-wdrozenie --teraz"
    echo "Wystartowało na ops-1 (poza oknem nocnym, te same bramki i kolejność co w nocy). Wynik przyjdzie na Telegram."
    echo "Na żywo: ssh … 'tail -f \$(ls -t /var/log/faktway-nocne/*.log | head -1)'; stan: $0 --sprawdz"
    exit 0 ;;
  odinstaluj)
    ssh_do "$OPS" "systemctl disable --now $UNIT.timer 2>/dev/null; \
      rm -f /etc/systemd/system/$UNIT.service /etc/systemd/system/$UNIT.timer /usr/local/sbin/faktway-nocne-wdrozenie /etc/faktway-nocne.env; \
      rm -rf /etc/faktway-nocne; systemctl daemon-reload; echo 'ops-1: timer, wrapper, env usunięte (repo w $KATALOG zostaje)'"
    for h in "$OPS" "$APP" "$DB"; do
      ssh_do "$h" "[ -f /root/.ssh/authorized_keys ] && sed -i '/ faktway-nocne\$/d' /root/.ssh/authorized_keys; echo '$h: klucz faktway-nocne usunięty z authorized_keys'" || true
    done
    ssh_do "$OPS" "rm -f $KLUCZ $KLUCZ.pub"
    echo "Jeśli był check Healthchecks dla nocnego wdrożenia: zatrzymaj go (Pause), inaczej przyjdzie alarm."
    exit 0 ;;
esac

# ── Instalacja ──
if [ -n "$TOKEN" ] && [[ ! $TOKEN =~ ^[0-9]{6,}:[A-Za-z0-9_-]{20,}$ ]]; then die "NOCNE_TELEGRAM_TOKEN nie wygląda na token bota (123456789:AAH…)."; fi
if [ -n "$CHATY" ] && [[ ! $CHATY =~ ^-?[0-9]+(,-?[0-9]+)*$ ]]; then die "NOCNE_TELEGRAM_CHAT_IDS: Id czatów po przecinku, same cyfry (czat grupowy z minusem)."; fi
if [ -n "$HC" ] && [[ ! $HC =~ ^https://[A-Za-z0-9./_-]+$ ]]; then die "NOCNE_HC_URL nie wygląda na adres pingu (https://hc-ping.com/<uuid>)."; fi
for v in PGC RESTC APP_PREFIX WORKER_PREFIX; do
  [[ ${!v} =~ ^[A-Za-z0-9._-]+$ ]] || die "$v w infra.env ma niedozwolone znaki."
done
JEST_ENV_NA_SERWERZE=0
if ssh_do "$OPS" "grep -q '^TELEGRAM_BOT_TOKEN=.' /etc/faktway-nocne.env 2>/dev/null"; then JEST_ENV_NA_SERWERZE=1; fi
if [ "$BEZ_TELEGRAMU" = 0 ] && { [ -z "$TOKEN" ] || [ -z "$CHATY" ]; } && [ "$JEST_ENV_NA_SERWERZE" = 0 ]; then
  die "Brak NOCNE_TELEGRAM_TOKEN i NOCNE_TELEGRAM_CHAT_IDS (dopisz do .agents/infra.env; ten sam bot i czat co alerty aplikacji). Bez raportów nocna automatyka zawodziłaby po cichu. Świadomie bez: --bez-telegramu."
fi

echo "── Adresy prywatne (sieć Hetznera)"
OPS_P=$(prywatny_ip "$OPS")
APP_P=$(prywatny_ip "$APP")
DB_P=$(prywatny_ip "$DB")
for pair in "ops-1:$OPS_P" "app-1:$APP_P" "db-1:$DB_P"; do
  [[ ${pair#*:} =~ ^10\.0\.0\.[0-9]+$ ]] || die "Nie znalazłem adresu 10.0.0.x na ${pair%%:*} (jest: „${pair#*:}”). Sieć prywatna nie jest podpięta?"
done
echo "   ops-1=$OPS_P app-1=$APP_P db-1=$DB_P"

echo "── ops-1: pakiety i kopia repo"
ssh_do "$OPS" "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq nodejs git jq curl util-linux >/dev/null && echo 'node:' \$(node --version)"
ssh_do "$OPS" "set -e; mkdir -p $KATALOG; [ -d $KATALOG/repo/.git ] || git clone -q --filter=blob:none $REPO_URL $KATALOG/repo; \
  git -C $KATALOG/repo fetch -q origin main; mkdir -p $KATALOG/repo/.agents; \
  git -C $KATALOG/repo cat-file -e origin/main:scripts/ops/nocne-wdrozenie.sh 2>/dev/null || { echo 'Na main nie ma jeszcze nocnego wdrożenia: scal PR i uruchom ponownie.'; exit 3; }"

echo "── ops-1: klucz SSH (tylko z ops-1, bez hasła)"
ssh_do "$OPS" "[ -f $KLUCZ ] || ssh-keygen -q -t ed25519 -N '' -C faktway-nocne -f $KLUCZ"
PUB=$(ssh_do "$OPS" "cut -d' ' -f1,2 $KLUCZ.pub")
[[ $PUB =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+$ ]] || die "Nie odczytałem klucza publicznego z ops-1."
LINIA="from=\"$OPS_P,127.0.0.1\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $PUB faktway-nocne"
for h in "$OPS" "$APP" "$DB"; do
  printf '%s\n' "$LINIA" | ssh_do "$h" "umask 077; mkdir -p /root/.ssh; touch /root/.ssh/authorized_keys; read -r l; grep -qF \"\$l\" /root/.ssh/authorized_keys || printf '%s\\n' \"\$l\" >> /root/.ssh/authorized_keys"
done
ssh_do "$OPS" "for h in $OPS_P $APP_P $DB_P; do ssh-keygen -F \$h >/dev/null 2>&1 || ssh-keyscan -T 10 -H \$h 2>/dev/null >> /root/.ssh/known_hosts; done"

echo "── ops-1: infra.env runnera, wrapper, jednostki systemd, env raportów"
{
  printf 'K=%s\nOPS=%s\nAPP=%s\nDB=%s\n' "$KLUCZ" "$OPS_P" "$APP_P" "$DB_P"
  printf 'PGC=%s\nRESTC=%s\nAPP_PREFIX=%s\nWORKER_PREFIX=%s\n' "$PGC" "$RESTC" "$APP_PREFIX" "$WORKER_PREFIX"
} | ssh_do "$OPS" "umask 077; cat > $KATALOG/repo/.agents/infra.env"
if [ -n "$TOKEN" ] || [ -n "$CHATY" ] || [ -n "$HC" ]; then
  {
    [ -z "$TOKEN" ] || printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOKEN"
    [ -z "$CHATY" ] || printf 'TELEGRAM_CHAT_IDS=%s\n' "$CHATY"
    [ -z "$HC" ] || printf 'NOCNE_HC_URL=%s\n' "$HC"
  } | ssh_do "$OPS" "umask 077; cat > /etc/faktway-nocne.env"
fi
put() { tr -d '\r' <"$ROOT/$1" | ssh_do "$OPS" "umask 022; cat > '$2'"; }
T=/root/.faktway-nocne-instalacja
ssh_do "$OPS" "mkdir -p $T /etc/faktway-nocne /var/log/faktway-nocne && chmod 700 $T"
put scripts/hetzner/nocne-wdrozenie-start.sh "$T/start"
put scripts/hetzner/systemd/$UNIT.service "$T/service"
put scripts/hetzner/systemd/$UNIT.timer "$T/timer"
ssh_do "$OPS" "set -e; install -m 700 $T/start /usr/local/sbin/faktway-nocne-wdrozenie; \
  install -m 644 $T/service /etc/systemd/system/$UNIT.service; install -m 644 $T/timer /etc/systemd/system/$UNIT.timer; \
  rm -rf $T; systemctl daemon-reload; systemctl enable --now $UNIT.timer; systemctl list-timers --no-pager $UNIT.timer | head -3"

echo "── Łączność kluczem nocnym z ops-1 do ops-1, app-1, db-1"
for pair in "ops-1:$OPS_P" "app-1:$APP_P" "db-1:$DB_P"; do
  if ssh_do "$OPS" "ssh -i $KLUCZ -o BatchMode=yes -o ConnectTimeout=10 root@${pair#*:} true"; then
    echo "   ${pair%%:*}: OK"
  else
    die "Klucz nocny nie wpuszcza na ${pair%%:*} (${pair#*:}). Sprawdź authorized_keys i zaporę sieci prywatnej."
  fi
done

if [ "$BEZ_TELEGRAMU" = 0 ]; then
  echo "── Wiadomość próbna na Telegram"
  ssh_do "$OPS" "/usr/local/sbin/faktway-nocne-wdrozenie --test-raportu" || die "Próbna wiadomość nie przeszła: sprawdź token i Id czatu (ten, który napisał /start do bota)."
fi

echo "── Próba na sucho na ops-1 (tylko odczyty, nic nie zmienia)"
ssh_do "$OPS" "/usr/local/sbin/faktway-nocne-wdrozenie --sucho" || true
echo
echo "Zainstalowane. Najbliższy przebieg: 03:30 czasu Warszawy (ssh … 'systemctl list-timers $UNIT.timer')."
echo "Wstrzymanie: $0 --wstrzymaj, stan: $0 --sprawdz, procedura: docs/runbooks/nocne-wdrozenie.md."
