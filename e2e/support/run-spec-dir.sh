#!/usr/bin/env bash
# Runs every spec file of one e2e directory back to back on ONE database, each file with both projects (desktop + mobile).
# Usage: e2e/support/run-spec-dir.sh e2e/003-identify-ingestion-alerts   (E2E_DATABASE_URL / E2E_PORT / E2E_GEM_PORT as usual)
# Why not `playwright test <dir>`: Playwright runs project by project (all desktop, then all mobile), and the 003 @mobile
# scenarios reuse the state their own file's desktop run left behind, which the next file's reset (resetIngestionData) clears.
set -uo pipefail
cd "$(dirname "$0")/../.."
dir="${1:?usage: run-spec-dir.sh <e2e/dir>}"; rc=0
for f in "$dir"/*.e2e.ts; do
  echo "=== $f"; pnpm exec playwright test "$f" || rc=1
done
exit $rc
