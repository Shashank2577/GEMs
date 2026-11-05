#!/usr/bin/env bash
# Post-deploy smoke test (spec 008 FR-008, US2 scenarios 2 and 4).
#
#   scripts/smoke.sh <base-url> <version>
#   scripts/smoke.sh https://staging.tenderpilot.in 1a2b3c4
#   scripts/smoke.sh http://localhost:8787 0.1.0          # local Node stack (pnpm --filter @tp/api start)
#
# Checks, printing a transcript (one PASS/FAIL line per check):
#   GET /api/health  → 200, JSON "version" = <version>
#   GET /            → 200, text/html, contains <div id="root">, carries the HTML Content-Security-Policy
#   GET /api/nope    → 404, JSON error.code = not_found
#   all three        → X-Content-Type-Options, Referrer-Policy, Permissions-Policy (FR-013);
#                      Strict-Transport-Security only when <base-url> is https:// (never sent over plain http)
# Exit 0 when every check passes, 1 on any mismatch, 2 on bad usage. Needs curl and node (for JSON parsing).
# SMOKE_RETRIES (default 5) / SMOKE_RETRY_DELAY (seconds, default 6) retry /api/health until the new version is live.
set -uo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <base-url> <version>" >&2
  exit 2
fi
BASE="${1%/}"
VERSION="$2"
RETRIES="${SMOKE_RETRIES:-5}"
DELAY="${SMOKE_RETRY_DELAY:-6}"

EXPECT_HSTS='max-age=31536000; includeSubDomains'
EXPECT_NOSNIFF='nosniff'
EXPECT_REFERRER='strict-origin-when-cross-origin'
EXPECT_PERMISSIONS='camera=(), microphone=(), geolocation=()'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }

# fetch <name> <path> → $TMP/<name>.headers, $TMP/<name>.body; echoes the status code.
fetch() {
  local code
  : >"$TMP/$1.body"; : >"$TMP/$1.headers"
  code="$(curl -sS -o "$TMP/$1.body" -D "$TMP/$1.headers" -w '%{http_code}' --max-time 20 "$BASE$2" 2>"$TMP/$1.err")" || true
  echo "${code:-000}"
}

# header <name> <header-name> → value of the last occurrence (case-insensitive), CR stripped.
header() {
  awk -v h="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" '
    { line = $0; sub(/\r$/, "", line); i = index(line, ":") }
    i > 0 && tolower(substr(line, 1, i - 1)) == h { v = substr(line, i + 1); sub(/^[ \t]+/, "", v); out = v }
    END { print out }' "$TMP/$1.headers"
}

# json <name> <dotted.path> → value or empty.
json() {
  node -e '
    let v; try { v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
    for (const k of process.argv[2].split(".")) v = v == null ? undefined : v[k];
    if (v !== undefined && v !== null) process.stdout.write(String(v));' "$TMP/$1.body" "$2"
}

expect_eq() { # <label> <actual> <expected>
  if [ "$2" = "$3" ]; then pass "$1 = $3"; else fail "$1: expected '$3', got '${2:-<missing>}'"; fi
}

check_security_headers() { # <name>
  expect_eq "$1 x-content-type-options" "$(header "$1" x-content-type-options)" "$EXPECT_NOSNIFF"
  expect_eq "$1 referrer-policy" "$(header "$1" referrer-policy)" "$EXPECT_REFERRER"
  expect_eq "$1 permissions-policy" "$(header "$1" permissions-policy)" "$EXPECT_PERMISSIONS"
  case "$BASE" in
    https://*) expect_eq "$1 strict-transport-security" "$(header "$1" strict-transport-security)" "$EXPECT_HSTS" ;;
    *) printf '  SKIP  %s strict-transport-security (http base URL; HSTS is only sent over https)\n' "$1" ;;
  esac
}

echo "smoke: $BASE expecting version $VERSION ($(date -u +%Y-%m-%dT%H:%M:%SZ))"

# 1. Health + version (retry: a fresh deploy can take a few seconds to reach every edge location).
echo "GET /api/health"
attempt=1
while :; do
  status="$(fetch health /api/health)"
  got="$(json health version)"
  if [ "$status" = "200" ] && [ "$got" = "$VERSION" ]; then break; fi
  if [ "$attempt" -ge "$RETRIES" ]; then break; fi
  printf '  ....  attempt %s: status %s, version %s; retrying in %ss\n' "$attempt" "$status" "${got:-<none>}" "$DELAY"
  attempt=$((attempt + 1))
  sleep "$DELAY"
done
expect_eq "health status" "$status" "200"
expect_eq "health version" "$got" "$VERSION"
expect_eq "health db" "$(json health db)" "true"
check_security_headers health

# 2. SPA shell.
echo "GET /"
status="$(fetch root /)"
expect_eq "/ status" "$status" "200"
ctype="$(header root content-type)"
case "$ctype" in text/html*) pass "/ content-type = $ctype" ;; *) fail "/ content-type: expected text/html, got '${ctype:-<missing>}'" ;; esac
if grep -q '<div id="root">' "$TMP/root.body"; then pass '/ contains <div id="root">'; else fail '/ body does not contain <div id="root">'; fi
csp="$(header root content-security-policy)"
for directive in "default-src 'self'" "script-src 'self' 'sha256-" "frame-ancestors 'self'" "object-src 'none'"; do
  case "$csp" in *"$directive"*) pass "/ content-security-policy has $directive" ;; *) fail "/ content-security-policy missing \"$directive\" (got '${csp:-<missing>}')" ;; esac
done
check_security_headers root

# 3. Unknown API route → JSON 404, never the SPA.
echo "GET /api/nope"
status="$(fetch nope /api/nope)"
expect_eq "/api/nope status" "$status" "404"
expect_eq "/api/nope error.code" "$(json nope error.code)" "not_found"
check_security_headers nope

if [ "$FAILS" -gt 0 ]; then
  echo "smoke: FAILED ($FAILS check(s)) for $BASE"
  for f in "$TMP"/*.err; do [ -s "$f" ] && sed 's/^/  curl: /' "$f"; done
  exit 1
fi
echo "smoke: OK for $BASE (version $VERSION)"
