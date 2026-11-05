/**
 * 008/US7 scenario 4 (FR-074, T104/T105): 1,000 active watchlists × 500 new tenders are matched in Node in < 5 s,
 * every watchlist's criteria are compiled once per run, and matches are inserted in statements of ≤ 500 rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { tenderMatches, tenders, watchlists } from '@tp/db';
import { MATCH_INSERT_BATCH, insertMatchesBatched, matchAndNotify } from '../src/services/ingest';
import { createTestContext, signup, type SignedUp, type TestContext } from './helpers';

const NOW = new Date('2026-11-04T04:30:00.000Z');
const WORDS = Array.from({ length: 50 }, (_, i) => `batchword${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`);

let ctx: TestContext;
let owner: SignedUp;
type PgPool = { query: (...args: unknown[]) => Promise<unknown> };
const inserts: number[] = []; // rows per INSERT INTO tender_matches statement

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW });
  owner = await signup(ctx.app, { orgName: 'Batch Matching Co' });
  const pool = (ctx.db as unknown as { $client: PgPool }).$client;
  const orig = pool.query.bind(pool);
  pool.query = (...args: unknown[]) => {
    const a = args[0] as string | { text: string };
    const text = typeof a === 'string' ? a : a.text;
    if (/^insert into "tender_matches"/i.test(text)) inserts.push(text.slice(text.search(/ values /i)).split(/\),\s*\(/).length);
    return orig(...args);
  };
});
afterAll(() => ctx?.close());

describe('batched matching (US7 scenario 4)', () => {
  it('MATCH_INSERT_BATCH is 500', () => expect(MATCH_INSERT_BATCH).toBe(500));

  it('1,000 watchlists × 500 tenders: < 5 s, 10,000 matches, every INSERT carries ≤ 500 rows', async () => {
    // Watchlist i watches WORDS[i % 50]; tender j's title has WORDS[j % 50] → every tender matches 20 watchlists.
    await ctx.db.insert(watchlists).values(Array.from({ length: 1000 }, (_, i) => ({
      orgId: owner.me.org.id, name: `Batch ${i}`, createdBy: owner.me.user.id,
      criteria: { keywords: [WORDS[i % 50]!], excludeKeywords: [], categories: [], hsnCodes: [], states: [], ministries: [] },
    })));
    const ids = (await ctx.db.insert(tenders).values(Array.from({ length: 500 }, (_, j) => ({
      bidNumber: `GEM/2026/B/55${String(j).padStart(5, '0')}`, title: `Supply of ${WORDS[j % 50]} items`, status: 'open' as const,
      endAt: new Date(NOW.getTime() + 10 * 86_400_000), sourceUrl: `https://bidplus.gem.gov.in/b/${j}`, contentHash: `batch-${j}`,
    }))).returning({ id: tenders.id })).map((r) => r.id);

    inserts.length = 0;
    const t0 = performance.now();
    const r = await matchAndNotify(ctx.deps, ids, NOW, { notify: false });
    const ms = performance.now() - t0;
    console.log(JSON.stringify({ watchlists: 1000, tenders: 500, matchesCreated: r.matchesCreated, insertStatements: inserts.length, maxRowsPerStatement: Math.max(...inserts), ms: Math.round(ms) }));
    expect(r.matchesCreated).toBe(10_000);
    expect(inserts).toHaveLength(20);
    expect(Math.max(...inserts)).toBeLessThanOrEqual(500);
    expect(inserts.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(ms).toBeLessThan(5000);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(tenderMatches).where(eq(tenderMatches.orgId, owner.me.org.id));
    expect(n).toBe(10_000);
    // A re-run inserts nothing new.
    expect(await matchAndNotify(ctx.deps, ids, NOW, { notify: false })).toEqual({ matchesCreated: 0, notificationsCreated: 0 });
  });

  it('insertMatchesBatched splits 1,201 rows into 500 + 500 + 201', async () => {
    const [w] = await ctx.db.select({ id: watchlists.id }).from(watchlists).limit(1);
    const ids = (await ctx.db.insert(tenders).values(Array.from({ length: 1201 }, (_, j) => ({
      bidNumber: `GEM/2026/B/56${String(j).padStart(5, '0')}`, title: `Split ${j}`, sourceUrl: `https://bidplus.gem.gov.in/s/${j}`, contentHash: `split-${j}`,
    }))).returning({ id: tenders.id })).map((r) => r.id);
    inserts.length = 0;
    const out = await insertMatchesBatched(ctx.db, ids.map((tenderId) => ({ orgId: owner.me.org.id, tenderId, watchlistId: w!.id, reasons: [], relevance: 0.5, createdAt: NOW })));
    expect(out).toHaveLength(1201);
    expect(inserts).toEqual([500, 500, 201]);
  });
});
