/**
 * T038 — Identify routes: tender feed filters/facets/sort/pagination, detail, seen/dismiss, watchlists CRUD +
 * preview + roles, ingestion run/runs roles, notifications, and org isolation.
 */
import { eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyses, bidWorkspaces, ingestionRuns, notifications, tenderMatches, tenders, watchlists } from '@tp/db';
import type { NormalizedTender } from '@tp/core/gem/parse';
import { createMockGem } from '../../../tools/mock-gem/src/app';
import { byPreviewOrder, escapeLike, phraseLike, type Candidate } from '../src/routes/watchlists';
import { matchAndNotify, runIngestion } from '../src/services/ingest';
import { createTestContext, request, seedOrgWithRoles, signup, type SignedUp, type TestContext } from './helpers';

const REF = new Date('2026-11-04T04:30:00.000Z');
const GEM = 'http://mock-gem.test';

let ctx: TestContext;
let team: Awaited<ReturnType<typeof seedOrgWithRoles>>;
let other: SignedUp;
let laptopWatchlistId: string;

const get = (path: string, who: SignedUp = team.analyst) => request(ctx.app, 'GET', path, { cookie: who.cookie });
const tenderId = async (bid: string) => (await ctx.db.select({ id: tenders.id }).from(tenders).where(eq(tenders.bidNumber, bid)))[0].id;

beforeAll(async () => {
  const mock = createMockGem({ now: () => REF, token: 'b'.repeat(32) });
  ctx = await createTestContext({ now: REF, gemBaseUrl: GEM, fetch: async (input, init) => mock.app.fetch(new Request(input as string, init)) });
  team = await seedOrgWithRoles(ctx.app, 'Sharma Infotech Pvt Ltd');
  other = await signup(ctx.app, { orgName: 'Rival Traders' });
  const w = await request(ctx.app, 'POST', '/watchlists', { cookie: team.bidManager.cookie, json: { name: 'Laptops — Maharashtra', criteria: { keywords: ['laptop'], states: ['Maharashtra'] } } });
  laptopWatchlistId = w.body.id;
  const r = await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.bidManager.cookie, json: { pages: 5 } });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ status: 'success', tendersCreated: 36, matchesCreated: 2, trigger: 'manual' });
  // Rival org watches CCTV.
  await request(ctx.app, 'POST', '/watchlists', { cookie: other.cookie, json: { name: 'CCTV', criteria: { keywords: ['cctv'] } } });
});

afterAll(async () => { await ctx?.close(); });

