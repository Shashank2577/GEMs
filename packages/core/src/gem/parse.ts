/**
 * GeM BidPlus listing parser (FR-001): turns one Solr doc from `POST /all-bids-data`
 * (`response.response.docs[]`) into a normalised tender ready to upsert into `tenders`.
 *
 * Field knowledge and the bid-type → document-route mapping are adapted from
 * erenmyeager15/india-government-tenders-scraper (Apache-2.0) and arush15june/gem-search (MIT) — see NOTICE.
 */
import { contentHash } from './hash';
import {
  cleanText, firstBool, firstNumber, firstText, parseAmount, parseGemDate, splitItems, tidyTitle,
} from './normalize';
import { canonicalState, deriveLocation } from './states';

export type GemBidType = 'bid' | 'ra' | 'bunch' | 'service';
export type TenderStatus = 'open' | 'closed' | 'cancelled' | 'awarded';

/** Raw BidPlus Solr doc (values are usually 1-element arrays). */
export type BidPlusDoc = Record<string, unknown>;

export interface BidPlusPage {
  docs: BidPlusDoc[];
  numFound: number;
  start: number;
}

/** A tender as stored in `tenders` (minus DB-generated columns). */
export interface NormalizedTender {
  source: 'gem';
  bidNumber: string;
  gemBidId: string | null;
  bidType: GemBidType;
  title: string;
  items: { name: string; quantity?: number; unit?: string }[];
  category: string | null;
  quantity: number | null;
  ministry: string | null;
  department: string | null;
  organisation: string | null;
  buyerOffice: string | null;
  state: string | null;
  city: string | null;
  startAt: Date | null;
  endAt: Date | null;
  openingAt: Date | null;
  emdAmount: number | null;
  estimatedValue: number | null;
  epbgPercent: number | null;
  hsnCodes: string[];
  status: TenderStatus;
  documentUrl: string | null;
  sourceUrl: string;
  raw: Record<string, unknown>;
  contentHash: string;
}

export interface ParseOptions {
  /** BidPlus base URL (no trailing slash). */
  baseUrl?: string;
  /** Used to mark bids whose end date has passed as closed. */
  now?: Date;
}

/** Fields whose change is meaningful for history / alerts; also the content-hash input. */
export const TRACKED_FIELDS = [
  'title', 'items', 'category', 'quantity', 'ministry', 'department', 'organisation', 'buyerOffice',
  'state', 'city', 'startAt', 'endAt', 'openingAt', 'emdAmount', 'estimatedValue', 'epbgPercent',
  'hsnCodes', 'status', 'bidType', 'documentUrl',
] as const satisfies readonly (keyof NormalizedTender)[];
export type TrackedField = (typeof TRACKED_FIELDS)[number];

/** Changes that should mark existing analyses stale and be recorded as a corrigendum. */
export const CORRIGENDUM_FIELDS: readonly TrackedField[] = [
  'endAt', 'openingAt', 'quantity', 'items', 'emdAmount', 'estimatedValue', 'epbgPercent', 'documentUrl', 'title',
];

/** Prefix of every error raised when GeM's listing response no longer looks like what we parse (FR-014). */
export const FORMAT_DRIFT_PREFIX = 'GeM response format changed:';

/** True when an error (or message) signals GeM format drift (FR-014). */
export function isFormatDriftError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.startsWith(FORMAT_DRIFT_PREFIX);
}

/**
 * Format-drift guard (FR-014): fail when more than half of a listing page's raw docs lack `b_bid_number`
 * (non-object entries count as missing). An empty page (GeM "no results") is fine.
 * Throws `GeM response format changed: <detail>`. `parseBidPlusResponse` runs it on the unfiltered docs.
 */
export function assertPageShape(page: { docs: readonly unknown[] }): void {
  const total = page.docs.length;
  if (!total) return;
  const missing = page.docs.filter((d) => !d || typeof d !== 'object' || Array.isArray(d) || !firstText(d as BidPlusDoc, ['b_bid_number'])).length;
  if (missing * 2 > total) {
    throw new Error(`${FORMAT_DRIFT_PREFIX} ${missing} of ${total} listing docs lack b_bid_number`);
  }
}

