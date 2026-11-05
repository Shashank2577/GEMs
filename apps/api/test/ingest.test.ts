/**
 * T038 — ingestion idempotency, corrigenda, matching → notifications, dispatch & digests, failure modes.
 * Runs against the in-process mock BidPlus (tools/mock-gem) through deps.fetch.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyses, ingestionRuns, notificationPrefs, notifications, tenderEvents, tenderMatches, tenders, users, watchlists } from '@tp/db';
import { toGemSolrDate } from '@tp/core/gem/normalize';
import { createMockGem } from '../../../tools/mock-gem/src/app';
import { createResendMailer } from '../src/adapters/mailer';
import { isTransientSendError, isTransientStatus, PROVIDER_TIMEOUT_MS, ProviderError } from '../src/adapters/provider-error';
import { createMetaWhatsApp } from '../src/adapters/whatsapp';
import { CLAIM_LEASE_MS, DISPATCH_BATCH, dispatchNotifications } from '../src/services/alerts';
import type { AppDeps } from '../src/deps';
import { IngestionBusyError, planPages, runIngestion } from '../src/services/ingest';
import { createTestContext, request, seedOrgWithRoles, signup, type TestContext } from './helpers';

const REF = new Date('2026-11-04T04:30:00.000Z'); // fixture reference = 10:00 IST
const GEM = 'http://mock-gem.test';

let ctx: TestContext;
let mock: ReturnType<typeof createMockGem>;
let team: Awaited<ReturnType<typeof seedOrgWithRoles>>;

const count = async (table: typeof tenders | typeof tenderMatches | typeof tenderEvents | typeof notifications, where?: ReturnType<typeof eq>) => {
  const [r] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
  return Number(r.n);
};
const admin = (path: string, body: unknown = {}) => mock.app.request(`${GEM}${path}`, { method: 'POST', body: JSON.stringify(body) });

beforeAll(async () => {
  let clockRef: { now(): Date } | null = null;
  mock = createMockGem({ now: () => clockRef?.now() ?? REF, token: 'a'.repeat(32) });
  ctx = await createTestContext({
    now: REF,
    gemBaseUrl: GEM,
    fetch: async (input, init) => mock.app.fetch(new Request(input as string, init)),
  });
  clockRef = ctx.clock;
  team = await seedOrgWithRoles(ctx.app, 'Sharma Infotech Pvt Ltd');
  // Owner watches laptops in Maharashtra.
  const w = await request(ctx.app, 'POST', '/watchlists', { cookie: team.owner.cookie, json: { name: 'Laptops — Maharashtra', criteria: { keywords: ['laptop'], states: ['Maharashtra'] } } });
  expect(w.status).toBe(201);
  expect(w.body.matchCount).toBe(0); // nothing ingested yet
});

afterAll(async () => { await ctx?.close(); });

describe('runIngestion', () => {
  it('ingests all fixture pages, records events and a successful run', async () => {
    const run = await runIngestion(ctx.deps, { trigger: 'manual', pages: 5 });
    expect(run).toMatchObject({ status: 'success', pagesFetched: 4, tendersSeen: 36, tendersCreated: 36, tendersUpdated: 0, error: null });
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(await count(tenders)).toBe(36);
    expect(await count(tenderEvents, eq(tenderEvents.kind, 'created'))).toBe(36);
    const [t] = await ctx.db.select().from(tenders).where(eq(tenders.bidNumber, 'GEM/2026/B/6421001'));
    expect(t).toMatchObject({ state: 'Maharashtra', emdAmount: 240_000, estimatedValue: 9_600_000, sourceUrl: `${GEM}/showbidDocument/7421001` });
    expect(t.fetchedAt.toISOString()).toBe(REF.toISOString());
  });

  it('acceptance #1: matched the laptop/Maharashtra watchlist with reasons and notified every member', async () => {
    const matches = await ctx.db.select({ bid: tenders.bidNumber, reasons: tenderMatches.reasons }).from(tenderMatches)
      .innerJoin(tenders, eq(tenders.id, tenderMatches.tenderId)).orderBy(tenders.bidNumber);
    expect(matches).toEqual([
      { bid: 'GEM/2026/B/6421001', reasons: ['Keyword “laptop”', 'State: Maharashtra'] },
      { bid: 'GEM/2026/B/6421010', reasons: ['Keyword “laptop”', 'State: Maharashtra'] },
    ]);
    // 4 members × 2 tenders in-app (sent) + email (pending)
    expect(await count(notifications, and(eq(notifications.channel, 'in_app'), eq(notifications.status, 'sent'))!)).toBe(8);
    expect(await count(notifications, and(eq(notifications.channel, 'email'), eq(notifications.status, 'pending'))!)).toBe(8);
  });

  it('acceptance #2: a second run creates no duplicate tenders, matches or alerts', async () => {
    const before = { n: await count(notifications), m: await count(tenderMatches), e: await count(tenderEvents) };
    ctx.clock.advance(30 * 60_000);
    const run = await runIngestion(ctx.deps, { trigger: 'cron', pages: 5 });
    expect(run).toMatchObject({ status: 'success', tendersSeen: 36, tendersCreated: 0, tendersUpdated: 0, matchesCreated: 0 });
    expect(await count(tenders)).toBe(36);
    expect(await count(notifications)).toBe(before.n);
    expect(await count(tenderMatches)).toBe(before.m);
    expect(await count(tenderEvents)).toBe(before.e);
    const [t] = await ctx.db.select().from(tenders).where(eq(tenders.bidNumber, 'GEM/2026/B/6421001'));
    expect(t.fetchedAt.getTime()).toBe(ctx.clock.now().getTime());
  });

  it('acceptance #3: dispatches email (status recorded) and WhatsApp per preference', async () => {
    // Analyst opts into WhatsApp with a phone; viewer opts into WhatsApp without one.
    await ctx.db.update(users).set({ phone: '+919812345678' }).where(eq(users.email, team.analyst.email));
    const r = await request(ctx.app, 'PUT', '/me/notification-prefs', { cookie: team.analyst.cookie, json: { inApp: true, email: true, whatsapp: true, frequency: 'instant', expiryReminders: true } });
    expect(r.status).toBe(200);
    // (The prefs API requires a phone for WhatsApp; simulate a number removed later.)
    await ctx.db.update(notificationPrefs).set({ whatsapp: true }).where(eq(notificationPrefs.userId, team.viewer.me.user.id));
    // A configured mailer for this test.
    const sentMail: { to: unknown; subject: string; html?: string }[] = [];
    const origMailer = ctx.deps.mailer;
    ctx.deps.mailer = { configured: true, send: async (m) => { sentMail.push(m); return { id: `msg_${sentMail.length}` }; } };
    try {
      await admin('/__admin/publish', { count: 1 }); // GEM/2026/B/6421101 — laptops, Mumbai
      ctx.clock.advance(30 * 60_000);
      const run = await runIngestion(ctx.deps, { trigger: 'cron', pages: 5 });
      expect(run).toMatchObject({ tendersCreated: 1, matchesCreated: 1 });
      const pendingWa = await ctx.db.select().from(notifications).where(eq(notifications.channel, 'whatsapp'));
      expect(pendingWa.map((n) => n.status).sort()).toEqual(['pending', 'skipped']);
      expect(pendingWa.find((n) => n.status === 'skipped')?.error).toMatch(/mobile number/);

      const report = await dispatchNotifications(ctx.deps);
      expect(report.failed).toBe(0);
      expect(report.sent).toBe(12); // 8 earlier emails + 4 new emails
      expect(report.skipped).toBe(1); // WhatsApp adapter not configured in tests
      expect(sentMail).toHaveLength(12);
      const mail = sentMail.find((m) => m.html?.includes('GEM/2026/B/6421101'))!;
      expect(mail.subject).toContain('Laptop');
      expect(mail.html).toContain('GEM/2026/B/6421101');
      expect(mail.html).toContain('Review &amp; score this bid');
      expect(mail.html).toContain('IST');
      const wa = await ctx.db.select().from(notifications).where(and(eq(notifications.channel, 'whatsapp'), eq(notifications.userId, team.analyst.me.user.id)));
      expect(wa[0]).toMatchObject({ status: 'skipped', error: expect.stringMatching(/WhatsApp is not configured/) });
      expect((ctx.whatsapp as unknown as { sent: { to: string; template?: { name: string; params?: string[] } }[] }).sent.at(-1)).toMatchObject({
        to: '+919812345678', template: { name: 'tender_alert', params: expect.arrayContaining(['GEM/2026/B/6421101']) },
      });
      // Delivery status is visible on the in-app notification.
      const list = await request(ctx.app, 'GET', '/notifications', { cookie: team.analyst.cookie });
      const n = list.body.items.find((i: { title: string }) => i.title.includes('Laptop'));
      expect(n.deliveries).toEqual(expect.arrayContaining([
        expect.objectContaining({ channel: 'email', status: 'sent' }),
        expect.objectContaining({ channel: 'whatsapp', status: 'skipped' }),
      ]));
      // Nothing left pending; a second dispatch is a no-op.
      expect(await dispatchNotifications(ctx.deps)).toMatchObject({ sent: 0, skipped: 0, failed: 0 });
    } finally {
      ctx.deps.mailer = origMailer;
    }
  });

  it('records provider failures as failed with the error', async () => {
    await ctx.db.insert(notifications).values({
      orgId: team.orgId, userId: team.owner.me.user.id, channel: 'email', kind: 'system', title: 'Test', body: 'x', status: 'pending', dedupeKey: 'fail-test',
    });
    const orig = ctx.deps.mailer;
    ctx.deps.mailer = { configured: true, send: async () => { throw new Error('Resend error 422: invalid from'); } };
    try {
      expect(await dispatchNotifications(ctx.deps)).toMatchObject({ failed: 1 });
    } finally { ctx.deps.mailer = orig; }
    const [n] = await ctx.db.select().from(notifications).where(eq(notifications.dedupeKey, 'fail-test'));
    expect(n).toMatchObject({ status: 'failed', error: 'Resend error 422: invalid from' });
  });

  it('acceptance #4: a corrigendum updates the end date, records history and marks analyses stale', async () => {
    const [t] = await ctx.db.select().from(tenders).where(eq(tenders.bidNumber, 'GEM/2026/B/6421001'));
    await ctx.db.insert(analyses).values({ orgId: team.orgId, tenderId: t.id, status: 'done', score: 72, verdict: 'go' });
    const r = await admin(`/__admin/corrigendum/${encodeURIComponent('GEM/2026/B/6421001')}`, { days: 7 });
    expect(r.status).toBe(200);
    ctx.clock.advance(30 * 60_000);
    const run = await runIngestion(ctx.deps, { trigger: 'cron', pages: 5 });
    expect(run).toMatchObject({ tendersUpdated: 1, tendersCreated: 0 });
    const [after] = await ctx.db.select().from(tenders).where(eq(tenders.id, t.id));
    expect(after.endAt!.getTime() - t.endAt!.getTime()).toBe(7 * 86_400_000);
    const events = await ctx.db.select().from(tenderEvents).where(and(eq(tenderEvents.tenderId, t.id), eq(tenderEvents.kind, 'corrigendum')));
    expect(events).toHaveLength(1);
    expect(events[0].changes).toEqual({ endAt: { from: t.endAt!.toISOString(), to: after.endAt!.toISOString() } });
    const [a] = await ctx.db.select().from(analyses).where(eq(analyses.tenderId, t.id));
    expect(a.stale).toBe(true);
    // Members who track it get an in-app heads-up; the match itself is not duplicated.
    expect(await count(notifications, and(eq(notifications.kind, 'deadline'), eq(notifications.orgId, team.orgId))!)).toBe(4);
    expect(await count(tenderMatches, eq(tenderMatches.tenderId, t.id))).toBe(1);
    // Detail API shows the history.
    const d = await request(ctx.app, 'GET', `/tenders/${t.id}`, { cookie: team.analyst.cookie });
    expect(d.body.events[0]).toMatchObject({ kind: 'corrigendum' });
    expect(d.body.hasCorrigendum).toBe(true);
    expect(d.body.analysis).toMatchObject({ stale: true, verdict: 'go' });
  });

  it('GeM down → run failed with error, nothing lost; HTML → failed too', async () => {
    const before = await count(tenders);
    await admin('/__admin/fail', { mode: 'down' });
    const fast = { ...ctx.deps, gem: { ...ctx.deps.gem, minIntervalMs: 0 } };
    ctx.clock.advance(60_000);
    const run = await runIngestion(fast, { trigger: 'cron', pages: 2 });
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/HTTP 503|unreachable/);
    expect(await count(tenders)).toBe(before);
    await admin('/__admin/fail', { mode: 'html' });
    ctx.clock.advance(60_000);
    const run2 = await runIngestion(fast, { trigger: 'cron', pages: 2 });
    expect(run2.status).toBe('failed');
    expect(run2.error).toMatch(/HTML/);
    await admin('/__admin/fail', { mode: 'off' });
    const runs = await request(ctx.app, 'GET', '/ingestion/runs', { cookie: team.viewer.cookie });
    expect(runs.status).toBe(200);
    expect(runs.body.lastRun.status).toBe('failed');
    expect(runs.body.lastSuccessAt).not.toBeNull();
    expect(runs.body.totalTenders).toBe(37);
  });

  it('is single-flight: a fresh running run blocks another (409 via API)', async () => {
    const [r] = await ctx.db.insert(ingestionRuns).values({ trigger: 'cron', status: 'running', startedAt: ctx.clock.now() }).returning();
    await expect(runIngestion(ctx.deps, { pages: 1 })).rejects.toBeInstanceOf(IngestionBusyError);
    const res = await request(ctx.app, 'POST', '/ingestion/run', { cookie: team.bidManager.cookie, json: { pages: 1 } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ingestion_running');
    // A stale lock (> 15 min) is reaped.
    ctx.clock.advance(16 * 60_000);
    const ok = await runIngestion(ctx.deps, { pages: 1 });
    expect(ok.status).toBe('success');
    const [reaped] = await ctx.db.select().from(ingestionRuns).where(eq(ingestionRuns.id, r.id));
    expect(reaped.status).toBe('failed');
  });

  it('daily digest: held before 08:00 IST, one digest email after, never twice a day', async () => {
    const daily = await signup(ctx.app, { role: 'analyst', ownerCookie: team.owner.cookie, name: 'Daily Digest' });
    await ctx.db.update(notificationPrefs).set({ frequency: 'daily', email: true }).where(eq(notificationPrefs.userId, daily.me.user.id));
    // 06:00 IST next day
    ctx.clock.set(new Date('2026-11-05T00:30:00.000Z'));
    const w = await request(ctx.app, 'POST', '/watchlists', { cookie: team.owner.cookie, json: { name: 'CCTV anywhere', criteria: { keywords: ['cctv'] } } });
    expect(w.body.matchCount).toBe(2); // silently back-filled from existing tenders
    const pub = await (await admin('/__admin/publish', { count: 1 })).json() as { published: string[] };
    expect(pub.published).toEqual(['GEM/2026/B/6421102']); // CCTV, Nagpur
    const run = await runIngestion(ctx.deps, { trigger: 'cron', pages: 5 });
    expect(run).toMatchObject({ status: 'success', tendersCreated: 1, matchesCreated: 1 });
    const mine = await ctx.db.select().from(notifications).where(and(eq(notifications.userId, daily.me.user.id), eq(notifications.channel, 'email')));
    expect(mine.length).toBeGreaterThanOrEqual(1);

    const held = await dispatchNotifications(ctx.deps);
    expect(held.held).toBe(mine.length);
    // Held until today's 08:00 IST, not re-claimed on every run before that.
    for (const n of await ctx.db.select().from(notifications).where(and(eq(notifications.userId, daily.me.user.id), eq(notifications.channel, 'email')))) {
      expect(n).toMatchObject({ status: 'pending', nextAttemptAt: new Date('2026-11-05T02:30:00.000Z') });
    }
    expect((await dispatchNotifications(ctx.deps)).held).toBe(0);
    ctx.clock.set(new Date('2026-11-05T03:30:00.000Z')); // 09:00 IST
    const sent = await dispatchNotifications(ctx.deps);
    expect(sent.digests).toBe(1);
    const digest = ctx.mailer.sent.find((m) => m.subject.startsWith('Daily digest') && m.to === daily.email);
    expect(digest?.subject).toMatch(/new GeM tenders? matched today/);
    expect(await count(notifications, and(eq(notifications.userId, daily.me.user.id), eq(notifications.status, 'pending'))!)).toBe(0);
    // Same day: no second digest — a match queued after today's digest waits for tomorrow's 08:00 IST.
    expect((await dispatchNotifications(ctx.deps)).digests).toBe(0);
    const [late] = await ctx.db.insert(notifications).values({
      orgId: team.orgId, userId: daily.me.user.id, channel: 'email', kind: 'tender_match', title: 'Late match', body: 'x', status: 'pending',
    }).returning();
    const again = await dispatchNotifications(ctx.deps);
    expect(again).toMatchObject({ digests: 0, held: 1 });
    expect((await ctx.db.select().from(notifications).where(eq(notifications.id, late.id)))[0])
      .toMatchObject({ status: 'pending', nextAttemptAt: new Date('2026-11-06T02:30:00.000Z') });
  });
});

// ───────────── US1 gaps: incremental/catch-up paging, keyword search pass, format drift ─────────────

type Captured = { path: string; searchBid: string | null; page: number | null; at: number };
/** deps copy whose fetch records every GeM request (payload search + page) before forwarding to mock-gem. */
function recordingDeps(over: Partial<typeof ctx.deps.gem> = {}, fail?: (c: Captured) => boolean) {
  const calls: Captured[] = [];
  const deps = {
    ...ctx.deps,
    gem: { ...ctx.deps.gem, ...over },
    fetch: (async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      let searchBid: string | null = null;
      let page: number | null = null;
      if (path === '/all-bids-data' && typeof init?.body === 'string') {
        const payload = JSON.parse(new URLSearchParams(init.body).get('payload') ?? '{}');
        searchBid = payload.param?.searchBid ?? '';
        page = payload.page ?? null;
      }
      const call = { path, searchBid, page, at: Date.now() };
      calls.push(call);
      if (fail?.(call)) return new Response('Service Unavailable', { status: 503 });
      return mock.app.fetch(new Request(input, init));
    }) as typeof fetch,
  };
  const listing = () => calls.filter((c) => c.path === '/all-bids-data' && c.searchBid === '');
  const searches = () => calls.filter((c) => c.path === '/all-bids-data' && c.searchBid !== '').map((c) => c.searchBid!);
  return { deps, calls, listing, searches };
}

