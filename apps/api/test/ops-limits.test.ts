/**
 * 008/US3 — request rate limits and body limits on real Postgres.
 * FR-017 (Postgres limiter), FR-018 (429 shape), FR-019 (every rule), FR-020 (fail-open / fail-closed), FR-021 (413).
 */
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rateLimits } from '@tp/db';
import type { Logger } from '../src/deps';
import { createPgRateLimiter, hit, pruneRateLimits, resetKey, windowStartOf } from '../src/lib/rate-limiter';
import { resetRateLimitWarnings } from '../src/middleware/rate-limit';
import { RATE_LIMIT_RULES, type GenericRuleName } from '../src/lib/rate-limit-rules';
import { createTestContext, request, seedOrgWithRoles, signup, uniqueEmail, type TestContext, type TestResponse } from './helpers';
import { file, pdf, seedTender } from './workspace-fixtures';

// 10:00:10 IST — 50 s left in the current minute window, 29 min 50 s left in the current hour window.
const NOW = new Date('2026-11-04T04:30:10Z');
const MB = 1024 * 1024;

let ctx: TestContext;
let org: Awaited<ReturnType<typeof seedOrgWithRoles>>;
let tenderId: string;
let vaultId: string;
const warnings: { msg: string; meta?: Record<string, unknown> }[] = [];

beforeAll(async () => {
  ctx = await createTestContext({
    now: NOW, trustProxy: 'xff', rateLimiter: (db) => createPgRateLimiter(db),
    // fetch-documents talks to "GeM": answer 404 so allowed calls finish quickly.
    fetch: async () => new Response('not found', { status: 404 }),
  });
  const spy: Logger = { info() {}, error() {}, warn(msg, meta) { warnings.push({ msg, meta }); } };
  ctx.deps.logger = spy;
  org = await seedOrgWithRoles(ctx.app, 'Limits Pvt Ltd');
  tenderId = (await seedTender(ctx)).id;
  const v = await request(ctx.app, 'POST', '/vault', { cookie: org.analyst.cookie, form: { file: file(await pdf('gst'), 'gst.pdf'), type: 'gst', title: 'GST' } });
  expect(v.status).toBe(201);
  vaultId = v.body.id;
});
afterAll(() => ctx?.close());
beforeEach(async () => {
  ctx.clock.set(NOW);
  await ctx.db.delete(rateLimits);
  warnings.length = 0;
  resetRateLimitWarnings();
});

const countOf = async (key: string) =>
  (await ctx.db.select({ n: rateLimits.count }).from(rateLimits).where(sql`${rateLimits.key} = ${key}`))[0]?.n ?? 0;

/** Put the counter of `rule:subject` for the current window at `count`. */
async function prefill(rule: GenericRuleName, subject: string, count: number) {
  const windowStart = windowStartOf(ctx.clock.now(), RATE_LIMIT_RULES[rule].windowSec);
  await ctx.db.insert(rateLimits).values({ key: `${rule}:${subject}`, windowStart, count })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count } });
}

function expect429(r: TestResponse, rule: string, retryAfter: number) {
  expect(r.status).toBe(429);
  expect(r.body.error.code).toBe('rate_limited');
  expect(r.body.error.details).toEqual({ rule, retryAfter });
  expect(r.headers.get('retry-after')).toBe(String(retryAfter));
}

describe('Postgres fixed-window limiter (lib/rate-limiter.ts)', () => {
  it('one atomic upsert per hit: concurrent hits never lose a count', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => hit(ctx.db, 'test:concurrent', 10, 60, NOW)));
    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(results.filter((r) => !r.allowed).length).toBe(2);
    expect(results.every((r) => r.retryAfterSec === 50)).toBe(true);
    const [row] = await ctx.db.select().from(rateLimits);
    expect(row).toMatchObject({ key: 'test:concurrent', count: 12, windowStart: new Date('2026-11-04T04:30:00Z') });
  });

  it('a new window starts at 1; resetKey forgets the key; prune drops dead windows', async () => {
    for (let i = 0; i < 3; i++) await hit(ctx.db, 'test:roll', 2, 60, NOW);
    expect(await hit(ctx.db, 'test:roll', 2, 60, new Date('2026-11-04T04:31:00Z'))).toMatchObject({ count: 1, allowed: true, retryAfterSec: 60 });
    await resetKey(ctx.db, 'test:roll');
    expect(await hit(ctx.db, 'test:roll', 2, 60, NOW)).toMatchObject({ count: 1 });
    await hit(ctx.db, 'test:old', 2, 60, new Date(NOW.getTime() - 3 * 3_600_000));
    expect(await pruneRateLimits(ctx.db, NOW)).toBe(1);
    const keys = (await ctx.db.select({ k: rateLimits.key }).from(rateLimits)).map((r) => r.k);
    expect(keys).toEqual(['test:roll']);
  });

  it('prunes in bounded batches until every dead window is gone (N2)', async () => {
    for (let i = 0; i < 5; i++) await hit(ctx.db, `test:dead${i}`, 2, 60, new Date(NOW.getTime() - 3 * 3_600_000));
    await hit(ctx.db, 'test:live', 2, 60, NOW);
    expect(await pruneRateLimits(ctx.db, NOW, 2)).toBe(5); // batches of 2, 2, 1
    expect((await ctx.db.select({ k: rateLimits.key }).from(rateLimits)).map((r) => r.k)).toEqual(['test:live']);
  });
});

