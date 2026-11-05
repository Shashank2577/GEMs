/**
 * Normalisers for GeM BidPlus data (FR-001): Indian amounts (lakh / crore / Indian digit grouping),
 * IST timestamps, Solr single-element arrays, whitespace.
 *
 * Solr-unwrapping approach adapted from erenmyeager15/india-government-tenders-scraper
 * (Apache-2.0, https://github.com/erenmyeager15/india-government-tenders-scraper) — see NOTICE.
 */

/** IST is UTC+05:30 with no daylight saving. */
export const IST_OFFSET_MINUTES = 330;

/** BidPlus returns most fields as 1-element arrays (`{ b_bid_number: ["GEM/2026/B/123"] }`). */
export function unwrap(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

export function cleanText(value: unknown): string | null {
  const v = unwrap(value);
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s : null;
}

export function firstText(doc: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const s = cleanText(doc[k]);
    if (s) return s;
  }
  return null;
}

export function firstNumber(doc: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = unwrap(doc[k]);
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = Number.parseFloat(String(v).replace(/,/g, '').replace(/[^\d.+-]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function firstBool(doc: Record<string, unknown>, keys: string[]): boolean {
  for (const k of keys) {
    const v = unwrap(doc[k]);
    if (v === true || v === 1 || v === '1' || v === 'true' || v === 'Yes' || v === 'yes') return true;
  }
  return false;
}

const UNITS: [RegExp, number][] = [
  [/^(crores?|cr\.?|crs\.?)$/i, 1e7],
  [/^(lakhs?|lacs?|lakh|lac|l\.?|lks?)$/i, 1e5],
  [/^(thousands?|k)$/i, 1e3],
  [/^(millions?|mn|m)$/i, 1e6],
  [/^(billions?|bn)$/i, 1e9],
  [/^(hundreds?)$/i, 1e2],
];

/**
 * Parse an Indian-format amount into integer rupees.
 *   "₹ 5 Lakh" → 500000, "1.2 Crore" → 12000000, "12,34,567" → 1234567, "Rs. 25,000/-" → 25000,
 *   "INR 3.5 Cr" → 35000000, 150000 → 150000. Returns null when no number is present.
 */
export function parseAmount(input: unknown): number | null {
  const v = unwrap(input);
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  let s = String(v).trim();
  if (!s) return null;
  // Drop currency markers and trailing "/-".
  s = s.replace(/₹|\bINR\b|\bRs\.?|\brupees?\b/gi, ' ').replace(/\/-/g, ' ').trim();
  const m = s.match(/(-?\d[\d,]*(?:\.\d+)?)\s*([a-zA-Z.]+)?/);
  if (!m) return null;
  const num = Number.parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  let mult = 1;
  const unit = m[2]?.replace(/\.$/, '');
  if (unit) {
    const hit = UNITS.find(([re]) => re.test(unit));
    if (hit) mult = hit[1];
  }
  return Math.round(num * mult);
}

/**
 * Parse a GeM timestamp into a UTC Date.
 *
 * BidPlus' Solr `*_sort` fields look like ISO-8601 UTC ("2026-11-20T15:00:00Z") but carry the
 * **IST wall-clock** time (a bid closing at 3 PM IST is stored as `T15:00:00Z`). We therefore read
 * the wall-clock parts and subtract 5h30 (`assumeIstWallClock`, default true). Also handles
 * "20-11-2026 15:00:00" (bid documents) and "2026-11-20 15:00".
 */
export function parseGemDate(input: unknown, opts: { assumeIstWallClock?: boolean } = {}): Date | null {
  const v = unwrap(input);
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const ist = opts.assumeIstWallClock ?? true;

  let y: number, mo: number, d: number, h = 0, mi = 0, se = 0;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (m[4]) [h, mi, se] = [+m[4], +m[5], +(m[6] ?? 0)];
    const tz = m[7];
    // An explicit non-Z offset is authoritative.
    if (tz && tz !== 'Z') {
      const date = new Date(s.replace(' ', 'T'));
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (!ist && tz === 'Z') return new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  } else {
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
    if (!m) return null;
    [d, mo, y] = [+m[1], +m[2], +m[3]];
    if (m[4]) {
      [h, mi, se] = [+m[4], +m[5], +(m[6] ?? 0)];
      const ap = m[7]?.toUpperCase();
      if (ap === 'PM' && h < 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
    }
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, se) - IST_OFFSET_MINUTES * 60_000;
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Format a Date as the IST wall clock in GeM's Solr style ("YYYY-MM-DDTHH:mm:ssZ"). Used by fixtures/mock. */
export function toGemSolrDate(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60_000);
  return ist.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Format a Date as "DD-MM-YYYY HH:mm:ss" IST (GeM bid-document style). */
export function toGemDocDate(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(ist.getUTCDate())}-${p(ist.getUTCMonth() + 1)}-${ist.getUTCFullYear()} ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`;
}

/** Split a GeM item/category string ("Laptop - Notebook (Q2), Printer ...") into item names. */
export function splitItems(text: string | null): string[] {
  if (!text) return [];
  return text
    .split(/\s*(?:,(?![^()]*\))|;|\|)\s*/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 1)
    .slice(0, 50);
}

/** Make an all-caps / oddly-cased GeM title readable without destroying acronyms. */
export function tidyTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const letters = t.replace(/[^A-Za-z]/g, '');
  const upper = letters.replace(/[^A-Z]/g, '').length;
  if (letters.length > 12 && upper / letters.length > 0.85) {
    return t.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  }
  return t;
}