/** Validate and unwrap a BidPlus `/all-bids-data` JSON response. Throws on an unexpected shape. */
export function parseBidPlusResponse(data: unknown): BidPlusPage {
  const d = data as { code?: unknown; status?: unknown; message?: unknown; response?: { response?: { docs?: unknown; numFound?: unknown; start?: unknown } } };
  if (!d || typeof d !== 'object') throw new Error('GeM returned an empty response');
  const code = Number(d.code ?? d.status ?? 200);
  // GeM answers "no results" with code 404 and a JSON body.
  if (code === 404) return { docs: [], numFound: 0, start: 0 };
  if (code !== 200) throw new Error(`GeM returned code ${Number.isFinite(code) ? code : 'unknown'}${d.message ? `: ${String(d.message)}` : ''}`);
  const page = d.response?.response;
  if (!page || !Array.isArray(page.docs)) {
    throw new Error(`${FORMAT_DRIFT_PREFIX} incomplete search-result shape (response.response.docs missing)`);
  }
  assertPageShape({ docs: page.docs }); // before dropping non-object entries, so they count as missing
  const docs = page.docs.filter((x): x is BidPlusDoc => !!x && typeof x === 'object' && !Array.isArray(x));
  const numFound = Number(page.numFound ?? docs.length);
  const start = Number(page.start ?? 0);
  return { docs, numFound: Number.isFinite(numFound) ? numFound : docs.length, start: Number.isFinite(start) ? start : 0 };
}

function bidTypeOf(doc: BidPlusDoc, category: string | null): GemBidType {
  const code = firstNumber(doc, ['b_bid_type']);
  if (code === 2 || code === 5) return 'ra';
  if (firstBool(doc, ['b_is_bunch', 'is_bunch'])) return 'bunch';
  if (firstNumber(doc, ['b_type']) === 1) return 'service';
  if (category && /\b(services?|hiring|manpower|outsourc|maintenance|cleaning|housekeeping|security)\b/i.test(category)) return 'service';
  return 'bid';
}

/** Document route used by GeM's public all-bids page (from the Apache-2.0 reference scraper). */
function documentRoute(doc: BidPlusDoc): string {
  const code = firstNumber(doc, ['b_bid_type']);
  if (code === 5) return 'showdirectradocumentPdf';
  if (code === 2) return (firstNumber(doc, ['b_eval_type']) ?? 0) > 0 ? 'list-ra-schedules' : 'showradocumentPdf';
  return 'showbidDocument';
}

function statusOf(doc: BidPlusDoc, endAt: Date | null, now: Date): TenderStatus {
  if (firstBool(doc, ['b_is_cancelled', 'is_cancelled'])) return 'cancelled';
  const buyerStatus = firstNumber(doc, ['b_buyer_status']);
  if (buyerStatus === 3) return 'awarded';
  if (endAt && endAt.getTime() < now.getTime()) return 'closed';
  return 'open';
}

function hsnCodesOf(doc: BidPlusDoc, texts: (string | null)[]): string[] {
  const out = new Set<string>();
  for (const k of ['b_hsn_code', 'bd_hsn_code', 'hsn_code', 'b_hsn']) {
    const v = doc[k];
    const arr = Array.isArray(v) ? v : v == null ? [] : [v];
    for (const x of arr) for (const code of String(x).split(/[,;\s]+/)) if (/^\d{4,8}$/.test(code)) out.add(code);
  }
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(/\bHSN(?:\s*code)?\s*[:\-]?\s*(\d{4,8})\b/gi)) out.add(m[1]);
  }
  return [...out];
}

/** Hash input: tracked fields only (never raw / fetch timestamps). */
export function tenderContentHash(t: Pick<NormalizedTender, TrackedField | 'bidNumber'>): string {
  const pick: Record<string, unknown> = { bidNumber: t.bidNumber };
  for (const f of TRACKED_FIELDS) pick[f] = t[f];
  return contentHash(pick);
}

