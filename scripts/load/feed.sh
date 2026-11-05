#!/usr/bin/env bash
# Feed load test (spec 008 FR-033, NFR-001, US4 scenario 4): N requests per feed variant with C in parallel,
# reports p50/p95/max latency and the non-2xx count per variant. Exit 1 when a p95 is over the budget or any
# request failed.
#
#   scripts/load/feed.sh [BASE_URL]                      # default http://localhost:8787
#   N=200 C=10 P95_BUDGET_MS=300 COOKIE='tp_session=…' scripts/load/feed.sh http://localhost:8791
#
# Without COOKIE a fresh owner is signed up per variant, so N requests per variant stay under the per-user API limit
# (`api.user`, 600/min; one cookie for all 4×200 requests trips it on a fast host). For the 500k-tender check, load
# the fixture first:
# Repeated runs: auth.signup.ip allows only 20 signups/hour per IP (4 per run), so set COOKIE for repeats.
#   DATABASE_URL=… pnpm --filter @tp/db exec tsx src/fixtures/bulk-tenders.ts --count 500000
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
BASE="${1:-${BASE_URL:-http://localhost:8787}}"
N="${N:-200}"; C="${C:-10}"; BUDGET="${P95_BUDGET_MS:-300}"
VARIANTS=(
  "/api/tenders"
  "/api/tenders?sort=endAt"
  "/api/tenders?state=Maharashtra"
  "/api/tenders?minValue=500000"
)
echo "feed.sh  base=$BASE  requests/variant=$N  concurrency=$C  p95 budget=${BUDGET} ms  ($(date -u +%FT%TZ))"
printf '%-34s %6s %9s %9s %9s %7s %s\n' variant n p50_ms p95_ms max_ms non2xx verdict
fail=0
for v in "${VARIANTS[@]}"; do
  cookie="${COOKIE:-$(signup "$BASE" feed)}"
  out="$(seq "$N" | xargs -P "$C" -I{} curl -sS -o /dev/null -H "cookie: $cookie" -w '%{http_code} %{time_total}\n' "$BASE$v" || true)"
  non2xx="$(awk '$1 !~ /^2/ {n++} END {print n+0}' <<<"$out")"
  read -r n p50 p95 max < <(awk '$1 ~ /^2/ {print $2}' <<<"$out" | percentiles)
  verdict=ok
  if [ "$non2xx" -gt 0 ] || awk -v p="$p95" -v b="$BUDGET" 'BEGIN{exit !(p=="NaN" || p+0 > b+0)}'; then verdict=FAIL; fail=1; fi
  printf '%-34s %6s %9s %9s %9s %7s %s\n' "${v#/api}" "$n" "$p50" "$p95" "$max" "$non2xx" "$verdict"
done
total="$(curl -sS -H "cookie: $cookie" "$BASE/api/ingestion/runs" | json 'j.openTenders + " open / " + j.totalTenders + " total tenders"')"
echo "dataset: $total"
exit "$fail"
