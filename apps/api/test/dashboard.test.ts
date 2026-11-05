/** Dashboard aggregates (T070; US6 independent test: numbers on seeded data, moving a card updates stage + activity). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { activityLog, analyses, bidWorkspaces, organizations, tenderMatches, tenders, vaultDocuments, watchlists } from '@tp/db';
import type { DashboardResponse } from '@tp/core/contracts/experience';
import { istMidnight } from '../src/routes/dashboard';
import { createTestContext, request, seedOrgWithRoles, signup, type TestContext } from './helpers';

const NOW = new Date('2026-11-04T04:30:00Z'); // 10:00 IST, Wednesday

let ctx: TestContext;
let org: Awaited<ReturnType<typeof seedOrgWithRoles>>;

const dash = async (cookie: string) => {
  const r = await request<DashboardResponse>(ctx.app, 'GET', '/dashboard', { cookie });
  expect(r.status).toBe(200);
  return r.body;
};

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW });
  org = await seedOrgWithRoles(ctx.app, 'Dashboard Org');
});
afterAll(() => ctx?.close());

describe('istMidnight', () => {
  it('returns the UTC instant of IST midnight', () => {
    expect(istMidnight(NOW).toISOString()).toBe('2026-11-03T18:30:00.000Z');
    expect(istMidnight(new Date('2026-11-03T19:00:00Z')).toISOString()).toBe('2026-11-03T18:30:00.000Z'); // 00:30 IST on the 4th
    expect(istMidnight(NOW, -1).toISOString()).toBe('2026-11-02T18:30:00.000Z');
  });
});

describe('GET /api/dashboard', () => {
  it('requires a session', async () => {
    expect((await request(ctx.app, 'GET', '/dashboard')).status).toBe(401);
  });

  it('returns a well-formed empty state for a new org', async () => {
    const d = await dash(org.viewer.cookie);
    expect(d.tiles).toEqual({ newMatchesToday: 0, closingThisWeek: 0, activeBids: 0, emdAtStake: 0, winRate: null, expiringDocs: 0 });
    expect(d.matchesByDay).toHaveLength(14);
    expect(d.matchesByDay[13]!.date).toBe('2026-11-04');
    expect(d.matchesByDay[0]!.date).toBe('2026-10-22');
    expect(d.closingSoon).toEqual([]);
    expect(d.pipeline.identified).toBe(0);
    expect(d.verdicts).toEqual({ go: 0, review: 0, no_go: 0 });
    expect(d.setupComplete).toBe(false);
    const team = d.setup.find((s) => s.key === 'team')!;
    expect(team.done).toBe(true); // seedOrgWithRoles invited 3 members
    expect(d.setup.find((s) => s.key === 'watchlist')!.done).toBe(false);
    expect(d.demo).toBe(false);
  });

  it('aggregates the demo dataset correctly', async () => {
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: org.owner.cookie })).status).toBe(201);
    const d = await dash(org.viewer.cookie);

    // Pipeline per the demo plan.
    expect(d.pipeline).toMatchObject({ identified: 3, analysing: 2, go: 2, preparing: 2, ready: 1, submitted: 3, won: 2, lost: 1, dropped: 0 });
    expect(d.tiles.activeBids).toBe(13);
    expect(d.tiles.winRate).toBe(67);
    expect(d.stats).toMatchObject({ won: 2, lost: 1 });
    expect(d.verdicts.go + d.verdicts.review + d.verdicts.no_go).toBe(20);
    expect(d.verdicts.no_go).toBeGreaterThan(0);
    expect(d.pipelineValue.won).toBeGreaterThan(0);

    // EMD at stake = sum of EMD of tenders in active workspaces (independent SQL).
    const [emd] = (await ctx.db.execute(sql`
      select coalesce(sum(t.emd_amount),0)::bigint as s from bid_workspaces w join tenders t on t.id = w.tender_id
      where w.org_id = ${org.orgId} and w.stage not in ('won','lost','dropped')`) as unknown as { rows: { s: string }[] }).rows;
    expect(d.tiles.emdAtStake).toBe(Number(emd!.s));
    expect(d.tiles.emdAtStake).toBeGreaterThan(0);

    // Expiring docs: ISO (10 d), CA certificate (25 d) and the expired Dell authorisation.
    expect(d.tiles.expiringDocs).toBe(3);
    expect(d.stats.expiredDocs).toBe(1);
    expect(d.expiringDocuments[0]!.status).toBe('expired');
    expect(d.expiringDocuments.map((x) => x.daysToExpiry)).toEqual([...d.expiringDocuments.map((x) => x.daysToExpiry)].sort((a, b) => a - b));

    // Closing soon: open, within 7 days, sorted, relevant to the org.
    expect(d.closingSoon.length).toBeGreaterThan(0);
    expect(d.closingSoon.length).toBeLessThanOrEqual(8);
    const ends = d.closingSoon.map((t) => Date.parse(t.endAt!));
    expect(ends).toEqual([...ends].sort((a, b) => a - b));
    for (const e of ends) {
      expect(e).toBeGreaterThanOrEqual(NOW.getTime());
      expect(e).toBeLessThanOrEqual(NOW.getTime() + 7 * 86_400_000);
    }
    expect(d.tiles.closingThisWeek).toBeGreaterThanOrEqual(d.closingSoon.length);
    expect(d.stats.closingToday).toBeGreaterThanOrEqual(1);
    expect(d.closingSoon.some((t) => t.workspace?.stage === 'ready')).toBe(true);
    // "Not our business" tenders (chairs, beds, paper…) never appear.
    expect(d.closingSoon.some((t) => /Chair|Hospital Bed|Copier Paper/.test(t.title))).toBe(false);

    // New matches today = distinct matched tenders since IST midnight (independent query).
    const [today] = await ctx.db.select({ n: sql<number>`count(distinct ${tenderMatches.tenderId})::int` }).from(tenderMatches)
      .where(and(eq(tenderMatches.orgId, org.orgId), sql`${tenderMatches.createdAt} >= ${istMidnight(NOW)}`));
    expect(d.tiles.newMatchesToday).toBe(today!.n);
    const total14 = d.matchesByDay.reduce((a, b) => a + b.count, 0);
    expect(total14).toBeGreaterThan(5);

    // Recent matches carry watchlist and reasons; activity is capped at 15 and has resolved targets.
    expect(d.recentMatches.length).toBe(6);
    expect(d.recentMatches[0]!.watchlistName).toBeTruthy();
    expect(d.recentMatches[0]!.reasons.length).toBeGreaterThan(0);
    expect(d.activity.length).toBeLessThanOrEqual(15);
    expect(d.activity.some((a) => a.action === 'demo.seeded')).toBe(true);
    expect(d.activity.some((a) => a.target?.href.startsWith('/workspaces/'))).toBe(true);

    expect(d.demo).toBe(true);
    expect(d.setup.find((s) => s.key === 'company')!.done).toBe(true);
    expect(d.setupComplete).toBe(true);
  });

  it('moving a card changes the stage counts and writes an activity entry (US6 independent test)', async () => {
    const list = await request(ctx.app, 'GET', '/workspaces', { cookie: org.analyst.cookie });
    const card = list.body.items.find((w: { stage: string }) => w.stage === 'identified');
    const before = await dash(org.analyst.cookie);
    const r = await request(ctx.app, 'PATCH', `/workspaces/${card.id}`, { cookie: org.analyst.cookie, json: { stage: 'analysing', position: 0.5 } });
    expect(r.status).toBe(200);
    const after = await dash(org.analyst.cookie);
    expect(after.pipeline.identified).toBe(before.pipeline.identified - 1);
    expect(after.pipeline.analysing).toBe(before.pipeline.analysing + 1);
    expect(after.activity[0]!.action).toBe('workspace.stage_changed');
    expect(after.activity[0]!.user?.name).toBeTruthy();
    expect(after.activity[0]!.target?.href).toBe(`/workspaces/${card.id}`);
    const [row] = await ctx.db.select().from(activityLog).where(and(eq(activityLog.orgId, org.orgId), eq(activityLog.entityId, card.id), eq(activityLog.action, 'workspace.stage_changed')));
    expect(row!.meta).toMatchObject({ from: 'identified', to: 'analysing' });
  });

  it('dismissed matches drop out of "new today" and closing-soon (unless in the pipeline)', async () => {
    const d = await dash(org.owner.cookie);
    const target = d.closingSoon.find((t) => !t.workspace);
    if (!target) return; // every closing tender is in the pipeline — nothing to dismiss
    expect((await request(ctx.app, 'POST', `/tenders/${target.id}/dismiss`, { cookie: org.owner.cookie })).status).toBeLessThan(300);
    const d2 = await dash(org.owner.cookie);
    expect(d2.closingSoon.some((t) => t.id === target.id)).toBe(false);
  });

  it('is tenant-isolated: another org sees none of it', async () => {
    const other = await signup(ctx.app, { orgName: 'Other Org' });
    const d = await dash(other.cookie);
    expect(d.tiles.activeBids).toBe(0);
    expect(d.closingSoon).toHaveLength(0);
    expect(d.recentMatches).toHaveLength(0);
    expect(d.activity.every((a) => a.action === 'org.created')).toBe(true);
    // Tenders are global but only surface through this org's matches/workspaces.
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(tenders);
    expect(n).toBe(40);
  });
});

/**
 * Boundaries (T015): IST day edges, tenders without a closing date, the 6-row cap on expiring documents and
 * win rate with lost-only / no results. Runs after the isolation test above (which counts global tenders).
 */
