/**
 * Small, dependency-free IST (UTC+05:30, no DST) formatting helpers shared by the API, the PDF
 * packet templates and the web app.
 */

const IST_OFFSET_MS = 330 * 60_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Nov 2026, 3:00 PM IST"; '' for null / invalid input. */
export function dateTimeIST(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const t = new Date(date.getTime() + IST_OFFSET_MS);
  let h = t.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}, ${h}:${String(t.getUTCMinutes()).padStart(2, '0')} ${ampm} IST`;
}

/** The IST calendar day of an instant, `YYYY-MM-DD` (job_runs days, digest dedupe keys). */
export const istDay = (d: Date): string => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The IST hour (0–23) of an instant. */
export const istHour = (d: Date): number => new Date(d.getTime() + IST_OFFSET_MS).getUTCHours();