describe('GET /tenders', () => {
  it('lists open tenders with facets, newest first by default', async () => {
    const r = await get('/tenders?pageSize=10');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(36);
    expect(r.body.items).toHaveLength(10);
    const item = r.body.items[0];
    expect(item).toHaveProperty('bidNumber');
    expect(item).not.toHaveProperty('raw');
    expect(item).not.toHaveProperty('contentHash');
    expect(r.body.facets.states.find((f: { value: string }) => f.value === 'Maharashtra').count).toBe(6);
    expect(r.body.facets.ministries.length).toBeGreaterThan(15);
    expect(r.body.facets.categories.length).toBeGreaterThan(20);
  });

  it('paginates without overlap', async () => {
    const p1 = await get('/tenders?pageSize=20&page=1&sort=endAt');
    const p2 = await get('/tenders?pageSize=20&page=2&sort=endAt');
    const ids = [...p1.body.items, ...p2.body.items].map((t: { id: string }) => t.id);
    expect(new Set(ids).size).toBe(36);
    const ends = p1.body.items.map((t: { endAt: string }) => Date.parse(t.endAt));
    expect([...ends].sort((a, b) => a - b)).toEqual(ends);
  });

  it('filters by state (multi), ministry, category, free text, value, closing window, bid type', async () => {
    expect((await get('/tenders?state=Maharashtra')).body.total).toBe(6);
    const multi = await get('/tenders?state=Maharashtra&state=Karnataka');
    expect(multi.body.total).toBe(6 + 3);
    // facet for the filtered dimension ignores its own filter
    expect(multi.body.facets.states.length).toBeGreaterThan(10);
    expect((await get('/tenders?state=Maharashtra|Karnataka')).body.total).toBe(9);
    expect((await get(`/tenders?ministry=${encodeURIComponent('Ministry of Defence')}`)).body.total).toBe(3);
    expect((await get(`/tenders?category=${encodeURIComponent('Laptop - Notebook')}`)).body.total).toBe(4);
    const q = await get('/tenders?q=laptop');
    expect(q.body.total).toBe(4);
    expect((await get('/tenders?q=laptop%20mumbai')).body.total).toBe(1);
    expect((await get('/tenders?q=GEM/2026/B/6421013')).body.items[0].title).toMatch(/Ambulance/);
    const big = await get('/tenders?minValue=20000000');
    expect(big.body.items.every((t: { estimatedValue: number }) => t.estimatedValue >= 20_000_000)).toBe(true);
    expect(big.body.total).toBeGreaterThan(3);
    const soon = await get('/tenders?closingWithinDays=5');
    expect(soon.body.items.every((t: { endAt: string }) => Date.parse(t.endAt) <= REF.getTime() + 5 * 86_400_000)).toBe(true);
    expect(soon.body.total).toBe(2);
    expect((await get('/tenders?bidType=ra')).body.total).toBe(2);
    expect((await get('/tenders?bidType=service')).body.total).toBeGreaterThanOrEqual(10);
    expect((await get('/tenders?status=closed')).body.total).toBe(0);
    expect((await get('/tenders?status=all')).body.total).toBe(36);
  });

  it('status selector: closed / awarded / cancelled / all (FR-036)', async () => {
    const closing = await tenderId('GEM/2026/B/6421001');
    const awarding = await tenderId('GEM/2026/B/6421013');
    try {
      await ctx.db.update(tenders).set({ status: 'closed' }).where(eq(tenders.id, closing));
      await ctx.db.update(tenders).set({ status: 'awarded' }).where(eq(tenders.id, awarding));
      expect((await get('/tenders?status=closed')).body.items.map((t: { id: string }) => t.id)).toEqual([closing]);
      expect((await get('/tenders?status=awarded')).body.items.map((t: { id: string }) => t.id)).toEqual([awarding]);
      expect((await get('/tenders')).body.total).toBe(34);
      expect((await get('/tenders?status=open')).body.total).toBe(34);
      expect((await get('/tenders?status=all')).body.total).toBe(36);
      expect((await get('/tenders?status=cancelled')).body.total).toBe(0);
      expect((await get('/tenders?status=bogus')).status).toBe(400);
    } finally {
      await ctx.db.update(tenders).set({ status: 'open' }).where(sql`${tenders.id} in (${closing}, ${awarding})`);
    }
  });

  it('status=closed also lists open-status tenders whose deadline has passed (FR-036)', async () => {
    const lapsed = await tenderId('GEM/2026/B/6421001');
    const [orig] = await ctx.db.select({ endAt: tenders.endAt }).from(tenders).where(eq(tenders.id, lapsed));
    try {
      await ctx.db.update(tenders).set({ endAt: new Date(REF.getTime() - 3_600_000) }).where(eq(tenders.id, lapsed));
      expect((await get('/tenders?status=closed')).body.items.map((t: { id: string }) => t.id)).toEqual([lapsed]);
      expect((await get('/tenders?status=open')).body.total).toBe(35);
    } finally {
      await ctx.db.update(tenders).set({ endAt: orig.endAt }).where(eq(tenders.id, lapsed));
    }
  });

  it('rejects bad query values with 400', async () => {
    expect((await get('/tenders?sort=bogus')).status).toBe(400);
    expect((await get('/tenders?pageSize=1000')).status).toBe(400);
    expect((await get('/tenders?verdict=maybe')).status).toBe(400);
  });

  it('shows matches with watchlist names + reasons, isNew, and filters matched / watchlist / unseen', async () => {
    const m = await get('/tenders?matched=1&sort=relevance');
    expect(m.body.total).toBe(2);
    const first = m.body.items[0];
    expect(first.matches).toEqual([expect.objectContaining({ watchlistId: laptopWatchlistId, watchlistName: 'Laptops — Maharashtra', reasons: ['Keyword “laptop”', 'State: Maharashtra'] })]);
    expect(first).toMatchObject({ isNew: true, seen: false, analysis: null, workspace: null });
    expect((await get(`/tenders?watchlistId=${laptopWatchlistId}`)).body.total).toBe(2);
    expect((await get('/tenders?unseen=1')).body.total).toBe(2);
    expect((await get('/tenders?matched=0')).body.total).toBe(34);
    const unmatched = (await get('/tenders?matched=0&pageSize=1')).body.items[0];
    expect(unmatched).toMatchObject({ matches: [], seen: true, isNew: false });
  });

  it('joins latest analysis verdict + workspace stage and filters/sorts by them', async () => {
    const a = await tenderId('GEM/2026/B/6421001');
    const b = await tenderId('GEM/2026/B/6421009');
    await ctx.db.insert(analyses).values([
      { orgId: team.orgId, tenderId: a, status: 'done', score: 81, verdict: 'go', createdAt: new Date(REF.getTime() - 1000) },
      { orgId: team.orgId, tenderId: b, status: 'done', score: 35, verdict: 'no_go' },
      // The rival's analysis must never leak.
      { orgId: other.me.org.id, tenderId: b, status: 'done', score: 99, verdict: 'go' },
    ]);
    await ctx.db.insert(bidWorkspaces).values({ orgId: team.orgId, tenderId: a, stage: 'preparing' });
    const go = await get('/tenders?verdict=go');
    expect(go.body.items.map((t: { id: string }) => t.id)).toEqual([a]);
    expect(go.body.items[0]).toMatchObject({ analysis: { score: 81, verdict: 'go', stale: false }, workspace: { stage: 'preparing' } });
    expect((await get('/tenders?verdict=go|no_go')).body.total).toBe(2);
    expect((await get('/tenders?verdict=none')).body.total).toBe(34);
    expect((await get('/tenders?stage=preparing')).body.total).toBe(1);
    const byScore = await get('/tenders?sort=score&pageSize=2');
    expect(byScore.body.items.map((t: { analysis: { score: number } }) => t.analysis?.score)).toEqual([81, 35]);
    const rival = await get('/tenders?verdict=go', other);
    expect(rival.body.items.map((t: { id: string }) => t.id)).toEqual([b]);
    expect(rival.body.items[0].analysis.score).toBe(99);
  });
});

