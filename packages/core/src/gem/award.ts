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

// Pattern: row number, company name, …, price, …, level  (gem.py get_bid_result, re.DOTALL)
const BIDDER_ROW =
  /<td class="productDtl">(\d+)<\/td>\s*<td><span[^>]*>\s*([^<]+)<\/span>[\s\S]*?<span class="bid_price">\s*([\d,.]+)<\/span>[\s\S]*?<td><strong>(L\d+)<\/strong>/g;
const CATEGORIES = /var categoris = "([^"]+)"/;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k]!;
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)));
    return m;
  });
}

function parsePrice(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

export function parseBidResult(html: string): BidResult {
  const bidders: BidResultBidder[] = [];
  for (const m of html.matchAll(BIDDER_ROW)) {
    const price = parsePrice(m[3]!);
    if (!Number.isFinite(price)) continue;
    bidders.push({ rank: Number(m[1]), company: decodeEntities(m[2]!).replace(/\s+/g, ' ').trim(), price, level: m[4]! });
  }
  const cat = CATEGORIES.exec(html);
  const categories = cat ? cat[1]!.split(',').map((c) => decodeEntities(c).trim()).filter(Boolean) : [];
  const l1 = bidders.filter((b) => b.level === 'L1').map((b) => b.price);
  return { categories, bidders, l1Price: l1.length ? Math.min(...l1) : null };
}
