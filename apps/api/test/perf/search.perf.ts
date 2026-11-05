/**
 * 008/US7 scenario 3 (FR-073, NFR-001): full-text feed search at 500,000 tenders. Opt-in (PERF=1) against a scratch
 * database that already holds the bulk fixture:
 *
 *   createdb tenderpilot_test_us7_500k; DATABASE_URL=…/tenderpilot_test_us7_500k pnpm --filter @tp/db exec tsx src/migrate.ts
 *   DATABASE_URL=… pnpm --filter @tp/db exec tsx src/fixtures/bulk-tenders.ts --count 500000
 *   psql … -c "update tenders set bid_number = replace(bid_number,'GEM/BULK/','GEM/2026/'),
 *              title = case when split_part(bid_number,'/',4)::int % 100 = 7 then 'Solar street light — ' || title else title end"
 *   PERF=1 TEST_DATABASE_URL=…/tenderpilot_test_us7_500k pnpm --filter @tp/api exec vitest run -c vitest.perf.config.ts test/perf/search.perf.ts
 *
 * Asserts: 200 × GET /api/tenders?q=solar street light → p95 < 300 ms (in-process server time); EXPLAIN of the page,
 * count and facet queries uses `tenders_search_gin`; `q=GEM/2026/B/12` matches by bid-number prefix; the plain feed still
 * uses the US4 open-tender partial indexes. The data is kept (keepData), only the test org is added.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestContext, request, signup, type SignedUp, type TestContext } from '../helpers';

const PERF = process.env.PERF === '1';
const RUNS = 200;

type PgPool = { query: (...args: unknown[]) => Promise<unknown> };
type PlanNode = { 'Node Type': string; 'Index Name'?: string; Plans?: PlanNode[] };
const nodes = (p: PlanNode): PlanNode[] => [p, ...(p.Plans ?? []).flatMap(nodes)];

describe.skipIf(!PERF)('feed full-text search at 500k tenders (US7 scenario 3)', () => {
  let ctx: TestContext;
  let owner: SignedUp;
  const captured: { text: string; values: unknown[] }[] = [];
  const pool = () => (ctx.db as unknown as { $client: PgPool }).$client;

  async function explain(text: string, values: unknown[]): Promise<{ plan: PlanNode; ms: number }> {
    const res = await pool().query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, values) as { rows: { 'QUERY PLAN': [{ Plan: PlanNode; 'Execution Time': number }] }[] };
    const [out] = res.rows[0]['QUERY PLAN'];
    return { plan: out.Plan, ms: out['Execution Time'] };
  }

  async function sqlOf(path: string) {
    captured.length = 0;
    const r = await request(ctx.app, 'GET', path, { cookie: owner.cookie });
    expect(r.status, r.text).toBe(200);
    return { body: r.body, queries: captured.filter((q) => /from "tenders"/.test(q.text)) };
  }

  beforeAll(async () => {
    ctx = await createTestContext({ keepData: true });
    const [{ n }] = (await ctx.db.execute(sql`select count(*)::int as n from tenders`) as unknown as { rows: { n: number }[] }).rows;
    if (n < 500_000) throw new Error(`expected the 500k bulk fixture in TEST_DATABASE_URL, found ${n} tenders (see the header)`);
    owner = await signup(ctx.app, { orgName: `Search Perf ${Date.now()}` });
    const p = pool();
    const orig = p.query.bind(p);
    p.query = (...args: unknown[]) => {
      const a = args[0] as string | { text: string; values?: unknown[] };
      captured.push({ text: typeof a === 'string' ? a : a.text, values: (typeof a === 'string' ? undefined : a.values) ?? (args[1] as unknown[]) ?? [] });
      return orig(...args);
    };
  });
  afterAll(() => ctx?.close());

  it(`GET /api/tenders?q=solar street light × ${RUNS}: p95 < 300 ms`, async () => {
    const path = `/tenders?q=${encodeURIComponent('solar street light')}`;
    for (let i = 0; i < 5; i++) await request(ctx.app, 'GET', path, { cookie: owner.cookie }); // warm-up
    const ms: number[] = [];
    let total = 0;
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      const r = await request(ctx.app, 'GET', path, { cookie: owner.cookie });
      ms.push(performance.now() - t0);
      expect(r.status).toBe(200);
      total = r.body.total;
    }
    ms.sort((a, b) => a - b);
    const p50 = ms[Math.floor(RUNS * 0.5)]!;
    const p95 = ms[Math.ceil(RUNS * 0.95) - 1]!;
    console.log(JSON.stringify({ query: 'q=solar street light', runs: RUNS, total, p50_ms: +p50.toFixed(1), p95_ms: +p95.toFixed(1), max_ms: +ms[RUNS - 1]!.toFixed(1) }));
    expect(total).toBeGreaterThan(0);
    expect(p95).toBeLessThan(300);
  });

  it('EXPLAIN: every tenders query of the search request uses tenders_search_gin', async () => {
    const { queries } = await sqlOf(`/tenders?q=${encodeURIComponent('solar street light')}`);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      const { plan, ms } = await explain(q.text, q.values);
      const idx = nodes(plan).map((x) => x['Index Name']).filter(Boolean);
      console.log(JSON.stringify({ query: q.text.slice(0, 90), indexes: idx, nodeTypes: [...new Set(nodes(plan).map((x) => x['Node Type']))], ms }));
      expect(idx).toContain('tenders_search_gin');
      expect(nodes(plan).some((x) => x['Node Type'] === 'Seq Scan')).toBe(false);
    }
  });

  it('q=GEM/2026/B/12 matches by bid-number prefix (index-backed)', async () => {
    const { body, queries } = await sqlOf(`/tenders?status=all&q=${encodeURIComponent('GEM/2026/B/12')}&pageSize=100`);
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.every((t: { bidNumber: string }) => t.bidNumber.startsWith('GEM/2026/B/12'))).toBe(true);
    const page = queries.find((q) => /\blimit \$\d+/i.test(q.text))!;
    const { plan, ms } = await explain(page.text, page.values);
    const idx = nodes(plan).map((x) => x['Index Name']).filter(Boolean);
    console.log(JSON.stringify({ query: 'status=all&q=GEM/2026/B/12', total: body.total, indexes: idx, ms }));
    expect(idx.some((i) => i === 'tenders_bid_number_prefix_idx' || i === 'tenders_search_gin')).toBe(true);
    expect(ms).toBeLessThan(300);
  });

  it('the plain feed (no q) still uses the US4 open-tender partial indexes', async () => {
    const { queries } = await sqlOf('/tenders');
    const page = queries.find((q) => /\blimit \$\d+/i.test(q.text))!;
    const { plan } = await explain(page.text, page.values);
    const idx = nodes(plan).map((x) => x['Index Name']).filter(Boolean);
    console.log(JSON.stringify({ query: 'GET /tenders (no q)', indexes: idx }));
    expect(idx.some((i) => /^tenders_open_/.test(i!))).toBe(true);
  });
});
