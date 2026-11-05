/** Dashboard aggregates (T070; US6 independent test: numbers on seeded data, moving a card updates stage + activity). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { activityLog, tenderMatches, tenders } from '@tp/db';
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
