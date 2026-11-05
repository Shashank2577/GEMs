## QA verdict — APPROVED

**Work item:** #191 · **PR:** #529 · **Branch/HEAD under test:** story/GEM-191-submission-outcome @ 26acf61 · **Reviewer:** qa (claude-code / Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mEtEp4yfQg82nf4ywc

**Playwright:** `pnpm exec playwright test e2e/006-apply-packet-assist/US7*` → **17 passed, 0 failed** (desktop 13 passed, mobile 375px 4 passed). Web bundle rebuilt first (`pnpm --filter @tp/web build`).
**API/core:** `vitest run test/assist.test.ts` (apps/api) → 13 passed; `@tp/core` suite → 435 passed (award.test.ts 26).
Evidence base: https://github.com/Shashank2577/GEMs/tree/story/GEM-191-submission-outcome/qa/evidence/006/US7 (PNG, one webm per test, `api-*.json` transcripts, `*.axe.json`).

Method: each stateful scenario runs against its own org/tender/workspace. "Ready" workspaces are real (the MAF checklist item is removed from the analysis so the Ready guard passes); the open-blockers scenario keeps the expired-MAF blocker. Axe scope: the Submit step content (header chrome of earlier stories excluded) and `[role=dialog]` for the two dialogs.

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Ready workspace Submit step shows 'Done on GeM?' card with 'Mark as submitted' (Analyst+) | met (Viewer sees no button; Viewer POST 403) | s1-done-on-gem-desktop.png, s1-done-on-gem-mobile.png |
| 2 | Confirm dialog 'Confirm you submitted on GeM' with 3 checkboxes; confirm disabled until all ticked | met (also disabled again when one is un-ticked; optional note present) | s2-confirm-dialog-desktop.png / -mobile.png |
| 3a | Confirm -> POST submitted 200 stage submitted + submittedAt | met | api-s3-submitted.json |
| 3b | toast 'Marked as submitted. Good luck!'; card 'Submitted on GeM' (IST date-time) + Record result; Submit step check | met | s3-submitted-desktop.png |
| 3c | activity with note | met (`workspace.submitted` meta note, from, openBlockers 0; rail "marked the bid as submitted on GeM") | api-s3-submitted.json |
| 4 | POST submitted on won/lost -> 409 'This bid already has an outcome recorded.'; dropped -> 409 'This bid was dropped. Move it back to the pipeline first.' | met (exact messages; `{}` 200, explicit submittedAt honoured, note > 1000 400, malformed id 404) | api-s4-submitted-409s.json |
| 5 | Record result dialog: Won/Lost, L1 price with ₹ preview and 'Enter a number', Our price, Notes <= 1000 | met (hint, live ₹29,50,000 preview, error on both price fields, Save disabled, Notes maxlength 1000) | s5-record-dialog-validation-desktop.png / -mobile.png |
| 6a | Won with L1 29,50,000 -> PATCH 200 stage won; toast 'Congratulations on the win!' | met (request `outcome {result:won,l1Price:2950000,ourPrice:null}`, response has `outcome.at`) | api-s6-won.json, s6-bid-won-desktop.png |
| 6b | card 'Bid won' (Our price '—'), header Won badge, activity 'recorded the result: Won (L1 ₹29,50,000)' | met (badge "Won · L1 ₹29.5 L") | s6-bid-won-desktop.png |
| 6c | Lost: toast 'Result recorded' | met (card 'Bid lost', Lost badge, activity sentence) | s6b-bid-lost-desktop.png |
| 7 | Stage dropdown Won/Lost without outcome stores minimal {result, at} | met (request body exactly `{"stage":"won"}`; outcome keys = `at`,`result`) | api-s7-minimal-outcome.json, s7-stage-only-won-desktop.png |
| 8 | Negative or non-integer price -> 400; > 10^13 rejected | met (-5, 1.5, "abc", 10^13+1, 10^15, ourPrice -1/2.5, notes 2001, bad result all 400 and nothing stored; 10^13 boundary accepted) | api-s8-price-validation.json |
| 9a | (gap FR-085) 'Suggest from GeM result' parses saved RA result HTML and pre-fills L1 price/seller | met (ra-result.html -> L1 2840500 / ₹28,40,500, seller in Notes, info line; nothing uploaded - no non-GET request; nothing saved until Save) | s9-suggested-desktop.png |
| 9b | no table -> 'No price table found in this page.' and nothing pre-filled | met (also clears an earlier pre-fill) | s9-no-table-desktop.png |
| 9c | hostile large-header file does not freeze the page | met (6.5 MB header cell: 118 ms; 200k `<th>`: 104 ms; dialog usable afterwards) | s9b-hostile-timings.json, s9b-hostile-handled-desktop.png |
| 10 | (gap FR-084) confirm dialog lists open blockers; activity records openBlockers | met (dialog "1 checklist item(s) were still open: OEM authorisation certificate (MAF) for this bid", does not block, activity `openBlockers: 1`; card notice too) | s10-open-blockers-desktop.png, api-s10-open-blockers.json |
| FR-083 | GET /assist contains no price/outcome after an outcome with prices | met (none of 2950001, 3100007, note text, outcome/l1Price/ourPrice/l1Seller in payload; same keys as before; noFinancials true) | api-s11-assist-no-outcome.json |
| QA | axe: 0 serious/critical on Submit step cards and the two dialogs (desktop + mobile) | met (0 violations in all six files) | submit-step-ready-*.axe.json, confirm-dialog-*.axe.json, record-dialog-*.axe.json |
| QA | Mobile 375px: no horizontal overflow on Submit step and both dialogs | met | s1/s2/s5 mobile PNG |

### Findings
None blocking. Observations:
1. **observation** - The Submit-step "Done on GeM?" card is shown for any non-submitted stage (e.g. Go), not only Ready (spec scenario 1 wording). Harmless and consistent with the API (which accepts any stage except won/lost/dropped).
2. **observation** - The note is shown only in the activity meta, not in the rail sentence ("marked the bid as submitted on GeM").

### Not checked
- Real GeM result pages; only the synthetic `ra-result.html` fixture and hand-made pages.
- Dark theme; Safari/Firefox.
- Mobile covers S1, S2, S5, S9 (layout-relevant); the other scenarios are API or desktop-only.

An approval covers what is in the table above. It is not a statement that the change is free of defects.

### Bug issues filed
None.

### Verdict
`qa:approved` - every criterion met, evidence above.
