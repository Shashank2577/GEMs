# 007 Experience & Growth — QA roll-up

Spec: [`specs/007-experience-growth/spec.md`](../../../specs/007-experience-growth/spec.md) · plan: [`plan.md`](../../../specs/007-experience-growth/plan.md) · tasks: [`tasks.md`](../../../specs/007-experience-growth/tasks.md) · epic #291.
E2E specs: `e2e/007-experience-growth/US<n>-*.e2e.ts`; helpers are described in [`e2e/README.md`](../../../e2e/README.md).
Playwright traces are not committed (they stay in `qa/.runs/`, git-ignored); each story folder holds named screenshots (`*.png`), one video per test (`*.webm`), JSON captures of API responses and the `VERDICT.md`.

## Stories

All seven stories were QA-approved and merged. A VERDICT.md can show an earlier round as rejected; the verdict at the top of each file is the final one.

| Story | Issue / PR | Verdict | Screenshots | Videos | Test results at approval |
|---|---|---|---|---|---|
| US1 Owner dashboard | #292 / #480 | [VERDICT.md](qa/evidence/007/US1/VERDICT.md) | [qa/evidence/007/US1/](qa/evidence/007/US1/) (`*.png`) | `*.webm` in the same folder | 20 passed (desktop + mobile), run twice; dashboard.test.ts 13 passed |
| US2 Pipeline board | #293 / #491 | [VERDICT.md](qa/evidence/007/US2/VERDICT.md) | [qa/evidence/007/US2/](qa/evidence/007/US2/) (`*.png`) | `*.webm` in the same folder | 25 passed; workspace.test.ts 44 passed |
| US3 Guided onboarding | #294 / #510 | [VERDICT.md](qa/evidence/007/US3/VERDICT.md) | [qa/evidence/007/US3/](qa/evidence/007/US3/) (`*.png`) | `*.webm` in the same folder | 26 passed (desktop 21, mobile 5); core 379, api 443, web 177 passed |
| US4 Demo data | #295 / #519 | [VERDICT.md](qa/evidence/007/US4/VERDICT.md) | [qa/evidence/007/US4/](qa/evidence/007/US4/) (`*.png`) | `*.webm` in the same folder | 20 passed (desktop 17, mobile 3); api 555 passed |
| US5 Persona-aware widgets | #296 / #525 | [VERDICT.md](qa/evidence/007/US5/VERDICT.md) | [qa/evidence/007/US5/](qa/evidence/007/US5/) (`*.png`) | `*.webm` in the same folder | 17 passed (desktop 13, mobile 4); api 562, web 209 passed |
| US6 Landing page and pricing | #297 / #530 | [VERDICT.md](qa/evidence/007/US6/VERDICT.md) | [qa/evidence/007/US6/](qa/evidence/007/US6/) (`*.png`) | `*.webm` in the same folder | 18 passed (desktop 16, mobile 2); core 428, api 606, web 249 passed |
| US7 Accessibility, responsiveness, offline | #298 / #539 | [VERDICT.md](qa/evidence/007/US7/VERDICT.md) | [qa/evidence/007/US7/](qa/evidence/007/US7/) (`*.png`) | `*.webm` in the same folder | desktop 59 passed, mobile 25 passed; api 646, web 279 passed |

Full-page `fr-*` / `us*-*` screenshots and `dev-*` developer screenshots sit side by side in each folder. Accessibility JSON: `US1/dashboard-demo-desktop.axe.json`, `US2/pipeline-*.axe.json`, `US3/onboarding-step1-desktop.axe.json`, `US7/axe/` (86 files). Lighthouse: [`US6/lighthouse/`](US6/lighthouse/) (`summary.json`, `report.html`).

## Success criteria (SC-001 … SC-008)

