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
 * Global rules: `api.ip` for requests without credentials (`ipLimit`, mounted in app.ts) and `api.user` for every
 * authenticated request (`limitAuthenticated`, called by middleware/auth.ts once the caller is known).
 */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { serviceUnavailable, tooManyRequests } from '../lib/errors';
import { clientIp } from '../lib/client-ip';
import { RATE_LIMIT_RULES, type GenericRuleName, type RateLimitSubject } from '../lib/rate-limit-rules';
import { SESSION_COOKIE } from '../lib/session';
import type { AppEnv } from '../types';

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
    r = await rateLimiter.hit(`${name}:${subject}`, rule.limit, rule.windowSec, clock.now());
  } catch (e) {
    logger.warn('rate_limit_unavailable', { rule: name, rid: c.var.requestId, error: (e as Error)?.message });
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

/**
 * Global `api.ip`: every request without credentials, except `/api/health`. Requests with credentials are counted
 * by `api.user` after authentication, or by `api.ip` when the credentials turn out to be invalid (middleware/auth.ts).
 */
export const ipLimit = createMiddleware<AppEnv>(async (c, next) => {
  if (!/\/api\/health\/?$/.test(c.req.path) && !hasCredentials(c)) await applyRateLimit(c, 'api.ip');
  await next();
});

/** Called once per request by middleware/auth.ts: `api.user` for an authenticated caller, `api.ip` for bad credentials. */
export async function limitAuthenticated(c: Context<AppEnv>, authenticated: boolean): Promise<void> {
  await applyRateLimit(c, authenticated ? 'api.user' : 'api.ip');
}
