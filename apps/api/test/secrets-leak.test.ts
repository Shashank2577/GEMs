/**
 * 002/NFR-003, SC-004: secret-leak scanner. Runs the auth / org / token / invite / reset flows (happy paths and the
 * usual failures) with a capturing logger and request logging ON, then asserts that no password, session token,
 * `tp_` API token, invitation or reset token — nor the stored hash of any of them, nor a password hash — appears in
 * the logs, in any list/read response, or in activity `meta`.
 *
 * Responses that hand a secret to its owner once by design (the created API token, the created/resent invitation's
 * `inviteUrl`) are not "list responses" and are excluded; everything else is scanned.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import type { AppDeps, Logger } from '../src/deps';
import { createLogMailer } from '../src/adapters/mailer';
import { createLogWhatsApp } from '../src/adapters/whatsapp';
import { loadConfig } from '../src/env';
import { sha256Hex } from '../src/lib/crypto';
import { settleDeferred } from '../src/lib/defer';
import { createTestContext, request, TEST_APP_URL, uniqueEmail, type TestContext, type TestResponse } from './helpers';

let ctx: TestContext;
let app: App;
let deps: AppDeps;
let mailer: ReturnType<typeof createLogMailer>;
const logs: string[] = [];

const capture = (level: string): Logger[keyof Logger] => (msg, meta) => { logs.push(`${level} ${msg} ${meta ? JSON.stringify(meta) : ''}`); };
const logger: Logger = { info: capture('info'), warn: capture('warn'), error: capture('error') };

beforeAll(async () => {
  ctx = await createTestContext();
  mailer = createLogMailer(logger);
  deps = {
    ...ctx.deps,
    logger,
    mailer,
    whatsapp: createLogWhatsApp(logger),
    // Request logging ON (as in development/production) so request lines are scanned too.
    config: loadConfig({ APP_URL: TEST_APP_URL, NODE_ENV: 'test', LOG_REQUESTS: '1', TRUST_PROXY: 'xff' }),
  };
  app = createApp(deps);
});
afterAll(async () => { await ctx?.close(); });

/** Every secret seen during the run (raw values); their sha256 hashes are added before scanning. */
const secrets = new Set<string>();
/** Bodies of every read/list response, scanned at the end. */
const reads: { label: string; text: string }[] = [];

const cookieValue = (cookie: string | null) => cookie?.split('=')[1] ?? null;
function keep(...values: (string | null | undefined)[]) {
  for (const v of values) if (v) secrets.add(v);
}
async function read(label: string, r: Promise<TestResponse>) {
  const res = await r;
  expect(res.status, `${label}: ${res.text}`).toBeLessThan(500);
  reads.push({ label, text: res.text });
  return res;
}
const tokenFromUrl = (url: string, part: 'invite' | 'reset-password') => String(url).split(`/${part}/`)[1];

