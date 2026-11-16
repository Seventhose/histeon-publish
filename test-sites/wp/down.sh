#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
docker compose --profile tools stop wpcli wordpress database
printf 'Fixture arrestata; volumi e credenziali locali restano conservati.\n'
