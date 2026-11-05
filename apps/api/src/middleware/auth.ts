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
import { API_TOKEN_READ_ONLY_MESSAGE } from '@tp/core/contracts/auth';
import { roleAtLeast } from '@tp/core/contracts/common';
import type { Role } from '@tp/db';
import { HttpError, forbidden, unauthorized } from '../lib/errors';
import { resolveAuth, type ResolvedAuth } from '../lib/session';
import { limitAuthenticated, limitUnauthenticated } from './rate-limit';
import type { AppEnv } from '../types';

/** Methods a read-only API token may use (HEAD is GET without a body; Hono serves it from GET routes). */
const READ_METHODS = new Set(['GET', 'HEAD']);

const isReadOnlyToken = (auth: Pick<ResolvedAuth, 'kind' | 'tokenScope'>) => auth.kind === 'token' && auth.tokenScope !== 'full';

/**
 * 006/FR-074: a request authenticated by an API token whose scope is not `'full'` may only read. Fails closed: an
 * unknown/missing scope value counts as read-only. Cookie sessions are never affected.
 */
export function assertWritable(c: Context<AppEnv>, auth: Pick<ResolvedAuth, 'kind' | 'tokenScope'>): void {
  if (!isReadOnlyToken(auth) || READ_METHODS.has(c.req.method.toUpperCase())) return;
  throw new HttpError(403, 'read_only_token', API_TOKEN_READ_ONLY_MESSAGE);
}

/**
 * 006/FR-074: for GET routes with side effects (outbound calls, cache writes, quota use) — refuse read-only tokens
 * with the same 403 as the global guard. Call after requireAuth/requireRole (needs the resolved token scope).
 */
export function refuseReadOnlyToken(c: Context<AppEnv>): void {
  if (isReadOnlyToken({ kind: c.var.authKind, tokenScope: c.var.apiTokenScope })) throw new HttpError(403, 'read_only_token', API_TOKEN_READ_ONLY_MESSAGE);
}

/**
 * 006/FR-074 global guard (mounted on `/api/*` right after `ipLimit`, app.ts): refuses every non-GET request that
 * carries a read-only token, including routes that do not use requireAuth (e.g. `/auth/logout`). Uses the
 * credentials `ipLimit` already resolved (no extra query). Refusals go through `authenticate`, so they still count
 * against the token's `api.user` rate limit before the 403.
 */
export const readOnlyTokenGuard = createMiddleware<AppEnv>(async (c, next) => {
  const auth = c.var.preAuth?.auth;
  if (auth && isReadOnlyToken(auth) && !READ_METHODS.has(c.req.method.toUpperCase())) {
    await authenticate(c); // throws: 403 read_only_token (or 429 when over api.user)
    assertWritable(c, auth); // unreachable unless authenticate changes; keeps the guard fail-closed
  }
  await next();
});

async function authenticate(c: Context<AppEnv>) {
  if (c.var.user && c.var.org) {
    assertWritable(c, { kind: c.var.authKind, tokenScope: c.var.apiTokenScope });
    return;
  }
  // Reuse what the global rate limiter already resolved (one session/token lookup per request).
  const auth = c.var.preAuth ? c.var.preAuth.auth : await resolveAuth(c);
  if (!auth || !auth.org || !auth.role) {
    // 008/FR-019: unusable credentials count against the client IP (`api.ip`) — once (ipLimit may already have).
    await limitUnauthenticated(c);
    if (!auth) throw unauthorized();
    throw new HttpError(403, 'no_organization', 'You are not a member of any organization. Ask an owner to invite you.');
  }
  c.set('user', auth.user);
  c.set('org', auth.org);
  c.set('role', auth.role);
  c.set('authKind', auth.kind);
  c.set('sessionId', auth.sessionId);
  c.set('apiTokenId', auth.apiTokenId);
  c.set('apiTokenScope', auth.tokenScope);
  // 008/FR-019 `api.user`: once per request, per user (or per API token).
  await limitAuthenticated(c);
  // 006/FR-074 (defence in depth: the global readOnlyTokenGuard normally refuses first).
  assertWritable(c, auth);
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
