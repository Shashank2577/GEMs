/**
 * 008/US4 — cluster-wide GeM lease (FR-024, NFR-002; T061, T063) and a single running ingestion (FR-025; T064),
 * on real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createNodeDb, gemThrottle, ingestionRuns, tenders } from '@tp/db';
import { createMockGem } from '../../../tools/mock-gem/src/app';
import type { Logger } from '../src/deps';
import { acquireGemSlot, ClockOffset, createPgGemLease, GEM_BUSY_MESSAGE, reserveGemSlot } from '../src/lib/gem-lease';
import { HttpError } from '../src/lib/errors';
import { runScheduledJobs } from '../src/lib/scheduled';
import { IngestionBusyError, isOneRunningViolation, runIngestion } from '../src/services/ingest';
import { createTestContext, request, seedOrgWithRoles, TEST_DATABASE_URL, type TestContext } from './helpers';

const GEM = 'http://mock-gem.test';
const TOLERANCE_MS = 20; // spec: ≥ interval, tolerance −20 ms

let ctx: TestContext;
let mock: ReturnType<typeof createMockGem>;
let team: Awaited<ReturnType<typeof seedOrgWithRoles>>;
let seq = 0;

/** Differences between consecutive times, after sorting. */
const gaps = (times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted.slice(1).map((t, i) => t - sorted[i]);
};
const nextSlot = async () => (await ctx.db.select().from(gemThrottle).where(eq(gemThrottle.id, 'gem')))[0]?.nextSlotAt ?? null;

async function gemTender(i: number) {
  const d = mock.state.docs[i];
  const [t] = await ctx.db.insert(tenders).values({
    source: `lease-${++seq}`, bidNumber: String(d.b_bid_number[0]), gemBidId: String(d.b_id[0]), title: `Lease bid ${i}`,
    sourceUrl: `${GEM}/all-bids#${d.b_id[0]}`, contentHash: `lease-${seq}`, endAt: new Date(Date.now() + 10 * 86_400_000),
  }).returning();
  return t;
}

beforeAll(async () => {
  mock = createMockGem({ token: 'd'.repeat(32) });
  ctx = await createTestContext({ gemBaseUrl: GEM, fetch: async (input, init) => mock.app.fetch(new Request(input as string, init)) });
  team = await seedOrgWithRoles(ctx.app, 'Lease Test Co');
});
afterAll(() => ctx?.close());
beforeEach(async () => { await ctx.db.delete(gemThrottle); });

describe('ClockOffset (DB clock → local clock bounds)', () => {
  it('intersects samples: pool/lock waits widen only the upper bound, a late-noticed reply only the lower one', () => {
    const o = new ClockOffset();
    expect(o.width).toBe(Infinity);
    // True offset +5000 ms. Sample 1 queued 300 ms for a pool connection before the DB read its clock (t = 1300).
    o.add(1000, 1301, 6300);
    // Sample 2's reply was noticed 250 ms late by a busy event loop (DB read at t = 2001).
    o.add(2000, 2252, 7001);
    expect(o.width).toBeLessThanOrEqual(4);
    // A slot at DB time 10000 is local 5000 ± 2.
    expect(o.earliestLocal(10_000)).toBeGreaterThanOrEqual(4997);
    expect(o.latestLocal(10_000)).toBeLessThanOrEqual(5003);
    expect(o.earliestLocal(10_000)).toBeLessThanOrEqual(5000);
    expect(o.latestLocal(10_000)).toBeGreaterThanOrEqual(5000);
  });

  it('starts over on a clock step (empty intersection) and after maxAgeMs', () => {
    const o = new ClockOffset(1000);
    o.add(0, 2, 5001);
    o.add(10, 12, 9011); // offset jumped to ~+9000
    expect(o.latestLocal(9011)).toBeGreaterThanOrEqual(10);
    expect(o.earliestLocal(9011)).toBeLessThanOrEqual(12);
    o.add(5000, 5400, 14_200); // stale bounds dropped: only this (wide) sample counts
    expect(o.width).toBe(402);
  });
});