describe('rule table (FR-019)', () => {
  it('has every rule of FR-019 with its limit and window', () => {
    const table = Object.fromEntries(Object.entries(RATE_LIMIT_RULES).map(([k, r]) => [k, [r.limit, r.windowSec, r.subject]]));
    expect(table).toEqual({
      'auth.fail.email': [10, 900, 'email'],
      'auth.fail.ip': [30, 900, 'ip'],
      'auth.signup.ip': [20, 3600, 'ip'],
      'auth.reset.email': [3, 3600, 'email'],
      'auth.reset.ip': [20, 3600, 'ip'],
      'watchlist.preview.user': [30, 60, 'user'],
      'upload.org': [120, 3600, 'org'],
      'gem.fetch.org': [30, 3600, 'org'],
      'analyse.user': [30, 3600, 'user'],
      'packet.org': [30, 3600, 'org'],
      'api.user': [600, 60, 'user_or_token'],
      'api.ip': [300, 60, 'ip'],
    });
    for (const [name, r] of Object.entries(RATE_LIMIT_RULES)) expect(r.failClosed).toBe(name.startsWith('auth.'));
  });
});

describe('limit + 1 → 429 for every generic rule, open again in the next window', () => {
  const IP = '203.0.113.77';
  const cases: { rule: GenericRuleName; subject: () => string; call: () => Promise<TestResponse> }[] = [
    {
      rule: 'auth.signup.ip', subject: () => IP,
      call: () => request(ctx.app, 'POST', '/auth/signup', { headers: { 'x-forwarded-for': IP }, json: { name: 'New Owner', email: uniqueEmail('su'), password: 'correct-horse-42', orgName: 'Signup Co' } }),
    },
    {
      rule: 'watchlist.preview.user', subject: () => org.analyst.me.user.id,
      call: () => request(ctx.app, 'POST', '/watchlists/preview', { cookie: org.analyst.cookie, json: { criteria: { keywords: ['laptop'] } } }),
    },
    {
      rule: 'upload.org', subject: () => org.orgId,
      call: async () => request(ctx.app, 'POST', '/vault', { cookie: org.analyst.cookie, form: { file: file(await pdf('pan'), 'pan.pdf'), type: 'pan', title: 'PAN' } }),
    },
    {
      rule: 'upload.org', subject: () => org.orgId,
      call: async () => request(ctx.app, 'PUT', `/vault/${vaultId}/file`, { cookie: org.analyst.cookie, form: { file: file(await pdf('gst2'), 'gst2.pdf') } }),
    },
    {
      rule: 'upload.org', subject: () => org.orgId,
      call: async () => request(ctx.app, 'POST', `/tenders/${tenderId}/documents`, { cookie: org.analyst.cookie, form: { file: file(await pdf('bid'), 'bid.pdf') } }),
    },
    { rule: 'gem.fetch.org', subject: () => org.orgId, call: () => request(ctx.app, 'POST', `/tenders/${tenderId}/fetch-documents`, { cookie: org.analyst.cookie }) },
    { rule: 'analyse.user', subject: () => org.analyst.me.user.id, call: () => request(ctx.app, 'POST', `/tenders/${tenderId}/analyse`, { cookie: org.analyst.cookie }) },
    {
      rule: 'packet.org', subject: () => org.orgId,
      call: () => request(ctx.app, 'POST', `/workspaces/${crypto.randomUUID()}/packets`, { cookie: org.analyst.cookie, json: {} }),
    },
    { rule: 'api.user', subject: () => `user:${org.viewer.me.user.id}`, call: () => request(ctx.app, 'GET', '/auth/me', { cookie: org.viewer.cookie }) },
    { rule: 'api.ip', subject: () => IP, call: () => request(ctx.app, 'GET', '/auth/invite/not-a-token', { headers: { 'x-forwarded-for': IP } }) },
  ];

  it.each(cases.map((c, i) => [`${c.rule} #${i}`, c] as const))('%s', async (_name, c) => {
    const rule = RATE_LIMIT_RULES[c.rule];
    await prefill(c.rule, c.subject(), rule.limit - 1);
    const last = await c.call(); // the limit-th request is still allowed
    expect(last.status).not.toBe(429);
    const over = await c.call(); // limit + 1
    const retryAfter = rule.windowSec === 60 ? 50 : 1790;
    expect429(over, c.rule, retryAfter);
    expect(over.body.error.message).toBe(c.rule.startsWith('auth.')
      ? 'Too many attempts. Try again in 30 minutes.'
      : retryAfter === 50 ? 'Too many requests. Try again in 50 seconds.' : 'Too many requests. Try again in 30 minutes.');
    // Still blocked later in the same window, with a shorter Retry-After.
    ctx.clock.advance(20_000);
    expect429(await c.call(), c.rule, retryAfter - 20);
    // Window rollover: allowed again.
    ctx.clock.set(new Date(windowStartOf(NOW, rule.windowSec).getTime() + rule.windowSec * 1000));
    expect((await c.call()).status).not.toBe(429);
  });

  it('scenario 6: 31 previews within 60 s → calls 1–30 are 200, call 31 is 429 watchlist.preview.user', async () => {
    const statuses: number[] = [];
    let last: TestResponse | null = null;
    for (let i = 0; i < 31; i++) {
      last = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: org.bidManager.cookie, json: { criteria: { keywords: [`laptop${i % 3}`] } } });
      statuses.push(last.status);
      if (i === 0) expect(last.headers.get('ratelimit-remaining')).toBe('29');
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect429(last!, 'watchlist.preview.user', 50);
    // Another user is unaffected.
    expect((await request(ctx.app, 'POST', '/watchlists/preview', { cookie: org.owner.cookie, json: { criteria: { keywords: ['laptop'] } } })).status).toBe(200);
  });

  it('API tokens get their own api.user bucket; /api/health is never limited', async () => {
    const tok = await request(ctx.app, 'POST', '/me/api-tokens', { cookie: org.owner.cookie, json: { name: 'Extension' } });
    expect(tok.status).toBe(201);
    await prefill('api.user', `token:${tok.body.id}`, 600);
    expect429(await request(ctx.app, 'GET', '/auth/me', { bearer: tok.body.token }), 'api.user', 50);
    expect((await request(ctx.app, 'GET', '/auth/me', { cookie: org.owner.cookie })).status).toBe(200);

    await prefill('api.ip', IP, 1000);
    const h = await request(ctx.app, 'GET', '/health', { headers: { 'x-forwarded-for': IP } });
    expect(h.status).toBe(200);
  });

  it('invalid credentials count against api.ip', async () => {
    await prefill('api.ip', IP, 300);
    expect429(await request(ctx.app, 'GET', '/auth/me', { cookie: 'tp_session=forged', headers: { 'x-forwarded-for': IP } }), 'api.ip', 50);
  });

  it('S2: one anonymous call to an authenticated route counts api.ip exactly once', async () => {
    const r = await request(ctx.app, 'GET', '/auth/me', { headers: { 'x-forwarded-for': IP } });
    expect(r.status).toBe(401);
    expect(await countOf(`api.ip:${IP}`)).toBe(1);
    const forged = await request(ctx.app, 'GET', '/auth/me', { cookie: 'tp_session=forged', headers: { 'x-forwarded-for': IP } });
    expect(forged.status).toBe(401);
    expect(await countOf(`api.ip:${IP}`)).toBe(2);
  });

  it('S3: a forged cookie on a public route is counted against the IP; a valid one is not', async () => {
    const r = await request(ctx.app, 'GET', '/auth/invite/not-a-token', { cookie: 'tp_session=forged', headers: { 'x-forwarded-for': IP } });
    expect(r.status).toBe(404);
    expect(await countOf(`api.ip:${IP}`)).toBe(1);
    const bearer = await request(ctx.app, 'GET', '/auth/invite/not-a-token', { bearer: 'tp_forged', headers: { 'x-forwarded-for': IP } });
    expect(bearer.status).toBe(404);
    expect(await countOf(`api.ip:${IP}`)).toBe(2);
    await request(ctx.app, 'GET', '/auth/invite/not-a-token', { cookie: org.viewer.cookie, headers: { 'x-forwarded-for': IP } });
    expect(await countOf(`api.ip:${IP}`)).toBe(2);
  });

  it('IPv6 clients share one bucket per /64 (S4)', async () => {
    await request(ctx.app, 'GET', '/auth/invite/x', { headers: { 'x-forwarded-for': '2001:db8:aa:bb::1' } });
    await request(ctx.app, 'GET', '/auth/invite/x', { headers: { 'x-forwarded-for': '2001:db8:aa:bb:ffff::9' } });
    expect(await countOf('api.ip:2001:db8:aa:bb::/64')).toBe(2);
  });
});