describe('incremental paging & catch-up (FR-011)', () => {
  it('after a > 2 h gap, pages past the normal cap until a page of known, unchanged bids', async () => {
    ctx.clock.advance(3 * 3_600_000);
    const pub = await (await admin('/__admin/publish', { count: 3 })).json() as { published: string[] };
    expect(pub.published).toHaveLength(3);
    const before = await count(tenders);
    const r = recordingDeps({ maxPages: 1 }); // normal cap 1 page — catch-up must override it
    const run = await runIngestion(r.deps, { trigger: 'manual' });
    // page 1: 3 new + 7 known; page 2: all known and unchanged → stop.
    expect(run).toMatchObject({ status: 'success', pagesFetched: 2, tendersCreated: 3, tendersUpdated: 0 });
    expect(r.listing().map((c) => c.page)).toEqual([1, 2]);
    expect(await count(tenders)).toBe(before + 3);
    for (const bid of pub.published) expect(await count(tenders, eq(tenders.bidNumber, bid))).toBe(1);
  });

  it('within 2 h keeps to the normal cap; a run that used up its cap makes the next one resume as catch-up', async () => {
    ctx.clock.advance(30 * 60_000);
    await admin('/__admin/publish', { count: 12 }); // 10 on page 1, 2 on page 2
    const capped = recordingDeps({ maxPages: 1 });
    const run = await runIngestion(capped.deps, { trigger: 'manual' });
    expect(run).toMatchObject({ status: 'success', pagesFetched: 1, tendersCreated: 10, listingStop: 'cap' });
    expect(capped.listing()).toHaveLength(1);
    // Cap 1 again, but the last run hit its cap without an all-known page → catch-up that resumes past page 1:
    // page 1 (known) doesn't stop it, page 2 has the 2 left over, page 3 is all known → stop.
    ctx.clock.advance(30 * 60_000);
    expect(await planPages(ctx.deps, {}, ctx.clock.now())).toMatchObject({ catchUp: true, maxPages: 20, noStopBefore: 2 });
    const r = recordingDeps({ maxPages: 1 });
    const next = await runIngestion(r.deps, { trigger: 'manual' });
    expect(next).toMatchObject({ status: 'success', pagesFetched: 3, tendersCreated: 2, tendersUpdated: 0, listingStop: 'all_known' });
    expect(r.listing().map((c) => c.page)).toEqual([1, 2, 3]);
    // Nothing new → page 1 is all known → stop there, even with cap 5.
    ctx.clock.advance(30 * 60_000);
    const quiet = recordingDeps({ maxPages: 5 });
    const idle = await runIngestion(quiet.deps, { trigger: 'manual' });
    expect(idle).toMatchObject({ status: 'success', pagesFetched: 1, tendersSeen: 10, tendersCreated: 0, listingStop: 'all_known' });
    expect(await planPages(ctx.deps, {}, ctx.clock.now())).toMatchObject({ catchUp: false, maxPages: 5, noStopBefore: 1 });
  });

  it('an explicit page count is honoured in full (no early stop)', async () => {
    ctx.clock.advance(30 * 60_000);
    const r = recordingDeps({ maxPages: 1 });
    const full = await runIngestion(r.deps, { trigger: 'manual', pages: 3 });
    expect(full).toMatchObject({ status: 'success', pagesFetched: 3, tendersSeen: 30, tendersCreated: 0, listingStop: 'explicit' });
    expect(r.listing().map((c) => c.page)).toEqual([1, 2, 3]);
    const runs = await request(ctx.app, 'GET', '/ingestion/runs', { cookie: team.viewer.cookie });
    expect(runs.body.lastRun).toMatchObject({ pagesFetched: 3 });
  });

  it('a catch-up run that ends partial (listing failed) does not cancel the next catch-up', async () => {
    ctx.clock.advance(3 * 3_600_000);
    await admin('/__admin/publish', { count: 3 });
    const flaky = recordingDeps({ maxPages: 5 }, (c) => c.path === '/all-bids-data' && c.page === 2);
    const partial = await runIngestion(flaky.deps, { trigger: 'manual' });
    expect(partial).toMatchObject({ status: 'partial', pagesFetched: 1, tendersCreated: 3, listingStop: 'error' });
    expect(partial.error).toMatch(/^page 2: /);
    // Still catch-up: the last *clean* listing is > 2 h old.
    ctx.clock.advance(60_000);
    expect(await planPages(ctx.deps, {}, ctx.clock.now())).toMatchObject({ catchUp: true, maxPages: 20 });
    const r = recordingDeps({ maxPages: 1 });
    const next = await runIngestion(r.deps, { trigger: 'manual' });
    expect(next).toMatchObject({ status: 'success', listingStop: 'all_known' });
    expect(await planPages(ctx.deps, {}, ctx.clock.now())).toMatchObject({ catchUp: false });
  });

  it('a run that is partial only because of the keyword pass still counts as a clean listing; the keyword stays out of the run row', async () => {
    ctx.clock.advance(3 * 3_600_000);
    const r = recordingDeps({ maxPages: 5 }, (c) => c.path === '/all-bids-data' && !!c.searchBid);
    const run = await runIngestion(r.deps, { trigger: 'cron' });
    expect(r.searches().length).toBeGreaterThan(0);
    const searched = r.searches()[0];
    expect(run).toMatchObject({ status: 'partial', listingStop: 'all_known' });
    expect(run.error).toMatch(/^keyword search 1\/\d+: GeM listing failed: HTTP 503$/);
    expect(run.error).not.toContain(searched); // GET /ingestion/runs is visible to every org (Constitution IV)
    const runs = await request(ctx.app, 'GET', '/ingestion/runs', { cookie: team.viewer.cookie });
    for (const kw of ['laptop', 'cctv']) expect(JSON.stringify(runs.body)).not.toContain(kw);
    ctx.clock.advance(60_000);
    expect(await planPages(ctx.deps, {}, ctx.clock.now())).toMatchObject({ catchUp: false, maxPages: ctx.deps.gem.maxPages });
  });
});

