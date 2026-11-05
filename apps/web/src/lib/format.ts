/**
 * Indian formatting helpers: ₹ with lakh/crore grouping, IST dates, relative times.
 * All dates from the API are ISO strings; we always render in Asia/Kolkata.
 */
const IST = 'Asia/Kolkata';

const inrFull = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const numIN = new Intl.NumberFormat('en-IN');

export type MoneyInput = number | string | bigint | null | undefined;

function toNumber(v: MoneyInput): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** formatINR(12345678) → "₹1,23,45,678"; formatINR(12345678, { compact: true }) → "₹1.23 Cr" */
export function formatINR(value: MoneyInput, opts: { compact?: boolean; fallback?: string } = {}): string {
  const n = toNumber(value);
  if (n === null) return opts.fallback ?? '—';
  if (opts.compact) return formatINRCompact(n);
  return inrFull.format(Math.round(n)).replace(/^₹\s?/, '₹');
}

/** "₹1.2 Cr", "₹45 L", "₹8.5 K", "₹950" */
export function formatINRCompact(value: MoneyInput): string {
  const n = toNumber(value);
  if (n === null) return '—';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const fmt = (x: number) => {
    const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
    return s.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  };
  if (a >= 1e7) return `${sign}₹${fmt(a / 1e7)} Cr`;
  if (a >= 1e5) return `${sign}₹${fmt(a / 1e5)} L`;
  if (a >= 1e3) return `${sign}₹${fmt(a / 1e3)} K`;
  return `${sign}₹${Math.round(a)}`;
}

export function formatNumberIN(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : numIN.format(value);
}

function toDate(d: string | number | Date | null | undefined): Date | null {
  if (d === null || d === undefined || d === '') return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "04 Nov 2026" or with time "04 Nov 2026, 3:00 pm IST" */
export function formatDateIST(d: string | number | Date | null | undefined, opts: { time?: boolean; fallback?: string } = {}): string {
  const date = toDate(d);
  if (!date) return opts.fallback ?? '—';
  const datePart = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  if (!opts.time) return datePart;
  const timePart = new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true }).format(date).toLowerCase();
  return `${datePart}, ${timePart} IST`;
}

export function formatTimeIST(d: string | number | Date | null | undefined): string {
  const date = toDate(d);
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true }).format(date).toLowerCase();
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 hours ago", "in 2 days", "just now" */
export function relativeTime(d: string | number | Date | null | undefined, now: Date = new Date()): string {
  const date = toDate(d);
  if (!date) return '—';
  const diff = (date.getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800], ['month', 2629800], ['year', 31557600],
  ];
  let unit: Intl.RelativeTimeFormatUnit = 'minute';
  let size = 60;
  for (const [u, s] of units) { if (abs >= s) { unit = u; size = s; } }
  return rtf.format(Math.round(diff / size), unit);
}

/** Whole days until a date (negative if past). Uses IST calendar days. */
export function daysUntil(d: string | number | Date | null | undefined, now: Date = new Date()): number | null {
  const date = toDate(d);
  if (!date) return null;
  const key = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const a = Date.parse(key(now));
  const b = Date.parse(key(date));
  return Math.round((b - a) / 86400000);
}

/** Breakdown used by <Countdown/>: "2d 4h", "5h 12m", "closed" */
export function countdownParts(d: string | number | Date | null | undefined, now: Date = new Date()) {
  const date = toDate(d);
  if (!date) return null;
  const ms = date.getTime() - now.getTime();
  const closed = ms <= 0;
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  const label = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return { closed, ms, days, hours, minutes, label, urgent: !closed && ms < 86400000, soon: !closed && ms < 3 * 86400000 };
}

export function pluralize(n: number, one: string, many = `${one}s`) {
  return `${formatNumberIN(n)} ${n === 1 ? one : many}`;
}