describe('acquireGemSlot (FR-024)', () => {
  it('spaces 20 concurrent callers ≥ interval apart, on the DB clock and in real time', async () => {
    const interval = 250;
    const results = await Promise.all(Array.from({ length: 20 }, async () => {
      const slot = await acquireGemSlot(ctx.db, interval, 10_000);
      return { slot, at: Date.now() };
    }));
    // Reserved slots are exactly one interval apart.
    const slots = results.map((r) => r.slot.slotAt.getTime()).sort((a, b) => a - b);
    for (const g of gaps(slots)) expect(g).toBeGreaterThanOrEqual(interval - 1);
    // Callers actually resumed one interval apart.
    for (const g of gaps(results.map((r) => r.at))) expect(g).toBeGreaterThanOrEqual(interval - TOLERANCE_MS);
    expect(Math.max(...results.map((r) => r.slot.waitedMs))).toBeGreaterThanOrEqual(19 * interval - 50);
  });

  it('a caller that wakes up late gives its slot up and takes a fresh one', async () => {
    let overrun = 300; // a starved event loop: the first sleep ends 300 ms late
    const sleep = async (ms: number) => { await new Promise((r) => setTimeout(r, ms + overrun)); overrun = 0; };
    await reserveGemSlot(ctx.db, 200, 1000); // someone else holds the current slot; ours is +200 ms
    const first = await nextSlot(); // = start of the slot we will get first (and miss)
    const slot = await acquireGemSlot(ctx.db, 200, 5_000, { sleep, lateToleranceMs: 20 });
    // The missed slot was given up: the slot we finally used is a later one.
    expect(slot.slotAt.getTime()).toBeGreaterThanOrEqual(first!.getTime() + 200 - 1);
  });

  it('holds across separate connection pools (isolates / processes)', async () => {
    const other = await createNodeDb(TEST_DATABASE_URL);
    try {
      const interval = 200;
      const at = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
        await acquireGemSlot(i % 2 ? other.db : ctx.db, interval, 10_000);
        return Date.now();
      }));
      for (const g of gaps(at)) expect(g).toBeGreaterThanOrEqual(interval - TOLERANCE_MS);
    } finally {
      await other.close();
    }
  });

  it('answers 503 gem_busy without reserving a slot when the wait would exceed maxWaitMs', async () => {
    const noSleep = { sleep: async () => {} };
    await acquireGemSlot(ctx.db, 1000, 1500, noSleep); // slot now, next +1 s
    await acquireGemSlot(ctx.db, 1000, 1500, noSleep); // slot +1 s, next +2 s
    const before = await nextSlot();
    const err = await acquireGemSlot(ctx.db, 1000, 1500, noSleep).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 503, code: 'gem_busy', message: GEM_BUSY_MESSAGE });
    expect((await nextSlot())?.getTime()).toBe(before?.getTime());
    expect(await reserveGemSlot(ctx.db, 1000, 1500)).toBeNull();
  });

  it('recreates the throttle row when it is missing', async () => {
    expect(await nextSlot()).toBeNull();
    const s = await reserveGemSlot(ctx.db, 1000, 0);
    expect(s?.waitMs).toBe(0);
    expect(await nextSlot()).not.toBeNull();
  });
});

describe('fetch-documents through the lease (FR-024, US4 scenario 1)', () => {
  it('20 concurrent fetches for 20 tenders reach GeM ≥ interval apart and all succeed', async () => {
    const interval = 200;
    // Arrival = when the API hands the request to the network (the in-process mock's handler shares this event loop,
    // so its own timestamps carry scheduling noise that a real, separate GeM would not see).
    const sent: number[] = [];
    const leased = await createTestContext({
      keepData: true, gemBaseUrl: GEM, gemLease: (db) => createPgGemLease(db, interval),
      fetch: async (input, init) => { if (String(input).includes('/showbidDocument/')) sent.push(Date.now()); return mock.app.fetch(new Request(input as string, init)); },
    });
    try {
      const list = await Promise.all(Array.from({ length: 20 }, (_, i) => gemTender(i)));
      const from = mock.state.requestLog.length;
      const res = await Promise.all(list.map((t) => request(leased.app, 'POST', `/tenders/${t.id}/fetch-documents`, { cookie: team.analyst.cookie })));
      expect(res.map((r) => r.status)).toEqual(Array(20).fill(201));
      expect(mock.state.requestLog.slice(from).filter((r) => r.path.startsWith('/showbidDocument/'))).toHaveLength(20);
      expect(sent).toHaveLength(20);
      for (const g of gaps(sent)) expect(g).toBeGreaterThanOrEqual(interval - TOLERANCE_MS);
    } finally {
      await leased.close();
    }
  });

  it('returns 503 gem_busy "GeM is busy — we’ll retry shortly." when no slot is free within 25 s', async () => {
    // 10 s interval and no real sleeping: slots at 0, 10, 20 s fit the 25 s wait; the 4th and later do not.
    const leased = await createTestContext({
      keepData: true, gemBaseUrl: GEM, gemLease: (db) => createPgGemLease(db, 10_000, { sleep: async () => {} }),
      fetch: async (input, init) => mock.app.fetch(new Request(input as string, init)),
    });
    try {
      const list = await Promise.all(Array.from({ length: 5 }, (_, i) => gemTender(i)));
      const from = mock.state.requestLog.length;
      const res = [];
      for (const t of list) res.push(await request(leased.app, 'POST', `/tenders/${t.id}/fetch-documents`, { cookie: team.analyst.cookie }));
      expect(res.map((r) => r.status)).toEqual([201, 201, 201, 503, 503]);
      expect(res[3].body.error).toEqual({ code: 'gem_busy', message: GEM_BUSY_MESSAGE, details: { maxWaitMs: 25_000 } });
      // The refused calls never reached GeM.
      expect(mock.state.requestLog.slice(from).filter((r) => r.path.startsWith('/showbidDocument/'))).toHaveLength(3);
    } finally {
      await leased.close();
    }
  });
});

