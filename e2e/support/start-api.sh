#!/usr/bin/env bash
# Starts the E2E API server: ensures Postgres + a fresh e2e database, builds the SPA, boots apps/api (auto-migrates).
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT="${E2E_PORT:-8788}"; GEM_PORT="${E2E_GEM_PORT:-4011}"
DB_URL="${E2E_DATABASE_URL:-postgres://tp:tp@localhost:5433/tenderpilot_e2e}"
if [ -z "${E2E_DATABASE_URL:-}" ]; then
  scripts/local-pg.sh >/dev/null
  psql postgres://tp:tp@localhost:5433/postgres -qc "drop database if exists tenderpilot_e2e with (force)" -c "create database tenderpilot_e2e" >/dev/null
fi
rm -rf .data/e2e-blobs
[ "${E2E_SKIP_BUILD:-}" = "1" ] || pnpm --filter @tp/web build >/dev/null
PORT=$PORT DATABASE_URL=$DB_URL AUTO_MIGRATE=1 BLOB_DIR=.data/e2e-blobs GEM_BASE_URL=http://127.0.0.1:$GEM_PORT \
  GEM_MIN_INTERVAL_MS=0 APP_URL=http://localhost:$PORT exec pnpm --filter @tp/api start
