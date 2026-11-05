/**
 * Dashboard (T070; US6, FR-030/FR-031) — owned by the Experience team.
 *
 *   GET /dashboard   viewer+   → DashboardResponse (packages/core/src/contracts/experience.ts)
 *
 * Everything is computed with SQL aggregates scoped to the active org (Constitution IV); the only
 * global table read is `tenders` (public GeM data), always joined through the org's matches/workspaces.
 * "Today" and the 14-day trend use IST calendar days.
 */
import { and, count, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  activityLog, analyses, bidWorkspaces, companyProfiles, invitations, memberships, tenderMatches, tenders, users, vaultDocuments,
  watchlists, type Db,
} from '@tp/db';
import type {
  DashboardActivity, DashboardExpiringDoc, DashboardMatch, DashboardResponse, DashboardStage, DashboardTenderRef, DashboardVerdict, SetupStep,
} from '@tp/core/contracts/experience';
import { docStatus, istDate } from '@tp/core/vault/status';
import { visibleTenderSource } from '../lib/tender-scope';
import { orgId, requireAuth } from '../middleware/auth';
import type { AppEnv } from '../types';

export const dashboardRoutes = new Hono<AppEnv>();

const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;
const STAGES: DashboardStage[] = ['identified', 'analysing', 'go', 'preparing', 'ready', 'submitted', 'won', 'lost', 'dropped'];
const CLOSED_STAGES: DashboardStage[] = ['won', 'lost', 'dropped'];

/** UTC instant of IST midnight for the day containing `now`, shifted by `days`. */
export function istMidnight(now: Date, days = 0): Date {
  return new Date(Math.floor((now.getTime() + IST_OFFSET) / DAY) * DAY - IST_OFFSET + days * DAY);
}

