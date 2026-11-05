/**
 * T038 — Identify routes: tender feed filters/facets/sort/pagination, detail, seen/dismiss, watchlists CRUD +
 * preview + roles, ingestion run/runs roles, notifications, and org isolation.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyses, bidWorkspaces, tenders } from '@tp/db';
import { createMockGem } from '../../../tools/mock-gem/src/app';
import { runIngestion } from '../src/services/ingest';
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
  it('rejects a manual sync within 2 min of a finished manual run with 429 sync_cooldown and retryAt', async () => {
    const [last] = (await get('/ingestion/runs', team.viewer)).body.items;
    expect(last).toMatchObject({ trigger: 'manual', status: 'success' });
    const retryAt = new Date(Date.parse(last.finishedAt) + 2 * 60_000);
    ctx.clock.set(new Date(retryAt.getTime() - 1_000));
    const r = await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.bidManager.cookie, json: {} });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatchObject({ code: 'sync_cooldown', details: { retryAt: retryAt.toISOString() } });
    const ist = retryAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
    expect(r.body.error.message).toBe(`GeM was synced moments ago. Next manual sync at ${ist} IST.`);
    // Nothing was started.
    expect((await get('/ingestion/runs', team.viewer)).body.items).toHaveLength(2);
    // Role checks still come first.
    expect((await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.analyst.cookie, json: {} })).status).toBe(403);
    // A scheduled run does not start a manual cooldown, and does not extend it.
    ctx.clock.set(retryAt);
    const cron = await runIngestion(ctx.deps, { trigger: 'cron', pages: 1 });
    expect(cron.status).toBe('success');
    const ok = await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.bidManager.cookie, json: { pages: 1 } });
    expect(ok.status).toBe(200);
    expect(ok.body.trigger).toBe('manual');
    // …but this finished manual run does — across orgs (GeM is shared by every tenant).
    const rival = await request(ctx.app, 'POST', '/ingestion/run', { cookie: other.cookie, json: {} });
    expect(rival.status).toBe(429);
    expect(rival.body.error.code).toBe('sync_cooldown');
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
