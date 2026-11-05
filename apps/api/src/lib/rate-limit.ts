/**
 * Postgres-backed attempt counters for authentication rate limiting (002/FR-010, FR-011).
 *
 * State lives in `auth_attempts` (not memory) so limits hold across Worker isolates and Node processes
 * (NFR-002). Each (key, kind) row is a FIXED window: the first hit opens it at `now`; hits inside the
 * window increment `count`; the first hit after the window has elapsed starts a fresh window at 1.
 *
 * Attempts are RESERVED before the expensive check (one atomic upsert per counter), so a parallel burst
 * cannot get more than `limit` attempts through:
 *
 *   const limiter = credentialLimiter(db, email, ip, now);
 *   await limiter.reserve();        // 429 when this attempt is over the email or IP limit
 *   …verify password…
 *   on success: await limiter.succeed();   // email counter cleared, IP reservation released
 *
 * Keys are normalised emails or client IPs — never secrets.
 */
import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { authAttempts, passwordResets, type Db } from '@tp/db';
import type { TrustProxy } from '../env';
import { HttpError } from './errors';

export type AttemptKind = 'login_email' | 'login_ip' | 'reset_email' | 'reset_ip' | 'test_alert';

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
/** Password reset requests per client IP. */
export const RESET_IP_LIMIT: LimitOptions = { limit: 20, windowMs: 60 * 60 * 1000 };
/** "Send a test alert" per user (002/FR-034). */
export const TEST_ALERT_LIMIT: LimitOptions = { limit: 1, windowMs: 60 * 1000 };
/** Longest window in use; rows older than this are dead and pruned by the scheduled job. */
const MAX_WINDOW_MS = 60 * 60 * 1000;

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

/**
 * Record one attempt atomically (single upsert) and return the new state. `over` is true when this
 * attempt itself exceeds the limit (count > limit) and must be rejected.
 */
export async function hit(db: Db, key: string, kind: AttemptKind, opts: LimitOptions, now: Date): Promise<LimitState & { over: boolean }> {
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
  return { ...toState(row.count, row.windowStart, opts, now), over: row.count > opts.limit };
}

/** Give one attempt back (e.g. a successful sign-in should not consume the IP budget). */
export async function release(db: Db, key: string, kind: AttemptKind): Promise<void> {
  await db.update(authAttempts).set({ count: sql`greatest(${authAttempts.count} - 1, 0)` })
    .where(and(eq(authAttempts.key, key), eq(authAttempts.kind, kind)));
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
 * Client IP, read only from headers set by a proxy we trust (config `TRUST_PROXY`):
 * - `cloudflare` (the Worker default): `cf-connecting-ip`, which Cloudflare always overwrites;
 * - `xff`: the first `x-forwarded-for` hop (Node behind a reverse proxy that sets the header);
 * - `none` (Node default): null — headers could be forged by the client.
 * Null means "unknown": callers skip per-IP limits so all such clients do not share one bucket; the
 * per-email limits still apply.
 */
export function clientIp(c: Context, trust: TrustProxy): string | null {
  if (trust === 'cloudflare') return c.req.header('cf-connecting-ip')?.trim().slice(0, 64) || null;
  if (trust === 'xff') return c.req.header('x-forwarded-for')?.split(',')[0]?.trim().slice(0, 64) || null;
  return null;
}

/**
 * Guard for credential checks (login, accept-invite existing user, change password).
 * `reserve` counts this attempt against the email and IP windows BEFORE the password is verified and
 * throws 429 when either is over the limit (so the 11th attempt fails even with the right password, and
 * parallel bursts cannot exceed the cap). `succeed` clears the email counter and releases the IP
 * reservation (the IP counter is not reset, so one valid account cannot clear an attacker's IP budget).
 */
export function credentialLimiter(db: Db, email: string, ip: string | null, now: Date) {
  return {
    async reserve() {
      const [e, i] = await Promise.all([
        hit(db, email, 'login_email', LOGIN_EMAIL_LIMIT, now),
        ip ? hit(db, ip, 'login_ip', LOGIN_IP_LIMIT, now) : Promise.resolve(null),
      ]);
      const blocked = [e, i].filter((s): s is LimitState & { over: boolean } => !!s?.over);
      if (blocked.length) throw rateLimited(Math.max(...blocked.map((s) => s.retryAfterSec)));
    },
    async succeed() {
      await reset(db, email, 'login_email');
      if (ip) await release(db, ip, 'login_ip');
    },
  };
}

/** Scheduled cleanup: dead attempt windows (> 1 h) and reset links used or expired more than a day ago. */
export async function pruneAuthState(db: Db, now: Date): Promise<{ attempts: number; resets: number }> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const attempts = await db.delete(authAttempts)
    .where(lt(authAttempts.windowStart, new Date(now.getTime() - MAX_WINDOW_MS))).returning({ key: authAttempts.key });
  const resets = await db.delete(passwordResets)
    .where(or(and(isNotNull(passwordResets.usedAt), lt(passwordResets.usedAt, dayAgo)), lt(passwordResets.expiresAt, dayAgo)))
    .returning({ id: passwordResets.id });
  return { attempts: attempts.length, resets: resets.length };
}
