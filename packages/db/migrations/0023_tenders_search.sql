-- tp:non-transactional
-- 008/FR-073 (US7): full-text search for the tender feed and watchlist candidates.
-- * `search`: generated tsvector ('simple' config — no stemming, no stop words) over bid number, title, category,
--   ministry, department, organisation, buyer office, state, city and item names. Every ASCII punctuation character
--   becomes a space first (the default parser reads "IS-2062" as 'is' + the signed number '-2062', "<cctv>" as an XML
--   tag, "1.5kg" as a float), so "GEM/2026/B/6421001" is searchable by "6421001", "IS-2062" by "2062" and every lexeme
--   is a plain run of word characters. Item names come from the jsonb text, whose escapes (`\n`, `\"`, `\u0001`) are
--   blanked first so "line\nLaptop" does not become 'nlaptop'. apps/api/src/lib/tender-search.ts applies the same
--   translation (SEARCH_SEPARATORS — keep the two sets identical; a test compares them) to every query, which keeps
--   the watchlist keyword pre-filter a superset of the matcher. Adding a STORED generated column rewrites `tenders`
--   under an ACCESS EXCLUSIVE lock: run this migration off-peak (docs/runbook.md § Full-text search migration).
-- * `tenders_search_gin`: GIN over `search`; `tenders_bid_number_prefix_idx`: `lower(bid_number) LIKE 'gem/2026/b/12%'`.
-- CREATE INDEX CONCURRENTLY cannot run in a transaction, so this file runs statement by statement outside one
-- (first-line marker, packages/db/src/migrate.ts). Every statement is idempotent (IF NOT EXISTS).
-- The column and indexes are intentionally not declared in schema.ts (see the comment on `tenders` there).
ALTER TABLE "tenders" ADD COLUMN IF NOT EXISTS "search" tsvector GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig, translate(
    coalesce("bid_number", '') || ' ' || coalesce("title", '') || ' ' || coalesce("category", '') || ' ' ||
    coalesce("ministry", '') || ' ' || coalesce("department", '') || ' ' || coalesce("organisation", '') || ' ' ||
    coalesce("buyer_office", '') || ' ' || coalesce("state", '') || ' ' || coalesce("city", '') || ' ' ||
    coalesce(regexp_replace(jsonb_path_query_array("items", '$[*].name')::text, '\\(u[0-9a-fA-F]{4}|.)', ' ', 'g'), ''),
    '!"#$%&''()*+,-./:;<=>?@[\]^_`{|}~', '                                '))
) STORED;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tenders_search_gin" ON "tenders" USING gin ("search");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tenders_bid_number_prefix_idx" ON "tenders" USING btree (lower("bid_number") text_pattern_ops);
