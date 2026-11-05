## QA verdict — APPROVED

**Work item:** #67 · **PR:** #564 · **Reviewer:** qa (claude-code / Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mGtwn84Qge91FivDUC

Branch `story/GEM-67-results`, evidence commit `204966a9d07191c76f4cdfe3c7709c8759fb86b8`. Task T076 (#108).

Run: private DB `tp_e2e_us6` (+ `tp_t_us6` for API tests), `E2E_PORT=9041 E2E_GEM_PORT=4141`, real API + built SPA + mock-gem.
Spec: `e2e/003-identify-ingestion-alerts/US6-results.e2e.ts`.

### Test results

| Suite | Result |
|---|---|
| Playwright desktop (`--project=desktop`) | **13 passed, 0 failed** (2 `@mobile` tests skipped on desktop by design) |
| Playwright mobile (`--project=mobile`, Pixel 7 + 375 px) | **2 passed, 0 failed** |
| API vitest (`@tp/api`, whole suite) | **940 passed, 0 failed, 2 skipped** (49 files); incl. `results.test.ts` 26/26, `mock-gem-results.test.ts` 5/5 |
| Core vitest `test/gem` | 136 passed (incl. `client.test.ts` 24, `result.test.ts` 10) |
| Web vitest (result + competitors helpers) | 12 passed |

### Acceptance criteria

Evidence base: https://github.com/Shashank2577/GEMs/blob/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/ (screenshots `<name>-desktop.png`, videos `*.webm`).

| # | Criterion (quoted from spec US6) | Verdict | Evidence |
|---|---|---|---|
| 1a | Given a tracked tender that closed within the last 30 days, when the scheduled results refresh runs, the tender is looked up via the public submitted-bids search | **met** | S1: refresh over 5 closed tracked tenders issued 5 submitted-bids searches (one per checked tender, no paging) and 3 result-view fetches (awarded only, none for tech-evaluated / unlisted) |
| 1b | its status becomes `awarded` when GeM reports `b_buyer_status = 3` | **met** | S1: 3 awarded bids -> `tenders.status='awarded'`; run `results/success`, seen 5, stored 4, awarded 3; tech-evaluated tender stays `open` |
| 1c | status changes are recorded as `tender_events` | **met** | S1: one `awarded` event per awarded tender, one `technical_evaluated` event for the tech-evaluated one; S4 re-publish adds no second `awarded` event |
| 1d | the client still makes ≤ 1 request/second | **met (unit level)** | E2E runs with `GEM_MIN_INTERVAL_MS=0`, so spacing is not observable end-to-end; `core/test/gem/client.test.ts` "throttles to ≤ 1 request per minIntervalMs" passes; request counts per tender asserted in S1. See Not checked |
| 2a | Given an awarded tender with a public result page, `GET /api/tenders/:id/result` returns `200` with `{evaluationStatus:"awarded", bidders:[{rank, seller, price, level:"L1"}, …], fetchedAt}` | **met** | S2: 200, `awarded`, 4 bidders ranks 1-4 L1-L4, prices 2840500/2950000/3125000/3310000, `fetchedAt` set; 401 signed out. [S2 desktop](https://raw.githubusercontent.com/Shashank2577/GEMs/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/S2-result-tab-awarded-desktop.png) |
| 2b | the tender page shows a **Result** tab with the bidder table (L1 row highlighted) | **met** | S2: Result tab, "Awarded" badge, exactly one `tr[data-l1]`, background differs from L2 row, "Awarded" outcome on L1 |
| 2c | prices in ₹ with Indian grouping | **met** | S2: ₹28,40,500 / ₹29,50,000 / ₹31,25,000 / ₹33,10,000 |
| 2d | and the source link to GeM | **met** | S2: "View the result on GeM" link, `href` `…/getBidResultView/…`, `target=_blank` |
| 3a | Given no result is published yet, the endpoint returns `200` with `evaluationStatus` (e.g. "Technical evaluated") and `bidders:[]` | **met** | S3: tech-evaluated bid -> 200 `technical_evaluated` / "Technical evaluated", `bidders: []`; never-checked tender -> 200 `not_evaluated`, `[]` |
| 3b | the tab reads "GeM hasn’t published the result yet. We check daily for 30 days after closing." | **met** | S3: `result-pending` text equals the quoted copy exactly; no table. [S3 desktop](https://raw.githubusercontent.com/Shashank2577/GEMs/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/S3-result-tab-not-published-desktop.png). Unlisted bid additionally shows the "GeM doesn’t list this bid’s evaluation yet. We’ll check again tomorrow." notice ([not-listed](https://raw.githubusercontent.com/Shashank2577/GEMs/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/S3-result-tab-not-listed-desktop.png)) |
| 4a | Given a tracked tender becomes awarded, org members with in-app alerts get "Result published: <title> — L1 <seller> at ₹<price>" | **met** | S4: owner, analyst and viewer each have exactly 1 `result` in-app row per awarded tender, none for tech-evaluated/unlisted, none for an org that does not track; title `Result published: … — L1 Kaveri Systems & Services Pvt Ltd at ₹28,40,500`; visible in bell and /notifications. [bell](https://raw.githubusercontent.com/Shashank2577/GEMs/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/S4-bell-result-published-desktop.png) |
| 4b | (dedupe per tender per org) | **met** | S4: B rolled back to financial_evaluated, aged, refreshed -> table re-read, notification count unchanged, no second `awarded` event |
| 5a | Given the org's awarded tracked tenders, when any signed-in member (any role, read-only) opens Insights → Competitors, a table lists sellers ranked by wins with win count, total awarded value and categories | **met** | S5: Viewer opens it from the nav; Kaveri 3 wins, ₹85,21,500, categories incl. Printer Cartridge; Aarav 1 win ₹29,50,000; ordered by wins. [table](https://raw.githubusercontent.com/Shashank2577/GEMs/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/S5-competitors-table-desktop.png) |
| 5b | filterable by category and buyer state | **met** | S5: State = Gujarat -> 1 award, ₹28,40,500 (URL `?state=Gujarat`); Category = Laptop - Notebook / Server (Q2) narrow correctly; API `?state=` and `?category=` agree. [state](https://raw.githubusercontent.com/Shashank2577/GEMs/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/S5-competitors-filter-state-desktop.png) |
| 5c | "winner is not the lowest price" cases are flagged | **met (seeded award)** | S5: tile "Flagged: not lowest price" = 1, "1 flagged award" badge on Aarav row, Result tab anomaly note "Winner is not the lowest price … ₹1,09,500 above the lowest price". mock-gem always awards L1, so this award (6421030) was seeded by SQL; aggregation and UI are real. [flagged](https://raw.githubusercontent.com/Shashank2577/GEMs/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/S5-competitors-flagged-award-desktop.png) |
| 5d | (empty state) | **met** | S5: org with nothing tracked/awarded sees "No awarded results for your tracked tenders yet", no table, API `total 0`. [empty](https://raw.githubusercontent.com/Shashank2577/GEMs/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/S5-competitors-empty-desktop.png) |
| 6a | Given the results page returns HTML the parser cannot read, the refresh records the error on the run | **met** | S6: second API process behind a pass-through proxy serving an unreadable result page; run `partial`, error "tender n/m: GeM result page could not be read (format changed?)" on `ingestion_runs` and on `tender_results.error` |
| 6b | and leaves existing result data untouched | **met** | S6: md5 over status, bidders, categories, source_url, fetched_at identical before/after; no extra `awarded` event or alert; API `lastCheck:"unreadable"` with the 4 bidders still returned; UI keeps the table + "GeM’s result page couldn’t be read. Showing the result from …". [S6](https://raw.githubusercontent.com/Shashank2577/GEMs/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/S6-result-tab-unreadable-kept-desktop.png) |
| N1 | NFR-005: 375 px without horizontal scroll (Result tab, Competitors) | **met** | @mobile: Result tab cards (L1 card highlighted, ₹28,40,500), not-published state, Competitors cards + working State filter; `noHorizontalOverflow` passes. [result](https://raw.githubusercontent.com/Shashank2577/GEMs/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/S2-mobile-result-tab-awarded-mobile.png) [competitors](https://raw.githubusercontent.com/Shashank2577/GEMs/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/S5-mobile-competitors-mobile.png) |
| N2 | NFR-005: light/dark, WCAG 2.1 AA | **met** | axe (A/AA, serious+critical) passes light and dark on: Result tab (awarded table), Result tab (not published), Competitors. 6/6 |

### Findings

1. **observation** — A bid GeM never lists (`not_listed`) keeps `checked_at` null, so it is asked again on every refresh, not once per 24 h (S1: second same-day refresh re-checked exactly that bid). Matches the documented design ("asked again next run") and the daily cadence, so harmless in production; manual repeated runs would re-query it.
   - Where: `apps/api/src/services/results.ts` (`recordFailure` with `advance=false`)
2. **observation** — The tender hero still shows the grey "Closed" status next to the "Awarded" chip on an awarded tender ([S2 screenshot](https://raw.githubusercontent.com/Shashank2577/GEMs/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/S2-result-tab-awarded-desktop.png)). Cosmetic.
3. **observation** — The Owner of a fresh org is redirected from /dashboard to the onboarding wizard; the bell checks therefore run as the Analyst. Pre-existing behaviour, not US6.

### Not checked

- The ≤ 1 request/second spacing end to end: the E2E API runs with `GEM_MIN_INTERVAL_MS=0` (see `e2e/support/start-api.sh`). Covered only by the core client unit test and the cluster GeM lease; real GeM is unreachable from CI.
- Real GeM markup: results are checked against the recorded/reconstructed fixtures served by mock-gem.
- The "winner is not the lowest price" award is a SQL-seeded row (mock-gem cannot produce one); the unreadable page is produced by a test proxy in front of mock-gem, not by mock-gem itself. In S6 the stored result was first moved back to `financial_evaluated` (table kept) so the tender was due for re-check, since awarded+table results are final.
- Scheduled 10:00 IST daily gate (`runDailyResults`) is bypassed by the test hook; covered by `results.test.ts`.
- Email/WhatsApp for result alerts (the spec asks for in-app only).

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion above is met, evidence linked. Videos: one per test in the evidence folder, e.g. [S2](https://github.com/Shashank2577/GEMs/blob/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/s2-scenario-2-get-result-200-shape-result-tab-shows-awarded--desktop.webm), [S4](https://github.com/Shashank2577/GEMs/blob/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/s4-scenario-4-result-published-title-l1-seller-at-price-for--desktop.webm), [S5](https://github.com/Shashank2577/GEMs/blob/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/s5-scenario-5-insights-competitors-ranked-by-wins-with-value-desktop.webm), [S6](https://github.com/Shashank2577/GEMs/blob/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/s6-scenario-6-unreadable-result-page-error-recorded-on-the-r-desktop.webm), [mobile result](https://github.com/Shashank2577/GEMs/blob/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/s2-mobile-result-tab-at-375-px-badge-l1-row-highlighted-card-mobile.webm), [mobile competitors](https://github.com/Shashank2577/GEMs/blob/204966a9d07191c76f4cdfe3c7709c8759fb86b8/qa/evidence/003/US6/s5-mobile-competitors-at-375-px-cards-value-flagged-filters--mobile.webm).

---
_Generated by [Claude Code](https://claude.ai/code)_
