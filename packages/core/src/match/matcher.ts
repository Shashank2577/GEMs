/**
 * Watchlist matcher (FR-004). Pure: given a tender and a watchlist's criteria, decide whether it
 * matches, why (human-readable reasons shown as chips in the feed), and how relevant it is (0..1).
 *
 * Semantics — every *configured* dimension must pass (AND across dimensions, OR within one):
 *   keywords        any keyword, word-boundary, case-insensitive, in title / items / category / buyer
 *   excludeKeywords none may appear (same haystack) → no match
 *   categories      tender category / items contain any (case-insensitive substring)
 *   hsnCodes        any tender HSN code starts with a watched code (4-digit heading matches 8-digit)
 *   states          tender state is one of them
 *   ministries      ministry, department or organisation contains any (substring)
 *   minValue/maxValue  estimated value in range (tenders with unknown value pass, flagged)
 *   minDaysToClose  at least N days left before end date
 *   bidTypes        tender bid type in list
 * A watchlist with no positive criteria at all matches nothing (avoids "alert on everything").
 */

export interface MatchCriteria {
  keywords?: string[];
  excludeKeywords?: string[];
  categories?: string[];
  hsnCodes?: string[];
  states?: string[];
  ministries?: string[];
  minValue?: number | null;
  maxValue?: number | null;
  minDaysToClose?: number | null;
  bidTypes?: string[];
}

export interface MatchableTender {
  title: string;
  items?: { name: string }[] | null;
  category?: string | null;
  ministry?: string | null;
  department?: string | null;
  organisation?: string | null;
  buyerOffice?: string | null;
  state?: string | null;
  hsnCodes?: string[] | null;
  estimatedValue?: number | null;
  endAt?: Date | string | null;
  bidType?: string | null;
  status?: string | null;
}

