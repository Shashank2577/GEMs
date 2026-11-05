/** Presentation helpers for the tender page: labels, icons and value formatting. */
import {
  Award, BadgeCheck, Banknote, Building2, CalendarClock, CircleCheck, CircleDashed, CircleHelp, CircleMinus, CircleX, ClipboardCheck,
  FileBadge, FileCheck2, FileSpreadsheet, FileText, Flag, Handshake, Landmark, ReceiptText, ScrollText, ShieldCheck, Sparkles,
  Timer, Truck, type LucideIcon,
} from 'lucide-react';
import type { FactorStatus, Requirement, StaleReason, TenderDocKind } from '@tp/core/contracts/analyse';
import { formatDateIST, formatINR } from '@/lib/format';

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
  { key: 'bid', label: 'Bid details', match: () => true },
];

const MONEY_KEYS = new Set(['turnover_min', 'oem_turnover', 'similar_work', 'emd', 'estimated_value']);

export function formatRequirementValue(r: Requirement): string {
  if (r.numeric != null && MONEY_KEYS.has(r.key)) return formatINR(r.numeric);
  if (typeof r.value === 'boolean') return r.value ? 'Yes' : 'No';
  if (typeof r.value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(r.value)) return formatDateIST(r.value, { time: true });
  if (r.value == null || r.value === '') return '—';
  if (r.key === 'undertaking' && r.value === 'non_blacklisting') return 'Required';
  return String(r.value);
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
