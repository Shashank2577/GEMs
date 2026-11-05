/**
 * NFR-001 performance check (T017): GET /api/dashboard p95 < 500 ms over 20 runs for an org with 10,000 tenders,
 * 2,000 matches, 200 workspaces and 500 activity rows. Skipped unless PERF=1:
 *
 *   PERF=1 TEST_DATABASE_URL=… pnpm --filter @tp/api exec vitest run test/perf
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestContext, request, signup, type TestContext } from '../helpers';

const PERF = process.env.PERF === '1';
const NOW = new Date('2026-11-04T04:30:00Z'); // 10:00 IST

describe.skipIf(!PERF)('GET /api/dashboard performance (NFR-001)', () => {
  let ctx: TestContext;
  let cookie: string;

  beforeAll(async () => {
    ctx = await createTestContext({ now: NOW });
    const owner = await signup(ctx.app, { orgName: 'Perf Org' });
    cookie = owner.cookie;
    const org = owner.me.org.id;
    const user = owner.me.user.id;
    const now = NOW.toISOString();

    // 10,000 public tenders, closing between now - 5 d and now + 25 d.
    await ctx.db.execute(sql`
      insert into tenders (bid_number, title, category, organisation, state, start_at, end_at, emd_amount, estimated_value, source_url, content_hash, status)
      select 'GEM/2026/B/' || (8000000 + g), 'Perf tender ' || g, 'Laptop - Notebook', 'Buyer ' || (g % 97), 'Maharashtra',
             ${now}::timestamptz - interval '10 days', ${now}::timestamptz + ((g % 720) - 120) * interval '1 hour',
             (g % 50) * 1000, 100000 + g * 10, 'https://bidplus.gem.gov.in/all-bids', 'perf-' || g, 'open'
      from generate_series(1, 10000) g`);
    await ctx.db.execute(sql`
      insert into watchlists (org_id, name, criteria, created_by)
      select ${org}, 'Perf watch ' || w, '{"keywords":["perf"],"excludeKeywords":[],"categories":[],"hsnCodes":[],"states":[],"ministries":[]}'::jsonb, ${user}
      from generate_series(1, 4) w`);
    // 2,000 matches spread over the last 20 days.
    await ctx.db.execute(sql`
      insert into tender_matches (org_id, tender_id, watchlist_id, reasons, created_at, seen, dismissed)
      select ${org}, t.id, (select id from watchlists where org_id = ${org} order by name offset (t.rn % 4) limit 1),
             '["Keyword perf"]'::jsonb, ${now}::timestamptz - (t.rn % 480) * interval '1 hour', t.rn % 3 = 0, t.rn % 25 = 0
      from (select id, row_number() over (order by bid_number) rn from tenders where bid_number like 'GEM/2026/B/8%' limit 2000) t`);
    // 200 workspaces across all stages.
    await ctx.db.execute(sql`
      insert into bid_workspaces (org_id, tender_id, stage, owner_id, position)
      select ${org}, t.id, (array['identified','analysing','go','preparing','ready','submitted','won','lost','dropped'])[1 + t.rn % 9], ${user}, t.rn
      from (select id, row_number() over (order by bid_number) rn from tenders where bid_number like 'GEM/2026/B/8%' offset 100 limit 200) t`);
    // Done analyses on 300 tenders (verdict donut + closing-soon refs).
    await ctx.db.execute(sql`
      insert into analyses (org_id, tender_id, status, method, checklist, score, confidence, verdict, requirements, factors)
      select ${org}, t.id, 'done', 'rules', '[]'::jsonb, 40 + t.rn % 60, 0.8,
             case when t.rn % 3 = 0 then 'go' when t.rn % 3 = 1 then 'review' else 'no_go' end, '[]'::jsonb, '[]'::jsonb
      from (select id, row_number() over (order by bid_number) rn from tenders where bid_number like 'GEM/2026/B/8%' limit 300) t`);
    // 500 activity rows pointing at workspaces.
    await ctx.db.execute(sql`
      insert into activity_log (org_id, user_id, action, entity_type, entity_id, meta, created_at)
      select ${org}, ${user}, 'workspace.stage_changed', 'workspace', w.id::text, '{"from":"identified","to":"analysing"}'::jsonb,
             ${now}::timestamptz - g * interval '7 minutes'
      from generate_series(1, 500) g
      join lateral (select id from bid_workspaces where org_id = ${org} order by position offset (g % 200) limit 1) w on true`);
    await ctx.db.execute(sql`analyze`);
  }, 300_000);
  afterAll(() => ctx?.close());

  it('answers in < 500 ms p95 over 20 runs', async () => {
    // Warm-up (connection pool, query plans).
    for (let i = 0; i < 3; i++) expect((await request(ctx.app, 'GET', '/dashboard', { cookie })).status).toBe(200);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const r = await request(ctx.app, 'GET', '/dashboard', { cookie });
      times.push(performance.now() - t0);
      expect(r.status).toBe(200);
    }
    const d = (await request(ctx.app, 'GET', '/dashboard', { cookie })).body;
    expect(d.tiles.activeBids).toBeGreaterThan(100); // the seeded data is really there
    expect(d.closingSoon.length).toBe(8);
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(0.95 * times.length) - 1]!;
    console.info(`[perf] GET /api/dashboard p50=${times[9]!.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${times[19]!.toFixed(1)}ms`);
    expect(p95).toBeLessThan(500);
  }, 120_000);
});
