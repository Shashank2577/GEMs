## QA verdict — APPROVED

**Work item:** #362 · **PR:** #551 · **Reviewer:** qa (claude-code/claude-opus-5-5) · **Session:** https://claude.ai/code/session_01BUi6mFf2769n2HrbTB4UYT

Code under test: `da46e1c2f2807f739a6abd9abe302eeabf672b24` (review round 2 rework, main 3f3da71 merged). Evidence commit: `1bb20ed52af5ac4a1a921c0256781e4e7adf2224`.
Servers restarted on that code for the run: API `:8795` on a fresh `tenderpilot_e2e_us7` database, mock-gem `:4018`, counting fake Anthropic API `:4119` served by the spec.

- **Playwright:** `pnpm exec playwright test e2e/008-operations-scale/US7` → **10 passed, 0 failed** (desktop 9 + mobile 1), 1.2 m
- **API:** `TEST_DATABASE_URL=…/tenderpilot_test_us7 pnpm --filter @tp/api exec vitest run` → **899 passed, 2 skipped** (46 files; the 2 skipped are the opt-in perf files, run separately below)
- **500k:** `PERF=1 … test/perf/search.perf.ts` on `tenderpilot_test_us7_500k` (500,000 tenders) → 4 passed, p95 69.6 ms

Evidence base URL: `https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/`

### Acceptance criteria

