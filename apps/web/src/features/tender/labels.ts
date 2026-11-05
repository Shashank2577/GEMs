/** Presentation helpers for the tender page: labels, icons and value formatting. */
import {
  Award, BadgeCheck, Banknote, Building2, CalendarClock, CircleCheck, CircleDashed, CircleHelp, CircleMinus, CircleX, ClipboardCheck,
  FileBadge, FileCheck2, FileSpreadsheet, FileText, Flag, Handshake, Landmark, ReceiptText, ScrollText, ShieldCheck, Sparkles,
  Timer, Truck, type LucideIcon,
} from 'lucide-react';
import type { AnalysisDto, FactorStatus, Requirement, StaleReason, TenderDocKind, TenderDocumentDto } from '@tp/core/contracts/analyse';
import { matchCheckPrefix } from '@tp/core/analyse/check-prefix';
import { formatDateIST, formatINR, relativeTime } from '@/lib/format';

export const FACTOR_ICON: Record<string, LucideIcon> = {
  turnover: Banknote, experience: Award, similarWork: Handshake, emd: Landmark, mii: Flag, oem: BadgeCheck,
  certificates: FileBadge, documents: FileCheck2, deliveryFeasibility: Truck, timeToClose: Timer,
};

export const FACTOR_HELP: Record<string, string> = {
  turnover: 'Average annual turnover of your latest three financial years, compared with the bid minimum.',
  experience: 'Years since your first relevant contract (or incorporation) compared with the years the buyer asks for.',
  similarWork: 'Value of your largest similar past order compared with the similar-work condition.',
  emd: 'Earnest Money Deposit — refundable security paid with the bid. MSEs and DPIIT Startups are exempt (GFR 170).',
  mii: 'Make in India (PPP-MII Order 2017): Class-I local suppliers (≥50% local content) get purchase preference.',
  oem: 'Manufacturer Authorisation Form from the OEM, required when you resell a brand.',
  certificates: 'Certificates the ATC asks for, e.g. ISO 9001 or BIS, matched against your profile and vault.',
  documents: 'Standard documents (GST, PAN, balance sheets, CRACs…) available and valid in your vault.',
  deliveryFeasibility: 'Delivery period and consignee location versus your operating states.',
  timeToClose: 'Time left before the bid closes on GeM.',
};

