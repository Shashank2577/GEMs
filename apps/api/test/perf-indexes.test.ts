/**
 * 008/US4 capacity on a CI-sized bulk fixture (T070, T071; FR-027, FR-028, FR-029, FR-033):
 *  - `EXPLAIN (FORMAT JSON)` of the real feed queries (captured from GET /api/tenders) uses the open-tender partial
 *    indexes, and the dispatcher's select uses `notifications_pending_idx`;
 *  - list queries (feed, watchlist preview, dashboard) never read `tenders.raw`, `content_hash` or document text.
 * The 500k-row version of the same checks is `scripts/load/feed.sh` against `bulk-tenders.ts --count 500000`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertBulkNotifications, insertBulkTenders } from '@tp/db/fixtures/bulk-tenders';
import { pendingNotificationsQuery } from '../src/services/alerts';
import { createTestContext, request, signup, type SignedUp, type TestContext } from './helpers';

const TENDERS = 50_000;
const NOTIFICATIONS = 100_000;
const PENDING = 500;

let ctx: TestContext;
let owner: SignedUp;
const captured: { text: string; values: unknown[] }[] = [];

type PgPool = { query: (...args: unknown[]) => Promise<unknown> };
type PlanNode = { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; 'Index Cond'?: string; Plans?: PlanNode[] };

/** Every node of a plan tree. */
function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

async function explain(text: string, values: unknown[], analyze = false): Promise<{ plan: PlanNode; ms: number }> {
  const pool = (ctx.db as unknown as { $client: PgPool }).$client;
  const res = await pool.query(`EXPLAIN (${analyze ? 'ANALYZE, ' : ''}FORMAT JSON) ${text}`, values) as { rows: { 'QUERY PLAN': [{ Plan: PlanNode; 'Execution Time'?: number }] }[] };
  const [out] = res.rows[0]['QUERY PLAN'];
  return { plan: out.Plan, ms: out['Execution Time'] ?? 0 };
}

/** Run a request and return the SQL it sent (in order). */
async function sqlOf(method: string, path: string, json?: unknown): Promise<{ text: string; values: unknown[] }[]> {
  captured.length = 0;
  const r = await request(ctx.app, method, path, { cookie: owner.cookie, json });
  expect(r.status, r.text).toBe(200);
  return [...captured];
}

/** The page query of GET /tenders: the projection select with LIMIT (drizzle omits table qualifiers here). */
const listQuery = (qs: { text: string; values: unknown[] }[]) => {
  const q = qs.find((x) => /^select "id", "source", "bid_number"/.test(x.text) && /from "tenders"/.test(x.text) && /\blimit \$\d+/i.test(x.text));
  if (!q) throw new Error(`feed list query not captured: ${qs.map((x) => x.text.slice(0, 120)).join('\n')}`);
  return q;
};

beforeAll(async () => {
  ctx = await createTestContext();
  owner = await signup(ctx.app, { orgName: 'Capacity Test Co' });
  await insertBulkTenders(ctx.db, { count: TENDERS, now: ctx.clock.now() });
  await insertBulkNotifications(ctx.db, { orgId: owner.me.org.id, userId: owner.me.user.id, count: NOTIFICATIONS, pending: PENDING, now: ctx.clock.now() });
  // Capture every SQL text the app sends through the pool (drizzle node-postgres: pool.query({text, values})).
  const pool = (ctx.db as unknown as { $client: PgPool }).$client;
  const orig = pool.query.bind(pool);
  pool.query = (...args: unknown[]) => {
    const a = args[0] as string | { text: string; values?: unknown[] };
    captured.push({ text: typeof a === 'string' ? a : a.text, values: (typeof a === 'string' ? undefined : a.values) ?? (args[1] as unknown[]) ?? [] });
    return orig(...args);
  };
}, 120_000);
afterAll(() => ctx?.close());

describe('bulk fixture (T071)', () => {
  it('has ~6 % open tenders with skewed states and some unknown values', async () => {
    const [r] = (await ctx.db.execute(sql`select count(*)::int as total, count(*) filter (where status = 'open')::int as open,
      count(distinct state)::int as states, count(*) filter (where estimated_value is null)::int as no_value from tenders`) as unknown as {
      rows: { total: number; open: number; states: number; no_value: number }[] }).rows;
    expect(r.total).toBe(TENDERS);
    expect(r.open / r.total).toBeGreaterThan(0.05);
    expect(r.open / r.total).toBeLessThan(0.07);
    expect(r.states).toBeGreaterThan(15);
    expect(r.no_value).toBeGreaterThan(0);
  });
});