describe('GET /api/dashboard — boundaries', () => {
  let seq = 0;
  const tender = async (endAt: Date | null) => {
    seq += 1;
    const [t] = await ctx.db.insert(tenders).values({
      bidNumber: `GEM/2026/B/91000${seq}`, title: `Boundary tender ${seq}`, sourceUrl: 'https://bidplus.gem.gov.in/all-bids',
      contentHash: `boundary-${seq}`, status: 'open', endAt,
    }).returning();
    return t!;
  };
  const watchlist = async (orgId: string) => {
    const [w] = await ctx.db.insert(watchlists).values({
      orgId, name: 'Boundary watch', criteria: { keywords: ['boundary'], excludeKeywords: [], categories: [], hsnCodes: [], states: [], ministries: [] },
    }).returning();
    return w!;
  };

  it('counts a match at 00:10 IST as today and one at 23:50 IST the previous day as yesterday', async () => {
    const o = await signup(ctx.app, { orgName: 'IST Edge Org' });
    const orgId = o.me.org.id;
    const wl = await watchlist(orgId);
    const [a, b] = [await tender(null), await tender(null)];
    await ctx.db.insert(tenderMatches).values([
      { orgId, tenderId: a.id, watchlistId: wl.id, createdAt: new Date('2026-11-03T18:40:00Z') }, // 4 Nov 00:10 IST
      { orgId, tenderId: b.id, watchlistId: wl.id, createdAt: new Date('2026-11-03T18:20:00Z') }, // 3 Nov 23:50 IST
    ]);
    const d = await dash(o.cookie);
    expect(d.tiles.newMatchesToday).toBe(1);
    expect(d.stats.newMatchesYesterday).toBe(1);
    expect(d.matchesByDay.find((x) => x.date === '2026-11-04')!.count).toBe(1);
    expect(d.matchesByDay.find((x) => x.date === '2026-11-03')!.count).toBe(1);
  });

  it('never lists a tender without a closing date (endAt = null) in closingSoon', async () => {
    const o = await signup(ctx.app, { orgName: 'No End Org' });
    const orgId = o.me.org.id;
    const wl = await watchlist(orgId);
    const noEnd = await tender(null);
    const soon = await tender(new Date(NOW.getTime() + 2 * 86_400_000));
    await ctx.db.insert(tenderMatches).values([
      { orgId, tenderId: noEnd.id, watchlistId: wl.id, createdAt: NOW },
      { orgId, tenderId: soon.id, watchlistId: wl.id, createdAt: NOW },
    ]);
    // In the pipeline too — still no closing date, still not "closing soon".
    await ctx.db.insert(bidWorkspaces).values({ orgId, tenderId: noEnd.id, stage: 'preparing' });
    const d = await dash(o.cookie);
    expect(d.closingSoon.map((t) => t.id)).toEqual([soon.id]);
    expect(d.closingSoon.every((t) => t.endAt !== null)).toBe(true);
    expect(d.tiles.closingThisWeek).toBe(1);
  });

  it('counts all 8 expiring documents in the tile but lists only 6', async () => {
    const o = await signup(ctx.app, { orgName: 'Many Docs Org' });
    const orgId = o.me.org.id;
    // 2 expired, 6 expiring within 30 days (4 Nov 2026 = today IST), 1 valid beyond the horizon.
    const expiries = ['2026-10-20', '2026-11-01', '2026-11-04', '2026-11-06', '2026-11-10', '2026-11-15', '2026-11-25', '2026-12-03', '2027-03-01'];
    await ctx.db.insert(vaultDocuments).values(expiries.map((expiryDate, i) => ({
      orgId, type: 'other' as const, title: `Doc ${i + 1}`, expiryDate, blobKey: `test/doc-${i}`, fileName: `doc-${i}.pdf`, mimeType: 'application/pdf', sizeBytes: 100,
    })));
    const d = await dash(o.cookie);
    expect(d.tiles.expiringDocs).toBe(8);
    expect(d.expiringDocuments).toHaveLength(6);
    expect(d.stats.expiredDocs).toBe(2);
    expect(d.expiringDocuments.map((x) => x.title)).toEqual(['Doc 1', 'Doc 2', 'Doc 3', 'Doc 4', 'Doc 5', 'Doc 6']);
    expect(d.expiringDocuments.map((x) => x.status)).toEqual(['expired', 'expired', 'expiring', 'expiring', 'expiring', 'expiring']);
  });

  it('win rate is null with no results and 0 for a lost-only org', async () => {
    const o = await signup(ctx.app, { orgName: 'Lost Only Org' });
    const orgId = o.me.org.id;
    const before = await dash(o.cookie);
    expect(before.tiles.winRate).toBeNull();
    // Workspaces still in progress are not results.
    await ctx.db.insert(bidWorkspaces).values({ orgId, tenderId: (await tender(null)).id, stage: 'submitted' });
    expect((await dash(o.cookie)).tiles.winRate).toBeNull();
    await ctx.db.insert(bidWorkspaces).values([
      { orgId, tenderId: (await tender(null)).id, stage: 'lost' },
      { orgId, tenderId: (await tender(null)).id, stage: 'lost' },
    ]);
    const d = await dash(o.cookie);
    expect(d.tiles.winRate).toBe(0);
    expect(d.stats).toMatchObject({ won: 0, lost: 2 });
  });
});

