/**
 * Pure dashboard helpers (T016; FR-008) — greeting, KPI deltas, the one-line summary and the empty-org check.
 * Kept free of React so they can be unit-tested (summary.test.ts).
 */
import type { DashboardResponse } from '@tp/core/contracts/experience';
import { pluralize } from '@/lib/format';

/** Hour of the day (0–23) in IST. */
export function istHour(now: Date): number {
  // hourCycle h23 so midnight is 0 (some ICU builds print "24" with hour12:false).
  return Number(now.toLocaleString('en-IN', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }));
}

/** IST-hour greeting: < 05:00 "Working late", < 12:00 "Good morning", < 17:00 "Good afternoon", else "Good evening". */
export function greeting(now: Date): string {
  const h = istHour(now);
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** Percent change vs the previous period; `null` when there is no baseline (prev = 0, cur > 0), `0` when both are 0. */
export function pctDelta(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0;
  return Math.round(((cur - prev) / prev) * 100);
}

/** One-line summary under the greeting: urgent items joined by " · ", else a calm fallback. */
export function summaryLine(d: Pick<DashboardResponse, 'tiles' | 'stats'>): string {
  const parts: string[] = [];
  if (d.tiles.newMatchesToday) parts.push(`${pluralize(d.tiles.newMatchesToday, 'new match', 'new matches')} today`);
  if (d.stats.closingToday) parts.push(`${pluralize(d.stats.closingToday, 'bid')} closing today`);
  if (d.stats.expiredDocs) parts.push(`${pluralize(d.stats.expiredDocs, 'expired document')}`);
  if (!parts.length) {
    return d.tiles.activeBids
      ? `${pluralize(d.tiles.activeBids, 'active bid')} in your pipeline. Nothing urgent right now.`
      : 'Here’s what’s happening on GeM for your business.';
  }
  return `${parts.join(' · ')}.`;
}

/** A brand-new org with nothing to show: not demo, no active bids, no matches and no watchlist yet. */
export function isEmptyOrg(d: Pick<DashboardResponse, 'demo' | 'tiles' | 'recentMatches' | 'setup'>): boolean {
  return !d.demo && d.tiles.activeBids === 0 && d.recentMatches.length === 0 && !d.setup.find((s) => s.key === 'watchlist')?.done;
}

/** "HH:MM" in IST (24 h) — used by the stale-data banner. */
export function istTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' });
}
