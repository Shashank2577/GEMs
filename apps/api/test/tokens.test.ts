/**
 * 002 US5 — API tokens for the Chrome extension: expiry, hints, per-user limit (FR-037) and
 * session-only / membership / role behaviour of bearer tokens (FR-036).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { apiTokens } from '@tp/db';
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
      expiresAt: r.body.expiresAt, hint: r.body.hint,
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
    const { owner, analyst } = await seedOrgWithRoles(ctx.app, 'Limit Co');
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
