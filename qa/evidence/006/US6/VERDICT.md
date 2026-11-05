## QA verdict — APPROVED

**Work item:** #188 · **PR:** #520 · **Branch/HEAD under test:** story/GEM-188-assisted-submission @ e54ca9c · **Reviewer:** qa (claude-code / Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mEtEp4yfQg82nf4ywc

**Round 2.** Round 1 (@ 2822a58) was rejected for: axe violations (Submit step, values editor), DSC PIN not outlined red, raw `no_value` in the fill report, missing "Build the packet first…" row before build, popup Connect form visible while connected, copy mismatches. All were fixed in e54ca9c and re-verified below. Extension was rebuilt (`pnpm --filter @tp/extension build`) before the run.

**Playwright:** `pnpm exec playwright test e2e/006-apply-packet-assist/US6*` → **21 passed, 0 failed** (desktop 16 passed, mobile 375px 5 passed).
**API:** `vitest run test/assist.test.ts test/tokens.test.ts` → **35 passed** (assist 12, tokens 23), 2 files.
Test corrections (mine, justified by the spec): S3 group heading expectation changed to the spec text "Declaration" (spec.md scenario 3); the "Not set" italic assertion now reads the inner `<span>` (the developer moved the italic from `dd` to its child span; rendered result is still italic, see screenshot).

Evidence base: this folder (31 PNG, 21 webm, API transcripts `api-*.json`, axe results `*.axe.json`).

### Round-1 failures re-verified

| Round-1 failure | Result | Evidence |
|---|---|---|
| axe serious on Submit step / values editor | fixed: 0 serious/critical on Submit step (desktop + mobile), values editor, token dialog (desktop + mobile) | `submit-step-desktop.axe.json`, `submit-step-mobile.axe.json`, `values-editor-desktop.axe.json`, `token-dialog-*.axe.json` |
| DSC PIN not outlined red | fixed: DSC PIN outlined red with price/total/rate/CAPTCHA/OTP | ![s9](../../../../qa/evidence/006/US6/s9-highlighted-page-desktop.png) |
| raw `no_value` in fill report | fixed: Model reads "no prepared value" | ![s15](../../../../qa/evidence/006/US6/s15-fill-report-desktop.png) |
| no "Build the packet first…" before build | fixed: row shown above the 6 mapped docs before build | ![s6 before](../../../../qa/evidence/006/US6/s6-before-build-desktop.png) |
| popup Connect form visible when connected | fixed: connected popup shows only workspace/values/steps | ![s8](../../../../qa/evidence/006/US6/s8-popup-connected-desktop.png) |
| copy mismatches | fixed: step 3 "Authenticate with OTP / DSC / e-Sign", group "Declaration" (S3 passes on spec text) | `s1-submit-step-desktop.png`, `s3-values-card-desktop.png` |

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Submit step shows 4 Human-only steps and the 'never stores GeM passwords, enters prices…' line | met | ![s1](../../../../qa/evidence/006/US6/s1-submit-step-desktop.png) mobile: `s1-submit-step-mobile.png` |
| 2 | GET /assist/{id}: noFinancials true, 14 fields in catalog order with values/sources, no price-like keys/values | met | `api-s2-assist-payload.json` |
| 3 | Values card title/intro, grouped, 'Not set' italic, Copy disabled when empty | met | ![s3](../../../../qa/evidence/006/US6/s3-values-card-desktop.png) |
| 4 | Edit values: only changed keys PUT, 200, 'Values saved', source saved, Model in annexures; empty clears; Cancel discards | met | `api-s4-edit-values.json`, `s4-editor-open-desktop.png`, `s4-saved-desktop.png`, `s4-cleared-falls-back-desktop.png` |
| 5 | PUT forbidden spellings -> 400 forbidden_field + details.forbidden; unknown not allow-listed; non-text 'Must be text'; >2000 rejected; Viewer 403 | met | `api-s5-assist-values-guards.json` |
| 6 | Upload order: merged packet first (Merged badge + file name), vault docs once, required annexures (no MAF request); before build 'Build the packet first — the merged PDF will appear here.' | met (both halves) | ![s6 after](../../../../qa/evidence/006/US6/s6-after-build-desktop.png) `api-s6-upload-order.json`, `s6b-build-first-desktop.png` |
| 7 | Connect validation messages (URL, tp_ prefix, revoked token), host permission for that origin only, 'Connected as <name> (<org>)' | met for messages and Connected-as; host-permission prompt **unverifiable** in automation (origin asserted `http://localhost:8788/*`, optional permission only) | `s7-bad-url-desktop.png`, `s7-revoked-token-desktop.png`, `s7-connected-desktop.png` |
| 8 | Workspace select lists only go/preparing/ready/submitted bids; popup shows Bid, Readiness, Open workspace, values, upload order, human-only steps | met | ![s8](../../../../qa/evidence/006/US6/s8-popup-connected-desktop.png) |
| 9 | Highlight: indigo dashed + TP chips on fillable fields, red on price/CAPTCHA/OTP/DSC, status counts | met (DSC fixed) | `s9-highlighted-page-desktop.png`, `s9-popup-status-desktop.png` |
| 10 | TP chip fills only that field, green, '✓' | met | `s10-chip-filled-desktop.png` |
| 11 | Fill allowed fields: empty allow-listed fields, input/change events, no overwrite, skips disabled/no value; forbidden never written; never submitted | met (6 filled; typed Brand and disabled Delivery kept; price/total/rate/CAPTCHA/OTP/DSC/file/e-Sign/Final Submit untouched; no click/submit/POST/navigation) | `s11-page-after-fill-desktop.png`, `s11-manual-radio-chip-desktop.png` |
| 12 | Non-GeM tab shows 'Open the GeM bid participation page in this tab first…' | met | `s12-not-gem-tab-desktop.png` |
| 13 | (FR-073) content script ignores foreign senders; https-only GeM matches | met (real foreign sender is unit-test only) | `s13-foreign-ignored-desktop.png` |
| 14 | (FR-074) read-only token: GETs work, writes 403 'This API token is read-only' | met | `api-s14-readonly-token.json`, `s14-token-dialog-desktop.png`, `s14-token-dialog-mobile.png` |
| 15 | (FR-075) popup lists filled/skipped with reasons, Clear highlights | met (reason text fixed) | `s15-fill-report-desktop.png`, `s15-cleared-desktop.png` |
| QA | axe: 0 serious/critical on Submit step, token dialog, values editor | met | `*.axe.json` (0 each) |
| QA | Constitution: extension never writes price/CAPTCHA/OTP/DSC, never submits | met | S11 |

