/**
 * Tenders feed (T036; FR-003, FR-006): list with filters + facets, detail, seen / dismiss.
 * Tenders are global public GeM data; everything org-specific (matches, analyses, workspaces,
 * seen/dismissed) is joined and filtered by the caller's org (Constitution IV).
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  analyses, bidWorkspaces, notifications, tenderDocuments, tenderEvents, tenderMatches, tenders, watchlists,
} from '@tp/db';
import { tenderQuerySchema, type Facet, type TenderListItem, type TenderQuery } from '@tp/core/contracts/identify';
import { uuidSchema } from '@tp/core/contracts/common';
import type { AppDeps } from '../deps';
import { conflict, notFound } from '../lib/errors';
import { canSeeTender, visibleTenderSource } from '../lib/tender-scope';
import { parseWith } from '../lib/validate';
import { orgId, requireAuth, userId } from '../middleware/auth';
import type { AppEnv } from '../types';

export const tendersRoutes = new Hono<AppEnv>();

type TenderRow = typeof tenders.$inferSelect;

/** Public tender fields (no raw payload / hash). */
export function tenderCore(t: TenderRow) {
  const { raw: _raw, contentHash: _hash, ...rest } = t;
  return rest;
}

/** Read the query string, keeping repeated keys as arrays. */
export function rawQuery(c: Context): Record<string, string | string[]> {
  const all = c.req.queries();
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(all)) out[k] = v.length > 1 ? v : v[0];
  return out;
}

const NEW_WINDOW_MS = 7 * 86_400_000;

/**
 * Build WHERE conditions for GET /tenders (optionally omitting one facet's own filter). `scope` is the org's
 * visible-source filter (lib/tender-scope.ts): demo tenders only for orgs that loaded the demo (008/FR-016).
 */
