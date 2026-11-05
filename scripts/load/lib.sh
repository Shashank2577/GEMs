#!/usr/bin/env bash
# Shared helpers for scripts/load/*.sh (spec 008 FR-033). Needs curl and node (for JSON + percentiles).

# json <expr> — evaluate a JS expression against stdin parsed as JSON (`j`), print the result.
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s||'null');const r=($1);process.stdout.write(typeof r==='string'?r:JSON.stringify(r))})"; }

# signup <base> <label> → prints "tp_session=…" for a fresh owner of a fresh org (@example.in test users only, NFR-008).
signup() {
  local base="$1" label="$2" email jar cookie
  email="load.${label}.$(date +%s%N)@example.in"
  jar="$(mktemp)"
  curl -sS -c "$jar" -o /dev/null -X POST "$base/api/auth/signup" -H 'content-type: application/json' \
    -d "{\"name\":\"Load ${label}\",\"email\":\"${email}\",\"password\":\"load-test-pass-42\",\"orgName\":\"Load Org ${label}\"}"
  cookie="$(awk '$6=="tp_session"{print "tp_session="$7}' "$jar")"
  rm -f "$jar"
  [ -n "$cookie" ] || { echo "signup failed for $email" >&2; return 1; }
  echo "$cookie"
}

# percentiles — read one number (seconds) per line on stdin, print "n p50_ms p95_ms max_ms".
percentiles() {
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=s.trim().split(/\s+/).filter(Boolean).map(Number).sort((x,y)=>x-y);const q=p=>a.length?a[Math.min(a.length-1,Math.ceil(p*a.length)-1)]*1000:NaN;console.log(a.length,q(.5).toFixed(1),q(.95).toFixed(1),(a.at(-1)*1000).toFixed(1))})"
}
