/** Small formatting helpers for human-readable factor details (Indian conventions). */

/** 1234567 → "12,34,567". */
export function groupIN(n: number): string {
  const neg = n < 0;
  const s = Math.round(Math.abs(n)).toString();
  const out = s.length <= 3 ? s : `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`;
  return neg ? `-${out}` : out;
}

const trim = (x: number) => (Math.round(x * 100) / 100).toString();

/** Compact rupees: ₹2.1 Cr, ₹50 L, ₹96,000. */
export function inr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e7) return `₹${trim(n / 1e7)} Cr`;
  if (a >= 1e5) return `₹${trim(n / 1e5)} L`;
  return `₹${groupIN(n)}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function years(n: number): string {
  const r = Math.round(n * 10) / 10;
  return `${r} ${r === 1 ? 'year' : 'years'}`;
}
