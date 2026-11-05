/**
 * Public GeM bid-result (award) page parser (T032; 007/FR-030, NFR-009).
 *
 *   const r = parseBidResult(html);   // { categories, bidders: [{ rank, company, price, level }], l1Price }
 *
 * Reads the public BidPlus result view (`/bidding/bid/getBidResultView/<b_id>`) that GeM publishes after
 * financial evaluation. Used only to *suggest* the L1 price in the "Record the result" dialog; the human
 * confirms it. Nothing here enters a price on GeM (Constitution I).
 *
 * Ported from `get_bid_result()` in arush15june/gem-search (gem.py, MIT, © 2026 Aarush Jain) — see NOTICE.
 * The bidder-row regex keeps the original structure (row number → company span → `bid_price` span → `L<n>`);
 * the only extensions are Indian digit grouping in prices ("29,50,000.00"), HTML entity decoding in company
 * names and the derived `l1Price`.
 */

export interface BidResultBidder {
  /** Row number on the result page (1-based). */
  rank: number;
  company: string;
  /** Total price quoted, in rupees. */
  price: number;
  /** GeM price level: "L1" (lowest) … "Ln". */
  level: string;
}

export interface BidResult {
  categories: string[];
  bidders: BidResultBidder[];
  /** Lowest price among L1 bidders, or null when the page lists no L1 (not evaluated yet / login required). */
  l1Price: number | null;
}

/**
 * L1 hint served by `GET /api/tenders/:id/result-hint` (T033). Bidder names are not passed on — only rank,
 * level and price are needed to pre-fill the dialog.
 */
export type BidResultHint =
  | { available: true; l1Price: number | null; bidders: { rank: number; level: string; price: number }[]; sourceUrl: string; fetchedAt: string }
  | { available: false; reason: 'no_gem_id' | 'not_published' | 'gem_unavailable' };

/** Path of the public result view for a BidPlus `b_id` (same route as gem-search's BID_RESULT_URL). */
export const bidResultPath = (gemBidId: string) => `/bidding/bid/getBidResultView/${encodeURIComponent(gemBidId)}`;

/** Larger inputs are truncated: a real result page is well under this. */
export const MAX_RESULT_HTML = 512 * 1024;

/** Rows longer than this are not bidder rows (a real one is < 2 KB) and are skipped unparsed. */
export const MAX_ROW_LENGTH = 16 * 1024;

// gem.py get_bid_result() pattern, re.DOTALL:
//   <td class="productDtl">(\d+)</td>\s*<td><span[^>]*>\s*([^<]+)</span>.*?<span class="bid_price">\s*([\d.]+)</span>.*?<td><strong>(L\d+)</strong>
// Same structure, but evaluated in steps so no part can backtrack: an anchored head (row number + company, made
// of non-overlapping character classes), then indexOf for the FIRST price span and the FIRST level cell after it,
// each read with a sticky regex. Applied to ONE table row at a time, so a row with a missing price or level is
// skipped instead of borrowing the next row's.
const ROW_HEAD = /<td class="productDtl">(\d+)<\/td>\s*<td><span[^>]*>([^<]+)<\/span>/;
const PRICE_OPEN = '<span class="bid_price">';
const PRICE = /\s*([\d,.]+)<\/span>/y;
const LEVEL_OPEN = '<td><strong>L';
const LEVEL = /<td><strong>(L\d+)<\/strong>/y;

function parseRow(row: string): BidResultBidder | null {
  if (row.length > MAX_ROW_LENGTH) return null;
  const head = ROW_HEAD.exec(row);
  if (!head) return null;
  const p = row.indexOf(PRICE_OPEN, head.index + head[0].length);
  if (p < 0) return null;
  PRICE.lastIndex = p + PRICE_OPEN.length;
  const price = PRICE.exec(row);
  if (!price) return null;
  const l = row.indexOf(LEVEL_OPEN, PRICE.lastIndex);
  if (l < 0) return null;
  LEVEL.lastIndex = l;
  const level = LEVEL.exec(row);
  if (!level) return null;
  const amount = parsePrice(price[1]!);
  if (!Number.isFinite(amount)) return null;
  return { rank: Number(head[1]), company: decodeEntities(head[2]!).replace(/\s+/g, ' ').trim(), price: amount, level: level[1]! };
}
const CATEGORIES = /var categoris = "([^"]+)"/;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k]!;
    if (!k.startsWith('#')) return m;
    const cp = k.startsWith('#x') ? parseInt(k.slice(2), 16) : Number(k.slice(1));
    // Only valid Unicode scalar values; anything else (too large, surrogates) stays as written.
    if (!Number.isSafeInteger(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
    return String.fromCodePoint(cp);
  });
}

function parsePrice(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

export function parseBidResult(input: string): BidResult {
  const html = input.length > MAX_RESULT_HTML ? input.slice(0, MAX_RESULT_HTML) : input;
  const bidders: BidResultBidder[] = [];
  for (const chunk of html.split(/<tr\b/i)) {
    const end = chunk.search(/<\/tr>/i);
    const b = parseRow(end < 0 ? chunk : chunk.slice(0, end));
    if (b) bidders.push(b);
  }
  const cat = CATEGORIES.exec(html);
  const categories = cat ? cat[1]!.split(',').map((c) => decodeEntities(c).trim()).filter(Boolean) : [];
  const l1 = bidders.filter((b) => b.level === 'L1').map((b) => b.price);
  return { categories, bidders, l1Price: l1.length ? Math.min(...l1) : null };
}
