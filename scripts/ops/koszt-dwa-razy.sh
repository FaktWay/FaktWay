#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# FZ-022 (reguła RP-KOSZT-01): ten sam dokument kosztu dwa razy, czyli ile
# firm zobaczy odmowę KPiR, JPK_V7M i kart kosztów. TYLKO ODCZYT.
# Runbook: docs/runbooks/koszt-dwa-razy.md.
#
#   ./scripts/ops/koszt-dwa-razy.sh                                  liczby dla wszystkich firm
#   ./scripts/ops/koszt-dwa-razy.sh --lista-firm                     do tego lista firm z odmową (id firmy i liczby)
#   ./scripts/ops/koszt-dwa-razy.sh --firma <uuid>                   liczby jednej firmy
#   ./scripts/ops/koszt-dwa-razy.sh --firma <uuid> --szczegoly       grupy jednej firmy z NIP-em, numerem i kwotami
#
# Domyślnie same liczby: firmy i grupy z odmową, wzory grup, pary źródeł, grupy
# z odmową i różną kwotą (do sprawdzenia, mogą być fałszywą odmową) i firmy
# z odmową w okresie już złożonym. --lista-firm dopisuje id firm z odmową
# z liczbami (do kontaktu przy okresach złożonych). NIP-y, numery i kwoty tylko
# z --szczegoly i tylko dla jednej firmy.
#
# Cała logika jest w koszt-dwa-razy.sql obok (test na bazie:
# tests/rls-koszt-dwa-razy-skrypt.test.ts, zgodność z odczytami aplikacji).
# Ten plik tylko sprawdza argumenty, ładuje .agents/infra.env i uruchamia SQL
# w kontenerze Postgresa w transakcji tylko do odczytu (BEGIN READ ONLY
# w pliku i default_transaction_read_only w PGOPTIONS).
# ════════════════════════════════════════════════════════════════

set -euo pipefail

USAGE="Użycie: ./scripts/ops/koszt-dwa-razy.sh [--lista-firm] [--firma <uuid>] [--szczegoly]"
FIRMA=""
LISTA=0
SZCZEGOLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --firma)
      FIRMA=${2:-}
      shift 2 || { echo "$USAGE" >&2; exit 1; }
      ;;
    --lista-firm)
      LISTA=1
      shift
      ;;
    --szczegoly)
      SZCZEGOLY=1
      shift
      ;;
    *)
      echo "Nieznana opcja $1." >&2
      echo "$USAGE" >&2
      exit 1
      ;;
  esac
done
# Tylko znaki UUID trafiają dalej do powłoki zdalnej.
if [ -n "$FIRMA" ] && ! [[ "$FIRMA" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Podaj id firmy (UUID małymi literami)." >&2
  echo "$USAGE" >&2
  exit 1
fi
if [ "$SZCZEGOLY" = 1 ] && [ -z "$FIRMA" ]; then
  echo "Szczegóły (NIP-y, numery, kwoty) tylko dla jednej firmy: dodaj --firma <uuid>." >&2
  echo "$USAGE" >&2
  exit 1
fi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MAIN_ROOT=""
if command -v git >/dev/null 2>&1; then
  # Ścieżka bezwzględna, bo w worktree Git Bash na Windowsie podaje `C:/…`,
  # której nie da się dokleić do $ROOT. Gdy `cd` się nie uda, MAIN_ROOT
  # zostaje pusty, a skrypt idzie dalej.
  COMMON_DIR=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -n "$COMMON_DIR" ]; then
    MAIN_ROOT=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd) || MAIN_ROOT=""
  fi
fi

ENV_FILE=""
for candidate in "${FAKTFLOW_INFRA_ENV:-}" "$ROOT/.agents/infra.env" "${MAIN_ROOT:+$MAIN_ROOT/.agents/infra.env}"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    ENV_FILE=$candidate
    break
  fi
done
if [ -z "$ENV_FILE" ]; then
  echo "Nie znalazłem .agents/infra.env (plik jest poza gitem, patrz AGENTS.md, sekcja Infrastruktura)." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"
for v in K DB PGC; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

REMOTE=/tmp/koszt-dwa-razy.sql
echo "Ten sam dokument kosztu dwa razy · $([ -n "$FIRMA" ] && echo "firma $FIRMA" || echo 'wszystkie firmy') · $([ "$SZCZEGOLY" = 1 ] && echo 'ze szczegółami' || echo 'same liczby') · tylko odczyt"

# Checkout z Windowsa ma CRLF, a wtedy psql nie rozpozna „\if :szczegoly\r”. Wysyłamy kopię z LF.
SQL_FILE=$(mktemp)
trap 'rm -f "$SQL_FILE"' EXIT
tr -d '\r' < "$ROOT/scripts/ops/koszt-dwa-razy.sql" > "$SQL_FILE"

SSH=(ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes)
scp -q -i "$K" -o ConnectTimeout=15 -o BatchMode=yes "$SQL_FILE" "root@$DB:$REMOTE"
"${SSH[@]}" "root@$DB" \
  "docker cp $REMOTE $PGC:$REMOTE && \
   docker exec -e 'PGOPTIONS=-c statement_timeout=60s -c default_transaction_read_only=on' $PGC psql -U postgres -d postgres -X -q \
     -v ON_ERROR_STOP=1 -v firma=$FIRMA -v lista=$LISTA -v szczegoly=$SZCZEGOLY \
     -f $REMOTE; \
   rc=\$?; rm -f $REMOTE; docker exec $PGC rm -f $REMOTE; exit \$rc"
