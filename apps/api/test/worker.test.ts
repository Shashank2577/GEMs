/**
 * Cloudflare Worker entry (apps/api/src/worker.ts) with a fake env (spec 008 FR-009, FR-012, FR-013).
 * The Neon driver is swapped for node-postgres on the test database; R2 and ASSETS are in-memory fakes.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { R2BucketLike } from '../src/adapters/blob-r2';
import type { ScheduledReport } from '../src/lib/scheduled';
import { TEST_DATABASE_URL, ensureMigrated, sessionCookieFrom, uniqueEmail } from './helpers';

const pools = vi.hoisted(() => ({ opened: 0, closed: 0 }));

vi.mock('@tp/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tp/db')>();
  return {
    ...actual,
    createNeonDb: async (url: string) => {
      const { db, close } = await actual.createNodeDb(url);
      pools.opened++;
      return { db, close: async () => { pools.closed++; await close(); } };
    },
  };
});

vi.mock('../src/lib/scheduled', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/scheduled')>();
  return { ...actual, runScheduledJobs: vi.fn(actual.runScheduledJobs) };
});

const { default: worker } = await import('../src/worker');
const { runScheduledJobs } = await import('../src/lib/scheduled');
type WorkerEnv = import('../src/worker').WorkerEnv;

function fakeR2(): R2BucketLike {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const meta = (key: string) => {
    const o = store.get(key);
    return o ? { key, size: o.bytes.byteLength, httpMetadata: { contentType: o.contentType } } : null;
  };
  return {
    async put(key, value, opts) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer);
      store.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
      return meta(key);
    },
    async get(key) {
      const o = store.get(key);
      if (!o) return null;
      return { ...meta(key)!, body: new Response(o.bytes as BlobPart).body!, arrayBuffer: async () => o.bytes.slice().buffer };
    },
    async head(key) { return meta(key); },
    async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
  };
}

function fakeEnv(overrides: Partial<WorkerEnv> = {}) {
  const assets = vi.fn(async (req: Request) => new Response(`<div id="root"></div> ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }));
  const env: WorkerEnv = {
    DATABASE_URL: TEST_DATABASE_URL,
    APP_URL: 'https://tp.test',
    APP_VERSION: 'abc1234',
    GEM_BASE_URL: 'http://127.0.0.1:9',
    LOG_REQUESTS: '0',
    BLOBS: fakeR2(),
    ASSETS: { fetch: assets },
    ...overrides,
  };
  return { env, assets };
}

function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } }, settle: () => Promise.all(pending), pending };
}

const report = (...oks: boolean[]): ScheduledReport[] =>
  oks.map((ok, i) => ({ step: `step${i}`, ok, ms: 1, ...(ok ? {} : { error: `boom ${i}` }) }));

beforeAll(async () => { await ensureMigrated(); });
afterEach(() => { vi.mocked(runScheduledJobs).mockReset(); });

describe('worker fetch()', () => {
  it('/api/* → Hono on a per-request pool (closed via waitUntil), APP_VERSION from env, security headers + HSTS', async () => {
    const { env, assets } = fakeEnv();
    const { ctx, settle } = fakeCtx();
    const before = { ...pools };
    const res = await worker.fetch(new Request('https://tp.test/api/health'), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true, version: 'abc1234' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(assets).not.toHaveBeenCalled();
    await settle();
    expect(pools.opened - before.opened).toBe(1);
    expect(pools.closed - before.closed).toBe(1);

    const nope = await worker.fetch(new Request('https://tp.test/api/nope'), env, fakeCtx().ctx);
    expect(nope.status).toBe(404);
    expect((await nope.json()).error.code).toBe('not_found');
  });

  it('everything else → static assets (SPA), without opening a pool', async () => {
    const { env, assets } = fakeEnv();
    const before = pools.opened;
    const res = await worker.fetch(new Request('https://tp.test/vault'), env, fakeCtx().ctx);
    expect(await res.text()).toContain('<div id="root"></div> /vault');
    expect(assets).toHaveBeenCalledTimes(1);
    expect(pools.opened).toBe(before);
  });

  it('bootstrap failure (no DATABASE_URL) → 503 service_unavailable with security headers', async () => {
    const { env } = fakeEnv({ DATABASE_URL: '' });
    const res = await worker.fetch(new Request('https://tp.test/api/health'), env, fakeCtx().ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('service_unavailable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  });

  it('PDF preview streamed from R2 may only be framed same-origin (FR-013)', async () => {
    const { env } = fakeEnv();
    const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://tp.test${path}`, init), env, fakeCtx().ctx);
    const signup = await call('/api/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Worker Owner', email: uniqueEmail('worker'), password: 'correct-horse-42', orgName: 'Worker Traders' }),
    });
    expect(signup.status).toBe(201);
    const cookie = sessionCookieFrom(signup)!;
    const doc = await PDFDocument.create();
    doc.addPage();
    const fd = new FormData();
    fd.append('file', new File([(await doc.save()) as BlobPart], 'gst.pdf', { type: 'application/pdf' }));
    fd.append('type', 'other');
    fd.append('title', 'GST certificate');
    const up = await call('/api/vault', { method: 'POST', headers: { cookie }, body: fd });
    expect(up.status).toBe(201);
    const { id } = await up.json();
    const pdf = await call(`/api/vault/${id}/download?inline=1`, { headers: { cookie } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(pdf.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new TextDecoder().decode(new Uint8Array(await pdf.arrayBuffer()).slice(0, 5))).toBe('%PDF-');
  });
});

describe('worker scheduled() (FR-012)', () => {
  it('awaits the job (not a bare waitUntil): it settles only after runScheduledJobs does; the pool closes via waitUntil', async () => {
    let finish!: (r: ScheduledReport[]) => void;
    vi.mocked(runScheduledJobs).mockImplementation(() => new Promise((r) => { finish = r; }));
    const { env } = fakeEnv();
    const { ctx, settle, pending } = fakeCtx();
    const before = { ...pools };
    let done = false;
    const run = worker.scheduled({ cron: '*/30 * * * *' }, env, ctx).then(() => { done = true; });
    await vi.waitFor(() => expect(runScheduledJobs).toHaveBeenCalledTimes(1));
    expect(vi.mocked(runScheduledJobs).mock.calls[0]![1]).toEqual({ trigger: 'cron' });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    expect(pending).toHaveLength(0); // the job itself is not handed to waitUntil
    finish(report(true, false, true));
    await run;
    expect(done).toBe(true);
    expect(pending).toHaveLength(1); // pool close
    await settle();
    expect(pools.closed - before.closed).toBe(1);
  });

  it('rejects when every step failed, so the cron invocation is marked failed; still closes the pool', async () => {
    vi.mocked(runScheduledJobs).mockResolvedValue(report(false, false, false, false));
    const { env } = fakeEnv();
    const { ctx, settle } = fakeCtx();
    const before = pools.closed;
    await expect(worker.scheduled({}, env, ctx)).rejects.toThrow(/scheduled run failed: step0: boom 0; step1: boom 1/);
    await settle();
    expect(pools.closed - before).toBe(1);
  });

  it('rejects when the job throws or the pool cannot be created', async () => {
    vi.mocked(runScheduledJobs).mockRejectedValue(new Error('db gone'));
    await expect(worker.scheduled({}, fakeEnv().env, fakeCtx().ctx)).rejects.toThrow('db gone');
    await expect(worker.scheduled({}, fakeEnv({ DATABASE_URL: '' }).env, fakeCtx().ctx)).rejects.toThrow(/DATABASE_URL/);
  });

  it('resolves when at least one step succeeded (steps are isolated; failures are logged)', async () => {
    vi.mocked(runScheduledJobs).mockResolvedValue(report(false, true, false, false));
    await expect(worker.scheduled({}, fakeEnv().env, fakeCtx().ctx)).resolves.toBeUndefined();
  });
});
