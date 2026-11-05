/**
 * 002/FR-022, NFR-008, SC-003 — table-driven role matrix (T051).
 *
 * Every mutating route registered on the Hono app × {viewer, analyst, bid_manager, owner}:
 *   - below the route's minimum role → 403 `forbidden` with the FR-022 message;
 *   - at/above it                    → anything but 403 (ids are random, so 400/404 are expected and fine).
 * The guard at the bottom fails when a mutating route is registered without a matrix entry (or an entry is stale),
 * so a new endpoint cannot ship without deciding its minimum role.
 *
 * Adding a route: add ONE line to MATRIX, e.g.
 *   { method: 'POST', path: '/api/org/invitations/:id/resend', min: 'bid_manager' },
 * `min` is a role (requireRole/requireAuth), 'session' (requireSession: cookie only, any role) or 'public' (no auth).
 *
 * Scope: this matrix tests the ROUTE GATE only (requireRole / requireAuth / requireSession). Checks made inside
 * handlers (e.g. only an Owner may invite an Owner, last-owner protection, org scoping) are covered by auth.test.ts
 * and isolation.test.ts.
 * Minimums follow 002/FR-022. Two differ from the older 001 contracts/api.md table, which was updated to match:
 * `POST /analyses/:id/override` is Bid Manager+ ("overrides" in FR-022), and `POST /workspaces/:id/comments` is
 * Analyst+ (tender work).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@tp/db';
import { createTestContext, request, seedOrgWithRoles, type RequestOptions, type SignedUp, type TestContext } from './helpers';

type Min = Role | 'session' | 'public';
interface Entry {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Hono route path exactly as registered (with `:params`). */
  path: string;
  min: Min;
  /** Request body (default `{}`); `null` sends no body. */
  json?: unknown;
  /** The call has a lasting effect on the caller (e.g. leaving the org) — run it against a fresh org. */
  fresh?: true;
}

