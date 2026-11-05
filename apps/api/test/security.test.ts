/** 002/FR-028: Origin check on cookie-authenticated mutating requests (CSRF defence in depth). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/env';
import { createTestContext, request, signup, TEST_APP_URL, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext(); });
afterAll(async () => { await ctx?.close(); });

const EVIL = 'https://evil.example';

describe('Origin check middleware', () => {
  it('rejects a cookie-authenticated mutation from a foreign Origin with 403 bad_origin before the handler runs', async () => {
    const a = await signup(ctx.app, { orgName: 'Origin Co' });
    for (const [method, path, json] of [
      ['PATCH', '/api/org', { name: 'Pwned' }],
      ['POST', '/api/org/invitations', { email: 'x@evil.example', role: 'owner' }],
      ['PUT', '/api/me/notification-prefs', { inApp: false, email: false, whatsapp: false, frequency: 'daily', expiryReminders: false }],
      ['DELETE', '/api/org/members/me', undefined],
      ['POST', '/api/auth/logout', undefined],
    ] as const) {
      const r = await request(ctx.app, method, path, { cookie: a.cookie, json, headers: { origin: EVIL } });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error).toEqual({ code: 'bad_origin', message: expect.any(String) });
    }
    // nothing changed: still signed in, same name, no invitation
    const me = await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie });
    expect(me.status).toBe(200);
    expect(me.body.org.name).toBe('Origin Co');
    expect((await request(ctx.app, 'GET', '/api/org/members', { cookie: a.cookie })).body.invitations).toEqual([]);
  });

  it('"Origin: null" (sandboxed iframe, file://) and a look-alike origin are rejected too', async () => {
    const a = await signup(ctx.app);
    for (const origin of ['null', `${TEST_APP_URL}.evil.example`, 'https://tp.test', `${TEST_APP_URL}:8080`]) {
      const r = await request(ctx.app, 'PATCH', '/api/org', { cookie: a.cookie, json: { name: 'X' }, headers: { origin } });
      expect(r.status, origin).toBe(403);
      expect(r.body.error.code).toBe('bad_origin');
    }
  });

  it('allows the APP_URL origin, a missing Origin, and safe methods from any origin', async () => {
    const a = await signup(ctx.app);
    expect((await request(ctx.app, 'PATCH', '/api/org', { cookie: a.cookie, json: { name: 'Same Origin' }, headers: { origin: TEST_APP_URL } })).status).toBe(200);
    expect((await request(ctx.app, 'PATCH', '/api/org', { cookie: a.cookie, json: { name: 'No Origin' } })).status).toBe(200);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie, headers: { origin: EVIL } })).status).toBe(200);
    expect((await request(ctx.app, 'HEAD', '/api/org', { cookie: a.cookie, headers: { origin: EVIL } })).status).not.toBe(403);
  });

  it('bearer-token requests are exempt even from a foreign Origin', async () => {
    const a = await signup(ctx.app);
    const token = (await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: a.cookie, json: { name: 'ext' } })).body.token;
    const r = await request(ctx.app, 'PATCH', '/api/org', { bearer: token, json: { name: 'Via Extension' }, headers: { origin: 'chrome-extension://abcdef' } });
    expect(r.status).toBe(200);
    // ...but a non-TenderPilot bearer value does not exempt the cookie it rides along with
    const r2 = await request(ctx.app, 'PATCH', '/api/org', { cookie: a.cookie, json: { name: 'X' }, headers: { origin: EVIL, authorization: 'Bearer not-ours' } });
    expect(r2.status).toBe(403);
    expect(r2.body.error.code).toBe('bad_origin');
  });

  it('requests without a session cookie are not affected (login / signup errors stay as before)', async () => {
    const r = await request(ctx.app, 'POST', '/api/auth/login', { json: { email: 'nobody@example.in', password: 'whatever-123' }, headers: { origin: EVIL } });
    expect(r.status).toBe(401);
  });

  it('loopback origins are accepted only when APP_URL itself is loopback (local dev with Vite), whatever NODE_ENV says', async () => {
    const a = await signup(ctx.app);
    const build = (APP_URL: string, NODE_ENV: string) => createApp({ ...ctx.deps, config: loadConfig({ APP_URL, NODE_ENV }) });
    const local = build('http://localhost:8787', 'production');
    const deployed = build('https://app.tenderpilot.in', 'development');
    const patch = (app: ReturnType<typeof build>, origin: string) => request(app, 'PATCH', '/api/org', { cookie: a.cookie, json: {}, headers: { origin } });
    expect((await patch(local, 'http://localhost:5173')).status).toBe(200);
    expect((await patch(local, 'http://127.0.0.1:4173')).status).toBe(200);
    expect((await patch(local, EVIL)).status).toBe(403);
    expect((await patch(local, 'http://localhost.evil.example')).status).toBe(403);
    expect((await patch(deployed, 'https://app.tenderpilot.in')).status).toBe(200);
    expect((await patch(deployed, 'http://localhost:5173')).status).toBe(403);
    expect((await patch(deployed, 'http://localhost:8787')).status).toBe(403);
  });

  it('a cookie request without Origin is rejected when the browser marks it Sec-Fetch-Site: cross-site', async () => {
    const a = await signup(ctx.app, { orgName: 'Fetch Site Co' });
    const cross = await request(ctx.app, 'PATCH', '/api/org', { cookie: a.cookie, json: { name: 'Pwned' }, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('bad_origin');
    for (const site of ['same-origin', 'same-site', 'none']) {
      const r = await request(ctx.app, 'PATCH', '/api/org', { cookie: a.cookie, json: {}, headers: { 'sec-fetch-site': site } });
      expect(r.status, site).toBe(200);
    }
    // bearer requests stay exempt
    const token = (await request(ctx.app, 'POST', '/api/me/api-tokens', { cookie: a.cookie, json: { name: 'ext' } })).body.token;
    expect((await request(ctx.app, 'PATCH', '/api/org', { bearer: token, json: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
    expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie })).body.org.name).toBe('Fetch Site Co');
  });

  it('OPTIONS is not treated as a safe method: a cookie OPTIONS from a foreign origin is refused', async () => {
    const a = await signup(ctx.app);
    const r = await request(ctx.app, 'OPTIONS', '/api/org', { cookie: a.cookie, headers: { origin: EVIL } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('bad_origin');
    // a real CORS preflight carries no cookie and is unaffected (no CORS is granted: it simply 404s)
    expect((await request(ctx.app, 'OPTIONS', '/api/org', { headers: { origin: EVIL } })).status).not.toBe(403);
  });
});
