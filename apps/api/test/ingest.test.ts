/**
 * T038 — ingestion idempotency, corrigenda, matching → notifications, dispatch & digests, failure modes.
 * Runs against the in-process mock BidPlus (tools/mock-gem) through deps.fetch.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyses, ingestionRuns, notificationPrefs, notifications, tenderEvents, tenderMatches, tenders, users } from '@tp/db';
import { createMockGem } from '../../../tools/mock-gem/src/app';
import { dispatchNotifications } from '../src/services/alerts';
import { IngestionBusyError, runIngestion } from '../src/services/ingest';
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
    ctx.clock.set(new Date('2026-11-05T03:30:00.000Z')); // 09:00 IST
    const sent = await dispatchNotifications(ctx.deps);
    expect(sent.digests).toBe(1);
    const digest = ctx.mailer.sent.find((m) => m.subject.startsWith('Daily digest') && m.to === daily.email);
    expect(digest?.subject).toMatch(/new GeM tenders? matched today/);
    expect(await count(notifications, and(eq(notifications.userId, daily.me.user.id), eq(notifications.status, 'pending'))!)).toBe(0);
    // Same day: no second digest.
    expect((await dispatchNotifications(ctx.deps)).digests).toBe(0);
  });
});
