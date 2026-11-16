#!/usr/bin/env bash
# Start nocnego wdrożenia na ops-1 (instaluje go scripts/ops/zainstaluj-nocne-wdrozenie.sh
# jako /usr/local/sbin/faktway-nocne-wdrozenie, woła go faktway-nocne-wdrozenie.service).
#
# Odświeża kopię repozytorium (publiczne, bez poświadczeń) do origin/main i oddaje
# sterowanie skryptowi z repo, więc nocne wdrożenie zawsze jedzie na aktualnym kodzie
# runnera. Brak sieci do GitHuba nie zatrzymuje startu: skrypt z repo sam zgłosi
# „git fetch padł” na Telegram i nic nie wdroży.
set -uo pipefail

REPO=${NOCNE_REPO_DIR:-/opt/faktway-nocne/repo}
cd "$REPO" || { echo "Brak $REPO: uruchom zainstaluj-nocne-wdrozenie.sh" >&2; exit 1; }

git fetch --quiet origin main || echo "git fetch padł (kontynuuję na ostatniej kopii; skrypt zgłosi problem)" >&2
git checkout --quiet --detach origin/main 2>/dev/null || echo "checkout origin/main nie przeszedł (zostaję na $(git rev-parse --short HEAD))" >&2

exec "$REPO/scripts/ops/nocne-wdrozenie.sh" "$@"
