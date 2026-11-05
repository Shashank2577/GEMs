## QA verdict — APPROVED

**Work item:** #62 · **PR:** #474 · **Reviewer:** qa (claude-code) · **Session:** https://claude.ai/code/session_01BUi6mFXxwtfLeYatLJVi7u

Spec: `specs/003-identify-ingestion-alerts/spec.md` US1 scenarios 1-9 plus FR-013 (scenario 11). Test: `e2e/003-identify-ingestion-alerts/US1-ingestion.e2e.ts` (15 passed on a fresh DB, run twice, desktop plus `@mobile`; real API, Postgres and mock-gem).

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1a | Empty tenders, Bid Manager POST `/api/ingestion/run {"pages":5}` returns 200, status success, pagesFetched 4, seen 36, created 36, updated 0, error null | met | test S1; [feed](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S1-feed-36-tenders-desktop.png) |
| 1b | 36 `tender_events` of kind `created` | met | test S1 (SQL count = 36) |
| 2 | GEM/2026/B/6421001: Maharashtra, emd 240000, value 9600000, bid, open, sourceUrl ends /showbidDocument/7421001 | met | [S2](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S2-tender-6421001-desktop.png) |
| 3 | Second sync: seen 36, created 0, updated 0, matches 0; tender count 36; no new events or notifications; fetchedAt advances | met | [S3](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S3-second-sync-no-change-desktop.png) |
| 4a | mock-gem down: run failed, error HTTP 503/unreachable, tenders unchanged | met | [S4](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S4-down-red-dot-last-sync-failed-desktop.png) |
| 4b | runs API lastRun.status failed, lastSuccessAt non-null | met | test S4 |
| 4c | Pill red dot, heading "Last sync failed" and error text | met | S4 screenshot, [video](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/s4-mock-gem-down-run-failed-data-kept-red-dot-last-sync-fail-desktop.webm) |
| 5 | html mode: run failed, error contains "HTML" | met | [S5](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S5-html-failed-desktop.png) |
| 6a | Fresh running row: 409 `ingestion_running`, exact message | met | [S6a](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S6a-409-busy-desktop.png) |
| 6b | Running row older than 15 min marked failed "Timed out (worker stopped)", new run proceeds | met | [S6b](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S6b-timed-out-reaped-desktop.png) |
| 7a | Analyst/Viewer POST gets 403 "You need to be at least a Bid Manager to do that" | met | test S7 |
| 7b | Sync now not rendered for them | met | [analyst](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S7-analyst-no-sync-button-desktop.png), [viewer](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S7-viewer-no-sync-button-desktop.png), [manager has it](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S7-bid-manager-has-sync-button-desktop.png) |
| 7c | GET runs 200 for every role | met | test S7 |
| 8a | Success within 2 h: "Synced <rel>", green pulsing dot, "· n open bids" (hidden under 640 px) | met | [S8a](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S8a-S9-healthy-popover-runs-desktop.png); [375 px](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S8-pill-375px-mobile.png) |
| 8b | Older than 2 h: amber dot, "Sync is overdue" | met | [S8b](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S8b-overdue-amber-desktop.png) (runs aged 3 h via SQL) |
| 8c | No run: "Not synced yet", "Waiting for the first sync" | met | [S8c](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S8c-never-synced-desktop.png) |
| 9a | Popover lists up to 6 runs (IST time, Manual/Scheduled, "n new · n updated · n matches" or error, status badge) | met | [S9](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S9-six-runs-desktop.png) (8 runs exist, 6 shown) |
| 9b | Footer "Public listings only · ≤ 1 request/sec" | met | S8a and S9 screenshots |
| 11 / FR-013 | Manual sync within 2 min: 429 `sync_cooldown` with retry time; button disabled with tooltip | met | [cooldown popover](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/S1-S11-cooldown-popover-desktop.png) |

Videos for every test are in [qa/evidence/003/US1/](https://github.com/Shashank2577/GEMs/blob/story/GEM-62-ingestion/qa/evidence/003/US1/).

### Findings

1. **observation** — Failed manual runs also start the 2-min cooldown (`apps/api/src/routes/ingestion.ts`, lastManual query has no status filter). After a GeM outage, a manager must wait 2 min before retrying. Spec says "finished", so this is within spec; may be worth a product decision.
2. **observation** — An incremental `{}` sync (UI Sync now) on a known DB reports `tendersSeen` of one page (10), not 36; scenario 3 holds only with `pages:5`, which is how I tested it.
3. **observation** — Scenarios 6 and 8b arrange state with SQL (aged or inserted run rows), since those states cannot be produced via the API in real time.

### Not checked

- 30-minute cron schedule, polite-client details (1 req/s, retry/back-off, CSRF re-bootstrap) and scenarios 10 and 12 (catch-up paging, format drift): outside the T022 scope.
- Real GeM BidPlus; only mock-gem was used.

### Bug issues filed

None.

### Verdict

`qa:approved` — every criterion met, evidence above.