### Videos
One webm per test in the evidence folder, e.g. [S6](./s6-upload-in-this-order-merged-packet-first-merged-badge-fil-desktop.webm), [S9/S10](https://github.com/Shashank2577/GEMs/blob/__SHA__/qa/evidence/006/US6/s9-s10-highlight-fields-indigo-dashed-tp-chips-red-on-price--desktop.webm), [S11/S15](https://github.com/Shashank2577/GEMs/blob/__SHA__/qa/evidence/006/US6/s11-s15-constitution-fill-allowed-fields-fills-empty-allow-l-desktop.webm), [S8](https://github.com/Shashank2577/GEMs/blob/__SHA__/qa/evidence/006/US6/s8-workspace-select-lists-only-go-preparing-ready-submitted--desktop.webm).

### Findings
None blocking. Observation: invalid-token message wording "invalid, expired or was revoked" vs spec "invalid or was revoked" (not re-flagged as a failure; both convey the same).

### Not checked
- Chrome host-permission prompt (stubbed; origin string asserted). Popup cross-origin fetch used `--disable-web-security` (harness only).
- Foreign real extension `sender.id` (unit tests only).
- Real GeM pages; only `apps/extension/test/fixtures/gem-form.html`.
- Mobile covers Submit step, values card, upload order, token dialog only.

An approval covers what is in the table above. It is not a statement that the change is free of defects.

### Bug issues filed
None.

### Verdict
`qa:approved` — every criterion met (host-permission prompt is a harness limit). T086 ticked.
