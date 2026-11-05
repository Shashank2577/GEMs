-- tp:non-transactional
-- 008/FR-073 (US7): full-text search for the tender feed and watchlist candidates.
-- * `search`: generated tsvector ('simple' config — no stemming, no stop words) over bid number, title, category,
--   ministry, department, organisation, buyer office, state, city and item names. `/ . _ @ :` become spaces first, so
--   "GEM/2026/B/6421001" is searchable by "6421001" and "street/light" by "light" (apps/api/src/lib/tender-search.ts
--   applies the same translation to the query). Adding a STORED generated column rewrites `tenders` under an ACCESS
--   EXCLUSIVE lock: run this migration off-peak (docs/runbook.md § Full-text search migration).
-- * `tenders_search_gin`: GIN over `search`; `tenders_bid_number_prefix_idx`: `lower(bid_number) LIKE 'gem/2026/b/12%'`.
-- CREATE INDEX CONCURRENTLY cannot run in a transaction, so this file runs statement by statement outside one
-- (first-line marker, packages/db/src/migrate.ts). Every statement is idempotent (IF NOT EXISTS).
-- The column and indexes are intentionally not declared in schema.ts (see the comment on `tenders` there).
ALTER TABLE "tenders" ADD COLUMN IF NOT EXISTS "search" tsvector GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig, translate(
    coalesce("bid_number", '') || ' ' || coalesce("title", '') || ' ' || coalesce("category", '') || ' ' ||
    coalesce("ministry", '') || ' ' || coalesce("department", '') || ' ' || coalesce("organisation", '') || ' ' ||
    coalesce("buyer_office", '') || ' ' || coalesce("state", '') || ' ' || coalesce("city", '') || ' ' ||
    coalesce(jsonb_path_query_array("items", '$[*].name')::text, ''),
    '/._@:', '     '))
) STORED;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tenders_search_gin" ON "tenders" USING gin ("search");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tenders_bid_number_prefix_idx" ON "tenders" USING btree (lower("bid_number") text_pattern_ops);
