/** 002/FR-012, FR-036: list and revoke your own sessions; session-only. */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessions } from '@tp/db';
import { createTestContext, request, signup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext(); });
afterAll(async () => { await ctx?.close(); });
beforeEach(() => { ctx.clock.set(new Date()); });

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';

async function loginAs(email: string, password: string, ua: string) {
  const r = await request(ctx.app, 'POST', '/api/auth/login', { headers: { 'user-agent': ua }, json: { email, password } });
  expect(r.status).toBe(200);
  return r.cookie!;
}

describe('session metadata', () => {
  it('records user agent and last_seen_at at sign-in and refreshes last_seen_at at most every 5 minutes', async () => {
    const a = await signup(ctx.app);
    const cookie = await loginAs(a.email, a.password, CHROME_WIN);
    const all = await ctx.db.select().from(sessions).where(eq(sessions.userId, a.me.user.id));
    const s = all.find((x) => x.userAgent === CHROME_WIN)!;
    expect(s).toBeTruthy();
    const t0 = s.lastSeenAt!.getTime();
    expect(t0).toBe(ctx.clock.now().getTime());

    ctx.clock.advance(2 * 60_000);
    await request(ctx.app, 'GET', '/api/auth/me', { cookie });
    let [row] = await ctx.db.select().from(sessions).where(eq(sessions.id, s.id));
    expect(row.lastSeenAt!.getTime()).toBe(t0);

    ctx.clock.advance(4 * 60_000);
    await request(ctx.app, 'GET', '/api/auth/me', { cookie });
    [row] = await ctx.db.select().from(sessions).where(eq(sessions.id, s.id));
    expect(row.lastSeenAt!.getTime()).toBe(ctx.clock.now().getTime());
  });
});

describe('GET /api/me/sessions', () => {
  it('lists the caller’s active sessions with device summary and current flag (current first)', async () => {
    const a = await signup(ctx.app);
    const b = await signup(ctx.app); // another user's sessions must not appear
    await request(ctx.app, 'POST', '/api/auth/logout', { cookie: a.cookie });
    const c1 = await loginAs(a.email, a.password, CHROME_WIN);
    ctx.clock.advance(60_000);
    const c2 = await loginAs(a.email, a.password, SAFARI_IOS);
    ctx.clock.advance(60_000);
    const c3 = await loginAs(a.email, a.password, FIREFOX_LINUX);

    const r = await request(ctx.app, 'GET', '/api/me/sessions', { cookie: c2 });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.items.map((s: any) => s.device)).toEqual(['Safari on iOS', 'Firefox on Linux', 'Chrome on Windows']);
    expect(r.body.items.map((s: any) => s.current)).toEqual([true, false, false]);
    expect(r.body.items[0]).toEqual({
      id: expect.any(String), current: true, userAgent: SAFARI_IOS, device: 'Safari on iOS',
      createdAt: expect.any(String), lastSeenAt: expect.any(String),
    });
    // No secrets in the response.
    expect(r.text).not.toMatch(/token|hash/i);
    expect(r.text).not.toContain(c1.split('=')[1]);
    expect(r.text).not.toContain(b.me.user.id);
    void c3;
  });

  it('does not list expired sessions', async () => {
    const a = await signup(ctx.app);
    ctx.clock.advance(31 * 24 * 60 * 60_000);
    const fresh = await loginAs(a.email, a.password, CHROME_WIN);
    const r = await request(ctx.app, 'GET', '/api/me/sessions', { cookie: fresh });
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].current).toBe(true);
  });

  it('is session-only: API tokens get 403, signed-out gets 401', async () => {
    const a = await signup(ctx.app);
    const tok = await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: a.cookie, json: { name: 'ext' } });
    const bearer = tok.body.token as string;
    expect((await request(ctx.app, 'GET', '/api/me/sessions', { bearer })).status).toBe(403);
    expect((await request(ctx.app, 'POST', '/api/me/sessions/revoke-others', { bearer })).status).toBe(403);
    const [s] = await ctx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, a.me.user.id));
    expect((await request(ctx.app, 'DELETE', `/api/me/sessions/${s.id}`, { bearer })).status).toBe(403);
    expect((await request(ctx.app, 'GET', '/api/me/sessions')).status).toBe(401);
    // the session survived the token attempts
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(200);
  });
});

describe('DELETE /api/me/sessions/:id', () => {
  it('revokes one of your sessions: that device’s next request is 401', async () => {
    const a = await signup(ctx.app);
    const phone = await loginAs(a.email, a.password, SAFARI_IOS);
    const list = await request(ctx.app, 'GET', '/api/me/sessions', { cookie: a.cookie });
    const target = list.body.items.find((s: any) => s.device === 'Safari on iOS');
    const r = await request(ctx.app, 'DELETE', `/api/me/sessions/${target.id}`, { cookie: a.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: phone })).status).toBe(401);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(200);
    // already gone → 404
    expect((await request(ctx.app, 'DELETE', `/api/me/sessions/${target.id}`, { cookie: a.cookie })).status).toBe(404);
  });

  it('another user’s session or a malformed id is 404 and nothing is deleted', async () => {
    const a = await signup(ctx.app);
    const b = await signup(ctx.app);
    const [bs] = await ctx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, b.me.user.id));
    const r = await request(ctx.app, 'DELETE', `/api/me/sessions/${bs.id}`, { cookie: a.cookie });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: b.cookie })).status).toBe(200);
    expect((await request(ctx.app, 'DELETE', '/api/me/sessions/not-a-uuid', { cookie: a.cookie })).status).toBe(404);
  });

  it('revoking the current session signs you out and clears the cookie', async () => {
    const a = await signup(ctx.app);
    const list = await request(ctx.app, 'GET', '/api/me/sessions', { cookie: a.cookie });
    const r = await request(ctx.app, 'DELETE', `/api/me/sessions/${list.body.items[0].id}`, { cookie: a.cookie });
    expect(r.status).toBe(200);
    expect(r.res.headers.get('set-cookie')).toMatch(/tp_session=;/);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(401);
  });
});

describe('POST /api/me/sessions/revoke-others', () => {
  it('signs out every other session of the caller only', async () => {
    const a = await signup(ctx.app);
    const b = await signup(ctx.app);
    const o1 = await loginAs(a.email, a.password, SAFARI_IOS);
    const o2 = await loginAs(a.email, a.password, FIREFOX_LINUX);
    const r = await request(ctx.app, 'POST', '/api/me/sessions/revoke-others', { cookie: a.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ revoked: 2 });
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: o1 })).status).toBe(401);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: o2 })).status).toBe(401);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(200);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: b.cookie })).status).toBe(200);
    const again = await request(ctx.app, 'POST', '/api/me/sessions/revoke-others', { cookie: a.cookie });
    expect(again.body).toEqual({ revoked: 0 });
    const list = await request(ctx.app, 'GET', '/api/me/sessions', { cookie: a.cookie });
    expect(list.body.total).toBe(1);
  });
});
