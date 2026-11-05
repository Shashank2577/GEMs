## QA verdict — APPROVED

**Work item:** #7 · **PR:** #502 · **Reviewer:** qa (claude-code/Sonnet 5.5) · **Reviewed HEAD:** `6295a336df77eb55122967a35fdd33b8b2c982a3` (developer review-fix commit on top of c0a2c8b; the suite was run against c0a2c8b in a clean checkout and re-run on 6295a33 with identical results) · **Session:** https://claude.ai/code/session_01BUi6mFdfjz9y1F3zKYmWQB

Tests: `e2e/002/US5-api-tokens.e2e.ts`: **16 passed, 0 failed** (desktop 11, mobile/Pixel 7 5; the 5 `@mobile` tests also run on desktop), `E2E_PORT=8790 E2E_GEM_PORT=4013 pnpm exec playwright test e2e/002/US5`.
API suite: **388 passed, 1 skipped (pre-existing perf test), 0 failed** across 21 files; `tokens.test.ts` 8/8 (incl. the new removed-member-during-create race test) (verbose in api-tests.txt).
Bearer checks use a cookie-less `request` context with only an `Authorization` header. Expiry states and the lastUsedAt window were driven by editing `api_tokens` in the e2e DB (test fixture only).

### Acceptance criteria (spec US5)

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1a | sc1: empty state "No tokens yet — Create one to connect the browser extension." | met | sc1-empty-state-guide-desktop.png; sc1-empty-state-guide-mobile.png |
| 1b | sc1: 4-step extension setup guide | met | same screenshots; test asserts 4 `li` with step contents |
| 1c | sc1: "You stay in control" compliance note | met | same screenshots; sc1 webm |
| 2a | sc2: default name "Chrome extension"; POST returns 201 `{id,name,createdAt,lastUsedAt:null,token}` | met | sc2-create-dialog-desktop.png; key set + `lastUsedAt:null` asserted; sc2-create-default-name-...-desktop.webm |
| 2b | sc2: `token` starts with `tp_` | met | regex assert; sc2-secret-shown-once-desktop.png |
| 2c | sc2: dialog "Copy your new token — This is the only time it’s shown.", Copy button, "I’ve saved it" | met | sc2-secret-shown-once-desktop.png; sc2-secret-shown-once-mobile.png (clipboard content asserted equal to token) |
| 2d | sc2: after closing, list shows "Chrome extension · Created <date> · never used" | met | sc2-list-after-close-desktop.png; sc2-list-after-close-mobile.png |
| 2e | sc2: secret never shown again; list response has no `token` field | met | page text/HTML after close and reload, list JSON, reopened dialog all checked; sc2-reopened-dialog-no-secret-desktop.png |
| 3a | sc3: Bearer authenticates as the token's user in the token's org | met | `/api/auth/me` via bearer: same email and org id; sc3-bearer-authenticates-...-desktop.webm |
| 3b | sc3: with the user's current role | met | viewer token 403 on POST /api/watchlists, then after owner promotes to analyst `/me` role=analyst and POST not 403; sc3b-token-request-uses-the-user-s-current-role-...-desktop.webm; sc3b-owner-page.png |
| 3c | sc3: `lastUsedAt` updated at most once per minute | met | 3 calls in-window leave timestamp unchanged; after backdating 2 min it refreshes (values in test annotations); sc3-list-last-used.png |
| 4 | sc4: bearer on POST /me/api-tokens, POST /me/password, POST /auth/switch-org → 403 "This action requires signing in on the web app" | met | all three asserted for status+message; password unchanged; sc4-token-authenticated-account-endpoints-...-desktop.webm; sc4-token-list-after-403s.png |
| 5a | sc5: Revoke → confirm "Revoke token" in "Revoke “Chrome extension”?" | met | sc5-revoke-dialog-desktop.png; sc5-revoke-dialog-mobile.png |
| 5b | sc5: DELETE returns `{ok:true}` | met | response body asserted; sc5-revoke-via-ui-...-desktop.webm |
| 5c | sc5: toast "Token revoked" | met | sc5-after-revoke-desktop.png; sc5-after-revoke-mobile.png |
| 5d | sc5: token immediately 401 | met | bearer 200 before, 401 after on /workspaces and /auth/me |
| 6 | sc6: user A revoking user B's token id → 404 "API token not found" | met | status+message asserted; B's token still 200; sc6-user-a-revoking-...-desktop.webm; sc6-a-has-no-tokens.png |
| 7 | sc7: member removed from org → token 401 (tokens deleted) | met | bearer 200 → owner DELETE member → 401, 0 rows left in api_tokens; sc7-team-before-removal.png; sc7-team-after-removal.png |
| 8a | sc8 (gap): create dialog offers 30 days / 90 days (default) / 1 year / Never | met | options list + 90 days selected asserted; sc8-expiry-options-open.png |
| 8b | sc8: token stores `expiresAt` (default 90d, 30, 365, null) | met | API + UI-created 30-day token asserted; sc8-expiry-choices-stored-...-desktop.webm |
| 8c | sc8: list shows "Expires in N days", amber under 7 days | met | "Expires in 3 days" has warning classes, "Expires in 8 days" neutral; sc8-list-expiry-states.png |
| 8d | sc8: red "Expired" | met | danger classes; sc8-list-expiry-states.png |
| 8e | sc8: expired token returns 401 | met | expired 401; 3-day and 8-day tokens 200 |
| 9a | sc9 (gap): each row shows last 4 chars `tp_…a1B2` | met | 10 rows, hint equals `token.slice(-4)`; sc9-ten-tokens-with-hints-desktop.png; sc9-ten-tokens-with-hints-mobile.png |
| 9b | sc9: max 10 active; 11th → 409 "You already have 10 tokens. Revoke one first." | met | API status+message, UI toast; revoking one frees a slot; sc9-eleventh-409-toast-desktop.png; sc9-eleventh-409-toast-mobile.png |
| T | Independent Test: create in UI, bearer GET /workspaces 200, bearer POST /me/api-tokens 403, revoke, GET 401 | met | independent-flow-done-desktop.png; independent-flow-done-mobile.png; independent-test-...-desktop.webm / -mobile.webm |
| M | T078 `@mobile` layout (375/Pixel 7): no horizontal overflow, dialogs fit | met | scrollWidth <= innerWidth asserted in sc1, sc2, sc5, sc9 on mobile; *-mobile.png files above |
| A | API-level coverage (T077) | met | api-tests.txt (tokens.test.ts 8/8; 388 total) |

### Findings

1. **observation** — Uncommitted developer edits were seen in the shared worktree mid-review; they turned out to be commit 6295a33 (lock order, removed-member race, constants). They were not committed by QA; the final run covers 6295a33.
2. **observation** — A full-page screenshot dismisses the open Radix Select popup (test technique only; sc8-expiry-options-open.png is a viewport capture).
3. **observation** — Badge colours are verified by token classes (`warning` / `danger`) plus the screenshot, not by computed contrast.

### Not checked

- axe accessibility scan (`a11y` helper is not on main yet).
- Real Chrome extension consuming a token (extension not driven; bearer behaviour verified over HTTP only).
- Dark theme, and widths other than desktop 1440 and Pixel 7.
- Concurrent creation race on the 10-token limit and the removed-member race are covered only by the developer's API test (tokens.test.ts), not by e2e.
- Clock-based "Expires in N days" rounding at exact boundaries beyond 3, 8, 30, 90, 365.
- `activity_log` entries for token create/revoke (belongs to US6).

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion met, evidence above.
