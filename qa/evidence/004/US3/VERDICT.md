## QA verdict - APPROVED

**Work item:** #169 - **PR:** #517 - **Reviewer:** qa (claude-code) - **Session:** https://claude.ai/code/session_01BUi6mG5jQ8e8oe3shm7NHq

Test file: `e2e/004-analyse/US3-scoring.e2e.ts` (one test per criterion, @mobile variants where layout matters). Tenders are SQL-inserted (no GeM link, PDF's bid number); demo company via `POST /api/demo/seed`.

**Playwright** (`pnpm exec playwright test e2e/000-smoke e2e/004-analyse`): **72 passed, 0 failed** (desktop 50 = smoke 1 + US1 18 + US2 13 + a11y 2 + US3 16; mobile 22 = smoke 1 + US1 5 + US2 8 + US3 8).
**API tests** (`TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test pnpm --filter @tp/api exec vitest run`): 558 passed, 2 skipped, 0 failed (31 files + 2 skipped). **Core tests**: 397 passed, 0 failed (23 files).
API tests backing the e2e: `apps/api/test/analyse.test.ts` ("two concurrent POSTs: one 201, the other 409 analysis_running", "a failed re-analysis keeps the previous result and its overrides", "a Desktop Computers tender whose authorisations do not mention it", "another organization cannot see the analysis"), `packages/core/test/analyse/score.test.ts`.

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | 4-step "Analysing this tender…" for at least 2.4 s, toast "Go · 100/100" / "Rules-only analysis complete", ring "Score 100 of 100, Go" | met | Test 1 asserts the four step labels, card on screen >= 2400 ms, toast text and ring aria-label. Screenshot `01a-analysing-four-steps-desktop.png` |
| 2 | Exact factor sentences (turnover, experience, similar work, EMD, MII, certificates, documents, delivery) and "Not applicable to this bid (1)" holding OEM | met | All 8 rows asserted verbatim (status badge, Hard criterion badge); N/A section collapsed then expanded. Screenshot `02-factor-sentences-desktop.png` |
| 3 | Score card: Rules only badge + tooltip, exact summary, 100%, 8 pass / 1 exempt, Analysed just now | met | Summary equals the spec text verbatim (tender bid number matches the PDF, so no Check documents prefix). Screenshot `03-score-card-desktop.png` |
| 4 | Show evidence: quote, p. 4 chip, file name, Rule · 85% confidence; aria-expanded toggles | met | Toggle false, true, false asserted. Screenshot `04-evidence-open-desktop.png` |
| 5 | Weak profile + nogo-experience.pdf: No-Go 58/100, 86%, blocker callout, blocker row first, Similar work Needs review, EMD pass | met | Real numbers: 58 / 86%; all sentences verbatim. Screenshot `05-nogo-blocker-desktop.png` |
| 6 | Demo + review-hardware-oem.pdf: Go 82/100, Certificates fail BIS, Documents 7 of 8, EMD exempt ₹2.16 L, summary ends Fix: certificates and documents in vault. | met (deviation, finding 1) | 82 reproduces only when the tender title/category carry no product word; on a product-named tender the same inputs give Go 76. Screenshot `06-go-82-desktop.png` |
| 7 | Expired Udyam: turnover fail with renewal hint, no EMD exemption; after valid Udyam, Exempt (MSE) | met | Before: fail + hint, EMD not exempt; after upload: turnover and EMD Exempt (MSE) (07b-valid-udyam). Screenshot `07a-expired-udyam-desktop.png` |
| 8 | No profile: Review 46/100, 44%, five Needs review factors, summary ends Needs review: … | met | Real numbers: 46 / 44%; five sentences verbatim. Screenshot `08-no-profile-review-46-desktop.png` |
| 9 | Closed tender: timeToClose failed blocker, No-Go; hero Analyse disabled if never analysed | met | Blocker row first + callout; never-analysed closed tender: button disabled (09b-closed-never-analysed-disabled). Screenshot `09a-closed-nogo-desktop.png` |
| 10 | 20 hours: Fail (not blocker); 2 days: Needs review | met | SQL end_at relative to now(); 10b-closes-in-2-days for the 2-day case. Screenshot `10a-closes-in-20-hours-desktop.png` |
| 11 | 5 days: Fail; outside operating states: Needs review | met | Generated PDF with Delivery Days 5; Kerala tender for 11b-outside-operating-states. Screenshot `11a-five-days-fail-desktop.png` |
| 12 | Viewer: result without Re-analyse/Override; empty-state sentence; POST analyse 403 | met | 12b-viewer-empty-state; 403 and GET 200 asserted. Screenshot `12a-viewer-sees-result-desktop.png` |
| 13 | Other org GET analysis: 404 | met | 404 with error.code not_found; other org's page shows the empty state, no score. Screenshot `13-other-org-no-analysis-desktop.png` |
| 14 | Concurrent analyse: 409 analysis_running | met | Four simultaneous POSTs: at least one 201 and one 409 with the exact message; double click sends 1 POST and one Analysing card (14a); running row: 409 + Analysis in progress banner. Race-based part retries up to 5 tenders; deterministic proof: API test. Screenshot `14b-analysis-in-progress-desktop.png` |
| 15 | Failed re-analysis keeps previous result + overrides, warning and Try again | met | Real failure via malformed profile (500); previous score and Overridden badge kept; Try again recovers (15b-try-again-recovers). Screenshot caught the ring mid count-up; aria-label asserted. Screenshot `15a-failed-reanalysis-warning-desktop.png` |
| 16 | OEM Needs review when no valid authorisation mentions Desktop Computers | met | Sentence verbatim; verdict not No-Go. Screenshot `16-oem-needs-review-desktop.png` |

Videos (one per test): https://github.com/Shashank2577/GEMs/blob/5bb75d1c20f9f991323eb728bf1785545a3b4f76/qa/evidence/004/US3/ (files `N-*-desktop.webm` / `-mobile.webm`).

### Findings

1. **minor (non-blocking)** - Criteria 6 and 16 give the same inputs (demo company + review-hardware-oem.pdf) but cannot both hold with "Go 82".
   - Observed: tender text "QA tender / IT Services" gives Go 82 (OEM factor stays a generic Pass because no significant product word exists). Any tender naming a product gives OEM Needs review: Desktop Computers tender gives Go 76; the mock-gem target tender "Fogging Machine (Q3)" gave Go 74 (OEM none of your valid OEM authorisations mention Fogging Machine). All sentences in criterion 6 stay exact.
   - Expected: criterion 6 says Go 82/100. The spec number predates FR-030 (criterion 16); suggest updating criterion 6 to state the tender text or the number.
   - Where: `packages/core/src/analyse/score.ts` OEM block.
2. **observation** - 14 uses real concurrent POSTs, inherently racy; the e2e retries on fresh tenders (up to 5). The deterministic proof is the API test.
3. **observation** - Screenshot 15a was captured while the score ring was still counting up (shows 85, final 91); the accessible name is asserted.
4. **observation** - A tender whose bid number differs from the PDF yields the "Check documents:" summary prefix (US2 behaviour); e2e tenders use the PDF's bid number to avoid it.

### Not checked

- Real GeM documents and LLM-assisted scoring (rules-only, no key).
- Criteria 9-11 and 7 clock/expiry cases use SQL-set dates and a generated PDF (5-day delivery); the real GeM feed was not used.
- Override and weights UI (US4).

### Bug issues filed

- none

### Verdict

`qa:approved` - every criterion met; criterion 6 with the deviation in finding 1.

---
_Generated by [Claude Code](https://claude.ai/code)_
