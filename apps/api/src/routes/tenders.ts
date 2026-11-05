/**
 * Tenders feed (T036; FR-003, FR-006): list with filters + facets, detail, seen / dismiss.
 * Tenders are global public GeM data; everything org-specific (matches, analyses, workspaces,
 * seen/dismissed) is joined and filtered by the caller's org (Constitution IV).
 */
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  analyses, bidWorkspaces, notifications, tenderDocuments, tenderEvents, tenderMatches, tenderResults, tenders, watchlists,
} from '@tp/db';
import {
  EVALUATION_STATUS_LABEL, RESULT_CHECK_DAYS, tenderQuerySchema,
  type Facet, type TenderListItem, type TenderQuery, type TenderResultDto,
} from '@tp/core/contracts/identify';
import { detectAnomalies } from '@tp/core/gem/result';
import { uuidSchema } from '@tp/core/contracts/common';
import type { AppDeps } from '../deps';
import { conflict, notFound } from '../lib/errors';
import { canSeeTender, DEMO_SOURCE, visibleTenderSource } from '../lib/tender-scope';
import { tenderSearchCondition } from '../lib/tender-search';
import { parseWith } from '../lib/validate';
import { orgId, requireAuth, userId } from '../middleware/auth';
import type { AppEnv } from '../types';

export const tendersRoutes = new Hono<AppEnv>();

type TenderRow = typeof tenders.$inferSelect;

/**
 * 008/FR-028: the one projection every tender LIST reads (feed, watchlist preview/back-fill, dashboard). It never
 * includes `raw` (the full GeM payload) or `content_hash`; document text lives in `tender_documents` and is never
 * joined here. `items` stays — the list DTO shows it.
 */
const { raw: _rawColumn, contentHash: _hashColumn, ...listColumns } = getTableColumns(tenders);
export const tenderListColumns = listColumns;
export type TenderListRow = Omit<TenderRow, 'raw' | 'contentHash'>;

/** Demo tenders are marked `raw.demo = true` by the seed (007/FR-067). */
export function isDemoTender(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as { demo?: unknown }).demo === true;
}

/**
 * Public tender fields (no raw payload / hash) plus `isDemo` (007/FR-067). Demo tenders are stored with
 * `source = 'demo'` (packages/db/src/demo.ts); list rows carry no `raw` (FR-028), and a row with `raw.demo` under
 * another source is never listed (lib/tender-scope.ts), so `source` decides there; a full row also honours `raw.demo`.
 */
