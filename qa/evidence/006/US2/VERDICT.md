## QA verdict — APPROVED

**Work item:** #179 · **PR:** #483 · **Reviewer:** qa (claude-code) · **Session:** https://claude.ai/code/session_01BUi6mHape454W5kq4qhhfS

Spec: `e2e/006-apply-packet-assist/US2-mapping-readiness.e2e.ts` (T030 / #214). **Re-review after rejection 1** (previous verdict rejected criterion 5). Criterion 5 changed because the lead amended spec scenario 2 and issue #179 (commit `350a0c4`): the Udyam upload button label comes from the document-type catalog, so it is now 'Upload Udyam (MSE) certificate'; the product was not changed. Result at branch head `350a0c4`: US2 **21 passed, 0 failed** (desktop + mobile); US1 + US2 combined **36 passed, 0 failed** (US1 15/15).

### Acceptance criteria

| # | Criterion (quoted from the work item) | Verdict | Evidence |
|---|---|---|---|
| 1 | Ring shows **83%** (amber), heading '1 blocker before “Ready to submit”', sub-line '5 of 6 required items covered · 7 items in the checklist', **Upload to vault** and **Annexures →** visible | met | S1 test; ring stroke = `hsl(var(--warning))`; [s1-ring-and-blocker-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s1-ring-and-blocker-desktop.png) |
| 2 | One red blocker chip 'Expired · OEM authorisation certificate (MAF) for this bid' linking to `#item-oem_authorization` | met | S1 test (href + `text-danger` + click scrolls); [s1-ring-and-blocker-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s1-ring-and-blocker-desktop.png) |
| 3 | GST / PAN Ready, Required, Auto-matched; balance sheets pick 'Balance sheet 2024-25' with FY 2024-25 (not 2023-24) | met | S2 test, plus API `readiness.items`; [s2-rows-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s2-rows-desktop.png) |
| 4 | OEM Expired, Required, 'Dell MAF', red-tinted card, buttons Change + Upload renewed | met | S2 test; [s2-rows-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s2-rows-desktop.png) |
| 5 | Udyam Missing, Optional, 'No matching document in the vault.', buttons Choose document + **'Upload Udyam (MSE) certificate'** (criterion as amended in 350a0c4) | met | Test `US2-mapping-readiness.e2e.ts:150` passes: label 'Upload Udyam (MSE) certificate', href `/vault?upload=1&uploadType=udyam`, vault dialog opens (S2 test; screenshot s2-rows-desktop.png) |
| 6 | Two Generated rows (Non-blacklisting, Make in India) with 'Generated from your profile · Print, sign and stamp before upload' and Preview | met | S2 test; [s2-rows-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s2-rows-desktop.png) |
| 7 | Filter tabs 'All 7', 'Needs attention 2', 'Covered 5'; selecting Needs attention shows only OEM + Udyam, `aria-selected=true` | met | S3 test; [s3-needs-attention-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s3-needs-attention-desktop.png) |
| 8 | Empty filter shows 'Nothing here — Everything in this view is covered.' | met | S3 empty-filter test (fixture checklist gst, pan, non_blacklisting, 'Needs attention 0'); [s3-empty-filter-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s3-empty-filter-desktop.png) |
| 9 | Change popover: focused search 'Search the vault…', group 'OEM authorisation' with checked 'Dell MAF', group 'Other documents', footer Auto-match / Not available / Upload new | met | S4 test; [s4-popover-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s4-popover-desktop.png) |
| 10 | 'Other documents' max 30 rows | met | S4 cap test: 40 candidates -> exactly 30 rows; [s4-popover-capped-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s4-popover-capped-desktop.png) |
| 11 | Pick 'Balance sheet 2023-24' for OEM: PUT mapping 200 `{workspace, readiness}`, toast 'Using “Balance sheet 2023-24”', Auto-matched badge gone | met | S5 test (request body, response keys, toast, badge); [s5-picked-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s5-picked-desktop.png) |
| 12 | Activity has `workspace.mapping_changed` rendered 'changed the document for 1 checklist item(s)' | met | S5 test (API activity meta + text in the Discussion rail); [s5-activity-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s5-activity-desktop.png) |
| 13 | Not available -> mapping stores `null`, toast 'Marked as not available', row Missing with 'Marked as not available.' | met | S6 test; [s6-not-available-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s6-not-available-desktop.png) |
| 14 | Auto-match -> key removed from stored mapping, toast 'TenderPilot will pick the best document', row back to Dell MAF + Auto-matched | met | S6 test (PUT body `{oem_authorization:'auto'}`, `mapping` lacks key); [s6-auto-match-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s6-auto-match-desktop.png) |
| 15 | Uploading a udyam doc later: untouched Udyam row Ready + Auto-matched, no mapping call | met | S7 test: zero non-GET `/mapping` requests, stored mapping has no `udyam` key, 'Covered 6'; [s7-udyam-auto-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s7-udyam-auto-desktop.png) |
| 16 | Explicit 'Not available' stays Missing after a udyam upload | met | S7 explicit test; [s7-explicit-not-available-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s7-explicit-not-available-desktop.png) |
| 17 | PUT mapping with unknown item -> 400 validation_error `fields.<itemId>` 'Not an item of this bid’s checklist' | met | S8 API test (video [s8-api-validation-unknown-item-400-foreign-doc-400-deleted-d-desktop.webm](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s8-api-validation-unknown-item-400-foreign-doc-400-deleted-d-desktop.webm)) |
| 18 | Foreign-org doc id or deleted doc id -> 400 'Document not found in your vault' (nothing stored) | met | S8 API test |
| 19 | Viewer PUT mapping -> 403 (and no edit controls in UI) | met | S8 API + Viewer UI tests; [s8-viewer-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s8-viewer-desktop.png) |
| 20 | Mapped doc deleted -> explicit item Missing; auto items fall back | met | S9 test: OEM Missing (dangling id stays stored, resolves to none); balance_sheets falls back to 'Balance sheet 2023-24' Auto-matched; [s9-deleted-doc-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s9-deleted-doc-desktop.png) |
| 21 | Doc expiring in 12 days: 'Expiring soon', note 'Expires in 12 day(s).', Upload renewed, covered (not a blocker), in `readiness.warnings` | met | S10 test (ring 100%, `canMarkReady` true, blockers empty); [s10-expiring-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s10-expiring-desktop.png) |
| 22 | No analysis: empty state 'No checklist yet' with 'Analyse tender →' to `/tenders/{id}` | met | S11 test (href + navigation); [s11-no-analysis-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s11-no-analysis-desktop.png) |
| 23 | 'other' items map only with relevance >= 0.5 or exact item-id tag | met | S12 test: full-title match and `cert_fire` tag map; 1-word match does not (item stays Missing); [s12-other-items-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s12-other-items-desktop.png) |
| 24 | 375 px: rows stack (doc box under label), popover <= 92vw, no horizontal page scroll, ring and buttons wrap without overlap | met | S13 test, viewport forced to 375x812 in the `mobile` project; popover width <= 345 px; [s13-mobile-rows-mobile.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s13-mobile-rows-mobile.png) · [s13-mobile-popover-mobile.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s13-mobile-popover-mobile.png) · [s13-mobile-top-mobile.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s13-mobile-top-mobile.png) |
| 25 | New a11y: ring accessible name 'Readiness 83 percent' | met | S1 test `getByRole('img', {name:'Readiness 83 percent'})` (desktop + mobile) |
| 26 | New a11y: filter tablist with arrow keys (Left/Right wrap, Home/End), roving tabindex, `aria-controls`/`aria-labelledby` tabpanel | met | S3 test; [s3-covered-keyboard-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-179-mapping-readiness/qa/evidence/006/US2/s3-covered-keyboard-desktop.png) |

### Findings

1. **observation** — previous rejection (criterion 5, Udyam button label) is resolved by the spec/issue amendment, not by a product change: the catalog label for `udyam` is 'Udyam (MSE) certificate' (`packages/core/src/vault/status.ts:106`) and the row button uses it (`DocumentsStep.tsx:109`). The assertion at `US2-mapping-readiness.e2e.ts:150` was updated accordingly; the obsolete FAILING screenshot/trace were removed.

2. **observation** — the "Upload renewed" / "Upload Udyam ..." links and the popover "Upload new" link only navigate to `/vault?upload=1&uploadType=...`; verified the href and that the vault upload dialog opens (S2), but the dialog's pre-selected type was not asserted.

3. **observation** — a Viewer-opened Documents step hides Change/Choose document/Upload controls (verified); the Viewer PUT is refused 403 with 'You need to be at least an Analyst to do that'.

### Extra job: US1 spec amended for FR-002 (empty stored mapping)

`e2e/006-apply-packet-assist/US1-workspace-stages.e2e.ts` S1 now asserts `POST /workspace` returns `mapping: {}` and, via `GET /api/workspaces/:id`, `readiness.items` picks gst, pan, balance_sheets -> `bsNew`, oem_authorization -> `oem` all with `auto: true`, udyam `docId: null` (POST returns only the workspace DTO, so `readiness` comes from the GET). US1 re-run: **15 passed, 0 failed** (13 desktop + 2 mobile).

### Not checked

- axe accessibility scan: `@axe-core/playwright` is not installed and QA may not add dependencies -> **not checked**. Manual a11y checks (ring name, tablist/tabpanel wiring, arrow keys, Home/End) are covered above.
- Pixel 7 emulation is 412 px wide; the 375 px test forces `setViewportSize(375x812)` in that project.
- The vault upload dialog contents after the `uploadType` redirect, real GeM behaviour, and load/performance were out of scope.

An approval would cover only what is in the table above; it is not a statement that the change is free of defects.

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion met, evidence above (re-review after rejection 1).

---
_Generated by [Claude Code](https://claude.ai/code)_
