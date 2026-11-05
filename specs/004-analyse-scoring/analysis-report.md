# Cross-artifact analysis: 004 Analyse (T097)

Run: `/cairn-analyze` on `specs/004-analyse-scoring/` on 2026-11-05, after US1-US6 were merged and before US7. Read-only pass; the findings below that were real inconsistencies were fixed in spec/plan/tasks in the same change (no code changed by this task).

The skill's prerequisite script could not resolve a feature directory (no `.cairn/workflow/feature.json` on this branch), so the three artifacts were loaded by path. There are no registered extension hooks (`.cairn/workflow/extensions.yml` has `hooks: {}`). No constitution violations were found.

## Metrics

| Metric | Value |
|---|---|
| Functional requirements | 56 (FR-001 to FR-056) |
| Non-functional requirements | 10 (NFR-001 to NFR-010) |
| Success criteria | 8 |
| Tasks | 101 (T001 to T100 plus T035a) |
| FRs referenced by at least one task | 56 of 56 (100 %) |
| Critical issues | 0 |

## Findings

| ID | Category | Severity | Location | Summary | Resolution |
|---|---|---|---|---|---|
| F1 | Inconsistency | MEDIUM | tasks.md T025, T038 | Both QA tasks were open although `qa/evidence/004/US1` and `US2` have `qa:approved` verdicts and issues #196, #210 are closed | Ticked in tasks.md |
| F2 | Inconsistency | MEDIUM | spec.md US3 criterion 6 vs 16 | Same inputs (demo company, `review-hardware-oem.pdf`) were given as "Go 82/100" (6) and as OEM Needs review (16); 82 only holds when the tender text names no product (US3 QA finding 1) | Criterion 6 now states the tender-text condition and the Go 76 example |
| F3 | Inconsistency | MEDIUM | plan.md API table and constitution table | Rows still marked "gap" for built endpoints (DELETE document, rescore, analysis fields); the 409 codes `analysis_superseded`, `analysis_replaced`, `reanalysis_required` and 422 `scanned_document` were missing; the constitution table still said NOTICE missing, axe pending, E2E open for US1-US6 | Plan updated to the built state; US7 rows still `gap` |
| F4 | Inconsistency | LOW | spec.md FR-022 | The experience hint added by T096 was not described | FR-022 extended (failed factor only) |
| F5 | Terminology | LOW | tasks.md T098 | Names label `area:analyse`; the repository label is `area:analyse-scoring` (CONVENTIONS.md `area:<area>`) | Left in the historic T098 text; T098 verified against the real label |
| F6 | Coverage | LOW | spec.md SC-003 to SC-006, SC-008 | No task cites these ids. They are outcome measures covered by tests (SC-003 factor sentences: US3 E2E; SC-004: rules-only E2E; SC-005: US6 E2E; SC-006: US4 history entries) or by US7 (SC-008: T094) | No change; mapping recorded here |
| F7 | Coverage | LOW | NFR-002 (determinism), NFR-008 (error envelope) | No task cites them; both are covered by core unit tests (pure functions, fixed `now`) and the API suite's envelope assertions | No change |
| F8 | Underspecification | MEDIUM | spec.md SC-001, tasks.md T035 | SC-001 asks for real-layout GeM PDFs; the corpus is synthesised (GeM unreachable). T035 was ticked, T035a opened | Documented in `corpus/README.md`; T035a stays open (needs a human) |
| F9 | Ambiguity | LOW | spec.md FR-040 | The tender-page checklist readiness chips use a clock captured at render (`now`), and the certification wording in FR-040 is loose | Tracked as a follow-up in `qa/evidence/004/SUMMARY.md`, not changed here |

## Coverage

Every FR has at least one task; US7 (T085 to T095, FR-047 to FR-054) is done and QA-approved (PR #560, pending merge); the only open task is T035a (needs-human, #554). T099 and T100 were closed in the US7 roll-up.

## Next actions

US7 is built and QA-approved. After PR #560 merges, update the pinned SHAs in `qa/evidence/004/SUMMARY.md` to the squash SHA. Remaining: T035a (real GeM PDFs, needs-human) and the product sign-off on the AI cost increase (see SUMMARY follow-ups).