describe('auth rules (spec 002 counters) carry the rule name', () => {
  const MIN = 60_000;

  it('scenario 5: 10 wrong passwords, 11th a minute later → 429 auth.fail.email "Try again in 14 minutes."', async () => {
    const a = await signup(ctx.app);
    const headers = { 'x-forwarded-for': '198.51.100.31' };
    for (let i = 0; i < 10; i++) {
      expect((await request(ctx.app, 'POST', '/auth/login', { headers, json: { email: a.email, password: 'wrong-pass' } })).status).toBe(401);
    }
    ctx.clock.advance(MIN);
    const r = await request(ctx.app, 'POST', '/auth/login', { headers, json: { email: a.email, password: 'wrong-pass' } });
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: { code: 'rate_limited', message: 'Too many attempts. Try again in 14 minutes.', details: { rule: 'auth.fail.email', retryAfter: 840 } } });
    expect(r.headers.get('retry-after')).toBe('840');
  });

  it('31st failure from one IP → auth.fail.ip; 4th reset request → auth.reset.email', async () => {
    const ip = '198.51.100.32';
    for (let i = 0; i < 30; i++) await request(ctx.app, 'POST', '/auth/login', { headers: { 'x-forwarded-for': ip }, json: { email: uniqueEmail('spray'), password: 'wrong-pass' } });
    const r = await request(ctx.app, 'POST', '/auth/login', { headers: { 'x-forwarded-for': ip }, json: { email: uniqueEmail('spray'), password: 'wrong-pass' } });
    expect(r.status).toBe(429);
    expect(r.body.error.details.rule).toBe('auth.fail.ip');

    const email = uniqueEmail('reset');
    for (let i = 0; i < 3; i++) expect((await request(ctx.app, 'POST', '/auth/forgot-password', { json: { email } })).status).toBe(200);
    const blocked = await request(ctx.app, 'POST', '/auth/forgot-password', { json: { email } });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.details.rule).toBe('auth.reset.email');
  });
});

