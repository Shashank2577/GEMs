/**
 * Vault document status & expiry reminders (T051; FR-021, FR-022) and the document-type catalog.
 * Dates are calendar dates ("YYYY-MM-DD"); "today" is the IST calendar day of `now`.
 *
 * GeM seller-document label vocabulary (`GEM_SELLER_DOC_LABELS`, T041; FR-026, NFR-009): the eligibility
 * labels of GeM bid documents ("Minimum Average Annual Turnover", "Years of Past Experience Required",
 * "MSE / Startup Relaxation for Years Of Experience and Turnover", "Document required from seller") are
 * adapted from `buildEligibilitySummary` in erenmyeager15/india-government-tenders-scraper
 * (Apache-2.0, https://github.com/erenmyeager15/india-government-tenders-scraper, src/routes.ts) — see
 * NOTICE. The "Document required from seller" item names are the labels printed on public GeM bid PDFs.
 */
import type { DocType } from '../analyse/types';

export type { DocType };
export type DocStatus = 'valid' | 'expiring' | 'expired';
export type DocCategory = 'Statutory' | 'Financial' | 'Experience' | 'OEM' | 'Quality' | 'Other';

/** Documents expiring within this many days are "Expiring soon". */
export const EXPIRING_WITHIN_DAYS = 30;
/** Reminder thresholds in days before expiry (FR-022). 0 = expired. */
export const REMINDER_THRESHOLDS = [30, 7, 1] as const;

const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;

/** IST calendar date "YYYY-MM-DD" for an instant. */
export function istDate(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET).toISOString().slice(0, 10);
}

