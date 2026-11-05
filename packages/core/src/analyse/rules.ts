/**
 * Deterministic requirement extractor for GeM bid documents (T042, FR-011, FR-012, Constitution III).
 *
 * Works on the per-page text from `extractPages()`. Each page is flattened (Devanagari removed — GeM
 * labels are bilingual, e.g. "बोली समाप्ति तिथि/समय/Bid End Date/Time" — and whitespace collapsed), then
 * every known "Bid Details" label is located. A label's value is the text between the end of the label
 * and the start of the next known label, which makes the extractor robust to labels that wrap over
 * two lines (pdf text then interleaves the value inside the label) and to arbitrary spacing.
 * ATC (Additional Terms & Conditions) clauses are scanned with targeted patterns (similar work,
 * certificates, OEM authorisation, non-blacklisting).
 *
 * Every requirement carries provenance: page, quote, method RULE and a confidence.
 */
import type { Requirement } from './types';
import { groupIN } from './format';

export interface RuleMeta {
  documentId?: string;
  fileName?: string;
  /** Estimated bid value from the listing; used to turn "40% of estimated value" into rupees. */
  estimatedValue?: number | null;
}

/** Requirement keys that may appear more than once. */
export const MULTI_KEYS = new Set(['document', 'certificate', 'undertaking', 'other']);

// ───────────── Normalisation ─────────────

/** Remove Devanagari (and joiners), normalise dashes/quotes, collapse whitespace. */
export function flattenText(text: string): string {
  return text
    .replace(/[\u0900-\u097F\u200B-\u200D\uFEFF]+/g, ' ')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00A0/g, ' ')
    .replace(/\s*\/\s*(?=\/)/g, '') // "/ /" leftovers from removed Hindi
    .replace(/\(\s*\)/g, ' ') // "( )" leftovers from removed Hindi in parentheses
    .replace(/\s+/g, ' ')
    .trim();
}

const UNIT_RE = '(crores?|cr\\.?|crs|lakhs?|lacs?|lakh|lac|thousands?)';

function unitMultiplier(unit: string | undefined): number {
  if (!unit) return 1;
  const u = unit.toLowerCase().replace(/\.$/, '');
  if (u.startsWith('cr')) return 1e7;
  if (u.startsWith('la')) return 1e5;
  if (u.startsWith('th')) return 1e3;
  return 1;
}

