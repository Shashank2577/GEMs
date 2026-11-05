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
 *
 * `parseAwardResult` (T092; 006/FR-085) is the second, looser reader: it takes any saved GeM RA / bid-result
 * page and finds the rank/price evaluation table by its header words. Ported from `scrape_ra_schedule()` in
 * IshanMaheshwari-777/GEM-SCRAPER (scraper.py). That repository publishes no licence file; the heuristics were
 * ported with the repo owner's approval (docs/delivery/TEAM_PLAYBOOK.md reference-scrapers list; plan.md T092),
 * not under any licence — see NOTICE. Differences from upstream: the rank cell is never used as the price,
 * amount cells are never used as seller names, rows without a price are skipped, and the first winner-marked
 * row is taken (upstream keeps the last). Columns are taken from the header words when present, positionally otherwise.
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

// ───────────── parseAwardResult (006/FR-085) ─────────────

export interface AwardBidder {
  /** Rank from the table ("L1" / "1" → 1); 0 when the table has no rank column. */
  rank: number;
  name: string;
  /** Quoted price in rupees (> 0). */
  price: number;
}

export interface AwardResult {
  /** Price of the winning / first-ranked row, in rupees. */
  l1Price: number;
  l1Seller: string;
  bidders: AwardBidder[];
}

// scrape_ra_schedule(): a table is the financial / evaluation table when its first row mentions one of these.
const FINANCIAL_HEADER = ['rank', 'price', 'l1', 'financial', 'amount', 'total'];
// ...and a row is the winner's when its markup carries one of these (fa-trophy, "winner", 🏆).
const WINNER_MARK = ['trophy', 'winner', '🏆'];
const MAX_CELL_LENGTH = 2 * 1024;
/** Amounts above this (1e13 rupees, the API's own cap) are not prices. */
const MAX_AMOUNT = 1e13;

/** Cell text as BeautifulSoup `get_text(strip=True)` would give it (tags dropped, entities decoded, spaces collapsed). */
function cellText(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Cells of one `<tr>` chunk, found with indexOf so no pattern can backtrack on hostile markup. Linear: the next
 * `<td` / `<th` positions are cached and only re-searched once passed (-1 = none left, never searched again).
 */
function cellsOf(row: string): string[] {
  const lower = row.toLowerCase();
  const out: string[] = [];
  let i = 0;
  let nextTd = -2; // -2 = not searched yet, -1 = none left
  let nextTh = -2;
  for (;;) {
    if (nextTd !== -1 && nextTd < i) nextTd = lower.indexOf('<td', i);
    if (nextTh !== -1 && nextTh < i) nextTh = lower.indexOf('<th', i);
    const start = nextTd < 0 ? nextTh : nextTh < 0 ? nextTd : Math.min(nextTd, nextTh);
    if (start < 0) break;
    const open = lower.charAt(start + 3);
    const gt = lower.indexOf('>', start);
    if (gt < 0) break;
    if (open !== '>' && open !== ' ' && open !== '\t' && open !== '\n' && open !== '\r' && open !== '/') { i = start + 3; continue; }
    const close = lower.indexOf('</t', gt);
    const end = close < 0 ? lower.length : close;
    const inner = row.slice(gt + 1, end);
    out.push(inner.length > MAX_CELL_LENGTH ? '' : cellText(inner));
    i = end + 1;
  }
  return out;
}

/** "₹ 29,50,000.00", "Rs. 2950000", "INR 29,50,000" → rupees; null when the cell is not a plain positive amount. */
function parseAmount(cell: string): number | null {
  const cleaned = cell.replace(/,/g, '').trim().replace(/^(?:₹|INR|Rs\.?)\s*/i, '').replace(/\s*(?:₹|INR|Rs\.?)$/i, '').trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 && n <= MAX_AMOUNT ? n : null;
}

/** "Acme Traders (Pvt Ltd Seller ID 123)" → "Acme Traders" (strip_portal_tags: one trailing parenthesis). */
const stripPortalTags = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim();

/**
 * Reads the rank/price evaluation table of a public GeM RA / bid-result page the user saved as HTML.
 * Pure and DOM-free; returns null when no table with a priced seller row is found.
 */
export function parseAwardResult(input: string): AwardResult | null {
  const html = input.length > MAX_RESULT_HTML ? input.slice(0, MAX_RESULT_HTML) : input;
  const bidders: (AwardBidder & { winner: boolean })[] = [];
  for (const table of html.split(/<table\b/i).slice(1)) {
    const body = table.split(/<\/table>/i)[0]!;
    const rows = body.split(/<tr\b/i).slice(1).map((r) => r.split(/<\/tr>/i)[0]!);
    if (rows.length < 2) continue;
    if (rows[0]!.length > MAX_ROW_LENGTH) continue;
    const headerCells = cellsOf(rows[0]!).map((c) => c.toLowerCase());
    const header = headerCells.join(' ');
    if (!FINANCIAL_HEADER.some((k) => header.includes(k))) continue;
    // Header-driven columns (when the header names them); anything not named falls back to the positional rules.
    const rankCol = headerCells.findIndex((h) => h.includes('rank') || /\bl1\b/.test(h));
    const priceCol = headerCells.findIndex((h) => h.includes('price') || h.includes('amount') || h.includes('total'));
    for (const row of rows.slice(1)) {
      if (row.length > MAX_ROW_LENGTH) continue;
      const cells = cellsOf(row);
      if (cells.length < 2) continue;
      const lowerRow = row.toLowerCase();
      let rank = '';
      let name = '';
      let rankAt = -1;
      const isRank = (ct: string) => /^l?\d{1,3}$/i.test(ct);
      if (rankCol >= 0 && rankCol < cells.length && isRank(cells[rankCol]!)) { rank = cells[rankCol]!.replace(/^l/i, ''); rankAt = rankCol; }
      let price: number | null = priceCol >= 0 && priceCol < cells.length && priceCol !== rankAt ? parseAmount(cells[priceCol]!) : null;
      cells.forEach((ct, i) => {
        if (!rank && i !== priceCol && isRank(ct)) { rank = ct.replace(/^l/i, ''); rankAt = i; }
        else if (!name && i !== rankAt && ct.length > 2 && !/^\d+$/.test(ct) && parseAmount(ct) === null) name = stripPortalTags(ct);
      });
      // Price fallback: the last numeric cell (never the rank cell).
      for (let i = cells.length - 1; i >= 0 && price === null; i--) if (i !== rankAt) price = parseAmount(cells[i]!);
      if (!name || price === null) continue;
      bidders.push({ rank: rank ? Number(rank) : 0, name, price, winner: WINNER_MARK.some((m) => lowerRow.includes(m)) });
    }
  }
  if (!bidders.length) return null;
  const win = bidders.find((b) => b.winner) ?? bidders.find((b) => b.rank === 1) ?? bidders[0]!;
  return { l1Price: win.price, l1Seller: win.name, bidders: bidders.map(({ rank, name, price }) => ({ rank, name, price })) };
}
