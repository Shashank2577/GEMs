/**
 * 002/FR-028: Origin check on cookie-authenticated mutating requests (CSRF defence in depth).
 * 002/FR-050: security headers on API, Node static/SPA and Worker static responses.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inlineScriptHashes, inlineScripts, spaCsp } from '@tp/core/security/headers';
import { createApp } from '../src/app';
import { loadConfig } from '../src/env';
import { startNodeServer } from '../src/node';
import worker from '../src/worker';
import { createTestContext, request, signup, TEST_APP_URL, TEST_DATABASE_URL, type TestContext } from './helpers';

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

// ───────────── 002/FR-050 security headers ─────────────

const THEME_SCRIPT = `
      (function () { try { var t = localStorage.getItem('tp-theme'); if (t === 'dark') document.documentElement.classList.add('dark'); } catch (e) {} })();
    `;
const INDEX_HTML = `<!doctype html><html><head><title>TP</title><script>${THEME_SCRIPT}</script>`
  + `<script type="module" crossorigin src="/assets/index-abc.js"></script></head><body><div id="root"></div></body></html>`;
const sha256b64 = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64');

function expectBaseHeaders(h: Headers, label: string) {
  expect(h.get('x-content-type-options'), label).toBe('nosniff');
  expect(h.get('x-frame-options'), label).toBe('DENY');
  expect(h.get('referrer-policy'), label).toBe('no-referrer');
}

describe('002/FR-050 security headers', () => {
  it('every API response carries nosniff, DENY, no-referrer — success, 401, 404 and validation errors alike — and no CSP', async () => {
    const a = await signup(ctx.app);
    const cases = [
      await request(ctx.app, 'GET', '/api/health'),
      await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie }),
      await request(ctx.app, 'GET', '/api/auth/me'),
      await request(ctx.app, 'GET', '/api/does-not-exist'),
      await request(ctx.app, 'POST', '/api/auth/login', { json: { email: 'x' } }),
      await request(ctx.app, 'PATCH', '/api/org', { cookie: a.cookie, json: {}, headers: { origin: EVIL } }),
    ];
    expect(cases.map((r) => r.status)).toEqual([200, 200, 401, 404, 400, 403]);
    for (const r of cases) {
      expectBaseHeaders(r.headers, `${r.status}`);
      expect(r.headers.get('content-security-policy')).toBeNull();
      expect(r.headers.get('strict-transport-security')).toBeNull(); // plain http
    }
  });

  it('HSTS only on https (direct or x-forwarded-proto)', async () => {
    const direct = await ctx.app.request('https://tp.test/api/health');
    expect(direct.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    const proxied = await request(ctx.app, 'GET', '/api/health', { headers: { 'x-forwarded-proto': 'https' } });
    expect(proxied.headers.get('strict-transport-security')).toMatch(/^max-age=31536000/);
    expect((await request(ctx.app, 'GET', '/api/health')).headers.get('strict-transport-security')).toBeNull();
  });

  it('an inline file preview (content-disposition: inline) may be framed by the app itself only (SAMEORIGIN)', async () => {
    const owner = await signup(ctx.app);
    const d = await PDFDocument.create();
    d.addPage([200, 200]);
    const bytes = await d.save();
    const up = await request(ctx.app, 'POST', '/api/vault', { cookie: owner.cookie, form: { file: new File([bytes as BlobPart], 'gst.pdf', { type: 'application/pdf' }), type: 'gst', title: 'GST' } });
    expect(up.status).toBe(201);
    const inline = await request(ctx.app, 'GET', `/api/vault/${up.body.id}/download?inline=1`, { cookie: owner.cookie });
    expect(inline.headers.get('content-disposition')).toMatch(/^inline/);
    expect(inline.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(inline.headers.get('x-content-type-options')).toBe('nosniff');
    const attachment = await request(ctx.app, 'GET', `/api/vault/${up.body.id}/download`, { cookie: owner.cookie });
    expect(attachment.headers.get('x-frame-options')).toBe('DENY');
  });

  it('the CSP allows the inline theme script by its sha256 hash, never unsafe-inline/unsafe-eval for scripts', async () => {
    expect(inlineScripts(INDEX_HTML)).toEqual([THEME_SCRIPT]);
    const hashes = await inlineScriptHashes(INDEX_HTML);
    expect(hashes).toEqual([`'sha256-${sha256b64(THEME_SCRIPT)}'`]);
    const csp = spaCsp(hashes);
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '))!;
    expect(scriptSrc).toBe(`script-src 'self' 'sha256-${sha256b64(THEME_SCRIPT)}'`);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-eval/);
  });

  describe('Node server (apps/api/src/node.ts) static + SPA responses', () => {
    let dir: string;
    let node: Awaited<ReturnType<typeof startNodeServer>>;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'tp-web-'));
      await mkdir(join(dir, 'assets'));
      await writeFile(join(dir, 'index.html'), INDEX_HTML);
      await writeFile(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
      node = await startNodeServer({ PORT: '0', DATABASE_URL: TEST_DATABASE_URL, WEB_DIST: dir, BLOB_DIR: join(dir, 'blobs'), NODE_ENV: 'test', APP_URL: TEST_APP_URL });
    });
    afterAll(async () => { await node?.shutdown(); await rm(dir, { recursive: true, force: true }); });

    it('index.html, SPA deep links and assets carry the headers; HTML gets the CSP with the hash of the served file', async () => {
      const expected = spaCsp([`'sha256-${sha256b64(THEME_SCRIPT)}'`]);
      for (const path of ['/', '/settings/account', '/reset-password/abc123']) {
        const r = await node.server.request(`http://localhost${path}`);
        expect(r.status, path).toBe(200);
        expect(r.headers.get('content-type'), path).toMatch(/^text\/html/);
        expectBaseHeaders(r.headers, path);
        expect(r.headers.get('content-security-policy'), path).toBe(expected);
      }
      const js = await node.server.request('http://localhost/assets/index-abc.js');
      expect(js.status).toBe(200);
      expectBaseHeaders(js.headers, 'asset');
      expect(js.headers.get('content-security-policy')).toBeNull();
      const api = await node.server.request('http://localhost/api/health');
      expectBaseHeaders(api.headers, 'api');
      expect(api.headers.get('content-security-policy')).toBeNull();
      const https = await node.server.request('http://localhost/', { headers: { 'x-forwarded-proto': 'https' } });
      expect(https.headers.get('strict-transport-security')).toMatch(/^max-age=/);
    });

    it('a rebuilt index.html (changed theme script) gets a new hash without a restart', async () => {
      const changed = INDEX_HTML.replace("'tp-theme'", "'tp-theme-v2'");
      await writeFile(join(dir, 'index.html'), changed);
      const bump = new Date(Date.now() + 5_000);
      const { utimes } = await import('node:fs/promises');
      await utimes(join(dir, 'index.html'), bump, bump);
      const r = await node.server.request('http://localhost/');
      expect(r.headers.get('content-security-policy')).toBe(spaCsp(await inlineScriptHashes(changed)));
      expect(r.headers.get('content-security-policy')).not.toContain(sha256b64(THEME_SCRIPT));
    });
  });

  it('Worker static responses passing through the Worker get the headers and the CSP of the served HTML', async () => {
    const env = {
      ASSETS: {
        async fetch(req: Request) {
          return new URL(req.url).pathname.endsWith('.js')
            ? new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } })
            : new Response(INDEX_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        },
      },
    } as never;
    const ctxLike = { waitUntil() {} };
    const html = await worker.fetch(new Request('https://tenderpilot.example/invite/tok123'), env, ctxLike);
    expect(await html.text()).toBe(INDEX_HTML);
    expectBaseHeaders(html.headers, 'worker html');
    expect(html.headers.get('content-security-policy')).toBe(spaCsp([`'sha256-${sha256b64(THEME_SCRIPT)}'`]));
    expect(html.headers.get('strict-transport-security')).toMatch(/^max-age=31536000/);
    const js = await worker.fetch(new Request('https://tenderpilot.example/assets/a.js'), env, ctxLike);
    expectBaseHeaders(js.headers, 'worker js');
    expect(js.headers.get('content-security-policy')).toBeNull();
  });
});
