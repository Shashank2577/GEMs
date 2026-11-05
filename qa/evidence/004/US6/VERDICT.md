## QA verdict - APPROVED

**Work item:** #172 - **PR:** #542 - **Reviewer:** qa (claude-code) - **Session:** https://claude.ai/code/session_01BUi6mG5jQ8e8oe3shm7NHq

Test file: `e2e/004-analyse/US6-stale.e2e.ts` (one test per criterion, @mobile variants where layout matters). Corrigendum flow uses a mock-gem tender (`/__admin/corrigendum` then `POST /api/ingestion/run`, the endpoint behind Sync now; the 15-minute manual cooldown is aged in SQL between runs). Company-side changes use SQL-inserted open tenders. The `dev-*.png` files in this folder are the developer's and predate the banner-heading rewording ("Re-analysis needed · since ...").

**Playwright** (`pnpm exec playwright test e2e/000-smoke e2e/004-analyse`): **122 passed, 0 failed** (desktop 82 = smoke 1 + US1 18 + US2 13 + a11y 2 + US3 16 + US4 14 + US5 8 + US6 10; mobile 40 = smoke 1 + US1 5 + US2 8 + US3 8 + US4 6 + US5 6 + US6 6).
**API tests**: 721 passed, 1 failed, 2 skipped (38 files); the failure is `apps/api/test/foundation.test.ts` "logs onboarding.completed once with durationSec" (007 US3, clock timing; same failure as in the US4/US5 reviews). **Core tests**: 480 passed, 0 failed (26 files).
API tests cited: `apps/api/test/staleness.test.ts` ("a corrigendum during a run → the run completes stale with reason and time (same-millisecond change counts)", "a flag older than the row's created_at is cleared by the completion write", "mutations flag open analyses" group), `apps/api/test/ingest.test.ts` ("an analysis that started after the run started but before the corrigendum was written completes stale (FR-045)"), `apps/api/test/analyse.test.ts` ("a corrigendum that changed documentUrl: fetch downloads the new document as kind corrigendum and keeps the old").

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | After corrigendum +7 days and sync: `stale:true`, corrigendum event, banner role=status "Re-analysis needed" with corrigendum copy and Re-analyse now | met | GET analysis `stale:true, staleReason:corrigendum`; tender events hold a `corrigendum` event (endAt old -> +7 days); banner contains "A corrigendum changed this bid after it was analysed. The score below may be outdated." and a **Re-analyse now** button. `01-corrigendum-stale-banner-*.png` |
| 2 | "Outdated" badge, feed "Re-check" + tooltip, History "Corrigendum issued" + "Re-check eligibility" + old -> new end date, History tab dot | met (minor deviation) | Outdated badge; feed card "Re-check" with tooltip "A corrigendum changed this bid after it was scored — re-run the analysis."; History: "Corrigendum issued", "Re-check eligibility", `Closing date: 12 Nov 2026, 3:00 pm IST -> 19 Nov 2026, 3:00 pm IST`; History tab dot `aria-label="corrigendum"`. Deviation: the row label reads "Closing date", not "Bid end date". `02a`, `02b`, `02c` |
| 3 | Re-analyse now: new analysis `stale:false`, banner and badges gone, time-to-close uses new date | met | New analysis id, `stale:false`; banner, Outdated and feed Re-check gone; time-to-close "Closes in 8 days" -> "Closes in 15 days" (+7). `03a`, `03b` |
| 4 | Viewer sees banner without the button | met | Viewer sees banner + corrigendum copy; no Re-analyse now / Re-score button. `04-viewer-banner-no-button-*.png` |
| 5 | Both orgs stale; org A re-analysis leaves org B stale | met | Both orgs' GET analysis `stale:true`; after org A re-analyses A is `stale:false`, B still `stale:true` with banner and Outdated badge. `05a`-`05d` |
| 6 | (gap) Profile / past-contract / vault change marks the org's open-tender analyses stale with reason-specific copy | met | PUT profile and POST past contract -> `profile_changed`, banner "Your company profile changed since this analysis. Re-score to update the score." with **Re-score** (no Re-analyse now); vault upload -> `vault_changed`, "Your document vault changed since this analysis. Re-score to update the score."; other org's analysis stays fresh, no banner. `06a`-`06d` |
| 7 | (gap) API exposes staleReason/staleAt; banner shows "since <time>" | met | API `staleReason: profile_changed`, `staleAt` within the last 2 minutes; heading "Re-analysis needed · since just now"; with `stale_at` aged 2 h in SQL: "since 2 hours ago". `07a`, `07b` |
| 8 | (gap) documentUrl corrigendum: re-analyse fetches the new GeM document as Corrigendum and keeps the old | met | mock-gem cannot change documentUrl, so the tender's `document_url` and a `corrigendum` tender_events row (`documentUrl` change) were written in SQL, as ingestion does. Before: one GeM document (bid). After Re-analyse now: two "From GeM" rows, "Bid document" and "Corrigendum" (`-corrigendum.pdf`); analysis lists both. API test cited above. `08a`, `08b` |
| x1 | Extra: closed tenders not made stale by profile/vault changes | met | Open tender -> stale `profile_changed`/`vault_changed`; closed tender `stale:false, staleReason:null`, no banner. `06e` |
| x2 | Extra: a change during a running analysis completes stale | met (API test cited) | Not reachable deterministically from the UI. Passing API tests: staleness.test.ts "a corrigendum during a run → the run completes stale…", ingest.test.ts FR-045 test. E2E `9` only shows a fresh analysis has no banner (`09`) |

Videos (one per test): this folder, `N-*-desktop.webm` / `-mobile.webm`.

### Findings

1. **minor** - History shows "Closing date: old -> new", the criterion says "Bid end date: ...".
2. **observation** - Sync now was exercised through `POST /api/ingestion/run` (what the button calls), not by clicking the button; the manual-sync cooldown was aged in SQL between runs.
3. **observation** - Criterion 8 uses a SQL-inserted corrigendum event (mock-gem cannot change documentUrl); the real path is covered by the API test.
4. **observation (not US6)** - `foundation.test.ts` "logs onboarding.completed once with durationSec" fails (007 US3).

### Not checked

- Workspace header "Re-analysis needed" and Qualify step "Corrigendum since analysis" (FR-042); weights_changed and document_added/removed banner copy (covered by US4 and API tests); a cairn round-2 follow-up commit, if any, after d8d2345.

### Bug issues filed

- none

### Verdict

`qa:approved` - all criteria met (2 with a minor deviation); T080 ticked.

---
_Generated by [Claude Code](https://claude.ai/code)_
