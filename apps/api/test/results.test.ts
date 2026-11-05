/**
 * 003/US6 — results refresh (T071: FR-061, FR-063, NFR-001), GET /tenders/:id/result (T072: FR-062) and
 * GET /insights/competitors (T074: FR-064, NFR-004). Runs against the in-process mock BidPlus (tools/mock-gem) through
 * deps.fetch: POST /__admin/award/<bid> moves a bid into the submitted-bids search and serves the recorded result page.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyses, bidWorkspaces, ingestionRuns, jobRuns, notifications, tenderEvents, tenderMatches, tenderResults, tenders,
} from '@tp/db';
import { GemError } from '@tp/core/gem/client';
import type { BidPlusPage } from '@tp/core/gem/parse';
import { createMockGem } from '../../../tools/mock-gem/src/app';
import { runScheduledJobs } from '../src/lib/scheduled';
import { runIngestion } from '../src/services/ingest';
import {
  RESULTS_BATCH, ResultsBusyError, refreshResults, resultAlertTitle, resultCandidates, runDailyResults,
} from '../src/services/results';
import { createTestContext, request, seedOrgWithRoles, signup, type SignedUp, type TestContext } from './helpers';

const REF = new Date('2026-11-04T04:30:00.000Z'); // 10:00 IST
const GEM = 'http://mock-gem.test';
const DAY = 86_400_000;
const L1 = 'Kaveri Systems & Services Pvt Ltd';

let ctx: TestContext;
let mock: ReturnType<typeof createMockGem>;
let team: Awaited<ReturnType<typeof seedOrgWithRoles>>;
let rival: SignedUp;
let outsider: SignedUp;
type T = typeof tenders.$inferSelect;
let A: T; let B: T; let C: T; let D: T;
let gemRequests = 0;

const admin = (path: string, body: unknown = {}) => mock.app.request(`${GEM}${path}`, { method: 'POST', body: JSON.stringify(body) });
const award = (t: T, status: 'awarded' | 'tech_evaluated' | 'fin_evaluated' = 'awarded') =>
  admin(`/__admin/award/${encodeURIComponent(t.bidNumber)}`, { status });
const resultOf = async (t: T) => (await ctx.db.select().from(tenderResults).where(eq(tenderResults.tenderId, t.id)))[0];
const tenderOf = async (t: T) => (await ctx.db.select().from(tenders).where(eq(tenders.id, t.id)))[0]!;
const resultAlerts = (orgId?: string) => ctx.db.select().from(notifications)
  .where(and(eq(notifications.kind, 'result'), orgId ? eq(notifications.orgId, orgId) : undefined));
const count = async (q: Promise<unknown[]>) => (await q).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const page = (docs: Record<string, unknown>[] = []): BidPlusPage => ({ docs: docs as BidPlusPage['docs'], numFound: docs.length, start: 0 });

beforeAll(async () => {
  let clockRef: { now(): Date } | null = null;
  mock = createMockGem({ now: () => clockRef?.now() ?? REF, token: 'r'.repeat(32) });
  ctx = await createTestContext({
    now: REF,
    gemBaseUrl: GEM,
    fetch: async (input, init) => { gemRequests++; return mock.app.fetch(new Request(input as string, init)); },
  });
  clockRef = ctx.clock;
  team = await seedOrgWithRoles(ctx.app, 'Sharma Infotech Pvt Ltd');
  const w = await request(ctx.app, 'POST', '/watchlists', { cookie: team.owner.cookie, json: { name: 'Laptops — Maharashtra', criteria: { keywords: ['laptop'], states: ['Maharashtra'] } } });
  expect(w.status).toBe(201);
  await runIngestion(ctx.deps, { trigger: 'manual', pages: 5 });
  const all = await ctx.db.select().from(tenders).orderBy(tenders.bidNumber);
  A = all.find((t) => t.bidNumber === 'GEM/2026/B/6421001')!;
  B = all.find((t) => t.bidNumber === 'GEM/2026/B/6421010')!;
  [C, D] = all.filter((t) => t !== A && t !== B && t.gemBidId).slice(0, 2) as [T, T];

  rival = await signup(ctx.app, { orgName: 'Rival Traders' });
  outsider = await signup(ctx.app, { orgName: 'Outsider Enterprises' });
  // Rival tracks C through a workspace; the team tracks D through an analysis; the outsider dismissed its match on A.
  await ctx.db.insert(bidWorkspaces).values({ orgId: rival.me.org.id, tenderId: C.id });
  await ctx.db.insert(analyses).values({ orgId: team.orgId, tenderId: D.id, status: 'done' });
  const ow = await request(ctx.app, 'POST', '/watchlists', { cookie: outsider.cookie, json: { name: 'Anything', criteria: { keywords: ['zzz-nothing'] } } });
  await ctx.db.insert(tenderMatches).values({ orgId: outsider.me.org.id, tenderId: A.id, watchlistId: ow.body.id, dismissed: true });
  // The team's viewer turned in-app alerts off.
  const prefs = await request(ctx.app, 'PUT', '/me/notification-prefs', { cookie: team.viewer.cookie, json: { inApp: false, email: false, whatsapp: false, frequency: 'instant', expiryReminders: true } });
  expect(prefs.status).toBe(200);

  // A, B and C closed two days ago (D stays open for now).
  await ctx.db.update(tenders).set({ endAt: new Date(REF.getTime() - 2 * DAY), status: 'closed' }).where(inArray(tenders.id, [A.id, B.id, C.id]));
});

afterAll(async () => { await ctx?.close(); });

describe('refreshResults (T071)', () => {
  it('scenario 3: evaluated-but-unpublished and never-evaluated bids store their status with no bidders and no alert', async () => {
    expect((await award(A, 'tech_evaluated')).status).toBe(200);
    const run = await refreshResults(ctx.deps, { trigger: 'manual' });
    expect(run).toMatchObject({ kind: 'results', trigger: 'manual', status: 'success', tendersSeen: 3, tendersUpdated: 3, tendersCreated: 0, error: null });
    expect(await resultOf(A)).toMatchObject({ evaluationStatus: 'technical_evaluated', bidders: [], error: null, sourceUrl: null });
    expect((await resultOf(A))!.fetchedAt?.toISOString()).toBe(REF.toISOString());
    expect(await resultOf(B)).toMatchObject({ evaluationStatus: 'not_evaluated', bidders: [] });
    expect(await resultOf(C)).toMatchObject({ evaluationStatus: 'not_evaluated' });
    expect(await resultOf(D)).toBeUndefined(); // still open: not a candidate
    expect((await tenderOf(A)).status).toBe('closed');
    expect(await count(resultAlerts())).toBe(0);

    const r = await request(ctx.app, 'GET', `/tenders/${A.id}/result`, { cookie: team.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      tenderId: A.id, tenderStatus: 'closed', evaluationStatus: 'technical_evaluated', evaluationLabel: 'Technical evaluated',
      bidders: [], winner: null, lowestPrice: null, anomalies: [], categories: [], sourceUrl: null,
      fetchedAt: REF.toISOString(), checkedAt: REF.toISOString(), lastCheckFailed: false,
      checkUntil: new Date(REF.getTime() + 28 * DAY).toISOString(),
    });
  });

  it('results runs are kept out of the listing sync health (GET /ingestion/runs)', async () => {
    const r = await request(ctx.app, 'GET', '/ingestion/runs', { cookie: team.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].trigger).toBe('manual'); // the listing run from beforeAll
    expect(r.body.lastRun.tendersCreated).toBeGreaterThan(30);
  });

  it('a tender checked in the last 24 h is not asked about again (no GeM request)', async () => {
    const before = gemRequests;
    const run = await refreshResults(ctx.deps);
    expect(run).toMatchObject({ status: 'success', tendersSeen: 0, pagesFetched: 0 });
    expect(gemRequests).toBe(before);
  });

  it('scenarios 1, 2, 4: an award stores the bidder table, marks the tender awarded once and alerts only tracking orgs', async () => {
    ctx.clock.advance(25 * 3_600_000);
    await award(A);
    await award(C);
    const run = await refreshResults(ctx.deps);
    expect(run).toMatchObject({ status: 'success', tendersSeen: 3, tendersUpdated: 3, tendersCreated: 2 });

    const a = (await resultOf(A))!;
    expect(a).toMatchObject({ evaluationStatus: 'awarded', error: null, categories: ['Desktop Computers (Q2)', 'Monitor (Q2)'] });
    expect(a.sourceUrl).toBe(`${GEM}/bidding/bid/getBidResultView/${A.gemBidId}`);
    expect(a.bidders.map((b) => [b.rank, b.level, b.seller, b.price])).toEqual([
      [1, 'L1', L1, 2_840_500], [2, 'L2', 'Aarav Infotech Pvt Ltd', 2_950_000], [3, 'L3', 'Northline Computers', 3_125_000], [4, 'L4', 'Deccan Office Automation LLP', 3_310_000],
    ]);
    expect((await tenderOf(A)).status).toBe('awarded');
    const events = await ctx.db.select().from(tenderEvents).where(and(eq(tenderEvents.tenderId, A.id), eq(tenderEvents.kind, 'awarded')));
    expect(events).toHaveLength(1);
    expect(events[0]!.changes).toEqual({ status: { from: 'closed', to: 'awarded' } });

    // Team: 4 members, the viewer has in-app off → 3. Rival (tracks C) → its owner. Outsider (dismissed A) → none.
    const teamAlerts = await resultAlerts(team.orgId);
    expect(teamAlerts).toHaveLength(3);
    expect(teamAlerts.every((n) => n.channel === 'in_app' && n.status === 'sent' && n.dedupeKey === `result:${A.id}:${team.orgId}` && n.link === `/tenders/${A.id}`)).toBe(true);
    expect(teamAlerts[0]!.title).toBe(`Result published: ${A.title} — L1 ${L1} at ₹28,40,500`);
    expect(teamAlerts[0]!.body).toContain('4 bidders');
    expect(teamAlerts.map((n) => n.userId)).not.toContain(team.viewer.me.user.id);
    const rivalAlerts = await resultAlerts(rival.me.org.id);
    expect(rivalAlerts.map((n) => [n.userId, n.dedupeKey])).toEqual([[rival.me.user.id, `result:${C.id}:${rival.me.org.id}`]]);
    expect(await count(resultAlerts(outsider.me.org.id))).toBe(0);
    // The bell shows it with kind `result`.
    const bell = await request(ctx.app, 'GET', '/notifications?kind=result', { cookie: team.analyst.cookie });
    expect(bell.body.items.map((n: { kind: string }) => n.kind)).toEqual(['result']);

    const r = await request(ctx.app, 'GET', `/tenders/${A.id}/result`, { cookie: rival.cookie }); // public data: any org that can see the tender
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      tenderStatus: 'awarded', evaluationStatus: 'awarded', evaluationLabel: 'Awarded', lowestPrice: 2_840_500, anomalies: [],
      winner: { rank: 1, seller: L1, price: 2_840_500, level: 'L1', awarded: true }, lastCheckFailed: false,
    });
    expect(r.body.bidders.map((b: { level: string; awarded: boolean }) => `${b.level}:${b.awarded}`)).toEqual(['L1:true', 'L2:false', 'L3:false', 'L4:false']);
  });

  it('idempotent: final results are never re-fetched, and later runs create no new events or alerts', async () => {
    const before = { alerts: await count(resultAlerts()), events: await count(ctx.db.select().from(tenderEvents).where(eq(tenderEvents.kind, 'awarded'))) };
    ctx.clock.advance(25 * 3_600_000);
    const run = await refreshResults(ctx.deps);
    expect(run).toMatchObject({ status: 'success', tendersSeen: 1, tendersCreated: 0 }); // only B (A, C are final)
    const candidates = await resultCandidates(ctx.deps, new Date(ctx.clock.now().getTime() + 2 * DAY));
    expect(candidates.map((c) => c.id)).toEqual([B.id]);
    expect(await count(resultAlerts())).toBe(before.alerts);
    expect(await count(ctx.db.select().from(tenderEvents).where(eq(tenderEvents.kind, 'awarded')))).toBe(before.events);
    // A later listing sync never downgrades `awarded`.
    expect((await tenderOf(A)).status).toBe('awarded');
  });

  it('scenario 6: an unreadable result page records the error and leaves stored status, bidders and fetchedAt untouched', async () => {
    const stored = [{ rank: 1, seller: 'Old Row Pvt Ltd', price: 1000, level: 'L1', awarded: false }];
    await ctx.db.update(tenderResults).set({ evaluationStatus: 'financial_evaluated', bidders: stored }).where(eq(tenderResults.tenderId, B.id));
    const before = (await resultOf(B))!;
    ctx.clock.advance(25 * 3_600_000);
    const client = {
      fetchSubmittedPage: async () => page([{ b_bid_number: [B.bidNumber], b_id: [B.gemBidId], b_buyer_status: [3] }]),
      fetchBidResult: async (id: string) => ({ html: '<html><body><table><tr><td>Bidder</td><td>???</td></tr></table></body></html>', url: `${GEM}/bidding/bid/getBidResultView/${id}` }),
    };
    const run = await refreshResults(ctx.deps, { client });
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/^tender 1\/1: GeM result page could not be read/);
    expect(run.error).not.toContain(B.bidNumber); // run rows carry no bid numbers
    const after = (await resultOf(B))!;
    expect(after).toMatchObject({ evaluationStatus: 'financial_evaluated', bidders: stored, sourceUrl: before.sourceUrl, fetchedAt: before.fetchedAt });
    expect(after.error).toMatch(/could not be read/);
    expect(after.checkedAt.getTime()).toBe(ctx.clock.now().getTime());
    expect((await tenderOf(B)).status).toBe('closed');
    expect(await count(resultAlerts(team.orgId))).toBe(3);
    const r = await request(ctx.app, 'GET', `/tenders/${B.id}/result`, { cookie: team.owner.cookie });
    expect(r.body).toMatchObject({ evaluationStatus: 'financial_evaluated', lastCheckFailed: true, fetchedAt: before.fetchedAt!.toISOString() });
  });

  it('NFR-001: a GeM failure is recorded on the tender and stops the run (no further requests)', async () => {
    await ctx.db.update(tenders).set({ endAt: new Date(ctx.clock.now().getTime() - DAY), status: 'closed' }).where(eq(tenders.id, D.id));
    ctx.clock.advance(25 * 3_600_000);
    let calls = 0;
    const client = {
      fetchSubmittedPage: async () => { calls++; throw new GemError('GeM listing failed: HTTP 503', 503, true); },
      fetchBidResult: async () => { calls++; return null; },
    };
    const before = (await resultOf(B))!;
    const run = await refreshResults(ctx.deps, { client });
    expect(calls).toBe(1);
    expect(run).toMatchObject({ status: 'failed', tendersSeen: 1, tendersUpdated: 0 });
    expect(run.error).toMatch(/check failed: GeM listing failed: HTTP 503/);
    // Never-checked D goes first and fails; B (checked before) is not attempted and stays exactly as it was.
    expect(await resultOf(D)).toMatchObject({ evaluationStatus: 'not_evaluated', bidders: [], fetchedAt: null, error: expect.stringContaining('HTTP 503') });
    expect(await resultOf(B)).toEqual(before);
  });

  it('every GeM request takes a cluster-wide lease slot (≤ 1 req/s across isolates)', async () => {
    ctx.clock.advance(25 * 3_600_000);
    let acquired = 0;
    const deps = { ...ctx.deps, gemLease: { acquire: async () => { acquired++; } } };
    const before = gemRequests;
    const run = await refreshResults(deps);
    expect(run.status).toBe('success');
    expect(run.tendersSeen).toBe(2); // B and D
    expect(gemRequests - before).toBeGreaterThan(0);
    expect(acquired).toBe(gemRequests - before);
    expect(run.pagesFetched).toBe(gemRequests - before);
  });
});

describe('results refresh concurrency (T071)', () => {
  it('two concurrent refreshes: one runs, the other gets ResultsBusyError; a listing sync is not blocked', async () => {
    ctx.clock.advance(25 * 3_600_000);
    const slow = { fetchSubmittedPage: async () => { await sleep(150); return page(); }, fetchBidResult: async () => null };
    const runsBefore = await count(ctx.db.select().from(ingestionRuns).where(eq(ingestionRuns.kind, 'results')));
    const [x, y, listing] = await Promise.allSettled([
      refreshResults(ctx.deps, { client: slow }),
      sleep(20).then(() => refreshResults(ctx.deps, { client: slow })),
      sleep(40).then(() => runIngestion(ctx.deps, { trigger: 'manual', pages: 1 })),
    ]);
    const outcomes = [x, y].map((r) => (r.status === 'fulfilled' ? r.value.status : (r.reason as Error).name));
    expect(outcomes.sort()).toEqual(['ResultsBusyError', 'success']);
    expect(listing.status === 'fulfilled' && listing.value.status).toBe('success');
    expect(await count(ctx.db.select().from(ingestionRuns).where(eq(ingestionRuns.kind, 'results')))).toBe(runsBefore + 1);
    expect(await count(ctx.db.select().from(ingestionRuns).where(eq(ingestionRuns.status, 'running')))).toBe(0);
  });

  it('the database allows one running run per kind (listing and results side by side)', async () => {
    await ctx.db.insert(ingestionRuns).values({ kind: 'results', trigger: 'cron', status: 'running', startedAt: ctx.clock.now() });
    await ctx.db.insert(ingestionRuns).values({ kind: 'listing', trigger: 'cron', status: 'running', startedAt: ctx.clock.now() });
    await expect(ctx.db.insert(ingestionRuns).values({ kind: 'results', trigger: 'manual', status: 'running' })).rejects.toThrow();
    await expect(refreshResults(ctx.deps)).rejects.toBeInstanceOf(ResultsBusyError);
    // A run older than the lock window is reaped by the next start.
    ctx.clock.advance(16 * 60_000);
    const run = await refreshResults(ctx.deps, { client: { fetchSubmittedPage: async () => page(), fetchBidResult: async () => null } });
    expect(run.status).toBe('success');
    const reaped = await ctx.db.select().from(ingestionRuns).where(and(eq(ingestionRuns.kind, 'results'), eq(ingestionRuns.error, 'Timed out (worker stopped)')));
    expect(reaped).toHaveLength(1);
    await ctx.db.delete(ingestionRuns).where(eq(ingestionRuns.status, 'running'));
  });

  it('runDailyResults: not before 10:00 IST, once per IST day, and a failed run releases the day for the next tick', async () => {
    const at = (iso: string) => ({ ...ctx.deps, clock: { now: () => new Date(iso) } });
    expect(await runDailyResults(at('2026-11-12T04:29:00.000Z'))).toEqual({ ran: false, day: '2026-11-12', reason: 'before_window' }); // 09:59 IST
    const first = await runDailyResults(at('2026-11-12T04:31:00.000Z'));
    expect(first).toMatchObject({ ran: true, day: '2026-11-12', run: { kind: 'results', trigger: 'cron' } });
    expect(await runDailyResults(at('2026-11-12T09:00:00.000Z'))).toEqual({ ran: false, day: '2026-11-12', reason: 'already_ran' });
    const [claim] = await ctx.db.select().from(jobRuns).where(and(eq(jobRuns.job, 'results'), eq(jobRuns.day, '2026-11-12')));
    expect(claim!.finishedAt).not.toBeNull();

    // GeM down: the run fails, the claim is released.
    await ctx.db.update(tenderResults).set({ checkedAt: new Date('2026-11-01T00:00:00.000Z') });
    const down = { ...at('2026-11-13T05:00:00.000Z'), fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch };
    const failed = await runDailyResults(down);
    expect(failed).toMatchObject({ ran: true, run: { status: 'failed' } });
    expect(await count(ctx.db.select().from(jobRuns).where(and(eq(jobRuns.job, 'results'), eq(jobRuns.day, '2026-11-13'))))).toBe(0);
  });

  it('is a step of the scheduled pipeline', async () => {
    const report = await runScheduledJobs({ ...ctx.deps, clock: { now: () => new Date('2026-11-14T06:00:00.000Z') } }, { trigger: 'cron' });
    expect(report.find((s) => s.step === 'results')).toMatchObject({ ok: true });
    expect(await count(ctx.db.select().from(jobRuns).where(and(eq(jobRuns.job, 'results'), eq(jobRuns.day, '2026-11-14'))))).toBe(1);
  });
});

describe('GET /tenders/:id/result (T072)', () => {
  it('never checked → not_evaluated, no bidders, checkedAt null; unknown or bad ids → 404; auth required', async () => {
    const [open] = await ctx.db.select().from(tenders).where(and(eq(tenders.status, 'open'), sql`${tenders.id} not in (${A.id}, ${B.id}, ${C.id}, ${D.id})`)).limit(1);
    const r = await request(ctx.app, 'GET', `/tenders/${open!.id}/result`, { cookie: outsider.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tenderId: open!.id, evaluationStatus: 'not_evaluated', evaluationLabel: 'Not evaluated', bidders: [], checkedAt: null, fetchedAt: null, lastCheckFailed: false });
    expect((await request(ctx.app, 'GET', `/tenders/${crypto.randomUUID()}/result`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await request(ctx.app, 'GET', '/tenders/not-a-uuid/result', { cookie: outsider.cookie })).status).toBe(404);
    expect((await request(ctx.app, 'GET', `/tenders/${A.id}/result`)).status).toBe(401);
  });

  it('flags "winner is not the lowest price" when GeM marks a higher bidder as awarded', async () => {
    await ctx.db.update(tenderResults).set({
      evaluationStatus: 'awarded',
      bidders: [
        { rank: 1, seller: 'Cheapest Co', price: 900_000, level: 'L1', awarded: false },
        { rank: 2, seller: 'Northline Computers', price: 1_000_000, level: 'L2', awarded: true },
      ],
      categories: ['Laser Printers'],
    }).where(eq(tenderResults.tenderId, D.id));
    const r = await request(ctx.app, 'GET', `/tenders/${D.id}/result`, { cookie: team.owner.cookie });
    expect(r.body).toMatchObject({
      winner: { seller: 'Northline Computers', price: 1_000_000, level: 'L2', awarded: true }, lowestPrice: 900_000,
      anomalies: [{ code: 'winner_not_lowest_price', message: 'Winner is not the lowest price' }],
    });
  });
});

describe('GET /insights/competitors (T074)', () => {
  const get = (who: SignedUp, qs = '') => request(ctx.app, 'GET', `/insights/competitors${qs}`, { cookie: who.cookie });

  it('aggregates the org’s tracked awarded tenders only: wins, awarded value, bids, categories, anomalies', async () => {
    const r = await get(team.viewer);
    expect(r.status).toBe(200);
    // Team tracks A (L1 Kaveri wins, 4 bidders) and D (Northline wins over a cheaper bid, flagged). B is not awarded.
    expect(r.body).toMatchObject({ total: 5, tenders: 2, flaggedAwards: 1 });
    expect(r.body.items.map((i: { seller: string; wins: number }) => [i.seller, i.wins])).toEqual([
      [L1, 1], ['Northline Computers', 1], ['Aarav Infotech Pvt Ltd', 0], ['Cheapest Co', 0], ['Deccan Office Automation LLP', 0],
    ]); // equal wins → higher awarded value first
    const northline = r.body.items[1];
    expect(northline).toMatchObject({ awardedValue: 1_000_000, bids: 2, anomalies: 1 });
    expect(northline.categories).toEqual(expect.arrayContaining(['Laser Printers', 'Desktop Computers (Q2)']));
    expect(northline.lastWinAt).toBe((await tenderOf(D)).endAt!.toISOString());
    expect(r.body.items[0]).toMatchObject({ seller: L1, awardedValue: 2_840_500, bids: 1, anomalies: 0 });
    expect(r.body.facets.states).toContain('Maharashtra');
    expect(r.body.facets.categories).toEqual(expect.arrayContaining(['Desktop Computers (Q2)', 'Monitor (Q2)', 'Laser Printers']));
  });

  it('NFR-004: another org sees only its own tracked tenders; an org tracking nothing (or only dismissed) sees nothing', async () => {
    const rv = await get(rival);
    expect(rv.body).toMatchObject({ tenders: 1, flaggedAwards: 0, total: 4 }); // C only
    expect(rv.body.items[0]).toMatchObject({ seller: L1, wins: 1, awardedValue: 2_840_500 });
    expect(rv.body.items.map((i: { seller: string }) => i.seller)).not.toContain('Cheapest Co');
    const out = await get(outsider);
    expect(out.body).toEqual({ items: [], total: 0, tenders: 0, flaggedAwards: 0, facets: { categories: [], states: [] } });
  });

  it('filters by buyer state and category (case-insensitive) and pages', async () => {
    expect((await get(team.owner, '?state=maharashtra')).body.tenders).toBe(A.state === D.state ? 2 : 1);
    expect((await get(team.owner, '?state=Atlantis')).body).toMatchObject({ tenders: 0, total: 0, items: [] });
    const printers = await get(team.owner, '?category=laser%20printers');
    expect(printers.body).toMatchObject({ tenders: 1, total: 2, flaggedAwards: 1 });
    expect((await get(team.owner, '?category=Desktop%20Computers%20(Q2)')).body).toMatchObject({ tenders: 1, total: 4 });
    const p2 = await get(team.owner, '?page=2&pageSize=2');
    expect(p2.body.items.map((i: { seller: string }) => i.seller)).toEqual(['Aarav Infotech Pvt Ltd', 'Cheapest Co']);
    expect(p2.body.total).toBe(5);
    expect((await get(team.owner, '?pageSize=500')).status).toBe(400);
    expect((await request(ctx.app, 'GET', '/insights/competitors')).status).toBe(401);
  });
});

describe('candidate selection (T071, FR-061)', () => {
  it('≤ 50 tracked real tenders closed within 30 days, unchecked or older than 24 h; never untracked, dismissed-only, cancelled, demo or long-closed', async () => {
    const now = ctx.clock.now();
    const mk = (n: number, extra: Partial<typeof tenders.$inferInsert> = {}) => Array.from({ length: n }, (_, i) => ({
      bidNumber: `GEM/2026/B/99${String(i).padStart(5, '0')}${extra.title ?? ''}`.slice(0, 40), title: `Synthetic ${extra.title ?? ''} ${i}`, sourceUrl: 'https://bidplus.gem.gov.in/x',
      contentHash: `h-${extra.title ?? ''}-${i}`, status: 'closed' as const, endAt: new Date(now.getTime() - 3 * DAY), ...extra,
    }));
    const tracked = await ctx.db.insert(tenders).values(mk(55, { title: 'T' })).returning();
    const [old] = await ctx.db.insert(tenders).values(mk(1, { title: 'old', endAt: new Date(now.getTime() - 31 * DAY) })).returning();
    const [untracked] = await ctx.db.insert(tenders).values(mk(1, { title: 'untracked' })).returning();
    const [cancelled] = await ctx.db.insert(tenders).values(mk(1, { title: 'cancelled', status: 'cancelled' })).returning();
    const [demo] = await ctx.db.insert(tenders).values(mk(1, { title: 'demo', source: 'demo' })).returning();
    const [dismissed] = await ctx.db.insert(tenders).values(mk(1, { title: 'dismissed' })).returning();
    for (const t of [...tracked, old!, cancelled!, demo!]) await ctx.db.insert(analyses).values({ orgId: team.orgId, tenderId: t.id });
    const [wl] = await ctx.db.select({ id: tenderMatches.watchlistId }).from(tenderMatches).where(eq(tenderMatches.orgId, outsider.me.org.id)).limit(1);
    await ctx.db.insert(tenderMatches).values({ orgId: outsider.me.org.id, tenderId: dismissed!.id, watchlistId: wl!.id, dismissed: true });

    const c = await resultCandidates(ctx.deps, now);
    expect(c).toHaveLength(RESULTS_BATCH);
    const ids = new Set(c.map((x) => x.id));
    for (const t of [old!, untracked!, cancelled!, demo!, dismissed!]) expect(ids.has(t.id)).toBe(false);
    // Never-checked tenders come first.
    expect(c.every((x) => x.prevStatus === null)).toBe(true);
  });

  it('alert titles keep the L1 part within 200 characters', () => {
    const t = resultAlertTitle('Supply of '.repeat(40), { rank: 1, seller: L1, price: 2_840_500, level: 'L1', awarded: true });
    expect(t.length).toBeLessThanOrEqual(200);
    expect(t.startsWith('Result published: Supply of')).toBe(true);
    expect(t.endsWith(`— L1 ${L1} at ₹28,40,500`)).toBe(true);
  });
});
