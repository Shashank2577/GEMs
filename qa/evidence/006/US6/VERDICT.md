## QA verdict — REJECTED

**Work item:** #188 · **PR:** #520 · **Branch/HEAD under test:** story/GEM-188-assisted-submission @ 2822a58 · **Reviewer:** qa (claude-code / Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mEtEp4yfQg82nf4ywc

Suite: `e2e/006-apply-packet-assist/US6-assisted-submission.e2e.ts` — `pnpm exec playwright test e2e/006-apply-packet-assist/US6*` → **16 passed, 5 failed** (desktop 12 passed / 4 failed, mobile 4 passed / 1 failed; 21 test runs). Unit/API gates: extension vitest 34 passed, core assist 80 passed, API assist+tokens 35 passed (12 assist, 23 tokens).

Evidence base: https://github.com/Shashank2577/GEMs/blob/story/GEM-188-assisted-submission/qa/evidence/006/US6/ (screenshots `*.png`, one `.webm` per test, API transcripts `api-*.json`, axe results `*.axe.json`).

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Submit step shows 4 Human-only steps and the 'never stores GeM passwords, enters prices…' line | met (step 3 reads "Verify with OTP / DSC / e-Sign", spec says "Authenticate with…"; observation) | S1 `s1-submit-step-desktop.png`, `s1-submit-step-mobile.png` |
| 2 | GET /assist/{id}: noFinancials true, 14 fields in catalog order with values/sources, no price-like keys or values | met | S2 `api-s2-assist-payload.json` |
| 3 | Values card title/intro, grouped, 'Not set' italic, Copy buttons disabled when empty | met (group reads "Declarations", spec "Declaration"; observation). Copy writes the value to the clipboard (desktop) | S3 `s3-values-card-desktop.png` |
| 4 | Edit values -> only changed keys PUT, 200, 'Values saved', source saved, Model appears in annexures; empty string clears; Cancel discards | met | S4 `api-s4-edit-values.json`, `s4-editor-open-desktop.png`, `s4-saved-desktop.png`, `s4-cleared-falls-back-desktop.png` |
| 5 | PUT assist-values forbidden spellings -> 400 forbidden_field + details.forbidden; foo -> not allow-listed; non-text 'Must be text'; >2000 rejected; Viewer 403 | met (15 forbidden spellings, exact message, nothing stored, 2000 accepted / 2001 refused, viewer 403, anon 401) | S5 `api-s5-assist-values-guards.json` |
| 6 | Upload order after build: merged packet first with Merged badge + file name, vault docs once, required annexures (no MAF request); before build 'Build the packet first — the merged PDF will appear here.' | **not met (before-build half)**; after-build half met | After build: `s6-after-build-desktop.png`, `api-s6-upload-order.json`. Before build with the normal fixture the list shows 6 rows (4 vault + 2 annexure) and the text is NOT shown (`s6-before-build-desktop.png`); it appears only when there are zero documents (`s6b-build-first-desktop.png`). Spec scenario 6: "before any build the list reads …" |
| 7 | Extension connect validation messages (URL, tp_ prefix, revoked token), host permission for that origin only, 'Connected as <name> (<org>)' | met for messages and Connected-as (permission prompt stubbed); **host-permission prompt itself unverifiable** in automation (origin string asked = `http://localhost:8788/*`, manifest has no blanket host_permissions, optional only). Invalid-token text is "invalid, expired or was revoked" (spec "invalid or was revoked"; observation) | S7 `s7-bad-url-desktop.png`, `s7-revoked-token-desktop.png`, `s7-connected-desktop.png` |
| 8 | Workspace select lists only go/preparing/ready/submitted bids; popup shows Bid, Readiness, Open workspace, values, upload order, human-only steps | met (dropped + identified excluded, 48-char title cut, remembered choice, empty-org text) | S8 `s8-popup-connected-desktop.png` |
| 9 | Highlight fields: indigo dashed + TP chips on fillable fields, red outline on price/CAPTCHA/OTP/DSC; status text with counts | **not met for DSC**: price/total/rate/CAPTCHA/OTP are red, the DSC PIN field (`type=password`) is not outlined at all; chips, dashed outline, titles and status counts are correct | `s9-highlighted-page-desktop.png` (DSC PIN row has no red outline), `s9-popup-status-desktop.png` |
| 10 | TP chip fills only that field, green, '✓' | met (only `make` changed, chip `✓` rgb(5,150,105), overwrites typed value) | S10 `s10-chip-filled-desktop.png` |
| 11 | Fill allowed fields fills empty allow-listed fields with input/change events, select matching, no overwrite, skips disabled/no value; forbidden controls never written; form never submitted | met: 6 filled (make, qty, local content, country select, MSE select, "Yes"->"Yes, Complied"), each with `input`+`change`; typed Brand kept; disabled Delivery kept; Model (no value) kept; price/total/rate/CAPTCHA/OTP/DSC/file/radio/e-Sign/Final Submit untouched, no click/submit events, no POST, no navigation, `__submitted` false; dist JS has no click()/submit() | `s11-page-after-fill-desktop.png`, `s11-manual-radio-chip-desktop.png` |
| 12 | Non-GeM tab shows 'Open the GeM bid participation page in this tab first…' | met (scan, fill, clear) | `s12-not-gem-tab-desktop.png` |
| 13 | (gap FR-073) content script ignores foreign senders; https-only GeM matches | met: manifest matches `https://*.gem.gov.in/*` + localhost fixture only, page-world postMessage/CustomEvent cannot trigger it, unit test for foreign `sender.id` (content.test.ts, 5 tests). A real foreign-extension sender cannot be created in automation | S13 `s13-foreign-ignored-desktop.png` |
| 14 | (gap FR-074) read-only token: GETs work, writes 403 'This API token is read-only' | met (me/workspaces/assist/detail 200; PUT assist-values, POST comments, PATCH, packets, submitted, logout all 403 with the message; minting a broader token refused; full token control writes) | `api-s14-readonly-token.json`, `s14-token-dialog-desktop.png`, `s14-token-created-desktop.png`, `s14-token-dialog-mobile.png` |
| 15 | (gap FR-075) popup lists filled/skipped with reasons and has Clear highlights | **not met (reason text)**: skipped rows read "already has a value", "disabled" but a field with no value reads the raw code `no_value`, not "no prepared value". Fill report and Clear highlights otherwise work | `s15-fill-report-desktop.png`, `s15-cleared-desktop.png` |
| QA | axe: 0 serious/critical on Submit step, token dialog, values editor | **not met**: Submit step and values editor fail; token dialog clean | `submit-step-desktop.axe.json`, `values-editor-desktop.axe.json`, `token-dialog-desktop.axe.json` (0) |
| QA | Constitution: extension never writes price/CAPTCHA/OTP/DSC fields, never submits | met (see 11) | S11 |