describe('feed uses the open-tender partial indexes (FR-027, US4 scenario 4)', () => {
  const OPEN_INDEXES = /^tenders_open_(created|closing|value|state|ministry|category)_idx$/;
  // [request, index the page query must use (null = any open-tender partial index — the planner picks by cost)]
  const cases: [string, string | null][] = [
    ['/tenders', 'tenders_open_created_idx'],
    ['/tenders?sort=endAt', 'tenders_open_closing_idx'],
    ['/tenders?minValue=500000&sort=value', 'tenders_open_value_idx'],
    ['/tenders?state=Maharashtra', 'tenders_open_state_idx'],
    ['/tenders?state=Maharashtra&ministry=Ministry%20of%20Defence&sort=endAt', null],
  ];
  for (const [path, index] of cases) {
    it(`${path} → ${index ?? 'an open-tender partial index'}; no query of the request scans tenders sequentially`, async () => {
      const qs = await sqlOf('GET', path);
      const list = listQuery(qs);
      const used = nodes((await explain(list.text, list.values)).plan).map((n) => n['Index Name']).filter((n): n is string => !!n && n.startsWith('tenders'));
      // At least one open-tender partial index bounds the work to open tenders (it may be AND-ed with another index).
      expect(used.some((u) => OPEN_INDEXES.test(u)), JSON.stringify(used)).toBe(true);
      if (index) expect(used).toContain(index);
      if (index === 'tenders_open_closing_idx') {
        // Review S5: "still open" is the index range itself, so expired-but-open rows are never read.
        const scan = nodes((await explain(list.text, list.values)).plan).find((n) => n['Index Name'] === index);
        expect(String(scan?.['Index Cond'] ?? ''), JSON.stringify(scan)).toMatch(/COALESCE\(end_at, 'infinity'/i);
      }
      if (index === 'tenders_open_state_idx') {
        // QA finding 1 (PR #515): the page query AND the count / ministry / category facet queries (all carry the state
        // filter; the state facet omits it by design) read tenders_open_state_idx with the state and "still open"
        // conditions as the index range — never the non-partial tenders_state_idx.
        // Page query + the shared total/ministry/category GROUPING SETS query (the state facet omits the state filter).
        const withState = qs.filter((q) => /from "tenders"/.test(q.text) && /"state" in \(/.test(q.text));
        expect(withState.length).toBe(2);
        for (const q of withState) {
          const all = nodes((await explain(q.text, q.values)).plan);
          const scan = all.find((n) => n['Index Name'] === index);
          expect(String(scan?.['Index Cond'] ?? ''), `${q.text.slice(0, 160)}\n${JSON.stringify(all.map((n) => n['Index Name']))}`)
            .toMatch(/state = .*Maharashtra.*COALESCE\(end_at, 'infinity'/i);
          expect(all.map((n) => n['Index Name'])).not.toContain('tenders_state_idx');
        }
      }
      // Page, the shared total + facets query (QA finding 2: one GROUPING SETS scan, not four), and one query per facet
      // whose own filter is set (it leaves that filter out).
      const tenderQueries = qs.filter((q) => /from "tenders"/.test(q.text));
      const ownFacets = ['state=', 'ministry=', 'category='].filter((p) => path.includes(p)).length;
      expect(tenderQueries.length).toBe(2 + ownFacets);
      expect(tenderQueries.filter((q) => /group by grouping sets/i.test(q.text)).length).toBe(1);
      for (const q of tenderQueries) {
        const all = nodes((await explain(q.text, q.values)).plan);
        expect(all.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'tenders'), q.text.slice(0, 160)).toEqual([]);
      }
    });
  }

  it('the page query answers in < 300 ms (EXPLAIN ANALYZE, CI-sized fixture)', async () => {
    for (const [path] of cases) {
      const list = listQuery(await sqlOf('GET', path));
      expect((await explain(list.text, list.values, true)).ms).toBeLessThan(300);
    }
  });
});

describe('full-text search uses tenders_search_gin (008/FR-073, US7 scenario 3)', () => {
  it('q=solar street light&status=all: the page and the total/facets queries read tenders_search_gin, never a Seq Scan on tenders', async () => {
    const qs = await sqlOf('GET', `/tenders?status=all&q=${encodeURIComponent('solar street light')}`);
    const tenderQueries = qs.filter((q) => /from "tenders"/.test(q.text));
    expect(tenderQueries.length).toBe(2);
    for (const q of tenderQueries) {
      const all = nodes((await explain(q.text, q.values)).plan);
      expect(all.map((n) => n['Index Name']), JSON.stringify(all.map((n) => [n['Node Type'], n['Index Name']]))).toContain('tenders_search_gin');
      expect(all.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'tenders')).toEqual([]);
    }
  });

  it('q=solar street light (open feed): index-backed — the GIN or, on this small fixture, an open-tender partial index', async () => {
    // At 50k rows / 3k open the planner may filter the open partial index instead; at 500k it picks the GIN
    // (test/perf/search.perf.ts asserts that on the full-size fixture).
    const qs = await sqlOf('GET', `/tenders?q=${encodeURIComponent('solar street light')}`);
    for (const q of qs.filter((x) => /from "tenders"/.test(x.text))) {
      const all = nodes((await explain(q.text, q.values)).plan);
      const used = all.map((n) => n['Index Name']).filter((n): n is string => !!n);
      expect(used.some((u) => u === 'tenders_search_gin' || /^tenders_open_/.test(u)), JSON.stringify(used)).toBe(true);
      expect(all.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'tenders')).toEqual([]);
    }
  });

  it('q=GEM/BULK/B/12 (bid-number shape) uses tenders_bid_number_prefix_idx, status=all included', async () => {
    const list = listQuery(await sqlOf('GET', `/tenders?status=all&q=${encodeURIComponent('GEM/BULK/B/12')}`));
    const all = nodes((await explain(list.text, list.values)).plan);
    expect(all.map((n) => n['Index Name'])).toContain('tenders_bid_number_prefix_idx');
    expect(all.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'tenders')).toEqual([]);
  });
});

