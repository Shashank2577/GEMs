#!/usr/bin/env bash
# Start a throwaway local Postgres 16 on port 5433 (dev + CI). Usage: scripts/local-pg.sh [start|stop|reset]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.data/pg"; PORT="${PGPORT_LOCAL:-5433}"
BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"; BIN="${BIN:-$(dirname "$(command -v pg_ctl)")}"
as_pg() { if [ "$(id -u)" = "0" ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
cmd="${1:-start}"
if [ "$cmd" = "reset" ]; then as_pg "$BIN/pg_ctl -D $DATA stop -m fast" >/dev/null 2>&1 || true; rm -rf "$DATA"; cmd=start; fi
if [ "$cmd" = "stop" ]; then as_pg "$BIN/pg_ctl -D $DATA stop -m fast"; exit 0; fi
mkdir -p "$ROOT/.data"
if [ ! -f "$DATA/PG_VERSION" ]; then
  mkdir -p "$DATA"; [ "$(id -u)" = "0" ] && chown -R postgres "$ROOT/.data" && chmod 755 "$ROOT" "$ROOT/.data"
  as_pg "$BIN/initdb -D $DATA -U postgres --auth=trust >/dev/null"
fi
if ! as_pg "$BIN/pg_ctl -D $DATA status" >/dev/null 2>&1; then
  as_pg "$BIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp' -l $DATA/server.log start -w >/dev/null"
fi
psql -h localhost -p "$PORT" -U postgres -tc "select 1 from pg_roles where rolname='tp'" | grep -q 1 || psql -h localhost -p "$PORT" -U postgres -c "create role tp login superuser password 'tp'" >/dev/null
for db in tenderpilot tenderpilot_test; do
  psql -h localhost -p "$PORT" -U postgres -tc "select 1 from pg_database where datname='$db'" | grep -q 1 || psql -h localhost -p "$PORT" -U postgres -c "create database $db owner tp" >/dev/null
done
echo "postgres ready on :$PORT (dbs: tenderpilot, tenderpilot_test)"