describe('GET /tenders/:id, seen, dismiss', () => {
  it('returns detail with events, documents and matches; 404 for unknown / malformed ids', async () => {
    const id = await tenderId('GEM/2026/B/6421010');
    const d = await get(`/tenders/${id}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ bidNumber: 'GEM/2026/B/6421010', state: 'Maharashtra', organisation: 'National Informatics Centre (NIC)' });
    expect(d.body.events).toEqual([expect.objectContaining({ kind: 'created' })]);
    expect(d.body.documents).toEqual([]);
    expect(d.body.matches).toHaveLength(1);
    expect((await get('/tenders/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await get('/tenders/not-a-uuid')).status).toBe(404);
  });

  it('seen clears "new" for the org and reads the related notification', async () => {
    const id = await tenderId('GEM/2026/B/6421010');
    const before = await get('/notifications', team.analyst);
    const unread = before.body.unreadCount;
    expect((await request(ctx.app, 'POST', `/tenders/${id}/seen`, { cookie: team.analyst.cookie })).status).toBe(200);
    const d = await get(`/tenders/${id}`, team.owner);
    expect(d.body).toMatchObject({ seen: true, isNew: false });
    expect((await get('/notifications', team.analyst)).body.unreadCount).toBe(unread - 1);
    expect((await get('/notifications', team.owner)).body.unreadCount).toBe(2); // other users' alerts untouched
  });

  it('dismiss hides a matched tender, undo brings it back; unmatched tenders cannot be dismissed', async () => {
    const id = await tenderId('GEM/2026/B/6421010');
    expect((await request(ctx.app, 'POST', `/tenders/${id}/dismiss`, { cookie: team.viewer.cookie })).body).toEqual({ ok: true, dismissed: true });
    expect((await get('/tenders?matched=1')).body.total).toBe(1);
    expect((await get('/tenders?q=laptop%20mumbai')).body.total).toBe(0);
    expect((await get('/tenders?q=laptop%20mumbai&includeDismissed=1')).body.items[0].dismissed).toBe(true);
    await request(ctx.app, 'POST', `/tenders/${id}/dismiss`, { cookie: team.viewer.cookie, json: { undo: true } });
    expect((await get('/tenders?matched=1')).body.total).toBe(2);
    const unmatched = await tenderId('GEM/2026/B/6421013');
    expect((await request(ctx.app, 'POST', `/tenders/${unmatched}/dismiss`, { cookie: team.viewer.cookie })).status).toBe(409);
  });

  it('requires auth', async () => {
    expect((await request(ctx.app, 'GET', '/tenders')).status).toBe(401);
  });
});

describe('watchlists', () => {
  it('previews counts and samples live without saving', async () => {
    const p = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: team.viewer.cookie, json: { criteria: { keywords: ['cctv', 'camera'] } } });
    expect(p.status).toBe(200);
    expect(p.body.count).toBe(3); // NVR+CCTV, CCTV AMC, interactive panel with document camera
    expect(p.body.sample[0]).toHaveProperty('previewReasons');
    const empty = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: team.viewer.cookie, json: { criteria: {} } });
    expect(empty.body).toEqual({ count: 0, sample: [] });
    const services = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: team.viewer.cookie, json: { criteria: { bidTypes: ['service'], states: ['Uttar Pradesh', 'Assam'], minValue: 5_000_000 } } });
    expect(services.body.count).toBe(2);
  });

  it('enforces roles: viewer cannot create; analyst can create, edit, pause, delete', async () => {
    const body = { name: 'Medical equipment', criteria: { keywords: ['ventilator', 'patient monitor', 'hospital bed'], excludeKeywords: ['mattress'] } };
    expect((await request(ctx.app, 'POST', '/watchlists', { cookie: team.viewer.cookie, json: body })).status).toBe(403);
    const created = await request(ctx.app, 'POST', '/watchlists', { cookie: team.analyst.cookie, json: body });
    expect(created.status).toBe(201);
    // Back-filled silently: ventilator + patient monitor; hospital bed bid is excluded by "mattress".
    expect(created.body).toMatchObject({ name: 'Medical equipment', active: true, matchCount: 2, openCount: 2, createdBy: { name: 'Test analyst' } });
    const id = created.body.id;

    const list = await get('/watchlists', team.viewer);
    expect(list.body.items.map((w: { name: string }) => w.name).sort()).toEqual(['Laptops — Maharashtra', 'Medical equipment']);

    const paused = await request(ctx.app, 'PATCH', `/watchlists/${id}`, { cookie: team.analyst.cookie, json: { active: false } });
    expect(paused.body.active).toBe(false);
    const edited = await request(ctx.app, 'PATCH', `/watchlists/${id}`, { cookie: team.analyst.cookie, json: { active: true, criteria: { keywords: ['ventilator'] } } });
    expect(edited.body).toMatchObject({ active: true, matchCount: 1 });
    expect((await request(ctx.app, 'PATCH', `/watchlists/${id}`, { cookie: team.viewer.cookie, json: { active: false } })).status).toBe(403);
    expect((await request(ctx.app, 'DELETE', `/watchlists/${id}`, { cookie: team.analyst.cookie })).status).toBe(200);
    expect((await get('/watchlists')).body.total).toBe(1);
  });

  it('validates criteria', async () => {
    const empty = await request(ctx.app, 'POST', '/watchlists', { cookie: team.analyst.cookie, json: { name: 'x', criteria: {} } });
    expect(empty.status).toBe(400);
    expect(empty.body.error.details.fields.criteria).toBeTruthy();
    const range = await request(ctx.app, 'POST', '/watchlists', { cookie: team.analyst.cookie, json: { name: 'x', criteria: { keywords: ['a'], minValue: 10, maxValue: 5 } } });
    expect(range.status).toBe(400);
    expect(range.body.error.details.fields['criteria.maxValue']).toMatch(/at least/);
    const hsn = await request(ctx.app, 'POST', '/watchlists', { cookie: team.analyst.cookie, json: { name: 'x', criteria: { hsnCodes: ['84AB'] } } });
    expect(hsn.status).toBe(400);
    const noName = await request(ctx.app, 'POST', '/watchlists', { cookie: team.analyst.cookie, json: { name: ' ', criteria: { keywords: ['a'] } } });
    expect(noName.status).toBe(400);
  });

  it('isolates orgs', async () => {
    const theirs = await get('/watchlists', other);
    expect(theirs.body.items.map((w: { name: string }) => w.name)).toEqual(['CCTV']);
    expect(theirs.body.items[0].matchCount).toBe(2);
    expect((await request(ctx.app, 'PATCH', `/watchlists/${laptopWatchlistId}`, { cookie: other.cookie, json: { active: false } })).status).toBe(404);
    expect((await request(ctx.app, 'DELETE', `/watchlists/${laptopWatchlistId}`, { cookie: other.cookie })).status).toBe(404);
    const feed = await get('/tenders?matched=1', other);
    expect(feed.body.items.every((t: { matches: { watchlistName: string }[] }) => t.matches.every((m) => m.watchlistName === 'CCTV'))).toBe(true);
    const laptop = await tenderId('GEM/2026/B/6421001');
    expect((await get(`/tenders/${laptop}`, other)).body.matches).toEqual([]);
  });
});

describe('ingestion routes', () => {
  it('only bid managers+ can run a sync; everyone sees health', async () => {
    expect((await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.analyst.cookie, json: {} })).status).toBe(403);
    expect((await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.viewer.cookie, json: {} })).status).toBe(403);
    expect((await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.bidManager.cookie, json: { pages: 99 } })).status).toBe(400);
    ctx.clock.advance(60_000);
    // FR-013: the setup's manual run finished < 2 min ago → cooldown; allowed again from retryAt.
    const cool = await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.owner.cookie, json: { pages: 1 } });
    expect(cool.status).toBe(429);
    ctx.clock.set(new Date(cool.body.error.details.retryAt));
    const ok = await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.owner.cookie, json: { pages: 1 } });
    expect(ok.body).toMatchObject({ status: 'success', pagesFetched: 1, tendersCreated: 0 });
    const runs = await get('/ingestion/runs', team.viewer);
    expect(runs.body.items.length).toBe(2);
    expect(runs.body).toMatchObject({ totalTenders: 36, openTenders: 36, lastRun: { trigger: 'manual', status: 'success' } });
    expect(runs.body.lastSuccessAt).toBeTruthy();
    expect(runs.body.items[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('manual sync cooldown (FR-013)', () => {
  const runCount = async () => Number((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(ingestionRuns))[0].n);

  it('rejects a manual sync within 2 min of a finished manual run with 429 sync_cooldown and retryAt', async () => {
    // Own fixture: a manual run that finished just now (later than any earlier one), so order doesn't matter.
    ctx.clock.advance(60_000);
    const finishedAt = ctx.clock.now();
    await ctx.db.insert(ingestionRuns).values({ trigger: 'manual', status: 'success', startedAt: new Date(finishedAt.getTime() - 5_000), finishedAt });
    const baseline = await runCount();
    const retryAt = new Date(finishedAt.getTime() + 2 * 60_000);

    ctx.clock.set(new Date(retryAt.getTime() - 1_000));
    const r = await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.bidManager.cookie, json: {} });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatchObject({ code: 'sync_cooldown', details: { retryAt: retryAt.toISOString() } });
    const ist = retryAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
    expect(r.body.error.message).toBe(`GeM was synced moments ago. Next manual sync at ${ist} IST.`);
    expect(await runCount()).toBe(baseline); // nothing was started
    // Role checks still come first.
    expect((await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.analyst.cookie, json: {} })).status).toBe(403);

    // A scheduled run neither starts nor extends the cooldown.
    ctx.clock.set(retryAt);
    const cron = await runIngestion(ctx.deps, { trigger: 'cron', pages: 1 });
    expect(cron.status).toBe('success');
    const ok = await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.bidManager.cookie, json: { pages: 1 } });
    expect(ok.status).toBe(200);
    expect(ok.body.trigger).toBe('manual');
    expect(await runCount()).toBe(baseline + 2);
    // …but this finished manual run does — across orgs (GeM is shared by every tenant).
    const rival = await request(ctx.app, 'POST', '/ingestion/run', { cookie: other.cookie, json: {} });
    expect(rival.status).toBe(429);
    expect(rival.body.error.code).toBe('sync_cooldown');
    expect(await runCount()).toBe(baseline + 2);
    ctx.clock.advance(2 * 60_000);
  });
});

describe('notifications', () => {
  it('lists in-app alerts with delivery status, unread filter, read and read-all — per user', async () => {
    const r = await get('/notifications', team.owner);
    expect(r.body.total).toBe(2);
    expect(r.body.items[0]).toMatchObject({ kind: 'tender_match', read: false, link: expect.stringMatching(/^\/tenders\//) });
    expect(r.body.items[0].title).toMatch(/^New match: Laptop/);
    expect(r.body.items[0].body).toMatch(/closes .* IST/);
    // manual run dispatched emails right away (log mailer → skipped, status recorded)
    expect(r.body.items[0].deliveries).toEqual([expect.objectContaining({ channel: 'email', status: 'skipped' })]);

    const one = r.body.items[0].id;
    expect((await request(ctx.app, 'POST', `/notifications/${one}/read`, { cookie: team.owner.cookie })).status).toBe(200);
    expect((await get('/notifications?unread=1', team.owner)).body).toMatchObject({ total: 1, unreadCount: 1 });
    // other users can't touch it
    expect((await request(ctx.app, 'POST', `/notifications/${one}/read`, { cookie: other.cookie })).status).toBe(404);
    const all = await request(ctx.app, 'POST', '/notifications/read-all', { cookie: team.owner.cookie });
    expect(all.body).toEqual({ ok: true, updated: 1 });
    expect((await get('/notifications', team.owner)).body.unreadCount).toBe(0);
    expect((await get('/notifications', team.bidManager)).body.unreadCount).toBe(2);
    expect((await get('/notifications', other)).body.total).toBe(0);
  });
});

describe('end-to-end: new bid published on GeM → matched → alert', () => {
  it('a newly published Maharashtra laptop bid shows up as new in the feed with an alert', async () => {
    // fresh context sharing the mock (publishing goes through the admin endpoint)
    const before = (await get('/tenders?matched=1', team.owner)).body.total;
    const mockFetch = ctx.deps.fetch;
    const pub = await mockFetch(`${GEM}/__admin/publish`, { method: 'POST', body: JSON.stringify({ count: 1 }) });
    expect((await pub.json()).published).toEqual(['GEM/2026/B/6421101']);
    ctx.clock.advance(30 * 60_000);
    const run = await runIngestion(ctx.deps, { trigger: 'cron', pages: 1 });
    expect(run).toMatchObject({ tendersCreated: 1, matchesCreated: 1 });
    const feed = await get('/tenders?matched=1&unseen=1', team.owner);
    expect(feed.body.items[0]).toMatchObject({ bidNumber: 'GEM/2026/B/6421101', isNew: true });
    expect((await get('/tenders?matched=1', team.owner)).body.total).toBe(before + 1);
    expect((await get('/notifications?unread=1', team.owner)).body.items[0].title).toMatch(/Laptop/);
  });
});

// The tests below seed their own org (and tenders, removed afterwards) so they don't depend on — or disturb — the
// shared fixture state used by the tests above.
describe('watchlists: silent back-fill, pause, limit, volume (T025, T030, T031)', () => {
  const countNotifications = async (org?: string) => Number((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(notifications)
    .where(org ? eq(notifications.orgId, org) : undefined))[0].n);
  const matchesOf = async (watchlistId: string) => Number((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(tenderMatches)
    .where(eq(tenderMatches.watchlistId, watchlistId)))[0].n);

  it('creating, editing criteria and resuming a watchlist create zero notifications (FR-025)', async () => {
    const org = await signup(ctx.app, { orgName: 'Silent Backfill Traders' });
    // Expected counts come from preview, so they hold whatever earlier tests ingested.
    const previewCount = async (criteria: object) =>
      (await request(ctx.app, 'POST', '/watchlists/preview', { cookie: org.cookie, json: { criteria } })).body.count as number;
    const laptops = await previewCount({ keywords: ['laptop'] });
    const cameras = await previewCount({ keywords: ['cctv', 'camera'] });
    expect(laptops).toBeGreaterThan(0);
    expect(cameras).toBeGreaterThan(0);
    const before = await countNotifications();
    const created = await request(ctx.app, 'POST', '/watchlists', { cookie: org.cookie, json: { name: 'Laptops', criteria: { keywords: ['laptop'] } } });
    expect(created.status).toBe(201);
    expect(created.body.matchCount).toBe(laptops); // back-filled…
    expect(await countNotifications(org.me.org.id)).toBe(0); // …silently
    const id = created.body.id;

    const edited = await request(ctx.app, 'PATCH', `/watchlists/${id}`, { cookie: org.cookie, json: { criteria: { keywords: ['cctv', 'camera'] } } });
    expect(edited.status).toBe(200);
    expect(edited.body.matchCount).toBe(cameras);
    expect(await countNotifications(org.me.org.id)).toBe(0);

    expect((await request(ctx.app, 'PATCH', `/watchlists/${id}`, { cookie: org.cookie, json: { active: false } })).body.active).toBe(false);
    // Drop the back-filled matches so resuming has something to back-fill.
    await ctx.db.delete(tenderMatches).where(eq(tenderMatches.watchlistId, id));
    const resumed = await request(ctx.app, 'PATCH', `/watchlists/${id}`, { cookie: org.cookie, json: { active: true } });
    expect(resumed.body).toMatchObject({ active: true, matchCount: cameras });
    expect(await countNotifications(org.me.org.id)).toBe(0);
    expect(await countNotifications()).toBe(before); // no other org was notified either
  });

  it('a paused watchlist gets no matches from a later ingestion (FR-025)', async () => {
    const org = await signup(ctx.app, { orgName: 'Paused Watch Co' });
    const criteria = { keywords: ['hydrofoil'] };
    const live = await request(ctx.app, 'POST', '/watchlists', { cookie: org.cookie, json: { name: 'Hydrofoils (live)', criteria } });
    const paused = await request(ctx.app, 'POST', '/watchlists', { cookie: org.cookie, json: { name: 'Hydrofoils (paused)', criteria } });
    expect((await request(ctx.app, 'PATCH', `/watchlists/${paused.body.id}`, { cookie: org.cookie, json: { active: false } })).body.active).toBe(false);
    expect(live.body.matchCount).toBe(0);

    const now = ctx.clock.now();
    const bidNumber = 'GEM/2099/B/7700001';
    const bid: NormalizedTender = {
      source: 'gem', bidNumber, gemBidId: null, bidType: 'bid', title: 'Hydrofoil survey boat', items: [{ name: 'Hydrofoil survey boat', quantity: 1 }],
      category: 'Boats', quantity: 1, ministry: 'Ministry of Ports, Shipping and Waterways', department: null, organisation: null, buyerOffice: null,
      state: 'Goa', city: 'Panaji', startAt: now, endAt: new Date(now.getTime() + 20 * 86_400_000), openingAt: null, emdAmount: null,
      estimatedValue: null, epbgPercent: null, hsnCodes: [], status: 'open', documentUrl: null, sourceUrl: `${GEM}/bid/7700001`, raw: {}, contentHash: 'hydrofoil-1',
    };
    const client = { fetchTenders: async () => ({ tenders: [bid], numFound: 1, rawCount: 1 }) };
    let runId: string | undefined;
    try {
      const run = await runIngestion(ctx.deps, { trigger: 'seed', pages: 1, client });
      runId = run.id;
      expect(run).toMatchObject({ status: 'success', tendersCreated: 1, matchesCreated: 1 });
      expect(await matchesOf(live.body.id)).toBe(1);
      expect(await matchesOf(paused.body.id)).toBe(0);
      expect(await countNotifications(org.me.org.id)).toBeGreaterThan(0); // the live one alerted (control)
      const list = await get('/watchlists', org);
      expect(list.body.items.find((w: { id: string }) => w.id === paused.body.id)).toMatchObject({ active: false, matchCount: 0 });
    } finally {
      await ctx.db.delete(tenders).where(eq(tenders.bidNumber, bidNumber));
      if (runId) await ctx.db.delete(ingestionRuns).where(eq(ingestionRuns.id, runId));
      await ctx.db.delete(notifications).where(eq(notifications.orgId, org.me.org.id));
    }
  });

  it('caps an org at 50 watchlists with 409 watchlist_limit — paused ones count, other orgs unaffected (FR-027)', async () => {
    const org = await signup(ctx.app, { orgName: 'Fifty Lists Ltd' });
    const orgId = org.me.org.id;
    await ctx.db.insert(watchlists).values(Array.from({ length: 49 }, (_, i) => ({
      orgId, name: `Seeded ${i + 1}`, criteria: { keywords: [`zqx${i}`] } as never, active: i % 2 === 0,
    })));
    const body = (name: string) => ({ name, criteria: { keywords: ['zqxnothing'] } });
    const fiftieth = await request(ctx.app, 'POST', '/watchlists', { cookie: org.cookie, json: body('Number 50') });
    expect(fiftieth.status).toBe(201);
    const over = await request(ctx.app, 'POST', '/watchlists', { cookie: org.cookie, json: body('Number 51') });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({ code: 'watchlist_limit', message: 'You can have up to 50 watchlists — delete one first.' });
    expect((await get('/watchlists', org)).body.total).toBe(50);
    // The limit is per org: another org can still create.
    const second = await signup(ctx.app, { orgName: 'Second Lists Ltd' });
    expect((await request(ctx.app, 'POST', '/watchlists', { cookie: second.cookie, json: body('Their first') })).status).toBe(201);
    // Deleting one frees a slot.
    expect((await request(ctx.app, 'DELETE', `/watchlists/${fiftieth.body.id}`, { cookie: org.cookie })).status).toBe(200);
    expect((await request(ctx.app, 'POST', '/watchlists', { cookie: org.cookie, json: body('Number 50 again') })).status).toBe(201);
  });

  it('preview and back-fill find every match beyond 5,000 candidates, with escaped category/ministry pre-filters (FR-028)', async () => {
    const N = 6000;
    const prefix = 'GEM/2099/B/88';
    const end = new Date(ctx.clock.now().getTime() + 30 * 86_400_000);
    const rows = Array.from({ length: N }, (_, i) => ({
      bidNumber: `${prefix}${String(i).padStart(5, '0')}`, title: `Flux capacitor module ${i}`, items: [{ name: 'Flux capacitor module', quantity: 2 }],
      category: 'Flux capacitor spares — 100% A\\B grade', ministry: 'Ministry of Temporal Affairs', department: 'Department of Clocks',
      state: 'Kerala', endAt: end, status: 'open' as const, sourceUrl: `${GEM}/bid/88${i}`, contentHash: `flux-${i}`,
    }));
    // Hyphenated phrase: only the `%flux%capacitor%` phrase pre-filter lets the matcher see this one.
    rows.push({ ...rows[0], bidNumber: `${prefix}99999`, title: 'Flux-capacitor module (hyphenated)', items: [{ name: 'Flux-capacitor module', quantity: 1 }],
      category: 'Flux-capacitor spares — 100% A\\B grade', sourceUrl: `${GEM}/bid/8899999`, contentHash: 'flux-hyphen' });
    try {
      for (let i = 0; i < rows.length; i += 1000) await ctx.db.insert(tenders).values(rows.slice(i, i + 1000));
      const criteria = { keywords: ['flux capacitor'], categories: ['100% A\\B grade'], ministries: ['temporal affairs'], states: ['kerala'] };
      const t0 = Date.now();
      const p = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: team.viewer.cookie, json: { criteria } });
      const previewMs = Date.now() - t0;
      expect(p.status).toBe(200);
      expect(p.body.count).toBe(N + 1);
      expect(p.body.sample).toHaveLength(5);
      // Pinpoint the hyphenated one: it is found, and its own preview has exactly it.
      const hyphen = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: team.viewer.cookie, json: { criteria: { keywords: ['flux capacitor module'], categories: ['flux-capacitor'] } } });
      expect(hyphen.body.count).toBe(1);
      expect(hyphen.body.sample[0].title).toBe('Flux-capacitor module (hyphenated)');
      expect(previewMs).toBeLessThan(10_000); // generous CI bound; NFR-003 is measured separately
      // LIKE wildcards in criteria are literal: "_" must not match the space.
      const literal = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: team.viewer.cookie, json: { criteria: { ministries: ['temporal_affairs'] } } });
      expect(literal.body.count).toBe(0);

      const org = await signup(ctx.app, { orgName: 'Flux Volume Corp' });
      const w = await request(ctx.app, 'POST', '/watchlists', { cookie: org.cookie, json: { name: 'Flux capacitors', criteria } });
      expect(w.status).toBe(201);
      expect(w.body).toMatchObject({ matchCount: N + 1, openCount: N + 1 });
      expect(await countNotifications(org.me.org.id)).toBe(0);
    } finally {
      await ctx.db.delete(tenders).where(like(tenders.bidNumber, `${prefix}%`));
    }
  }, 180_000);
});

describe('watchlist SQL helpers and batched matching', () => {
  it('escapes LIKE wildcards and the escape character; phrases allow any separator', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('A\\B')).toBe('A\\\\B');
    expect(escapeLike('plain text')).toBe('plain text');
    expect(phraseLike('flux capacitor')).toBe('%flux%capacitor%');
    expect(phraseLike('  patient   monitor ')).toBe('%patient%monitor%');
    expect(phraseLike('50% off_cut\\x')).toBe('%50\\%%off\\_cut\\\\x%');
  });

  it('orders preview candidates deterministically, by id when everything else ties', () => {
    const at = new Date('2026-11-10T00:00:00Z');
    const c = (id: string, relevance = 0.5, endAt: Date | null = at): Candidate => ({ id, relevance, reasons: [], endAt, createdAt: at });
    const sorted = [c('b'), c('c'), c('a'), c('z', 0.9), c('y', 0.5, new Date('2026-11-09T00:00:00Z'))].sort(byPreviewOrder);
    expect(sorted.map((x) => x.id)).toEqual(['z', 'y', 'a', 'b', 'c']);
  });

  it('matchAndNotify inserts more than one batch of matches once, then nothing on a re-run (FR-023, FR-040)', async () => {
    const org = await signup(ctx.app, { orgName: 'Batch Match Pvt Ltd' });
    const w = await request(ctx.app, 'POST', '/watchlists', { cookie: org.cookie, json: { name: 'Gyroscopes', criteria: { keywords: ['gyroscope'] } } });
    expect(w.body.matchCount).toBe(0);
    const prefix = 'GEM/2099/B/66';
    const end = new Date(ctx.clock.now().getTime() + 30 * 86_400_000);
    const values = Array.from({ length: 1100 }, (_, i) => ({
      bidNumber: `${prefix}${String(i).padStart(5, '0')}`, title: `Gyroscope assembly ${i}`, endAt: end, status: 'open' as const,
      sourceUrl: `${GEM}/bid/66${i}`, contentHash: `gyro-${i}`,
    }));
    try {
      const ids = (await ctx.db.insert(tenders).values(values).returning({ id: tenders.id })).map((r) => r.id);
      const first = await matchAndNotify(ctx.deps, ids, ctx.clock.now(), { orgId: org.me.org.id });
      expect(first.matchesCreated).toBe(1100);
      expect(first.notificationsCreated).toBeGreaterThanOrEqual(1100); // one per tender per channel for the owner
      const again = await matchAndNotify(ctx.deps, ids, ctx.clock.now(), { orgId: org.me.org.id });
      expect(again).toEqual({ matchesCreated: 0, notificationsCreated: 0 });
      const stored = (await get('/watchlists', org)).body.items[0];
      expect(stored.matchCount).toBe(1100);
    } finally {
      await ctx.db.delete(tenders).where(like(tenders.bidNumber, `${prefix}%`));
      await ctx.db.delete(notifications).where(eq(notifications.orgId, org.me.org.id));
    }
  });

  it('matchAndNotify dedupes repeated tender ids: one match, the watchlist name once in the alert', async () => {
    const org = await signup(ctx.app, { orgName: 'Dedupe Match Pvt Ltd' });
    await request(ctx.app, 'POST', '/watchlists', { cookie: org.cookie, json: { name: 'Ornithopters', criteria: { keywords: ['ornithopter'] } } });
    const bid = 'GEM/2099/B/7700001';
    try {
      const [{ id }] = await ctx.db.insert(tenders).values({
        bidNumber: bid, title: 'Ornithopter wing set', endAt: new Date(ctx.clock.now().getTime() + 30 * 86_400_000), status: 'open',
        sourceUrl: `${GEM}/bid/7700001`, contentHash: 'ornithopter-1',
      }).returning({ id: tenders.id });
      // 501 copies span two `in (…)` chunks of 500, so without the dedupe the tender row is loaded twice.
      const r = await matchAndNotify(ctx.deps, Array(501).fill(id), ctx.clock.now(), { orgId: org.me.org.id });
      expect(r.matchesCreated).toBe(1);
      const alerts = await ctx.db.select({ body: notifications.body, channel: notifications.channel }).from(notifications)
        .where(eq(notifications.orgId, org.me.org.id));
      expect(alerts.length).toBe(r.notificationsCreated);
      const inApp = alerts.find((a) => a.channel === 'in_app')!;
      expect(inApp.body.match(/Ornithopters/g)).toHaveLength(1);
    } finally {
      await ctx.db.delete(tenders).where(eq(tenders.bidNumber, bid));
      await ctx.db.delete(notifications).where(eq(notifications.orgId, org.me.org.id));
    }
  });

  it('preview tolerates a tender whose items jsonb is not an array (no 500)', async () => {
    const prefix = 'GEM/2099/B/7800';
    const end = new Date(ctx.clock.now().getTime() + 30 * 86_400_000);
    const row = (n: number, title: string) => ({
      bidNumber: `${prefix}${n}`, title, endAt: end, status: 'open' as const, sourceUrl: `${GEM}/bid/7800${n}`, contentHash: `quokka-${n}`,
    });
    try {
      await ctx.db.insert(tenders).values([row(1, 'Quokka feeder'), row(2, 'Unrelated stationery'), row(3, 'Another unrelated lot')]);
      // Title matches but items is an object; the others only reach the item scan, with an object and a scalar.
      await ctx.db.execute(sql`update tenders set items = '{"name":"quokka feeder"}'::jsonb where bid_number in (${`${prefix}1`}, ${`${prefix}2`})`);
      await ctx.db.execute(sql`update tenders set items = '"quokka"'::jsonb where bid_number = ${`${prefix}3`}`);
      const p = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: team.viewer.cookie, json: { criteria: { keywords: ['quokka'] } } });
      expect(p.status).toBe(200);
      expect(p.body.count).toBe(1);
      expect(p.body.sample[0].title).toBe('Quokka feeder');
      const cat = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: team.viewer.cookie, json: { criteria: { categories: ['quokka'] } } });
      expect(cat.status).toBe(200);
      expect(cat.body.count).toBe(1);
    } finally {
      await ctx.db.delete(tenders).where(like(tenders.bidNumber, `${prefix}%`));
    }
  });
});