| SC | Criterion (spec.md) | Result | Measured value and where |
|---|---|---|---|
| SC-001 | Populated matched feed within 5 min of sign-up; scripted E2E < 90 s; production median `durationSec` ≤ 300 | **Met for the scripted E2E; production median not measured** | Sign-up to matched feed took **56.6 s** in the US3 independent test as recorded in the VERDICT (the committed re-run capture [`US3/US3-IT-timing.json`](US3/US3-IT-timing.json) shows 53.87 s, 10 matched rows); both are scripted and well under 90 s. `onboarding.completed.durationSec` is written exactly once (US3-15) but there is no production data yet, so the "median ≤ 300" half cannot be measured before launch |
| SC-002 | 100% of six KPI tiles and nine pipeline counts equal SQL ground truth | **Met** | Independent psql queries on `tenderpilot_e2e` match the API and UI: [`US1/SC-002-ground-truth.json`](US1/SC-002-ground-truth.json) |
| SC-003 | 0 serious/critical axe violations on 11 core pages × 2 viewports × 2 themes | **Met** | 66 page audits (11 pages × {375, 1440} × {light, dark}) have 0 violations of any impact; dev sweep 44/44, QA 375 px touch sweep 22/22: [`US7/axe/`](US7/axe/). Observation, not a failure of the criterion: axe `aria-hidden-focus` behind open Radix modal menus (theme and "Move to…" menus), tracked in #547 item 6 |
| SC-004 | 0 pages with horizontal page scroll at 375 px | **Met** | `noHorizontalOverflow()` over the 11 pages; the pipeline kanban scrolls inside its own container: [`US7/us7-9-pipeline-inner-scroll.json`](US7/us7-9-pipeline-inner-scroll.json) |
| SC-005 | 7/7 user-story E2E specs pass in CI against real Postgres with evidence | **Met locally; CI run not independently verified here** | Each of the 7 specs passed 0 failed against local Postgres (`tenderpilot_e2e`) with evidence in this folder (counts in the table above). This roll-up did not re-run them in CI |
| SC-006 | Landing Lighthouse mobile meets NFR-003 on three consecutive runs | **Met** | Median of 3 runs: Performance **93**, Accessibility **100**, Best Practices **96**, SEO **100**, LCP **905 ms**, CLS **0** (Lighthouse 13.6.0, mobile). Thresholds enforced by `scripts/lighthouse-landing.mjs`: [`US6/lighthouse/summary.json`](US6/lighthouse/summary.json), [`report.html`](US6/lighthouse/report.html). TBT 260–370 ms is a follow-up (#534 item 5) |
| SC-007 | After "Remove demo data", 0 demo-provenance rows remain and 100% of user-created rows are preserved | **Met** (API test and E2E) | `DELETE /api/demo` leaves 0 demo workspaces/analyses/matches/comments/notifications/past contracts/vault documents; a user watchlist with a demo name, "My laptops", "Real GST.pdf" and a user workspace on a real tender are kept; second call returns all zeros: [`US4/US4-10-removal.json`](US4/US4-10-removal.json). Blob deletion is proven by the API test (spy blob store), not re-proven in E2E. Caveat: the "Sample" badge (FR-067) is not yet on every dashboard list (#523) |
| SC-008 | Greeting, summary line and ≥ 4 KPI tiles visible at 375×812 without scrolling | **Met** | All 6 KPI tiles fully inside the first viewport on Pixel 7 and a 375×812 desktop viewport, no horizontal overflow: [`US1/SC-008-first-viewport-375x812-mobile.png`](US1/SC-008-first-viewport-375x812-mobile.png), [`US1/SC-008-first-viewport-mobile.json`](US1/SC-008-first-viewport-mobile.json) |

Other budgets (NFR-001 dashboard < 2 s p95 and `GET /dashboard` < 500 ms p95 on 10,000 tenders, NFR-002 200 pipeline cards < 1 s) were not benchmarked in this roll-up; the `bid_workspaces_org_stage_idx` index supports NFR-001 and no load measurement is recorded here.

## Follow-up issues (non-blocking, deferred from reviews and QA)

| Issue | Story | What |
|---|---|---|
| [#497](https://github.com/Shashank2577/GEMs/issues/497) | US2 | GeM result-hint: failure back-off (Constitution II), prune `gem_result_hints`, document the concurrent first-lookup 429 |
| [#516](https://github.com/Shashank2577/GEMs/issues/516) | US3 | Onboarding: a reload after a failed `watchlist` tick can create a second watchlist (NB-5); "Skip for now" shown while vault queries load, Replace may add a second document (NB-6) |
| [#523](https://github.com/Shashank2577/GEMs/issues/523) | US4 | FR-067 "Sample" badge missing on dashboard closing-soon/recent-matches and pipeline cards; `removeDemo` also deletes user-written activity about demo rows (beyond FR-065 text); demo-tender lookup scans `tenders` without an index |
| [#527](https://github.com/Shashank2577/GEMs/issues/527) | US5 | DecisionsCard shares one move mutation across rows; Go test only checks the body; ordering test does not pin the sort key; unused `CHOICES.go.title`; "read-only for analysts" is UI-only; plan said nested `analysis`, code is flat (fixed in plan.md by T080); `roleGate()` duplicates `ROLE_RANK` |
| [#534](https://github.com/Shashank2577/GEMs/issues/534) | US6 | Static hero shell copy guard and focus loss; no `errorElement` on a failed landing chunk; TBT 260–370 ms; **canonical host `tenderpilot.in` is an assumption**; `PLANS.limits` vs ADR-0010; CSP leftovers; signed-out console 401 |
| [#547](https://github.com/Shashank2577/GEMs/issues/547) | US7 | Double toasts offline at ~50 call sites; untyped TanStack `meta`; hover-revealed controls skipped by the target-size check; "Go Go" link name on TenderCard; unify the 375 px sweeps; axe `aria-hidden-focus` behind Radix modal menus; items not verified (Android install prompt, screen-reader speech, reduced motion, WebKit/Firefox) |

## What was not measured

- Production `onboarding.completed.durationSec` median (SC-001 second half), and any CI run of the 7 E2E specs (SC-005).
- NFR-001/NFR-002 timings on the large reference data set; real-device iOS Safari and Android install (spec assumption: manual QA).
- Screen-reader speech output and `prefers-reduced-motion` on browsers other than Chromium (US7 "Not checked").

## Consistency analysis (T080)

The cairn-analyze findings for spec/plan/tasks against the delivered code are in the PR description of `story/GEM-291-hardening`; the resulting *As delivered* notes are in `spec.md` and `plan.md`.
