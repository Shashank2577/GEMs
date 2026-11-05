/**
 * Rate-limit middleware (008/FR-018…FR-020) over `AppDeps.rateLimiter` and the rule table `lib/rate-limit-rules.ts`.
 *
 *   router.post('/watchlists/preview', requireAuth, rateLimit('watchlist.preview.user'), handler)
 *
 * Over the limit → 429 `rate_limited` `{details:{rule, retryAfter}}` + `Retry-After`. Under the limit the response
 * carries `RateLimit-Remaining` for the rule. When the counter cannot be written the request is allowed and a `warn`
 * line `rate_limit_unavailable` is logged (fail-open), except rules with `failClosed` (auth) → 503.
 * Per-user/org rules must come after `requireAuth`/`requireRole`; when the subject is unknown (no user, client IP not
 * determinable) the rule is skipped.
 *
 * Global rules: `api.ip` for requests without (valid) credentials (`ipLimit`, mounted in app.ts) and `api.user` for
 * every authenticated request (`limitAuthenticated`, called by middleware/auth.ts once the caller is known).
 *
 * Windows are fixed (aligned to the clock), so a client can send up to 2× the limit across a window boundary
 * (end of one window + start of the next). Accepted for these abuse caps; a sliding window would cost a second
 * counter read per request.
 */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { serviceUnavailable, tooManyRequests } from '../lib/errors';
import { clientIp } from '../lib/client-ip';
import { RATE_LIMIT_RULES, type GenericRuleName, type RateLimitSubject } from '../lib/rate-limit-rules';
import { SESSION_COOKIE, resolveAuth } from '../lib/session';
import type { AppEnv } from '../types';

/** A limiter slower than this is treated as unavailable (the request is not held up by a sick database). */
export const LIMITER_TIMEOUT_MS = 300;
/**
 * Fail-closed (auth) rules wait longer: timing out there answers 503, so a merely slow database must not lock people
 * out of signing up.
 */
export const FAIL_CLOSED_TIMEOUT_MS = 3_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`rate limiter timed out after ${ms} ms`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** One `rate_limit_unavailable` line per rule per 10 s (an outage would otherwise log on every request). */
const WARN_EVERY_MS = 10_000;
const lastWarn = new Map<string, { at: number; suppressed: number }>();
/** Null when this warning should be skipped, else how many were skipped since the last one. */
function sampleWarning(rule: string): number | null {
  const now = Date.now();
  const w = lastWarn.get(rule);
  if (w && now - w.at < WARN_EVERY_MS) { w.suppressed++; return null; }
  lastWarn.set(rule, { at: now, suppressed: 0 });
  return w?.suppressed ?? 0;
}
/** Test hook: forget warning sampling state. */
export function resetRateLimitWarnings(): void { lastWarn.clear(); }

function subjectKey(c: Context<AppEnv>, subject: RateLimitSubject): string | null {
  switch (subject) {
    case 'ip': return clientIp(c, c.var.deps.config.trustProxy);
    case 'user': return c.var.user?.id ?? null;
    case 'org': return c.var.org?.id ?? null;
    case 'user_or_token': return c.var.apiTokenId ? `token:${c.var.apiTokenId}` : c.var.user ? `user:${c.var.user.id}` : null;
    case 'email': return null; // email rules are enforced by lib/rate-limit.ts (auth-attempts engine)
  }
}

/** Count this request against `name`; throws 429 when over the limit (or 503 for fail-closed rules on limiter errors). */
export async function applyRateLimit(c: Context<AppEnv>, name: GenericRuleName): Promise<void> {
  const rule = RATE_LIMIT_RULES[name];
  const subject = subjectKey(c, rule.subject);
  if (!subject) return;
  const { rateLimiter, clock, logger } = c.var.deps;
  let r;
  try {
    r = await withTimeout(rateLimiter.hit(`${name}:${subject}`, rule.limit, rule.windowSec, clock.now()),
      rule.failClosed ? FAIL_CLOSED_TIMEOUT_MS : LIMITER_TIMEOUT_MS);
  } catch (e) {
    const suppressed = sampleWarning(name);
    if (suppressed !== null) logger.warn('rate_limit_unavailable', { rule: name, rid: c.var.requestId, error: (e as Error)?.message, suppressed });
    if (rule.failClosed) throw serviceUnavailable('service_unavailable', 'This is temporarily unavailable. Please try again in a minute.', { reason: 'rate_limit_unavailable' });
    return;
  }
  if (!r.allowed) throw tooManyRequests(name, r.retryAfterSec);
  c.header('RateLimit-Remaining', String(r.remaining));
}

/** Route middleware for one rule of the table. */
export const rateLimit = (name: GenericRuleName) =>
  createMiddleware<AppEnv>(async (c, next) => {
    await applyRateLimit(c, name);
    await next();
  });

/** True when the request carries a session cookie or a Bearer token (it is then limited per user once authenticated). */
export function hasCredentials(c: Context<AppEnv>): boolean {
  return /^Bearer\s+\S/i.test(c.req.header('authorization') ?? '') || !!getCookie(c, SESSION_COOKIE);
}

/** `api.ip` at most once per request. */
async function countIp(c: Context<AppEnv>): Promise<void> {
  if (c.var.ipCounted) return;
  c.set('ipCounted', true);
  await applyRateLimit(c, 'api.ip');
}

/**
 * Global `api.ip` (every /api request except `/api/health`):
 * - no credentials → counted against the client IP;
 * - credentials → resolved here once (cached in `c.var.preAuth` for requireAuth) and counted against the IP when
 *   they do not resolve to a member, so forged cookies on public routes are limited too. Valid credentials are
 *   limited per user (`api.user`) when the route authenticates.
 */
export const ipLimit = createMiddleware<AppEnv>(async (c, next) => {
  if (!/\/api\/health\/?$/.test(c.req.path)) {
    if (!hasCredentials(c)) await countIp(c);
    else {
      const auth = await resolveAuth(c);
      c.set('preAuth', { auth });
      if (!auth || !auth.org || !auth.role) await countIp(c);
    }
  }
  await next();
});

/** `api.user` for an authenticated caller (middleware/auth.ts, once per request). */
export async function limitAuthenticated(c: Context<AppEnv>): Promise<void> {
  await applyRateLimit(c, 'api.user');
}

/** `api.ip` for credentials that did not authenticate — only when credentials were sent, and only once. */
export async function limitUnauthenticated(c: Context<AppEnv>): Promise<void> {
  if (hasCredentials(c)) await countIp(c);
}
