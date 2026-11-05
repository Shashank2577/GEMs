/**
 * Full-text tender search (008/FR-073, US7 scenario 3). `tenders.search` is a generated `tsvector` ('simple' config)
 * with GIN index `tenders_search_gin`; both are created by migration `*_tenders_search.sql` and intentionally not
 * declared in the Drizzle schema (a declared column would be read by every `select().from(tenders)`).
 *
 * The query side parses the user's text with `websearch_to_tsquery('simple', q)` (quoted phrases, `or`, `-word`)
 * after the same `/ . _ @ :` → space translation the column applies, then turns every lexeme into a prefix match
 * (`'laptop':*` also finds "Laptops", as the old ILIKE search did). The feed additionally matches bid numbers by
 * prefix (`lower(bid_number) LIKE 'gem/2026/b/12%'`, index `tenders_bid_number_prefix_idx`).
 */
import { sql, type SQL } from 'drizzle-orm';
import { tenders } from '@tp/db';

/** Characters the generated column (and so the query) turns into spaces before tokenising. */
export const SEARCH_SEPARATORS = '/._@:';
const SPACES = ' '.repeat(SEARCH_SEPARATORS.length);
/** A lexeme's closing quote in tsquery text (lexemes never contain an unescaped quote followed by a space/`)`/end). */
const LEXEME_END = String.raw`'(?=\s|\)|$)`;

/** The generated column, qualified so it also works inside correlated subqueries. */
export const tenderSearchColumn = sql`${tenders}."search"`;

const escapeLike = (s: string) => s.replace(/[%_\\]/g, (m) => `\\${m}`);

/** `websearch_to_tsquery('simple', q)` with every lexeme made a prefix match. Empty (no lexemes) for punctuation-only q. */
export function tenderTsQuery(q: string): SQL {
  const parsed = sql`websearch_to_tsquery('simple', translate(${q}::text, ${SEARCH_SEPARATORS}::text, ${SPACES}::text))`;
  // `::tsquery` (not to_tsquery) keeps websearch's normalised lexemes as they are: to_tsquery would re-parse
  // 'wombat-proof' into a second phrase.
  return sql`regexp_replace(${parsed}::text, ${LEXEME_END}::text, ${"':*"}::text, 'g')::tsquery`;
}

/** A query that is (the start of) a GeM bid number, e.g. `GEM/2026/B/12` — matched by prefix only. */
export const BID_NUMBER_PREFIX_RE = /^gem\/\d{2,4}(\/|$)/i;

/**
 * Feed condition (GET /tenders `q`): full-text match OR bid-number prefix, both index-backed (BitmapOr). A query shaped
 * like a bid number uses only the prefix arm, so `GEM/2026/B/12` lists exactly the bids starting with it instead of
 * every tender that happens to contain the words "gem", "2026", "b" and "12…".
 */
export function tenderSearchCondition(q: string): SQL {
  const text = q.trim();
  const prefix = sql`lower(${tenders.bidNumber}) like ${`${escapeLike(text.toLowerCase())}%`}`;
  if (BID_NUMBER_PREFIX_RE.test(text)) return prefix;
  return sql`(${tenderSearchColumn} @@ ${tenderTsQuery(text)} or ${prefix})`;
}

/**
 * Watchlist keyword pre-filter (candidateTenders): a tender passes when ANY keyword's query matches. The matcher
 * (packages/core/src/match/matcher.ts) still decides; this only has to be a superset of its hits, so a keyword
 * that yields no lexemes (e.g. only punctuation) lets every row through to the matcher instead of none.
 */
export function anyKeywordCondition(keywords: string[]): SQL {
  return sql`(${sql.join(keywords.map((k) => {
    const q = tenderTsQuery(k);
    return sql`(numnode(${q}) = 0 or ${tenderSearchColumn} @@ ${q})`;
  }), sql` or `)})`;
}