describe('dispatcher select uses notifications_pending_idx (FR-029, US4 scenario 5)', () => {
  it(`EXPLAIN ANALYZE on ${NOTIFICATIONS.toLocaleString('en-IN')} rows with ${PENDING} pending`, async () => {
    const q = pendingNotificationsQuery(ctx.db, 500).toSQL();
    const { plan, ms } = await explain(q.sql, q.params, true);
    expect(nodes(plan).map((n) => n['Index Name'])).toContain('notifications_pending_idx');
    expect(ms).toBeLessThan(50);
  });
});

describe('list queries read tenderListColumns only (FR-028, US4 scenario 6)', () => {
  // The SELECT list must not read `raw` / `content_hash` (qualified or not). WHERE clauses may still filter on them
  // (the demo scope of 008/FR-016, lib/tender-scope.ts); no list query may touch tender_documents at all.
  const heavy = /(^|[\s,(])("tenders"\.)?"(raw|content_hash)"/;
  const projection = (text: string) => text.slice(0, text.search(/ from "tenders"/i));
  const lean = (q: { text: string }) => {
    expect(projection(q.text), q.text).not.toMatch(heavy);
    expect(q.text).not.toMatch(/"tender_documents"/);
  };
  const tenderSelects = (qs: { text: string; values: unknown[] }[]) => qs.filter((q) => /from "tenders"|join "tenders"/i.test(q.text));

  it('feed', async () => {
    const qs = tenderSelects(await sqlOf('GET', '/tenders?pageSize=25'));
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) lean(q);
    expect(listQuery(qs).text).toMatch(/"items"/); // what the list DTO shows stays
  });

  it('watchlist preview — open, not yet closed, keyset pages of at most 2,000 lean rows', async () => {
    // 003/FR-028 (merged) forbids a silent overall cap, so memory is bounded per page instead (008/FR-028's intent):
    // the candidate scan reads lean columns in keyset pages of ≤ 2,000 rows.
    const qs = tenderSelects(await sqlOf('POST', '/watchlists/preview', { criteria: { keywords: ['laptop'] } }));
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) lean(q);
    const cand = qs.find((q) => /limit \$\d+$/i.test(q.text.trim()) && /("tenders"\.)?"end_at" >= \$\d+/.test(q.text));
    expect(cand, qs.map((q) => q.text).join('\n')).toBeTruthy();
    expect(cand!.values.at(-1)).toBe(2000);
    expect(cand!.text).toMatch(/("tenders"\.)?"status" = \$\d+/);
    expect(cand!.text).toMatch(/order by "tenders"\."id" asc/i);
  });

  it('dashboard', async () => {
    const qs = tenderSelects(await sqlOf('GET', '/dashboard'));
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) lean(q);
  });
});
