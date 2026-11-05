/** 008/US6: health v2 (FR-044), request logs (FR-045), error reporter (FR-046). */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestionRuns, notifications, organizations, users } from '@tp/db';
import { createApp } from '../src/app';
import type { AppDeps, ErrorReporter, Logger } from '../src/deps';
import { loadConfig } from '../src/env';
import { createJsonLogger } from '../src/adapters/logger';
import { createSentryReporter } from '../src/adapters/errors';
import { HttpError } from '../src/lib/errors';
import { errorHandler } from '../src/middleware/error';
import { requireAuth } from '../src/middleware/auth';
import { injectDeps } from '../src/middleware/request';
import { runScheduledJobs } from '../src/lib/scheduled';
import type { AppEnv } from '../src/types';
import { buildHealth } from '../src/routes/health';
import { createTestContext, request, signup, TEST_APP_URL, truncateAll, type TestContext } from './helpers';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
let ctx: TestContext;

beforeAll(async () => { ctx = await createTestContext({ now: NOW }); });
afterAll(async () => { await ctx?.close(); });
beforeEach(async () => { await truncateAll(ctx.db); ctx.deps.config = loadConfig({ APP_URL: TEST_APP_URL, NODE_ENV: 'test' }); });

const run = (status: 'success' | 'partial' | 'failed' | 'running', finishedMinAgo: number | null, startedMinAgo = (finishedMinAgo ?? 1) + 1) =>
  ctx.db.insert(ingestionRuns).values({ trigger: 'cron', status, startedAt: minutesAgo(startedMinAgo), finishedAt: finishedMinAgo == null ? null : minutesAgo(finishedMinAgo) });

async function pendingNotification(createdMinAgo: number) {
  const [org] = await ctx.db.insert(organizations).values({ name: 'O', slug: `o-${Math.random().toString(36).slice(2)}` }).returning();
  const [user] = await ctx.db.insert(users).values({ email: `u${Math.random().toString(36).slice(2)}@example.in`, name: 'U', passwordHash: 'x' }).returning();
  await ctx.db.insert(notifications).values({ orgId: org!.id, userId: user!.id, channel: 'email', kind: 'system', title: 't', body: 'b', status: 'pending', createdAt: minutesAgo(createdMinAgo) });
}

