#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Wyłącznik faktury w cenach brutto (RP-FA-BRUTTO-01): stan, włączenie
# i wyłączenie flagi `grossPricesEnabled` w `global_feature_flags` na db-1.
# Runbook: docs/runbooks/ceny-brutto-wylacznik.md (kto decyduje, warunki
# włączenia, kontrola po włączeniu).
#
# UWAGA: skrypt napisany 22.11.2026 i NIE był jeszcze uruchomiony na
# serwerze. Pierwsze użycie zacznij od `stan` i porównaj wynik z runbookiem.
# ────────────────────────────────────────────────────────────────
# Jedna linia z katalogu repo (skrypt sam ładuje `.agents/infra.env`):
#
#   ./scripts/ops/ceny-brutto.sh stan
#       wiersz flagi (brak wiersza = wyłączone) i faktury sprzedaży
#       w cenach brutto według stanu wysyłki; tylko odczyt
#   ./scripts/ops/ceny-brutto.sh wlacz [--tak]
#       włącza fakturę w cenach brutto; bez `--tak` tylko pokazuje stan
#   ./scripts/ops/ceny-brutto.sh wylacz [--tak]
#       wyłącza; bez `--tak` tylko pokazuje stan
#
# Włącza tylko Bartosz (warunki w runbooku). Zmiana działa od następnego
# zapisu i wysyłki faktury: aplikacja i worker czytają flagę wprost z bazy
# (`getGlobalFlagForExecution`), bez pamięci podręcznej i bez wdrożenia.
# ════════════════════════════════════════════════════════════════

set -euo pipefail

# Gdzie leży `.agents/infra.env`: zmienna FAKTFLOW_INFRA_ENV, katalog tego
# repo, a dla worktree główny checkout (jak w kontrola-go-live-ksef.sh).
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MAIN_ROOT=""
if command -v git >/dev/null 2>&1; then
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
  echo "Nie znalazłem .agents/infra.env (plik jest poza gitem, AGENTS.md: Infrastruktura)." >&2
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

usage() {
  cat >&2 <<'TEKST'
Użycie:
  ./scripts/ops/ceny-brutto.sh stan
  ./scripts/ops/ceny-brutto.sh wlacz [--tak]
  ./scripts/ops/ceny-brutto.sh wylacz [--tak]
Runbook: docs/runbooks/ceny-brutto-wylacznik.md
TEKST
  exit 1
}

if [ $# -gt 2 ]; then usage; fi
CMD=${1:-}
FLAG=${2:-}
case "$CMD" in
  stan|wlacz|wylacz) ;;
  *) usage ;;
esac
if [ "$CMD" = "stan" ] && [ -n "$FLAG" ]; then
  echo "Nieznana opcja $FLAG (stan nic nie zmienia)." >&2
  exit 1
fi
if [ "$CMD" != "stan" ] && [ -n "$FLAG" ] && [ "$FLAG" != "--tak" ]; then
  echo "Nieznana opcja $FLAG (jedyna: --tak)." >&2
  exit 1
fi

SSH=(ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes)

# psql w kontenerze Postgresa. SQL bez cudzysłowów podwójnych, backticków
# i znaku dolara: przechodzi przez dwie powłoki (lokalną i na serwerze).
# Odczyt: transakcja tylko do odczytu i limit 30 s, jak w kontrola-go-live-ksef.sh.
sql_odczyt() {
  local label=$1 query=$2
  printf -- '--- %s\n' "$label"
  "${SSH[@]}" "root@$DB" \
    "docker exec -e PGCLIENTENCODING=UTF8 -e 'PGOPTIONS=-c statement_timeout=30s -c default_transaction_read_only=on' $PGC psql -U postgres -d postgres -At -F' | ' -v ON_ERROR_STOP=1 -c \"$query\""
}

sql_zapis() {
  local label=$1 query=$2
  printf -- '--- %s\n' "$label"
  "${SSH[@]}" "root@$DB" \
    "docker exec -e PGCLIENTENCODING=UTF8 -e 'PGOPTIONS=-c statement_timeout=30s' $PGC psql -U postgres -d postgres -At -F' | ' -v ON_ERROR_STOP=1 -c \"$query\""
}

stan() {
  sql_odczyt "flaga grossPricesEnabled: stan | zmiana | kto | notatka (brak wiersza = wyłączone)" \
    "SELECT coalesce((SELECT CASE WHEN enabled THEN 'włączone' ELSE 'wyłączone' END || ' | ' || updated_at::text || ' | ' || coalesce(updated_by, '-') || ' | ' || coalesce(note, '-') FROM public.global_feature_flags WHERE flag = 'grossPricesEnabled'), 'brak wiersza = wyłączone')"
  sql_odczyt "faktury sprzedaży w cenach brutto (fa3_data.pricesGross): stan wysyłki | liczba | ostatnia zmiana" \
    "SELECT coalesce(ksef_status, '-'), count(*), max(updated_at) FROM public.invoices WHERE direction = 'outgoing' AND fa3_data ->> 'pricesGross' = 'true' GROUP BY 1 ORDER BY 1"
}

ustaw() {
  local enabled=$1 note=$2
  sql_zapis "zapis flagi (RETURNING: flaga | stan | zmiana)" \
    "INSERT INTO public.global_feature_flags (flag, enabled, updated_at, updated_by, note) VALUES ('grossPricesEnabled', $enabled, now(), 'operator: ceny-brutto.sh', '$note') ON CONFLICT (flag) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by, note = EXCLUDED.note RETURNING flag, enabled, updated_at"
}

case "$CMD" in
  stan)
    stan
    ;;
  wlacz|wylacz)
    stan
    if [ "$FLAG" != "--tak" ]; then
      echo
      echo "Nic nie zmieniłem. Żeby $( [ "$CMD" = wlacz ] && echo 'włączyć' || echo 'wyłączyć' ) fakturę w cenach brutto: ./scripts/ops/ceny-brutto.sh $CMD --tak"
      exit 0
    fi
    if [ "$CMD" = "wlacz" ]; then
      ustaw true 'Faktura w cenach brutto (RP-FA-BRUTTO-01) włączona skryptem ceny-brutto.sh po decyzji Bartosza.'
    else
      ustaw false 'Faktura w cenach brutto (RP-FA-BRUTTO-01) wyłączona skryptem ceny-brutto.sh.'
    fi
    echo
    stan
    ;;
esac
