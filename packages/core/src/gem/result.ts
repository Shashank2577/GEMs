/**
 * GeM bid-result view parser for results and competitor intelligence (spec 003 US6; FR-060, FR-064).
 *
 *   const r = parseBidResultHtml(html);
 *   // ok:   { ok: true, categories, bidders: [{ rank, seller, price, level, awarded }], winner, lowestPrice, anomalies }
 *   // fail: { ok: false, reason: 'not_published' | 'malformed' }
 *
 * Never throws: a page GeM has not published yet, an empty or oversized body (> MAX_RESULT_HTML_CHARS is refused as
 * `malformed`, never parsed as a prefix), or changed markup yields a typed failure the caller records without
 * touching stored data. Markup knowledge (bidder rows `td.productDtl` ->
 * seller span -> `span.bid_price` -> `<td><strong>L<n></strong>`, `var categoris`) comes from arush15june/gem-search
 * `get_bid_result` (MIT, see NOTICE); this module is a separate, stricter reader that keeps the seller as
 * `seller`, flags the awarded row, and works on one table row at a time so nothing can backtrack across rows.
 *
 * The "winner is not the lowest price" anomaly is an idea taken from IshanMaheshwari-777/GEM-SCRAPER (no licence,
 * ideas only, re-implemented here from the requirement; no code or text copied — see NOTICE).
 * Read-only: nothing here enters a price on GeM (Constitution I).
 */

/** GeM `b_buyer_status` values. */
export const BUYER_STATUS = {
  0: 'Not evaluated',
  1: 'Technical evaluated',
  2: 'Financial evaluated',
  3: 'Awarded',
} as const;
export type BuyerStatus = keyof typeof BUYER_STATUS;

/** Label for a `b_buyer_status` code; unknown codes read as "Not evaluated". */
export function buyerStatusLabel(code: unknown): (typeof BUYER_STATUS)[BuyerStatus] {
  const n = typeof code === 'string' ? Number(code) : code;
  return typeof n === 'number' && n in BUYER_STATUS ? BUYER_STATUS[n as BuyerStatus] : BUYER_STATUS[0];
}

export interface ResultBidder {
  /** Row number on the result page (1-based). */
  rank: number;
  seller: string;
  /** Total price quoted, in rupees. */
  price: number;
  /** GeM price level "L1" … "Ln". */
  level: string;
  /** True when the page marks this row as the award. */
  awarded: boolean;
}

export type ResultAnomalyCode = 'winner_not_lowest_price';
export interface ResultAnomaly { code: ResultAnomalyCode; message: string }

export type BidResultParse =
  | {
      ok: true;
      categories: string[];
      bidders: ResultBidder[];
      /** The marked awarded row, else the L1 row, else null. */
      winner: ResultBidder | null;
      /** Lowest price over all bidders. */
      lowestPrice: number;
      anomalies: ResultAnomaly[];
    }
  | { ok: false; reason: 'not_published' | 'malformed' };

export const MAX_RESULT_HTML_CHARS = 512 * 1024;
const MAX_ROW_CHARS = 16 * 1024;
const MAX_BIDDERS = 500;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', '#39': "'" };
function decode(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (k in ENTITIES) return ENTITIES[k]!;
      if (!k.startsWith('#')) return m;
      const cp = k.startsWith('#x') ? parseInt(k.slice(2), 16) : Number(k.slice(1));
      return Number.isSafeInteger(cp) && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const RANK = /<td class="productDtl">\s*(\d+)\s*<\/td>/;
const SELLER = /\s*<td[^>]*>\s*<span[^>]*>([^<]+)<\/span>/y;
const PRICE = /<span class="bid_price">\s*([\d,]+(?:\.\d+)?)\s*<\/span>/;
const LEVEL = /<td[^>]*>\s*<strong>\s*(L\d+)\s*<\/strong>/;
const AWARDED_CLASS = /^[^>]*\bclass\s*=\s*"[^"]*\b(?:awarded|winner)\b/i;
const CATEGORIES = /var\s+categoris\s*=\s*"([^"]*)"/;
const NOT_PUBLISHED = /not\s+(?:yet\s+)?(?:been\s+)?(?:published|available|declared)|yet\s+to\s+be\s+(?:published|declared)|result\s+(?:is\s+)?pending/i;

function parseRow(chunk: string): ResultBidder | null {
  if (chunk.length > MAX_ROW_CHARS) return null;
  const rank = RANK.exec(chunk);
  if (!rank) return null;
  SELLER.lastIndex = rank.index + rank[0].length;
  const seller = SELLER.exec(chunk);
  const rest = chunk.slice(rank.index + rank[0].length);
  const price = PRICE.exec(rest);
  const level = LEVEL.exec(rest);
  if (!seller || !price || !level) return null;
  const amount = Number(price[1]!.replace(/,/g, ''));
  const name = decode(seller[1]!);
  if (!Number.isFinite(amount) || amount <= 0 || !name) return null;
  return { rank: Number(rank[1]), seller: name, price: amount, level: level[1]!, awarded: AWARDED_CLASS.test(chunk) };
}

/** Flags worth a human look. Currently: the winner's price is above another bidder's price. */
export function detectAnomalies(bidders: ResultBidder[], winner: ResultBidder | null): ResultAnomaly[] {
  if (!winner || bidders.length < 2) return [];
  const lowest = Math.min(...bidders.map((b) => b.price));
  return winner.price > lowest
    ? [{ code: 'winner_not_lowest_price', message: 'Winner is not the lowest price' }]
    : [];
}

export function parseBidResultHtml(input: string): BidResultParse {
  try {
    if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'malformed' };
    // Never parse a prefix: a cut-off page would be stored as the complete bidder table (003/US6 scenario 6).
    if (input.length > MAX_RESULT_HTML_CHARS) return { ok: false, reason: 'malformed' };
    const html = input;
    const bidders: ResultBidder[] = [];
    for (const chunk of html.split(/<tr\b/i).slice(1)) {
      if (bidders.length >= MAX_BIDDERS) break;
      const end = chunk.search(/<\/tr>/i);
      const b = parseRow(end < 0 ? chunk : chunk.slice(0, end));
      if (b) bidders.push(b);
    }
    if (!bidders.length) {
      return { ok: false, reason: NOT_PUBLISHED.test(html) ? 'not_published' : 'malformed' };
    }
    const cat = CATEGORIES.exec(html);
    const categories = cat ? cat[1]!.split(',').map(decode).filter(Boolean) : [];
    const winner = bidders.find((b) => b.awarded) ?? bidders.find((b) => b.level === 'L1') ?? null;
    return {
      ok: true,
      categories,
      bidders,
      winner,
      lowestPrice: Math.min(...bidders.map((b) => b.price)),
      anomalies: detectAnomalies(bidders, winner),
    };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