### Findings

1. **blocking** — axe serious violations on the Submit step (desktop and 375px) and on the open values editor. Observed (`A1`, `A2`): `definition-list` (4 nodes: each `<dl>` has `div > div` and `div > button` children, i.e. copy button inside the `<dl>` group), `dlitem` (28; the `dt`/`dd` lose their `dl` parent), `color-contrast` 3.1:1 on the 10px "Not set" badge (`text-warning` on `bg-warning-soft`, 4 nodes; 1 in the editor). Expected 0 serious/critical. Where: `apps/web/src/features/workspace/SubmitStep.tsx` values card (`<dl>` rows, source badge). Header chrome (stage/owner/due-date popovers, US1) is excluded from the scope; it has `label-content-name-mismatch` findings that are not US6.
2. **major** — criterion 9 / scenario 9: the DSC PIN field (`type=password`) is not outlined red; `collectControls` skips password inputs so the user gets no "TenderPilot never fills this" cue on the DSC field. Nothing is written (safety holds). Where: `apps/extension/src/dom.ts` collectControls.
3. **major** — criterion 15 / FR-075: skipped reason for no prepared value shows `no_value`. Where: `apps/extension/src/fill.ts` (reason code surfaced) / `report.ts`.
4. **major** — criterion 6: "Build the packet first — the merged PDF will appear here." is shown only when the list is empty; before a build with mapped documents it is absent.
5. **minor** — popup: `#settings { display:flex }` and `main { display:flex }` override the `hidden` attribute, so the "Connect to TenderPilot" form (URL + token field) is always visible even when connected (see `s8-popup-connected-desktop.png`), and `#main` is visible before connecting. Where: `apps/extension/src/popup.css:15`.
6. **observation** — copy deviates from spec text: step 3 "Verify with OTP / DSC / e-Sign" (spec "Authenticate with"), group "Declarations" (spec "Declaration"), invalid-token message "invalid, expired or was revoked".

### Not checked

- The Chrome host-permission prompt (`chrome.permissions.request`) cannot be answered in automation; the popup was run with that call stubbed (real popup code and API), and the origin string is asserted. Cross-origin fetch from the popup used `--disable-web-security` (test harness only).
- A message from a different real extension (foreign `sender.id`) is covered by unit tests only.
- Real GeM pages; only the repository fixture `apps/extension/test/fixtures/gem-form.html`.
- Mobile: only the Submit step, values card, upload order and token dialog (375px, no horizontal overflow); the extension popup has no mobile form factor.
- Method: direct DB inserts for extra tenders/analyses (S8) because no public API exists.

An approval would cover only what is in the table above.

### Verdict

`qa:rejected` — criteria 6 (before-build text), 9 (DSC outline), 15 (reason text) and the axe requirement not met. Rejection 1 of 3 on this item. T086 not ticked.