describe('targeted keyword search pass (FR-012, NFR-001)', () => {
  const extra = ['chair', 'desk', 'printer', 'projector', 'router', 'scanner', 'server', 'switch', 'tablet', 'toner', 'ups'];

  it('scheduled runs search up to 10 active watchlist keywords, rotating across runs, through the throttled client', async () => {
    const w = await request(ctx.app, 'POST', '/watchlists', { cookie: team.owner.cookie, json: { name: 'Office kit', criteria: { keywords: [...extra, 'Laptop'] } } });
    expect(w.status).toBe(201);
    // Paused watchlists don't contribute keywords.
    const paused = await request(ctx.app, 'POST', '/watchlists', { cookie: team.owner.cookie, json: { name: 'Paused', criteria: { keywords: ['submarine'] } } });
    expect((await request(ctx.app, 'PATCH', `/watchlists/${paused.body.id}`, { cookie: team.owner.cookie, json: { active: false } })).status).toBe(200);
    const all = [...extra, 'cctv', 'laptop'].sort(); // 13 distinct, case-folded

    ctx.clock.advance(30 * 60_000);
    const r1 = recordingDeps({ maxPages: 5, minIntervalMs: 15 });
    const run1 = await runIngestion(r1.deps, { trigger: 'cron' });
    expect(run1.status).toBe('success');
    const s1 = r1.searches();
    expect(s1).toHaveLength(10);
    expect(new Set(s1).size).toBe(10);
    for (const k of s1) expect(all).toContain(k);
    expect(s1).not.toContain('submarine');
    // Every search is page 1, after the listing pages, on the same ≤ 1 req/interval throttle.
    const gemCalls = r1.calls.filter((c) => c.path === '/all-bids-data');
    expect(gemCalls.filter((c) => c.searchBid).every((c) => c.page === 1)).toBe(true);
    expect(gemCalls.findIndex((c) => c.searchBid)).toBe(r1.listing().length);
    for (let i = 1; i < r1.calls.length; i++) expect(r1.calls[i].at - r1.calls[i - 1].at).toBeGreaterThanOrEqual(14);

    ctx.clock.advance(30 * 60_000);
    const r2 = recordingDeps({ maxPages: 5 });
    await runIngestion(r2.deps, { trigger: 'cron' });
    const s2 = r2.searches();
    expect(s2).toHaveLength(10);
    expect(s2).not.toEqual(s1); // cursor moved
    expect(new Set([...s1, ...s2])).toEqual(new Set(all)); // two runs cover all 13
  });

  it('search results go through the same upsert/match path and finds bids beyond the listing pages', async () => {
    // Keep the active keyword set ≤ 10 so this run searches all of them, whatever the rotation cursor is.
    await ctx.db.update(watchlists).set({ active: false }).where(eq(watchlists.name, 'Office kit'));
    // A corrigendum on a recorded-fixture CCTV bid: ~20 newer published bids sit above it, so listing page 1 can't see it.
    const cctv = await ctx.db.select().from(tenders)
      .where(sql`${tenders.title} ilike '%cctv%' and ${tenders.status} = 'open' and ${tenders.bidNumber} like 'GEM/2026/B/64210%'`);
    expect(cctv.length).toBeGreaterThan(0);
    const target = cctv[0];
    await admin(`/__admin/corrigendum/${encodeURIComponent(target.bidNumber)}`, { days: 5 });
    ctx.clock.advance(30 * 60_000);
    const r = recordingDeps();
    const run = await runIngestion(r.deps, { trigger: 'cron', pages: 1 });
    expect(r.listing()).toHaveLength(1);
    expect(r.searches()).toContain('cctv');
    expect(run).toMatchObject({ status: 'success', tendersUpdated: 1, tendersCreated: 0 });
    expect(run.tendersSeen).toBeGreaterThan(10);
    const [after] = await ctx.db.select().from(tenders).where(eq(tenders.id, target.id));
    expect(after.endAt!.getTime() - target.endAt!.getTime()).toBe(5 * 86_400_000);
  });

  it('search hits still need an exact watchlist match: token hits that only contain the keyword are stored, not matched', async () => {
    // Only the "ups" watchlist (plus earlier laptop/cctv ones) is active → every keyword is searched this run.
    await ctx.db.update(watchlists).set({ active: false }).where(eq(watchlists.name, 'Office kit'));
    const ups = await request(ctx.app, 'POST', '/watchlists', { cookie: team.owner.cookie, json: { name: 'UPS', criteria: { keywords: ['ups'] } } });
    expect(ups.status).toBe(201);
    // Two old (deep-in-listing) bids that mock-gem's substring search returns for "ups".
    const base = mock.state.docs.find((d) => String(d.b_bid_number[0]) === 'GEM/2026/B/6421003')!;
    const end = toGemSolrDate(new Date(ctx.clock.now().getTime() + 10 * 86_400_000));
    const mk = (n: number, category: string) => {
      const d = JSON.parse(JSON.stringify(base)) as typeof base;
      for (const k of ['bbt_title', 'b_title', 'b_hsn_code', 'bd_hsn_code', 'hsn_code']) delete (d as Record<string, unknown>)[k];
      d.b_id = [7438000 + n];
      (d as Record<string, unknown>).id = String(7438000 + n);
      d.b_bid_number = [`GEM/2026/B/643800${n}`];
      d.b_category_name = [category];
      d.bd_category_name = [category];
      d.final_end_date_sort = [end];
      mock.state.docs.push(d);
      return d.b_bid_number[0];
    };
    const tokenOnly = mk(1, 'Cloud Backups Storage Appliance'); // "ups" only inside "Backups"
    const exact = mk(2, 'UPS - Online 10 kVA');
    ctx.clock.advance(30 * 60_000);
    const r = recordingDeps();
    const run = await runIngestion(r.deps, { trigger: 'cron', pages: 1 });
    expect(r.searches()).toContain('ups');
    expect(run).toMatchObject({ status: 'success' });
    expect(r.listing()).toHaveLength(1);
    const [tTok] = await ctx.db.select().from(tenders).where(eq(tenders.bidNumber, tokenOnly));
    const [tExact] = await ctx.db.select().from(tenders).where(eq(tenders.bidNumber, exact));
    expect(tTok).toBeDefined(); // went through the same upsert path
    expect(tExact).toBeDefined();
    expect(await count(tenderMatches, eq(tenderMatches.tenderId, tTok.id))).toBe(0);
    const m = await ctx.db.select().from(tenderMatches).where(eq(tenderMatches.tenderId, tExact.id));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ watchlistId: ups.body.id, reasons: ['Keyword “ups”'] });
  });

  it('manual runs and explicit searches skip the keyword pass', async () => {
    ctx.clock.advance(30 * 60_000);
    const r = recordingDeps();
    await runIngestion(r.deps, { trigger: 'manual' });
    expect(r.searches()).toEqual([]);
    ctx.clock.advance(30 * 60_000);
    const s = recordingDeps();
    await runIngestion(s.deps, { trigger: 'cron', search: 'laptop', pages: 1 });
    expect(s.searches()).toEqual(['laptop']);
  });
});

