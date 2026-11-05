/**
 * NFR-003 performance check (T031): POST /api/watchlists/preview p95 < 800 ms over 20 runs with 50,000 open tenders
 * and a broad criteria set that every one of them matches (worst case: no SQL narrowing, 50k matcher passes, 50k
 * candidates kept). Each tender carries a ~2 KB `raw` blob, which the candidate scan must not load. Skipped unless PERF=1:
 *
 *   PERF=1 TEST_DATABASE_URL=… pnpm --filter @tp/api exec vitest run test/perf
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestContext, request, signup, type TestContext } from '../helpers';

const PERF = process.env.PERF === '1';
const NOW = new Date('2026-11-04T04:30:00Z');
const N = 50_000;

describe.skipIf(!PERF)('POST /api/watchlists/preview performance (NFR-003)', () => {
  let ctx: TestContext;
  let cookie: string;

  beforeAll(async () => {
    ctx = await createTestContext({ now: NOW });
    cookie = (await signup(ctx.app, { orgName: 'Perf Watch Org' })).cookie;
    const now = NOW.toISOString();
    const kinds = ['Laptop', 'Printer', 'CCTV camera', 'Rack server', 'Desktop computer'];
    await ctx.db.execute(sql`
      insert into tenders (bid_number, title, items, category, ministry, organisation, state, start_at, end_at, estimated_value,
                           source_url, content_hash, status, raw)
      select 'GEM/2026/B/' || (5000000 + g),
             (${sql.raw(`array[${kinds.map((k) => `'${k}'`).join(',')}]`)})[1 + g % 5] || ' supply lot ' || g,
             jsonb_build_array(jsonb_build_object('name', (${sql.raw(`array[${kinds.map((k) => `'${k}'`).join(',')}]`)})[1 + g % 5] || ' unit', 'quantity', 1 + g % 40)),
             'IT hardware ' || (g % 30), 'Ministry ' || (g % 40), 'Buyer ' || (g % 97),
             (array['Maharashtra','Karnataka','Delhi','Tamil Nadu','Gujarat'])[1 + g % 5],
             ${now}::timestamptz - interval '2 days', ${now}::timestamptz + (1 + g % 30) * interval '1 day', 100000 + g * 10,
             'https://bidplus.gem.gov.in/all-bids', 'perf-wl-' || g, 'open',
             jsonb_build_object('blob', repeat('x', 2000), 'g', g)
      from generate_series(1, ${N}) g`);
    await ctx.db.execute(sql`analyze tenders`);
  }, 300_000);
  afterAll(() => ctx?.close());

  it(`previews ${N.toLocaleString('en-IN')} matching tenders in < 800 ms p95 over 20 runs`, async () => {
    const criteria = {
      keywords: ['laptop', 'printer', 'cctv', 'server', 'desktop'],
      states: ['maharashtra', 'Karnataka', 'Delhi', 'Tamil Nadu', 'Gujarat'],
      maxValue: 10_000_000_000,
    };
    const preview = () => request(ctx.app, 'POST', '/watchlists/preview', { cookie, json: { criteria } });
    for (let i = 0; i < 3; i++) expect((await preview()).status).toBe(200); // warm-up
    const heapBefore = process.memoryUsage().heapUsed;
    const times: number[] = [];
    let count = 0;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const r = await preview();
      times.push(performance.now() - t0);
      expect(r.status).toBe(200);
      count = r.body.count;
      expect(r.body.sample).toHaveLength(5);
    }
    expect(count).toBe(N); // every tender matched: no silent cap
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(0.95 * times.length) - 1]!;
    const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1e6;
    console.info(`[perf] POST /api/watchlists/preview n=${N} p50=${times[9]!.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${times[19]!.toFixed(1)}ms heapΔ=${heapMb.toFixed(1)}MB`);
    expect(p95).toBeLessThan(800);
  }, 180_000);
});
