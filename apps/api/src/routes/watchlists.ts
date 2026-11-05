/**
 * Watchlists (T036; FR-003, FR-004): CRUD, pause/resume, live preview.
 * Creating / changing a watchlist back-fills matches against currently open tenders silently
 * (no alert storm); alerts fire only for tenders ingested afterwards.
 */
import { and, desc, eq, gte, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { tenderMatches, tenders, users, watchlists, type WatchlistCriteria } from '@tp/db';
import {
  criteriaIsEmpty, watchlistCreateSchema, watchlistPreviewSchema, watchlistUpdateSchema, type WatchlistCriteriaDto, type WatchlistDto,
} from '@tp/core/contracts/identify';
import { uuidSchema } from '@tp/core/contracts/common';
import { matchTender } from '@tp/core/match/matcher';
import type { AppDeps } from '../deps';
import { logActivity } from '../lib/activity';
import { notFound, validationError } from '../lib/errors';
import { parseJson } from '../lib/validate';
import { orgId, requireAuth, requireRole, userId } from '../middleware/auth';
import { matchAndNotify } from '../services/ingest';
import type { AppEnv } from '../types';
import { decorateTenders } from './tenders';

export const watchlistsRoutes = new Hono<AppEnv>();

type TenderRow = typeof tenders.$inferSelect;
const CANDIDATE_LIMIT = 5000;

/**
 * Open tenders that could match the criteria: a cheap SQL pre-filter (state, value, keyword ILIKE)
 * followed by the exact matcher in JS.
 */
export async function candidateTenders(deps: AppDeps, criteria: WatchlistCriteriaDto): Promise<{ row: TenderRow; reasons: string[]; relevance: number }[]> {
  const now = deps.clock.now();
  const conds: SQL[] = [eq(tenders.status, 'open'), or(isNull(tenders.endAt), gte(tenders.endAt, now))!];
  if (criteria.states.length) conds.push(inArray(tenders.state, criteria.states));
  if (criteria.minValue != null) conds.push(or(isNull(tenders.estimatedValue), gte(tenders.estimatedValue, criteria.minValue))!);
  if (criteria.maxValue != null) conds.push(or(isNull(tenders.estimatedValue), sql`${tenders.estimatedValue} <= ${criteria.maxValue}`)!);
  if (criteria.bidTypes.length) conds.push(inArray(tenders.bidType, criteria.bidTypes));
  if (criteria.keywords.length) {
    const ors: SQL[] = [];
    for (const kw of criteria.keywords) {
      const like = `%${kw.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      ors.push(ilike(tenders.title, like), ilike(tenders.category, like), ilike(tenders.department, like), ilike(tenders.ministry, like),
        ilike(tenders.organisation, like), ilike(tenders.buyerOffice, like), sql`${tenders.items}::text ilike ${like}`);
    }
    conds.push(or(...ors)!);
  }
  const rows = await deps.db.select().from(tenders).where(and(...conds)).orderBy(desc(tenders.createdAt)).limit(CANDIDATE_LIMIT);
  const out: { row: TenderRow; reasons: string[]; relevance: number }[] = [];
  for (const row of rows) {
    const r = matchTender(row, criteria, { now });
    if (r.matched) out.push({ row, reasons: r.reasons, relevance: r.relevance });
  }
  return out;
}

/** Re-evaluate a watchlist's matches: drop ones that no longer match, add new ones (no alerts). */
async function refreshMatches(deps: AppDeps, w: typeof watchlists.$inferSelect): Promise<number> {
  const now = deps.clock.now();
  const existing = await deps.db.select({ id: tenderMatches.id, tenderId: tenderMatches.tenderId }).from(tenderMatches)
    .where(eq(tenderMatches.watchlistId, w.id));
  if (existing.length) {
    const rows = await deps.db.select().from(tenders).where(inArray(tenders.id, existing.map((e) => e.tenderId)));
    const stillMatching = new Set(rows.filter((t) => matchTender(t, w.criteria, { now: new Date(0) }).matched || t.status !== 'open').map((t) => t.id));
    const stale = existing.filter((e) => !stillMatching.has(e.tenderId)).map((e) => e.id);
    if (stale.length) await deps.db.delete(tenderMatches).where(inArray(tenderMatches.id, stale));
  }
  if (!w.active) return 0;
  const cands = await candidateTenders(deps, w.criteria as WatchlistCriteriaDto);
  const r = await matchAndNotify(deps, cands.map((c) => c.row.id), now, { watchlistId: w.id, notify: false });
  return r.matchesCreated;
}

async function serialize(deps: AppDeps, org: string, rows: (typeof watchlists.$inferSelect)[]): Promise<WatchlistDto[]> {
  if (!rows.length) return [];
  const now = deps.clock.now();
  const ids = rows.map((r) => r.id);
  const [stats, creators] = await Promise.all([
    deps.db.select({
      watchlistId: tenderMatches.watchlistId,
      matchCount: sql<number>`count(*)::int`,
      newThisWeek: sql<number>`count(*) filter (where ${tenderMatches.createdAt} >= ${new Date(now.getTime() - 7 * 86_400_000)})::int`,
      openCount: sql<number>`count(*) filter (where ${tenders.status} = 'open' and (${tenders.endAt} is null or ${tenders.endAt} >= ${now}))::int`,
      lastMatchAt: sql<Date | null>`max(${tenderMatches.createdAt})`,
    }).from(tenderMatches).innerJoin(tenders, eq(tenders.id, tenderMatches.tenderId))
      .where(and(eq(tenderMatches.orgId, org), inArray(tenderMatches.watchlistId, ids)))
      .groupBy(tenderMatches.watchlistId),
    deps.db.select({ id: users.id, name: users.name }).from(users)
      .where(inArray(users.id, rows.map((r) => r.createdBy).filter((x): x is string => !!x).concat(['00000000-0000-0000-0000-000000000000']))),
  ]);
  const sBy = new Map(stats.map((s) => [s.watchlistId, s]));
  const uBy = new Map(creators.map((u) => [u.id, u]));
  return rows.map((w) => {
    const s = sBy.get(w.id);
    const last = s?.lastMatchAt ? new Date(s.lastMatchAt as unknown as string) : null;
    return {
      id: w.id, name: w.name, criteria: w.criteria as WatchlistCriteriaDto, active: w.active,
      createdBy: w.createdBy ? uBy.get(w.createdBy) ?? null : null,
      createdAt: w.createdAt.toISOString(), updatedAt: w.updatedAt.toISOString(),
      matchCount: Number(s?.matchCount ?? 0), newThisWeek: Number(s?.newThisWeek ?? 0), openCount: Number(s?.openCount ?? 0),
      lastMatchAt: last ? last.toISOString() : null,
    };
  });
}

async function loadOwn(deps: AppDeps, org: string, id: string | undefined) {
  if (!id || !uuidSchema.safeParse(id).success) throw notFound('Watchlist');
  const [w] = await deps.db.select().from(watchlists).where(and(eq(watchlists.id, id), eq(watchlists.orgId, org)));
  if (!w) throw notFound('Watchlist');
  return w;
}

const requireCriteria = (c: WatchlistCriteriaDto) => {
  if (criteriaIsEmpty(c)) {
    throw validationError('Add at least one keyword, category, HSN code, state, buyer, value limit or bid type', { fields: { criteria: 'Add at least one criterion' } });
  }
};

watchlistsRoutes.get('/watchlists', requireAuth, async (c) => {
  const deps = c.var.deps;
  const org = orgId(c);
  const rows = await deps.db.select().from(watchlists).where(eq(watchlists.orgId, org)).orderBy(desc(watchlists.active), desc(watchlists.createdAt));
  const items = await serialize(deps, org, rows);
  return c.json({ items, total: items.length });
});

watchlistsRoutes.post('/watchlists/preview', requireAuth, async (c) => {
  const deps = c.var.deps;
  const { criteria } = await parseJson(c, watchlistPreviewSchema);
  if (criteriaIsEmpty(criteria)) return c.json({ count: 0, sample: [] });
  const cands = await candidateTenders(deps, criteria);
  cands.sort((a, b) => b.relevance - a.relevance || (a.row.endAt?.getTime() ?? 0) - (b.row.endAt?.getTime() ?? 0));
  const sample = await decorateTenders(deps, orgId(c), cands.slice(0, 5).map((x) => x.row));
  // Show the reasons this *draft* would produce.
  const reasonBy = new Map(cands.map((x) => [x.row.id, x.reasons]));
  return c.json({ count: cands.length, sample: sample.map((s) => ({ ...s, previewReasons: reasonBy.get(s.id) ?? [] })) });
});

watchlistsRoutes.post('/watchlists', requireRole('analyst'), async (c) => {
  const deps = c.var.deps;
  const body = await parseJson(c, watchlistCreateSchema);
  requireCriteria(body.criteria);
  const org = orgId(c);
  const now = deps.clock.now();
  const [w] = await deps.db.insert(watchlists).values({
    orgId: org, name: body.name, criteria: body.criteria as WatchlistCriteria, active: body.active ?? true,
    createdBy: userId(c), createdAt: now, updatedAt: now,
  }).returning();
  const matched = await refreshMatches(deps, w);
  await logActivity(deps.db, { orgId: org, userId: userId(c), action: 'watchlist.created', entityType: 'watchlist', entityId: w.id, meta: { name: w.name, matched } });
  const [dto] = await serialize(deps, org, [w]);
  return c.json(dto, 201);
});

watchlistsRoutes.patch('/watchlists/:id', requireRole('analyst'), async (c) => {
  const deps = c.var.deps;
  const org = orgId(c);
  const w = await loadOwn(deps, org, c.req.param('id'));
  const body = await parseJson(c, watchlistUpdateSchema);
  if (body.criteria) requireCriteria(body.criteria);
  const [updated] = await deps.db.update(watchlists).set({
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.criteria ? { criteria: body.criteria as WatchlistCriteria } : {}),
    ...(body.active !== undefined ? { active: body.active } : {}),
    updatedAt: deps.clock.now(),
  }).where(and(eq(watchlists.id, w.id), eq(watchlists.orgId, org))).returning();
  if (body.criteria || (body.active === true && !w.active)) await refreshMatches(deps, updated);
  const action = body.active === false ? 'watchlist.paused' : body.active === true && !w.active ? 'watchlist.resumed' : 'watchlist.updated';
  await logActivity(deps.db, { orgId: org, userId: userId(c), action, entityType: 'watchlist', entityId: w.id, meta: { name: updated.name } });
  const [dto] = await serialize(deps, org, [updated]);
  return c.json(dto);
});

watchlistsRoutes.delete('/watchlists/:id', requireRole('analyst'), async (c) => {
  const deps = c.var.deps;
  const org = orgId(c);
  const w = await loadOwn(deps, org, c.req.param('id'));
  await deps.db.delete(watchlists).where(and(eq(watchlists.id, w.id), eq(watchlists.orgId, org)));
  await logActivity(deps.db, { orgId: org, userId: userId(c), action: 'watchlist.deleted', entityType: 'watchlist', entityId: w.id, meta: { name: w.name } });
  return c.json({ ok: true });
});
