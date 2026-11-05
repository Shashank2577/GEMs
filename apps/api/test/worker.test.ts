/** 008/US6: Worker entry wiring (FR-044, FR-046) without a database or SENTRY_DSN. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECT_TIMEOUT_MS, createNodeDb } from '@tp/db/client';
import worker, { NO_DATABASE_MESSAGE, WORKER_DB_POOL_MAX, workerDatabaseUrl, type WorkerEnv } from '../src/worker';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const env = (extra: Partial<WorkerEnv> = {}) => ({
  ASSETS: { fetch: async () => new Response('asset-body', { headers: { 'content-type': 'text/plain' } }) },
  BLOBS: {},
  APP_VERSION: '9.9.9',
  ...extra,
}) as unknown as WorkerEnv;

afterEach(() => { vi.restoreAllMocks(); });

describe('worker default export (withSentry-wrapped)', () => {
  it('exposes fetch and scheduled', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });

  it('serves non-/api requests from ASSETS without SENTRY_DSN', async () => {
    const res = await worker.fetch(new Request('https://app.example.in/dashboard'), env(), ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset-body');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('bootstrap failure on /api/health → 503 with the db_unreachable health body and one JSON log line', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(new Request('https://app.example.in/api/health?token=tp_abcdefghijklmnopqrstuv'), env(), ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      ok: false, db: false, version: '9.9.9',
      ingestion: { lastSuccessAt: null, ageMinutes: null, lastStatus: null, state: 'never' },
      alerts: { pendingOlderThan30m: 0 }, reasons: ['db_unreachable'],
    });
    expect(err).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(err.mock.calls[0]![0]));
    expect(line).toMatchObject({ level: 'error', msg: 'worker bootstrap failed', path: '/api/health', error: NO_DATABASE_MESSAGE });
    expect(JSON.stringify(line)).not.toContain('tp_abc');
  });

  it('008/FR-075: the database is the Hyperdrive binding (DATABASE_URL only as break-glass), pool max 5', () => {
    expect(WORKER_DB_POOL_MAX).toBe(5);
    expect(workerDatabaseUrl({ HYPERDRIVE: { connectionString: 'postgres://hd/db' }, DATABASE_URL: 'postgres://neon-pooler/db' })).toBe('postgres://hd/db');
    expect(workerDatabaseUrl({ DATABASE_URL: 'postgres://neon-pooler/db' })).toBe('postgres://neon-pooler/db');
    expect(() => workerDatabaseUrl({})).toThrow(NO_DATABASE_MESSAGE);
  });

  it('008/FR-075: with a Hyperdrive binding (pointed at the test Postgres) /api/health reaches the DB through the pg driver', async () => {
    const waits: Promise<unknown>[] = [];
    const res = await worker.fetch(new Request('https://app.example.in/api/health'),
      env({ HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } }), { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException: () => {} });
    const body = await res.json() as { db: boolean; version: string };
    expect(body).toMatchObject({ db: true, version: '9.9.9' });
    await Promise.all(waits); // the per-request pool is closed after the response
    expect(waits.length).toBeGreaterThan(0);
  });

  it('review S3: without a Hyperdrive binding the Worker runs on the DATABASE_URL secret (the shipped wrangler.toml state)', async () => {
    const waits: Promise<unknown>[] = [];
    const res = await worker.fetch(new Request('https://app.example.in/api/health'),
      env({ DATABASE_URL: process.env.TEST_DATABASE_URL! }), { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException: () => {} });
    expect(await res.json()).toMatchObject({ db: true, version: '9.9.9' });
    await Promise.all(waits);
  });

  it('review S3: the pg pool fails a connection attempt after CONNECT_TIMEOUT_MS instead of hanging', async () => {
    expect(CONNECT_TIMEOUT_MS).toBe(10_000);
    const { db, close } = await createNodeDb(process.env.TEST_DATABASE_URL!, { max: 1 });
    expect((db as unknown as { $client: { options: { connectionTimeoutMillis: number } } }).$client.options.connectionTimeoutMillis).toBe(10_000);
    await close();
  });

  it('review S3: wrangler.toml deploys without an operator-created Hyperdrive id (no placeholder binding, no bare env.staging)', () => {
    const toml = readFileSync(fileURLToPath(new URL('../../../wrangler.toml', import.meta.url)), 'utf8');
    const active = toml.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    expect(active).not.toMatch(/\[\[hyperdrive\]\]/); // enable per docs/runbook.md § Hyperdrive, with a real id
    expect(active).not.toMatch(/\[\[env\.staging\./); // staging belongs to [env.staging] (spec 008 US2)
    expect(active).not.toMatch(/id = "0{32}"/);
  });

  it('bootstrap failure on other /api routes → 503 service_unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(new Request('https://app.example.in/api/tenders'), env(), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: 'Service temporarily unavailable' } });
  });
});
