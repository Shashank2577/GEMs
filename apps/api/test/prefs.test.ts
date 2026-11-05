/**
 * 002/US4 — notification preferences per (org, user) and the "Send a test alert" endpoint.
 * T064 (FR-031): defaults when no row, full-object PUT round-trip, per-org isolation, viewer edits own prefs.
 * T066 (FR-034, NFR-007): POST /me/notifications/test with the log adapters (not configured → `skipped`).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notificationPrefs, notifications } from '@tp/db';
import type { Mailer } from '../src/deps';
import { createTestContext, request, seedOrgWithRoles, signup, type TestContext } from './helpers';

const DEFAULTS = { inApp: true, email: true, whatsapp: false, frequency: 'instant', expiryReminders: true };

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext(); });
afterAll(async () => { await ctx?.close(); });

/** A user who owns org A and is a bid manager in org B; returns one cookie whose active org can be switched. */
async function twoOrgUser() {
  const a = await signup(ctx.app, { orgName: 'Alpha Prefs' });
  const b = await signup(ctx.app, { orgName: 'Beta Prefs' });
  const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: b.cookie, json: { email: a.email, role: 'bid_manager' } });
  const token = String(inv.body.inviteUrl).split('/invite/')[1];
  const acc = await request(ctx.app, 'POST', '/api/auth/accept-invite', { json: { token, password: a.password } });
  expect(acc.status).toBe(200);
  const cookie = acc.cookie!;
  const use = async (orgId: string) => expect((await request(ctx.app, 'POST', '/api/auth/switch-org', { cookie, json: { orgId } })).status).toBe(200);
  return { cookie, userId: a.me.user.id, orgA: a.me.org.id, orgB: b.me.org.id, use };
}

describe('002/FR-031 notification preferences', () => {
  it('GET returns the defaults when no row exists', async () => {
    const u = await signup(ctx.app);
    await ctx.db.delete(notificationPrefs).where(eq(notificationPrefs.userId, u.me.user.id));
    const r = await request(ctx.app, 'GET', '/api/me/notification-prefs', { cookie: u.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(DEFAULTS);
  });

  it('PUT upserts the full object (also when no row exists) and GET round-trips it', async () => {
    const u = await signup(ctx.app);
    await ctx.db.delete(notificationPrefs).where(eq(notificationPrefs.userId, u.me.user.id));
    const prefs = { inApp: false, email: false, whatsapp: false, frequency: 'daily', expiryReminders: false };
    const put = await request(ctx.app, 'PUT', '/api/me/notification-prefs', { cookie: u.cookie, json: prefs });
    expect(put.status).toBe(200);
    expect(put.body).toEqual(prefs);
    expect((await request(ctx.app, 'GET', '/api/me/notification-prefs', { cookie: u.cookie })).body).toEqual(prefs);

    const back = { ...DEFAULTS, frequency: 'daily' };
    await request(ctx.app, 'PUT', '/api/me/notification-prefs', { cookie: u.cookie, json: back });
    expect((await request(ctx.app, 'GET', '/api/me/notification-prefs', { cookie: u.cookie })).body).toEqual(back);
    const rows = await ctx.db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, u.me.user.id));
    expect(rows).toHaveLength(1);
  });

  it('PUT rejects a partial object (full object required)', async () => {
    const u = await signup(ctx.app);
    const r = await request(ctx.app, 'PUT', '/api/me/notification-prefs', { cookie: u.cookie, json: { frequency: 'daily' } });
    expect(r.status).toBe(400);
    expect((await request(ctx.app, 'GET', '/api/me/notification-prefs', { cookie: u.cookie })).body).toEqual(DEFAULTS);
  });

  it('preferences are isolated per org for a user in two orgs', async () => {
    const u = await twoOrgUser();
    await u.use(u.orgA);
    const daily = { ...DEFAULTS, frequency: 'daily', email: false };
    expect((await request(ctx.app, 'PUT', '/api/me/notification-prefs', { cookie: u.cookie, json: daily })).status).toBe(200);

    await u.use(u.orgB);
    expect((await request(ctx.app, 'GET', '/api/me/notification-prefs', { cookie: u.cookie })).body).toEqual(DEFAULTS);
    const bPrefs = { ...DEFAULTS, expiryReminders: false };
    await request(ctx.app, 'PUT', '/api/me/notification-prefs', { cookie: u.cookie, json: bPrefs });

    await u.use(u.orgA);
    expect((await request(ctx.app, 'GET', '/api/me/notification-prefs', { cookie: u.cookie })).body).toEqual(daily);
    const [rowA] = await ctx.db.select().from(notificationPrefs).where(and(eq(notificationPrefs.userId, u.userId), eq(notificationPrefs.orgId, u.orgA)));
    const [rowB] = await ctx.db.select().from(notificationPrefs).where(and(eq(notificationPrefs.userId, u.userId), eq(notificationPrefs.orgId, u.orgB)));
    expect(rowA).toMatchObject({ frequency: 'daily', email: false, expiryReminders: true });
    expect(rowB).toMatchObject({ frequency: 'instant', email: true, expiryReminders: false });
  });

  it('a viewer can edit their own preferences', async () => {
    const { viewer } = await seedOrgWithRoles(ctx.app);
    expect((await request(ctx.app, 'GET', '/api/me/notification-prefs', { cookie: viewer.cookie })).body).toEqual(DEFAULTS);
    const mine = { ...DEFAULTS, frequency: 'daily', inApp: false };
    const put = await request(ctx.app, 'PUT', '/api/me/notification-prefs', { cookie: viewer.cookie, json: mine });
    expect(put.status).toBe(200);
    expect((await request(ctx.app, 'GET', '/api/me/notification-prefs', { cookie: viewer.cookie })).body).toEqual(mine);
  });
});