const MATRIX: Entry[] = [
  // ── auth (public) ──
  { method: 'POST', path: '/api/auth/signup', min: 'public' },
  { method: 'POST', path: '/api/auth/login', min: 'public' },
  { method: 'POST', path: '/api/auth/logout', min: 'public', json: null },
  { method: 'POST', path: '/api/auth/forgot-password', min: 'public' },
  { method: 'POST', path: '/api/auth/reset-password', min: 'public' },
  { method: 'POST', path: '/api/auth/accept-invite', min: 'public' },
  // ── account (own data, any member) ──
  { method: 'POST', path: '/api/auth/switch-org', min: 'session' },
  { method: 'PATCH', path: '/api/me', min: 'viewer' },
  { method: 'POST', path: '/api/me/password', min: 'session' },
  { method: 'PUT', path: '/api/me/notification-prefs', min: 'viewer' },
  { method: 'POST', path: '/api/me/notifications/test', min: 'session' },
  { method: 'POST', path: '/api/me/api-tokens', min: 'session' },
  { method: 'DELETE', path: '/api/me/api-tokens/:id', min: 'viewer' },
  { method: 'POST', path: '/api/me/sessions/revoke-others', min: 'session' },
  { method: 'DELETE', path: '/api/me/sessions/:id', min: 'session' },
  // ── organization ──
  { method: 'PATCH', path: '/api/org', min: 'bid_manager' },
  { method: 'POST', path: '/api/org/invitations', min: 'bid_manager' },
  { method: 'DELETE', path: '/api/org/invitations/:id', min: 'bid_manager' },
  { method: 'POST', path: '/api/org/invitations/:id/resend', min: 'bid_manager' },
  { method: 'DELETE', path: '/api/org/members/me', min: 'session', fresh: true },
  { method: 'PATCH', path: '/api/org/members/:userId', min: 'owner' },
  { method: 'DELETE', path: '/api/org/members/:userId', min: 'owner' },
  // ── identify ──
  { method: 'POST', path: '/api/tenders/:id/seen', min: 'viewer' },
  { method: 'POST', path: '/api/tenders/:id/dismiss', min: 'viewer' },
  { method: 'POST', path: '/api/watchlists/preview', min: 'viewer' }, // read-only preview
  { method: 'POST', path: '/api/watchlists', min: 'analyst' },
  { method: 'PATCH', path: '/api/watchlists/:id', min: 'analyst' },
  { method: 'DELETE', path: '/api/watchlists/:id', min: 'analyst' },
  { method: 'POST', path: '/api/views', min: 'viewer' }, // personal saved views (own, per user)
  { method: 'PATCH', path: '/api/views/:id', min: 'viewer' },
  { method: 'DELETE', path: '/api/views/:id', min: 'viewer' },
  { method: 'POST', path: '/api/ingestion/run', min: 'bid_manager', json: { pages: 'not-a-number' } },
  { method: 'POST', path: '/api/notifications/unsubscribe', min: 'public', json: null }, // signed token is the credential (003/FR-048)
  { method: 'POST', path: '/api/notifications/read-all', min: 'viewer' },
  { method: 'POST', path: '/api/notifications/:id/read', min: 'viewer' },
  // ── analyse ──
  { method: 'POST', path: '/api/tenders/:id/documents', min: 'analyst' },
  { method: 'DELETE', path: '/api/tenders/:id/documents/:docId', min: 'analyst' },
  { method: 'POST', path: '/api/tenders/:id/documents/:docId/ocr', min: 'analyst' },
  { method: 'POST', path: '/api/tenders/:id/fetch-documents', min: 'analyst' },
  { method: 'POST', path: '/api/tenders/:id/analyse', min: 'analyst' },
  { method: 'POST', path: '/api/analyses/:id/override', min: 'bid_manager' },
  { method: 'POST', path: '/api/analyses/:id/rescore', min: 'analyst' },
  { method: 'PUT', path: '/api/scoring-weights', min: 'bid_manager' },
  // ── profile & vault ──
  { method: 'PUT', path: '/api/profile', min: 'analyst' },
  { method: 'POST', path: '/api/past-contracts', min: 'analyst' },
  { method: 'PATCH', path: '/api/past-contracts/:id', min: 'analyst' },
  { method: 'DELETE', path: '/api/past-contracts/:id', min: 'analyst' },
  { method: 'POST', path: '/api/vault/reminders/run', min: 'bid_manager' },
  { method: 'POST', path: '/api/vault', min: 'analyst' },
  { method: 'PATCH', path: '/api/vault/:id', min: 'analyst' },
  { method: 'PUT', path: '/api/vault/:id/file', min: 'analyst' },
  { method: 'DELETE', path: '/api/vault/:id', min: 'analyst' },
  // ── apply ──
  { method: 'POST', path: '/api/tenders/:id/workspace', min: 'analyst' },
  { method: 'PATCH', path: '/api/workspaces/:id', min: 'analyst' },
  { method: 'PUT', path: '/api/workspaces/:id/mapping', min: 'analyst' },
  { method: 'POST', path: '/api/workspaces/:id/overrides', min: 'bid_manager' },
  { method: 'DELETE', path: '/api/workspaces/:id/overrides/:itemId', min: 'bid_manager' },
  { method: 'POST', path: '/api/workspaces/:id/comments', min: 'analyst' },
  { method: 'DELETE', path: '/api/workspaces/:id/comments/:commentId', min: 'viewer' }, // author-or-Bid-Manager+ check is in the handler (workspace.test.ts)
  { method: 'PUT', path: '/api/workspaces/:id/assist-values', min: 'analyst' },
  { method: 'POST', path: '/api/workspaces/:id/submitted', min: 'analyst' },
  { method: 'PUT', path: '/api/annexure-templates/:key', min: 'bid_manager' },
  { method: 'DELETE', path: '/api/annexure-templates/:key', min: 'bid_manager' },
  { method: 'POST', path: '/api/workspaces/:id/annexures/:key/preview', min: 'analyst' },
  { method: 'POST', path: '/api/workspaces/:id/packets', min: 'analyst' },
  // ── experience ──
  { method: 'POST', path: '/api/demo/seed', min: 'bid_manager' },
  { method: 'DELETE', path: '/api/demo', min: 'bid_manager' },
  // ── operator (008/FR-042): Bearer ADMIN_TOKEN, never a member session; 404 without it (plan.test.ts) ──
  { method: 'POST', path: '/api/admin/orgs/:id/plan', min: 'public' },
];

const ROLES: Role[] = ['viewer', 'analyst', 'bid_manager', 'owner'];
const RANK: Record<Role, number> = { viewer: 0, analyst: 1, bid_manager: 2, owner: 3 };
const FORBIDDEN_MESSAGE: Record<Exclude<Role, 'viewer'>, string> = {
  analyst: 'You need to be at least an Analyst to do that',
  bid_manager: 'You need to be at least a Bid Manager to do that',
  owner: 'Only an Owner can do that',
};
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** A well-formed id that matches nothing, so allowed calls hit "not found"/validation instead of real data. */
const FAKE_ID = '00000000-0000-4000-8000-00000000abcd';

const key = (e: { method: string; path: string }) => `${e.method} ${e.path}`;
const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, FAKE_ID);
const opts = (e: Entry, auth: RequestOptions): RequestOptions => (e.json === null ? auth : { ...auth, json: e.json ?? {} });

let ctx: TestContext;
type Org = Awaited<ReturnType<typeof seedOrgWithRoles>>;
let org: Org;
const userFor = (o: Org, role: Role): SignedUp =>
  ({ viewer: o.viewer, analyst: o.analyst, bid_manager: o.bidManager, owner: o.owner })[role];