describe('limiter unavailable (FR-020, scenario 8)', () => {
  async function withTableRenamed(table: string, fn: () => Promise<void>) {
    await ctx.db.execute(sql.raw(`alter table "${table}" rename to "${table}_offline"`));
    try { await fn(); } finally { await ctx.db.execute(sql.raw(`alter table "${table}_offline" rename to "${table}"`)); }
  }

  it('generic rules fail open with a warn log; auth.signup.ip fails closed with 503', async () => {
    await withTableRenamed('rate_limits', async () => {
      const r = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: org.analyst.cookie, json: { criteria: { keywords: ['laptop'] } } });
      expect(r.status).toBe(200);
      expect(warnings.some((w) => w.msg === 'rate_limit_unavailable' && w.meta?.rule === 'watchlist.preview.user')).toBe(true);
      expect(warnings.some((w) => w.msg === 'rate_limit_unavailable' && w.meta?.rule === 'api.user')).toBe(true);

      const s = await request(ctx.app, 'POST', '/auth/signup', { headers: { 'x-forwarded-for': '203.0.113.90' }, json: { name: 'N', email: uniqueEmail('closed'), password: 'correct-horse-42', orgName: 'Closed Co' } });
      expect(s.status).toBe(503);
      expect(s.body.error.code).toBe('service_unavailable');
    });
  });

  it('a limiter slower than 300 ms is treated as unavailable: allowed, one sampled warning (N3)', async () => {
    const real = ctx.deps.rateLimiter;
    ctx.deps.rateLimiter = { hit: () => new Promise(() => {}), reset: async () => {} };
    try {
      const t0 = performance.now();
      for (let i = 0; i < 3; i++) {
        const r = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: org.analyst.cookie, json: { criteria: { keywords: ['laptop'] } } });
        expect(r.status).toBe(200);
      }
      expect(performance.now() - t0).toBeLessThan(3 * 2 * 300 + 1500);
      expect(warnings.filter((w) => w.meta?.rule === 'watchlist.preview.user')).toHaveLength(1);
      expect(String(warnings[0]!.meta?.error)).toMatch(/timed out after 300 ms/);
    } finally {
      ctx.deps.rateLimiter = real;
    }
  });

  it('R2: a slow (500 ms) limiter does not turn sign-up (fail-closed rule) into 503; a hung one does after 3 s', async () => {
    const real = ctx.deps.rateLimiter;
    const slow = (ms: number): typeof real => ({
      hit: (key, limit, windowSec, now) => new Promise((res) => setTimeout(() => res(real.hit(key, limit, windowSec, now)), ms)),
      reset: (key) => real.reset(key),
    });
    const body = () => ({ name: 'Slow Co Owner', email: uniqueEmail('slow'), password: 'correct-horse-42', orgName: 'Slow Co' });
    try {
      ctx.deps.rateLimiter = slow(500);
      const r = await request(ctx.app, 'POST', '/auth/signup', { headers: { 'x-forwarded-for': '203.0.113.91' }, json: body() });
      expect(r.status).toBe(201);
      ctx.deps.rateLimiter = { hit: () => new Promise(() => {}), reset: async () => {} };
      const t0 = performance.now();
      const hung = await request(ctx.app, 'POST', '/auth/signup', { headers: { 'x-forwarded-for': '203.0.113.92' }, json: body() });
      expect(hung.status).toBe(503);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(2_900);
    } finally {
      ctx.deps.rateLimiter = real;
    }
  });

  it('auth failure counters fail closed: login answers 503 instead of checking the password', async () => {
    const a = await signup(ctx.app);
    await withTableRenamed('auth_attempts', async () => {
      const r = await request(ctx.app, 'POST', '/auth/login', { json: { email: a.email, password: a.password } });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('service_unavailable');
      expect(r.cookie).toBeNull();
    });
    expect((await request(ctx.app, 'POST', '/auth/login', { json: { email: a.email, password: a.password } })).status).toBe(200);
  });
});