/** FR-007 (QA US1-3 defect): the team step does not block setupComplete for a demo org, but does for real orgs. */
describe('GET /api/dashboard — setupComplete and the team step', () => {
  it('a single-member demo org is setup-complete while team stays not done', async () => {
    const solo = await signup(ctx.app, { orgName: 'Solo Demo Org' });
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: solo.cookie })).status).toBe(201);
    const d = await dash(solo.cookie);
    expect(d.demo).toBe(true);
    expect(d.setup.find((s) => s.key === 'team')!.done).toBe(false);
    expect(d.setup.filter((s) => s.key !== 'team').every((s) => s.done)).toBe(true);
    expect(d.setupComplete).toBe(true);
  });

  it('for a non-demo org the team step still blocks setupComplete (US3-12)', async () => {
    const solo = await signup(ctx.app, { orgName: 'Solo Real Org' });
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: solo.cookie })).status).toBe(201);
    // Same data, but the org is no longer flagged as demo: every step except team is done.
    await ctx.db.update(organizations).set({ onboardingState: { demo: false } }).where(eq(organizations.id, solo.me.org.id));
    const d = await dash(solo.cookie);
    expect(d.demo).toBe(false);
    expect(d.setup.filter((s) => s.key !== 'team').every((s) => s.done)).toBe(true);
    expect(d.setup.find((s) => s.key === 'team')!.done).toBe(false);
    expect(d.setupComplete).toBe(false);
    // Inviting a teammate completes setup.
    expect((await request(ctx.app, 'POST', '/org/invitations', { cookie: solo.cookie, json: { email: 'mate@example.in', role: 'analyst' } })).status).toBe(201);
    const d2 = await dash(solo.cookie);
    expect(d2.setup.find((s) => s.key === 'team')!.done).toBe(true);
    expect(d2.setupComplete).toBe(true);
  });
});