describe('002/SC-004 no secret in logs, list responses or activity meta', () => {
  it('runs every platform flow and finds no secret anywhere', async () => {
    const H = { 'x-forwarded-for': '198.51.100.23', 'user-agent': 'LeakScanner/1.0' };
    // ── signup / login / failures ──
    const owner = { name: 'Leak Owner', email: uniqueEmail('leak'), password: 'owner-Secret-111', orgName: 'Leak Traders' };
    keep(owner.password);
    const su = await request(app, 'POST', '/api/auth/signup', { json: owner, headers: H });
    expect(su.status).toBe(201);
    let ownerCookie = su.cookie!;
    keep(cookieValue(ownerCookie));

    keep('wrong-Secret-222', 'short');
    expect((await request(app, 'POST', '/api/auth/login', { json: { email: owner.email, password: 'wrong-Secret-222' }, headers: H })).status).toBe(401);
    expect((await request(app, 'POST', '/api/auth/signup', { json: { ...owner, email: uniqueEmail('leak'), password: 'short' }, headers: H })).status).toBe(400);
    const li = await request(app, 'POST', '/api/auth/login', { json: { email: owner.email, password: owner.password }, headers: H });
    expect(li.status).toBe(200);
    keep(cookieValue(li.cookie));
    await read('me', request(app, 'GET', '/api/auth/me', { cookie: ownerCookie }));

    // ── change password ──
    keep('owner-Secret-333');
    expect((await request(app, 'POST', '/api/me/password', { cookie: ownerCookie, json: { currentPassword: 'nope-Secret-444', newPassword: 'owner-Secret-333' }, headers: H })).status).toBe(400);
    keep('nope-Secret-444');
    expect((await request(app, 'POST', '/api/me/password', { cookie: ownerCookie, json: { currentPassword: owner.password, newPassword: 'owner-Secret-333' }, headers: H })).status).toBe(200);

    // ── API tokens ──
    const tok = await request(app, 'POST', '/api/me/api-tokens', { cookie: ownerCookie, json: { name: 'Chrome extension' } });
    expect(tok.status).toBe(201);
    const apiToken: string = tok.body.token;
    expect(apiToken.startsWith('tp_')).toBe(true);
    keep(apiToken);
    await read('me via bearer', request(app, 'GET', '/api/auth/me', { bearer: apiToken }));
    await read('token list', request(app, 'GET', '/api/me/api-tokens', { cookie: ownerCookie }));
    const tok2 = await request(app, 'POST', '/api/me/api-tokens', { cookie: ownerCookie, json: { name: 'revoked' } });
    keep(tok2.body.token);
    expect((await request(app, 'DELETE', `/api/me/api-tokens/${tok2.body.id}`, { cookie: ownerCookie })).status).toBe(200);
    expect((await request(app, 'GET', '/api/auth/me', { bearer: tok2.body.token })).status).toBe(401);
    expect((await request(app, 'GET', '/api/auth/me', { bearer: 'tp_not-a-real-token-but-secret-looking' })).status).toBe(401);
    keep('tp_not-a-real-token-but-secret-looking');

    // ── invitations: create, preview, resend, accept (new user + existing user wrong password) ──
    const inviteeEmail = uniqueEmail('invitee');
    const inv = await request(app, 'POST', '/api/org/invitations', { cookie: ownerCookie, json: { email: inviteeEmail, role: 'analyst' } });
    expect(inv.status).toBe(201);
    const firstInvite = tokenFromUrl(inv.body.inviteUrl, 'invite');
    keep(firstInvite);
    await read('invite preview', request(app, 'GET', `/api/auth/invite/${firstInvite}`));
    const resent = await request(app, 'POST', `/api/org/invitations/${inv.body.id}/resend`, { cookie: ownerCookie });
    expect(resent.status).toBe(201);
    const inviteToken = tokenFromUrl(resent.body.inviteUrl, 'invite');
    keep(inviteToken);
    expect((await request(app, 'GET', `/api/auth/invite/${firstInvite}`)).status).toBe(404); // old link logged as a 404 too
    await read('members (pending invitation)', request(app, 'GET', '/api/org/members', { cookie: ownerCookie }));
    keep('invitee-Secret-555');
    const acc = await request(app, 'POST', '/api/auth/accept-invite', { json: { token: inviteToken, name: 'Ina Invitee', password: 'invitee-Secret-555' }, headers: H });
    expect(acc.status).toBe(200);
    keep(cookieValue(acc.cookie));

    // existing user (the owner of another org) joining with a wrong password, then the right one
    const other = { name: 'Other Owner', email: uniqueEmail('other'), password: 'other-Secret-666', orgName: 'Other Co' };
    keep(other.password);
    const os = await request(app, 'POST', '/api/auth/signup', { json: other, headers: H });
    keep(cookieValue(os.cookie));
    const inv2 = await request(app, 'POST', '/api/org/invitations', { cookie: ownerCookie, json: { email: other.email, role: 'viewer' } });
    const invite2 = tokenFromUrl(inv2.body.inviteUrl, 'invite');
    keep(invite2, 'wrong-Secret-777');
    expect((await request(app, 'POST', '/api/auth/accept-invite', { json: { token: invite2, password: 'wrong-Secret-777' }, headers: H })).status).toBe(401);
    const acc2 = await request(app, 'POST', '/api/auth/accept-invite', { json: { token: invite2, password: other.password }, headers: H });
    expect(acc2.status).toBe(200);
    keep(cookieValue(acc2.cookie));
    // a revoked invitation
    const inv3 = await request(app, 'POST', '/api/org/invitations', { cookie: ownerCookie, json: { email: uniqueEmail('revoked'), role: 'viewer' } });
    keep(tokenFromUrl(inv3.body.inviteUrl, 'invite'));
    expect((await request(app, 'DELETE', `/api/org/invitations/${inv3.body.id}`, { cookie: ownerCookie })).status).toBe(200);

    // ── forgot / reset password (background email) ──
    expect((await request(app, 'POST', '/api/auth/forgot-password', { json: { email: owner.email }, headers: H })).status).toBe(200);
    expect((await request(app, 'POST', '/api/auth/forgot-password', { json: { email: uniqueEmail('ghost') }, headers: H })).status).toBe(200);
    await settleDeferred(deps);
    const resetMail = mailer.sent.find((m) => m.subject === 'Reset your TenderPilot password')!;
    expect(resetMail).toBeTruthy();
    const resetToken = String(resetMail.text).match(/\/reset-password\/([A-Za-z0-9_-]+)/)![1];
    keep(resetToken, 'reset-Secret-888', 'not-a-real-reset-token-xyz');
    expect((await request(app, 'POST', '/api/auth/reset-password', { json: { token: 'not-a-real-reset-token-xyz', newPassword: 'reset-Secret-888' }, headers: H })).status).toBe(400);
    const rp = await request(app, 'POST', '/api/auth/reset-password', { json: { token: resetToken, newPassword: 'reset-Secret-888' }, headers: H });
    expect(rp.status).toBe(200);
    ownerCookie = rp.cookie!;
    keep(cookieValue(ownerCookie));
    expect((await request(app, 'POST', '/api/auth/reset-password', { json: { token: resetToken, newPassword: 'reset-Secret-888' }, headers: H })).status).toBe(400);

    // ── sessions, members, notifications, leave, logout ──
    const second = await request(app, 'POST', '/api/auth/login', { json: { email: owner.email, password: 'reset-Secret-888' }, headers: { ...H, 'user-agent': 'Second device' } });
    keep(cookieValue(second.cookie));
    await read('sessions', request(app, 'GET', '/api/me/sessions', { cookie: ownerCookie }));
    expect((await request(app, 'POST', '/api/me/sessions/revoke-others', { cookie: ownerCookie })).status).toBe(200);
    await read('members', request(app, 'GET', '/api/org/members', { cookie: ownerCookie }));
    expect((await request(app, 'POST', '/api/me/notifications/test', { cookie: ownerCookie })).status).toBe(200);
    await read('notifications', request(app, 'GET', '/api/notifications', { cookie: ownerCookie }));
    await read('prefs', request(app, 'GET', '/api/me/notification-prefs', { cookie: ownerCookie }));
    expect((await request(app, 'DELETE', '/api/org/members/me', { cookie: acc2.cookie! })).status).toBe(200);
    await read('activity', request(app, 'GET', '/api/activity?pageSize=100', { cookie: ownerCookie }));
    await read('org', request(app, 'GET', '/api/org', { cookie: ownerCookie }));
    expect((await request(app, 'POST', '/api/auth/logout', { cookie: ownerCookie })).status).toBe(200);
    await settleDeferred(deps);

    // ── what to look for: every secret, its sha256 (the stored form), and the stored password hashes ──
    for (const s of [...secrets]) secrets.add(await sha256Hex(s));
    const pw = await ctx.db.execute(sql`select password_hash from users`);
    for (const r of (pw as unknown as { rows: { password_hash: string }[] }).rows) {
      secrets.add(r.password_hash);
      secrets.add(r.password_hash.split('$').at(-1)!); // the derived key alone
    }
    const leaksIn = (text: string) => [...secrets].filter((s) => s.length >= 5 && text.includes(s));

    // the scan is meaningful: logs, reads and activity are non-trivial
    expect(logs.some((l) => l.includes('/api/auth/invite/:token'))).toBe(true); // request log lines (redacted)
    expect(logs.length).toBeGreaterThan(30);
    expect(reads.length).toBeGreaterThan(10);

    const logLeaks = logs.map((l) => ({ l, found: leaksIn(l) })).filter((x) => x.found.length);
    expect(logLeaks, 'secrets in logs').toEqual([]);

    const readLeaks = reads.map((r) => ({ label: r.label, found: leaksIn(r.text) })).filter((x) => x.found.length);
    expect(readLeaks, 'secrets in list/read responses').toEqual([]);

    const acts = await ctx.db.execute(sql`select action, meta::text as meta from activity_log`);
    const actRows = (acts as unknown as { rows: { action: string; meta: string }[] }).rows;
    expect(actRows.length).toBeGreaterThan(5);
    const metaLeaks = actRows.map((r) => ({ action: r.action, found: leaksIn(r.meta) })).filter((x) => x.found.length);
    expect(metaLeaks, 'secrets in activity meta').toEqual([]);
    // no meta key even suggests a secret
    for (const r of actRows) expect(r.meta, r.action).not.toMatch(/"(password|token|tokenHash|secret|hash)"/i);
  });
});
