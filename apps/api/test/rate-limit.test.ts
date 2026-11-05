/** 002/FR-010, SC-007: Postgres-backed auth rate limiting (lib/rate-limit.ts + wiring in routes/auth.ts). */
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LOGIN_EMAIL_LIMIT, check, clientIp, hit, rateLimited, reset } from '../src/lib/rate-limit';
import { createTestContext, request, signup, uniqueEmail, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext(); });
afterAll(async () => { await ctx?.close(); });
beforeEach(() => { ctx.clock.set(new Date()); });

const MIN = 60_000;
let ipSeq = 0;
/** A fresh client IP per test so the 30/IP budget does not leak between tests. */
const freshIp = () => `203.0.113.${++ipSeq}`;

describe('rate-limit lib', () => {
  const opts = { limit: 3, windowMs: 15 * MIN };

  it('hit counts atomically within a window, check reports limited + Retry-After, reset clears', async () => {
    const key = uniqueEmail('lib');
    const now = ctx.clock.now();
    expect(await check(ctx.db, key, 'login_email', opts, now)).toBeNull();
    const states = await Promise.all([1, 2, 3].map(() => hit(ctx.db, key, 'login_email', opts, now)));
    expect(states.map((s) => s.count).sort()).toEqual([1, 2, 3]); // concurrent upserts never lose a count
    const st = await check(ctx.db, key, 'login_email', opts, new Date(now.getTime() + 5 * MIN));
    expect(st).toMatchObject({ count: 3, limited: true, retryAfterSec: 600 });
    // Different kind is a different bucket.
    expect(await check(ctx.db, key, 'login_ip', opts, now)).toBeNull();
    await reset(ctx.db, key, 'login_email');
    expect(await check(ctx.db, key, 'login_email', opts, now)).toBeNull();
  });

  it('a window that has elapsed starts over at 1', async () => {
    const key = uniqueEmail('lib');
    const t0 = ctx.clock.now();
    for (let i = 0; i < 3; i++) await hit(ctx.db, key, 'login_email', opts, t0);
    const later = new Date(t0.getTime() + 15 * MIN);
    expect(await check(ctx.db, key, 'login_email', opts, later)).toBeNull();
    const st = await hit(ctx.db, key, 'login_email', opts, later);
    expect(st).toMatchObject({ count: 1, limited: false });
    expect(st.windowStart.getTime()).toBe(later.getTime());
  });

  it('rateLimited() builds a 429 with Retry-After and minutes in the message', () => {
    const e = rateLimited(601);
    expect(e.status).toBe(429);
    expect(e.code).toBe('rate_limited');
    expect(e.message).toBe('Too many attempts. Try again in 11 minutes.');
    expect(e.headers).toEqual({ 'Retry-After': '601' });
    expect(rateLimited(30).message).toBe('Too many attempts. Try again in 1 minute.');
  });

  it('clientIp prefers cf-connecting-ip, then the first x-forwarded-for hop, else null', async () => {
    const app = new Hono().get('/', (c) => c.json({ ip: clientIp(c) }));
    const ip = async (headers: Record<string, string>) => ((await (await app.request('/', { headers })).json()) as { ip: string | null }).ip;
    expect(await ip({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '10.0.0.1' })).toBe('198.51.100.7');
    expect(await ip({ 'x-forwarded-for': ' 198.51.100.8 , 10.0.0.1' })).toBe('198.51.100.8');
    expect(await ip({})).toBeNull();
  });
});