describe('format-drift guard (FR-014)', () => {
  const drifted = (body: unknown) => {
    const logs: { level: string; msg: string; meta?: Record<string, unknown> }[] = [];
    const deps = {
      ...ctx.deps,
      logger: {
        info: (msg: string, meta?: Record<string, unknown>) => { logs.push({ level: 'info', msg, meta }); },
        warn: (msg: string, meta?: Record<string, unknown>) => { logs.push({ level: 'warn', msg, meta }); },
        error: (msg: string, meta?: Record<string, unknown>) => { logs.push({ level: 'error', msg, meta }); },
      },
      fetch: (async (input: string, init?: RequestInit) => {
        if (new URL(String(input)).pathname === '/all-bids-data') return Response.json(body);
        return mock.app.fetch(new Request(input, init));
      }) as typeof fetch,
    };
    return { deps, logs };
  };

  it('fails the run when most docs lack b_bid_number and logs ingestion.format_drift at error level', async () => {
    const before = await count(tenders);
    const docs = [{ bidNo: ['GEM/2026/B/1'] }, { bidNo: ['GEM/2026/B/2'] }, { b_bid_number: ['GEM/2026/B/6421001'], b_category_name: ['Laptop'] }];
    const d = drifted({ code: 200, response: { response: { numFound: 3, start: 0, docs } } });
    ctx.clock.advance(60_000);
    const run = await runIngestion(d.deps, { trigger: 'cron' });
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/^GeM response format changed: 2 of 3 listing docs lack b_bid_number/);
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(d.logs).toContainEqual(expect.objectContaining({ level: 'error', msg: 'ingestion.format_drift', meta: expect.objectContaining({ page: 1 }) }));
    expect(await count(tenders)).toBe(before);
  });

  it('fails the run when response.response.docs is missing', async () => {
    const d = drifted({ code: 200, response: { results: [] } });
    ctx.clock.advance(60_000);
    const run = await runIngestion(d.deps, { trigger: 'cron', pages: 2 });
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/^GeM response format changed: .*response\.response\.docs missing/);
    expect(d.logs.filter((l) => l.level === 'error' && l.msg === 'ingestion.format_drift')).toHaveLength(1);
    const runs = await request(ctx.app, 'GET', '/ingestion/runs', { cookie: team.viewer.cookie });
    expect(runs.body.lastRun).toMatchObject({ status: 'failed', error: expect.stringMatching(/^GeM response format changed/) });
  });
});

