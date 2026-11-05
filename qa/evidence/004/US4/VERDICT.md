## QA verdict - APPROVED

**Work item:** #170 - **PR:** #528 - **Reviewer:** qa (claude-code) - **Session:** https://claude.ai/code/session_01BUi6mG5jQ8e8oe3shm7NHq

Test file: `e2e/004-analyse/US4-override-weights.e2e.ts` (one test per criterion, @mobile variants where layout matters). Tenders are SQL-inserted (no GeM link, the PDF's bid number); the weak profile + `nogo-experience.pdf` analysis is the US3 #5 No-Go case; the demo company comes from `POST /api/demo/seed`.

**Playwright** (`pnpm exec playwright test e2e/000-smoke e2e/004-analyse`): **92 passed, 0 failed** (desktop 64 = smoke 1 + US1 18 + US2 13 + a11y 2 + US3 16 + US4 14; mobile 28 = smoke 1 + US1 5 + US2 8 + US3 8 + US4 6). Test 6 gained a final step (override dropped once the computed status equals it) after that run and was re-run alone: 1 passed.
**API tests**: 608 passed, 1 failed, 2 skipped (33 files). The one failure is `apps/api/test/foundation.test.ts` "PATCH /org onboarding state (007 US3) > logs onboarding.completed once with durationSec" (expected 94 >= 95); it is a 007 test unrelated to this story and fails in isolation too (finding 3). **Core tests**: 428 passed, 0 failed (23 files).
API tests backing the e2e: `apps/api/test/analyse.test.ts` ("override (FR-016) > requires bid manager and a reason", "re-scores, records who/why, is audited and survives re-analysis", "scoring weights", "re-score (FR-037, FR-043) > a weights change marks the analysis stale; re-score applies them, keeps overrides, clears stale, audits", "re-score only fixes company-side staleness > A: stale for document_added ... re-score answers 409 reanalysis_required", "B: weights_changed, then a corrigendum ...", "a weights save leaves analyses of closed tenders untouched"), `packages/core/test/analyse/score.test.ts` ("an override replaces the effective status ... can lift a blocker").

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Dialog "Override “Years of experience”" shows computed status, segmented Pass/Exempt/Unknown/Fail/N/A preselected, required Reason (max 500) with audit hint | met | Test 1: title, "Computed: Fail" + detail sentence, five radios with Pass checked, textarea maxlength 500, hint "Visible to your team in the activity log." `01-override-dialog-desktop.png` / `-mobile.png` |
| 2 | Reason under 3 chars: "Give a short reason — it is kept in the audit log."; API 400 validation_error | met | Empty and "ab": error shown, zero POSTs sent. API: "", "ab", "  a  " each 400 validation_error "Give a short reason (at least 3 characters)"; 501 chars 400. `02-reason-too-short-desktop.png` |
| 3 | Experience to Pass on No-Go 58: 200, toast "Years of experience set to pass" / "New score 82/100 · Go", blocker gone, Overridden badge + who/when/why, "1 overridden" | met | Real numbers: No-Go 58 before, Go 82 after (matches the spec). 200 from the real POST, toast, ring "Score 82 of 100, Go", tooltip "Originally fail — overridden by <name>", line "<name> set this to pass just now: “JV partner Acme Systems brings 6 years of CCTV AMC experience”". `03-override-applied-go-82-desktop.png` |
| 4 | History: "Years of experience: fail → pass — “reason”" (analysis.factor_overridden) | met | Entry "<name> overrode a factor" with the exact line. `04-history-factor-overridden-desktop.png` |
| 5 | Choosing computed status: "Same as computed — this removes the override." and removes it | met | Note absent for Pass, appears for Fail; save returns to No-Go 58, badge, "1 overridden" gone, blocker back, API factor has no override. `05a-same-as-computed-note-desktop.png`, `05b-override-removed-no-go-58-desktop.png` |
| 6 | Override re-applied after re-analysis when computed status differs | met | New analysis row: experience still fail, override pass kept, Go 82. After raising incorporation to 10 years the computed status is pass and the override is dropped (06b). `06-override-survives-reanalysis-desktop.png`, `06b-override-dropped-when-computed-equals-desktop.png` |
| 7 | Analyst: no Override buttons, API 403; non-done 409; unknown factor 400 | met | Analyst page shows the score, zero Override buttons, 403 forbidden. Unknown factor and bad status 400 validation_error. A real failed re-analysis leaves a failed row: 409 conflict "Only a completed analysis can be overridden". `07a-analyst-no-override-buttons-desktop.png` |
| 8 | Weights page: defaults 20/18/12/10/6/10/8/8/4/4, "Total weight 100", share %, "Default weights" | met | Ten sliders with exact values, "N · N% of score", total 100, badge, Save disabled. `08-weights-defaults-desktop.png` / `-mobile.png` |
| 9 | Save EMD 30: 200 {custom:true}, toast, "Custom weights", "Default 10."; next analysis EMD "Weight 30" | met | PUT body contains emd 30, response custom true; toast text exact; total 120, "30 · 25% of score"; next analysis factor weight 30 and "Weight 30" on the row. `09b-saved-custom-weights-desktop.png`, `09c-next-analysis-emd-weight-30-desktop.png` |
| 10 | Reset to default + Save sends {} and returns {custom:false} | met | Request body equals `{}`, response custom false, weights equal defaults, badge "Default weights". `10b-saved-defaults-desktop.png` |
| 11 | All zero: total red, Save disabled; API 400 all-zero / unknown key / 101 | met | Total "0" with the `text-danger` class (renders orange-red), Save disabled. API: all-zero 400 "At least one weight must be above 0", unknown key 400, 101 and -1 400, nothing saved. `11-all-zero-save-disabled-desktop.png` / `-mobile.png` |
| 12 | Analyst/viewer: sliders disabled, footer text; PUT 403 | met | All ten sliders disabled, footer exact, no Save/Reset, PUT 403 forbidden, GET 200, weights unchanged. `12-analyst-weights-read-only-desktop.png`, `12-viewer-weights-read-only-desktop.png` |
| 13 | (gap) Weights change: stale banner + Re-score (200); document staleness: rescore 409; closed tenders untouched | met | Banner "Scoring weights changed since this analysis. Re-score to update the score."; UI Re-score posts `/api/analyses/:id/rescore` 200, toast "Re-scored · N/100", EMD weight 30. Document-added tender: rescore 409 reanalysis_required and the banner offers "Re-analyse now". Closed tender not stale after the weights save. GeM-corrigendum staleness: API test "B: weights_changed, then a corrigendum". `13a-stale-weights-banner-desktop.png`, `13b-rescored-desktop.png`, `13c-document-stale-needs-reanalysis-desktop.png` |
| 14 | (gap) Slider range 0-100 matches the API | met | min 0, max 100; API-set 80, 100 and 0 shown without clamping; keyboard ArrowRight 80 to 81; fill 100 and 0. `14-slider-80-100-0-unclamped-desktop.png` |

Videos (one per test): this folder, files `N-*-desktop.webm` / `-mobile.webm`.

### Findings

1. **observation** - The "Total weight 0" colour is the `text-danger` token and renders orange-red rather than pure red; asserted by class, visible in `11-all-zero-save-disabled-desktop.png`.
2. **observation** - Criterion 13's corrigendum case is proven at API level only (`analyse.test.ts` "B"); the e2e uses an uploaded corrigendum document (reason `document_added`).
3. **observation (not US4)** - `apps/api/test/foundation.test.ts` "logs onboarding.completed once with durationSec" fails (expected 94 >= 95) in the full run and in isolation; it belongs to 007 US3 and depends on clock timing, not on this story.
4. **observation** - Full-page screenshots show the sticky app header and sidebar mid-page (same as the US3 evidence); content is unaffected.

### Not checked

- LLM-assisted scoring (rules-only, no key); real GeM documents.
- Concurrency of override vs running re-analysis (covered by API test "B2: an override saved while a re-analysis is running is carried into the new result", not re-run in the browser).

### Bug issues filed

- none

### Verdict

`qa:approved` - all 14 criteria met; T064 ticked.

---
_Generated by [Claude Code](https://claude.ai/code)_
