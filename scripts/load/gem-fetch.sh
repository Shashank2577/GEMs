#!/usr/bin/env bash
# GeM politeness load test (spec 008 FR-024, FR-033, NFR-002, US4 scenario 1): K orgs call
# POST /api/tenders/:id/fetch-documents for K different tenders at the same instant, then the mock-gem request log
# (GET /__admin/requests) gives the arrival time of every GeM document request. Passes when every gap between
# consecutive GeM requests is ≥ MIN_GAP_MS (default 1000 − 20 ms tolerance) and every call answered 2xx or
# 503 gem_busy.
#
#   scripts/load/gem-fetch.sh [BASE_URL] [MOCK_GEM_URL]     # defaults http://localhost:8787 http://127.0.0.1:4010
#   K=20 scripts/load/gem-fetch.sh http://localhost:8791 http://127.0.0.1:4014
#
# The API must run with the cluster-wide lease on (GEM_MIN_INTERVAL_MS ≥ 1000, the default) against mock-gem.
# GeM documents are shared once fetched, so use tenders without a GeM document (a fresh database: 36 mock bids;
# bulk-fixture rows are skipped — their synthetic bid ids do not exist on mock-gem).
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
BASE="${1:-${BASE_URL:-http://localhost:8787}}"
GEM="${2:-${MOCK_GEM_URL:-http://127.0.0.1:4010}}"
K="${K:-20}"; MIN_GAP_MS="${MIN_GAP_MS:-980}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
echo "gem-fetch.sh  base=$BASE  mock-gem=$GEM  orgs/tenders=$K  min gap=${MIN_GAP_MS} ms  ($(date -u +%FT%TZ))"

for i in $(seq "$K"); do signup "$BASE" "org$i" >"$work/cookie.$i" & done; wait
first="$(cat "$work/cookie.1")"

# Make sure tenders exist (a cooldown/409 answer means a sync already ran — fine).
curl -sS -o /dev/null -w 'ingestion: HTTP %{http_code}\n' -X POST "$BASE/api/ingestion/run" -H "cookie: $first" -H 'content-type: application/json' -d '{"pages":5}'
curl -sS -H "cookie: $first" "$BASE/api/tenders?pageSize=100" | json 'j.items.filter(t=>t.gemBidId && t.source!=="bulk").map(t=>t.id).join("\n")' >"$work/all"
: >"$work/ids"
while read -r id; do
  [ "$(wc -l <"$work/ids")" -ge "$K" ] && break
  has="$(curl -sS -H "cookie: $first" "$BASE/api/tenders/$id" | json 'j.documents.some(d=>!d.orgOwned)')"
  [ "$has" = "false" ] && echo "$id" >>"$work/ids"
done <"$work/all"
got="$(wc -l <"$work/ids")"
[ "$got" -ge "$K" ] || { echo "only $got tenders without a GeM document (need $K) — use a fresh database" >&2; exit 2; }

since="$(curl -sS "$GEM/__admin/requests" | json 'j.items.length')"
start_ms="$(date +%s%3N)"
paste -d' ' <(seq "$K") "$work/ids" | xargs -P "$K" -n 2 sh -c '
  cookie="$(cat "'"$work"'/cookie.$0")"
  curl -sS -o "'"$work"'/body.$0" -w "%{http_code} %{time_total}\n" -X POST "'"$BASE"'/api/tenders/$1/fetch-documents" -H "cookie: $cookie" >"'"$work"'/status.$0"'
end_ms="$(date +%s%3N)"

echo "calls (org: HTTP status, seconds):"
for i in $(seq "$K"); do printf '  org%-3s %s\n' "$i" "$(cat "$work/status.$i")"; done
bad="$(for i in $(seq "$K"); do read -r code _ <"$work/status.$i"; case "$code" in 2*) ;; 503) grep -q gem_busy "$work/body.$i" || echo x ;; *) echo x ;; esac; done | wc -l)"
busy="$(for i in $(seq "$K"); do grep -l gem_busy "$work/body.$i" 2>/dev/null || true; done | wc -l)"

curl -sS "$GEM/__admin/requests" | json "j.items.slice($since).filter(r=>r.path.startsWith('/showbidDocument/')).map(r=>r.at)" >"$work/arrivals"
report="$(node -e "
const a=JSON.parse(require('fs').readFileSync('$work/arrivals','utf8')).sort((x,y)=>x-y);
const gaps=a.slice(1).map((t,i)=>t-a[i]);
const t0=a[0]??0;
console.log('mock-gem document requests: '+a.length);
console.log('arrival offsets (ms): '+a.map(t=>t-t0).join(' '));
console.log('inter-arrival gaps (ms): '+gaps.join(' '));
console.log('min gap: '+(gaps.length?Math.min(...gaps):'n/a')+' ms   mean gap: '+(gaps.length?(gaps.reduce((x,y)=>x+y,0)/gaps.length).toFixed(0):'n/a')+' ms');
process.exitCode = gaps.some(g=>g<$MIN_GAP_MS) ? 1 : 0;
")" && gap_ok=1 || gap_ok=0
echo "$report"
echo "wall clock: $((end_ms - start_ms)) ms   503 gem_busy: $busy   unexpected answers: $bad"
if [ "$gap_ok" = 1 ] && [ "$bad" -eq 0 ]; then echo "RESULT: PASS (every GeM request ≥ ${MIN_GAP_MS} ms apart)"; else echo "RESULT: FAIL"; exit 1; fi
