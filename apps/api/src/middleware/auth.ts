/**
 * Authentication & authorization middleware (FR-030, FR-031, FR-032).
 *
 *   router.get('/things', requireAuth, handler)                 // any member (viewer+)
 *   router.post('/things', requireRole('analyst'), handler)     // "W" in contracts/api.md
 *   router.post('/things/x', requireRole('bid_manager'), h)     // "M"
 *   router.delete('/things/x', requireRole('owner'), h)         // "O"
 *
 * requireRole implies requireAuth. Always scope queries with `orgId(c)`.
 *
 * ⚠️ Every router is mounted at "/api". Do NOT write `router.use('*', requireAuth)` — that would
 * apply to every API route (including /api/health and /api/auth/login). Attach middleware per
 * route, or with a path prefix: `router.use('/vault/*', requireAuth)`.
 */
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { roleAtLeast } from '@tp/core/contracts/common';
import type { Role } from '@tp/db';
import { HttpError, forbidden, unauthorized } from '../lib/errors';
import { resolveAuth } from '../lib/session';
import type { AppEnv } from '../types';

async function authenticate(c: Context<AppEnv>) {
  if (c.var.user && c.var.org) return;
  const auth = await resolveAuth(c);
  if (!auth) throw unauthorized();
  if (!auth.org || !auth.role) throw new HttpError(403, 'no_organization', 'You are not a member of any organization. Ask an owner to invite you.');
  c.set('user', auth.user);
  c.set('org', auth.org);
  c.set('role', auth.role);
  c.set('authKind', auth.kind);
  c.set('sessionId', auth.sessionId);
  c.set('apiTokenId', auth.apiTokenId);
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  await authenticate(c);
  await next();
});

const ROLE_NAMES: Record<Role, string> = { owner: 'an Owner', bid_manager: 'a Bid Manager', analyst: 'an Analyst', viewer: 'a Viewer' };

export const requireRole = (min: Role) =>
  createMiddleware<AppEnv>(async (c, next) => {
    await authenticate(c);
    if (!roleAtLeast(c.var.role, min)) {
      throw forbidden(min === 'owner' ? 'Only an Owner can do that' : `You need to be at least ${ROLE_NAMES[min]} to do that`);
    }
    await next();
  });

/** Only allow cookie sessions (not API tokens) — e.g. for account-management endpoints. */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  await authenticate(c);
  if (c.var.authKind !== 'session') throw forbidden('This action requires signing in on the web app');
  await next();
});

/** The active organization id. Use it in EVERY org-scoped query (Constitution IV). */
export function orgId(c: Context<AppEnv>): string {
  const org = c.var.org;
  if (!org) throw unauthorized();
  return org.id;
}

export function userId(c: Context<AppEnv>): string {
  const u = c.var.user;
  if (!u) throw unauthorized();
  return u.id;
}

export { roleAtLeast };
