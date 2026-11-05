/**
 * Generic fixed-window rate limiter (008/FR-017) behind `AppDeps.rateLimiter`.
 *
 *   const r = await hit(db, 'watchlist.preview.user:<userId>', 30, 60, now);   // one upsert
 *   if (!r.allowed) throw tooManyRequests(rule, r.retryAfterSec);
 *
 * Windows are aligned to multiples of `windowSec` since the epoch, so every isolate/process computes the same
 * `window_start` and one `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count` both opens and counts
 * a window atomically. Rows of past windows are dead and pruned by `pruneRateLimits`.
 *
 * Not to be confused with `lib/rate-limit.ts` (spec 002): the auth-failure counters (`auth_attempts`, reserve before
 * PBKDF2, reset on success). Rules for both live in `lib/rate-limit-rules.ts`.
 */
import { eq, lt, sql } from 'drizzle-orm';
import { rateLimits, type Db } from '@tp/db';
import type { RateLimitResult, RateLimiter } from '../deps';

/** Start of the aligned window of `windowSec` containing `now`. */
export function windowStartOf(now: Date, windowSec: number): Date {
  const ms = windowSec * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

function result(count: number, limit: number, windowStart: Date, windowSec: number, now: Date): RateLimitResult {
  const endMs = windowStart.getTime() + windowSec * 1000;
  return {
    count, limit, allowed: count <= limit, remaining: Math.max(0, limit - count),
    retryAfterSec: Math.max(1, Math.ceil((endMs - now.getTime()) / 1000)),
  };
}

/** Count one request against `key` (single atomic upsert) and report whether it is within `limit`. */
export async function hit(db: Db, key: string, limit: number, windowSec: number, now: Date): Promise<RateLimitResult> {
  const windowStart = windowStartOf(now, windowSec);
  const [row] = await db.insert(rateLimits).values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  return result(row!.count, limit, windowStart, windowSec, now);
}

/** Forget every window of `key`. */
export async function resetKey(db: Db, key: string): Promise<void> {
  await db.delete(rateLimits).where(eq(rateLimits.key, key));
}

/** Longest window in the rule table (1 h); anything older is dead. */
const MAX_WINDOW_MS = 60 * 60 * 1000;

/** Scheduled cleanup: delete windows that ended more than an hour ago. */
export async function pruneRateLimits(db: Db, now: Date): Promise<number> {
  const rows = await db.delete(rateLimits).where(lt(rateLimits.windowStart, new Date(now.getTime() - 2 * MAX_WINDOW_MS)))
    .returning({ key: rateLimits.key });
  return rows.length;
}

/** Postgres-backed limiter used by the Worker and the Node server. */
export function createPgRateLimiter(db: Db): RateLimiter {
  return { hit: (key, limit, windowSec, now) => hit(db, key, limit, windowSec, now), reset: (key) => resetKey(db, key) };
}

/** In-process limiter with the same window semantics (unit tests). */
export function createMemoryRateLimiter(): RateLimiter & { readonly size: number } {
  const counts = new Map<string, number>();
  return {
    async hit(key, limit, windowSec, now) {
      const ws = windowStartOf(now, windowSec);
      const k = `${key}\u0000${ws.getTime()}`;
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return result(n, limit, ws, windowSec, now);
    },
    async reset(key) {
      for (const k of [...counts.keys()]) if (k.startsWith(`${key}\u0000`)) counts.delete(k);
    },
    get size() { return counts.size; },
  };
}

/** Never limits (default for API tests that are not about limits). */
export const noopRateLimiter: RateLimiter = {
  async hit(_key, limit) { return { count: 0, limit, allowed: true, remaining: limit, retryAfterSec: 1 }; },
  async reset() { /* nothing to forget */ },
};