export interface StatusMeta { label: string; icon: LucideIcon; tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral'; dot: string; text: string; soft: string }

export const STATUS_META: Record<FactorStatus, StatusMeta> = {
  pass: { label: 'Pass', icon: CircleCheck, tone: 'success', dot: 'bg-success', text: 'text-success', soft: 'bg-success-soft' },
  exempt: { label: 'Exempt', icon: ShieldCheck, tone: 'info', dot: 'bg-info', text: 'text-info', soft: 'bg-info-soft' },
  fail: { label: 'Fail', icon: CircleX, tone: 'danger', dot: 'bg-danger', text: 'text-danger', soft: 'bg-danger-soft' },
  unknown: { label: 'Needs review', icon: CircleHelp, tone: 'warning', dot: 'bg-warning', text: 'text-[hsl(32_90%_36%)] dark:text-warning', soft: 'bg-warning-soft' },
  na: { label: 'Not applicable', icon: CircleMinus, tone: 'neutral', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground', soft: 'bg-muted' },
};

export const DOC_KIND_LABEL: Record<TenderDocKind, string> = { bid: 'Bid document', atc: 'ATC', corrigendum: 'Corrigendum', boq: 'BOQ', other: 'Other' };

/** Stale-banner body per reason (FR-043). Analyses marked stale before reasons existed are corrigenda. */
export const STALE_REASON_COPY: Record<StaleReason, string> = {
  corrigendum: 'A corrigendum changed this bid after it was analysed. The score below may be outdated.',
  document_added: 'A document was added since this analysis. Re-analyse to include it.',
  document_removed: 'A document was removed since this analysis. Re-analyse to update the score.',
  profile_changed: 'Your company profile changed since this analysis. Re-analyse to update the score.',
  vault_changed: 'Your document vault changed since this analysis. Re-analyse to update the score.',
  weights_changed: 'Scoring weights changed since this analysis. Re-analyse to update the score.',
};

export const staleReasonCopy = (reason: StaleReason | null | undefined) => STALE_REASON_COPY[reason ?? 'corrigendum'] ?? STALE_REASON_COPY.corrigendum;

export const DOC_TYPE_LABEL: Record<string, string> = {
  gst: 'GST', pan: 'PAN', udyam: 'Udyam', startup_dpiit: 'DPIIT', incorporation: 'Incorporation', balance_sheet: 'Balance sheet', itr: 'ITR',
  ca_turnover_certificate: 'CA certificate', oem_authorization: 'OEM authorisation', crac: 'CRAC', work_order: 'Work order', iso: 'ISO', bis: 'BIS',
  mii_certificate: 'MII', emd_exemption: 'EMD exemption', bank_details: 'Bank details', power_of_attorney: 'Power of attorney',
  product_catalogue: 'Catalogue', test_report: 'Test report', other: 'Other',
};

export function docTypeIcon(docType: string | null, generated?: string): LucideIcon {
  if (generated) return Sparkles;
  switch (docType) {
    case 'gst': case 'pan': return ReceiptText;
    case 'udyam': case 'startup_dpiit': case 'incorporation': return Building2;
    case 'balance_sheet': case 'itr': case 'ca_turnover_certificate': return FileSpreadsheet;
    case 'crac': case 'work_order': return ClipboardCheck;
    case 'oem_authorization': return BadgeCheck;
    case 'iso': case 'bis': case 'mii_certificate': case 'test_report': return FileBadge;
    case 'power_of_attorney': return ScrollText;
    case null: return CircleDashed;
    default: return FileText;
  }
}

/** Requirement groups for the requirements table. */
export const REQ_GROUPS: { key: string; label: string; match: (r: Requirement) => boolean }[] = [
  { key: 'eligibility', label: 'Eligibility criteria', match: (r) => ['turnover_min', 'oem_turnover', 'experience_years', 'similar_work', 'past_performance', 'oem_auth', 'certificate', 'mii', 'undertaking'].includes(r.key) },
  { key: 'money', label: 'EMD, ePBG & exemptions', match: (r) => ['emd', 'epbg', 'epbg_duration', 'mse_exemption', 'startup_exemption', 'mse_purchase_preference', 'estimated_value'].includes(r.key) },
  { key: 'documents', label: 'Documents required from seller', match: (r) => r.key === 'document' },
  // Everything else, including contract_period, bid_published_at and consignee_state (FR-019).
  { key: 'bid', label: 'Bid details', match: () => true },
];

/** Keys whose value is a date without a meaningful time ("Dated: 01-11-2026"). */
const DATE_ONLY_KEYS = new Set(['bid_published_at']);

const MONEY_KEYS = new Set(['turnover_min', 'oem_turnover', 'similar_work', 'emd', 'estimated_value']);

export function formatRequirementValue(r: Requirement): string {
  if (r.numeric != null && MONEY_KEYS.has(r.key)) return formatINR(r.numeric);
  if (typeof r.value === 'boolean') return r.value ? 'Yes' : 'No';
  if (typeof r.value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(r.value)) return formatDateIST(r.value, { time: !DATE_ONLY_KEYS.has(r.key) });
  // "2 years" → "2 years (24 months)"; "1 year 6 months" already reads as months.
  if (r.key === 'contract_period' && typeof r.value === 'string' && r.numeric != null && !/month/i.test(r.value)) {
    return `${r.value} (${r.numeric} ${r.numeric === 1 ? 'month' : 'months'})`;
  }
  if (r.value == null || r.value === '') return '—';
  if (r.key === 'undertaking' && r.value === 'non_blacklisting') return 'Required';
  return String(r.value);
}

/**
 * Documents used by this analysis whose printed bid number is not the tender's (FR-010, US2 #13):
 * listed documents flagged `bidNumberFound` that existed when the analysis was created.
 */
export function mismatchedDocuments(analysis: Pick<AnalysisDto, 'createdAt'>, documents: TenderDocumentDto[] | undefined): TenderDocumentDto[] {
  const at = Date.parse(analysis.createdAt);
  return (documents ?? []).filter((d) => d.bidNumberFound && !(Date.parse(d.createdAt) > at));
}

/** How often the page re-reads the analysis while another member's run is in progress (FR-029). */
export const ANALYSIS_POLL_MS = 3000;

/** Another analysis for this org+tender is running (GET …/analysis `lastAttempt`, FR-028/FR-029). */
export function isAnalysisRunning(a: Pick<AnalysisDto, 'lastAttempt'> | null | undefined): boolean {
  return a?.lastAttempt?.status === 'running';
}

/**
 * US3 #15 warning when the newest attempt failed but a previous result is shown, else null:
 * "The last re-analysis failed: <reason>. Showing the previous result from <relative time>."
 */
export function failedAttemptCopy(a: Pick<AnalysisDto, 'status' | 'lastAttempt' | 'updatedAt'> | null | undefined, now: Date = new Date()): string | null {
  if (!a || a.status !== 'done' || a.lastAttempt?.status !== 'failed') return null;
  const reason = friendlyAnalysisError(a.lastAttempt.error).replace(/[.\s]+$/, '');
  return `The last re-analysis failed: ${reason}. Showing the previous result from ${relativeTime(a.updatedAt, now)}.`;
}

/**
 * A user-safe reason for a failed analysis (S6). The raw error is kept in logs and the DB; only the
 * known-safe cases are shown, anything else (stack-ish or provider text) becomes a generic message.
 */
export function friendlyAnalysisError(raw: string | null | undefined): string {
  const e = (raw ?? '').trim();
  if (/timed out|took too long/i.test(e)) return 'it took too long and timed out';
  if (/pdf|unreadable|password/i.test(e)) return 'a document could not be read';
  return 'something went wrong while reading the documents';
}

/** Documents whose page count was capped (S1): `pageCount` read of `totalPages`. */
export function truncatedDocuments(docs: readonly { fileName: string; pageCount: number | null; totalPages?: number | null }[] | undefined) {
  return (docs ?? []).filter((d) => d.pageCount != null && d.totalPages != null && d.totalPages > d.pageCount)
    .map((d) => ({ fileName: d.fileName, analysed: d.pageCount as number, total: d.totalPages as number }));
}

/**
 * What the Analysis tab shows: the result, a failed first attempt ("Try again"), or "in progress".
 * `lastAttempt` wins over a `running`/`pending` row: a first-ever run that timed out (S3, FR-028) is
 * failed, never "in progress" forever, even if an older API still reports the row as running.
 */
export function analysisPanelState(a: Pick<AnalysisDto, 'status' | 'error' | 'lastAttempt'>): { kind: 'result' } | { kind: 'in_progress' } | { kind: 'failed'; error: string | null } {
  if (a.status === 'done') return { kind: 'result' };
  if (a.lastAttempt?.status === 'failed') return { kind: 'failed', error: a.lastAttempt.error ?? a.error ?? null };
  if (a.status === 'failed') return { kind: 'failed', error: a.error ?? null };
  return { kind: 'in_progress' };
}

/** The "Check documents: … is for GEM/…." prefix the API puts on an analysis summary, if any. */
export function documentCheckPrefix(summary: string | null | undefined): string | null {
  return matchCheckPrefix(summary);
}

export const CHANGE_LABEL: Record<string, string> = {
  endAt: 'Closing date', openingAt: 'Opening date', startAt: 'Start date', emdAmount: 'EMD', estimatedValue: 'Estimated value',
  quantity: 'Quantity', epbgPercent: 'ePBG %', status: 'Status', title: 'Title', category: 'Category', documentUrl: 'Bid document',
};

export function formatChangeValue(key: string, v: unknown): string {
  if (v == null || v === '') return '—';
  if (/At$/.test(key) && typeof v === 'string') return formatDateIST(v, { time: true });
  if (/(Amount|Value)$/.test(key) && typeof v === 'number') return formatINR(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export const ACTIVITY_LABEL: Record<string, string> = {
  'tender.analysed': 'ran the eligibility analysis',
  'tender.document_uploaded': 'uploaded a document',
  'tender.document_fetched': 'fetched the bid document from GeM',
  'analysis.factor_overridden': 'overrode a factor',
  'tender.dismissed': 'dismissed this tender',
  'workspace.created': 'started a bid workspace',
};

export { CalendarClock };
