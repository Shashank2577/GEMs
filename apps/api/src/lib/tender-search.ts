/**
 * Full-text tender search (008/FR-073, US7 scenario 3). `tenders.search` is a generated `tsvector` ('simple' config)
 * with GIN index `tenders_search_gin`; both are created by migration `*_tenders_search.sql` and intentionally not
 * declared in the Drizzle schema (a declared column would be read by every `select().from(tenders)`).
 *
 * Every ASCII punctuation character ({@link SEARCH_SEPARATORS}) becomes a space before tokenising, on the column and on
 * the query alike. Postgres' default parser is context-sensitive about punctuation — "IS-2062" parses as 'is' and the
 * signed number '-2062', "<cctv>" as an XML tag (dropped), "1.5kg" as a float, "a@b.in" as an e-mail — so without
 * this a search for "2062" would not find "IS-2062". With only letters, digits, spaces and non-ASCII characters left,
 * every lexeme is simply a maximal run of word characters, which is what keeps the watchlist pre-filter a superset of
 * the matcher (packages/core/src/match/matcher.ts; property-tested in apps/api/test/identify.test.ts).
 *
 * - Feed `q` ({@link tenderSearchCondition}): `websearch_to_tsquery` syntax stays available — `"quoted phrase"`,
 *   `or`, and `-word` (a `-` at the start of a word); a `-` inside a word ("IS-2062") is a separator. Every lexeme is
 *   made a prefix match (`'laptop':*` also finds "Laptops", as the old ILIKE search did). The feed additionally matches
 *   bid numbers by prefix (`lower(bid_number) LIKE 'gem/2026/b/12%'`, index `tenders_bid_number_prefix_idx`).
 * - Watchlist keywords ({@link anyKeywordCondition}): a keyword is plain text for the matcher, so no operators — its
 *   lexemes are ANDed (`plainto_tsquery`), each as a prefix match.
 */
import { sql, type SQL } from 'drizzle-orm';
import { tenders } from '@tp/db';

/**
 * ASCII punctuation the generated column (and so every query) turns into spaces before tokenising. Must stay
 * byte-identical to the `translate(…)` set in migration `*_tenders_search.sql` (asserted by a test).
 */
export const SEARCH_SEPARATORS = `!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`;
const SPACES = ' '.repeat(SEARCH_SEPARATORS.length);
/** The feed keeps `"` and `-` for websearch syntax; a `-` inside a word is turned into a space in JS first. */
const FEED_SEPARATORS = SEARCH_SEPARATORS.replace(/["-]/g, '');
const FEED_SPACES = ' '.repeat(FEED_SEPARATORS.length);
/** A lexeme's closing quote in tsquery text (lexemes never contain an unescaped quote followed by a space/`)`/end). */
const LEXEME_END = String.raw`'(?=\s|\)|$)`;

/** The generated column, qualified so it also works inside correlated subqueries. */
export const tenderSearchColumn = sql`${tenders}."search"`;

const escapeLike = (s: string) => s.replace(/[%_\\]/g, (m) => `\\${m}`);
const prefixed = (query: SQL): SQL => sql`regexp_replace(${query}::text, ${LEXEME_END}::text, ${"':*"}::text, 'g')::tsquery`;

/**
 * Feed query: `websearch_to_tsquery('simple', q)` with every lexeme made a prefix match. Empty (no lexemes) for
 * punctuation-only q. `::tsquery` (not to_tsquery) keeps websearch's normalised lexemes as they are.
 */
export function tenderTsQuery(q: string): SQL {
  const text = q.replace(/(?<=\S)-/g, ' '); // "IS-2062" → "IS 2062"; "-cctv" (exclusion) is kept
  return prefixed(sql`websearch_to_tsquery('simple', translate(${text}::text, ${FEED_SEPARATORS}::text, ${FEED_SPACES}::text))`);
}

/** Watchlist keyword query: the keyword's lexemes ANDed, each a prefix match; no websearch operators. */
export function keywordTsQuery(keyword: string): SQL {
  return prefixed(sql`plainto_tsquery('simple', translate(${keyword}::text, ${SEARCH_SEPARATORS}::text, ${SPACES}::text))`);
}

/** A query that is (the start of) a GeM bid number, e.g. `GEM/2026/B/12` — matched by prefix only. */
export const BID_NUMBER_PREFIX_RE = /^gem\/\d{2,4}(\/|$)/i;

/**
 * Feed condition (GET /tenders `q`): full-text match OR bid-number prefix, both index-backed (BitmapOr). A query shaped
 * like a bid number uses only the prefix arm, so `GEM/2026/B/12` lists exactly the bids starting with it instead of
 * every tender that happens to contain the words "gem", "2026", "b" and "12…". A query without lexemes (only
 * punctuation) skips the full-text arm instead of evaluating an empty tsquery against every row.
 */
export function tenderSearchCondition(q: string): SQL {
  const text = q.trim();
  const prefix = sql`lower(${tenders.bidNumber}) like ${`${escapeLike(text.toLowerCase())}%`}`;
  if (BID_NUMBER_PREFIX_RE.test(text)) return prefix;
  const query = tenderTsQuery(text);
  return sql`((numnode(${query}) > 0 and ${tenderSearchColumn} @@ ${query}) or ${prefix})`;
}

/**
 * Watchlist keyword pre-filter (candidateTenders): a tender passes when ANY keyword's query matches. The matcher
 * (packages/core/src/match/matcher.ts) still decides; this only has to be a superset of its hits. It is, because the
 * matcher needs the keyword's words at word boundaries (its last word possibly followed by a plural suffix), and after
 * the shared separator translation each such word is a whole lexeme — the last one a lexeme prefix — of the tender's
 * tsvector. A keyword that yields no lexemes (only punctuation, or only non-letter symbols) lets every row through to
 * the matcher instead of none.
 */
export function anyKeywordCondition(keywords: string[]): SQL {
  return sql`(${sql.join(keywords.map((k) => {
    const q = keywordTsQuery(k);
    return sql`(numnode(${q}) = 0 or ${tenderSearchColumn} @@ ${q})`;
  }), sql` or `)})`;
}