export interface MatchResult {
  matched: boolean;
  reasons: string[];
  /** 0..1 — more matched keywords / dimensions / title hits ⇒ higher. */
  relevance: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clean = (xs: string[] | undefined | null) => (xs ?? []).map((x) => x.trim()).filter(Boolean);

/** Word-boundary, case-insensitive regex for a keyword/phrase (handles "CCTV", "A4 paper", "UPS-1kVA"). */
export function keywordRegex(keyword: string): RegExp {
  let re = regexCache.get(keyword);
  if (!re) {
    re = buildKeywordRegex(keyword);
    if (regexCache.size >= 1000) regexCache.clear(); // bounded: criteria sets are small, tenders many
    regexCache.set(keyword, re);
  }
  return re;
}

/** Compiled keyword regexes (no `g` flag, so `test()` is stateless and safe to share). */
const regexCache = new Map<string, RegExp>();

function buildKeywordRegex(keyword: string): RegExp {
  const parts = keyword.trim().split(/\s+/).map(escapeRe);
  // Allow simple plurals on the last word ("laptop" matches "Laptops").
  const body = parts.join('[\\s\\-_/]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:e?s)?(?![\\p{L}\\p{N}])`, 'iu');
}

function haystacks(t: MatchableTender) {
  // `items` is jsonb: tolerate a non-array value or malformed entries in stored data rather than throwing.
  const items = (Array.isArray(t.items) ? t.items : []).map((i) => i?.name ?? '').filter(Boolean).join(' · ');
  return {
    title: t.title ?? '',
    other: [items, t.category ?? ''].join(' · '),
    buyer: [t.ministry, t.department, t.organisation, t.buyerOffice].filter(Boolean).join(' · '),
  };
}

export function daysToClose(endAt: Date | string | null | undefined, now: Date): number | null {
  if (!endAt) return null;
  const end = typeof endAt === 'string' ? new Date(endAt) : endAt;
  if (Number.isNaN(end.getTime())) return null;
  return (end.getTime() - now.getTime()) / 86_400_000;
}

export function hasPositiveCriteria(c: MatchCriteria): boolean {
  return (
    clean(c.keywords).length > 0 || clean(c.categories).length > 0 || clean(c.hsnCodes).length > 0
    || clean(c.states).length > 0 || clean(c.ministries).length > 0 || c.minValue != null || c.maxValue != null
    || (c.bidTypes?.length ?? 0) > 0
  );
}

const shortINR = (n: number) =>
  n >= 1e7 ? `₹${+(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${+(n / 1e5).toFixed(2)} L` : `₹${n.toLocaleString('en-IN')}`;

/**
 * A watchlist's criteria with every regex built and every string normalised ONCE (008/FR-074). Matching N tenders
 * against M watchlists compiles M times, not N × M: callers compile per run (`compileCriteria`) and reuse the result.
 */
export interface CompiledCriteria {
  readonly compiled: true;
  positive: boolean;
  keywords: { keyword: string; re: RegExp }[];
  exclude: RegExp[];
  categories: { value: string; lower: string }[];
  hsn: string[];
  states: string[];
  ministries: { value: string; lower: string }[];
  minValue: number | null;
  maxValue: number | null;
  minDaysToClose: number | null;
  bidTypes: string[];
}

export function compileCriteria(c: MatchCriteria): CompiledCriteria {
  const lowered = (xs: string[] | undefined) => clean(xs).map((value) => ({ value, lower: value.toLowerCase() }));
  return {
    compiled: true,
    positive: hasPositiveCriteria(c),
    keywords: clean(c.keywords).map((keyword) => ({ keyword, re: buildKeywordRegex(keyword) })),
    exclude: clean(c.excludeKeywords).map(buildKeywordRegex),
    categories: lowered(c.categories),
    hsn: clean(c.hsnCodes).map((x) => x.replace(/\D/g, '')).filter(Boolean),
    states: clean(c.states).map((x) => x.toLowerCase()),
    ministries: lowered(c.ministries),
    minValue: c.minValue ?? null,
    maxValue: c.maxValue ?? null,
    minDaysToClose: c.minDaysToClose ?? null,
    bidTypes: (c.bidTypes ?? []).filter(Boolean),
  };
}

const isCompiled = (c: MatchCriteria | CompiledCriteria): c is CompiledCriteria => (c as CompiledCriteria).compiled === true;

/** Match one tender. Pass `compileCriteria(criteria)` when matching many tenders against the same watchlist. */
export function matchTender(tender: MatchableTender, criteria: MatchCriteria | CompiledCriteria, opts: { now?: Date } = {}): MatchResult {
  const c = isCompiled(criteria) ? criteria : compileCriteria(criteria);
  const now = opts.now ?? new Date();
  const no: MatchResult = { matched: false, reasons: [], relevance: 0 };
  if (!c.positive) return no;
  const reasons: string[] = [];
  let score = 0;
  let dims = 0;
  const h = haystacks(tender);
  const all = `${h.title} · ${h.other} · ${h.buyer}`;

  // Exclusions first (cheap reject).
  for (const re of c.exclude) if (re.test(all)) return no;

  if (c.keywords.length) {
    dims++;
    const hits: string[] = [];
    let titleHits = 0;
    for (const { keyword, re } of c.keywords) {
      if (re.test(h.title)) { hits.push(keyword); titleHits++; } else if (re.test(h.other) || re.test(h.buyer)) hits.push(keyword);
    }
    if (!hits.length) return no;
    reasons.push(...hits.map((k) => `Keyword “${k}”`));
    score += 0.45 * Math.min(1, hits.length / Math.min(c.keywords.length, 3)) + (titleHits ? 0.15 : 0);
  }

  if (c.categories.length) {
    dims++;
    const text = `${tender.category ?? ''} · ${h.other} · ${h.title}`.toLowerCase();
    const hit = c.categories.find((x) => text.includes(x.lower));
    if (!hit) return no;
    reasons.push(`Category: ${hit.value}`);
    score += 0.15;
  }

  if (c.hsn.length) {
    dims++;
    const codes = tender.hsnCodes ?? [];
    const hit = c.hsn.find((w) => codes.some((x) => x.startsWith(w) || w.startsWith(x)));
    if (!hit) return no;
    reasons.push(`HSN ${hit}`);
    score += 0.15;
  }

  if (c.states.length) {
    dims++;
    if (!tender.state || !c.states.includes(tender.state.toLowerCase())) return no;
    reasons.push(`State: ${tender.state}`);
    score += 0.1;
  }

  if (c.ministries.length) {
    dims++;
    const buyer = h.buyer.toLowerCase();
    const hit = c.ministries.find((m) => buyer.includes(m.lower));
    if (!hit) return no;
    reasons.push(`Buyer: ${hit.value}`);
    score += 0.1;
  }

  if (c.minValue != null || c.maxValue != null) {
    dims++;
    const v = tender.estimatedValue;
    if (v != null) {
      if (c.minValue != null && v < c.minValue) return no;
      if (c.maxValue != null && v > c.maxValue) return no;
      reasons.push(`Value ${shortINR(v)}`);
      score += 0.05;
    } else {
      // Unknown value: don't drop a potentially relevant bid; say so.
      reasons.push('Value not published');
    }
  }

  if (c.minDaysToClose != null && c.minDaysToClose > 0) {
    const d = daysToClose(tender.endAt, now);
    if (d === null || d < c.minDaysToClose) return no;
  }

  if (c.bidTypes.length) {
    dims++;
    if (!tender.bidType || !c.bidTypes.includes(tender.bidType)) return no;
    score += 0.02;
  }

  // Closed / cancelled bids are never alert-worthy.
  if (tender.status && tender.status !== 'open') return no;
  const d = daysToClose(tender.endAt, now);
  if (d !== null && d < 0) return no;

  const breadth = Math.min(1, dims / 4) * 0.1;
  const relevance = Math.max(0.05, Math.min(1, score + breadth));
  return { matched: true, reasons, relevance: Math.round(relevance * 100) / 100 };
}

/** Match a tender against many watchlists → only the hits. */
export function matchWatchlists<W extends { id: string; criteria: MatchCriteria }>(
  tender: MatchableTender, watchlists: W[], opts: { now?: Date } = {},
): { watchlist: W; result: MatchResult }[] {
  const out: { watchlist: W; result: MatchResult }[] = [];
  for (const w of watchlists) {
    const result = matchTender(tender, compileCriteria(w.criteria), opts);
    if (result.matched) out.push({ watchlist: w, result });
  }
  return out;
}
