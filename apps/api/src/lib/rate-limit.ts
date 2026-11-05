/**
 * Postgres-backed attempt counters for authentication rate limiting (002/FR-010, FR-011).
 *
 * State lives in `auth_attempts` (not memory) so limits hold across Worker isolates and Node processes
 * (NFR-002). Each (key, kind) row is a fixed window: the first hit opens it at `now`; hits inside the
 * window increment `count`; the first hit after the window has elapsed starts a fresh window at 1.
 *
 *   const limited = await check(db, email, 'login_email', LOGIN_EMAIL_LIMIT, now);
 *   if (limited) throw rateLimited(limited.retryAfterSec);
 *   …on failure:  await hit(db, email, 'login_email', LOGIN_EMAIL_LIMIT, now);
 *   …on success:  await reset(db, email, 'login_email');
 *
 * Keys are normalised emails or client IPs — never secrets.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { authAttempts, type Db } from '@tp/db';
import { HttpError } from './errors';

export type AttemptKind = 'login_email' | 'login_ip' | 'reset_email';

export interface LimitOptions {
  /** Maximum attempts allowed in one window; the attempt after that is rejected. */
  limit: number;
  windowMs: number;
}

export interface LimitState {
  count: number;
  windowStart: Date;
  /** True when the window is full (further attempts must be rejected). */
  limited: boolean;
  /** Seconds until the window resets (≥ 1). */
  retryAfterSec: number;
}

const FIFTEEN_MIN = 15 * 60 * 1000;
/** Failed sign-ins per normalised email (login, accept-invite, change password). */
export const LOGIN_EMAIL_LIMIT: LimitOptions = { limit: 10, windowMs: FIFTEEN_MIN };
/** Failed sign-ins per client IP. */
export const LOGIN_IP_LIMIT: LimitOptions = { limit: 30, windowMs: FIFTEEN_MIN };
/** Password reset requests per email. */
export const RESET_EMAIL_LIMIT: LimitOptions = { limit: 3, windowMs: 60 * 60 * 1000 };

function toState(count: number, windowStart: Date, opts: LimitOptions, now: Date): LimitState {
  const remainingMs = windowStart.getTime() + opts.windowMs - now.getTime();
  return { count, windowStart, limited: count >= opts.limit, retryAfterSec: Math.max(1, Math.ceil(remainingMs / 1000)) };
}

/** Current state of a counter, or null when there is no open window. Does not modify anything. */
export async function check(db: Db, key: string, kind: AttemptKind, opts: LimitOptions, now: Date): Promise<LimitState | null> {
  const [row] = await db.select().from(authAttempts).where(and(eq(authAttempts.key, key), eq(authAttempts.kind, kind)));
  if (!row || row.windowStart.getTime() + opts.windowMs <= now.getTime()) return null;
  return toState(row.count, row.windowStart, opts, now);
}

/** Record one attempt atomically (single upsert) and return the new state. */
export async function hit(db: Db, key: string, kind: AttemptKind, opts: LimitOptions, now: Date): Promise<LimitState> {
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - opts.windowMs).toISOString();
  const expired = sql`${authAttempts.windowStart} <= ${cutoffIso}::timestamptz`;
  const [row] = await db.insert(authAttempts).values({ key, kind, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: [authAttempts.key, authAttempts.kind],
      set: {
        count: sql`case when ${expired} then 1 else ${authAttempts.count} + 1 end`,
        windowStart: sql`case when ${expired} then ${nowIso}::timestamptz else ${authAttempts.windowStart} end`,
      },
    })
    .returning({ count: authAttempts.count, windowStart: authAttempts.windowStart });
  return toState(row.count, row.windowStart, opts, now);
}

/** Clear a counter (e.g. after a successful sign-in). */
export async function reset(db: Db, key: string, kind: AttemptKind): Promise<void> {
  await db.delete(authAttempts).where(and(eq(authAttempts.key, key), eq(authAttempts.kind, kind)));
}

/** 429 `rate_limited` with a `Retry-After` header and "Try again in N minutes." */
export function rateLimited(retryAfterSec: number): HttpError {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return new HttpError(
    429, 'rate_limited', `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    { retryAfter: retryAfterSec }, { 'Retry-After': String(retryAfterSec) },
  );
}

/**
 * Client IP: `cf-connecting-ip` (Cloudflare) → first `x-forwarded-for` hop → null.
 * Null means "unknown" (e.g. plain local Node without a proxy); callers skip per-IP limits then, so all
 * such clients do not share one bucket.
 */
export function clientIp(c: Context): string | null {
  const cf = c.req.header('cf-connecting-ip')?.trim();
  if (cf) return cf.slice(0, 64);
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return xff ? xff.slice(0, 64) : null;
}

/**
 * Guard for failed-credential flows (login, accept-invite existing user, change password).
 * `assert` throws 429 when the email or IP window is full; `fail` records a failure; `succeed` clears the
 * email counter (the IP counter is kept so one valid account cannot reset an attacker's IP budget).
 */
export function credentialLimiter(db: Db, email: string, ip: string | null, now: Date) {
  return {
    async assert() {
      const [e, i] = await Promise.all([
        check(db, email, 'login_email', LOGIN_EMAIL_LIMIT, now),
        ip ? check(db, ip, 'login_ip', LOGIN_IP_LIMIT, now) : Promise.resolve(null),
      ]);
      const blocked = [e, i].filter((s): s is LimitState => !!s?.limited);
      if (blocked.length) throw rateLimited(Math.max(...blocked.map((s) => s.retryAfterSec)));
    },
    async fail() {
      await hit(db, email, 'login_email', LOGIN_EMAIL_LIMIT, now);
      if (ip) await hit(db, ip, 'login_ip', LOGIN_IP_LIMIT, now);
    },
    async succeed() {
      await reset(db, email, 'login_email');
    },
  };
}