function dateOnly(v: string | Date): number | null {
  const s = typeof v === 'string' ? v.slice(0, 10) : istDate(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

/** Whole days from today (IST) to the expiry date. Negative when past. null when no/invalid expiry. */
export function daysUntilExpiry(expiryDate: string | Date | null | undefined, now: Date): number | null {
  if (!expiryDate) return null;
  const e = dateOnly(expiryDate);
  const today = dateOnly(now)!;
  return e == null ? null : Math.round((e - today) / DAY);
}

/**
 * Valid / Expiring soon (≤ 30 days) / Expired (expiry date before today). A document is still valid
 * on its expiry date. No expiry date → valid (e.g. PAN, GST registration).
 */
export function docStatus(expiryDate: string | Date | null | undefined, now: Date): { status: DocStatus; daysToExpiry: number | null } {
  const d = daysUntilExpiry(expiryDate, now);
  if (d == null) return { status: 'valid', daysToExpiry: null };
  if (d < 0) return { status: 'expired', daysToExpiry: d };
  if (d <= EXPIRING_WITHIN_DAYS) return { status: 'expiring', daysToExpiry: d };
  return { status: 'valid', daysToExpiry: d };
}

/**
 * Which reminder (30 / 7 / 1 days, or 0 = "has expired") is due now, given the threshold of the last
 * reminder sent for this document (null = none yet). Returns null when nothing is due.
 * A document uploaded with 5 days left gets the 7-day reminder once, never the 30-day one too.
 * Expired documents get one "expired" reminder, but only within 30 days of expiry (no nagging about
 * archives).
 */
export function reminderDue(doc: { expiryDate: string | Date | null | undefined; lastReminderDays?: number | null }, now: Date): number | null {
  const d = daysUntilExpiry(doc.expiryDate, now);
  if (d == null) return null;
  let threshold: number | null = null;
  if (d < 0) threshold = d >= -EXPIRING_WITHIN_DAYS ? 0 : null;
  else for (const t of REMINDER_THRESHOLDS) if (d <= t) threshold = t; // smallest crossed threshold
  if (threshold == null) return null;
  const last = doc.lastReminderDays;
  if (last != null && last <= threshold) return null;
  return threshold;
}

/**
 * The next reminder still to be sent for a document (FR-053), or null when none is left or there is no
 * expiry date ("All reminders sent").
 * - A reminder already due (`reminderDue`, including the post-expiry notice) goes out on the next scheduler
 *   tick, so its date is today (IST).
 * - Otherwise the next unsent "N days before expiry" threshold of `REMINDER_THRESHOLDS`, dated expiry − N.
 * - Otherwise, if the document has not expired yet and the expiry notice was not sent, `days: 0` = the
 *   "has expired" notice, dated the day after expiry.
 */
export function nextReminder(
  expiryDate: string | Date | null | undefined, lastReminderDays: number | null | undefined, now: Date,
): { days: number; date: string } | null {
  const left = daysUntilExpiry(expiryDate, now);
  if (left == null) return null;
  const due = reminderDue({ expiryDate, lastReminderDays }, now);
  if (due != null) return { days: due, date: istDate(now) };
  const expiry = dateOnly(expiryDate!)!;
  const next = REMINDER_THRESHOLDS.find((t) => t < left && (lastReminderDays == null || t < lastReminderDays));
  if (next != null) return { days: next, date: new Date(expiry - next * DAY).toISOString().slice(0, 10) };
  if (left >= 0 && lastReminderDays !== 0) return { days: 0, date: new Date(expiry + DAY).toISOString().slice(0, 10) };
  return null;
}

/** Human copy for a reminder threshold. */
export function reminderCopy(threshold: number, daysToExpiry: number): string {
  if (threshold === 0 || daysToExpiry < 0) {
    const ago = Math.abs(daysToExpiry);
    return ago === 0 ? 'expired today' : `expired ${ago} day${ago === 1 ? '' : 's'} ago`;
  }
  if (daysToExpiry === 0) return 'expires today';
  return `expires in ${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'}`;
}

// ───────────── Document-type catalog ─────────────

export interface DocTypeInfo {
  type: DocType;
  label: string;
  /** lucide-react icon name (PascalCase). */
  icon: string;
  description: string;
  category: DocCategory;
  /** Does this document normally carry an expiry date? */
  expires: boolean;
  /** Typical validity in months (null = no expiry / varies). */
  typicalValidityMonths: number | null;
  /** Is it tied to a financial year (balance sheet, ITR, CA certificate)? */
  perFinancialYear: boolean;
  /** Commonly asked for in GeM bids. */
  commonInBids: boolean;
  /** Lower-case filename hints used to guess the type of an upload. */
  keywords: string[];
}

/**
 * Labels GeM bid documents use for the proofs a seller must upload, mapped to the vault type that
 * satisfies them. Their normalised forms are appended to `DOC_TYPES[].keywords`, so `guessDocType`
 * recognises file names that sellers copy from the bid ("Bidder_Turnover.pdf", "Experience Criteria.pdf").
 */
export const GEM_SELLER_DOC_LABELS: Readonly<Record<string, DocType>> = {
  // Eligibility labels (adapted from india-government-tenders-scraper `buildEligibilitySummary`, Apache-2.0).
  'Minimum Average Annual Turnover': 'ca_turnover_certificate',
  'Average Annual Turnover': 'ca_turnover_certificate',
  'Years of Past Experience Required': 'work_order',
  'Past Experience': 'work_order',
  'MSE Relaxation for Years Of Experience and Turnover': 'udyam',
  'MSE Relaxation': 'udyam',
  'Startup Relaxation for Years Of Experience and Turnover': 'startup_dpiit',
  'Startup Relaxation': 'startup_dpiit',
  // "Document required from seller" items on GeM bid PDFs.
  'Experience Criteria': 'work_order',
  'Past Performance': 'crac',
  'Bidder Turnover': 'ca_turnover_certificate',
  'OEM Authorization Certificate': 'oem_authorization',
  'OEM Authorisation Certificate': 'oem_authorization',
  'Manufacturer Authorization Form': 'oem_authorization',
  'Compliance of BoQ specification and supporting document': 'product_catalogue',
  'BoQ Compliance': 'product_catalogue',
  'Make in India Certificate': 'mii_certificate',
  'Local Content Certificate': 'mii_certificate',
  'EMD Exemption Certificate': 'emd_exemption',
};

/** Lower-case, punctuation-free form used for keyword matching ("OEM Authorization Certificate" → "oem authorization certificate"). */
const labelKeyword = (label: string) => label.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();
const gemKeywords = (type: DocType) => Object.entries(GEM_SELLER_DOC_LABELS).filter(([, t]) => t === type).map(([l]) => labelKeyword(l));

export const DOC_TYPES: readonly DocTypeInfo[] = [
  { type: 'gst', label: 'GST registration', icon: 'Receipt', category: 'Statutory', expires: false, typicalValidityMonths: null, perFinancialYear: false, commonInBids: true,
    description: 'GST registration certificate (Form GST REG-06) showing your GSTIN.', keywords: ['gst', 'gstin', 'reg-06', 'reg06'] },
  { type: 'pan', label: 'PAN card', icon: 'CreditCard', category: 'Statutory', expires: false, typicalValidityMonths: null, perFinancialYear: false, commonInBids: true,
    description: 'Permanent Account Number card of the bidding entity.', keywords: ['pan'] },
  { type: 'udyam', label: 'Udyam (MSE) certificate', icon: 'BadgeCheck', category: 'Statutory', expires: false, typicalValidityMonths: null, perFinancialYear: false, commonInBids: true,
    description: 'Udyam registration — needed to claim MSE EMD exemption and purchase preference.', keywords: ['udyam', 'msme', 'mse', 'udyog', ...gemKeywords('udyam')] },
  { type: 'startup_dpiit', label: 'Startup (DPIIT) recognition', icon: 'Rocket', category: 'Statutory', expires: true, typicalValidityMonths: 120, perFinancialYear: false, commonInBids: false,
    description: 'DPIIT recognition certificate — exempts eligible startups from turnover/experience criteria.', keywords: ['dpiit', 'startup', 'dipp', ...gemKeywords('startup_dpiit')] },
  { type: 'incorporation', label: 'Incorporation certificate', icon: 'Building2', category: 'Statutory', expires: false, typicalValidityMonths: null, perFinancialYear: false, commonInBids: false,
    description: 'Certificate of incorporation / partnership deed / LLP agreement.', keywords: ['incorporation', 'coi', 'partnership', 'deed', 'llp', 'moa', 'aoa'] },
  { type: 'balance_sheet', label: 'Audited balance sheet', icon: 'FileSpreadsheet', category: 'Financial', expires: false, typicalValidityMonths: null, perFinancialYear: true, commonInBids: true,
    description: 'Audited balance sheet and P&L for one financial year.', keywords: ['balance', 'bs', 'audited', 'financial statement', 'financial statements', 'p&l', 'pnl', 'profit and loss', 'profit loss'] },
  { type: 'itr', label: 'Income-tax return (ITR)', icon: 'Landmark', category: 'Financial', expires: false, typicalValidityMonths: null, perFinancialYear: true, commonInBids: false,
    description: 'ITR acknowledgement for one assessment year.', keywords: ['itr', 'income tax', 'acknowledgement'] },
  { type: 'ca_turnover_certificate', label: 'CA turnover certificate', icon: 'Calculator', category: 'Financial', expires: false, typicalValidityMonths: null, perFinancialYear: true, commonInBids: true,
    description: 'Chartered Accountant certificate of annual turnover (usually last 3 FYs, with UDIN).', keywords: ['ca cert', 'turnover', 'udin', 'chartered', ...gemKeywords('ca_turnover_certificate')] },
  { type: 'oem_authorization', label: 'OEM authorisation', icon: 'Handshake', category: 'OEM', expires: true, typicalValidityMonths: 12, perFinancialYear: false, commonInBids: true,
    description: 'Manufacturer authorisation (MAF) allowing you to bid for their products.', keywords: ['oem', 'maf', 'authorization', 'authorisation', 'dealer', 'dealership', ...gemKeywords('oem_authorization')] },
  { type: 'crac', label: 'CRAC / completion certificate', icon: 'ClipboardCheck', category: 'Experience', expires: false, typicalValidityMonths: null, perFinancialYear: false, commonInBids: true,
    description: 'Consignee Receipt & Acceptance Certificate or performance/completion certificate from a buyer.', keywords: ['crac', 'completion', 'performance', 'acceptance', 'satisfactory', ...gemKeywords('crac')] },
  { type: 'work_order', label: 'Work / purchase order', icon: 'FileText', category: 'Experience', expires: false, typicalValidityMonths: null, perFinancialYear: false, commonInBids: true,
    description: 'Past contract, purchase order or GeM contract as proof of experience.', keywords: ['work order', 'wo', 'purchase order', 'po', 'contract', 'supply order', ...gemKeywords('work_order')] },
  { type: 'iso', label: 'ISO certificate', icon: 'Award', category: 'Quality', expires: true, typicalValidityMonths: 36, perFinancialYear: false, commonInBids: true,
    description: 'ISO 9001 / 14001 / 27001 etc. Valid for 3 years subject to surveillance audits.', keywords: ['iso', '9001', '14001', '27001', '45001'] },
  { type: 'bis', label: 'BIS licence', icon: 'ShieldCheck', category: 'Quality', expires: true, typicalValidityMonths: 24, perFinancialYear: false, commonInBids: false,
    description: 'Bureau of Indian Standards licence / CRS registration for the product.', keywords: ['bis', 'isi', 'crs'] },
  { type: 'mii_certificate', label: 'Make in India declaration', icon: 'Flag', category: 'Statutory', expires: false, typicalValidityMonths: null, perFinancialYear: false, commonInBids: true,
    description: 'Local-content self-certificate (Class-I ≥ 50%, Class-II ≥ 20%); above ₹10 crore it must come from a statutory auditor.', keywords: ['mii', 'make in india', 'local content', 'class-i', 'class i', ...gemKeywords('mii_certificate')] },
  { type: 'emd_exemption', label: 'EMD exemption proof', icon: 'Percent', category: 'Financial', expires: true, typicalValidityMonths: 12, perFinancialYear: false, commonInBids: false,
    description: 'Any document supporting an EMD exemption claim (beyond Udyam / DPIIT).', keywords: ['emd', 'exemption', ...gemKeywords('emd_exemption')] },
  { type: 'bank_details', label: 'Bank details / cancelled cheque', icon: 'Banknote', category: 'Financial', expires: false, typicalValidityMonths: null, perFinancialYear: false, commonInBids: false,
    description: 'Cancelled cheque or bank mandate letter with IFSC.', keywords: ['cheque', 'bank', 'mandate', 'ifsc', 'nach'] },
  { type: 'power_of_attorney', label: 'Power of attorney / board resolution', icon: 'PenLine', category: 'Statutory', expires: true, typicalValidityMonths: 12, perFinancialYear: false, commonInBids: false,
    description: 'Authorises the signatory to sign bids on behalf of the company.', keywords: ['poa', 'power of attorney', 'board resolution', 'authority letter'] },
  { type: 'product_catalogue', label: 'Product catalogue / datasheet', icon: 'BookOpen', category: 'Other', expires: false, typicalValidityMonths: null, perFinancialYear: false, commonInBids: false,
    description: 'Brochures and technical datasheets for offered products.', keywords: ['catalogue', 'catalog', 'datasheet', 'brochure', 'spec sheet', ...gemKeywords('product_catalogue')] },
  { type: 'test_report', label: 'Test report', icon: 'FlaskConical', category: 'Quality', expires: true, typicalValidityMonths: 24, perFinancialYear: false, commonInBids: false,
    description: 'NABL / government lab test report for the offered product.', keywords: ['test report', 'nabl', 'lab', 'type test'] },
  { type: 'other', label: 'Other document', icon: 'File', category: 'Other', expires: false, typicalValidityMonths: null, perFinancialYear: false, commonInBids: false,
    description: 'Anything else you may need to attach to a bid.', keywords: [] },
];

export const DOC_TYPE_VALUES = DOC_TYPES.map((d) => d.type) as [DocType, ...DocType[]];
export const DOC_CATEGORIES: readonly DocCategory[] = ['Statutory', 'Financial', 'Experience', 'OEM', 'Quality', 'Other'];

const BY_TYPE = new Map(DOC_TYPES.map((d) => [d.type, d]));
export function docTypeInfo(type: string): DocTypeInfo {
  return BY_TYPE.get(type as DocType) ?? BY_TYPE.get('other')!;
}

/**
 * Guess the document type from a file name ("GST_REG06_2023.pdf" → gst). Longer keyword matches win
 * so "ca turnover" beats "turnover"-less matches. Returns 'other' when nothing matches.
 */
export function guessDocType(fileName: string): DocType {
  const name = ` ${fileName.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[_\-.]+/g, ' ')} `;
  let best: { type: DocType; score: number } | null = null;
  for (const d of DOC_TYPES) {
    for (const kw of d.keywords) {
      const re = new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')}([^a-z0-9]|$)`);
      if (re.test(name) && (!best || kw.length > best.score)) best = { type: d.type, score: kw.length };
    }
  }
  return best?.type ?? 'other';
}

/** "2023-24" style FY guessed from a filename ("BS_FY2023-24.pdf", "balance sheet 2024-2025"). */
export function guessFinancialYear(fileName: string): string | null {
  const m = fileName.match(/(20\d{2})\s*[-_–]\s*(20)?(\d{2})(?!\d)/);
  if (!m) return null;
  const a = Number(m[1]);
  return Number(m[3]) === (a + 1) % 100 ? `${a}-${m[3]}` : null;
}

/** A suggested expiry date (ISO) from the issue date and the type's typical validity. */
export function suggestExpiry(type: DocType, issueDate: string | null | undefined): string | null {
  const info = docTypeInfo(type);
  if (!info.expires || !info.typicalValidityMonths || !issueDate || !/^\d{4}-\d{2}-\d{2}/.test(issueDate)) return null;
  const d = new Date(`${issueDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + info.typicalValidityMonths);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
