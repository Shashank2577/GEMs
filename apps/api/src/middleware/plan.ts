/**
 * 008/FR-038: an expired trial makes the workspace read-only. Mounted once in app.ts for every /api route:
 *
 *   GET/HEAD/OPTIONS and the allow-list (`allowedWhenExpired`, @tp/core/contracts/plans) → pass;
 *   other writes by a member of a trial org whose `trial_ends_at` has passed → 402 `plan_expired`.
 *
 * Routes attach their own auth per route, so for a blocked-candidate write this middleware looks the caller up itself
 * (session cookie or API token). It deliberately does NOT store the result in the context: the route's
 * `requireAuth`/`requireRole` still runs its full authentication (incl. per-user rate limits). Unauthenticated writes
 * pass through and get the route's own 401/403/404. The org row is read on every request, so a plan change by the
 * admin endpoint takes effect on the next request (FR-043).
 */
import { createMiddleware } from 'hono/factory';
import { PLAN_EXPIRED_MESSAGE, allowedWhenExpired, isTrialExpired } from '@tp/core/contracts/plans';
import { paymentRequired } from '../lib/errors';
import { resolveAuth } from '../lib/session';
import type { AppEnv } from '../types';

export const requireActivePlan = createMiddleware<AppEnv>(async (c, next) => {
  if (allowedWhenExpired(c.req.method, c.req.path)) return next();
  const org = c.var.org ?? (await resolveAuth(c))?.org;
  if (!org) return next();
  if (isTrialExpired(org, c.var.deps.clock.now())) {
    throw paymentRequired('plan_expired', PLAN_EXPIRED_MESSAGE(org.trialEndsAt!), { plan: 'trial', trialEndsAt: new Date(org.trialEndsAt!).toISOString() });
  }
  return next();
});
