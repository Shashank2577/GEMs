/** 008/US6: Worker entry wiring (FR-044, FR-046) without a database or SENTRY_DSN. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type WorkerEnv } from '../src/worker';

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
    expect(line).toMatchObject({ level: 'error', msg: 'worker bootstrap failed', path: '/api/health', error: 'DATABASE_URL secret is not set' });
    expect(JSON.stringify(line)).not.toContain('tp_abc');
  });

  it('bootstrap failure on other /api routes → 503 service_unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(new Request('https://app.example.in/api/tenders'), env(), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: 'Service temporarily unavailable' } });
  });
});
