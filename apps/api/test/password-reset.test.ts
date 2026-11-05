/** 002/FR-011, NFR-003: self-service password reset. */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { passwordResets, users } from '@tp/db';
import { settleDeferred } from '../src/lib/defer';
import { createTestContext, request, signup, uniqueEmail, TEST_APP_URL, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext({ trustProxy: 'xff' }); });
afterAll(async () => { await ctx?.close(); });
beforeEach(() => { ctx.clock.set(new Date()); ctx.mailer.sent.length = 0; });

const MIN = 60_000;

/** forgot-password, then wait for its background work (lookup + token + email). */
async function forgot(email: string, headers?: Record<string, string>) {
  const r = await request(ctx.app, 'POST', '/api/auth/forgot-password', { json: { email }, headers });
  await settleDeferred(ctx.deps);
  return r;
}

/** Request a reset link and return the raw token taken from the logged email. */
async function requestReset(email: string): Promise<string> {
  const r = await forgot(email);
  expect(r.status).toBe(200);
  const msg = ctx.mailer.sent.at(-1)!;
  const m = String(msg.text).match(/\/reset-password\/([A-Za-z0-9_-]+)/);
  expect(m).toBeTruthy();
  return m![1];
}

describe('POST /api/auth/forgot-password', () => {
  it('always returns 200 {ok:true}; only existing users get an email with a 60-minute link', async () => {
    const a = await signup(ctx.app);
    const r = await forgot(a.email.toUpperCase());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(ctx.mailer.sent).toHaveLength(1);
    const msg = ctx.mailer.sent[0];
    expect(msg.to).toBe(a.email);
    expect(msg.subject).toBe('Reset your TenderPilot password');
    expect(msg.text).toContain(`${TEST_APP_URL}/reset-password/`);
    expect(msg.text).toContain('expires in 1 hour');

    const ghost = await forgot(uniqueEmail('ghost'));
    expect(ghost.status).toBe(200);
    expect(ghost.body).toEqual({ ok: true });
    expect(ctx.mailer.sent).toHaveLength(1);
  });

  it('stores only the token hash with a 60-minute expiry', async () => {
    const a = await signup(ctx.app);
    const token = await requestReset(a.email);
    const rows = await ctx.db.select().from(passwordResets).where(eq(passwordResets.userId, a.me.user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toContain(token);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].expiresAt.getTime() - ctx.clock.now().getTime()).toBe(60 * MIN);
  });

  it('validates the email (400) and rate-limits to 3 per email per hour (429, also for unknown emails)', async () => {
    const bad = await request(ctx.app, 'POST', '/api/auth/forgot-password', { json: { email: 'priya@' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields.email).toBeTruthy();

    for (const email of [(await signup(ctx.app)).email, uniqueEmail('ghost')]) {
      for (let i = 0; i < 3; i++) expect((await forgot(email)).status).toBe(200);
      const r = await forgot(email);
      expect(r.status).toBe(429);
      expect(r.body.error.code).toBe('rate_limited');
      expect(r.headers.get('retry-after')).toBe('3600');
    }
    ctx.clock.advance(60 * MIN);
  });

  it('limits requests per client IP (20 per hour) across emails', async () => {
    const headers = { 'x-forwarded-for': '198.51.100.99' };
    for (let i = 0; i < 20; i++) expect((await forgot(uniqueEmail('spray'), headers)).status).toBe(200);
    const r = await forgot(uniqueEmail('spray'), headers);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
    expect((await forgot(uniqueEmail('spray'), { 'x-forwarded-for': '198.51.100.100' })).status).toBe(200);
  });

  it('the account lookup and email happen in the background (same foreground work for unknown emails)', async () => {
    const a = await signup(ctx.app);
    await request(ctx.app, 'POST', '/api/auth/forgot-password', { json: { email: a.email } });
    await settleDeferred(ctx.deps);
    expect(ctx.mailer.sent).toHaveLength(1);
  });
});

describe('POST /api/auth/reset-password', () => {
  it('sets the password, signs out every session, consumes the link and signs the user in', async () => {
    const a = await signup(ctx.app);
    const other = (await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: a.password } })).cookie!;
    const token = await requestReset(a.email);

    const r = await request(ctx.app, 'POST', '/api/auth/reset-password', { json: { token, newPassword: 'brand-new-pass-1' } });
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe(a.email);
    expect(r.body.org.id).toBe(a.me.org.id);
    expect(r.cookie).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toContain(token);

    // every earlier session is gone; the new one works
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(401);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: other })).status).toBe(401);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: r.cookie! })).status).toBe(200);

    expect((await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: a.password } })).status).toBe(401);
    expect((await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: 'brand-new-pass-1' } })).status).toBe(200);

    // single use
    const again = await request(ctx.app, 'POST', '/api/auth/reset-password', { json: { token, newPassword: 'another-pass-2' } });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('reset_invalid');
  });

  it('expired, unknown and superseded links are 400 reset_invalid', async () => {
    const a = await signup(ctx.app);
    const first = await requestReset(a.email);
    const second = await requestReset(a.email);
    const superseded = await request(ctx.app, 'POST', '/api/auth/reset-password', { json: { token: first, newPassword: 'brand-new-pass-1' } });
    expect(superseded.status).toBe(400);
    expect(superseded.body.error).toMatchObject({ code: 'reset_invalid', message: expect.stringContaining('Request a new one') });

    ctx.clock.advance(61 * MIN);
    const expired = await request(ctx.app, 'POST', '/api/auth/reset-password', { json: { token: second, newPassword: 'brand-new-pass-1' } });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('reset_invalid');

    const unknown = await request(ctx.app, 'POST', '/api/auth/reset-password', { json: { token: 'not-a-real-token-xyz', newPassword: 'brand-new-pass-1' } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('reset_invalid');

    // The password is unchanged.
    expect((await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: a.password } })).status).toBe(200);
  });

  it('a too-short password is a validation error and does not consume the link', async () => {
    const a = await signup(ctx.app);
    const token = await requestReset(a.email);
    const short = await request(ctx.app, 'POST', '/api/auth/reset-password', { json: { token, newPassword: 'short' } });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe('validation_error');
    expect(short.body.error.details.fields.newPassword).toBeTruthy();
    expect((await request(ctx.app, 'POST', '/api/auth/reset-password', { json: { token, newPassword: 'long-enough-1' } })).status).toBe(200);
  });

  it('a successful reset lifts a sign-in lockout for that email', async () => {
    const a = await signup(ctx.app);
    for (let i = 0; i < 10; i++) await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: 'wrong-pass' } });
    expect((await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: a.password } })).status).toBe(429);
    const token = await requestReset(a.email);
    expect((await request(ctx.app, 'POST', '/api/auth/reset-password', { json: { token, newPassword: 'brand-new-pass-1' } })).status).toBe(200);
    expect((await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: 'brand-new-pass-1' } })).status).toBe(200);
  });

  it('never stores the password or token in plain text', async () => {
    const a = await signup(ctx.app);
    const token = await requestReset(a.email);
    await request(ctx.app, 'POST', '/api/auth/reset-password', { json: { token, newPassword: 'plain-text-check-1' } });
    const [u] = await ctx.db.select({ h: users.passwordHash }).from(users).where(eq(users.id, a.me.user.id));
    expect(u.h).toMatch(/^pbkdf2_sha256\$/);
    const dump = await ctx.db.execute(sql`select row_to_json(p)::text as j from password_resets p`);
    for (const row of (dump as unknown as { rows: { j: string }[] }).rows) {
      expect(row.j).not.toContain(token);
      expect(row.j).not.toContain('plain-text-check-1');
    }
  });
});
