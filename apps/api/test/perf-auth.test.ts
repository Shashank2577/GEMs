/**
 * 002/NFR-001: `GET /api/auth/me` makes ≤ 4 DB queries (counted with an instrumented Drizzle logger) and the auth
 * endpoints stay fast. The timing part is a smoke test with lenient thresholds (CI machines vary): it catches an
 * accidental N+1 or a missing index, not small regressions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeDb } from '@tp/db';
import { createApp, type App } from '../src/app';
import { createTestContext, request, seedOrgWithRoles, signup, TEST_DATABASE_URL, type TestContext } from './helpers';

let ctx: TestContext;
let app: App;
let closeCounted: () => Promise<void>;
const queries: string[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  const counted = await createNodeDb(TEST_DATABASE_URL, { logger: { logQuery: (q) => { queries.push(q); } } });
  closeCounted = counted.close;
  app = createApp({ ...ctx.deps, db: counted.db });
});
afterAll(async () => { await closeCounted?.(); await ctx?.close(); });

async function countQueries(fn: () => Promise<unknown>): Promise<string[]> {
  queries.length = 0;
  await fn();
  return [...queries];
}

const MIN = 60_000;

describe('002/NFR-001 GET /api/auth/me query count', () => {
  it('cookie session: ≤ 4 queries, also when last_seen_at / the sliding expiry is refreshed', async () => {
    const a = await signup(app);
    // Typical request: nothing to refresh.
    const typical = await countQueries(async () => expect((await request(app, 'GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(200));
    expect(typical.length, typical.join('\n')).toBeLessThanOrEqual(3);
    // last_seen_at is older than 5 minutes → one extra UPDATE.
    ctx.clock.advance(6 * MIN);
    const refreshed = await countQueries(async () => expect((await request(app, 'GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(200));
    expect(refreshed.length, refreshed.join('\n')).toBeLessThanOrEqual(4);
    expect(refreshed.some((q) => /^update "sessions"/i.test(q))).toBe(true);
  });

  it('a member of several orgs still costs ≤ 4 queries (org list is one query)', async () => {
    const owner = await signup(app);
    const org = await seedOrgWithRoles(app);
    const inv = await request(app, 'POST', '/api/org/invitations', { cookie: org.owner.cookie, json: { email: owner.email, role: 'analyst' } });
    const token = String(inv.body.inviteUrl).split('/invite/')[1];
    expect((await request(app, 'POST', '/api/auth/accept-invite', { cookie: owner.cookie, json: { token } })).status).toBe(200);
    ctx.clock.advance(6 * MIN);
    const q = await countQueries(async () => {
      const r = await request(app, 'GET', '/api/auth/me', { cookie: owner.cookie });
      expect(r.status).toBe(200);
      expect(r.body.orgs).toHaveLength(2);
    });
    expect(q.length, q.join('\n')).toBeLessThanOrEqual(4);
  });

  it('API token: ≤ 4 queries including the last-used bump', async () => {
    const a = await signup(app);
    const token = (await request(app, 'POST', '/api/me/api-tokens', { cookie: a.cookie, json: { name: 'ext' } })).body.token;
    const first = await countQueries(async () => expect((await request(app, 'GET', '/api/auth/me', { bearer: token })).status).toBe(200));
    expect(first.length, first.join('\n')).toBeLessThanOrEqual(4);
    const second = await countQueries(async () => expect((await request(app, 'GET', '/api/auth/me', { bearer: token })).status).toBe(200));
    expect(second.length, second.join('\n')).toBeLessThanOrEqual(3);
  });
});

function p95(samples: number[]): number {
  const s = [...samples].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

async function time(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

describe('002/NFR-001 auth timing smoke (lenient thresholds)', () => {
  it('GET /auth/me p95 < 300 ms and POST /auth/login p95 < 1500 ms (incl. PBKDF2) on Node', async () => {
    const a = await signup(ctx.app);
    // warm-up (JIT, pool connections)
    for (let i = 0; i < 3; i++) await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie });

    const me: number[] = [];
    for (let i = 0; i < 40; i++) {
      me.push(await time(async () => expect((await request(ctx.app, 'GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(200)));
    }
    const login: number[] = [];
    for (let i = 0; i < 12; i++) {
      login.push(await time(async () => expect((await request(ctx.app, 'POST', '/api/auth/login', { json: { email: a.email, password: a.password } })).status).toBe(200)));
    }
    const report = { meP95: Math.round(p95(me)), loginP95: Math.round(p95(login)) };
    console.log(`[perf-auth] p95 ms ${JSON.stringify(report)}`);
    expect(report.meP95).toBeLessThan(300);
    expect(report.loginP95).toBeLessThan(1500);
  });
});