beforeAll(async () => {
  ctx = await createTestContext();
  org = await seedOrgWithRoles(ctx.app, 'Matrix Traders');
});
afterAll(async () => { await ctx?.close(); });

describe('role matrix: every mutating route × every role (FR-022)', () => {
  it.each(MATRIX.map((e) => [key(e), e] as const))('%s', async (_name, e) => {
    const path = concrete(e.path);

    if (e.min === 'public') {
      const r = await request(ctx.app, e.method, path, opts(e, {}));
      expect([401, 403], `${key(e)} must not require auth`).not.toContain(r.status);
      return;
    }

    // Unauthenticated → 401 for every protected route.
    const anon = await request(ctx.app, e.method, path, opts(e, {}));
    expect(anon.status, `${key(e)} without auth`).toBe(401);

    const o = e.fresh ? await seedOrgWithRoles(ctx.app) : org;
    for (const role of ROLES) {
      const r = await request(ctx.app, e.method, path, opts(e, { cookie: userFor(o, role).cookie }));
      const allowed = e.min === 'session' || RANK[role] >= RANK[e.min];
      if (allowed) {
        expect(r.status, `${key(e)} as ${role}: ${r.text}`).not.toBe(403);
        expect(r.status, `${key(e)} as ${role}: ${r.text}`).toBeLessThan(500);
        expect(String(r.body?.error?.message ?? ''), `${key(e)} is not routed`).not.toMatch(/^No API route/);
      } else {
        expect(r.status, `${key(e)} as ${role}: ${r.text}`).toBe(403);
        expect(r.body.error).toEqual({ code: 'forbidden', message: FORBIDDEN_MESSAGE[e.min as Exclude<Role, 'viewer'>] });
      }
    }
  });

  it('session-only routes refuse API tokens (403) even for an owner', async () => {
    const token = (await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: org.owner.cookie, json: { name: 'matrix' } })).body.token as string;
    expect(token).toMatch(/^tp_/);
    for (const e of MATRIX.filter((x) => x.min === 'session')) {
      const r = await request(ctx.app, e.method, concrete(e.path), opts(e, { bearer: token }));
      expect(r.status, key(e)).toBe(403);
      expect(r.body.error.code).toBe('forbidden');
    }
    // and an owner's token passes the role gates of non-session routes
    const r = await request(ctx.app, 'PATCH', '/api/org', { bearer: token, json: {} });
    expect(r.status).toBe(200);
  });
});

describe('006/FR-074 read-only API tokens: every mutating route', () => {
  it('an owner\'s read-only token is 403 read_only_token on every MATRIX route (public ones too); nothing changes', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'Read Only Matrix');
    const created = await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: o.owner.cookie, json: { name: 'ro', scope: 'read' } });
    expect(created.body.scope).toBe('read');
    const token = created.body.token as string;
    for (const e of MATRIX) {
      const r = await request(ctx.app, e.method, concrete(e.path), opts(e, { bearer: token }));
      expect(r.status, `${key(e)}: ${r.text}`).toBe(403);
      expect(r.body.error, key(e)).toEqual({ code: 'read_only_token', message: 'This API token is read-only' });
    }
    // still a member (DELETE /org/members/me was refused), token still reads, org untouched
    const me = await request(ctx.app, 'GET', '/api/auth/me', { bearer: token });
    expect(me.status).toBe(200);
    expect(me.body.org).toMatchObject({ id: o.orgId, name: 'Read Only Matrix' });
    expect((await request(ctx.app, 'GET', '/api/org/members', { cookie: o.owner.cookie })).body.items).toHaveLength(4);
  });
});

describe('matrix completeness guard (SC-003)', () => {
  it('every mutating route registered on the app has exactly one matrix entry, and no entry is stale', () => {
    const registered = new Set<string>();
    for (const r of ctx.app.routes) {
      const method = r.method.toUpperCase();
      // ALL handlers are middleware/fallbacks (`/api/*`); a concrete ALL route would accept mutations, so count it.
      if (MUTATING.has(method) || (method === 'ALL' && !r.path.endsWith('*'))) registered.add(key({ method, path: r.path }));
    }
    const entries = MATRIX.map(key);
    const dupes = entries.filter((k, i) => entries.indexOf(k) !== i);
    expect(dupes, 'duplicate matrix entries').toEqual([]);
    const missing = [...registered].filter((k) => !entries.includes(k));
    expect(missing, 'mutating routes without a role-matrix entry — add them to MATRIX in roles-matrix.test.ts').toEqual([]);
    const stale = entries.filter((k) => !registered.has(k));
    expect(stale, 'matrix entries for routes that no longer exist').toEqual([]);
  });
});