describe('002/FR-034 POST /me/notifications/test', () => {
  const testRows = (userId: string) => ctx.db.select().from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.title, 'Test alert from TenderPilot')));

  it('with defaults: in-app row created, email attempted (log mailer → skipped), WhatsApp off', async () => {
    const u = await signup(ctx.app);
    const before = ctx.mailer.sent.length;
    const r = await request(ctx.app, 'POST', '/api/me/notifications/test', { cookie: u.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ inApp: 'sent', email: 'skipped', whatsapp: 'off' });
    expect(ctx.mailer.sent.length).toBe(before + 1);
    expect(ctx.mailer.sent.at(-1)).toMatchObject({ to: u.email, subject: 'Test alert from TenderPilot' });

    const list = await request(ctx.app, 'GET', '/api/notifications', { cookie: u.cookie });
    expect(list.body.items[0]).toMatchObject({ title: 'Test alert from TenderPilot', kind: 'system', read: false });
    expect(list.body.items[0].deliveries).toEqual([expect.objectContaining({ channel: 'email', status: 'skipped' })]);
    const rows = await testRows(u.me.user.id);
    expect(rows.map((x) => x.channel).sort()).toEqual(['email', 'in_app']);
    expect(rows.every((x) => x.status !== 'pending')).toBe(true);
  });

  it('is limited to 1 per minute per user (429 rate_limited + Retry-After)', async () => {
    const u = await signup(ctx.app);
    expect((await request(ctx.app, 'POST', '/api/me/notifications/test', { cookie: u.cookie })).status).toBe(200);
    const again = await request(ctx.app, 'POST', '/api/me/notifications/test', { cookie: u.cookie });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('rate_limited');
    const retry = Number(again.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(await testRows(u.me.user.id)).toHaveLength(2); // the rejected call created nothing

    // another user is not affected
    const other = await signup(ctx.app);
    expect((await request(ctx.app, 'POST', '/api/me/notifications/test', { cookie: other.cookie })).status).toBe(200);

    ctx.clock.advance(61_000);
    expect((await request(ctx.app, 'POST', '/api/me/notifications/test', { cookie: u.cookie })).status).toBe(200);
  });

  it('always creates the in-app row; email/WhatsApp only when enabled (in-app/email off, WhatsApp on)', async () => {
    const u = await signup(ctx.app);
    await request(ctx.app, 'PATCH', '/api/me', { cookie: u.cookie, json: { phone: '+919822012345' } });
    await request(ctx.app, 'PUT', '/api/me/notification-prefs', { cookie: u.cookie, json: { ...DEFAULTS, inApp: false, email: false, whatsapp: true } });
    const mail = ctx.mailer.sent.length;
    const wa = ctx.whatsapp.sent.length;
    const r = await request(ctx.app, 'POST', '/api/me/notifications/test', { cookie: u.cookie });
    expect(r.body).toEqual({ inApp: 'sent', email: 'off', whatsapp: 'skipped' });
    expect(ctx.mailer.sent.length).toBe(mail);
    expect(ctx.whatsapp.sent.length).toBe(wa + 1);
    expect(ctx.whatsapp.sent.at(-1)!.to).toBe('+919822012345');
    const rows = await testRows(u.me.user.id);
    expect(rows.map((x) => [x.channel, x.status]).sort()).toEqual([['in_app', 'sent'], ['whatsapp', 'skipped']]);
    const list = await request(ctx.app, 'GET', '/api/notifications', { cookie: u.cookie });
    expect(list.body.items[0]).toMatchObject({ title: 'Test alert from TenderPilot' });
  });

  it('WhatsApp on but the mobile was cleared later → skipped without calling the provider', async () => {
    const u = await signup(ctx.app);
    await request(ctx.app, 'PATCH', '/api/me', { cookie: u.cookie, json: { phone: '+919822012345' } });
    await request(ctx.app, 'PUT', '/api/me/notification-prefs', { cookie: u.cookie, json: { ...DEFAULTS, whatsapp: true } });
    await request(ctx.app, 'PATCH', '/api/me', { cookie: u.cookie, json: { phone: null } });
    const wa = ctx.whatsapp.sent.length;
    const r = await request(ctx.app, 'POST', '/api/me/notifications/test', { cookie: u.cookie });
    expect(r.body).toMatchObject({ whatsapp: 'skipped' });
    expect(ctx.whatsapp.sent.length).toBe(wa);
    const [row] = (await testRows(u.me.user.id)).filter((x) => x.channel === 'whatsapp');
    expect(row.error).toBe('No mobile number on the account');
  });

  it('reports `sent` from a configured provider and `failed` when it throws', async () => {
    const original = ctx.deps.mailer;
    try {
      const ok: Mailer = { configured: true, send: async () => ({ id: 'msg_1' }) };
      ctx.deps.mailer = ok;
      const u = await signup(ctx.app);
      expect((await request(ctx.app, 'POST', '/api/me/notifications/test', { cookie: u.cookie })).body.email).toBe('sent');

      ctx.deps.mailer = { configured: true, send: async () => { throw new Error('Resend error 500'); } };
      const v = await signup(ctx.app);
      const r = await request(ctx.app, 'POST', '/api/me/notifications/test', { cookie: v.cookie });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ inApp: 'sent', email: 'failed', whatsapp: 'off' });
      const [row] = (await testRows(v.me.user.id)).filter((x) => x.channel === 'email');
      expect(row).toMatchObject({ status: 'failed', error: 'Resend error 500' });
    } finally {
      ctx.deps.mailer = original;
    }
  });

  it('uses the preferences of the active org (two-org user)', async () => {
    const u = await twoOrgUser();
    await request(ctx.app, 'PATCH', '/api/me', { cookie: u.cookie, json: { phone: '+919822012345' } });
    await u.use(u.orgA);
    expect((await request(ctx.app, 'PUT', '/api/me/notification-prefs', { cookie: u.cookie, json: { ...DEFAULTS, whatsapp: true } })).status).toBe(200);

    await u.use(u.orgB); // org B keeps the defaults
    const wa = ctx.whatsapp.sent.length;
    const inB = await request(ctx.app, 'POST', '/api/me/notifications/test', { cookie: u.cookie });
    expect(inB.body).toEqual({ inApp: 'sent', email: 'skipped', whatsapp: 'off' });
    expect(ctx.whatsapp.sent.length).toBe(wa);

    ctx.clock.advance(61_000);
    await u.use(u.orgA);
    const inA = await request(ctx.app, 'POST', '/api/me/notifications/test', { cookie: u.cookie });
    expect(inA.status).toBe(200);
    expect(inA.body).toEqual({ inApp: 'sent', email: 'skipped', whatsapp: 'skipped' });
    expect(ctx.whatsapp.sent.length).toBe(wa + 1);
    expect(ctx.whatsapp.sent.at(-1)!.to).toBe('+919822012345');

    const rows = await testRows(u.userId);
    expect(rows.filter((x) => x.orgId === u.orgB).map((x) => x.channel).sort()).toEqual(['email', 'in_app']);
    expect(rows.filter((x) => x.orgId === u.orgA).map((x) => x.channel).sort()).toEqual(['email', 'in_app', 'whatsapp']);
  });

  it('requires a signed-in web session', async () => {
    expect((await request(ctx.app, 'POST', '/api/me/notifications/test')).status).toBe(401);
    const u = await signup(ctx.app);
    const tok = await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: u.cookie, json: { name: 'ext' } });
    expect((await request(ctx.app, 'POST', '/api/me/notifications/test', { bearer: tok.body.token })).status).toBe(403);
  });
});
