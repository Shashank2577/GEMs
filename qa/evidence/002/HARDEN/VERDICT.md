## QA verdict — APPROVED (recommended)

**Work item:** epic #2 (cross-cutting HARDEN) · **PR:** #511 · **Reviewer:** qa (claude-code/Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mKB2io1Xqg2BH1FPTX
**Commit tested:** 8de46cc. Isolated run: API :8820, mock-gem :8821, DB tenderpilot_e2e_hard_qa; API suites on tenderpilot_test_hard.

Runs: `pnpm exec playwright test e2e/002/HARDEN-security.e2e.ts --trace off` -> 8 passed (6 desktop, 2 mobile). API: security, secrets-leak, perf-auth, rate-limit, prefs -> 5 files, 51 tests passed (perf-auth p95: me 4 ms, login 72 ms).

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| T015 | `createOrgWithRoles` returns owner + bid_manager/analyst/viewer, usable as storage states | met | roles test: 4 distinct users, same org, `/auth/me` role matches, viewer 403 / bid_manager OK on demo seed; qa-roles-{owner,bid-manager,analyst,viewer}-account.png, helper-creates-one-org-*.webm |
| T099 / FR-050 headers (API) | nosniff, X-Frame-Options DENY, Referrer-Policy no-referrer on 200/401/404/POST; no CSP/HSTS on API over http | met | qa-headers-api.png, api-responses-*.webm; api test security.test.ts (15) |
| T099 / FR-050 CSP (SPA) | CSP on `/`, `/login`, deep links; script-src has sha256 of the inline theme script (recomputed), no unsafe-inline/eval; assets nosniff | met | qa-headers-spa.png, spa-documents-*.webm |
| FR-050 no CSP breakage | login, dashboard, settings at 1440 and 375: zero securitypolicyviolation events and zero CSP/other console errors | met | qa-csp-{login,dashboard,settings}-{1440,375}.png, *-mobile-login-dashboard-*.webm (desktop + mobile) |
| T100 / NFR-003 | no secret in logs, list responses, activity meta | met | secrets-leak.test.ts 1/1 passed |
| T101 / NFR-001 | /auth/me <= 4 queries; p95 smoke | met | perf-auth.test.ts 4/4; p95 me 4 ms, login 72 ms |
| #482 item 17 | notifications status line sr-only when empty, shown after test alert, cleared on save | met | qa-notif-status-{empty,filled,cleared}-{1440,375}.png |
| #482 item 1/rate limit | 11th bad login -> 429 `rate_limited`, Retry-After (<=900), right password also refused, UI shows "Try again in 15 minutes" | met | qa-rate-limited-login.png, repeated-bad-logins-*.webm; rate-limit.test.ts 19/19 (incl. IP-first ordering, blocked IP does not advance victim's email counter) |
| #482 item 19 | test-alert copy uses skipReasons; prefs.test.ts matches | met | prefs.test.ts 12/12; filled status line reads "Email not configured on this server" (qa-notif-status-filled-375.png) |
| #482 items 2,9,11 TRUST_PROXY docs | documented in .dev.vars.example, wrangler.toml (line 33), wiki/Runbook.md (line 30) | met | grep |
| Extension 401 copy | mentions "expired" | met | apps/extension/src/api.ts:34 (read only; extension tests not run) |
| T103 | contracts/api.md Platform section lists endpoints and error codes rate_limited, invite_email_mismatch, bad_origin, reset_invalid, token_limit | met | every documented platform route exists in apps/api/src/routes (auth, org, sessions, notifications, tokens); all 5 codes in the error table (lines 54-60) |
| T106 / FR-050 text | spec says no-referrer, as implemented | met | spec.md:328 matches observed headers |
| T106 /cairn-analyze run | task left unticked "on merge after review round 2" | unverifiable | not run by QA; tasks.md T106 is deliberately unticked |
| #482 items 3,4,5,12-15,18 | node.ts shutdown ordering, ResetPassword TTL text, etc. | unverifiable end-to-end | covered only by the developer-reported unit suites; QA did not re-run the whole suites |

### Findings
1. **observation** - Playwright video file names for `@mobile` tests start with "-" (title slug quirk in collectRunArtifacts); harmless.
2. **observation** - The error banner on the rate-limited login fades in; screenshot caught it mid-animation (text still legible).

### Not checked
- Full API/core/web suites (author reports core 384, api 453+2 skipped, web 164), items 3,4,5,12-15,18 beyond the files listed, Worker (non-Node) static responses and HSTS over https (API test only), and /cairn-analyze output.

### Verdict
`qa:approved` recommended: all verifiable criteria met.