describe('single running ingestion (FR-025)', () => {
  const slowClient = (ms: number) => ({
    async fetchTenders() { await new Promise((r) => setTimeout(r, ms)); return { tenders: [], numFound: 0, rawCount: 0 }; },
  });

  beforeEach(async () => { await ctx.db.delete(ingestionRuns); });

  it('the partial unique index allows at most one running row', async () => {
    await ctx.db.insert(ingestionRuns).values({ trigger: 'cron', status: 'running' });
    const err = await ctx.db.insert(ingestionRuns).values({ trigger: 'manual', status: 'running' }).catch((e) => e);
    expect(isOneRunningViolation(err)).toBe(true);
    // Finished runs are unconstrained.
    await ctx.db.insert(ingestionRuns).values([{ trigger: 'cron', status: 'success' }, { trigger: 'cron', status: 'failed' }]);
  });

  it('concurrent starts: exactly one runs, the others get IngestionBusyError', async () => {
    const settled = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      runIngestion(ctx.deps, { trigger: i % 2 ? 'manual' : 'cron', pages: 1, client: slowClient(150) })));
    const ok = settled.filter((r) => r.status === 'fulfilled');
    const busy = settled.filter((r) => r.status === 'rejected' && r.reason instanceof IngestionBusyError);
    expect(ok).toHaveLength(1);
    expect(busy).toHaveLength(5);
    const rows = await ctx.db.select().from(ingestionRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
  });

  it('reaps a stale running run and starts, in one transaction', async () => {
    const now = ctx.clock.now();
    await ctx.db.insert(ingestionRuns).values({ trigger: 'cron', status: 'running', startedAt: new Date(now.getTime() - 16 * 60_000) });
    const run = await runIngestion(ctx.deps, { pages: 1, client: slowClient(0) });
    expect(run.status).toBe('success');
    const rows = await ctx.db.select().from(ingestionRuns).orderBy(ingestionRuns.startedAt);
    expect(rows.map((r) => r.status)).toEqual(['failed', 'success']);
    expect(rows[0].error).toMatch(/Timed out/);
  });

  it('cron tick + manual Sync now during a running cron: one running row, 409 ingestion_running, cron logs a skip', async () => {
    const lines: { level: string; msg: string }[] = [];
    const logger: Logger = {
      info: (msg) => lines.push({ level: 'info', msg }), warn: (msg) => lines.push({ level: 'warn', msg }), error: (msg) => lines.push({ level: 'error', msg }),
    };
    const first = runIngestion(ctx.deps, { trigger: 'cron', pages: 1, client: slowClient(300) });
    await new Promise((r) => setTimeout(r, 50));
    const [tick, manual] = await Promise.all([
      runScheduledJobs({ ...ctx.deps, logger }, { trigger: 'cron' }),
      request(ctx.app, 'POST', '/ingestion/run', { cookie: team.bidManager.cookie, json: {} }),
    ]);
    expect(manual.status).toBe(409);
    expect(manual.body.error).toMatchObject({ code: 'ingestion_running', message: 'A GeM sync is already running — results will appear shortly.' });
    expect(tick.find((s) => s.step === 'ingestion')).toMatchObject({ ok: true });
    expect(lines).toContainEqual({ level: 'info', msg: 'ingestion skipped: already running' });
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(ingestionRuns).where(eq(ingestionRuns.status, 'running'));
    expect(Number(n)).toBe(1);
    await first;
  });
});
