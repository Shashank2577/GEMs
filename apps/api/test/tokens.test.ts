/**
 * 002 US5 — API tokens for the Chrome extension: expiry, hints, per-user limit (FR-037) and
 * session-only / membership / role behaviour of bearer tokens (FR-036); 006/FR-074 read-only scope.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { activityLog, apiTokens, organizations } from '@tp/db';
import { assertWritable } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/error';
import type { AppEnv } from '../src/types';
import { API_TOKEN_LIMIT } from '@tp/core/contracts/auth';
import { createTestContext, request, seedOrgWithRoles, signup, type TestContext } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
const START = new Date('2026-11-01T06:00:00.000Z');

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext({ now: START }); });
afterAll(async () => { await ctx?.close(); });

const create = (cookie: string, json: Record<string, unknown>) => request(ctx.app, 'POST', '/api/me/api-tokens', { cookie, json });

describe('002/FR-037 token expiry and hint', () => {
  it('defaults to 90 days, stores a 4-char hint and returns expiresAt/hint in summaries', async () => {
    ctx.clock.set(START);
    const a = await signup(ctx.app);
    const r = await create(a.cookie, { name: 'Chrome extension' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Chrome extension', lastUsedAt: null, hint: r.body.token.slice(-4) });
    expect(r.body.hint).toHaveLength(4);
    expect(r.body.expiresAt).toBe(new Date(START.getTime() + 90 * DAY).toISOString());

    const list = await request(ctx.app, 'GET', '/api/me/api-tokens', { cookie: a.cookie });
    expect(list.body.items[0]).toEqual({
      id: r.body.id, name: 'Chrome extension', createdAt: expect.any(String), lastUsedAt: null,
      expiresAt: r.body.expiresAt, hint: r.body.hint, scope: 'full',
    });
    expect(JSON.stringify(list.body)).not.toContain(r.body.token);
  });

  it('accepts 30, 365 and null (never); rejects other values with 400', async () => {
    ctx.clock.set(START);
    const a = await signup(ctx.app);
    const d30 = await create(a.cookie, { name: '30', expiresInDays: 30 });
    expect(d30.body.expiresAt).toBe(new Date(START.getTime() + 30 * DAY).toISOString());
    const d365 = await create(a.cookie, { name: '365', expiresInDays: 365 });
    expect(d365.body.expiresAt).toBe(new Date(START.getTime() + 365 * DAY).toISOString());
    const never = await create(a.cookie, { name: 'never', expiresInDays: null });
    expect(never.status).toBe(201);
    expect(never.body.expiresAt).toBeNull();
    for (const bad of [7, 0, '90', 400]) {
      const r = await create(a.cookie, { name: 'bad', expiresInDays: bad });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('validation_error');
    }
  });

  it('an expired token returns 401; a never-expiring token keeps working', async () => {
    ctx.clock.set(START);
    const a = await signup(ctx.app);
    const short = (await create(a.cookie, { name: 'short', expiresInDays: 30 })).body.token as string;
    const forever = (await create(a.cookie, { name: 'forever', expiresInDays: null })).body.token as string;
    expect((await request(ctx.app, 'GET', '/api/workspaces', { bearer: short })).status).toBe(200);

    ctx.clock.advance(30 * DAY - 1000);
    expect((await request(ctx.app, 'GET', '/api/workspaces', { bearer: short })).status).toBe(200);
    ctx.clock.advance(1000);
    const expired = await request(ctx.app, 'GET', '/api/workspaces', { bearer: short });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('unauthorized');

    ctx.clock.advance(2000 * DAY);
    expect((await request(ctx.app, 'GET', '/api/workspaces', { bearer: forever })).status).toBe(200);
    ctx.clock.set(START);
  });
});

describe('002/FR-037 at most 10 active tokens per user per org', () => {
  it('the 11th active token is 409 token_limit; revoking or expiry frees a slot; other users/orgs unaffected', async () => {
    ctx.clock.set(START);
    const { owner, analyst, orgId } = await seedOrgWithRoles(ctx.app, 'Limit Co');
    // A paid plan: the clock jumps past the 14-day trial below, which would make the org read-only (008/FR-038).
    await ctx.db.update(organizations).set({ plan: 'pro', trialEndsAt: null }).where(eq(organizations.id, orgId));
    const ids: string[] = [];
    for (let i = 0; i < API_TOKEN_LIMIT; i++) {
      const r = await create(owner.cookie, { name: `t${i}`, expiresInDays: i === 0 ? 30 : 90 });
      expect(r.status).toBe(201);
      ids.push(r.body.id);
    }
    const over = await create(owner.cookie, { name: 'eleven' });
    expect(over.status).toBe(409);
    expect(over.body.error).toEqual({ code: 'token_limit', message: 'You already have 10 tokens. Revoke one first.' });

    // another member of the same org has their own allowance
    expect((await create(analyst.cookie, { name: 'mine' })).status).toBe(201);

    // revoke one → room for one more
    expect((await request(ctx.app, 'DELETE', `/api/me/api-tokens/${ids[1]}`, { cookie: owner.cookie })).status).toBe(200);
    expect((await create(owner.cookie, { name: 'replacement' })).status).toBe(201);
    expect((await create(owner.cookie, { name: 'again' })).status).toBe(409);

    // the 30-day token expiring frees its slot (expired tokens are not active)
    ctx.clock.advance(31 * DAY);
    const relogin = await request(ctx.app, 'POST', '/api/auth/login', { json: { email: owner.email, password: owner.password } });
    expect((await create(relogin.cookie!, { name: 'after expiry' })).status).toBe(201);
    ctx.clock.set(START);
  });
});

describe('002/FR-036 bearer tokens cannot manage the account', () => {
  it('POST /me/api-tokens, /me/password and /auth/switch-org are 403 with a bearer token', async () => {
    const a = await signup(ctx.app);
    const token = (await create(a.cookie, { name: 'ext' })).body.token as string;
    const calls: [string, unknown][] = [
      ['/api/me/api-tokens', { name: 'x' }],
      ['/api/me/password', { currentPassword: a.password, newPassword: 'another-pass-77' }],
      ['/api/auth/switch-org', { orgId: a.me.org.id }],
    ];
    for (const [path, json] of calls) {
      const r = await request(ctx.app, 'POST', path, { bearer: token, json });
      expect(r.status, path).toBe(403);
      expect(r.body.error).toEqual({ code: 'forbidden', message: 'This action requires signing in on the web app' });
    }
    // password unchanged, still only the original token
    expect((await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: a.password } })).status).toBe(200);
    expect((await request(ctx.app, 'GET', '/api/me/api-tokens', { cookie: a.cookie })).body.total).toBe(1);
  });

  it('a token stops working once its owner is removed from the org', async () => {
    const { owner, analyst } = await seedOrgWithRoles(ctx.app, 'Removal Co');
    const token = (await create(analyst.cookie, { name: 'ext' })).body.token as string;
    expect((await request(ctx.app, 'GET', '/api/workspaces', { bearer: token })).status).toBe(200);
    expect((await request(ctx.app, 'DELETE', `/api/org/members/${analyst.me.user.id}`, { cookie: owner.cookie })).status).toBe(200);
    expect((await request(ctx.app, 'GET', '/api/workspaces', { bearer: token })).status).toBe(401);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { bearer: token })).status).toBe(401);
  });

  it('a member removed while creating a token ends up with no token (no 500s, no orphan rows)', async () => {
    for (let i = 0; i < 5; i++) {
      const { owner, analyst, orgId } = await seedOrgWithRoles(ctx.app, `Race Co ${i}`);
      const [created, removed] = await Promise.all([
        create(analyst.cookie, { name: 'racing' }),
        request(ctx.app, 'DELETE', `/api/org/members/${analyst.me.user.id}`, { cookie: owner.cookie }),
      ]);
      expect(removed.status).toBe(200);
      expect([201, 403]).toContain(created.status);
      if (created.status === 403) expect(created.body.error.code).toBe('no_organization');
      const left = await ctx.db.select({ id: apiTokens.id }).from(apiTokens)
        .where(and(eq(apiTokens.orgId, orgId), eq(apiTokens.userId, analyst.me.user.id)));
      expect(left).toHaveLength(0);
    }
  });

  it('a role change applies to the next token request', async () => {
    const { owner, bidManager } = await seedOrgWithRoles(ctx.app, 'Role Change Co');
    const token = (await create(bidManager.cookie, { name: 'ext' })).body.token as string;
    const rename = (name: string) => request(ctx.app, 'PATCH', '/api/org', { bearer: token, json: { name } });
    expect((await rename('Role Change Co 2')).status).toBe(200);

    await request(ctx.app, 'PATCH', `/api/org/members/${bidManager.me.user.id}`, { cookie: owner.cookie, json: { role: 'viewer' } });
    const denied = await rename('Role Change Co 3');
    expect(denied.status).toBe(403);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { bearer: token })).body.role).toBe('viewer');

    await request(ctx.app, 'PATCH', `/api/org/members/${bidManager.me.user.id}`, { cookie: owner.cookie, json: { role: 'bid_manager' } });
    expect((await rename('Role Change Co 4')).status).toBe(200);
  });
});

const READ_ONLY = { code: 'read_only_token', message: 'This API token is read-only' };

describe('006/FR-074 assertWritable (unit)', () => {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.all('/x/:kind/:scope', (c) => {
    const kind = c.req.param('kind') as 'session' | 'token';
    const raw = c.req.param('scope');
    assertWritable(c, { kind, tokenScope: (raw === 'null' ? null : raw) as 'full' | 'read' | null });
    return c.json({ ok: true });
  });
  const call = (method: string, kind: string, scope: string) => app.request(`http://tp.test/x/${kind}/${scope}`, { method });

  it.each(['GET', 'HEAD'])('%s is allowed for every credential kind and scope', async (method) => {
    for (const [kind, scope] of [['token', 'read'], ['token', 'full'], ['token', 'bogus'], ['session', 'null']]) {
      expect((await call(method, kind, scope)).status, `${method} ${kind}/${scope}`).toBe(200);
    }
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s is refused for read (and unknown, fail-closed) token scopes only', async (method) => {
    for (const scope of ['read', 'bogus', 'null']) {
      const r = await call(method, 'token', scope);
      expect(r.status, `${method} token/${scope}`).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('read_only_token');
    }
    expect((await call(method, 'token', 'full')).status).toBe(200);
    expect((await call(method, 'session', 'null')).status).toBe(200); // cookie sessions are never affected
  });
});

describe('006/FR-074 token scope', () => {
  it('defaults to full; scope "read" is stored, returned on create and in the list, and logged', async () => {
    ctx.clock.set(START);
    const a = await signup(ctx.app);
    const full = await create(a.cookie, { name: 'default' });
    expect(full.status).toBe(201);
    expect(full.body.scope).toBe('full');
    const read = await create(a.cookie, { name: 'Extension (read-only)', scope: 'read' });
    expect(read.status).toBe(201);
    expect(read.body.scope).toBe('read');
    const explicitFull = await create(a.cookie, { name: 'full', scope: 'full' });
    expect(explicitFull.body.scope).toBe('full');

    const list = await request(ctx.app, 'GET', '/api/me/api-tokens', { cookie: a.cookie });
    const byName = Object.fromEntries(list.body.items.map((t: any) => [t.name, t.scope]));
    expect(byName).toEqual({ default: 'full', 'Extension (read-only)': 'read', full: 'full' });
    const [row] = await ctx.db.select().from(apiTokens).where(eq(apiTokens.id, read.body.id));
    expect(row.scope).toBe('read');
    const [log] = await ctx.db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, read.body.id), eq(activityLog.action, 'api_token.created'))).orderBy(desc(activityLog.createdAt));
    expect(log.meta).toMatchObject({ scope: 'read' });
  });

  it('rejects unknown scopes with 400 and creates nothing', async () => {
    const a = await signup(ctx.app);
    for (const bad of ['admin', 'READ', 'write', '', null, 1, ['read']]) {
      const r = await create(a.cookie, { name: 'bad', scope: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error.code).toBe('validation_error');
    }
    expect((await request(ctx.app, 'GET', '/api/me/api-tokens', { cookie: a.cookie })).body.total).toBe(0);
  });

  it('a read-only token can GET (and HEAD) but every write is 403 read_only_token, even with a valid cookie alongside', async () => {
    const { owner } = await seedOrgWithRoles(ctx.app, 'Read Only Co');
    const read = (await create(owner.cookie, { name: 'ro', scope: 'read' })).body.token as string;
    for (const path of ['/api/auth/me', '/api/workspaces', '/api/me/api-tokens', '/api/org', '/api/org/members', '/api/me/notification-prefs']) {
      expect((await request(ctx.app, 'GET', path, { bearer: read })).status, path).toBe(200);
    }
    expect((await request(ctx.app, 'HEAD', '/api/workspaces', { bearer: read })).status).toBe(200);

    const writes: [string, string, unknown][] = [
      ['PATCH', '/api/org', { name: 'Renamed by token' }],
      ['PATCH', '/api/me', { name: 'Renamed by token' }],
      ['PUT', '/api/me/notification-prefs', { inApp: false, email: false, whatsapp: false, frequency: 'daily', expiryReminders: false }],
      ['POST', '/api/watchlists', { name: 'w', keywords: ['laptop'] }],
      ['POST', '/api/me/api-tokens', { name: 'escalate', scope: 'full' }],
      ['POST', '/api/auth/logout', undefined],
    ];
    for (const [method, path, json] of writes) {
      const r = await request(ctx.app, method, path, { bearer: read, json });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error, `${method} ${path}`).toEqual(READ_ONLY);
      // the Bearer token wins over the cookie (resolveAuth), so a cookie alongside cannot bypass the scope
      const both = await request(ctx.app, method, path, { bearer: read, cookie: owner.cookie, json });
      expect(both.status, `${method} ${path} + cookie`).toBe(403);
      expect(both.body.error).toEqual(READ_ONLY);
    }
    const me = await request(ctx.app, 'GET', '/api/auth/me', { cookie: owner.cookie });
    expect(me.body.org.name).toBe('Read Only Co');
    expect(me.body.user.name).toBe(owner.me.user.name);
    expect((await request(ctx.app, 'GET', '/api/watchlists', { cookie: owner.cookie })).body.items ?? []).toHaveLength(0);
    expect((await request(ctx.app, 'GET', '/api/me/api-tokens', { cookie: owner.cookie })).body.total).toBe(1);
    // logout with the token did not end the owner's web session
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: owner.cookie })).status).toBe(200);
  });

  it('session cookies and full-scope tokens of the same user keep writing', async () => {
    const { owner } = await seedOrgWithRoles(ctx.app, 'Mixed Scope Co');
    await create(owner.cookie, { name: 'ro', scope: 'read' });
    const full = (await create(owner.cookie, { name: 'full' })).body.token as string;
    expect((await request(ctx.app, 'PATCH', '/api/org', { bearer: full, json: { name: 'Mixed Scope Co 2' } })).status).toBe(200);
    expect((await request(ctx.app, 'PATCH', '/api/org', { cookie: owner.cookie, json: { name: 'Mixed Scope Co 3' } })).status).toBe(200);
  });

  it('the scope cannot be escalated by the token holder (no create, no update route, no self-revoke) — only the web session manages it', async () => {
    const a = await signup(ctx.app);
    const created = await create(a.cookie, { name: 'ro', scope: 'read' });
    const read = created.body.token as string;
    const id = created.body.id as string;
    // no route updates a token: PATCH/PUT are not routed (404) for the cookie, and refused for the read token
    for (const method of ['PATCH', 'PUT']) {
      const viaCookie = await request(ctx.app, method, `/api/me/api-tokens/${id}`, { cookie: a.cookie, json: { scope: 'full' } });
      expect(viaCookie.status, method).toBe(404);
      const viaToken = await request(ctx.app, method, `/api/me/api-tokens/${id}`, { bearer: read, json: { scope: 'full' } });
      expect(viaToken.status, method).toBe(403);
    }
    // POST /me/api-tokens with the read token: refused (read-only first; it is session-only anyway)
    const mintWithToken = await request(ctx.app, 'POST', '/api/me/api-tokens', { bearer: read, json: { name: 'x', scope: 'full' } });
    expect(mintWithToken.body.error).toEqual(READ_ONLY);
    // DELETE (revoke) is a write too
    expect((await request(ctx.app, 'DELETE', `/api/me/api-tokens/${id}`, { bearer: read })).body.error).toEqual(READ_ONLY);
    const rows = await ctx.db.select().from(apiTokens).where(eq(apiTokens.userId, a.me.user.id));
    expect(rows.map((r) => r.scope)).toEqual(['read']);
    // the owner revokes it from the web app → the token stops working (401 on reads and writes)
    expect((await request(ctx.app, 'DELETE', `/api/me/api-tokens/${id}`, { cookie: a.cookie })).status).toBe(200);
    expect((await request(ctx.app, 'GET', '/api/workspaces', { bearer: read })).status).toBe(401);
    expect((await request(ctx.app, 'PATCH', '/api/org', { bearer: read, json: {} })).status).toBe(401);
  });

  it('an expired or revoked read-only token is 401 (not 403) on writes', async () => {
    ctx.clock.set(START);
    const a = await signup(ctx.app);
    const read = (await create(a.cookie, { name: 'ro', scope: 'read', expiresInDays: 30 })).body.token as string;
    ctx.clock.advance(31 * DAY);
    const r = await request(ctx.app, 'PATCH', '/api/me', { bearer: read, json: { name: 'x' } });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthorized');
    ctx.clock.set(START);
  });

  it('fails closed: a token row with an unexpected scope value is treated as read-only', async () => {
    const a = await signup(ctx.app);
    const created = await create(a.cookie, { name: 'odd' });
    await ctx.db.update(apiTokens).set({ scope: 'admin' as 'full' }).where(eq(apiTokens.id, created.body.id));
    expect((await request(ctx.app, 'GET', '/api/workspaces', { bearer: created.body.token })).status).toBe(200);
    const w = await request(ctx.app, 'PATCH', '/api/me', { bearer: created.body.token, json: { name: 'x' } });
    expect(w.status).toBe(403);
    expect(w.body.error).toEqual(READ_ONLY);
  });

  it('tenant isolation: a read-only token reads only its own org and never writes to another', async () => {
    const orgA = await seedOrgWithRoles(ctx.app, 'Scope Org A');
    const orgB = await seedOrgWithRoles(ctx.app, 'Scope Org B');
    const readA = (await create(orgA.owner.cookie, { name: 'ro', scope: 'read' })).body.token as string;
    const me = await request(ctx.app, 'GET', '/api/auth/me', { bearer: readA });
    expect(me.body.org.id).toBe(orgA.orgId);
    const members = await request(ctx.app, 'GET', '/api/org/members', { bearer: readA });
    expect(JSON.stringify(members.body)).not.toContain(orgB.owner.email);
    // org B's token list is invisible; org B's resources are refused
    expect((await request(ctx.app, 'GET', '/api/me/api-tokens', { bearer: readA })).body.items.map((t: any) => t.name)).toEqual(['ro']);
    expect((await request(ctx.app, 'DELETE', `/api/org/members/${orgB.viewer.me.user.id}`, { bearer: readA })).body.error).toEqual(READ_ONLY);
    const bMembers = await request(ctx.app, 'GET', '/api/org/members', { cookie: orgB.owner.cookie });
    expect(JSON.stringify(bMembers.body)).toContain(orgB.viewer.email);
    // org B's read-only token is likewise confined: org B's full-scope cookie still works on org B
    expect((await request(ctx.app, 'PATCH', '/api/org', { cookie: orgB.owner.cookie, json: { name: 'Scope Org B 2' } })).status).toBe(200);
  });
});