/** Parse one BidPlus doc. Returns null when it has no bid number (unusable). */
export function parseBidPlusDoc(doc: BidPlusDoc, opts: ParseOptions = {}): NormalizedTender | null {
  const base = (opts.baseUrl ?? 'https://bidplus.gem.gov.in').replace(/\/+$/, '');
  const now = opts.now ?? new Date();
  const bidNumber = firstText(doc, ['b_bid_number']);
  if (!bidNumber) return null;
  const idNum = firstNumber(doc, ['b_id']);
  const gemBidId = idNum !== null ? idNum.toFixed(0) : firstText(doc, ['id']);

  const shortCat = firstText(doc, ['b_category_name']);
  const longCat = firstText(doc, ['bd_category_name']);
  const explicitTitle = firstText(doc, ['bbt_title', 'b_title']);
  const itemNames = splitItems(longCat ?? shortCat);
  const quantity = firstNumber(doc, ['b_total_quantity']);
  const category = shortCat ? splitItems(shortCat)[0] ?? shortCat : itemNames[0] ?? null;

  let title = explicitTitle ?? shortCat ?? longCat ?? `GeM bid ${bidNumber}`;
  if (!explicitTitle && itemNames.length > 1) title = `${itemNames[0]} + ${itemNames.length - 1} more item${itemNames.length > 2 ? 's' : ''}`;
  title = tidyTitle(title).slice(0, 300);

  const ministry = firstText(doc, ['ba_official_details_minName']);
  const department = firstText(doc, ['ba_official_details_deptName']);
  const organisation = firstText(doc, ['ba_official_details_orgName', 'ba_org_name']);
  const buyerOffice = firstText(doc, ['ba_official_details_officeName', 'ba_office_name']);
  const explicitState = canonicalState(firstText(doc, ['ba_state', 'b_state', 'consignee_state']));
  const ministryAsState = canonicalState(ministry);
  const loc = deriveLocation(buyerOffice, organisation, department, firstText(doc, ['ba_city', 'b_city']));
  const state = explicitState ?? ministryAsState ?? loc.state;
  const city = firstText(doc, ['ba_city', 'b_city']) ?? (loc.state === state ? loc.city : null);

  const startAt = parseGemDate(doc.final_start_date_sort ?? doc.b_start_date);
  const endAt = parseGemDate(doc.final_end_date_sort ?? doc.b_end_date);
  const openingAt = parseGemDate(doc.b_bid_opening_date ?? doc.final_opening_date_sort);

  const emdAmount = parseAmount(doc.b_emd_amount ?? doc.ba_emd_amount ?? doc.emd_amount ?? null);
  const estimatedValue = parseAmount(doc.b_estimated_value ?? doc.ba_estimated_bid_value ?? doc.estimated_bid_value ?? doc.b_bid_value ?? null);
  const epbg = firstNumber(doc, ['b_epbg_percentage', 'ba_epbg_percent', 'epbg_percentage']);

  const bidType = bidTypeOf(doc, `${shortCat ?? ''} ${longCat ?? ''}`);
  const documentUrl = gemBidId ? `${base}/${documentRoute(doc)}/${gemBidId}` : null;

  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) raw[k] = v;

  const t: Omit<NormalizedTender, 'contentHash'> = {
    source: 'gem',
    bidNumber,
    gemBidId,
    bidType,
    title,
    items: itemNames.map((name, i) => (i === 0 && itemNames.length === 1 && quantity !== null ? { name, quantity } : { name })),
    category: category ? tidyTitle(category) : null,
    quantity: quantity !== null ? Math.round(quantity) : null,
    ministry,
    department,
    organisation,
    buyerOffice,
    state,
    city: cleanText(city),
    startAt,
    endAt,
    openingAt,
    emdAmount,
    estimatedValue,
    epbgPercent: epbg,
    hsnCodes: hsnCodesOf(doc, [shortCat, longCat]),
    status: statusOf(doc, endAt, now),
    documentUrl,
    sourceUrl: documentUrl ?? `${base}/all-bids`,
    raw,
  };
  return { ...t, contentHash: tenderContentHash(t) };
}

const normStr = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const asDate = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

/** True when both sides are the same value for diff/alerting purposes (case- and whitespace-insensitive strings, instant-equal dates). */
export function sameValue(a: unknown, b: unknown): boolean {
  const da = asDate(a), db = asDate(b);
  if (da && db) return da.getTime() === db.getTime();
  if (typeof a === 'string' && typeof b === 'string') return normStr(a) === normStr(b);
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Compare two tenders on the tracked fields → `{field: {from, to}}` (empty when identical). */
export function diffTenders(
  before: Partial<Record<TrackedField, unknown>>,
  after: Partial<Record<TrackedField, unknown>>,
): Record<string, { from: unknown; to: unknown }> {
  const norm = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of TRACKED_FIELDS) {
    const a = norm(before[f]);
    const b = norm(after[f]);
    if (!sameValue(a, b)) out[f] = { from: a, to: b };
  }
  return out;
}

export function isCorrigendum(changes: Record<string, unknown>): boolean {
  return Object.keys(changes).some((k) => (CORRIGENDUM_FIELDS as readonly string[]).includes(k));
}
