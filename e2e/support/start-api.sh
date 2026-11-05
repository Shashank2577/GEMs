#!/usr/bin/env bash
# Starts the E2E API server: ensures Postgres + a fresh e2e database, builds the SPA, boots apps/api (auto-migrates).
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT="${E2E_PORT:-8788}"; GEM_PORT="${E2E_GEM_PORT:-4011}"
DB_NAME="${E2E_DB_NAME:-tenderpilot_e2e}"
DB_URL="${E2E_DATABASE_URL:-postgres://tp:tp@localhost:5433/$DB_NAME}"
if [ -z "${E2E_DATABASE_URL:-}" ]; then
  scripts/local-pg.sh >/dev/null
  psql postgres://tp:tp@localhost:5433/postgres -qc "drop database if exists $DB_NAME with (force)" -c "create database $DB_NAME" >/dev/null
fi
BLOBS=".data/e2e-blobs-$PORT"; rm -rf "$BLOBS"
[ "${E2E_SKIP_BUILD:-}" = "1" ] || pnpm --filter @tp/web build >/dev/null
PORT=$PORT DATABASE_URL=$DB_URL AUTO_MIGRATE=1 BLOB_DIR=$BLOBS GEM_BASE_URL=http://127.0.0.1:$GEM_PORT \
  GEM_MIN_INTERVAL_MS=0 APP_URL=http://localhost:$PORT exec pnpm --filter @tp/api start
