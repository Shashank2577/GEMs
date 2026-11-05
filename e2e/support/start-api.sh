#!/usr/bin/env bash
# Starts the E2E API server: ensures Postgres + a fresh e2e database, builds the SPA, boots apps/api (auto-migrates).
#
# Local (default): starts Postgres via scripts/local-pg.sh and recreates tenderpilot_e2e on :5433.
# CI / external Postgres: set E2E_DATABASE_URL (e.g. postgres://tp:tp@localhost:5433/tenderpilot_e2e); the database
# named in that URL is dropped and recreated with psql through the server's `postgres` maintenance database
# (override with E2E_ADMIN_DATABASE_URL). Unless E2E_ALLOW_ANY_DB=1 the database name (also E2E_DB_NAME) must have an
# `e2e`/`test` segment (`(^|_)(e2e|test)(_|$)`) and the server must be localhost/127.0.0.1.
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT="${E2E_PORT:-8788}"; GEM_PORT="${E2E_GEM_PORT:-4011}"
# Safety net: only throwaway databases on this machine are dropped unless E2E_ALLOW_ANY_DB=1.
host_of() { local a="${1#*://}"; a="${a%%[/?]*}"; a="${a##*@}"; echo "${a%%:*}"; }
guard() { # guard <db-name> <url...>
  local name="$1"; shift
  if ! [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "start-api.sh: invalid e2e database name '$name'" >&2; exit 1
  fi
  [ "${E2E_ALLOW_ANY_DB:-}" = "1" ] && return 0
  if ! [[ "$name" =~ (^|_)(e2e|test)(_|$) ]]; then
    echo "start-api.sh: refusing to drop '$name' (name must contain an _e2e_/_test_ segment; E2E_ALLOW_ANY_DB=1 overrides)" >&2; exit 1
  fi
  local url h
  for url in "$@"; do
    h="$(host_of "$url")"
    if [ "$h" != "localhost" ] && [ "$h" != "127.0.0.1" ]; then
      echo "start-api.sh: refusing to drop a database on host '$h' (only localhost/127.0.0.1; E2E_ALLOW_ANY_DB=1 overrides)" >&2; exit 1
    fi
  done
}
if [ -n "${E2E_DATABASE_URL:-}" ]; then
  DB_URL="$E2E_DATABASE_URL"
  base="${DB_URL%%\?*}"; query="${DB_URL#"$base"}"   # split off ?sslmode=… etc.
  DB_NAME="${base##*/}"
  ADMIN_URL="${E2E_ADMIN_DATABASE_URL:-${base%/*}/postgres$query}"
  guard "$DB_NAME" "$DB_URL" "$ADMIN_URL"
else
  DB_NAME="${E2E_DB_NAME:-tenderpilot_e2e}"
  DB_URL="postgres://tp:tp@localhost:5433/$DB_NAME"
  ADMIN_URL="postgres://tp:tp@localhost:5433/postgres"
  guard "$DB_NAME"
  scripts/local-pg.sh >/dev/null
fi
PGOPTIONS="-c client_min_messages=warning" psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qc "drop database if exists \"$DB_NAME\" with (force)" -c "create database \"$DB_NAME\"" >/dev/null
BLOBS=".data/e2e-blobs-$PORT"; rm -rf "$BLOBS"
[ "${E2E_SKIP_BUILD:-}" = "1" ] || pnpm --filter @tp/web build >/dev/null
# E2E_API_LOG: also append the API's stdout/stderr (JSON log lines) to this file, for specs that assert on server logs
# (008/US6). scripts/e2e-ci.sh sets it per spec-file run.
if [ -n "${E2E_API_LOG:-}" ]; then mkdir -p "$(dirname "$E2E_API_LOG")"; exec > >(tee -a "$E2E_API_LOG") 2>&1; fi
PORT=$PORT DATABASE_URL=$DB_URL AUTO_MIGRATE=1 BLOB_DIR=$BLOBS GEM_BASE_URL=http://127.0.0.1:$GEM_PORT \
  GEM_MIN_INTERVAL_MS=0 APP_URL=http://localhost:$PORT exec pnpm --filter @tp/api start