describe('GET /api/health v2 (FR-044)', () => {
  it('fresh stack: never synced → 200, state never', async () => {
    const r = await request(ctx.app, 'GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true, db: true, version: ctx.deps.config.version,
      ingestion: { lastSuccessAt: null, ageMinutes: null, lastStatus: null, state: 'never' },
      alerts: { pendingOlderThan30m: 0 }, reasons: [],
    });
  });

  it('healthy: recent success → 200, state ok, age in minutes', async () => {
    await run('success', 10);
    const r = await request(ctx.app, 'GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, db: true, ingestion: { state: 'ok', ageMinutes: 10, lastStatus: 'success', lastSuccessAt: minutesAgo(10).toISOString() }, reasons: [] });
  });

  it('stale (3 h) → 503 ingestion_stale; boundary at the threshold is still ok', async () => {
    await run('success', 180);
    const r = await request(ctx.app, 'GET', '/api/health');
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, db: true, ingestion: { state: 'stale', ageMinutes: 180 }, reasons: ['ingestion_stale'] });
    await truncateAll(ctx.db);
    await run('success', 120);
    expect((await request(ctx.app, 'GET', '/api/health')).status).toBe(200);
  });

  it('reports the latest run status separately from the last success; a failed latest run alone does not 503', async () => {
    await run('success', 30);
    await run('failed', 5);
    const r = await request(ctx.app, 'GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body.ingestion).toMatchObject({ state: 'ok', lastStatus: 'failed', ageMinutes: 30 });
  });

  it('partial counts as a success (same definition as sync health)', async () => {
    await run('partial', 15);
    expect((await request(ctx.app, 'GET', '/api/health')).body.ingestion).toMatchObject({ state: 'ok', lastStatus: 'partial' });
  });

  it('only failed/running runs ever → state never, 200', async () => {
    await run('failed', 400);
    await run('running', null, 2);
    const r = await request(ctx.app, 'GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body.ingestion).toMatchObject({ state: 'never', lastSuccessAt: null });
  });

  it('alert backlog: pending notification older than 30 min → 503 alerts_backlog; younger is fine', async () => {
    await pendingNotification(10);
    expect((await request(ctx.app, 'GET', '/api/health')).status).toBe(200);
    await pendingNotification(45);
    const r = await request(ctx.app, 'GET', '/api/health');
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, alerts: { pendingOlderThan30m: 1 }, reasons: ['alerts_backlog'] });
  });

  it('multiple reasons are all listed', async () => {
    await run('success', 500);
    await pendingNotification(60);
    const r = await request(ctx.app, 'GET', '/api/health');
    expect(r.status).toBe(503);
    expect(r.body.reasons).toEqual(['ingestion_stale', 'alerts_backlog']);
  });

  it('HEALTH_INGESTION_MAX_AGE_MIN is configurable', async () => {
    await run('success', 90);
    ctx.deps.config = loadConfig({ APP_URL: TEST_APP_URL, NODE_ENV: 'test', HEALTH_INGESTION_MAX_AGE_MIN: '60' });
    expect((await request(ctx.app, 'GET', '/api/health')).body.reasons).toEqual(['ingestion_stale']);
  });

  it('db down → 503 db_unreachable, no throw, nothing sensitive in the body', async () => {
    const broken = new Proxy(ctx.db, { get() { throw new Error('connect ECONNREFUSED postgres://tp:secretpw@db:5432'); } }) as typeof ctx.db;
    const app = createApp({ ...ctx.deps, db: broken });
    const r = await request(app, 'GET', '/api/health');
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, db: false, reasons: ['db_unreachable'] });
    expect(r.text).not.toContain('secretpw');
  });

  it('each query has a 3 s timeout: a hanging database answers 503 instead of hanging', async () => {
    const hang = new Promise(() => {});
    const slow = { execute: () => hang, select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => hang }) }), orderBy: () => ({ limit: () => hang }) }) }) } as unknown as typeof ctx.db;
    const t0 = Date.now();
    const report = await buildHealth({ ...ctx.deps, db: slow }, 50);
    expect(report).toMatchObject({ ok: false, db: false, reasons: ['db_unreachable'] });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('is unauthenticated and exposes no org data', async () => {
    const owner = await signup(ctx.app);
    const anon = await request(ctx.app, 'GET', '/api/health');
    expect(anon.status).toBe(200);
    expect(anon.text).not.toContain(owner.email);
    expect(Object.keys(anon.body).sort()).toEqual(['alerts', 'db', 'ingestion', 'ok', 'reasons', 'version']);
  });
});

describe('request logs (FR-045)', () => {
  function logged(level: 'debug' | 'info' = 'info') {
    const lines: Record<string, unknown>[] = [];
    const raw: string[] = [];
    const logger = createJsonLogger({ level, write: (l) => { raw.push(l); lines.push(JSON.parse(l)); } });
    const deps: AppDeps = { ...ctx.deps, logger, config: { ...ctx.deps.config, logRequests: true } };
    return { app: createApp(deps), lines, raw };
  }

  it('logs one request line with rid, method, path (no query), status, ms, orgId, userId after auth', async () => {
    const owner = await signup(ctx.app);
    const l = logged();
    const r = await request(l.app, 'GET', '/api/auth/me?token=abc&q=secret', { cookie: owner.cookie, headers: { 'x-request-id': 'rid-123' } });
    expect(r.status).toBe(200);
    const line = l.lines.find((x) => x.msg === 'request')!;
    expect(line).toMatchObject({ level: 'info', msg: 'request', rid: 'rid-123', method: 'GET', path: '/api/auth/me', status: 200, orgId: owner.me.org!.id, userId: owner.me.user.id });
    expect(typeof line.ms).toBe('number');
    expect(r.headers.get('x-request-id')).toBe('rid-123');
    expect(l.raw.join('\n')).not.toContain('secret');
  });

  it('unauthenticated requests log null orgId/userId', async () => {
    const l = logged();
    await request(l.app, 'GET', '/api/auth/me');
    expect(l.lines.find((x) => x.msg === 'request')).toMatchObject({ status: 401, orgId: null, userId: null });
  });

  it('a login request log contains no password or cookie', async () => {
    const owner = await signup(ctx.app);
    const l = logged();
    const r = await request(l.app, 'POST', '/api/auth/login', { json: { email: owner.email, password: owner.password }, headers: { cookie: 'tp_session=sekrit-cookie' } });
    expect(r.status).toBe(200);
    const all = l.raw.join('\n');
    expect(all).toContain('"path":"/api/auth/login"');
    expect(all).not.toContain(owner.password);
    expect(all).not.toContain('sekrit-cookie');
    expect(all).not.toContain(r.cookie!.split('=')[1]!);
  });

  it('/api/health requests log at debug: hidden at info, visible at debug', async () => {
    const info = logged('info');
    await request(info.app, 'GET', '/api/health');
    expect(info.lines.filter((x) => x.msg === 'request')).toHaveLength(0);
    const dbg = logged('debug');
    await request(dbg.app, 'GET', '/api/health');
    expect(dbg.lines.find((x) => x.msg === 'request')).toMatchObject({ level: 'debug', path: '/api/health', status: 200 });
  });
});