describe('login rate limiting', () => {
  it('the 11th attempt within 15 minutes is 429 even with the right password; opens again after the window', async () => {
    const a = await signup(ctx.app);
    const headers = { 'x-forwarded-for': freshIp() };
    for (let i = 0; i < LOGIN_EMAIL_LIMIT.limit; i++) {
      const r = await request(ctx.app, 'POST', '/api/auth/login', { headers, json: { email: a.email, password: `wrong-${i}` } });
      expect(r.status).toBe(401);
    }
    const blocked = await request(ctx.app, 'POST', '/api/auth/login', { headers, json: { email: a.email.toUpperCase(), password: a.password } });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatchObject({ code: 'rate_limited', message: 'Too many attempts. Try again in 15 minutes.' });
    expect(blocked.headers.get('retry-after')).toBe('900');
    expect(blocked.cookie).toBeNull();

    ctx.clock.advance(10 * MIN);
    const still = await request(ctx.app, 'POST', '/api/auth/login', { headers, json: { email: a.email, password: a.password } });
    expect(still.status).toBe(429);
    expect(still.body.error.message).toBe('Too many attempts. Try again in 5 minutes.');
    expect(still.headers.get('retry-after')).toBe('300');

    ctx.clock.advance(5 * MIN);
    const ok = await request(ctx.app, 'POST', '/api/auth/login', { headers, json: { email: a.email, password: a.password } });
    expect(ok.status).toBe(200);
  });

  it('a successful login resets the email counter', async () => {
    const a = await signup(ctx.app);
    const headers = { 'x-forwarded-for': freshIp() };
    for (let i = 0; i < 9; i++) await request(ctx.app, 'POST', '/api/auth/login', { headers, json: { email: a.email, password: 'wrong-pass' } });
    expect((await request(ctx.app, 'POST', '/api/auth/login', { headers, json: { email: a.email, password: a.password } })).status).toBe(200);
    for (let i = 0; i < 9; i++) {
      expect((await request(ctx.app, 'POST', '/api/auth/login', { headers, json: { email: a.email, password: 'wrong-pass' } })).status).toBe(401);
    }
    expect((await request(ctx.app, 'POST', '/api/auth/login', { headers, json: { email: a.email, password: a.password } })).status).toBe(200);
  });

  it('unknown emails are counted the same way (no account enumeration)', async () => {
    const email = uniqueEmail('ghost');
    const headers = { 'x-forwarded-for': freshIp() };
    for (let i = 0; i < 10; i++) await request(ctx.app, 'POST', '/api/auth/login', { headers, json: { email, password: 'wrong-pass' } });
    const r = await request(ctx.app, 'POST', '/api/auth/login', { headers, json: { email, password: 'wrong-pass' } });
    expect(r.status).toBe(429);
  });

  it('30 failures from one IP block that IP for every email, other IPs are unaffected', async () => {
    const victim = await signup(ctx.app);
    const ip = freshIp();
    for (let i = 0; i < 30; i++) {
      const r = await request(ctx.app, 'POST', '/api/auth/login', { headers: { 'cf-connecting-ip': ip }, json: { email: uniqueEmail('spray'), password: 'wrong-pass' } });
      expect(r.status).toBe(401);
    }
    const blocked = await request(ctx.app, 'POST', '/api/auth/login', { headers: { 'cf-connecting-ip': ip }, json: { email: victim.email, password: victim.password } });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    const other = await request(ctx.app, 'POST', '/api/auth/login', { headers: { 'cf-connecting-ip': freshIp() }, json: { email: victim.email, password: victim.password } });
    expect(other.status).toBe(200);
  });
});

describe('accept-invite (existing user) and change-password share the limits', () => {
  it('existing-user accept-invite: 11th attempt is 429; success resets the counter', async () => {
    const orgA = await signup(ctx.app);
    const orgB = await signup(ctx.app);
    const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: orgB.cookie, json: { email: orgA.email, role: 'analyst' } });
    const token = String(inv.body.inviteUrl).split('/invite/')[1];
    const headers = { 'x-forwarded-for': freshIp() };
    for (let i = 0; i < 10; i++) {
      const r = await request(ctx.app, 'POST', '/api/auth/accept-invite', { headers, json: { token, password: 'wrong-pass' } });
      expect(r.status).toBe(401);
    }
    const blocked = await request(ctx.app, 'POST', '/api/auth/accept-invite', { headers, json: { token, password: orgA.password } });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.headers.get('retry-after')).toBe('900');
    // The email counter is shared with login.
    expect((await request(ctx.app, 'POST', '/api/auth/login', { headers, json: { email: orgA.email, password: orgA.password } })).status).toBe(429);

    ctx.clock.advance(15 * MIN);
    const ok = await request(ctx.app, 'POST', '/api/auth/accept-invite', { headers, json: { token, password: orgA.password } });
    expect(ok.status).toBe(200);
    expect(await check(ctx.db, orgA.email, 'login_email', LOGIN_EMAIL_LIMIT, ctx.clock.now())).toBeNull();
  });

  it('new-user accept-invite is not counted', async () => {
    const owner = await signup(ctx.app);
    const email = uniqueEmail('newbie');
    const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: owner.cookie, json: { email, role: 'viewer' } });
    const token = String(inv.body.inviteUrl).split('/invite/')[1];
    for (let i = 0; i < 12; i++) {
      expect((await request(ctx.app, 'POST', '/api/auth/accept-invite', { json: { token, name: 'N', password: 'short' } })).status).toBe(400);
    }
    expect(await check(ctx.db, email, 'login_email', LOGIN_EMAIL_LIMIT, ctx.clock.now())).toBeNull();
  });

  it('POST /me/password: 11th attempt is 429', async () => {
    const a = await signup(ctx.app);
    const headers = { 'x-forwarded-for': freshIp() };
    for (let i = 0; i < 10; i++) {
      const r = await request(ctx.app, 'POST', '/api/me/password', { cookie: a.cookie, headers, json: { currentPassword: 'wrong-pass', newPassword: 'new-password-9' } });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_credentials');
    }
    const blocked = await request(ctx.app, 'POST', '/api/me/password', { cookie: a.cookie, headers, json: { currentPassword: a.password, newPassword: 'new-password-9' } });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('900');
    ctx.clock.advance(15 * MIN);
    const ok = await request(ctx.app, 'POST', '/api/me/password', { cookie: a.cookie, headers, json: { currentPassword: a.password, newPassword: 'new-password-9' } });
    expect(ok.status).toBe(200);
  });

  it('auth_attempts never stores secrets', async () => {
    const res = await ctx.db.execute(sql`select key from auth_attempts`);
    const keys = (res as unknown as { rows: { key: string }[] }).rows.map((r) => r.key);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).toMatch(/@|^\d+\.\d+\.\d+\.\d+$/);
  });
});
