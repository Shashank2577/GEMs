/**
 * Human-readable corrigendum summaries (spec 003 FR-052).
 *
 * The material-field comparison (case-insensitive, whitespace-tolerant string equality, so a re-cased title is not
 * reported as an amendment) is adapted from erenmyeager15/india-government-tenders-scraper `src/monitoring.ts`
 * (Apache-2.0; see NOTICE). The IST/₹ formatting is TenderPilot's own.
 */
import { CORRIGENDUM_FIELDS, sameValue } from './parse';

export type FieldChange = { from: unknown; to: unknown };

const LABEL: Record<string, string> = {
  endAt: 'Bid end date', openingAt: 'Bid opening date', quantity: 'Quantity', items: 'Items', emdAmount: 'EMD',
  estimatedValue: 'Estimated value', epbgPercent: 'ePBG', documentUrl: 'Bid document', title: 'Title',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_MS = 330 * 60_000;

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** "19 Nov, 3:00 pm" in IST (year added when `withYear`). Deterministic: no ICU dependence. */
function fmtIst(d: Date, withYear: boolean): string {
  const t = new Date(d.getTime() + IST_MS);
  const h = t.getUTCHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}${withYear ? ` ${t.getUTCFullYear()}` : ''}, ${h12}:${mm} ${h < 12 ? 'am' : 'pm'}`;
}

/** ₹ in lakh / crore shorthand: ₹2.4 L, ₹3 L, ₹1.25 Cr, ₹45,000. */
export function formatInrShort(n: number): string {
  if (n >= 1e7) return `₹${+(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${+(n / 1e5).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function itemText(i: unknown): string {
  if (i == null || typeof i !== 'object') return String(i);
  const o = i as { name?: unknown; quantity?: unknown; unit?: unknown };
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const qty = o.quantity != null && o.quantity !== '' ? ` ×${o.quantity}${o.unit ? ` ${o.unit}` : ''}` : o.unit ? ` ${o.unit}` : '';
  return `${name}${qty}`.trim() || JSON.stringify(i);
}

function scalar(v: unknown): string {
  if (v == null || v === '') return 'none';
  if (typeof v === 'string') return clip(v.trim());
  if (Array.isArray(v)) return clip(v.map(itemText).join(', '));
  return clip(String(v));
}

function formatPair(field: string, c: FieldChange): string {
  const fd = toDate(c.from), td = toDate(c.to);
  if (field.endsWith('At') && (fd || td)) {
    const withYear = !!fd && !!td && new Date(fd.getTime() + IST_MS).getUTCFullYear() !== new Date(td.getTime() + IST_MS).getUTCFullYear();
    return `${fd ? fmtIst(fd, withYear) : 'none'} → ${td ? `${fmtIst(td, withYear)} IST` : 'none'}`;
  }
  if (field === 'emdAmount' || field === 'estimatedValue') {
    const f = (v: unknown) => (typeof v === 'number' ? (v === 0 && field === 'emdAmount' ? 'Nil' : formatInrShort(v)) : 'none');
    return `${f(c.from)} → ${f(c.to)}`;
  }
  if (field === 'epbgPercent') {
    const f = (v: unknown) => (typeof v === 'number' ? `${v}%` : 'none');
    return `${f(c.from)} → ${f(c.to)}`;
  }
  if (field === 'quantity') {
    const f = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-IN') : 'none');
    return `${f(c.from)} → ${f(c.to)}`;
  }
  if (field === 'documentUrl') return 'replaced';
  return `${scalar(c.from)} → ${scalar(c.to)}`;
}

/**
 * "Bid end date: 19 Nov, 3:00 pm → 26 Nov, 3:00 pm IST · Quantity: 75 → 90 · EMD: ₹2.4 L → ₹3 L".
 * Only corrigendum (material) fields are listed, in a fixed order; unchanged-in-substance fields are dropped.
 * Returns '' when nothing material changed.
 */
export function summariseChanges(changes: Record<string, FieldChange>): string {
  const parts: string[] = [];
  for (const field of CORRIGENDUM_FIELDS) {
    const c = changes[field];
    if (!c || sameValue(c.from, c.to)) continue;
    parts.push(`${LABEL[field] ?? field}: ${formatPair(field, c)}`);
  }
  return parts.join(' · ');
}
