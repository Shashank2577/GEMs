/** 002/FR-042 + SC-008: every audited action writes exactly one activity row with the right entity, actor and safe meta. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { activityLog } from '@tp/db';
import { createTestContext, request, signup, TEST_PASSWORD, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext(); });
afterAll(async () => { await ctx?.close(); });

const rows = (orgId: string, action: string) =>
  ctx.db.select().from(activityLog).where(and(eq(activityLog.orgId, orgId), eq(activityLog.action, action))).orderBy(asc(activityLog.createdAt));

/** Run `fn` and return the rows of `action` it added (exactly the delta). */
async function delta(orgId: string, action: string, fn: () => Promise<unknown>) {
  const before = (await rows(orgId, action)).length;
  await fn();
  return (await rows(orgId, action)).slice(before);
}

function expectSafe(meta: unknown) {
  // Keys/values must not carry secrets or IPs; "expiresInDays"/"count" style fields are fine.
  const json = JSON.stringify(meta);
  expect(json).not.toMatch(/passwordHash|newPassword|currentPassword|tokenHash|inviteUrl|"token"|"ip"/i);
  expect(json).not.toMatch(/tp_[A-Za-z0-9_-]{10,}/);
  expect(json).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
}

describe('FR-042 activity entries', () => {
  it('org.created on signup', async () => {
    const owner = await signup(ctx.app, { name: 'Asha', orgName: 'Audit Co' });
    const org = owner.me.org.id;
    const r = await rows(org, 'org.created');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ entityType: 'organization', entityId: org, userId: owner.me.user.id, meta: { name: 'Audit Co' } });
    expectSafe(r[0].meta);
  });

  it('org.updated only for name/scoring changes, not onboarding ticks', async () => {
    const owner = await signup(ctx.app);
    const org = owner.me.org.id;
    const tick = await delta(org, 'org.updated', () => request(ctx.app, 'PATCH', '/api/org', { cookie: owner.cookie, json: { onboardingState: { profile: true } } }));
    expect(tick).toHaveLength(0);
    const renamed = await delta(org, 'org.updated', async () => {
      expect((await request(ctx.app, 'PATCH', '/api/org', { cookie: owner.cookie, json: { name: 'Renamed Co' } })).status).toBe(200);
    });
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({ entityType: 'organization', entityId: org, userId: owner.me.user.id });
    expectSafe(renamed[0].meta);
  });

  it('scoring weights change logs org.scoring_weights_updated once', async () => {
    const owner = await signup(ctx.app);
    const org = owner.me.org.id;
    const r = await delta(org, 'org.scoring_weights_updated', async () => {
      expect((await request(ctx.app, 'PUT', '/api/scoring-weights', { cookie: owner.cookie, json: { turnover: 30 } })).status).toBe(200);
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ entityType: 'organization', entityId: org, userId: owner.me.user.id });
  });

  it('invite lifecycle: member.invited, invite_resent, invite_revoked, member.joined', async () => {
    const owner = await signup(ctx.app);
    const org = owner.me.org.id;
    const uid = owner.me.user.id;

    let inviteId = '';
    const invited = await delta(org, 'member.invited', async () => {
      const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: owner.cookie, json: { email: 'new.hire@example.in', role: 'analyst' } });
      expect(inv.status).toBe(201);
      inviteId = inv.body.id;
    });
    expect(invited).toHaveLength(1);
    expect(invited[0]).toMatchObject({ entityType: 'invitation', entityId: inviteId, userId: uid, meta: { email: 'new.hire@example.in', role: 'analyst' } });
    expectSafe(invited[0].meta);

    const resent = await delta(org, 'member.invite_resent', async () => {
      expect((await request(ctx.app, 'POST', `/api/org/invitations/${inviteId}/resend`, { cookie: owner.cookie })).status).toBe(201);
    });
    expect(resent).toHaveLength(1);
    expect(resent[0]).toMatchObject({ entityType: 'invitation', entityId: inviteId, userId: uid });
    expectSafe(resent[0].meta);

    const revoked = await delta(org, 'member.invite_revoked', async () => {
      expect((await request(ctx.app, 'DELETE', `/api/org/invitations/${inviteId}`, { cookie: owner.cookie })).status).toBe(200);
    });
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ entityType: 'invitation', entityId: inviteId, userId: uid, meta: { email: 'new.hire@example.in' } });

    const joinedBefore = (await rows(org, 'member.joined')).length;
    const analyst = await signup(ctx.app, { role: 'analyst', ownerCookie: owner.cookie });
    const joined = (await rows(org, 'member.joined')).slice(joinedBefore);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ entityType: 'user', entityId: analyst.me.user.id, userId: analyst.me.user.id, meta: { role: 'analyst' } });
    expectSafe(joined[0].meta);
  });

  it('member.role_changed, member.removed and member.left', async () => {
    const owner = await signup(ctx.app);
    const org = owner.me.org.id;
    const uid = owner.me.user.id;
    const a = await signup(ctx.app, { role: 'analyst', ownerCookie: owner.cookie });
    const b = await signup(ctx.app, { role: 'viewer', ownerCookie: owner.cookie });

    const changed = await delta(org, 'member.role_changed', async () => {
      expect((await request(ctx.app, 'PATCH', `/api/org/members/${a.me.user.id}`, { cookie: owner.cookie, json: { role: 'bid_manager' } })).status).toBe(200);
    });
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ entityType: 'user', entityId: a.me.user.id, userId: uid, meta: { from: 'analyst', to: 'bid_manager' } });
    expectSafe(changed[0].meta);

    const removed = await delta(org, 'member.removed', async () => {
      expect((await request(ctx.app, 'DELETE', `/api/org/members/${a.me.user.id}`, { cookie: owner.cookie })).status).toBe(200);
    });
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ entityType: 'user', entityId: a.me.user.id, userId: uid });
    expectSafe(removed[0].meta);

    const left = await delta(org, 'member.left', async () => {
      expect((await request(ctx.app, 'DELETE', '/api/org/members/me', { cookie: b.cookie })).status).toBe(200);
    });
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ entityType: 'user', entityId: b.me.user.id, userId: b.me.user.id, meta: { role: 'viewer' } });
    expectSafe(left[0].meta);
  });

  it('api_token.created and api_token.revoked never contain the secret', async () => {
    const owner = await signup(ctx.app);
    const org = owner.me.org.id;
    let tokenId = '';
    let secret = '';
    const created = await delta(org, 'api_token.created', async () => {
      const r = await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: owner.cookie, json: { name: 'CI token' } });
      expect(r.status).toBe(201);
      tokenId = r.body.id;
      secret = r.body.token;
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ entityType: 'api_token', entityId: tokenId, userId: owner.me.user.id, meta: { name: 'CI token' } });
    expectSafe(created[0].meta);
    expect(JSON.stringify(created[0])).not.toContain(secret);

    const revoked = await delta(org, 'api_token.revoked', async () => {
      expect((await request(ctx.app, 'DELETE', `/api/me/api-tokens/${tokenId}`, { cookie: owner.cookie })).status).toBe(200);
    });
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ entityType: 'api_token', entityId: tokenId, userId: owner.me.user.id });
  });

  it('auth.password_changed logs once with no password material; a wrong password logs nothing', async () => {
    const owner = await signup(ctx.app);
    const org = owner.me.org.id;
    const bad = await delta(org, 'auth.password_changed', async () => {
      expect((await request(ctx.app, 'POST', '/api/me/password', { cookie: owner.cookie, json: { currentPassword: 'nope-nope-1', newPassword: 'brand-new-pass-9' } })).status).toBe(400);
    });
    expect(bad).toHaveLength(0);
    const ok = await delta(org, 'auth.password_changed', async () => {
      expect((await request(ctx.app, 'POST', '/api/me/password', { cookie: owner.cookie, json: { currentPassword: TEST_PASSWORD, newPassword: 'brand-new-pass-9' } })).status).toBe(200);
    });
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ entityType: 'user', entityId: owner.me.user.id, userId: owner.me.user.id });
    expectSafe(ok[0].meta);
    expect(JSON.stringify(ok[0])).not.toContain('brand-new-pass-9');
  });

  it('auth.sessions_revoked logs once for revoke-others (only when something was revoked) and for a single revoke', async () => {
    const owner = await signup(ctx.app);
    const org = owner.me.org.id;
    const none = await delta(org, 'auth.sessions_revoked', async () => {
      expect((await request(ctx.app, 'POST', '/api/me/sessions/revoke-others', { cookie: owner.cookie })).body.revoked).toBe(0);
    });
    expect(none).toHaveLength(0);

    const second = await request(ctx.app, 'POST', '/api/auth/login', { json: { email: owner.email, password: owner.password } });
    const others = await delta(org, 'auth.sessions_revoked', async () => {
      expect((await request(ctx.app, 'POST', '/api/me/sessions/revoke-others', { cookie: owner.cookie })).body.revoked).toBe(1);
    });
    expect(others).toHaveLength(1);
    expect(others[0]).toMatchObject({ entityType: 'user', entityId: owner.me.user.id, userId: owner.me.user.id, meta: { scope: 'others', count: 1 } });
    expectSafe(others[0].meta);
    expect(second.cookie).toBeTruthy();

    const third = await request(ctx.app, 'POST', '/api/auth/login', { json: { email: owner.email, password: owner.password } });
    const list = await request(ctx.app, 'GET', '/api/me/sessions', { cookie: owner.cookie });
    const other = list.body.items.find((s: any) => !s.current);
    expect(third.cookie).toBeTruthy();
    const one = await delta(org, 'auth.sessions_revoked', async () => {
      expect((await request(ctx.app, 'DELETE', `/api/me/sessions/${other.id}`, { cookie: owner.cookie })).status).toBe(200);
    });
    expect(one).toHaveLength(1);
    expect(one[0].meta).toMatchObject({ scope: 'one', count: 1 });
  });

  it('GET /api/activity lists the new entries for the org, newest first, filterable by entityType', async () => {
    const owner = await signup(ctx.app);
    await request(ctx.app, 'POST', '/api/me/password', { cookie: owner.cookie, json: { currentPassword: TEST_PASSWORD, newPassword: 'brand-new-pass-9' } });
    const r = await request(ctx.app, 'GET', '/api/activity?entityType=user', { cookie: owner.cookie });
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ action: 'auth.password_changed', entityType: 'user', user: { id: owner.me.user.id } });
    expect(r.body.items.every((i: any) => i.entityType === 'user')).toBe(true);
  });

  it('revoking the current session logs once with scope "current" and signs you out', async () => {
    const owner = await signup(ctx.app);
    const org = owner.me.org.id;
    const list = await request(ctx.app, 'GET', '/api/me/sessions', { cookie: owner.cookie });
    const current = list.body.items.find((s: any) => s.current);
    const r = await delta(org, 'auth.sessions_revoked', async () => {
      expect((await request(ctx.app, 'DELETE', `/api/me/sessions/${current.id}`, { cookie: owner.cookie })).status).toBe(200);
    });
    expect(r).toHaveLength(1);
    expect(r[0].meta).toMatchObject({ scope: 'current', count: 1 });
    expect((await request(ctx.app, 'GET', '/api/me/sessions', { cookie: owner.cookie })).status).toBe(401);
  });

  it('GET /api/activity: userId of another org yields nothing; entityType accepts a comma list and never crosses orgs', async () => {
    const a = await signup(ctx.app);
    const b = await signup(ctx.app);
    await request(ctx.app, 'POST', '/api/me/password', { cookie: b.cookie, json: { currentPassword: TEST_PASSWORD, newPassword: 'brand-new-pass-9' } });
    const foreign = await request(ctx.app, 'GET', `/api/activity?userId=${b.me.user.id}`, { cookie: a.cookie });
    expect(foreign.status).toBe(200);
    expect(foreign.body.total).toBe(0);
    expect(foreign.body.items).toEqual([]);
    const cross = await request(ctx.app, 'GET', '/api/activity?entityType=user,organization,tender', { cookie: a.cookie });
    expect(cross.body.items.length).toBeGreaterThan(0);
    expect(cross.body.items.every((i: any) => ['user', 'organization', 'tender'].includes(i.entityType))).toBe(true);
    expect(cross.body.items.some((i: any) => i.action === 'auth.password_changed')).toBe(false);
    const one = await request(ctx.app, 'GET', '/api/activity?entityType=organization', { cookie: a.cookie });
    expect(one.body.items.every((i: any) => i.entityType === 'organization')).toBe(true);
  });
});