// ───────────── US4 gap: retries with back-off, error classification, concurrent dispatch (FR-047, SC-006) ─────────────

describe('alert delivery retries (FR-047, SC-006)', () => {
  const MIN = 60_000;
  type Mail = Parameters<typeof ctx.deps.mailer.send>[0];
  /** A configured mailer: `onMine` handles our test rows (by subject prefix), every other message is accepted. */
  const prefixMailer = (prefix: string, mine: Mail[], onMine: (m: Mail) => Promise<{ id?: string }>): AppDeps['mailer'] => ({
    configured: true,
    send: async (m) => {
      if (!m.subject.startsWith(prefix)) return { id: 'other' };
      mine.push(m);
      return onMine(m);
    },
  });
  /** Swap in a configured mailer for the duration of `fn`. */
  async function withMailer<T>(prefix: string, onMine: (m: Mail) => Promise<{ id?: string }>, fn: (mine: Mail[]) => Promise<T>): Promise<T> {
    const mine: Mail[] = [];
    const orig = ctx.deps.mailer;
    ctx.deps.mailer = prefixMailer(prefix, mine, onMine);
    try { return await fn(mine); } finally { ctx.deps.mailer = orig; }
  }
  const addRow = async (title: string, extra: Partial<typeof notifications.$inferInsert> = {}) => {
    const [row] = await ctx.db.insert(notifications).values({
      orgId: team.orgId, userId: team.owner.me.user.id, channel: 'email', kind: 'system', title, body: 'x', status: 'pending', dedupeKey: title, ...extra,
    }).returning();
    return row;
  };
  const rowOf = async (id: string) => (await ctx.db.select().from(notifications).where(eq(notifications.id, id)))[0];
  const dailyUser = async (name: string) => {
    const u = await signup(ctx.app, { role: 'analyst', ownerCookie: team.owner.cookie, name });
    await ctx.db.update(notificationPrefs).set({ frequency: 'daily', email: true }).where(eq(notificationPrefs.userId, u.me.user.id));
    return u;
  };
  const addMatches = async (userId: string, n: number, extra: Partial<typeof notifications.$inferInsert> = {}) =>
    (await ctx.db.insert(notifications).values(Array.from({ length: n }, (_, i) => ({
      orgId: team.orgId, userId, channel: 'email' as const, kind: 'tender_match' as const, title: `Match ${i + 1}`, body: 'x', status: 'pending' as const, ...extra,
    }))).returning()).map((r) => r.id);
  const digestRows = (userId: string) => ctx.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, 'digest')));

  beforeAll(() => { ctx.clock.set(new Date('2026-11-07T04:30:00.000Z')); }); // 10:00 IST, after the digest hour

  it('a transient failure stays pending, is retried at +5 min then +25 min, and is marked failed after 3 attempts', async () => {
    const row = await addRow('Retry-A 503');
    await withMailer('Retry-A', async () => { throw new ProviderError('Resend error 503: upstream', true, 503); }, async (mine) => {
      const t0 = ctx.clock.now();
      const r1 = await dispatchNotifications(ctx.deps);
      expect(r1.retried).toBeGreaterThanOrEqual(1);
      expect(await rowOf(row.id)).toMatchObject({ status: 'pending', attempts: 1, error: 'Resend error 503: upstream', nextAttemptAt: new Date(t0.getTime() + 5 * MIN) });
      // Not due yet: nothing is attempted.
      ctx.clock.advance(4 * MIN);
      await dispatchNotifications(ctx.deps);
      expect(mine).toHaveLength(1);
      ctx.clock.advance(1 * MIN);
      await dispatchNotifications(ctx.deps);
      expect(mine).toHaveLength(2);
      const t2 = ctx.clock.now();
      expect(await rowOf(row.id)).toMatchObject({ status: 'pending', attempts: 2, nextAttemptAt: new Date(t2.getTime() + 25 * MIN) });
      ctx.clock.advance(24 * MIN);
      await dispatchNotifications(ctx.deps);
      expect(mine).toHaveLength(2);
      ctx.clock.advance(1 * MIN);
      const r3 = await dispatchNotifications(ctx.deps);
      expect(r3.failed).toBeGreaterThanOrEqual(1);
      expect(mine).toHaveLength(3);
      expect(await rowOf(row.id)).toMatchObject({ status: 'failed', attempts: 3, nextAttemptAt: null, error: 'Resend error 503: upstream' });
      // Terminal: never tried again.
      ctx.clock.advance(60 * MIN);
      await dispatchNotifications(ctx.deps);
      expect(mine).toHaveLength(3);
    });
  });

  it('SC-006: on the 30-min cron a failing row is terminal within 3 cycles, even when each run starts a minute early', async () => {
    const row = await addRow('Early-1');
    await withMailer('Early-', async () => { throw new ProviderError('Resend error 502: bad gateway', true, 502); }, async (mine) => {
      await dispatchNotifications(ctx.deps);
      ctx.clock.advance(29 * MIN);
      await dispatchNotifications(ctx.deps);
      expect(mine).toHaveLength(2);
      ctx.clock.advance(29 * MIN);
      await dispatchNotifications(ctx.deps);
      expect(mine).toHaveLength(3);
      expect(await rowOf(row.id)).toMatchObject({ status: 'failed', attempts: 3, nextAttemptAt: null });
    });
  });

  it('the Resend adapter: a network error is retried and the next attempt is sent; a 4xx fails at once', async () => {
    const flaky = await addRow('Retry-B network');
    const bad = await addRow('Retry-C invalid');
    let calls = 0;
    const signals: unknown[] = [];
    const resend = createResendMailer({
      apiKey: 'k', from: 'alerts@tenderpilot.test', logger: ctx.deps.logger,
      fetch: (async (_url: string, init?: RequestInit) => {
        signals.push(init?.signal);
        const subject = JSON.parse(String(init?.body)).subject as string;
        if (subject.startsWith('Retry-C')) return new Response('{"message":"invalid to"}', { status: 422 });
        if (subject.startsWith('Retry-B') && calls++ === 0) throw new TypeError('fetch failed');
        return new Response('{"id":"re_1"}', { status: 200 });
      }) as typeof fetch,
    });
    await withMailer('Retry-', (m) => resend.send(m), async () => {
      await dispatchNotifications(ctx.deps);
      expect(await rowOf(flaky.id)).toMatchObject({ status: 'pending', attempts: 1, error: expect.stringMatching(/^Resend network error: fetch failed/) });
      expect(await rowOf(bad.id)).toMatchObject({ status: 'failed', attempts: 1, nextAttemptAt: null, error: expect.stringMatching(/^Resend error 422/) });
      ctx.clock.advance(5 * MIN);
      await dispatchNotifications(ctx.deps);
      expect(await rowOf(flaky.id)).toMatchObject({ status: 'sent', attempts: 2, nextAttemptAt: null, sentAt: ctx.clock.now() });
    });
    // Every provider request carries a timeout signal (PROVIDER_TIMEOUT_MS).
    expect(signals.length).toBeGreaterThan(0);
    for (const sig of signals) expect(sig).toBeInstanceOf(AbortSignal);
  });

  it('classifies provider errors: network/timeout/408/429/5xx and Meta throttling codes are transient, other 4xx and bugs permanent', async () => {
    const wa = (status: number, body: string) => createMetaWhatsApp({
      token: 't', phoneNumberId: '1', fetch: (async () => new Response(body, { status })) as unknown as typeof fetch,
    }).send({ to: '+919812345678', text: 'x' }).then(() => null, (e) => e as ProviderError);
    expect((await wa(500, '{}'))?.transient).toBe(true);
    expect((await wa(429, '{}'))?.transient).toBe(true);
    expect((await wa(400, '{"error":{"code":131056,"message":"pair rate limit"}}'))?.transient).toBe(true);
    expect((await wa(400, '{"error":{"code":131026,"message":"undeliverable"}}'))?.transient).toBe(false);
    expect((await wa(401, '{"error":{"code":190}}'))?.transient).toBe(false);
    const waNet = await createMetaWhatsApp({ token: 't', phoneNumberId: '1', fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch })
      .send({ to: '+919812345678', text: 'x' }).then(() => null, (e) => e);
    expect(isTransientSendError(waNet)).toBe(true); // thrown by fetch → wrapped by providerFetch
    const timedOut = await createMetaWhatsApp({ token: 't', phoneNumberId: '1', fetch: (async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }) as unknown as typeof fetch })
      .send({ to: '+919812345678', text: 'x' }).then(() => null, (e) => e);
    expect(isTransientSendError(timedOut)).toBe(true);
    expect(PROVIDER_TIMEOUT_MS).toBe(30_000);
    expect(isTransientSendError(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(true);
    expect(isTransientStatus(408)).toBe(true);
    expect(isTransientStatus(404)).toBe(false);
    expect(isTransientSendError(new Error('boom'))).toBe(false);
    // A bare TypeError outside fetch is a programming error, not a network failure: not retried.
    expect(isTransientSendError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
  });

  it('a dispatcher never sends rows another running dispatcher has claimed; each row is sent exactly once', async () => {
    const rows = await Promise.all([1, 2, 3, 4].map((i) => addRow(`Conc-${i}`)));
    const sentA: Mail[] = [];
    const sentB: Mail[] = [];
    let inSend!: () => void;
    const aInSend = new Promise<void>((r) => { inSend = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Run A blocks inside its first send until released.
    const depsA: AppDeps = { ...ctx.deps, mailer: prefixMailer('Conc-', sentA, async (m) => { if (sentA.length === 1) { inSend(); await gate; } return { id: m.subject }; }) };
    const depsB: AppDeps = { ...ctx.deps, mailer: prefixMailer('Conc-', sentB, async (m) => ({ id: m.subject })) };
    const runA = dispatchNotifications(depsA);
    try {
      await aInSend;
      ctx.clock.advance(1); // B is a later run: its own lease differs from A's
      const reportB = await dispatchNotifications(depsB);
      expect(sentB).toEqual([]);
      expect(reportB.failed + reportB.retried).toBe(0);
    } finally { release(); }
    const reportA = await runA;
    expect(reportA.failed + reportA.retried).toBe(0);
    expect(sentA.map((m) => m.subject).sort()).toEqual(rows.map((r) => r.title).sort());
    for (const r of rows) expect(await rowOf(r.id)).toMatchObject({ status: 'sent', attempts: 1, nextAttemptAt: null });
    // Re-running is a no-op.
    await dispatchNotifications(depsB);
    await dispatchNotifications(depsA);
    expect(sentB).toEqual([]);
    expect(sentA).toHaveLength(rows.length);
  });

  it('a row claimed by a dispatcher that died is retried once its lease expires', async () => {
    const row = await addRow('Lease-1', { nextAttemptAt: new Date(ctx.clock.now().getTime() + CLAIM_LEASE_MS) });
    await withMailer('Lease-', async () => ({ id: 'ok' }), async (mine) => {
      await dispatchNotifications(ctx.deps);
      expect(mine).toHaveLength(0);
      ctx.clock.advance(CLAIM_LEASE_MS);
      await dispatchNotifications(ctx.deps);
      expect(mine).toHaveLength(1);
      expect(await rowOf(row.id)).toMatchObject({ status: 'sent', attempts: 1 });
    });
  });

  it('a queued email for a user who switched email off (or unsubscribed) is skipped, not sent', async () => {
    const off = await signup(ctx.app, { role: 'analyst', ownerCookie: team.owner.cookie, name: 'Email Off' });
    await ctx.db.update(notificationPrefs).set({ email: false }).where(eq(notificationPrefs.userId, off.me.user.id));
    const row = await addRow('Off-1', { userId: off.me.user.id });
    await withMailer('Off-', async () => ({ id: 'x' }), async (mine) => {
      await dispatchNotifications(ctx.deps);
      expect(mine).toHaveLength(0);
      expect(await rowOf(row.id)).toMatchObject({ status: 'skipped', error: 'Email alerts are turned off', nextAttemptAt: null });
    });
  });

  it('a daily digest is reserved as pending during the send; a transient failure frees the slot, the retry is sent once', async () => {
    ctx.clock.set(new Date('2026-11-08T04:30:00.000Z')); // 10:00 IST
    const daily = await dailyUser('Retry Digest');
    const ids = await addMatches(daily.me.user.id, 2);
    let fail = true;
    const orig = ctx.deps.mailer;
    const digests: Mail[] = [];
    const statusDuringSend: string[] = [];
    ctx.deps.mailer = {
      configured: true,
      send: async (m) => {
        if (m.to !== daily.email) return { id: 'other' };
        digests.push(m);
        statusDuringSend.push(...(await digestRows(daily.me.user.id)).map((d) => d.status));
        if (fail) throw new ProviderError('Resend error 429: slow down', true, 429);
        return { id: 'digest' };
      },
    };
    try {
      await dispatchNotifications(ctx.deps);
      for (const id of ids) expect(await rowOf(id)).toMatchObject({ status: 'pending', attempts: 1 });
      expect(await digestRows(daily.me.user.id)).toHaveLength(0);
      fail = false;
      ctx.clock.advance(5 * MIN);
      const r = await dispatchNotifications(ctx.deps);
      expect(r.digests).toBe(1);
      for (const id of ids) expect(await rowOf(id)).toMatchObject({ status: 'sent', attempts: 2 });
      expect(digests).toHaveLength(2);
      expect(digests[1].subject).toBe('Daily digest: 2 new GeM tenders matched today');
      expect(statusDuringSend).toEqual(['pending', 'pending']); // never `sent` before the provider accepted it
      expect(await digestRows(daily.me.user.id)).toEqual([expect.objectContaining({ status: 'sent', attempts: 1, nextAttemptAt: null, sentAt: ctx.clock.now() })]);
    } finally { ctx.deps.mailer = orig; }
  });

  it('a digest reservation in flight holds the rows until its lease ends; once stale it is removed and the digest is sent', async () => {
    ctx.clock.set(new Date('2026-11-09T04:30:00.000Z')); // 10:00 IST
    const daily = await dailyUser('Stale Digest');
    const now = ctx.clock.now();
    const leaseEnd = new Date(now.getTime() + 10 * MIN);
    // Another dispatcher reserved today's digest 5 minutes ago and is still within its lease.
    await ctx.db.insert(notifications).values({
      orgId: team.orgId, userId: daily.me.user.id, channel: 'email', kind: 'digest', title: 'reserved', body: 'x',
      dedupeKey: `digest:${team.orgId}:2026-11-09`, status: 'pending', nextAttemptAt: leaseEnd,
    });
    const ids = await addMatches(daily.me.user.id, 2);
    const mine: Mail[] = [];
    const orig = ctx.deps.mailer;
    ctx.deps.mailer = { configured: true, send: async (m) => { if (m.to === daily.email) mine.push(m); return { id: 'x' }; } };
    try {
      await dispatchNotifications(ctx.deps);
      expect(mine).toHaveLength(0);
      for (const id of ids) expect(await rowOf(id)).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: leaseEnd });
      // That dispatcher died: when its lease runs out the reservation is dropped and the digest goes out once.
      ctx.clock.set(leaseEnd);
      const r = await dispatchNotifications(ctx.deps);
      expect(r.digests).toBe(1);
      expect(mine.map((m) => m.subject)).toEqual(['Daily digest: 2 new GeM tenders matched today']);
      expect(await digestRows(daily.me.user.id)).toEqual([expect.objectContaining({ status: 'sent', title: '2 new GeM tenders matched today' })]);
      for (const id of ids) expect(await rowOf(id)).toMatchObject({ status: 'sent', attempts: 1 });
    } finally { ctx.deps.mailer = orig; }
  });

  it('a database error after a successful send neither frees the digest slot nor counts as a failed attempt', async () => {
    ctx.clock.set(new Date('2026-11-10T04:30:00.000Z')); // 10:00 IST
    const daily = await dailyUser('Db Error Digest');
    const ids = await addMatches(daily.me.user.id, 2);
    const instant = await addRow('DbErr-1');
    // Simulated outage: any write that marks these rows `sent` fails.
    await ctx.db.execute(sql.raw(`
      create or replace function tp_test_fail_sent() returns trigger language plpgsql as $$
      begin
        if new.status = 'sent' and (new.title = 'DbErr-1' or (new.kind = 'digest' and new.user_id = '${daily.me.user.id}')) then
          raise exception 'simulated database outage';
        end if;
        return new;
      end $$;
      create trigger tp_test_fail_sent before update on notifications for each row execute function tp_test_fail_sent();`));
    const mine: Mail[] = [];
    const orig = ctx.deps.mailer;
    ctx.deps.mailer = { configured: true, send: async (m) => { if (m.to === daily.email || m.subject === 'DbErr-1') mine.push(m); return { id: 'x' }; } };
    try {
      const r = await dispatchNotifications(ctx.deps);
      expect(r.failed + r.retried).toBe(0);
      expect(mine.map((m) => m.subject).sort()).toEqual(['Daily digest: 2 new GeM tenders matched today', 'DbErr-1']);
      // Not failed / retried, attempt not counted, digest reservation kept (still leased): nothing is re-sent now.
      expect(await rowOf(instant.id)).toMatchObject({ status: 'pending', attempts: 0 });
      for (const id of ids) expect(await rowOf(id)).toMatchObject({ status: 'pending', attempts: 0 });
      expect(await digestRows(daily.me.user.id)).toEqual([expect.objectContaining({ status: 'pending' })]);
      await dispatchNotifications(ctx.deps);
      expect(mine).toHaveLength(2);
      await ctx.db.execute(sql.raw('drop trigger tp_test_fail_sent on notifications'));
      // After the lease the rows are delivered again (at-least-once) and settle normally.
      ctx.clock.advance(CLAIM_LEASE_MS);
      await dispatchNotifications(ctx.deps);
      expect(mine).toHaveLength(4);
      expect(await rowOf(instant.id)).toMatchObject({ status: 'sent', attempts: 1 });
      for (const id of ids) expect(await rowOf(id)).toMatchObject({ status: 'sent', attempts: 1 });
      expect(await digestRows(daily.me.user.id)).toEqual([expect.objectContaining({ status: 'sent' })]);
    } finally {
      ctx.deps.mailer = orig;
      await ctx.db.execute(sql.raw('drop trigger if exists tp_test_fail_sent on notifications; drop function if exists tp_test_fail_sent();'));
    }
  });

  it('held daily rows wait for 08:00 IST and never starve instant rows out of the batch', async () => {
    ctx.clock.set(new Date('2026-11-11T00:30:00.000Z')); // 06:00 IST
    // Drain anything else that is due, so the batch below only sees this test's rows.
    await dispatchNotifications(ctx.deps);
    await dispatchNotifications(ctx.deps);
    const daily = await dailyUser('Starve Digest');
    const held = await addMatches(daily.me.user.id, 6);
    const instant = await addRow('Starve-instant'); // newest row
    await withMailer('Starve-', async () => ({ id: 'ok' }), async (mine) => {
      // Batch of 4 (stands in for DISPATCH_BATCH = 500 with 500+ held rows): the old behaviour re-claimed the same
      // 4 held rows every run and never reached the instant one.
      for (let i = 0; i < 3; i++) await dispatchNotifications(ctx.deps, { limit: 4 });
      expect(mine.map((m) => m.subject)).toEqual(['Starve-instant']);
    });
    expect(await rowOf(instant.id)).toMatchObject({ status: 'sent' });
    for (const id of held) expect(await rowOf(id)).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: new Date('2026-11-11T02:30:00.000Z') });
    expect(DISPATCH_BATCH).toBe(500);
  });
});