function buildFilters(q: TenderQuery, org: string, now: Date, scope: SQL, omit?: 'state' | 'ministry' | 'category'): SQL[] {
  const conds: SQL[] = [scope];
  const status = q.status ?? 'open';
  if (status !== 'all') conds.push(eq(tenders.status, status));
  if (status === 'open') conds.push(or(isNull(tenders.endAt), gte(tenders.endAt, now))!);
  if (q.q) {
    for (const word of q.q.split(/\s+/).filter(Boolean).slice(0, 8)) {
      const like = `%${word.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      conds.push(or(
        ilike(tenders.title, like), ilike(tenders.bidNumber, like), ilike(tenders.category, like),
        ilike(tenders.ministry, like), ilike(tenders.department, like), ilike(tenders.organisation, like),
        ilike(tenders.buyerOffice, like), ilike(tenders.state, like), ilike(tenders.city, like),
        sql`${tenders.items}::text ilike ${like}`,
      )!);
    }
  }
  if (omit !== 'state' && q.state.length) conds.push(inArray(tenders.state, q.state));
  if (omit !== 'ministry' && q.ministry.length) conds.push(inArray(tenders.ministry, q.ministry));
  if (omit !== 'category' && q.category.length) conds.push(inArray(tenders.category, q.category));
  if (q.bidType.length) conds.push(inArray(tenders.bidType, q.bidType));
  if (q.closingWithinDays !== undefined) {
    conds.push(isNotNull(tenders.endAt), gte(tenders.endAt, now), lte(tenders.endAt, new Date(now.getTime() + q.closingWithinDays * 86_400_000)));
  }
  if (q.minValue !== undefined) conds.push(gte(tenders.estimatedValue, Math.round(q.minValue)));
  if (q.maxValue !== undefined) conds.push(lte(tenders.estimatedValue, Math.round(q.maxValue)));

  const matchExists = (extra: SQL = sql`true`) =>
    sql`exists (select 1 from ${tenderMatches} m where m.org_id = ${org} and m.tender_id = ${tenders.id} and ${extra})`;
  if (q.matched === true) conds.push(matchExists(sql`m.dismissed = false`));
  if (q.matched === false) conds.push(sql`not ${matchExists()}`);
  if (q.watchlistId) conds.push(matchExists(sql`m.watchlist_id = ${q.watchlistId}`));
  if (q.unseen) conds.push(matchExists(sql`m.seen = false and m.dismissed = false`));
  if (!q.includeDismissed) {
    // Hide tenders this org dismissed (all their matches dismissed).
    conds.push(sql`not exists (select 1 from ${tenderMatches} m where m.org_id = ${org} and m.tender_id = ${tenders.id} and m.dismissed = true)`);
  }
  if (q.verdict.length) {
    const named = q.verdict.filter((v) => v !== 'none');
    const parts: SQL[] = [];
    if (named.length) {
      parts.push(sql`(select a.verdict from ${analyses} a where a.org_id = ${org} and a.tender_id = ${tenders.id} order by a.created_at desc limit 1) in (${sql.join(named.map((v) => sql`${v}`), sql`, `)})`);
    }
    if (q.verdict.includes('none')) parts.push(sql`not exists (select 1 from ${analyses} a where a.org_id = ${org} and a.tender_id = ${tenders.id})`);
    conds.push(or(...parts)!);
  }
  if (q.stage.length) {
    conds.push(sql`exists (select 1 from ${bidWorkspaces} w where w.org_id = ${org} and w.tender_id = ${tenders.id} and w.stage in (${sql.join(q.stage.map((s) => sql`${s}`), sql`, `)}))`);
  }
  return conds;
}

function orderBy(q: TenderQuery, org: string): SQL[] {
  const score = sql`(select a.score from ${analyses} a where a.org_id = ${org} and a.tender_id = ${tenders.id} and a.status = 'done' order by a.created_at desc limit 1)`;
  const relevance = sql`(select max(m.relevance) from ${tenderMatches} m where m.org_id = ${org} and m.tender_id = ${tenders.id})`;
  switch (q.sort) {
    case 'endAt': return [sql`${tenders.endAt} asc nulls last`, desc(tenders.createdAt)];
    case '-endAt': return [sql`${tenders.endAt} desc nulls last`, desc(tenders.createdAt)];
    case 'score': return [sql`${score} desc nulls last`, asc(tenders.endAt)];
    case '-score': return [sql`${score} asc nulls last`, asc(tenders.endAt)];
    case 'value': return [sql`${tenders.estimatedValue} desc nulls last`, asc(tenders.endAt)];
    case '-value': return [sql`${tenders.estimatedValue} asc nulls last`, asc(tenders.endAt)];
    case 'relevance': return [sql`${relevance} desc nulls last`, asc(tenders.endAt)];
    case '-createdAt':
    default: return [desc(tenders.createdAt), sql`${tenders.endAt} asc nulls last`, desc(tenders.bidNumber)];
  }
}

/** Attach org-specific data (matches, analysis, workspace, seen/new) to tender rows. */
export async function decorateTenders(deps: AppDeps, org: string, rows: TenderRow[]): Promise<TenderListItem[]> {
  if (!rows.length) return [];
  const { db, clock } = deps;
  const ids = rows.map((r) => r.id);
  const now = clock.now();
  const [matchRows, analysisRows, wsRows, corrRows] = await Promise.all([
    db.select({
      tenderId: tenderMatches.tenderId, watchlistId: tenderMatches.watchlistId, watchlistName: watchlists.name,
      reasons: tenderMatches.reasons, relevance: tenderMatches.relevance, seen: tenderMatches.seen,
      dismissed: tenderMatches.dismissed, createdAt: tenderMatches.createdAt,
    }).from(tenderMatches).innerJoin(watchlists, eq(watchlists.id, tenderMatches.watchlistId))
      .where(and(eq(tenderMatches.orgId, org), inArray(tenderMatches.tenderId, ids)))
      .orderBy(desc(tenderMatches.relevance)),
    db.selectDistinctOn([analyses.tenderId], { tenderId: analyses.tenderId, id: analyses.id, score: analyses.score, verdict: analyses.verdict, stale: analyses.stale })
      .from(analyses).where(and(eq(analyses.orgId, org), eq(analyses.status, 'done'), inArray(analyses.tenderId, ids)))
      .orderBy(analyses.tenderId, desc(analyses.createdAt)),
    db.select({ tenderId: bidWorkspaces.tenderId, id: bidWorkspaces.id, stage: bidWorkspaces.stage })
      .from(bidWorkspaces).where(and(eq(bidWorkspaces.orgId, org), inArray(bidWorkspaces.tenderId, ids))),
    db.selectDistinct({ tenderId: tenderEvents.tenderId }).from(tenderEvents)
      .where(and(inArray(tenderEvents.tenderId, ids), eq(tenderEvents.kind, 'corrigendum'), gte(tenderEvents.createdAt, new Date(now.getTime() - NEW_WINDOW_MS)))),
  ]);
  const byTender = new Map<string, typeof matchRows>();
  for (const m of matchRows) byTender.set(m.tenderId, [...(byTender.get(m.tenderId) ?? []), m]);
  const aBy = new Map(analysisRows.map((a) => [a.tenderId, a]));
  const wBy = new Map(wsRows.map((w) => [w.tenderId, w]));
  const corr = new Set(corrRows.map((r) => r.tenderId));

  return rows.map((t) => {
    const ms = byTender.get(t.id) ?? [];
    const a = aBy.get(t.id);
    const w = wBy.get(t.id);
    const seen = ms.length === 0 || ms.some((m) => m.seen);
    const dismissed = ms.length > 0 && ms.every((m) => m.dismissed);
    return {
      ...(tenderCore(t) as unknown as Omit<TenderListItem, 'matches' | 'analysis' | 'workspace' | 'seen' | 'isNew' | 'dismissed' | 'hasCorrigendum'>),
      matches: ms.map((m) => ({ watchlistId: m.watchlistId, watchlistName: m.watchlistName, reasons: m.reasons, relevance: m.relevance, createdAt: m.createdAt.toISOString() })),
      analysis: a ? { id: a.id, score: a.score, verdict: a.verdict, stale: a.stale } : null,
      workspace: w ? { id: w.id, stage: w.stage } : null,
      seen,
      isNew: !seen && !dismissed && ms.some((m) => now.getTime() - m.createdAt.getTime() < NEW_WINDOW_MS),
      dismissed,
      hasCorrigendum: corr.has(t.id),
    };
  });
}

async function facet(deps: AppDeps, column: typeof tenders.state | typeof tenders.ministry | typeof tenders.category, conds: SQL[]): Promise<Facet[]> {
  const rows = await deps.db.select({ value: column, count: sql<number>`count(*)::int` })
    .from(tenders).where(and(isNotNull(column), ...conds)).groupBy(column).orderBy(desc(sql`count(*)`), asc(column)).limit(60);
  return rows.map((r) => ({ value: String(r.value), count: Number(r.count) }));
}

/** GET /tenders */
tendersRoutes.get('/tenders', requireAuth, async (c) => {
  const deps = c.var.deps;
  const q = parseWith(tenderQuerySchema, rawQuery(c), 'query');
  const org = orgId(c);
  const now = deps.clock.now();
  const scope = visibleTenderSource(c.var.org);
  const where = and(...buildFilters(q, org, now, scope));
  const offset = (q.page - 1) * q.pageSize;

  const [rows, [{ total }], states, ministries, categories] = await Promise.all([
    deps.db.select().from(tenders).where(where).orderBy(...orderBy(q, org)).limit(q.pageSize).offset(offset),
    deps.db.select({ total: sql<number>`count(*)::int` }).from(tenders).where(where),
    facet(deps, tenders.state, buildFilters(q, org, now, scope, 'state')),
    facet(deps, tenders.ministry, buildFilters(q, org, now, scope, 'ministry')),
    facet(deps, tenders.category, buildFilters(q, org, now, scope, 'category')),
  ]);
  const items = await decorateTenders(deps, org, rows);
  return c.json({ items, total: Number(total), facets: { states, ministries, categories } });
});

async function loadTender(c: Context<AppEnv>): Promise<TenderRow> {
  const id = c.req.param('id');
  if (!uuidSchema.safeParse(id).success) throw notFound('Tender');
  const [t] = await c.var.deps.db.select().from(tenders).where(eq(tenders.id, id!));
  // Demo tenders do not exist for orgs that never loaded the demo (008/FR-016).
  if (!t || !canSeeTender(c.var.org, t)) throw notFound('Tender');
  return t;
}

/** GET /tenders/:id */
tendersRoutes.get('/tenders/:id', requireAuth, async (c) => {
  const deps = c.var.deps;
  const org = orgId(c);
  const t = await loadTender(c);
  const [[item], events, docs, [analysis]] = await Promise.all([
    decorateTenders(deps, org, [t]),
    deps.db.select().from(tenderEvents).where(eq(tenderEvents.tenderId, t.id)).orderBy(desc(tenderEvents.createdAt)).limit(50),
    deps.db.select().from(tenderDocuments)
      .where(and(eq(tenderDocuments.tenderId, t.id), or(isNull(tenderDocuments.orgId), eq(tenderDocuments.orgId, org))))
      .orderBy(desc(tenderDocuments.createdAt)),
    deps.db.select().from(analyses).where(and(eq(analyses.orgId, org), eq(analyses.tenderId, t.id), eq(analyses.status, 'done'))).orderBy(desc(analyses.createdAt)).limit(1),
  ]);
  return c.json({
    ...item,
    events: events.map((e) => ({ id: e.id, kind: e.kind, changes: e.changes, createdAt: e.createdAt })),
    documents: docs.map((d) => ({
      id: d.id, kind: d.kind, fileName: d.fileName, sizeBytes: d.sizeBytes, pageCount: d.pageCount,
      sourceUrl: d.sourceUrl, orgOwned: d.orgId !== null, createdAt: d.createdAt,
    })),
    analysisDetail: analysis ?? null,
  });
});

/** POST /tenders/:id/seen — mark this org's matches seen and clear related in-app alerts for the user. */
tendersRoutes.post('/tenders/:id/seen', requireAuth, async (c) => {
  const deps = c.var.deps;
  const t = await loadTender(c);
  const org = orgId(c);
  await deps.db.update(tenderMatches).set({ seen: true }).where(and(eq(tenderMatches.orgId, org), eq(tenderMatches.tenderId, t.id)));
  await deps.db.update(notifications).set({ status: 'read', readAt: deps.clock.now() })
    .where(and(eq(notifications.orgId, org), eq(notifications.userId, userId(c)), eq(notifications.channel, 'in_app'),
      eq(notifications.link, `/tenders/${t.id}`), ne(notifications.status, 'read')));
  return c.json({ ok: true });
});

/** POST /tenders/:id/dismiss `{undo?: boolean}` — hide a matched tender from this org's feed. */
tendersRoutes.post('/tenders/:id/dismiss', requireAuth, async (c) => {
  const deps = c.var.deps;
  const t = await loadTender(c);
  const org = orgId(c);
  let undo = false;
  try { undo = !!(JSON.parse((await c.req.text()) || '{}') as { undo?: boolean }).undo; } catch { /* empty body */ }
  const updated = await deps.db.update(tenderMatches).set({ dismissed: !undo, seen: true })
    .where(and(eq(tenderMatches.orgId, org), eq(tenderMatches.tenderId, t.id))).returning({ id: tenderMatches.id });
  if (!updated.length) throw conflict('Only tenders that match one of your watchlists can be dismissed');
  return c.json({ ok: true, dismissed: !undo });
});