describe('error reporter (FR-046)', () => {
  function fakeReporter() {
    const calls: { error: unknown; context?: Record<string, unknown> }[] = [];
    const errors: ErrorReporter = { capture: (error, context) => { calls.push({ error, context }); } };
    return { errors, calls };
  }
  const silent: Logger = { info() {}, warn() {}, error() {} };

  it('captures unhandled errors with rid/orgId/userId/route, matching the x-request-id of the 500', async () => {
    const owner = await signup(ctx.app);
    const { errors, calls } = fakeReporter();
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', injectDeps({ ...ctx.deps, errors, logger: silent }));
    app.get('/boom/:id', requireAuth, () => { throw new Error('kaboom'); });
    const res = await app.request(`${TEST_APP_URL}/boom/42`, { headers: { cookie: owner.cookie, 'x-request-id': 'rid-boom' } });
    expect(res.status).toBe(500);
    expect(res.headers.get('x-request-id')).toBe('rid-boom');
    expect(calls).toHaveLength(1);
    expect((calls[0]!.error as Error).message).toBe('kaboom');
    expect(calls[0]!.context).toEqual({ rid: 'rid-boom', orgId: owner.me.org!.id, userId: owner.me.user.id, route: '/boom/:id' });
    expect(((await res.json()) as { error: { details: { requestId: string } } }).error.details.requestId).toBe('rid-boom');
  });

  it('does not capture HttpError (expected 4xx/5xx), and a throwing reporter does not break the 500', async () => {
    const { errors, calls } = fakeReporter();
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', injectDeps({ ...ctx.deps, errors, logger: silent }));
    app.get('/nope', () => { throw new HttpError(404, 'not_found', 'x'); });
    expect((await app.request(`${TEST_APP_URL}/nope`)).status).toBe(404);
    expect(calls).toHaveLength(0);

    const app2 = new Hono<AppEnv>();
    app2.onError(errorHandler);
    app2.use('*', injectDeps({ ...ctx.deps, logger: silent, errors: { capture() { throw new Error('reporter down'); } } }));
    app2.get('/boom', () => { throw new Error('x'); });
    expect((await app2.request(`${TEST_APP_URL}/boom`)).status).toBe(500);
  });

  it('runScheduledJobs reports each failed step with its job name', async () => {
    const { errors, calls } = fakeReporter();
    const broken = new Proxy(ctx.db, { get() { throw new Error('db gone'); } }) as typeof ctx.db;
    const report = await runScheduledJobs({ ...ctx.deps, db: broken, errors, logger: silent }, { trigger: 'cron' });
    expect(report.every((s) => !s.ok)).toBe(true);
    expect(calls.map((c) => c.context)).toEqual(report.map((s) => ({ job: s.step })));
  });

  it('Sentry adapter forwards only rid/orgId/route/job tags and the user id; swallows SDK errors', () => {
    const seen: any[] = [];
    const r = createSentryReporter({ captureException: (e, hint) => { seen.push({ e, hint }); } });
    const err = new Error('e');
    r.capture(err, { rid: 'r', orgId: 'o', userId: 'u', route: '/x/:id', job: 'ingestion', email: 'a@b.in', cookie: 'c', body: { password: 'p' } });
    expect(seen).toEqual([{ e: err, hint: { tags: { rid: 'r', orgId: 'o', route: '/x/:id', job: 'ingestion' }, user: { id: 'u' } } }]);
    expect(() => createSentryReporter({ captureException() { throw new Error('sdk'); } }).capture(err)).not.toThrow();
  });
});