describe('body limits (FR-021, scenario 7)', () => {
  /** A 30 MB body that counts how much of it was ever read. */
  function hugeBody() {
    const state = { pulled: 0 };
    const chunk = new Uint8Array(MB);
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        state.pulled += chunk.byteLength;
        if (state.pulled > 30 * MB) ctrl.close(); else ctrl.enqueue(chunk);
      },
    }, { highWaterMark: 0 }); // nothing is pulled until someone reads
    return { stream, state };
  }

  async function send(method: string, path: string, opts: { cookie?: string; contentLength?: number; contentType: string }) {
    const { stream, state } = hugeBody();
    const headers: Record<string, string> = { 'content-type': opts.contentType };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.contentLength !== undefined) headers['content-length'] = String(opts.contentLength);
    const t0 = performance.now();
    const res = await ctx.app.request(`http://tp.test/api${path}`, { method, headers, body: stream, duplex: 'half' } as RequestInit);
    const ms = performance.now() - t0;
    return { res, body: await res.json() as { error: { code: string; message: string } }, ms, pulled: state.pulled };
  }

  const multipart = 'multipart/form-data; boundary=----tp';

  it('a declared 30 MB upload is rejected with 413 in < 200 ms without reading the body (all upload routes)', async () => {
    const routes: [string, string, string][] = [
      ['POST', '/vault', 'Files can be at most 20 MB. Compress the scan or split it and try again.'],
      ['PUT', `/vault/${vaultId}/file`, 'Files can be at most 20 MB. Compress the scan or split it and try again.'],
      ['POST', `/tenders/${tenderId}/documents`, 'The file is larger than 25 MB'],
    ];
    for (const [method, path, message] of routes) {
      for (const cookie of [org.analyst.cookie, undefined]) {
        const r = await send(method, path, { cookie, contentLength: 30 * MB, contentType: multipart });
        expect(r.res.status).toBe(413);
        expect(r.body.error).toMatchObject({ code: 'payload_too_large', message });
        expect(r.ms).toBeLessThan(200);
        expect(r.pulled).toBe(0);
      }
    }
  });

  it('without content-length the body is counted while streaming and aborted at the cap', async () => {
    const r = await send('POST', `/tenders/${tenderId}/documents`, { cookie: org.analyst.cookie, contentType: multipart });
    expect(r.res.status).toBe(413);
    expect(r.body.error.code).toBe('payload_too_large');
    expect(r.pulled).toBeLessThanOrEqual(27 * MB); // stopped just past 25 MB + overhead, not read to the end (30 MB)
  });

  it('caps are chosen by route, not content type: 5 MB multipart to PATCH /me is 413 (S1)', async () => {
    const declared = await send('PATCH', '/me', { cookie: org.viewer.cookie, contentLength: 5 * MB, contentType: multipart });
    expect(declared.res.status).toBe(413);
    expect(declared.body.error.message).toBe('The request body is too large (at most 1 MB).');
    expect(declared.pulled).toBe(0);
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(5 * MB)], 'big.bin'));
    const streamed = await request(ctx.app, 'PATCH', '/me', { cookie: org.viewer.cookie, form: fd });
    expect(streamed.status).toBe(413);
    // Same for a JSON route that is not an upload route under /vault.
    expect((await send('POST', '/vault/reminders/run', { cookie: org.owner.cookie, contentLength: 5 * MB, contentType: multipart })).res.status).toBe(413);
  });

  it('R5: chunked uploads through @hono/node-server — under the cap stored, 40 MB over the cap is 413', async () => {
    const server = serve({ fetch: ctx.app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    const port = (server.address() as AddressInfo).port;
    /** POST `body` with Transfer-Encoding: chunked (no content-length), 256 KB per chunk. */
    const chunked = (path: string, contentType: string, body: Uint8Array) => new Promise<{ status: number; json: any; sent: number }>((resolve, reject) => {
      let sent = 0;
      const req = httpRequest({ host: '127.0.0.1', port, path: `/api${path}`, method: 'POST',
        headers: { cookie: org.analyst.cookie, 'content-type': contentType, 'transfer-encoding': 'chunked' } }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text || 'null'), sent }));
      });
      req.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE' && e.code !== 'ECONNRESET') reject(e); });
      const CHUNK = 256 * 1024;
      const pump = (off: number) => {
        while (off < body.length) {
          const part = body.subarray(off, off + CHUNK);
          off += part.length;
          sent += part.length;
          if (!req.write(part)) { req.once('drain', () => pump(off)); return; }
        }
        req.end();
      };
      pump(0);
    });
    try {
      const fd = new FormData();
      fd.append('file', file(await pdf('chunked ok'), 'chunked.pdf'));
      fd.append('type', 'gst');
      const okRes = new Response(fd);
      const ok = await chunked('/vault', okRes.headers.get('content-type')!, new Uint8Array(await okRes.arrayBuffer()));
      expect(ok.status).toBe(201);
      expect(ok.json.fileName).toBe('chunked.pdf');

      const big = new FormData();
      big.append('file', new File([new Uint8Array(40 * MB)], 'huge.pdf', { type: 'application/pdf' }));
      const bigRes = new Response(big);
      const bigBytes = new Uint8Array(await bigRes.arrayBuffer());
      const r = await chunked(`/tenders/${tenderId}/documents`, bigRes.headers.get('content-type')!, bigBytes);
      expect(r.status).toBe(413);
      expect(r.json.error).toMatchObject({ code: 'payload_too_large', message: 'The file is larger than 25 MB' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('JSON bodies are capped at 1 MB (declared or streamed) and nothing is written', async () => {
    const declared = await send('PATCH', '/me', { cookie: org.viewer.cookie, contentLength: 2 * MB, contentType: 'application/json' });
    expect(declared.res.status).toBe(413);
    expect(declared.pulled).toBe(0);

    const big = await request(ctx.app, 'PATCH', '/me', { cookie: org.viewer.cookie, json: { name: 'x'.repeat(MB + 10) } });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('payload_too_large');
    const me = await request(ctx.app, 'GET', '/auth/me', { cookie: org.viewer.cookie });
    expect(me.body.user.name).not.toMatch(/^x+$/);

    // Ordinary bodies are untouched.
    expect((await request(ctx.app, 'PATCH', '/me', { cookie: org.viewer.cookie, json: { name: 'Viewer Renamed' } })).status).toBe(200);
  });
});
