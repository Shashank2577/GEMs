#!/usr/bin/env bash
# CI E2E shard runner (spec 008 FR-001/FR-002, NFR-007). Usage: scripts/e2e-ci.sh <shard> <total>
#
# Each story's E2E assumes a fresh database (QA runs `pnpm exec playwright test e2e/<NNN>/US<n>*`), so the suite is not
# run as one Playwright invocation: every spec file of this shard (scripts/e2e-shard.ts) gets its own `playwright test
# <file>` run, whose webServer (e2e/support/start-api.sh) drops/recreates E2E_DATABASE_URL and boots a fresh API +
# mock-gem. The SPA is built once. Each run writes a blob report to qa/.runs/<port>/blob/<tag>/ and its traces/videos
# to qa/.runs/<port>/artifacts/<tag>/ (E2E_RUN_TAG) so nothing is wiped by the next run; the `e2e` job merges the blobs
# into results.json + the HTML report. The API's log goes to qa/.runs/<port>/api-<tag>.log (E2E_API_LOG, read by 008/US6).
# Exits non-zero if any file failed (all files still run).
set -uo pipefail
cd "$(dirname "$0")/.."
shard="${1:?shard}"; total="${2:?total}"
PORT="${E2E_PORT:-8788}"
mapfile -t files < <(pnpm exec tsx scripts/e2e-shard.ts "$shard" "$total")
echo "e2e shard $shard/$total: ${#files[@]} spec file(s)"
printf '  %s\n' "${files[@]}"
[ "${#files[@]}" -eq 0 ] && exit 0
pnpm --filter @tp/web build >/dev/null || exit 1
failed=()
i=0
for f in "${files[@]}"; do
  i=$((i + 1))
  tag="s${shard}-$(printf '%02d' "$i")"
  # Extra server environment a spec declares in its header: `@e2e-env KEY=value KEY2=value2` (no spaces in values).
  read -r -a extra_env <<< "$(sed -n 's/^.*@e2e-env[[:space:]]\{1,\}//p' "$f" | tr '\n' ' ')"
  echo "::group::[$tag] playwright test $f${extra_env[*]:+ (env: ${extra_env[*]})}"
  if ! env "${extra_env[@]}" E2E_SKIP_BUILD=1 E2E_RUN_TAG="$tag" E2E_BLOB_DIR="qa/.runs/$PORT/blob/$tag" \
      E2E_API_LOG="qa/.runs/$PORT/api-$tag.log" pnpm exec playwright test "$f"; then
    failed+=("$f")
  fi
  echo "::endgroup::"
done
if [ "${#failed[@]}" -gt 0 ]; then
  printf '::error title=e2e shard %s/%s::failed: %s\n' "$shard" "$total" "${failed[*]}"
  exit 1
fi
echo "e2e shard $shard/$total: all ${#files[@]} file(s) passed"