/**
 * Persona widgets (T058; 007/US5, FR-070, NFR-005): `myWork` (owner or assignee, active stages only, `dueAt` nulls
 * last then `endAt`, ≤ 5, readiness) and `awaitingDecision` (stage `analysing` with a done analysis, oldest first, ≤ 5).
 */
describe('GET /api/dashboard — persona widgets (myWork, awaitingDecision)', () => {
  let seq = 0;
  const DAYMS = 86_400_000;
  const tender = async (endAt: Date | null, title?: string) => {
    seq += 1;
    const [t] = await ctx.db.insert(tenders).values({
      bidNumber: `GEM/2026/B/92000${seq}`, title: title ?? `Persona tender ${seq}`, sourceUrl: 'https://bidplus.gem.gov.in/all-bids',
      contentHash: `persona-${seq}`, status: 'open', endAt,
    }).returning();
    return t!;
  };
  const analysis = async (orgId: string, tenderId: string, over: Partial<typeof analyses.$inferInsert> = {}) => {
    const [a] = await ctx.db.insert(analyses).values({ orgId, tenderId, status: 'done', score: 82, verdict: 'go', ...over }).returning();
    return a!;
  };
  const days = (n: number) => new Date(NOW.getTime() + n * DAYMS);

  it('is empty for a member with nothing assigned and when nothing awaits a decision', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'Persona Empty Org');
    for (const who of [o.owner, o.bidManager, o.analyst, o.viewer]) {
      const d = await dash(who.cookie);
      expect(d.myWork).toEqual([]);
      expect(d.awaitingDecision).toEqual([]);
    }
  });

  it('myWork lists owner-or-assignee workspaces only, active stages only, dueAt nulls last then endAt, max 5', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'Persona MyWork Org');
    const orgId = o.orgId;
    const me = o.analyst.me.user.id, other = o.bidManager.me.user.id;
    const mk = async (stage: typeof bidWorkspaces.$inferInsert['stage'], endDays: number | null, w: Partial<typeof bidWorkspaces.$inferInsert> = {}) => {
      const t = await tender(endDays == null ? null : days(endDays));
      const [ws] = await ctx.db.insert(bidWorkspaces).values({ orgId, tenderId: t.id, stage, ...w }).returning();
      return { t, ws: ws! };
    };
    const a = await mk('preparing', 9, { ownerId: me, dueAt: days(3) });
    const b = await mk('go', 5, { assigneeIds: [other, me], dueAt: days(1) });
    const c = await mk('identified', 4, { ownerId: me }); // no dueAt → after dated ones, by endAt
    const d2 = await mk('ready', 2, { assigneeIds: [me] }); // no dueAt, earlier endAt than c
    const e = await mk('analysing', null, { ownerId: me }); // no dueAt, no endAt → last
    await mk('won', 1, { ownerId: me, dueAt: days(0) });        // closed stages excluded
    await mk('lost', 1, { assigneeIds: [me] });
    await mk('submitted', 1, { ownerId: me, dueAt: days(0) }); // submitted is no longer in flight (US5-2)
    await mk('dropped', 1, { ownerId: me });
    await mk('preparing', 1, { ownerId: other, assigneeIds: [other], dueAt: days(0) }); // someone else's
    const g = await mk('go', 6, { ownerId: me, dueAt: days(20) }); // sixth active item: `e` (no dates) is cut by the cap of 5
    const r = await dash(o.analyst.cookie);
    expect(e.ws.id).toBeTruthy();
    expect(r.myWork!.map((x) => x.workspaceId)).toEqual([b.ws.id, a.ws.id, g.ws.id, d2.ws.id, c.ws.id]);
    expect(r.myWork).toHaveLength(5);
    expect(r.myWork!.every((x) => !['won', 'lost', 'dropped', 'submitted'].includes(x.stage))).toBe(true);
    expect(r.myWork![0]).toMatchObject({ tenderId: b.t.id, bidNumber: b.t.bidNumber, stage: 'go', dueAt: days(1).toISOString(), endAt: days(5).toISOString() });

    // Without the 20-day item the order is fully determined: due ↑, then endAt ↑ with nulls last (cap not reached).
    const o2 = await seedOrgWithRoles(ctx.app, 'Persona MyWork Order Org');
    const me2 = o2.bidManager.me.user.id;
    const mk2 = async (stage: typeof bidWorkspaces.$inferInsert['stage'], endDays: number | null, w: Partial<typeof bidWorkspaces.$inferInsert>) => {
      const t = await tender(endDays == null ? null : days(endDays));
      const [ws] = await ctx.db.insert(bidWorkspaces).values({ orgId: o2.orgId, tenderId: t.id, stage, ...w }).returning();
      return ws!.id;
    };
    const w1 = await mk2('preparing', 9, { ownerId: me2, dueAt: days(3) });
    const w2 = await mk2('go', 5, { assigneeIds: [me2], dueAt: days(1) });
    const w3 = await mk2('identified', 4, { ownerId: me2 });
    const w4 = await mk2('ready', 2, { assigneeIds: [me2] });
    const w5 = await mk2('analysing', null, { ownerId: me2 });
    const ordered = await dash(o2.bidManager.cookie);
    expect(ordered.myWork!.map((x) => x.workspaceId)).toEqual([w2, w1, w4, w3, w5]);
    expect(ordered.myWork![4]).toMatchObject({ dueAt: null, endAt: null });
    // The owner of the org is neither owner nor assignee on any of them.
    expect((await dash(o2.owner.cookie)).myWork).toEqual([]);
  });

  it('myWork carries readiness: honest 0 % / analysed:false until the tender has a finished analysis', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'Persona Readiness Org');
    const me = o.analyst.me.user.id;
    const t1 = await tender(days(5)), t2 = await tender(days(6));
    await ctx.db.insert(bidWorkspaces).values([
      { orgId: o.orgId, tenderId: t1.id, stage: 'preparing', ownerId: me, dueAt: days(1) },
      { orgId: o.orgId, tenderId: t2.id, stage: 'preparing', ownerId: me, dueAt: days(2) },
    ]);
    await analysis(o.orgId, t1.id);
    const r = await dash(o.analyst.cookie);
    const [first, second] = r.myWork!;
    expect(first!.tenderId).toBe(t1.id);
    expect(first!.readiness).toMatchObject({ analysed: true, blockers: 0 });
    expect(first!.readiness.percent).toBeGreaterThanOrEqual(0);
    expect(second!.readiness).toEqual({ percent: 0, blockers: 0, analysed: false });
  });

  it('awaitingDecision: analysing + done analysis only, oldest first, with score/verdict, max 5', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'Persona Decisions Org');
    const orgId = o.orgId;
    const mk = async (stage: typeof bidWorkspaces.$inferInsert['stage'], updatedAt: Date, a?: Partial<typeof analyses.$inferInsert> | null) => {
      const t = await tender(days(10));
      const [ws] = await ctx.db.insert(bidWorkspaces).values({ orgId, tenderId: t.id, stage, updatedAt }).returning();
      if (a !== null) await analysis(orgId, t.id, { updatedAt, ...a });
      return { t, id: ws!.id };
    };
    const newest = await mk('analysing', days(-1), { score: 55, verdict: 'review' });
    const oldest = await mk('analysing', days(-9), { score: 91, verdict: 'go' });
    const middle = await mk('analysing', days(-4), { score: 20, verdict: 'no_go' });
    await mk('analysing', days(-8), null);                                 // no analysis
    await mk('analysing', days(-7), { status: 'running', score: null, verdict: null }); // not done
    await mk('analysing', days(-6), { status: 'failed', score: null, verdict: null });
    await mk('go', days(-10), { score: 90, verdict: 'go' });               // already decided
    await mk('identified', days(-10), { score: 90, verdict: 'go' });
    const extra = [await mk('analysing', days(-3)), await mk('analysing', days(-2)), await mk('analysing', days(-1.5))]; // 6 eligible in total
    const r = await dash(o.owner.cookie);
    expect(r.awaitingDecision).toHaveLength(5);
    expect(r.awaitingDecision!.map((x) => x.workspaceId)).toEqual([oldest.id, middle.id, extra[0]!.id, extra[1]!.id, extra[2]!.id]);
    expect(r.awaitingDecision![0]).toMatchObject({ tenderId: oldest.t.id, bidNumber: oldest.t.bidNumber, title: oldest.t.title, score: 91, verdict: 'go', endAt: days(10).toISOString() });
    expect(r.awaitingDecision![1]).toMatchObject({ score: 20, verdict: 'no_go' });
    expect(r.awaitingDecision!.some((x) => x.workspaceId === newest.id)).toBe(false); // sixth, cut by the cap
    // Same list for every role (the UI gates the buttons, not the data).
    expect((await dash(o.viewer.cookie)).awaitingDecision!.map((x) => x.workspaceId)).toEqual(r.awaitingDecision!.map((x) => x.workspaceId));
  });

  it('uses the latest analysis for score and verdict', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'Persona Latest Org');
    const t = await tender(days(4));
    await ctx.db.insert(bidWorkspaces).values({ orgId: o.orgId, tenderId: t.id, stage: 'analysing' });
    await analysis(o.orgId, t.id, { score: 30, verdict: 'no_go', createdAt: days(-5) });
    await analysis(o.orgId, t.id, { score: 77, verdict: 'go', createdAt: days(-1) });
    const r = await dash(o.owner.cookie);
    expect(r.awaitingDecision).toHaveLength(1);
    expect(r.awaitingDecision![0]).toMatchObject({ score: 77, verdict: 'go' });
  });

  it('is tenant-isolated: another org sees neither list, even for the same tender and user ids', async () => {
    const a = await seedOrgWithRoles(ctx.app, 'Persona Org A');
    const b = await seedOrgWithRoles(ctx.app, 'Persona Org B');
    const t = await tender(days(3));
    await ctx.db.insert(bidWorkspaces).values({ orgId: a.orgId, tenderId: t.id, stage: 'analysing', ownerId: a.analyst.me.user.id, assigneeIds: [a.analyst.me.user.id, b.analyst.me.user.id] });
    await analysis(a.orgId, t.id);
    expect((await dash(a.analyst.cookie)).myWork).toHaveLength(1);
    expect((await dash(a.owner.cookie)).awaitingDecision).toHaveLength(1);
    for (const who of [b.owner, b.bidManager, b.analyst, b.viewer]) {
      const d = await dash(who.cookie);
      expect(d.myWork).toEqual([]);
      expect(d.awaitingDecision).toEqual([]);
    }
    // Org B has a done analysis for the same tender but no workspace → still nothing; and org A's analysis does not leak a score into B's workspace.
    await analysis(b.orgId, t.id, { score: 11, verdict: 'no_go' });
    await ctx.db.insert(bidWorkspaces).values({ orgId: b.orgId, tenderId: t.id, stage: 'analysing', ownerId: b.analyst.me.user.id });
    const bd = await dash(b.analyst.cookie);
    expect(bd.awaitingDecision![0]).toMatchObject({ score: 11, verdict: 'no_go' });
    expect(bd.myWork![0]!.readiness.analysed).toBe(true);
    expect((await dash(a.owner.cookie)).awaitingDecision![0]).toMatchObject({ score: 82, verdict: 'go' });
  });

  it('works on the demo dataset: owner sees demo bids in both lists', async () => {
    const o = await signup(ctx.app, { orgName: 'Persona Demo Org' });
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: o.cookie })).status).toBe(201);
    const d = await dash(o.cookie);
    expect(d.myWork!.length).toBeGreaterThan(0);
    expect(d.myWork!.length).toBeLessThanOrEqual(5);
    expect(d.awaitingDecision!.length).toBeGreaterThan(0);
    expect(d.awaitingDecision!.every((x) => x.score != null && x.verdict != null)).toBe(true);
  });
});