const rowsOf = <T>(res: unknown): T[] => (res as { rows: T[] }).rows;
const iso = (d: Date | string | null | undefined) => (d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const num = (v: unknown) => Number(v ?? 0);

async function tenderRefs(db: Db, org: string, ids: string[]): Promise<Map<string, Pick<DashboardTenderRef, 'analysis' | 'workspace'>>> {
  const out = new Map<string, Pick<DashboardTenderRef, 'analysis' | 'workspace'>>();
  if (!ids.length) return out;
  const [an, ws] = await Promise.all([
    db.selectDistinctOn([analyses.tenderId], { tenderId: analyses.tenderId, score: analyses.score, verdict: analyses.verdict })
      .from(analyses).where(and(eq(analyses.orgId, org), inArray(analyses.tenderId, ids), eq(analyses.status, 'done')))
      .orderBy(analyses.tenderId, desc(analyses.createdAt)),
    db.select({ id: bidWorkspaces.id, tenderId: bidWorkspaces.tenderId, stage: bidWorkspaces.stage }).from(bidWorkspaces)
      .where(and(eq(bidWorkspaces.orgId, org), inArray(bidWorkspaces.tenderId, ids))),
  ]);
  for (const id of ids) out.set(id, { analysis: null, workspace: null });
  for (const a of an) out.get(a.tenderId)!.analysis = { score: a.score, verdict: a.verdict };
  for (const w of ws) out.get(w.tenderId)!.workspace = { id: w.id, stage: w.stage };
  return out;
}

const buyerOf = (t: { organisation: string | null; department: string | null; ministry: string | null }) => t.organisation ?? t.department ?? t.ministry;

/** Resolve a readable label + link for activity entries (batched per entity type). */
async function enrichActivity(db: Db, org: string, items: Omit<DashboardActivity, 'target'>[]): Promise<DashboardActivity[]> {
  const ids = (type: string) => [...new Set(items.filter((i) => i.entityType === type && i.entityId).map((i) => i.entityId!))].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const wsIds = ids('workspace'), tIds = ids('tender'), vIds = ids('vault_document'), wlIds = ids('watchlist');
  const [wsRows, tRows, vRows, wlRows] = await Promise.all([
    wsIds.length ? db.select({ id: bidWorkspaces.id, title: tenders.title }).from(bidWorkspaces).innerJoin(tenders, eq(tenders.id, bidWorkspaces.tenderId))
      .where(and(eq(bidWorkspaces.orgId, org), inArray(bidWorkspaces.id, wsIds))) : [],
    tIds.length ? db.select({ id: tenders.id, title: tenders.title }).from(tenders).where(inArray(tenders.id, tIds)) : [],
    vIds.length ? db.select({ id: vaultDocuments.id, title: vaultDocuments.title }).from(vaultDocuments).where(and(eq(vaultDocuments.orgId, org), inArray(vaultDocuments.id, vIds))) : [],
    wlIds.length ? db.select({ id: watchlists.id, title: watchlists.name }).from(watchlists).where(and(eq(watchlists.orgId, org), inArray(watchlists.id, wlIds))) : [],
  ]);
  const ws = new Map(wsRows.map((r) => [r.id, r.title]));
  const ts = new Map(tRows.map((r) => [r.id, r.title]));
  const vs = new Map(vRows.map((r) => [r.id, r.title]));
  const wl = new Map(wlRows.map((r) => [r.id, r.title]));
  return items.map((i) => {
    const id = i.entityId ?? '';
    const metaTitle = typeof i.meta.title === 'string' ? i.meta.title : typeof i.meta.name === 'string' ? i.meta.name : null;
    let target: DashboardActivity['target'] = null;
    if (i.entityType === 'workspace' && ws.has(id)) target = { label: ws.get(id)!, href: `/workspaces/${id}` };
    else if (i.entityType === 'tender' && ts.has(id)) target = { label: ts.get(id)!, href: `/tenders/${id}` };
    else if (i.entityType === 'vault_document') target = { label: vs.get(id) ?? metaTitle ?? 'a document', href: '/vault' };
    else if (i.entityType === 'watchlist') target = { label: wl.get(id) ?? metaTitle ?? 'a watchlist', href: '/watchlists' };
    else if (i.entityType === 'company_profile' || i.action.startsWith('profile.')) target = { label: 'company profile', href: '/profile' };
    else if (i.action.startsWith('member.')) target = { label: typeof i.meta.email === 'string' ? i.meta.email : 'team', href: '/settings/team' };
    else if (metaTitle) target = { label: metaTitle, href: '/dashboard' };
    return { ...i, target };
  });
}

dashboardRoutes.get('/dashboard', requireAuth, async (c) => {
  const { db, clock } = c.var.deps;
  const org = orgId(c);
  const now = clock.now();
  const today = istMidnight(now);
  const yesterday = istMidnight(now, -1);
  const tomorrow = istMidnight(now, 1);
  const trendStart = istMidnight(now, -13);
  const weekEnd = new Date(now.getTime() + 7 * DAY);
  const expiryHorizon = istDate(new Date(now.getTime() + 30 * DAY));

  // Tenders that matter to this org: matched (not dismissed) or in the active pipeline.
  const relevant = sql`(
    exists (select 1 from ${tenderMatches} m where m.tender_id = ${tenders.id} and m.org_id = ${org} and m.dismissed = false)
    or exists (select 1 from ${bidWorkspaces} w where w.tender_id = ${tenders.id} and w.org_id = ${org} and w.stage not in ('won','lost','dropped'))
  )`;
  // Demo tenders only for orgs that loaded the demo (008/FR-016).
  const scope = visibleTenderSource(c.var.org);
  const closingWhere = and(scope, eq(tenders.status, 'open'), isNotNull(tenders.endAt), gte(tenders.endAt, now), lte(tenders.endAt, weekEnd), relevant);

  const [
    [matchCounts], trendRows, pipelineRows, verdictRows, [closingCounts], closingRows, recentRows, expiringRows,
    activityRows, [profile], [setupCounts], [openTenders],
  ] = await Promise.all([
    db.select({
      today: sql<number>`count(distinct ${tenderMatches.tenderId}) filter (where ${tenderMatches.createdAt} >= ${today})`,
      yesterday: sql<number>`count(distinct ${tenderMatches.tenderId}) filter (where ${tenderMatches.createdAt} >= ${yesterday} and ${tenderMatches.createdAt} < ${today})`,
    }).from(tenderMatches).where(and(eq(tenderMatches.orgId, org), eq(tenderMatches.dismissed, false), gte(tenderMatches.createdAt, yesterday))),

    db.execute(sql`
      select to_char((${tenderMatches.createdAt} at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as day, count(distinct ${tenderMatches.tenderId})::int as n
      from ${tenderMatches}
      where ${tenderMatches.orgId} = ${org} and ${tenderMatches.dismissed} = false and ${tenderMatches.createdAt} >= ${trendStart}
      group by 1`),

    db.select({
      stage: bidWorkspaces.stage,
      n: count(),
      value: sql<number>`coalesce(sum(${tenders.estimatedValue}), 0)::bigint`,
      emd: sql<number>`coalesce(sum(${tenders.emdAmount}), 0)::bigint`,
    }).from(bidWorkspaces).innerJoin(tenders, eq(tenders.id, bidWorkspaces.tenderId))
      .where(eq(bidWorkspaces.orgId, org)).groupBy(bidWorkspaces.stage),

    db.execute(sql`
      select verdict, count(*)::int as n from (
        select distinct on (${analyses.tenderId}) ${analyses.verdict} as verdict
        from ${analyses}
        where ${analyses.orgId} = ${org} and ${analyses.status} = 'done'
        order by ${analyses.tenderId}, ${analyses.createdAt} desc
      ) latest where verdict is not null group by verdict`),

    db.select({
      week: count(),
      today: sql<number>`count(*) filter (where ${tenders.endAt} < ${tomorrow})`,
    }).from(tenders).where(closingWhere),

    db.select({
      id: tenders.id, bidNumber: tenders.bidNumber, title: tenders.title, organisation: tenders.organisation, department: tenders.department,
      ministry: tenders.ministry, state: tenders.state, endAt: tenders.endAt, emdAmount: tenders.emdAmount, estimatedValue: tenders.estimatedValue,
    }).from(tenders).where(closingWhere).orderBy(tenders.endAt).limit(8),

    db.select({
      tenderId: tenderMatches.tenderId, reasons: tenderMatches.reasons, matchedAt: tenderMatches.createdAt, seen: tenderMatches.seen,
      watchlistName: watchlists.name, bidNumber: tenders.bidNumber, title: tenders.title, organisation: tenders.organisation,
      department: tenders.department, ministry: tenders.ministry, state: tenders.state, endAt: tenders.endAt, emdAmount: tenders.emdAmount,
      estimatedValue: tenders.estimatedValue,
    }).from(tenderMatches)
      .innerJoin(tenders, eq(tenders.id, tenderMatches.tenderId))
      .innerJoin(watchlists, eq(watchlists.id, tenderMatches.watchlistId))
      .where(and(eq(tenderMatches.orgId, org), eq(tenderMatches.dismissed, false)))
      .orderBy(desc(tenderMatches.createdAt)).limit(20),

    db.select({ id: vaultDocuments.id, title: vaultDocuments.title, type: vaultDocuments.type, expiryDate: vaultDocuments.expiryDate })
      .from(vaultDocuments)
      .where(and(eq(vaultDocuments.orgId, org), isNotNull(vaultDocuments.expiryDate), lte(vaultDocuments.expiryDate, expiryHorizon)))
      .orderBy(vaultDocuments.expiryDate),

    db.select({
      id: activityLog.id, action: activityLog.action, entityType: activityLog.entityType, entityId: activityLog.entityId,
      meta: activityLog.meta, createdAt: activityLog.createdAt, userId: users.id, userName: users.name,
    }).from(activityLog).leftJoin(users, eq(users.id, activityLog.userId))
      .where(eq(activityLog.orgId, org)).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(15),

    db.select({ legalName: companyProfiles.legalName, gstin: companyProfiles.gstin, categories: companyProfiles.categories })
      .from(companyProfiles).where(eq(companyProfiles.orgId, org)),

    db.select({
      watchlists: sql<number>`(select count(*)::int from ${watchlists} where ${watchlists.orgId} = ${org})`,
      vault: sql<number>`(select count(*)::int from ${vaultDocuments} where ${vaultDocuments.orgId} = ${org})`,
      members: sql<number>`(select count(*)::int from ${memberships} where ${memberships.orgId} = ${org})`,
      invites: sql<number>`(select count(*)::int from ${invitations} where ${invitations.orgId} = ${org} and ${invitations.acceptedAt} is null and ${invitations.expiresAt} > ${now})`,
      analyses: sql<number>`(select count(*)::int from ${analyses} where ${analyses.orgId} = ${org} and ${analyses.status} = 'done')`,
      analysesWeek: sql<number>`(select count(*)::int from ${analyses} where ${analyses.orgId} = ${org} and ${analyses.status} = 'done' and ${analyses.createdAt} >= ${new Date(now.getTime() - 7 * DAY)})`,
    }).from(sql`(select 1) as one`),

    db.select({ n: count() }).from(tenders).where(and(scope, eq(tenders.status, 'open'), sql`(${tenders.endAt} is null or ${tenders.endAt} >= ${now})`)),
  ]);

  // Pipeline
  const pipeline = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<DashboardStage, number>;
  const pipelineValue = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<DashboardStage, number>;
  let emdAtStake = 0;
  for (const r of pipelineRows) {
    pipeline[r.stage] = num(r.n);
    pipelineValue[r.stage] = num(r.value);
    if (!CLOSED_STAGES.includes(r.stage)) emdAtStake += num(r.emd);
  }
  const activeBids = STAGES.filter((s) => !CLOSED_STAGES.includes(s)).reduce((a, s) => a + pipeline[s], 0);
  const won = pipeline.won, lost = pipeline.lost;

  // Verdicts
  const verdicts: Record<DashboardVerdict, number> = { go: 0, review: 0, no_go: 0 };
  for (const r of rowsOf<{ verdict: DashboardVerdict; n: number }>(verdictRows)) verdicts[r.verdict] = num(r.n);

  // Trend (fill missing days)
  const byDay = new Map(rowsOf<{ day: string; n: number }>(trendRows).map((r) => [r.day, num(r.n)]));
  const matchesByDay = Array.from({ length: 14 }, (_, i) => {
    const date = istDate(new Date(trendStart.getTime() + i * DAY + IST_OFFSET / 2));
    return { date, count: byDay.get(date) ?? 0 };
  });

  // Closing soon + recent matches share tender enrichment
  const recentUnique: typeof recentRows = [];
  const seenT = new Set<string>();
  for (const r of recentRows) {
    if (seenT.has(r.tenderId)) continue;
    seenT.add(r.tenderId);
    recentUnique.push(r);
    if (recentUnique.length === 6) break;
  }
  const refs = await tenderRefs(db, org, [...new Set([...closingRows.map((t) => t.id), ...recentUnique.map((r) => r.tenderId)])]);
  const closingSoon: DashboardTenderRef[] = closingRows.map((t) => ({
    id: t.id, bidNumber: t.bidNumber, title: t.title, buyer: buyerOf(t), state: t.state, endAt: iso(t.endAt),
    emdAmount: t.emdAmount, estimatedValue: t.estimatedValue, ...refs.get(t.id)!,
  }));
  const recentMatches: DashboardMatch[] = recentUnique.map((r) => ({
    id: r.tenderId, bidNumber: r.bidNumber, title: r.title, buyer: buyerOf(r), state: r.state, endAt: iso(r.endAt),
    emdAmount: r.emdAmount, estimatedValue: r.estimatedValue, ...refs.get(r.tenderId)!,
    watchlistName: r.watchlistName, reasons: r.reasons ?? [], matchedAt: iso(r.matchedAt)!, isNew: !r.seen,
  }));

  // Expiring documents
  const expiringDocuments: DashboardExpiringDoc[] = expiringRows.map((d) => {
    const s = docStatus(d.expiryDate, now);
    return { id: d.id, title: d.title, type: d.type, expiryDate: d.expiryDate!, daysToExpiry: s.daysToExpiry ?? 0, status: s.status === 'expired' ? 'expired' : 'expiring' };
  });
  const expiredDocs = expiringDocuments.filter((d) => d.status === 'expired').length;

  // Activity
  const activity = await enrichActivity(db, org, activityRows.map((r) => ({
    id: r.id, action: r.action, entityType: r.entityType, entityId: r.entityId, meta: r.meta ?? {},
    createdAt: r.createdAt.toISOString(), user: r.userId ? { id: r.userId, name: r.userName ?? '' } : null,
  })));

  // Setup checklist (US7: skipped onboarding steps stay visible here)
  const sc = setupCounts!;
  const setup: SetupStep[] = [
    { key: 'company', label: 'Add company basics', description: 'Legal name and GSTIN power annexures and eligibility checks.', done: !!(profile?.legalName?.trim() && profile.gstin), href: '/profile' },
    { key: 'categories', label: 'Tell us what you sell', description: 'Categories and HSN codes sharpen your matches.', done: (profile?.categories?.length ?? 0) > 0, href: '/profile' },
    { key: 'watchlist', label: 'Create a watchlist', description: 'Get alerts the moment a matching bid is published.', done: num(sc.watchlists) > 0, href: '/watchlists?new=1' },
    { key: 'documents', label: 'Upload key documents', description: 'GST, PAN and Udyam — the basics every bid asks for.', done: num(sc.vault) >= 3, href: '/vault?upload=1' },
    { key: 'analysis', label: 'Check eligibility on a tender', description: 'Get a Go/No-Go score with the reasons behind it.', done: num(sc.analyses) > 0, href: '/tenders?matched=1' },
    { key: 'team', label: 'Invite a teammate', description: 'Bid managers, analysts and compliance can work together.', done: num(sc.members) > 1 || num(sc.invites) > 0, href: '/settings/team' },
  ];

  // FR-007: a demo org (the sample company has no teammates) is not held back by the team step; its own
  // `done` stays honest. Non-demo orgs need every step, team included (US3-12).
  const demo = !!c.var.org.onboardingState?.demo;
  const setupComplete = setup.filter((s) => !(demo && s.key === 'team')).every((s) => s.done);

  const body: DashboardResponse = {
    generatedAt: now.toISOString(),
    tiles: {
      newMatchesToday: num(matchCounts?.today),
      closingThisWeek: num(closingCounts?.week),
      activeBids,
      emdAtStake,
      winRate: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null,
      expiringDocs: expiringDocuments.length,
    },
    stats: {
      newMatchesYesterday: num(matchCounts?.yesterday),
      closingToday: num(closingCounts?.today),
      won, lost, expiredDocs,
      analysesThisWeek: num(sc.analysesWeek),
      openTenders: num(openTenders?.n),
    },
    closingSoon,
    pipeline,
    pipelineValue,
    verdicts,
    matchesByDay,
    recentMatches,
    expiringDocuments: expiringDocuments.slice(0, 6),
    activity,
    setup,
    setupComplete,
    demo,
  };
  return c.json(body);
});
