#!/usr/bin/env bash
# Starts the E2E API server: ensures Postgres + a fresh e2e database, builds the SPA, boots apps/api (auto-migrates).
#
# Local (default): starts Postgres via scripts/local-pg.sh and recreates tenderpilot_e2e on :5433.
# CI / external Postgres: set E2E_DATABASE_URL (e.g. postgres://tp:tp@localhost:5433/tenderpilot_e2e); the database
# named in that URL is dropped and recreated with psql through the server's `postgres` maintenance database
# (override with E2E_ADMIN_DATABASE_URL). The name must contain "e2e" or "test" unless E2E_ALLOW_ANY_DB=1.
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT="${E2E_PORT:-8788}"; GEM_PORT="${E2E_GEM_PORT:-4011}"
if [ -n "${E2E_DATABASE_URL:-}" ]; then
  DB_URL="$E2E_DATABASE_URL"
  base="${DB_URL%%\?*}"; query="${DB_URL#"$base"}"   # split off ?sslmode=… etc.
  DB_NAME="${base##*/}"
  ADMIN_URL="${E2E_ADMIN_DATABASE_URL:-${base%/*}/postgres$query}"
  if ! [[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "start-api.sh: cannot derive a database name from E2E_DATABASE_URL (got '$DB_NAME')" >&2; exit 1
  fi
  if [ "${E2E_ALLOW_ANY_DB:-}" != "1" ] && ! [[ "$DB_NAME" =~ (e2e|test) ]]; then
    echo "start-api.sh: refusing to drop '$DB_NAME' (name lacks e2e/test; set E2E_ALLOW_ANY_DB=1 to override)" >&2; exit 1
  fi
else
  DB_NAME="${E2E_DB_NAME:-tenderpilot_e2e}"
  DB_URL="postgres://tp:tp@localhost:5433/$DB_NAME"
  ADMIN_URL="postgres://tp:tp@localhost:5433/postgres"
  scripts/local-pg.sh >/dev/null
fi
PGOPTIONS="-c client_min_messages=warning" psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qc "drop database if exists \"$DB_NAME\" with (force)" -c "create database \"$DB_NAME\"" >/dev/null
BLOBS=".data/e2e-blobs-$PORT"; rm -rf "$BLOBS"
[ "${E2E_SKIP_BUILD:-}" = "1" ] || pnpm --filter @tp/web build >/dev/null
PORT=$PORT DATABASE_URL=$DB_URL AUTO_MIGRATE=1 BLOB_DIR=$BLOBS GEM_BASE_URL=http://127.0.0.1:$GEM_PORT \
  GEM_MIN_INTERVAL_MS=0 APP_URL=http://localhost:$PORT exec pnpm --filter @tp/api start
