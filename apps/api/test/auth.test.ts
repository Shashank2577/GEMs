import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, request, seedOrgWithRoles, signup, uniqueEmail, TEST_APP_URL, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext(); });
afterAll(async () => { await ctx?.close(); });

describe('platform basics', () => {
  it('GET /api/health reports db status without auth', async () => {
    const r = await request(ctx.app, 'GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, db: true, version: expect.any(String) });
    expect(r.headers.get('x-request-id')).toBeTruthy();
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('unknown API routes return a JSON 404 in the standard error format', async () => {
    const r = await request(ctx.app, 'GET', '/api/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  it('invalid JSON and schema violations are 400 with field details', async () => {
    const bad = await ctx.app.request(`${TEST_APP_URL}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe('bad_request');
    const r = await request(ctx.app, 'POST', '/api/auth/signup', { json: { name: '', email: 'nope', password: 'short', orgName: 'A' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    expect(Object.keys(r.body.error.details.fields).sort()).toEqual(['email', 'name', 'orgName', 'password']);
  });
});

describe('auth', () => {
  it('signup creates org + owner membership + prefs and sets a secure-ish session cookie', async () => {
    const email = uniqueEmail('Founder').toUpperCase();
    const r = await request(ctx.app, 'POST', '/api/auth/signup', { json: { name: 'Asha Rao', email, password: 'super-secret-1', orgName: 'Rao Electricals Pvt Ltd' } });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ name: 'Asha Rao', email: email.toLowerCase(), phone: null });
    expect(r.body.org).toMatchObject({ name: 'Rao Electricals Pvt Ltd', slug: 'rao-electricals-pvt-ltd', plan: 'trial', onboardingState: {} });
    expect(r.body.role).toBe('owner');
    expect(r.body.orgs).toHaveLength(1);
    const setCookie = r.res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/tp_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Secure/i); // http test URL

    const me = await request(ctx.app, 'GET', '/api/auth/me', { cookie: r.cookie! });
    expect(me.status).toBe(200);
    expect(me.body.org.id).toBe(r.body.org.id);

    const prefs = await request(ctx.app, 'GET', '/api/me/notification-prefs', { cookie: r.cookie! });
    expect(prefs.body).toEqual({ inApp: true, email: true, whatsapp: false, frequency: 'instant', expiryReminders: true });

    const act = await request(ctx.app, 'GET', '/api/activity', { cookie: r.cookie! });
    expect(act.body.items[0]).toMatchObject({ action: 'org.created', user: { name: 'Asha Rao' } });

    // second org with the same name gets a distinct slug
    const r2 = await request(ctx.app, 'POST', '/api/auth/signup', { json: { name: 'B', email: uniqueEmail(), password: 'super-secret-1', orgName: 'Rao Electricals Pvt Ltd' } });
    expect(r2.body.org.slug).not.toBe('rao-electricals-pvt-ltd');
    expect(r2.body.org.slug).toMatch(/^rao-electricals-pvt-ltd-/);
  });

  it('cookie is Secure on https', async () => {
    const r = await ctx.app.request('https://tp.test/api/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'S', email: uniqueEmail(), password: 'super-secret-1', orgName: 'Secure Co' }),
    });
    expect(r.status).toBe(201);
    expect(r.headers.get('set-cookie')).toMatch(/Secure/);
  });

  it('rejects duplicate email with 409', async () => {
    const a = await signup(ctx.app);
    const r = await request(ctx.app, 'POST', '/api/auth/signup', { json: { name: 'X', email: a.email, password: 'super-secret-1', orgName: 'Other' } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('conflict');
  });

  it('login / logout lifecycle', async () => {
    const a = await signup(ctx.app);
    const wrong = await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: 'wrong-password' } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_credentials');
    const unknown = await request(ctx.app, 'POST', '/api/auth/login', { json: { email: uniqueEmail(), password: 'whatever-123' } });
    expect(unknown.status).toBe(401);

    const ok = await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email.toUpperCase(), password: a.password } });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe(a.email);
    const cookie = ok.cookie!;
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie })).status).toBe(200);

    const out = await request(ctx.app, 'POST', '/api/auth/logout', { cookie });
    expect(out.status).toBe(200);
    expect(out.res.headers.get('set-cookie')).toMatch(/tp_session=;/);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie })).status).toBe(401);
    // the original signup session is still valid
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(200);
  });

  it('unauthenticated and garbage sessions get 401 in the standard format', async () => {
    const r = await request(ctx.app, 'GET', '/api/auth/me');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: 'tp_session=garbage' })).status).toBe(401);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { bearer: 'tp_garbage' })).status).toBe(401);
  });

  it('sessions expire after 30 days of inactivity and slide when used', async () => {
    const a = await signup(ctx.app);
    const day = 24 * 60 * 60 * 1000;
    try {
      ctx.clock.advance(20 * day); // < 15 days remaining → refreshed
      const r = await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie });
      expect(r.status).toBe(200);
      ctx.clock.advance(25 * day); // 45 days after login, but 25 after refresh
      expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(200);
      ctx.clock.advance(31 * day);
      expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(401);
    } finally {
      ctx.clock.set(new Date());
    }
  });

  it('PATCH /me updates name and validates phone; WhatsApp prefs need a phone', async () => {
    const a = await signup(ctx.app);
    const noPhone = await request(ctx.app, 'PUT', '/api/me/notification-prefs', { cookie: a.cookie, json: { inApp: true, email: true, whatsapp: true, frequency: 'daily', expiryReminders: true } });
    expect(noPhone.status).toBe(400);
    const bad = await request(ctx.app, 'PATCH', '/api/me', { cookie: a.cookie, json: { phone: '98123' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields.phone).toBeTruthy();
    const ok = await request(ctx.app, 'PATCH', '/api/me', { cookie: a.cookie, json: { name: 'Vikram S', phone: '+919812345678' } });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ name: 'Vikram S', phone: '+919812345678' });
    const prefs = { inApp: true, email: false, whatsapp: true, frequency: 'daily', expiryReminders: false };
    const put = await request(ctx.app, 'PUT', '/api/me/notification-prefs', { cookie: a.cookie, json: prefs });
    expect(put.status).toBe(200);
    expect((await request(ctx.app, 'GET', '/api/me/notification-prefs', { cookie: a.cookie })).body).toEqual(prefs);
  });

  it('change password signs out other sessions', async () => {
    const a = await signup(ctx.app);
    const other = (await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: a.password } })).cookie!;
    const wrong = await request(ctx.app, 'POST', '/api/me/password', { cookie: a.cookie, json: { currentPassword: 'nope-nope', newPassword: 'new-password-9' } });
    expect(wrong.status).toBe(400);
    const r = await request(ctx.app, 'POST', '/api/me/password', { cookie: a.cookie, json: { currentPassword: a.password, newPassword: 'new-password-9' } });
    expect(r.status).toBe(200);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: other })).status).toBe(401);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(200);
    expect((await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: 'new-password-9' } })).status).toBe(200);
  });
});

describe('API tokens (browser extension)', () => {
  it('create → Bearer auth → list without secret → revoke', async () => {
    const a = await signup(ctx.app);
    const created = await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: a.cookie, json: { name: 'Chrome on laptop' } });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^tp_[A-Za-z0-9_-]{40,}$/);
    const token = created.body.token as string;

    const me = await request(ctx.app, 'GET', '/api/auth/me', { bearer: token });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(a.email);

    // token cannot mint more tokens or switch org (session-only actions)
    expect((await request(ctx.app, 'POST', '/api/me/api-tokens', { bearer: token, json: { name: 'x' } })).status).toBe(403);
    expect((await request(ctx.app, 'POST', '/api/auth/switch-org', { bearer: token, json: { orgId: a.me.org.id } })).status).toBe(403);

    const list = await request(ctx.app, 'GET', '/api/me/api-tokens', { cookie: a.cookie });
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ name: 'Chrome on laptop', lastUsedAt: expect.any(String) });
    expect(JSON.stringify(list.body)).not.toContain(token);

    const del = await request(ctx.app, 'DELETE', `/api/me/api-tokens/${created.body.id}`, { cookie: a.cookie });
    expect(del.status).toBe(200);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { bearer: token })).status).toBe(401);
  });

  it('cannot revoke another user\'s token', async () => {
    const a = await signup(ctx.app);
    const b = await signup(ctx.app);
    const t = await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: a.cookie, json: { name: 'A' } });
    expect((await request(ctx.app, 'DELETE', `/api/me/api-tokens/${t.body.id}`, { cookie: b.cookie })).status).toBe(404);
  });
});

describe('invitations & roles', () => {
  it('owner invites; invitee previews, creates an account and joins with the invited role', async () => {
    const owner = await signup(ctx.app, { orgName: 'Invite Co' });
    const email = uniqueEmail('newbie');
    const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: owner.cookie, json: { email, role: 'analyst' } });
    expect(inv.status).toBe(201);
    expect(inv.body.inviteUrl).toMatch(new RegExp(`^${TEST_APP_URL}/invite/[A-Za-z0-9_-]+$`));
    expect(ctx.mailer.sent.at(-1)).toMatchObject({ to: email, subject: expect.stringContaining('Invite Co') });
    const token = inv.body.inviteUrl.split('/invite/')[1];

    const preview = await request(ctx.app, 'GET', `/api/auth/invite/${token}`);
    expect(preview.body).toMatchObject({ orgName: 'Invite Co', email, role: 'analyst', existingUser: false, invitedBy: 'Test owner' });

    const members = await request(ctx.app, 'GET', '/api/org/members', { cookie: owner.cookie });
    expect(members.body.invitations).toHaveLength(1);
    expect(members.body.invitations[0]).toMatchObject({ email, role: 'analyst', invitedBy: { name: 'Test owner' } });

    const noName = await request(ctx.app, 'POST', '/api/auth/accept-invite', { json: { token, password: 'pass-word-1' } });
    expect(noName.status).toBe(400);
    const acc = await request(ctx.app, 'POST', '/api/auth/accept-invite', { json: { token, name: 'Neha', password: 'pass-word-1' } });
    expect(acc.status).toBe(200);
    expect(acc.body).toMatchObject({ role: 'analyst', user: { name: 'Neha', email }, org: { name: 'Invite Co' } });
    expect(acc.cookie).toBeTruthy();

    // single use
    expect((await request(ctx.app, 'POST', '/api/auth/accept-invite', { json: { token, name: 'Again', password: 'pass-word-1' } })).status).toBe(404);
    const after = await request(ctx.app, 'GET', '/api/org/members', { cookie: owner.cookie });
    expect(after.body.items.map((m: any) => m.role).sort()).toEqual(['analyst', 'owner']);
    expect(after.body.invitations).toHaveLength(0);
  });

  it('existing user accepts with password, then switches between orgs', async () => {
    const orgA = await signup(ctx.app, { orgName: 'Alpha Supplies' });
    const orgB = await signup(ctx.app, { orgName: 'Beta Infra' });
    const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: orgB.cookie, json: { email: orgA.email, role: 'bid_manager' } });
    const token = inv.body.inviteUrl.split('/invite/')[1];
    expect((await request(ctx.app, 'GET', `/api/auth/invite/${token}`)).body.existingUser).toBe(true);
    const wrong = await request(ctx.app, 'POST', '/api/auth/accept-invite', { json: { token, password: 'wrong-pass' } });
    expect(wrong.status).toBe(401);
    const acc = await request(ctx.app, 'POST', '/api/auth/accept-invite', { json: { token, password: orgA.password } });
    expect(acc.status).toBe(200);
    expect(acc.body.org.name).toBe('Beta Infra');
    expect(acc.body.role).toBe('bid_manager');
    expect(acc.body.orgs.map((o: any) => o.name)).toEqual(['Alpha Supplies', 'Beta Infra']);

    const cookie = acc.cookie!;
    const sw = await request(ctx.app, 'POST', '/api/auth/switch-org', { cookie, json: { orgId: orgA.me.org.id } });
    expect(sw.status).toBe(200);
    expect(sw.body).toMatchObject({ org: { name: 'Alpha Supplies' }, role: 'owner' });
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie })).body.org.name).toBe('Alpha Supplies');

    const stranger = await signup(ctx.app);
    const denied = await request(ctx.app, 'POST', '/api/auth/switch-org', { cookie, json: { orgId: stranger.me.org.id } });
    expect(denied.status).toBe(404);

    // login resumes the last active org
    const login = await request(ctx.app, 'POST', '/api/auth/login', { json: { email: orgA.email, password: orgA.password } });
    expect(login.body.org.name).toBe('Alpha Supplies');
  });

  it('002/FR-021: sign-in resumes the last-used org across sign-outs, else the oldest membership', async () => {
    const a = await signup(ctx.app, { orgName: 'Oldest Org' });
    const b = await signup(ctx.app, { orgName: 'Newer Org' });
    const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: b.cookie, json: { email: a.email, role: 'analyst' } });
    const token = inv.body.inviteUrl.split('/invite/')[1];
    const login = () => request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: a.password } });

    // accepting (signed in) makes B active; sign out → sign in lands in B
    expect((await request(ctx.app, 'POST', '/api/auth/accept-invite', { cookie: a.cookie, json: { token } })).body.org.name).toBe('Newer Org');
    expect((await request(ctx.app, 'POST', '/api/auth/logout', { cookie: a.cookie })).status).toBe(200);
    const l1 = await login();
    expect(l1.body.org.name).toBe('Newer Org');

    // switching in an older session counts too
    const s2 = (await login()).cookie!;
    await request(ctx.app, 'POST', '/api/auth/switch-org', { cookie: l1.cookie!, json: { orgId: a.me.org.id } });
    await request(ctx.app, 'POST', '/api/auth/switch-org', { cookie: s2, json: { orgId: b.me.org.id } });
    await request(ctx.app, 'POST', '/api/auth/switch-org', { cookie: l1.cookie!, json: { orgId: b.me.org.id } });
    await request(ctx.app, 'POST', '/api/auth/switch-org', { cookie: s2, json: { orgId: a.me.org.id } });
    await request(ctx.app, 'POST', '/api/auth/switch-org', { cookie: l1.cookie!, json: { orgId: b.me.org.id } });
    await request(ctx.app, 'POST', '/api/auth/logout', { cookie: l1.cookie! });
    await request(ctx.app, 'POST', '/api/auth/logout', { cookie: s2 });
    expect((await login()).body.org.name).toBe('Newer Org');

    // removed from B → falls back to the oldest membership
    expect((await request(ctx.app, 'DELETE', `/api/org/members/${a.me.user.id}`, { cookie: b.cookie })).status).toBe(200);
    const l3 = await login();
    expect(l3.status).toBe(200);
    expect(l3.body.org.name).toBe('Oldest Org');
  });

  it('a signed-in user accepting an invite for their email joins with their current account', async () => {
    const host = await signup(ctx.app, { orgName: 'Host Org' });
    const guest = await signup(ctx.app, { orgName: 'Guest Org' });
    const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: host.cookie, json: { email: guest.email, role: 'viewer' } });
    const token = inv.body.inviteUrl.split('/invite/')[1];
    const acc = await request(ctx.app, 'POST', '/api/auth/accept-invite', { cookie: guest.cookie, json: { token } });
    expect(acc.status).toBe(200);
    expect(acc.cookie).toBeNull(); // keeps the existing session
    expect(acc.body).toMatchObject({ user: { email: guest.email }, org: { name: 'Host Org' }, role: 'viewer' });
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: guest.cookie })).body.org.name).toBe('Host Org');
  });

  it('002/FR-018: a signed-in user with a different email cannot redeem the invitation', async () => {
    const host = await signup(ctx.app, { orgName: 'Bound Org' });
    const ravi = await signup(ctx.app, { orgName: 'Ravi Org' });
    const asha = uniqueEmail('asha');
    const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: host.cookie, json: { email: asha, role: 'analyst' } });
    const token = inv.body.inviteUrl.split('/invite/')[1];

    const r = await request(ctx.app, 'POST', '/api/auth/accept-invite', { cookie: ravi.cookie, json: { token } });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({
      code: 'invite_email_mismatch',
      message: `This invitation was sent to ${asha}. Sign out and continue as that account.`,
    });
    expect(r.cookie).toBeNull();
    // no membership, active org unchanged, invitation still usable by the right person
    const me = await request(ctx.app, 'GET', '/api/auth/me', { cookie: ravi.cookie });
    expect(me.body.org.name).toBe('Ravi Org');
    expect(me.body.orgs.map((o: any) => o.name)).toEqual(['Ravi Org']);
    const members = await request(ctx.app, 'GET', '/api/org/members', { cookie: host.cookie });
    expect(members.body.items.map((m: any) => m.email)).not.toContain(ravi.email);
    expect(members.body.invitations.map((i: any) => i.email)).toEqual([asha]);
    const acts = await request(ctx.app, 'GET', '/api/activity?pageSize=100', { cookie: host.cookie });
    expect(acts.body.items.some((i: any) => i.action === 'member.joined' && i.user?.id === ravi.me.user.id)).toBe(false);

    // a name/password in the body does not bypass the binding
    const r2 = await request(ctx.app, 'POST', '/api/auth/accept-invite', { cookie: ravi.cookie, json: { token, name: 'Ravi', password: ravi.password } });
    expect(r2.status).toBe(403);

    const ok = await request(ctx.app, 'POST', '/api/auth/accept-invite', { json: { token, name: 'Asha', password: 'pass-word-1' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ user: { email: asha }, org: { name: 'Bound Org' }, role: 'analyst' });
  });

  it('expired and invalid invitations are rejected', async () => {
    const owner = await signup(ctx.app);
    const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: owner.cookie, json: { email: uniqueEmail(), role: 'viewer' } });
    const token = inv.body.inviteUrl.split('/invite/')[1];
    try {
      ctx.clock.advance(8 * 24 * 60 * 60 * 1000);
      const r = await request(ctx.app, 'GET', `/api/auth/invite/${token}`);
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('invite_invalid');
    } finally { ctx.clock.set(new Date()); }
    expect((await request(ctx.app, 'POST', '/api/auth/accept-invite', { json: { token: 'not-a-real-token-xyz', name: 'x', password: 'abcdefgh' } })).status).toBe(404);
  });

  it('enforces the role hierarchy owner > bid_manager > analyst > viewer', async () => {
    const { owner, bidManager, analyst, viewer } = await seedOrgWithRoles(ctx.app, 'Roles Ltd');
    expect(bidManager.me.role).toBe('bid_manager');
    expect(analyst.me.role).toBe('analyst');
    expect(viewer.me.role).toBe('viewer');

    // invitations: bid_manager+
    const e = () => ({ email: uniqueEmail(), role: 'viewer' });
    expect((await request(ctx.app, 'POST', '/api/org/invitations', { cookie: viewer.cookie, json: e() })).status).toBe(403);
    const an = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: analyst.cookie, json: e() });
    expect(an.status).toBe(403);
    expect(an.body.error).toMatchObject({ code: 'forbidden', message: expect.stringContaining('Bid Manager') });
    expect((await request(ctx.app, 'POST', '/api/org/invitations', { cookie: bidManager.cookie, json: e() })).status).toBe(201);
    // only owners can invite owners
    expect((await request(ctx.app, 'POST', '/api/org/invitations', { cookie: bidManager.cookie, json: { email: uniqueEmail(), role: 'owner' } })).status).toBe(403);
    // cannot invite an existing member; the full sentence is the email field error (US2 scenario 3)
    const dup = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: owner.cookie, json: { email: analyst.email, role: 'viewer' } });
    expect(dup.status).toBe(409);
    const dupMsg = `${analyst.email} is already a member of this organization`;
    expect(dup.body.error).toMatchObject({ code: 'conflict', message: dupMsg, details: { fields: { email: dupMsg } } });

    // PATCH /org: bid_manager+
    expect((await request(ctx.app, 'PATCH', '/api/org', { cookie: analyst.cookie, json: { name: 'Hacked' } })).status).toBe(403);
    const upd = await request(ctx.app, 'PATCH', '/api/org', { cookie: bidManager.cookie, json: { name: 'Roles Pvt Ltd', onboardingState: { profile: true } } });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name: 'Roles Pvt Ltd', onboardingState: { profile: true } });
    const upd2 = await request(ctx.app, 'PATCH', '/api/org', { cookie: owner.cookie, json: { onboardingState: { vault: true }, scoringWeights: { turnover: 20 } } });
    expect(upd2.body.onboardingState).toEqual({ profile: true, vault: true });
    expect(upd2.body.scoringWeights).toEqual({ turnover: 20 });
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: viewer.cookie })).body.org.name).toBe('Roles Pvt Ltd');

    // member role changes / removal: owner only
    const target = analyst.me.user.id;
    expect((await request(ctx.app, 'PATCH', `/api/org/members/${target}`, { cookie: bidManager.cookie, json: { role: 'viewer' } })).status).toBe(403);
    const ch = await request(ctx.app, 'PATCH', `/api/org/members/${target}`, { cookie: owner.cookie, json: { role: 'bid_manager' } });
    expect(ch.status).toBe(200);
    expect(ch.body).toMatchObject({ userId: target, role: 'bid_manager' });
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: analyst.cookie })).body.role).toBe('bid_manager');
    expect((await request(ctx.app, 'PATCH', `/api/org/members/${target}`, { cookie: owner.cookie, json: { role: 'admin' } })).status).toBe(400);
  });

  it('cannot demote or remove the last owner; removal revokes access', async () => {
    const { owner, viewer } = await seedOrgWithRoles(ctx.app);
    const ownerId = owner.me.user.id;
    const demote = await request(ctx.app, 'PATCH', `/api/org/members/${ownerId}`, { cookie: owner.cookie, json: { role: 'viewer' } });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('last_owner');
    expect((await request(ctx.app, 'DELETE', `/api/org/members/${ownerId}`, { cookie: owner.cookie })).status).toBe(409);

    // with a second owner, the first can step down
    await request(ctx.app, 'PATCH', `/api/org/members/${viewer.me.user.id}`, { cookie: owner.cookie, json: { role: 'owner' } });
    expect((await request(ctx.app, 'PATCH', `/api/org/members/${ownerId}`, { cookie: owner.cookie, json: { role: 'bid_manager' } })).status).toBe(200);
    // now viewer (owner) removes the former owner
    const viewerToken = (await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: owner.cookie, json: { name: 'x' } })).body.token;
    const rm = await request(ctx.app, 'DELETE', `/api/org/members/${ownerId}`, { cookie: viewer.cookie });
    expect(rm.status).toBe(200);
    const me = await request(ctx.app, 'GET', '/api/auth/me', { cookie: owner.cookie });
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('no_organization');
    expect((await request(ctx.app, 'GET', '/api/auth/me', { bearer: viewerToken })).status).toBe(401);
    expect((await request(ctx.app, 'DELETE', '/api/org/members/not-a-uuid', { cookie: viewer.cookie })).status).toBe(404);

    const act = await request(ctx.app, 'GET', '/api/activity?entityType=user', { cookie: viewer.cookie });
    expect(act.body.items.map((i: any) => i.action)).toEqual(expect.arrayContaining(['member.removed', 'member.role_changed', 'member.joined']));
  });

  it('002/FR-020: bid managers can resend a pending invitation with a fresh link and expiry', async () => {
    const { owner, bidManager, analyst } = await seedOrgWithRoles(ctx.app, 'Resend Co');
    const email = uniqueEmail('resend');
    const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: owner.cookie, json: { email, role: 'analyst' } });
    const oldToken = inv.body.inviteUrl.split('/invite/')[1];
    const mailsTo = () => ctx.mailer.sent.filter((m) => m.to === email);
    expect(mailsTo()).toHaveLength(1);
    try {
      ctx.clock.advance(3 * 24 * 60 * 60 * 1000);
      expect((await request(ctx.app, 'POST', `/api/org/invitations/${inv.body.id}/resend`, { cookie: analyst.cookie })).status).toBe(403);

      const r = await request(ctx.app, 'POST', `/api/org/invitations/${inv.body.id}/resend`, { cookie: bidManager.cookie });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ id: inv.body.id, email, role: 'analyst' });
      expect(r.body.inviteUrl).toMatch(new RegExp(`^${TEST_APP_URL}/invite/[A-Za-z0-9_-]+$`));
      expect(r.body.inviteUrl).not.toBe(inv.body.inviteUrl);
      expect(new Date(r.body.expiresAt).getTime()).toBe(ctx.clock.now().getTime() + 7 * 24 * 60 * 60 * 1000);
      expect(mailsTo()).toHaveLength(2);
      expect(mailsTo().at(-1)).toMatchObject({ to: email, subject: expect.stringContaining('Resend Co'), text: expect.stringContaining(r.body.inviteUrl) });

      // the old link stops working, the new one previews; still exactly one pending row
      expect((await request(ctx.app, 'GET', `/api/auth/invite/${oldToken}`)).status).toBe(404);
      const newToken = r.body.inviteUrl.split('/invite/')[1];
      const preview = await request(ctx.app, 'GET', `/api/auth/invite/${newToken}`);
      expect(preview.body).toMatchObject({ email, role: 'analyst', orgName: 'Resend Co', expiresAt: r.body.expiresAt });
      const members = await request(ctx.app, 'GET', '/api/org/members', { cookie: owner.cookie });
      expect(members.body.invitations.filter((i: any) => i.email === email)).toHaveLength(1);
      expect(members.body.invitations.find((i: any) => i.email === email).expiresAt).toBe(r.body.expiresAt);

      const act = await request(ctx.app, 'GET', '/api/activity?entityType=invitation', { cookie: owner.cookie });
      expect(act.body.items[0]).toMatchObject({ action: 'member.invite_resent', entityId: inv.body.id, meta: { email, role: 'analyst' }, user: { id: bidManager.me.user.id } });

      // an expired, unaccepted invitation can be revived
      ctx.clock.advance(8 * 24 * 60 * 60 * 1000);
      expect((await request(ctx.app, 'GET', `/api/auth/invite/${newToken}`)).status).toBe(404);
      const revived = await request(ctx.app, 'POST', `/api/org/invitations/${inv.body.id}/resend`, { cookie: owner.cookie });
      expect(revived.status).toBe(201);
      const accepted = await request(ctx.app, 'POST', '/api/auth/accept-invite', { json: { token: revived.body.inviteUrl.split('/invite/')[1], name: 'Resent', password: 'pass-word-1' } });
      expect(accepted.status).toBe(200);
      // accepted invitations cannot be resent
      expect((await request(ctx.app, 'POST', `/api/org/invitations/${inv.body.id}/resend`, { cookie: owner.cookie })).status).toBe(404);
    } finally { ctx.clock.set(new Date()); }

    // unknown ids and malformed ids are 404
    expect((await request(ctx.app, 'POST', `/api/org/invitations/${crypto.randomUUID()}/resend`, { cookie: owner.cookie })).status).toBe(404);
    expect((await request(ctx.app, 'POST', '/api/org/invitations/not-a-uuid/resend', { cookie: owner.cookie })).status).toBe(404);
  });

  it('only an Owner can resend an Owner invitation', async () => {
    const { owner, bidManager } = await seedOrgWithRoles(ctx.app);
    const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: owner.cookie, json: { email: uniqueEmail(), role: 'owner' } });
    const r = await request(ctx.app, 'POST', `/api/org/invitations/${inv.body.id}/resend`, { cookie: bidManager.cookie });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe('Only an Owner can invite another Owner');
    expect((await request(ctx.app, 'POST', `/api/org/invitations/${inv.body.id}/resend`, { cookie: owner.cookie })).status).toBe(201);
  });

  it('bid managers can revoke pending invitations', async () => {
    const { owner, bidManager, analyst } = await seedOrgWithRoles(ctx.app);
    const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: owner.cookie, json: { email: uniqueEmail(), role: 'viewer' } });
    expect((await request(ctx.app, 'DELETE', `/api/org/invitations/${inv.body.id}`, { cookie: analyst.cookie })).status).toBe(403);
    expect((await request(ctx.app, 'DELETE', `/api/org/invitations/${inv.body.id}`, { cookie: bidManager.cookie })).status).toBe(200);
    const token = inv.body.inviteUrl.split('/invite/')[1];
    expect((await request(ctx.app, 'GET', `/api/auth/invite/${token}`)).status).toBe(404);
  });
});

describe('DELETE /api/org/members/me — leave organization (002/FR-027)', () => {
  it('removes own membership + own tokens for that org, logs member.left and moves the session to the next org', async () => {
    const a = await seedOrgWithRoles(ctx.app, 'Leave Alpha');
    const home = await signup(ctx.app, { orgName: 'Leave Home' });
    // `home` joins Alpha as an analyst with their existing account, so they have two orgs.
    const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: a.owner.cookie, json: { email: home.email, role: 'analyst' } });
    const acc = await request(ctx.app, 'POST', '/api/auth/accept-invite', { cookie: home.cookie, json: { token: inv.body.inviteUrl.split('/invite/')[1] } });
    expect(acc.body.org.name).toBe('Leave Alpha');
    const alphaToken = (await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: home.cookie, json: { name: 'alpha ext' } })).body.token;
    await request(ctx.app, 'POST', '/api/auth/switch-org', { cookie: home.cookie, json: { orgId: home.me.org.id } });
    const homeToken = (await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: home.cookie, json: { name: 'home ext' } })).body.token;
    await request(ctx.app, 'POST', '/api/auth/switch-org', { cookie: home.cookie, json: { orgId: a.orgId } });

    const r = await request(ctx.app, 'DELETE', '/api/org/members/me', { cookie: home.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, nextOrgId: home.me.org.id });

    const me = await request(ctx.app, 'GET', '/api/auth/me', { cookie: home.cookie });
    expect(me.body.org.id).toBe(home.me.org.id);
    expect(me.body.orgs.map((o: any) => o.name)).toEqual(['Leave Home']);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { bearer: alphaToken })).status).toBe(401);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { bearer: homeToken })).status).toBe(200);

    const members = await request(ctx.app, 'GET', '/api/org/members', { cookie: a.owner.cookie });
    expect(members.body.items.map((m: any) => m.email)).not.toContain(home.email);
    const act = await request(ctx.app, 'GET', '/api/activity?entityType=user', { cookie: a.owner.cookie });
    expect(act.body.items[0]).toMatchObject({ action: 'member.left', entityId: home.me.user.id, user: { id: home.me.user.id }, meta: { role: 'analyst' } });
    // the switch back to the org they left is refused
    expect((await request(ctx.app, 'POST', '/api/auth/switch-org', { cookie: home.cookie, json: { orgId: a.orgId } })).status).toBe(404);
  });

  it('leaving the only org returns nextOrgId null and the session has no organization', async () => {
    const a = await seedOrgWithRoles(ctx.app);
    const r = await request(ctx.app, 'DELETE', '/api/org/members/me', { cookie: a.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, nextOrgId: null });
    const me = await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.viewer.cookie });
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('no_organization');
  });

  it('the last Owner gets 409 last_owner; a non-last Owner may leave', async () => {
    const a = await seedOrgWithRoles(ctx.app);
    const last = await request(ctx.app, 'DELETE', '/api/org/members/me', { cookie: a.owner.cookie });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('last_owner');
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.owner.cookie })).body.role).toBe('owner');

    await request(ctx.app, 'PATCH', `/api/org/members/${a.bidManager.me.user.id}`, { cookie: a.owner.cookie, json: { role: 'owner' } });
    expect((await request(ctx.app, 'DELETE', '/api/org/members/me', { cookie: a.owner.cookie })).status).toBe(200);
    const members = await request(ctx.app, 'GET', '/api/org/members', { cookie: a.bidManager.cookie });
    expect(members.body.items.filter((m: any) => m.role === 'owner').map((m: any) => m.userId)).toEqual([a.bidManager.me.user.id]);
  });

  it('is session-only: an API token gets 403 and nothing changes', async () => {
    const a = await seedOrgWithRoles(ctx.app);
    const token = (await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: a.analyst.cookie, json: { name: 'ext' } })).body.token;
    const r = await request(ctx.app, 'DELETE', '/api/org/members/me', { bearer: token });
    expect(r.status).toBe(403);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.analyst.cookie })).body.role).toBe('analyst');
    expect((await request(ctx.app, 'DELETE', '/api/org/members/me')).status).toBe(401);
  });
});

describe('organization isolation (Constitution IV)', () => {
  it('two orgs cannot see or touch each other\'s members, invitations or activity', async () => {
    const a = await seedOrgWithRoles(ctx.app, 'Org A');
    const b = await seedOrgWithRoles(ctx.app, 'Org B');
    await request(ctx.app, 'POST', '/api/org/invitations', { cookie: a.owner.cookie, json: { email: 'only-a@example.in', role: 'viewer' } });
    await request(ctx.app, 'PATCH', '/api/org', { cookie: b.owner.cookie, json: { name: 'Org B Renamed' } });

    const ma = await request(ctx.app, 'GET', '/api/org/members', { cookie: a.viewer.cookie });
    const mb = await request(ctx.app, 'GET', '/api/org/members', { cookie: b.viewer.cookie });
    const emailsA = ma.body.items.map((m: any) => m.email);
    const emailsB = mb.body.items.map((m: any) => m.email);
    expect(emailsA).toHaveLength(4);
    expect(emailsB).toHaveLength(4);
    expect(emailsA.some((e: string) => emailsB.includes(e))).toBe(false);
    expect(mb.body.invitations.map((i: any) => i.email)).not.toContain('only-a@example.in');

    const actA = await request(ctx.app, 'GET', '/api/activity?pageSize=100', { cookie: a.viewer.cookie });
    const actB = await request(ctx.app, 'GET', '/api/activity?pageSize=100', { cookie: b.viewer.cookie });
    const idsA = new Set(actA.body.items.map((i: any) => i.id));
    expect(actB.body.items.some((i: any) => idsA.has(i.id))).toBe(false);
    expect(actA.body.items.some((i: any) => i.action === 'org.updated')).toBe(false);
    expect(actB.body.items.some((i: any) => i.action === 'org.updated')).toBe(true);
    expect(actA.body.items.every((i: any) => [a.owner, a.bidManager, a.analyst, a.viewer].some((u) => u.me.user.id === i.user?.id))).toBe(true);

    // org A's owner cannot modify or remove org B's members
    const bUser = b.analyst.me.user.id;
    expect((await request(ctx.app, 'PATCH', `/api/org/members/${bUser}`, { cookie: a.owner.cookie, json: { role: 'owner' } })).status).toBe(404);
    expect((await request(ctx.app, 'DELETE', `/api/org/members/${bUser}`, { cookie: a.owner.cookie })).status).toBe(404);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: b.analyst.cookie })).body.role).toBe('analyst');
    // nor revoke org B's invitations
    const invB = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: b.owner.cookie, json: { email: uniqueEmail(), role: 'viewer' } });
    expect((await request(ctx.app, 'DELETE', `/api/org/invitations/${invB.body.id}`, { cookie: a.owner.cookie })).status).toBe(404);
    // nor resend them
    expect((await request(ctx.app, 'POST', `/api/org/invitations/${invB.body.id}/resend`, { cookie: a.owner.cookie })).status).toBe(404);
  });

  it('activity supports filters and pagination', async () => {
    const { owner } = await seedOrgWithRoles(ctx.app);
    const all = await request(ctx.app, 'GET', '/api/activity', { cookie: owner.cookie });
    expect(all.body.total).toBeGreaterThanOrEqual(7); // created + 3 invited + 3 joined
    const page = await request(ctx.app, 'GET', '/api/activity?page=2&pageSize=2', { cookie: owner.cookie });
    expect(page.body.items).toHaveLength(2);
    expect(page.body.total).toBe(all.body.total);
    expect(page.body.items[0].id).toBe(all.body.items[2].id);
    const inv = await request(ctx.app, 'GET', '/api/activity?entityType=invitation', { cookie: owner.cookie });
    expect(inv.body.items.every((i: any) => i.entityType === 'invitation')).toBe(true);
    expect((await request(ctx.app, 'GET', '/api/activity?pageSize=1000', { cookie: owner.cookie })).status).toBe(400);
  });
});
