# ADR-0009: Feed query performance at 10^5–10^6 tenders — partial indexes and a full-text search column

**Status**: Proposed
**Date**: 2026-11-05
**Priority**: MUST (partial indexes, no `raw` in hot selects) · SHOULD (full-text search)

## Context

`GET /tenders` (`routes/tenders.ts`) ran five queries per call over the same WHERE: page, `count(*)`, and three
facet `GROUP BY`s (state, ministry, category) — since 0015's rework, page + one GROUPING SETS query (decision 6). Default filter is `status = 'open' AND (end_at IS NULL OR end_at >= now)`;
default sort `created_at DESC`; optional `q` expands to `ILIKE '%word%'` across 10 text columns plus
`items::text`, up to 8 words. Per-org predicates are correlated `EXISTS` on `tender_matches`, `analyses`,
`bid_workspaces` (all have `(org_id, tender_id)` leading index columns — fine).

Indexes today: `(source, bid_number)` unique, `end_at`, `state`. There is no index whose leading column is `status`
and no text index. GeM publishes thousands of bids per day; within a year the table is ~10^6 rows of which
~2–5 % are open. Every feed call currently scans or bitmap-merges the whole table; `ILIKE '%…%'` is always a
sequential scan. NFR-001 (feed < 2 s p95) will not hold.

Several hot paths also select `tenders.*` including `raw` jsonb (3–8 KB/row): `candidateTenders` (up to 5,000
rows), `matchAndNotify`, `refreshMatches`, `decorateTenders` callers.

## Decision

1. **Partial indexes on open tenders (MUST)** — `packages/db/src/schema.ts` + migration:
   ```sql
   CREATE INDEX tenders_open_created_idx ON tenders (created_at DESC) WHERE status = 'open';
   CREATE INDEX tenders_open_closing_idx ON tenders (coalesce(end_at, 'infinity')) WHERE status = 'open';
   -- (was tenders_open_end_idx ON (end_at); 008 migration 0014 indexes the feed's "still open" expression instead)
   CREATE INDEX tenders_open_value_idx   ON tenders (estimated_value) WHERE status = 'open';
   CREATE INDEX tenders_open_state_idx   ON tenders (state, created_at DESC, coalesce(end_at, 'infinity'))
                                                                        WHERE status = 'open';
   -- (008 migration 0015, PR #515 QA round 1: on (state) alone the planner never chose it for ?state=X)
   CREATE INDEX tenders_open_ministry_idx ON tenders (ministry)       WHERE status = 'open';
   CREATE INDEX tenders_open_category_idx ON tenders (category)       WHERE status = 'open';
   ```
   The open subset is small, so facets and sorts become index-range scans. Keep `tenders_end_idx` for the
   cron's "close expired" update; drop `tenders_state_idx` (superseded).

   **State filter (amended 2026-11-05, 0015).** PostgreSQL does not use expression statistics of a *partial* index, so
   it estimates the feed's "still open" condition (`coalesce(end_at, 'infinity') >= $now`) at the default 1/3. With
   `tenders_open_state_idx (state)` that made it prefer, at 500k rows, `tenders_open_created_idx` + filter for the
   `?state=X` page and `BitmapAnd(tenders_open_closing_idx, tenders_state_idx)` (non-partial) for count/facets. The
   index is therefore `(state, created_at DESC, coalesce(end_at, 'infinity'))`: state equality and "still open" are both
   Index Conds, rows come out in the default sort order, and count/facets are one bitmap scan of it.
   The feed writes `status = 'open'` as a literal — the partial indexes' exact predicate — so the planner can prove
   the indexes apply even under a generic plan (statement-caching poolers). `perf-indexes.test.ts` asserts the index
   name and its Index Cond for the page and the shared count/facet query.
6. **One scan for the total and the facets** (008/FR-033, PR #515 QA round 1). The total and every facet whose own
   filter is not set share the request's WHERE, so they are one `GROUP BY GROUPING SETS ((state), (ministry),
   (category), ())` query, ranked in SQL (`row_number()`: count desc, value asc, top 60); a facet whose filter is set
   (it leaves that filter out) keeps its own query. At 500k / 30k open each scan of the open set costs ~15–20 ms of
   Postgres CPU; four per request was what queued at concurrency 10 (feed p95 ~260–360 ms → ~95–150 ms).
2. **Column projection (MUST)** — a shared `tenderListColumns` object (everything except `raw`, `content_hash`)
   used by `routes/tenders.ts`, `routes/watchlists.ts#candidateTenders`, `services/ingest.ts#matchAndNotify`.
   `raw` is only read by `GET /tenders/:id` debugging paths (currently none) — consider moving it to ADR-0012 retention.
3. **Full-text search (SHOULD)** — generated column
   `search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(bid_number,'') || ' ' || coalesce(category,'') || ' ' || coalesce(ministry,'') || ' ' || coalesce(department,'') || ' ' || coalesce(organisation,'') || ' ' || coalesce(buyer_office,'') || ' ' || coalesce(state,'') || ' ' || coalesce(city,'') || ' ' || coalesce(items::text,''))) STORED`
   with `CREATE INDEX tenders_search_idx ON tenders USING gin (search)`. `buildFilters` uses
   `search @@ websearch_to_tsquery('simple', $q)`; keep a prefix match on `bid_number` (`ILIKE 'GEM/2026/B/12%'`,
   which the unique index serves) so pasting a bid number still works. `candidateTenders` keyword pre-filter uses the
   same column. `'simple'` dictionary avoids English stemming surprises on product names.
4. **Analyses latest-row lookups** — extend `analyses_org_tender_idx` to `(org_id, tender_id, created_at DESC)` so
   `DISTINCT ON` / `ORDER BY created_at DESC LIMIT 1` are index-only.
5. Add an API test fixture that seeds 50k synthetic tenders (fast `COPY`-style insert) and asserts the feed query
   plans use the partial indexes (`EXPLAIN (FORMAT JSON)`), run in CI nightly rather than on every push.

## Consequences

- Feed/dashboard cost becomes proportional to open tenders (~10^4), not total rows (~10^6).
- Write amplification: six partial indexes + a GIN index on a table that receives ~3k inserts/updates per day —
  negligible.
- Search semantics change from substring to word/prefix matching; the UI copy ("Search title, buyer, category…")
  stays true; hyphenated model numbers tokenize differently — covered by tests on the existing fixtures.
- Storage: `search` adds ~0.5 KB/row; acceptable, and `raw` retention (ADR-0012) more than pays for it.

## Acceptance

- With 500k seeded tenders (10k open), `GET /api/tenders?q=laptop&state=Maharashtra` p95 < 300 ms on Neon's
  smallest compute; `EXPLAIN` shows `tenders_search_idx` and `tenders_open_created_idx`.
- Existing identify tests pass unchanged except for documented tokenization cases.
