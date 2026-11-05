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
  if (withUnit) {
    const n = Number.parseFloat(withUnit[1].replace(/,/g, ''));
    if (Number.isFinite(n)) return Math.round(n * unitMultiplier(withUnit[2]));
  }
  const plain = s.match(/(?:₹|Rs\.?|INR)?\s*(\d[\d,]*(?:\.\d+)?)/i);
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
}

const yesNo = (v: string): Parsed => {
  const m = v.match(/\b(yes|no)\b/i);
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
  { key: 'bid_end', label: 'Bid end date', re: L('Bid End Date ?/ ?Time'), parse: dateP, mandatory: false },
  { key: 'bid_opening', label: 'Bid opening date', re: L('Bid Opening Date ?/ ?Time'), parse: dateP, mandatory: false },
  { key: 'offer_validity', label: 'Bid offer validity', re: L('Bid Offer Validity( \\(From End Date\\))?'), parse: daysP, mandatory: false },
  { key: 'ministry', label: 'Ministry / State', re: L('Ministry ?/ ?State Name'), parse: textP, mandatory: false },
  { key: 'department', label: 'Department', re: L('Department Name'), parse: textP, mandatory: false },
  { key: 'organisation', label: 'Organisation', re: L('Organi[sz]ation Name'), parse: textP, mandatory: false },
  { key: 'office', label: 'Office', re: L('Office Name'), parse: textP, mandatory: false },
  { key: 'total_quantity', label: 'Total quantity', re: L('Total Quantity'), parse: intP, mandatory: false },
  { key: 'item_category', label: 'Item category', re: L('Item Category'), parse: textP, mandatory: false },
  { key: 'estimated_value', label: 'Estimated bid value', re: L('Estimated Bid Value'), parse: amount, mandatory: false },
  { key: 'turnover_min', label: 'Minimum average annual turnover (bidder)', re: L('Minimum Average Annual Turnover of the bidder'), parse: amount, mandatory: true },
  { key: 'oem_turnover', label: 'OEM average annual turnover', re: L('OEM Average Turnover'), parse: amount, mandatory: true },
  { key: 'experience_years', label: 'Years of past experience', re: L('Years of Past Experience Required'), parse: yearsP, mandatory: true },
  { key: 'past_performance', label: 'Past performance', re: L('Past Performance'), parse: pctP, mandatory: true },
  { key: 'mse_exemption', label: 'MSE exemption (experience & turnover)', re: L('MSE Exemption for Years Of Experience'), parse: yesNo, mandatory: false },
  { key: 'startup_exemption', label: 'Startup exemption (experience & turnover)', re: L('Startup Exemption for Years Of Experience'), parse: yesNo, mandatory: false },
  { key: 'documents_required', label: 'Documents required from seller', re: L('Document(s)? required from seller'), parse: textP, mandatory: true },
  { key: 'bid_to_ra', label: 'Bid to reverse auction', re: L('Bid to RA enabled'), parse: yesNo, mandatory: false },
  { key: 'bid_type', label: 'Type of bid', re: L('Type of Bid'), parse: textP, mandatory: false },
  { key: 'evaluation_method', label: 'Evaluation method', re: L('Evaluation Method'), parse: textP, mandatory: false },
  { key: 'emd', label: 'EMD amount', re: L('EMD Amount'), parse: amount, mandatory: true },
  { key: 'epbg', label: 'ePBG percentage', re: L('ePBG Percentage ?\\(%\\)'), parse: pctP, mandatory: false },
  { key: 'epbg_duration', label: 'ePBG duration', re: L('Duration of ePBG required ?\\(Months\\)\\.?'), parse: monthsP, mandatory: false },
  { key: 'mii', label: 'Make in India (MII) compliance', re: L('MII (Compliance|Purchase Preference)'), parse: yesNo, mandatory: true },
  { key: 'mse_purchase_preference', label: 'MSE purchase preference', re: L('MSE Purchase Preference'), parse: yesNo, mandatory: false },
  { key: 'delivery_days', label: 'Delivery period', re: L('Delivery (Days|Period)( \\(in days\\))?'), parse: daysP, mandatory: true },
  // Boundaries only
  { key: '_', label: '', re: L('Advisory Bank'), mandatory: false, boundaryOnly: true },
  { key: '_', label: '', re: L('Time allowed for Technical Clarifications'), mandatory: false, boundaryOnly: true },
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
  { key: '_', label: '', re: /\bGEM\/\d{4}\/[A-Z]\/\d+\s*\|\s*Page\s*\d+/gi, mandatory: false, boundaryOnly: true },
];

interface Hit { def: LabelDef; start: number; end: number }

function findHits(flat: string): Hit[] {
  const hits: Hit[] = [];
  for (const def of LABELS) {
    def.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = def.re.exec(flat))) {
      hits.push({ def, start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) def.re.lastIndex++;
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
  const t = s.trim();
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
      if (have.has(h.def.key)) return;
      const next = hits[j + 1];
      const end = Math.min(next ? next.start : flat.length, h.end + (h.def.key === 'documents_required' ? 600 : 260));
      const raw = flat.slice(h.end, end);
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