| # | Criterion (quoted from the work item / spec US7) | Verdict | Evidence |
|---|---|---|---|
| 1a | "Org B analysing a GeM document already extracted for org A at current extractor_version makes 0 new LLM extraction calls" | met | fake LLM calls: org A 1, org B **0** ([sc1-two-org-cache-desktop.txt](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc1-two-org-cache-desktop.txt)); [video](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc1-org-b-analysing-a-gem-document-already-extracted-for-org-desktop.webm) |
| 1b | "and shows the same requirements" (spec: "with provenance") | met | LLM requirements of A and B identical incl. `documentId` + page; org B's Requirements tab shows the AI row ([sc1-org-b-requirements-desktop.png](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc1-org-b-requirements-desktop.png), [sc1-org-a-requirements-desktop.png](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc1-org-a-requirements-desktop.png)) |
| 1c | spec: "`tender_documents.extracted_method` is `LLM`" | met | `…|null|LLM|llm-extract-2026-11-v1` (org_id null = public GeM document) in sc1 transcript |
| 2 | "Bumping CURRENT_EXTRACTOR_VERSION re-extracts the document once and updates the cache" | met | E2E: cache row made stale (`extractor_version='qa-older-version'`, the state a bump produces) → next analysis 1 LLM call per document, row back at current version/`LLM`/fresh, following analysis 0 calls; API test that bumps the constant in-process passes ([sc2-version-bump-desktop.txt](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc2-version-bump-desktop.txt), [sc2-transcript-desktop.png](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc2-transcript-desktop.png)) |
| 3a | "500k tenders: q='solar street light' p95 < 300 ms" | met | 200 runs at 500,000 tenders: p50 36.1 ms, **p95 69.6 ms**, max 83.2 ms ([sc3-search-desktop.txt](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc3-search-desktop.txt), [sc3-transcript-desktop.png](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc3-transcript-desktop.png)) |
| 3b | "using tenders_search_gin" (spec: "`EXPLAIN` uses `tenders_search_gin`") | met | page + total/facet query plans list `tenders_search_gin`; psql `EXPLAIN ANALYZE` → `Bitmap Index Scan on tenders_search_gin` (same transcript) |
| 3c | "bid-number prefix still matches" | met | 500k: `q=GEM/2026/B/12` → 11,111 rows via `tenders_bid_number_prefix_idx`; e2e feed `GEM/2026/B/77310` lists all 3 fixtures ([sc3-search-bid-prefix-desktop.png](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc3-search-bid-prefix-desktop.png), [375 px](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc3-search-bid-prefix-375-mobile.png)) |
| 3d | Feed search UI: "solar street light" (desktop + 375 px), "IS 2062" finds "IS-2062" | met | [desktop](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc3-search-solar-street-light-desktop.png), [375 px, no horizontal scroll](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc3-search-solar-street-light-375-mobile.png), [IS 2062](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc3-search-is-2062-desktop.png); "Street furniture" correctly not returned for "solar street light"; [video desktop](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc3-feed-search-finds-solar-street-light-is-2062-is-2062-and-desktop.webm), [video mobile](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc3-feed-search-at-375-px-solar-street-light-and-a-bid-numbe-mobile.webm) |
| 4a | "1,000 watchlists x 500 tenders matching < 5 s in Node" | met | core benchmark 844 ms; API end-to-end (DB) 2,286 ms, 10,000 matches ([sc4-matching-benchmark-desktop.txt](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc4-matching-benchmark-desktop.txt), [sc4-transcript-desktop.png](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc4-transcript-desktop.png)) |
| 4b | "inserts batched <= 500 rows per statement" | met | `insertStatements 20, maxRowsPerStatement 500`; 1,201 rows → 500 + 500 + 201 (same transcript) |
| 5a | "Fixed-clock housekeeping deletes exactly the expired sessions, notifications, events, raw payloads and packets beyond newest 5 per workspace (row + R2)" | met | `housekeeping.test.ts` 10/10: summary `{"job":"housekeeping","deleted":{"sessions":1,"invitations":2,"notifications":4,"tenderEvents":1,"tenderRaw":1,"rateLimits":0,"packets":2,"packetBlobs":2}}`, exact survivors asserted ([sc5-housekeeping-desktop.txt](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc5-housekeeping-desktop.txt), [sc5-transcript-desktop.png](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc5-transcript-desktop.png)) |
| 5b | "second run deletes 0" | met | "runs once per IST day: a later tick the same day skips; a forced second run deletes 0" passes (same transcript) |
| 6 | "120 queued emails -> exactly 2 Resend /emails/batch calls" | met | `calls` = 2 × `/emails/batch`, sizes `[100, 20]`, 120 rows sent ([sc6-email-batch-desktop.txt](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc6-email-batch-desktop.txt), [sc6-transcript-desktop.png](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc6-transcript-desktop.png)) |
| 7a | "With Hyperdrive binding: @neondatabase/serverless removed" | met | absent from every package.json; no importer in pnpm-lock declares it; 0 neon modules in the `wrangler deploy --dry-run` bundle ([sc7-hyperdrive-desktop.txt](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc7-hyperdrive-desktop.txt)) |
| 7b | "createNeonDb deleted" | met | `git grep createNeonDb -- apps packages` → no matches; `worker.ts` uses `createNodeDb` (HYPERDRIVE) |
| 7c | "50 concurrent feed requests on staging -> 0 connection errors" | **unverifiable** | Needs a real Hyperdrive config id and the staging Worker; the `[[hyperdrive]]` binding ships commented out until an operator creates it. Tracked as operator task T111 #468 — what would satisfy it: the `scripts/load/feed.sh` 50-concurrent transcript from staging. ([sc7-transcript-desktop.png](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc7-transcript-desktop.png)) |
| 8 | "Each LATER item (Queues, RLS, Razorpay, Analytics Engine, weekly pg_dump) has its trigger documented and linked from the runbook" | met | `docs/runbook.md` § LATER triggers: each of the 5 rows has a measurable trigger and a link to an existing ADR that names the item ([sc8-later-triggers-desktop.txt](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc8-later-triggers-desktop.txt), [sc8-transcript-desktop.png](https://github.com/Shashank2577/GEMs/blob/1bb20ed52af5ac4a1a921c0256781e4e7adf2224/qa/evidence/008/US7/sc8-transcript-desktop.png)) |

### Findings

1. **observation** — Scenario 2 in the E2E is driven by making the cache row's `extractor_version` older (a running server cannot change the constant); the in-process constant bump is covered by `extraction-cache.test.ts` ("bumping the extractor version re-extracts the document once…"), which passes.
2. **observation** — `pnpm-lock.yaml` still lists `@neondatabase/serverless@0.10.4` as an auto-installed optional peer of `drizzle-orm` (`autoInstallPeers: true`). No workspace package depends on it and it is not in the Worker bundle; setting `auto-install-peers=false` would remove it from the lockfile entirely.
3. **observation** — FR-071 (R2 lifecycle rule for packets) is partial (T109, decision pending in #552): documented commands and offboarding exist; no rule is configured. Not one of #362's acceptance criteria.
4. **observation** — Known, documented superset gaps of the FTS pre-filter: Greek final sigma σ/ς and µ/μ case folding (runbook § Full-text search migration).

### Not checked

- Hyperdrive on staging (criterion 7c) — no staging access (T111 #468).
- Production-scale housekeeping run time and R2 behaviour against real Cloudflare R2 (tests use the filesystem/memory blob store).
- Real Resend API (the adapter is exercised against a recorded-shape fake `fetch`).

An approval covers what is in the table above. It is not a statement that the change is free of defects.

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion met except 7c, which is legitimately unverifiable here (operator task T111 #468). #362 stays open for T111 #468 and T109 #552 (`needs-human`).
