## QA verdict — APPROVED

**Work item:** #358 · **PR:** #499 · **Reviewer:** qa (claude-code) · **Spec:** 008 User Story 3 (T058)

Run: `pnpm exec playwright test e2e/008-operations-scale/US3*` → **11 passed, 0 failed** (9 desktop + 2 `@mobile` at Pixel 7 / 375 px class width).
API: `pnpm --filter @tp/api exec vitest run` → **483 passed, 2 skipped (perf, opt-in), 0 failed** (27 files).

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Org A loads demo: A sees 40 demo bids; org B feed shows none, dashboard tiles unchanged, preview returns no demo tender | met | sc1-orgA-feed-demo-desktop.png, sc1-orgB-feed-no-demo-desktop.png, sc1-orgB-dashboard-desktop.png, sc1-orgB-watchlist-preview-desktop.png, sc1-demo-isolation-desktop.txt (A: 41 bids = 40 demo + 1 mock-gem; B: 1; B dashboard tiles == never-seeded org C) |
| 2 | Org B watchlist `laptop` + matching run: no tender_matches / notifications for org B reference a demo tender | met | sc2-no-matches-desktop.txt (SQL: 0 / 0 for B; demo laptop tenders exist; control org A keeps its demo matches) |
| 3 | Data-fix migration: demo-marked `source='gem'` rows become `source='demo'`; non-demo orgs' matches deleted | met | sc3-datafix-desktop.txt (0009 applied to legacy row: source=demo, org B match deleted, org A match kept, real bid untouched, idempotent on 2nd run) |
| 4 | Org B calling org A's ids (GET/PATCH/DELETE/POST) → 404 `not_found`, A rows unchanged; enforced by isolation test | met | sc4-cross-org-404-desktop.txt (10 calls all 404, A snapshot identical), sc4-orgB-opens-orgA-workspace-desktop.png; `isolation-contract.test.ts` passes in the API run |
| 5 | 10 wrong logins + 11th → 429 `rate_limited`, `Retry-After`, `details.rule=auth.fail.email`; inline role=alert message; button enabled | met (desktop + mobile) | sc5-login-429-desktop.png, sc5-login-429-mobile.png, sc5-login-429-*.txt |
| 6 | 31 previews/60 s: 1-30 → 200, 31 → 429 `watchlist.preview.user`; editor shows "Preview paused — try again in N s" | met (desktop + mobile) | sc6-preview-paused-desktop.png, sc6-preview-paused-mobile.png, sc6-preview-paused-*.txt |
| 7 | 30 MB to all three upload routes → 413 `payload_too_large` before reading body, < 200 ms | met | sc7-upload-413-desktop.txt (vault POST 48 ms, vault PUT 30 ms, tender documents 30 ms; real 30 MB bodies) |
| 8 | Limiter unreachable: generic rules fail open + warn log; auth-failure rules fail closed 503 | met (partly via API tests) | sc8-limiter-unavailable-desktop.txt (tables renamed: preview 200, org 200, login 503 `service_unavailable`, restored → 200). Per-IP rules and the `rate_limit_unavailable` log line are not observable in E2E; covered by `ops-limits.test.ts` (passes) |
| 9 | Cookie POST with `Origin: https://evil.example` → 403 `bad_origin`; same with Bearer accepted | met | sc9-bad-origin-desktop.txt, sc9-app-same-origin-works-desktop.png |

### Findings

1. **observation** — Spec scenario 5 example says "Try again in 14 minutes"; immediately after the 10th failure the server (correctly) says "15 minutes" (retryAfter 900). The 14-minute wording is the API test's one-minute-later case. Not a defect.
2. **observation** — In Node/E2E the per-IP rules (`auth.signup.ip`, `auth.fail.ip`, `api.ip`) are skipped because a loopback socket is "IP unknown" by design (`lib/client-ip.ts`); production needs `TRUST_PROXY=1` or Cloudflare. Verified only at API level here.

### Not checked
- Per-IP limits and the `rate_limit_unavailable` log line against a real proxy / Worker; production Neon behaviour; the data-fix migration on a production-size dataset.

### Verdict

`qa:approved` — every criterion 1-9 met, evidence above.
