/**
 * 003 NFR-003 / SC-005 performance check (T078): seeds 50,000 tenders and 500 matches for one org into a PRIVATE
 * Postgres database, then measures p95 of GET /api/tenders (several filter combinations) and POST
 * /api/watchlists/preview through the real Hono app (no network hop, real SQL).
 *
 *   createdb -h localhost -p 5433 -U postgres tp_perf            # create by hand; drop it afterwards
 *   PERF_DATABASE_URL=postgres://tp:tp@localhost:5433/tp_perf \
 *     pnpm --filter @tp/api exec tsx ../../scripts/perf/identify.ts [--out ../../qa/evidence/003/perf-raw.json]
 *
 * Refuses to run unless the database name contains "perf": the harness TRUNCATES every table of the target.
 * Budgets: GET /tenders p95 < 400 ms (NFR-003), feed filter changes < 1 s p95 (SC-005), preview p95 < 800 ms (NFR-003).
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createTestContext, request, signup } from '../../apps/api/test/helpers';

// scripts/ has no node_modules of its own: resolve drizzle-orm exactly as the API workspace does.
const apiRequire = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { sql } = (await import(pathToFileURL(apiRequire.resolve('drizzle-orm')).href)) as typeof import('drizzle-orm');

const DB_URL = process.env.PERF_DATABASE_URL;
if (!DB_URL || !/\/[^/]*perf[^/]*$/i.test(DB_URL.split('?')[0]!)) {
  console.error('Set PERF_DATABASE_URL to a private database whose name contains "perf" (it is truncated).');
  process.exit(2);
}
const N = Number(process.env.PERF_TENDERS ?? 50_000);
const MATCHES = Number(process.env.PERF_MATCHES ?? 500);
const RUNS = Number(process.env.PERF_RUNS ?? 30);
const OPEN_SHARE_PCT = Number(process.env.PERF_OPEN_PCT ?? 20); // production is ~6 % open; 20 % is deliberately heavier
const NOW = new Date('2026-11-05T04:30:00Z');
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined;

const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
interface Row { name: string; call: string; n: number; p50: number; p95: number; max: number; status: number; total: number | null; budgetMs: number }

async function main() {
  const ctx = await createTestContext({ now: NOW, databaseUrl: DB_URL });
  const rows: Row[] = [];
  try {
    const { cookie, me } = await signup(ctx.app, { orgName: 'Perf Org' });
    const org = me.org.id;
    const iso = NOW.toISOString();
    const t0 = performance.now();
    await ctx.db.execute(sql`
      insert into tenders (bid_number, bid_type, title, items, category, ministry, organisation, state, start_at, end_at,
                           estimated_value, source_url, content_hash, status, raw, created_at)
      select 'GEM/2026/B/' || (7000000 + g), 'bid',
             (array['Laptop','Printer','CCTV camera','Rack server','Desktop computer','Office chair','Diesel generator'])[1 + g % 7] || ' supply lot ' || g,
             jsonb_build_array(jsonb_build_object('name', 'Item ' || g, 'quantity', 1 + g % 40)),
             'Category ' || (g % 60), 'Ministry ' || (g % 40), 'Buyer ' || (g % 97),
             (array['Maharashtra','Karnataka','Delhi','Tamil Nadu','Gujarat','Uttar Pradesh','Kerala','Assam'])[1 + g % 8],
             ${iso}::timestamptz - interval '3 days',
             case when g % 100 < ${OPEN_SHARE_PCT} then ${iso}::timestamptz + (1 + g % 30) * interval '1 day'
                  else ${iso}::timestamptz - (1 + g % 300) * interval '1 day' end,
             50000 + (g * 7919) % 90000000,
             'https://bidplus.gem.gov.in/all-bids', 'perf-' || g,
             case when g % 100 < ${OPEN_SHARE_PCT} then 'open' else (array['closed','awarded','cancelled'])[1 + g % 3] end,
             jsonb_build_object('blob', repeat('x', 2000), 'g', g),
             ${iso}::timestamptz - (g % 400) * interval '1 hour'
      from generate_series(1, ${N}) g`);
    const [wl] = await ctx.db.execute(sql`
      insert into watchlists (org_id, name, criteria) values (${org}, 'Perf watchlist', '{"keywords":["laptop"]}'::jsonb) returning id`)
      .then((r) => (r as unknown as { rows: { id: string }[] }).rows);
    // 500 matches for the org on open tenders (newest first), a tenth of them seen.
    await ctx.db.execute(sql`
      insert into tender_matches (org_id, tender_id, watchlist_id, reasons, relevance, seen)
      select ${org}, t.id, ${wl!.id}, '["keyword: laptop"]'::jsonb, 1, (row_number() over ()) % 10 = 0
      from (select id from tenders where status = 'open' order by created_at desc limit ${MATCHES}) t`);
    await ctx.db.execute(sql`analyze`);
    const seedMs = performance.now() - t0;
    const [cnt] = await ctx.db.execute(sql`select (select count(*) from tenders)::int t, (select count(*) from tenders where status='open')::int o, (select count(*) from tender_matches where org_id=${org})::int m`)
      .then((r) => (r as unknown as { rows: { t: number; o: number; m: number }[] }).rows);
    console.info(`seeded tenders=${cnt!.t} open=${cnt!.o} matches=${cnt!.m} in ${(seedMs / 1000).toFixed(1)}s`);

    const measure = async (name: string, method: 'GET' | 'POST', path: string, json: unknown, budgetMs: number) => {
      const call = () => request(ctx.app, method, path, { cookie, json });
      for (let i = 0; i < 3; i++) await call(); // warm-up (plan cache, pool)
      const times: number[] = [];
      let last = await call();
      for (let i = 0; i < RUNS; i++) {
        const s = performance.now();
        last = await call();
        times.push(performance.now() - s);
      }
      times.sort((a, b) => a - b);
      const total = typeof last.body?.total === 'number' ? last.body.total : typeof last.body?.count === 'number' ? last.body.count : null;
      rows.push({ name, call: `${method} ${path}`, n: RUNS, p50: percentile(times, 0.5), p95: percentile(times, 0.95), max: times[times.length - 1]!, status: last.status, total, budgetMs });
      console.info(`${name.padEnd(46)} status=${last.status} total=${total} p50=${rows.at(-1)!.p50.toFixed(1)}ms p95=${rows.at(-1)!.p95.toFixed(1)}ms`);
    };

    const feed: [string, string][] = [
      ['default feed (open, page 1)', '/tenders'],
      ['status=all', '/tenders?status=all'],
      ['state=Maharashtra', '/tenders?state=Maharashtra'],
      ['q=laptop', '/tenders?q=laptop'],
      ['q=laptop supply (two words)', '/tenders?q=laptop%20supply'],
      ['matched=1', '/tenders?matched=1'],
      ['matched=1&unseen=1', '/tenders?matched=1&unseen=1'],
      ['ministry+category+minValue, sort -value', '/tenders?ministry=Ministry%203&category=Category%2023&minValue=1000000&sort=-value'],
      ['closingWithinDays=7&sort=endAt', '/tenders?closingWithinDays=7&sort=endAt'],
      ['state+q+maxValue, page 3', '/tenders?state=Karnataka&q=printer&maxValue=50000000&page=3'],
      ['status=closed, page 100', '/tenders?status=closed&page=100'],
    ];
    for (const [name, qs] of feed) await measure(`GET ${name}`, 'GET', qs, undefined, 400);

    await measure('POST preview (narrow: laptop + Maharashtra)', 'POST', '/watchlists/preview',
      { criteria: { keywords: ['laptop'], states: ['Maharashtra'] } }, 800);
    await measure('POST preview (broad: 7 keywords, all states)', 'POST', '/watchlists/preview',
      { criteria: { keywords: ['laptop', 'printer', 'cctv', 'server', 'desktop', 'chair', 'generator'], maxValue: 10_000_000_000 } }, 800);
    await measure('POST preview (categories + ministries)', 'POST', '/watchlists/preview',
      { criteria: { categories: ['Category 23', 'Category 43'], ministries: ['Ministry 3', 'Ministry 23'] } }, 800);

    if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), tenders: cnt, runs: RUNS, rows }, null, 2));
    const worstFeed = Math.max(...rows.filter((r) => r.call.startsWith('GET')).map((r) => r.p95));
    const worstPrev = Math.max(...rows.filter((r) => r.call.startsWith('POST')).map((r) => r.p95));
    console.info(`worst GET /tenders p95=${worstFeed.toFixed(1)}ms (budget 400), worst preview p95=${worstPrev.toFixed(1)}ms (budget 800)`);
    process.exitCode = rows.some((r) => r.status !== 200 || r.p95 >= r.budgetMs) ? 1 : 0;
  } finally {
    await ctx.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