export function tenderCore(t: TenderListRow | TenderRow) {
  const { raw, contentHash: _hash, ...rest } = t as TenderRow;
  return { ...rest, isDemo: t.source === DEMO_SOURCE || isDemoTender(raw) };
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
  if (status === 'closed') conds.push(or(eq(tenders.status, 'closed'), and(eq(tenders.status, 'open'), lt(tenders.endAt, now)))!);
  // `status = 'open'` as a literal, exactly the open-tender partial indexes' predicate, so the planner can prove the
  // index applies even under a generic (parameter-agnostic) plan, e.g. behind a statement-caching pooler (008/FR-027).
  else if (status === 'open') conds.push(sql`${tenders.status} = 'open'`);
  else if (status !== 'all') conds.push(eq(tenders.status, status));
  // Same as `end_at IS NULL OR end_at >= now`, written so the planner does not treat "open" and "still open" as
  // independent (it would then over-trust a closing-date index); it is also tenders_open_closing_idx's expression, so
  // the closing-date sort reads only still-open rows. Every open-feed query stays on the open-tender
  // partial indexes (008/FR-027).
  if (status === 'open') conds.push(sql`coalesce(${tenders.endAt}, 'infinity'::timestamptz) >= ${now}`);
  // 008/FR-073: GIN-backed full-text search (websearch syntax, prefix lexemes) OR bid-number prefix.
  if (q.q) conds.push(tenderSearchCondition(q.q));
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
    // Same order as `end_at asc nulls last`, written as tenders_open_closing_idx's expression so the "still open"
    // filter above is an index range (008/FR-027, review S5).
    case 'endAt': return [sql`coalesce(${tenders.endAt}, 'infinity'::timestamptz) asc`, desc(tenders.createdAt)];
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
export async function decorateTenders(deps: AppDeps, org: string, rows: TenderListRow[]): Promise<TenderListItem[]> {
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

type FacetKey = 'state' | 'ministry' | 'category';
const FACET_KEYS: FacetKey[] = ['state', 'ministry', 'category'];
const FACET_COLUMNS = { state: tenders.state, ministry: tenders.ministry, category: tenders.category } as const;
const FACET_LIMIT = 60;

/** One facet with its own filter left out: non-null values, count desc then value asc, top 60. */
async function facet(deps: AppDeps, key: FacetKey, conds: SQL[]): Promise<Facet[]> {
  const column = FACET_COLUMNS[key];
  const rows = await deps.db.select({ value: column, count: sql<number>`count(*)::int` })
    .from(tenders).where(and(isNotNull(column), ...conds)).groupBy(column).orderBy(desc(sql`count(*)`), asc(column)).limit(FACET_LIMIT);
  return rows.map((r) => ({ value: String(r.value), count: Number(r.count) }));
}

/**
 * The total and every facet whose own filter is NOT set share the request's WHERE, so they come from one scan of the
 * matching tenders (`GROUP BY GROUPING SETS ((state), (ministry), (category), ())`) instead of one scan each
 * (008/FR-033, US4 scenario 4 — PR #515 QA finding 2: on the 500k fixture every scan of the 30k open tenders costs
 * ~15–20 ms of Postgres CPU, and four of them per feed request were what queued at concurrency 10). Each facet is the
 * same as `facet()`: non-null values, count desc then value asc, top 60 (ranked in SQL, so the collation is the same).
 */
async function totalAndFacets(deps: AppDeps, where: SQL, keys: FacetKey[]): Promise<{ total: number; facets: Partial<Record<FacetKey, Facet[]>> }> {
  if (!keys.length) {
    const [{ total }] = await deps.db.select({ total: sql<number>`count(*)::int` }).from(tenders).where(where);
    return { total: Number(total), facets: {} };
  }
  const cols = keys.map((k) => FACET_COLUMNS[k]);
  const grouping = sql`grouping(${sql.join(cols, sql`, `)})`;
  // Inside a facet's grouping set the other facet columns are NULL, so coalesce() is that facet's value.
  const value = cols.length === 1 ? sql`${cols[0]}` : sql`coalesce(${sql.join(cols, sql`, `)})`;
  const sets = sql.join([...cols.map((col) => sql`(${col})`), sql`()`], sql`, `);
  const res = await deps.db.execute(sql`select g, v, n from (
      select ${grouping} as g, ${value} as v, count(*)::int as n,
             row_number() over (partition by ${grouping} order by ${value} is null, count(*) desc, ${value}) as rn
        from ${tenders} where ${where} group by grouping sets (${sets})
    ) x where rn <= ${FACET_LIMIT + 1} order by g, rn`);
  const rows = (res as unknown as { rows: { g: number | string; v: string | null; n: number | string }[] }).rows;
  // grouping(a, b, c) has a 1-bit per column NOT in the row's set (first column = highest bit); () is all ones.
  const all = (1 << keys.length) - 1;
  const maskOf = (i: number) => all & ~(1 << (keys.length - 1 - i));
  const facets: Partial<Record<FacetKey, Facet[]>> = Object.fromEntries(keys.map((k) => [k, []]));
  let total = 0;
  for (const r of rows) {
    const g = Number(r.g);
    if (g === all) { total = Number(r.n); continue; }
    const i = keys.findIndex((_, j) => maskOf(j) === g);
    const list = i >= 0 ? facets[keys[i]!]! : null;
    if (list && r.v !== null && list.length < FACET_LIMIT) list.push({ value: String(r.v), count: Number(r.n) });
  }
  return { total, facets };
}

/** GET /tenders */
tendersRoutes.get('/tenders', requireAuth, async (c) => {
  const deps = c.var.deps;
  const q = parseWith(tenderQuerySchema, rawQuery(c), 'query');
  const org = orgId(c);
  const now = deps.clock.now();
  const scope = visibleTenderSource(c.var.org);
  const where = and(...buildFilters(q, org, now, scope))!;
  const offset = (q.page - 1) * q.pageSize;
  // A facet whose own filter is set (e.g. ?state=X → the state facet) leaves that filter out, so it needs its own query.
  const filtered = FACET_KEYS.filter((k) => q[k].length > 0);
  const shared = FACET_KEYS.filter((k) => !filtered.includes(k));

  // The page's org decoration runs as soon as the page is in, alongside the total/facet aggregation.
  const [items, summary, ...own] = await Promise.all([
    deps.db.select(tenderListColumns).from(tenders).where(where).orderBy(...orderBy(q, org)).limit(q.pageSize).offset(offset)
      .then((rows) => decorateTenders(deps, org, rows)),
    totalAndFacets(deps, where, shared),
    ...filtered.map((k) => facet(deps, k, buildFilters(q, org, now, scope, k))),
  ]);
  const byKey: Partial<Record<FacetKey, Facet[]>> = { ...summary.facets };
  filtered.forEach((k, i) => { byKey[k] = own[i] as Facet[]; });
  return c.json({ items, total: summary.total, facets: { states: byKey.state ?? [], ministries: byKey.ministry ?? [], categories: byKey.category ?? [] } });
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

/**
 * The stored GeM result as a TenderResultDto (003/FR-062). No row yet → `not_evaluated`, no bidders, never checked.
 * The winner is GeM's awarded row, else L1; anomalies are recomputed from the stored bidders (FR-064).
 */
export function tenderResultDto(
  t: Pick<TenderRow, 'id' | 'status' | 'endAt'>, r: typeof tenderResults.$inferSelect | null | undefined,
): TenderResultDto {
  const bidders = [...(r?.bidders ?? [])].sort((a, b) => a.rank - b.rank)
    .map((b) => ({ rank: b.rank, seller: b.seller, price: b.price, level: b.level, awarded: !!b.awarded }));
  const marked = bidders.find((b) => b.awarded);
  const l1 = bidders.find((b) => b.level.toUpperCase() === 'L1') ?? null;
  const winner = marked ?? l1;
  const shown = winner && !marked ? bidders.map((b) => ({ ...b, awarded: b === winner })) : bidders;
  const evaluationStatus = r?.evaluationStatus ?? 'not_evaluated';
  return {
    tenderId: t.id,
    tenderStatus: t.status,
    evaluationStatus,
    evaluationLabel: EVALUATION_STATUS_LABEL[evaluationStatus] ?? EVALUATION_STATUS_LABEL.not_evaluated,
    bidders: shown,
    winner: winner ? { ...winner, awarded: true } : null,
    lowestPrice: bidders.length ? Math.min(...bidders.map((b) => b.price)) : null,
    anomalies: detectAnomalies(bidders, winner),
    categories: r?.categories ?? [],
    sourceUrl: r?.sourceUrl ?? null,
    fetchedAt: r?.fetchedAt?.toISOString() ?? null,
    checkedAt: r ? r.checkedAt.toISOString() : null,
    lastCheckFailed: !!r?.error,
    checkUntil: t.endAt ? new Date(t.endAt.getTime() + RESULT_CHECK_DAYS * 86_400_000).toISOString() : null,
  };
}

/** GET /tenders/:id/result (003/FR-062) — public GeM result data, any member of an org that can see the tender. */
tendersRoutes.get('/tenders/:id/result', requireAuth, async (c) => {
  const t = await loadTender(c);
  const [r] = await c.var.deps.db.select().from(tenderResults).where(eq(tenderResults.tenderId, t.id));
  return c.json(tenderResultDto(t, r));
});