/** "50 Lakh (s)" → 5000000, "1.5 Crore (s)" → 15000000, "96,000" → 96000, "Rs. 2,50,000/-" → 250000. */
export function parseIndianAmount(s: string): number | null {
  const withUnit = s.match(new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*${UNIT_RE}\\b`, 'i'));
  const plain = s.match(/(?:₹|Rs\.?|INR)?\s*(\d[\d,]*(?:\.\d+)?)/i);
  // The first amount wins: "39,00,000 … 1.2 Crore" is 39 lakh, not 1.2 crore.
  if (withUnit && (!plain || withUnit.index! <= plain.index! + plain[0].length - plain[1].length)) {
    const n = Number.parseFloat(withUnit[1].replace(/,/g, ''));
    if (Number.isFinite(n)) return Math.round(n * unitMultiplier(withUnit[2]));
  }
  if (!plain) return null;
  const n = Number.parseFloat(plain[1].replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** "28-11-2026 15:00:00" (IST) → "2026-11-28T15:00:00+05:30". */
export function parseGemDateTime(s: string): string | null {
  const m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, d, mo, y, h = '00', mi = '00', se = '00'] = m;
  const p = (x: string) => x.padStart(2, '0');
  const iso = `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(se)}+05:30`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// ───────────── Label table ─────────────

type Parsed = { value: Requirement['value']; numeric?: number | null } | null;

interface LabelDef {
  key: string;
  label: string;
  re: RegExp;
  parse?: (v: string) => Parsed;
  mandatory: boolean;
  /** Boundary-only labels are used to delimit values but produce no requirement. */
  boundaryOnly?: boolean;
  /** Only read on page 1 (header fields such as "Dated:"). */
  firstPageOnly?: boolean;
  /**
   * Rest of a long label after the head matched by `re`. When the label wraps, pdf text may put the value
   * inside it ("Minimum Average 1.2 Crore (s) Annual Turnover of the bidder"); see `matchTail`.
   */
  tail?: string;
  /** Letters/digits of the tail that must be present for the hit to count (0 = head alone is enough). */
  minTail?: number;
}

const alnum = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Match the tail of a wrapped label after its head, allowing one gap of up to six tokens (the value
 * interleaved by the wrap). Tokens are compared on letters/digits only, so "same/ similar" and
 * "(For 3 Years)" match however they were broken. Returns where the label ends and the gap, or null
 * when less than `minTail` characters of the tail were found.
 */
function matchTail(flat: string, from: number, tail: string, minTail: number): { end: number; gap: [number, number] | null } | null {
  let rest = alnum(tail);
  const tokens = [...flat.slice(from, from + 400).matchAll(/\S+/g)].map((m) => ({ s: from + m.index, e: from + m.index + m[0].length, a: alnum(m[0]) }));
  const consume = (i: number): { i: number; n: number; end: number } => {
    let n = 0;
    let end = -1;
    while (i < tokens.length && rest) {
      const a = tokens[i].a;
      if (a && !rest.startsWith(a)) break;
      if (!a && n === 0) break; // a gap may not start the consumed run with bare punctuation
      rest = rest.slice(a.length);
      n += a.length;
      end = tokens[i].e;
      i++;
    }
    return { i, n, end };
  };
  const total = rest.length;
  const pre = consume(0);
  let end = pre.end >= 0 ? pre.end : from;
  let gap: [number, number] | null = null;
  if (rest && pre.i < tokens.length) {
    for (let g = pre.i + 1; g <= Math.min(tokens.length - 1, pre.i + 6); g++) {
      const saved = rest;
      const post = consume(g);
      if (post.n >= Math.min(6, saved.length)) {
        gap = [tokens[pre.i].s, tokens[g - 1].e];
        end = post.end;
        break;
      }
      rest = saved;
    }
  }
  return total - rest.length >= minTail ? { end, gap } : null;
}

/** "Yes", "No", and the newer GeM forms "Yes | Complete" / "No | Complete" (FR-018). */
const yesNo = (v: string): Parsed => {
  const m = v.match(/\b(yes|no)\b(?:\s*\|\s*complete\b)?/i);
  return m ? { value: m[1].toLowerCase() === 'yes', numeric: null } : null;
};
const amount = (v: string): Parsed => {
  const cleaned = v
    .replace(/\(\s*For\s+\d+\s+Years?\s*\)/gi, ' ')
    .replace(/\(\s*(?:For|Last)\s+\d+/gi, ' ')
    .replace(/\bYears?\s*\)/gi, ' ');
  const n = parseIndianAmount(cleaned);
  if (n == null) return null;
  const raw = cleaned.match(new RegExp(`\\d[\\d,]*(?:\\.\\d+)?\\s*(?:${UNIT_RE}\\b(?:\\s*\\(s\\))?)?`, 'i'))?.[0]?.trim();
  return { value: raw ?? String(n), numeric: n };
};
const yearsP = (v: string): Parsed => {
  const m = v.match(/(\d+(?:\.\d+)?)\s*Years?\b/i) ?? v.match(/^\s*(\d+(?:\.\d+)?)\b/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return { value: `${n} ${n === 1 ? 'year' : 'years'}`, numeric: n };
};
const daysP = (v: string): Parsed => {
  const m = v.match(/(\d+)\s*(?:\(?\s*Days?\s*\)?)?/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return { value: `${n} days`, numeric: n };
};
/**
 * Delivery days, either a plain "30" / "30 (Days)" or, in GeM's consignee table, the last column of the
 * first consignee row ("1 Anil Kumar 110001,ABC Bhawan, New Delhi 25 30" → 30). A table row whose
 * columns cannot be told apart yields nothing rather than the S.No.
 */
const deliveryP = (v: string): Parsed => {
  const s = v.replace(/^[\s:/|-]+/, '');
  if (/^1\s+[^\d\s(]/.test(s)) {
    const row = s.split(/\s(?=2\s+[^\d\s(])/)[0].replace(/[\s:/|-]+$/, '');
    const m = row.match(/\s(\d[\d,]*(?:\.\d+)?)\s+(\d{1,4})$/);
    if (!m) return null;
    const n = Number.parseInt(m[2], 10);
    return { value: `${n} days`, numeric: n };
  }
  return daysP(s);
};
/** "2 Year(s)", "1 Year(s) 6 Month(s)", "90 Day(s)" → total months (FR-019). */
const contractP = (v: string): Parsed => {
  const m = v.match(/^[\s:/|-]*((?:\d+(?:\.\d+)?\s*(?:Years?|Months?|Days?)\s*(?:\(\s*s\s*\))?[\s,]*(?:and\s+)?)+)/i);
  if (!m) return null;
  let months = 0;
  const parts: string[] = [];
  for (const [, num, unit] of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(Year|Month|Day)/gi)) {
    const n = Number.parseFloat(num);
    if (!n) continue;
    const u = unit.toLowerCase();
    months += u === 'year' ? n * 12 : u === 'month' ? n : n / 30;
    parts.push(`${n} ${u}${n === 1 ? '' : 's'}`);
  }
  if (!parts.length) return null;
  return { value: parts.join(' '), numeric: Math.round(months * 10) / 10 };
};
const monthsP = (v: string): Parsed => {
  const m = v.match(/(\d+)/);
  return m ? { value: `${m[1]} months`, numeric: Number.parseInt(m[1], 10) } : null;
};
const pctP = (v: string): Parsed => {
  const m = v.match(/(\d+(?:\.\d+)?)\s*%?/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return { value: `${n}%`, numeric: n };
};
const intP = (v: string): Parsed => {
  const m = v.match(/(\d[\d,]*)/);
  if (!m) return null;
  const n = Number.parseInt(m[1].replace(/,/g, ''), 10);
  return { value: n, numeric: n };
};
const textP = (v: string): Parsed => {
  const t = v.replace(/^[\s:/|-]+|[\s:/|-]+$/g, '').trim();
  return t && t.length <= 240 ? { value: t, numeric: null } : null;
};
const dateP = (v: string): Parsed => {
  const iso = parseGemDateTime(v);
  return iso ? { value: iso, numeric: null } : null;
};

const L = (s: string) => new RegExp(s.replace(/ /g, '\\s*'), 'gi');

const LABELS: LabelDef[] = [
  // Header "Dated: dd-mm-yyyy" (case-sensitive, page 1 only: prose says "dated 23.03.2012").
  { key: 'bid_published_at', label: 'Bid published on', re: /\bDated\s*:/g, parse: dateP, mandatory: false, firstPageOnly: true },
  { key: 'bid_end', label: 'Bid end date', re: L('Bid End Date ?/ ?Time'), parse: dateP, mandatory: false },
  { key: 'bid_opening', label: 'Bid opening date', re: L('Bid Opening Date ?/ ?Time'), parse: dateP, mandatory: false },
  { key: 'offer_validity', label: 'Bid offer validity', re: L('Bid Offer'), tail: 'Validity (From End Date)', minTail: 8, parse: daysP, mandatory: false },
  { key: 'ministry', label: 'Ministry / State', re: L('Ministry ?/ ?State Name'), parse: textP, mandatory: false },
  { key: 'department', label: 'Department', re: L('Department Name'), parse: textP, mandatory: false },
  { key: 'organisation', label: 'Organisation', re: L('Organi[sz]ation Name'), parse: textP, mandatory: false },
  { key: 'office', label: 'Office', re: L('Office Name'), parse: textP, mandatory: false },
  { key: 'total_quantity', label: 'Total quantity', re: L('Total Quantity'), parse: intP, mandatory: false },
  { key: 'item_category', label: 'Item category', re: L('Item Category'), parse: textP, mandatory: false },
  // Service bids; case-sensitive so ATC prose ("during the contract period") is not read as the label.
  { key: 'contract_period', label: 'Contract period', re: /\bContract\s*Period\b/g, parse: contractP, mandatory: false },
  { key: 'estimated_value', label: 'Estimated bid value', re: L('Estimated Bid Value'), parse: amount, mandatory: false },
  { key: 'turnover_min', label: 'Minimum average annual turnover (bidder)', re: L('Minimum Average'), tail: 'Annual Turnover of the bidder (For 3 Years)', minTail: 14, parse: amount, mandatory: true },
  { key: 'oem_turnover', label: 'OEM average annual turnover', re: L('OEM Average'), tail: 'Turnover (Last 3 Years)', minTail: 8, parse: amount, mandatory: true },
  { key: 'experience_years', label: 'Years of past experience', re: L('Years of Past'), tail: 'Experience Required for same/similar service', minTail: 18, parse: yearsP, mandatory: true },
  { key: 'past_performance', label: 'Past performance', re: L('Past Performance'), parse: pctP, mandatory: true },
  { key: 'mse_exemption', label: 'MSE exemption (experience & turnover)', re: L('MSE (Exemption|Relaxation)'), tail: 'for Years Of Experience and Turnover', minTail: 8, parse: yesNo, mandatory: false },
  { key: 'startup_exemption', label: 'Startup exemption (experience & turnover)', re: L('Startup (Exemption|Relaxation)'), tail: 'for Years Of Experience and Turnover', minTail: 8, parse: yesNo, mandatory: false },
  { key: 'documents_required', label: 'Documents required from seller', re: L('Document(s)? required from seller'), parse: textP, mandatory: true },
  { key: 'bid_to_ra', label: 'Bid to reverse auction', re: L('Bid to RA enabled'), parse: yesNo, mandatory: false },
  { key: 'bid_type', label: 'Type of bid', re: L('Type of Bid'), parse: textP, mandatory: false },
  { key: 'evaluation_method', label: 'Evaluation method', re: L('Evaluation Method'), parse: textP, mandatory: false },
  { key: 'emd', label: 'EMD amount', re: L('EMD Amount'), parse: amount, mandatory: true },
  { key: 'epbg', label: 'ePBG percentage', re: L('ePBG Percentage ?\\(%\\)'), parse: pctP, mandatory: false },
  { key: 'epbg_duration', label: 'ePBG duration', re: L('Duration of ePBG required ?\\(Months\\)\\.?'), parse: monthsP, mandatory: false },
  { key: 'mii', label: 'Make in India (MII) compliance', re: L('MII (Compliance|Purchase Preference)'), parse: yesNo, mandatory: true },
  { key: 'mse_purchase_preference', label: 'MSE purchase preference', re: L('MSE Purchase Preference'), parse: yesNo, mandatory: false },
  { key: 'delivery_days', label: 'Delivery period', re: L('Delivery (Days|Period)( \\(in days\\))?'), parse: deliveryP, mandatory: true },
  // Boundaries only
  { key: '_', label: '', re: L('Advisory Bank'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: /\bTime\b/g, tail: 'allowed for Technical Clarifications during technical evaluation', minTail: 19, mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('EMD Detail'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('ePBG Detail'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('\\(a\\)\\. EMD EXEMPTION'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Splitting'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Bid splitting'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Consignees? ?/ ?Reporting Officer'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Technical Specifications'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Buyer Added Bid Specific'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('\\d\\. Preference to Make In India'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('\\d\\. Purchase preference to Micro'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('S\\.No\\.'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Address'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: /\bQuantity\b(?=\s+\d)/gi, mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: /\*\s*In case any bidder/gi, mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: /\bGEM\/\d{4}\/[A-Z]\/\d+\s*[|/]\s*Page\s*\d+/gi, mandatory: false, boundaryOnly: true },
  // Other GeM "Bid Details" rows and page furniture we do not extract, so values stop before them.
  { key: '_', label: '', re: /\bBid Number\b/g, mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: /\bPage\s*\d+\s*(?:of|\/)\s*\d+\b/gi, mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Primary product category'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Similar Category'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Inspection Required'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Do you want to show documents'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('RA Qualification Rule'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Arbitration Clause'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Mediation Clause'), mandatory: false, boundaryOnly: true },
];

interface Hit { def: LabelDef; start: number; end: number; gap: [number, number] | null }

function findHits(flat: string): Hit[] {
  const hits: Hit[] = [];
  for (const def of LABELS) {
    def.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = def.re.exec(flat))) {
      const end = m.index + m[0].length;
      if (m[0].length === 0) def.re.lastIndex++;
      if (def.tail) {
        const t = matchTail(flat, end, def.tail, def.minTail ?? 0);
        if (t) hits.push({ def, start: m.index, end: t.end, gap: t.gap });
      } else hits.push({ def, start: m.index, end, gap: null });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  // Drop hits contained in a longer earlier hit (e.g. "Quantity" inside "Total Quantity").
  const out: Hit[] = [];
  for (const h of hits) {
    const prev = out[out.length - 1];
    if (prev && h.start >= prev.start && h.end <= prev.end) continue;
    out.push(h);
  }
  return out;
}

function clip(s: string, max = 220): string {
  // Trailing "/" is what remains of the next row's stripped Hindi label.
  const t = s.trim().replace(/[\s/|]+$/, '');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Split the "Document required from seller" value into individual documents. */
export function splitDocumentList(v: string): string[] {
  const head = v.split(/\*\s*In case/i)[0];
  return head
    .split(/,(?![^(]*\))/)
    .map((s) => s.replace(/\s+/g, ' ').replace(/^[\s:/-]+|[\s.:/-]+$/g, '').trim())
    .filter((s) => s.length > 1 && s.length < 120);
}

// ───────────── ATC patterns ─────────────

const CERT_PATTERNS: { re: RegExp; name: (m: RegExpMatchArray) => string }[] = [
  { re: /\bISO\s*[-/]?\s*(9001|14001|27001|45001|20000(?:-1)?|22000|13485|50001)(?:\s*:\s*\d{4})?/gi, name: (m) => `ISO ${m[1]}` },
  { re: /\bBIS\b(?:\s+(?:registration|certificat(?:e|ion)|licen[cs]e|mark))?/gi, name: () => 'BIS' },
  { re: /\bCMMI\s*(?:Level|L)?\s*-?\s*(\d)/gi, name: (m) => `CMMI Level ${m[1]}` },
  { re: /\bNABL\b/gi, name: () => 'NABL' },
  { re: /\bSTQC\b/gi, name: () => 'STQC' },
  { re: /\bPSARA\b/gi, name: () => 'PSARA licence' },
];

function sentenceAround(flat: string, idx: number, len: number): string {
  const startCut = Math.max(flat.lastIndexOf('. ', idx), flat.lastIndexOf(': ', idx - 1));
  const start = startCut >= 0 && idx - startCut < 260 ? startCut + 2 : Math.max(0, idx - 120);
  const endDot = flat.indexOf('. ', idx + len);
  const end = endDot >= 0 && endDot - idx < 320 ? endDot + 1 : Math.min(flat.length, idx + len + 160);
  return clip(flat.slice(start, end), 260);
}

// ───────────── Consignee state (FR-019) ─────────────

/**
 * States and union territories of India. List ported from erenmyeager15/india-government-tenders-scraper
 * `src/routes.ts` INDIAN_STATES (Apache-2.0, see NOTICE); aliases added here.
 */
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry',
] as const;

const STATE_ALIASES: Record<string, (typeof INDIAN_STATES)[number]> = {
  orissa: 'Odisha', pondicherry: 'Puducherry', uttaranchal: 'Uttarakhand', 'jammu & kashmir': 'Jammu and Kashmir',
  'j&k': 'Jammu and Kashmir', 'andaman & nicobar': 'Andaman and Nicobar Islands', 'andaman and nicobar': 'Andaman and Nicobar Islands',
  'nct of delhi': 'Delhi', 'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu', 'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
};

const STATE_RE = new RegExp(
  `(?<![A-Za-z])(${[...INDIAN_STATES, ...Object.keys(STATE_ALIASES)]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&').replace(/ /g, '\\s+'))
    .join('|')})(?![A-Za-z])`,
  'i',
);

/**
 * The first Indian state / UT named in `text` (longest name wins at the same position), canonicalised.
 * Idea from erenmyeager15 `inferIndianState`, but position-ordered and word-bounded.
 */
export function inferIndianState(text: string): { state: string; index: number; length: number } | null {
  const m = STATE_RE.exec(text);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, ' ').toLowerCase();
  const state = STATE_ALIASES[raw] ?? INDIAN_STATES.find((s) => s.toLowerCase() === raw);
  return state ? { state, index: m.index, length: m[0].length } : null;
}

const CONSIGNEE_START = /Consignees?\s*\/\s*Reporting\s*Officer/i;
const CONSIGNEE_END = /Technical\s*Specifications|Buyer\s*Added\s*Bid\s*Specific|Specification\s*Document|Pre[- ]?Dispatch\s*Inspection|Disclaimer/i;

/** State of the first consignee, read only from the consignee / reporting-officer block (FR-019). */
function consigneeState(flats: string[]): { state: string; page: number; quote: string } | null {
  for (let i = 0; i < flats.length; i++) {
    const flat = flats[i];
    const start = CONSIGNEE_START.exec(flat);
    if (!start) continue;
    const rest = flat.slice(start.index, start.index + 1500);
    const end = CONSIGNEE_END.exec(rest.slice(start[0].length));
    const block = end ? rest.slice(0, start[0].length + end.index) : rest;
    const hit = inferIndianState(block);
    if (hit) {
      // Start the quote at a word boundary, at most 120 characters before the state.
      const from = hit.index > 120 ? block.indexOf(' ', hit.index - 120) + 1 : 0;
      return { state: hit.state, page: i + 1, quote: clip(block.slice(from, hit.index + hit.length + 40)) };
    }
  }
  return null;
}

// ───────────── Main extractor ─────────────

export function extractRequirementsRules(pages: string[], meta: RuleMeta = {}): Requirement[] {
  const out: Requirement[] = [];
  const have = new Set<string>();
  const src = (page: number, quote: string): Requirement['source'] => ({
    ...(meta.documentId ? { documentId: meta.documentId } : {}),
    ...(meta.fileName ? { fileName: meta.fileName } : {}),
    page,
    quote: clip(quote),
  });
  const flats = pages.map(flattenText);
  let docList: { items: string[]; page: number; quote: string } | null = null;

  flats.forEach((flat, i) => {
    const page = i + 1;
    const hits = findHits(flat);
    hits.forEach((h, j) => {
      if (h.def.boundaryOnly || !h.def.parse) return;
      if (h.def.firstPageOnly && page !== 1) return;
      if (have.has(h.def.key)) return;
      let next = hits[j + 1];
      if (h.def.key === 'documents_required') {
        // GeM lists documents named like labels ("…,Past Performance,Bidder Turnover"): a label that
        // directly follows a comma is a list item, not the next row.
        let k = j + 1;
        while (hits[k] && /,\s*$/.test(flat.slice(Math.max(0, hits[k].start - 3), hits[k].start))) k++;
        next = hits[k];
      }
      const end = Math.min(next ? next.start : flat.length, h.end + (h.def.key === 'documents_required' ? 600 : 260));
      // A value interleaved inside the wrapped label comes first.
      const raw = h.gap ? `${flat.slice(h.gap[0], h.gap[1])} ${flat.slice(h.end, end)}` : flat.slice(h.end, end);
      if (h.def.key === 'documents_required') {
        const items = splitDocumentList(raw);
        if (!items.length) return;
        docList = { items, page, quote: flat.slice(h.start, end) };
        have.add(h.def.key);
        return;
      }
      const parsed = h.def.parse(raw);
      if (!parsed || parsed.value === '' || parsed.value == null) return;
      have.add(h.def.key);
      out.push({
        key: h.def.key,
        label: h.def.label,
        value: parsed.value,
        numeric: parsed.numeric ?? null,
        mandatory: h.def.mandatory,
        source: src(page, flat.slice(h.start, end)),
        method: 'RULE',
        confidence: 0.95,
      });
    });
  });

  // Documents required → one requirement per document.
  const dl = docList as { items: string[]; page: number; quote: string } | null;
  if (dl) {
    for (const item of dl.items) {
      out.push({
        key: 'document', label: item, value: item, numeric: null, mandatory: true,
        source: src(dl.page, dl.quote), method: 'RULE', confidence: 0.9,
      });
    }
  }

  const estimated = (out.find((r) => r.key === 'estimated_value')?.numeric ?? null) || meta.estimatedValue || null;

  // ATC / free-text scans
  const docLabels = dl?.items.join(' | ') ?? '';
  flats.forEach((flat, i) => {
    const page = i + 1;

    // Similar work
    if (!have.has('similar_work')) {
      const pct = /similar[^.]{0,260}?(?:not less than|at least|minimum(?: of)?)\s*(?:the amount equal to\s*)?(\d+(?:\.\d+)?)\s*%\s*of\s*(?:the\s*)?estimated/i.exec(flat);
      const abs = pct ? null : /similar[^.]{0,200}?(?:value|cost(?:ing)?)[^.]{0,40}?(?:not less than|of at least|minimum of|exceeding)\s*(?:Rs\.?|₹|INR)?\s*(\d[\d,]*(?:\.\d+)?\s*(?:crores?|lakhs?|lacs?|lakh|cr\.?)?)/i.exec(flat);
      if (pct) {
        const p = Number.parseFloat(pct[1]);
        const rupees = estimated ? Math.round((estimated * p) / 100) : null;
        have.add('similar_work');
        out.push({
          key: 'similar_work', label: 'Similar work value (single order)',
          value: rupees ? `${p}% of estimated value (₹${groupIN(rupees)})` : `${p}% of estimated bid value`,
          numeric: rupees, mandatory: true, source: src(page, sentenceAround(flat, pct.index, pct[0].length)),
          method: 'RULE', confidence: rupees ? 0.85 : 0.7,
        });
      } else if (abs) {
        const n = parseIndianAmount(abs[1]);
        if (n) {
          have.add('similar_work');
          out.push({
            key: 'similar_work', label: 'Similar work value (single order)', value: `₹${groupIN(n)}`, numeric: n,
            mandatory: true, source: src(page, sentenceAround(flat, abs.index, abs[0].length)), method: 'RULE', confidence: 0.8,
          });
        }
      }
    }

    // Experience stated only in ATC
    if (!have.has('experience_years')) {
      const m = /(?:minimum of\s*|at least\s*)?\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*\(?\d*\)?\s*years?\s*(?:of\s*)?(?:past\s*|relevant\s*)?experience/i.exec(flat);
      if (m) {
        const n = WORD_NUM[m[1].toLowerCase()] ?? Number.parseInt(m[1], 10);
        if (n > 0 && n < 40) {
          have.add('experience_years');
          out.push({
            key: 'experience_years', label: 'Years of past experience', value: `${n} ${n === 1 ? 'year' : 'years'}`, numeric: n,
            mandatory: true, source: src(page, sentenceAround(flat, m.index, m[0].length)), method: 'RULE', confidence: 0.75,
          });
        }
      }
    }

    // Certificates
    for (const cp of CERT_PATTERNS) {
      cp.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = cp.re.exec(flat))) {
        const name = cp.name(m);
        const k = `certificate:${name}`;
        if (have.has(k)) continue;
        have.add(k);
        out.push({
          key: 'certificate', label: `${name} certificate`, value: name, numeric: null, mandatory: true,
          source: src(page, sentenceAround(flat, m.index, m[0].length)), method: 'RULE', confidence: 0.8,
        });
      }
    }

    // OEM authorisation
    if (!have.has('oem_auth')) {
      const inList = /OEM Authori[sz]ation/i.test(docLabels);
      const m = /(?:authori[sz]ation (?:letter |certificate )?from (?:the )?OEM|Manufacturer'?s? Authori[sz]ation|OEM Authori[sz]ation)/i.exec(flat);
      if (m && (inList || !/Document required from seller/i.test(flat.slice(Math.max(0, m.index - 400), m.index)))) {
        have.add('oem_auth');
        out.push({
          key: 'oem_auth', label: 'OEM authorisation', value: true, numeric: null, mandatory: true,
          source: src(page, sentenceAround(flat, m.index, m[0].length)), method: 'RULE', confidence: inList ? 0.95 : 0.8,
        });
      }
    }

    // Non-blacklisting undertaking
    if (!have.has('undertaking:non_blacklisting')) {
      const m = /(?:not been|not)\s+(?:been\s+)?(?:blacklisted|debarred)|non[- ]?blacklisting/i.exec(flat);
      if (m) {
        have.add('undertaking:non_blacklisting');
        out.push({
          key: 'undertaking', label: 'Non-blacklisting undertaking', value: 'non_blacklisting', numeric: null, mandatory: true,
          source: src(page, sentenceAround(flat, m.index, m[0].length)), method: 'RULE', confidence: 0.85,
        });
      }
    }
  });

  const consignee = consigneeState(flats);
  if (consignee) {
    out.push({
      key: 'consignee_state', label: 'Consignee state', value: consignee.state, numeric: null, mandatory: false,
      source: src(consignee.page, consignee.quote), method: 'RULE', confidence: 0.8,
    });
  }

  // OEM authorisation listed in "Document required from seller" even if not on another page.
  if (!have.has('oem_auth') && dl && /OEM Authori[sz]ation/i.test(docLabels)) {
    out.push({
      key: 'oem_auth', label: 'OEM authorisation', value: true, numeric: null, mandatory: true,
      source: src(dl.page, dl.quote), method: 'RULE', confidence: 0.95,
    });
  }

  return out;
}

// ───────────── Listing fallback & multi-document merge ─────────────

export interface ListingLike {
  endAt?: Date | string | null;
  emdAmount?: number | null;
  estimatedValue?: number | null;
  epbgPercent?: number | null;
  category?: string | null;
}

/** Requirements derivable from the BidPlus listing when the document did not yield them. */
export function requirementsFromListing(t: ListingLike): Requirement[] {
  const out: Requirement[] = [];
  const src = { quote: 'GeM BidPlus listing data' };
  const base = { method: 'RULE' as const, confidence: 0.7, source: src };
  if (t.endAt) {
    const iso = typeof t.endAt === 'string' ? t.endAt : t.endAt.toISOString();
    out.push({ ...base, key: 'bid_end', label: 'Bid end date', value: iso, numeric: null, mandatory: false });
  }
  if (t.emdAmount != null) out.push({ ...base, key: 'emd', label: 'EMD amount', value: `₹${groupIN(t.emdAmount)}`, numeric: t.emdAmount, mandatory: t.emdAmount > 0 });
  if (t.estimatedValue != null) out.push({ ...base, key: 'estimated_value', label: 'Estimated bid value', value: `₹${groupIN(t.estimatedValue)}`, numeric: t.estimatedValue, mandatory: false });
  if (t.epbgPercent != null) out.push({ ...base, key: 'epbg', label: 'ePBG percentage', value: `${t.epbgPercent}%`, numeric: t.epbgPercent, mandatory: false });
  if (t.category) out.push({ ...base, key: 'item_category', label: 'Item category', value: t.category, numeric: null, mandatory: false });
  return out;
}

export function requirementId(r: Requirement): string {
  if (!MULTI_KEYS.has(r.key)) return r.key;
  return `${r.key}:${String(r.value ?? r.label).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

/**
 * Combine requirement lists from several documents, in order (bid document first, then ATC,
 * corrigenda…). For single-valued keys a later document wins (a corrigendum supersedes the
 * original); multi-valued keys are unioned. `fallback` fills keys no document provided.
 */
export function combineRequirements(lists: Requirement[][], fallback: Requirement[] = []): Requirement[] {
  const map = new Map<string, Requirement>();
  for (const list of lists) for (const r of list) map.set(requirementId(r), r);
  for (const r of fallback) if (!map.has(requirementId(r))) map.set(requirementId(r), r);
  return [...map.values()];
}

// ───────────── Bid-number detection (FR-010) ─────────────

const BID_NO_RE = /GEM\s*\/\s*(\d{4})\s*\/\s*([A-Z])\s*\/\s*(\d+)/i;
/** Characters of page 1 treated as header / footer when looking for the printed bid number. */
const HEADER_CHARS = 800;
const FOOTER_CHARS = 400;

/** Normalise a GeM bid number ("gem / 2026 / b / 123" → "GEM/2026/B/123"); null if it is not one. */
export function normalizeBidNumber(s: string | null | undefined): string | null {
  const m = s ? BID_NO_RE.exec(s) : null;
  return m ? `GEM/${m[1]}/${m[2].toUpperCase()}/${m[3]}` : null;
}

/**
 * The GeM bid number printed on page 1 of a document (`GEM/\d{4}/[A-Z]/\d+`), looking at the page
 * header first and the footer second, so a bid number quoted in the body (e.g. "previous bid …")
 * is not mistaken for the document's own. Returns null when page 1 carries none (scans, ATCs).
 */
export function detectBidNumber(pages: string[]): string | null {
  const first = pages[0] ?? '';
  if (!first.trim()) return null;
  // Match over the whole page (slicing could cut a number in half), then judge by where it starts.
  const matches = [...first.matchAll(new RegExp(BID_NO_RE.source, 'gi'))];
  const header = matches.find((m) => m.index < HEADER_CHARS);
  const footer = matches.find((m) => m.index >= first.length - FOOTER_CHARS);
  return normalizeBidNumber((header ?? footer)?.[0]);
}
