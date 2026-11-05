/**
 * Watchlists (T027, T030, T031; FR-020–FR-028): CRUD, pause/resume, live preview, 50-per-org limit.
 * Creating / changing a watchlist back-fills matches against currently open tenders silently
 * (no alert storm); alerts fire only for tenders ingested afterwards.
 */
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { organizations, tenderMatches, tenders, users, watchlists, type WatchlistCriteria } from '@tp/db';
import {
  criteriaIsEmpty, watchlistCreateSchema, watchlistPreviewSchema, watchlistUpdateSchema, type WatchlistCriteriaDto, type WatchlistDto,
} from '@tp/core/contracts/identify';
import { uuidSchema } from '@tp/core/contracts/common';
import { canonicalState } from '@tp/core/gem/states';
import { compileCriteria, matchTender } from '@tp/core/match/matcher';
import type { AppDeps } from '../deps';
import { logActivity } from '../lib/activity';
import { HttpError, notFound, validationError } from '../lib/errors';
import { visibleTenderSource } from '../lib/tender-scope';
import { anyKeywordCondition } from '../lib/tender-search';
import { parseJson } from '../lib/validate';
import { orgId, requireAuth, requireRole, userId } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import type { AppEnv } from '../types';
import { decorateTenders, tenderListColumns } from './tenders';

export const watchlistsRoutes = new Hono<AppEnv>();

/** Keyset page size for scanning candidate tenders (FR-028: no overall cap, every open tender is considered). */
const CANDIDATE_PAGE = 2000;
/** Rows per `tender_matches` insert / `in (…)` list. */
const BATCH = 500;
/** FR-027: maximum watchlists per organization, paused ones included. */
export const WATCHLIST_LIMIT = 50;

/** Only the columns the matcher reads (never `raw`), so scanning 50k open tenders stays small (NFR-003). */
const MATCH_COLUMNS = {
  id: tenders.id, title: tenders.title, items: tenders.items, category: tenders.category, ministry: tenders.ministry,
  department: tenders.department, organisation: tenders.organisation, buyerOffice: tenders.buyerOffice, state: tenders.state,
  hsnCodes: tenders.hsnCodes, estimatedValue: tenders.estimatedValue, endAt: tenders.endAt, bidType: tenders.bidType,
  status: tenders.status, createdAt: tenders.createdAt,
};

/** A matching open tender, without the tender row itself. */
export interface Candidate { id: string; relevance: number; reasons: string[]; endAt: Date | null; createdAt: Date }

const clean = (xs: string[] | undefined | null) => (xs ?? []).map((x) => x.trim()).filter(Boolean);
/** Escape LIKE wildcards (`%`, `_`) and the escape character (`\`) so they match literally. */
export const escapeLike = (s: string) => s.replace(/[%_\\]/g, (m) => `\\${m}`);
/** `%a%b%` for a phrase: the matcher treats space/hyphen/underscore/slash runs between words as interchangeable. */
export const phraseLike = (s: string) => `%${s.trim().split(/\s+/).map(escapeLike).join('%')}%`;
/** `ilike any (array[…])`: one scan of the value for several patterns. */
const ilikeAny = (expr: SQL, patterns: string[]) => sql`${expr} ilike any (array[${sql.join(patterns.map((p) => sql`${p}`), sql`, `)}]::text[])`;
/**
 * Any item name matches any pattern — one `jsonb_array_elements` pass per row, not one per pattern. A row whose
 * `items` is not a JSON array (bad legacy data) is treated as having no items rather than failing the whole query;
 * the `case` guarantees the guard is evaluated before `jsonb_array_elements` sees the value.
 */
const itemsLikeAny = (patterns: string[]) =>
  sql`exists (select 1 from jsonb_array_elements(case when jsonb_typeof(${tenders.items}) = 'array' then ${tenders.items} else '[]'::jsonb end) e where ${ilikeAny(sql`e->>'name'`, patterns)})`;
/** Several text columns as one haystack (a cross-field hit only widens the pre-filter; the matcher decides). */
const joined = (...cols: unknown[]) => sql`concat_ws(' · ', ${sql.join(cols.map((c) => sql`${c}`), sql`, `)})`;

/** Preview order (FR-024): relevance, then closing soonest, then newest, then id — fully deterministic. */
export const byPreviewOrder = (a: Candidate, b: Candidate) =>
  b.relevance - a.relevance || (a.endAt?.getTime() ?? 0) - (b.endAt?.getTime() ?? 0)
  || b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Open tenders that match the criteria: a cheap SQL pre-filter (state, value, bid type, keyword full-text match via
 * `anyKeywordCondition`, category / ministry ILIKE — each a superset of what the matcher accepts; the keyword one is
 * property-tested against the matcher in identify.test.ts) followed by the exact matcher in JS.
 * Scans keyset pages ordered by `id` until exhausted (FR-028) and keeps only `{id, relevance, reasons, endAt,
 * createdAt}` per match (NFR-003).
 */
export async function candidateTenders(deps: AppDeps, criteria: WatchlistCriteriaDto, scope: SQL): Promise<Candidate[]> {
  const now = deps.clock.now();
  // `scope`: the tenders the org may see (lib/tender-scope.ts; demo tenders only for demo orgs, 008/FR-016).
  const conds: SQL[] = [scope, eq(tenders.status, 'open'), or(isNull(tenders.endAt), gte(tenders.endAt, now))!];
  // Stored states are canonical (parser), so canonicalise the criteria and keep the exact, indexed comparison.
  const states = [...new Set(clean(criteria.states).map((x) => canonicalState(x) ?? x))];
  if (states.length) conds.push(inArray(tenders.state, states));
  if (criteria.minValue != null) conds.push(or(isNull(tenders.estimatedValue), gte(tenders.estimatedValue, criteria.minValue))!);
  if (criteria.maxValue != null) conds.push(or(isNull(tenders.estimatedValue), sql`${tenders.estimatedValue} <= ${criteria.maxValue}`)!);
  if (criteria.bidTypes.length) conds.push(inArray(tenders.bidType, criteria.bidTypes));
  // Keywords: GIN-backed full-text pre-filter (008/FR-073) over title, category, buyer fields and item names; the
  // matcher below applies the exact word-boundary rules.
  const keywords = clean(criteria.keywords);
  if (keywords.length) conds.push(anyKeywordCondition(keywords));
  // Categories substring-match category, item names and title.
  const categories = clean(criteria.categories);
  if (categories.length) {
    const likes = categories.map((c) => `%${escapeLike(c)}%`);
    conds.push(or(ilikeAny(joined(tenders.category, tenders.title), likes), itemsLikeAny(likes))!);
  }
  // Ministries substring-match ministry, department, organisation or buyer office.
  const ministries = clean(criteria.ministries);
  if (ministries.length) {
    const likes = ministries.map((m) => `%${escapeLike(m)}%`);
    conds.push(ilikeAny(joined(tenders.ministry, tenders.department, tenders.organisation, tenders.buyerOffice), likes));
  }
  const where = (after: string | null): SQL => (after ? and(...conds, gt(tenders.id, after))! : and(...conds)!);
  // At most two pages of lean MATCH_COLUMNS rows are alive at once (the one being matched and the prefetch).
  // Drizzle query builders are lazy: `.execute()` actually starts the query, so the prefetch overlaps matching.
  // The no-op `.catch` marks the promise handled, so if matching throws while a prefetch is in flight its later
  // rejection is not reported as unhandled; `await next` below still sees (and throws) any rejection.
  const page = (after: string | null) => {
    const p = deps.db.select(MATCH_COLUMNS).from(tenders).where(where(after)).orderBy(asc(tenders.id)).limit(CANDIDATE_PAGE).execute();
    p.catch(() => {});
    return p;
  };
  const out: Candidate[] = [];
  const compiled = compileCriteria(criteria); // 008/FR-074: regexes built once, not once per candidate row
  let next = page(null);
  for (;;) {
    const rows = await next;
    // Start the following page before matching this one, so the database works while we match.
    const more = rows.length === CANDIDATE_PAGE;
    if (more) next = page(rows[rows.length - 1].id);
    for (const row of rows) {
      const r = matchTender(row, compiled, { now });
      if (r.matched) out.push({ id: row.id, relevance: r.relevance, reasons: r.reasons, endAt: row.endAt, createdAt: row.createdAt });
    }
    if (!more) break;
  }
  return out;
}

/**
 * Re-evaluate a watchlist's matches (FR-025): drop ones that no longer match (closed tenders are kept), then insert
 * the matches computed by `candidateTenders` directly, in batches — never notifying.
 */
/**
 * `scope` is the owning org's visible tenders (lib/tender-scope.ts, 008/FR-016): a demo org's saved watchlist matches
 * the demo tenders its preview showed (silently — refreshes never alert); other orgs only ever match real tenders,
 * and an existing match on a tender outside the scope is dropped.
 */
async function refreshMatches(deps: AppDeps, w: typeof watchlists.$inferSelect, scope: SQL): Promise<number> {
  const now = deps.clock.now();
  const existing = await deps.db.select({ id: tenderMatches.id, tenderId: tenderMatches.tenderId }).from(tenderMatches)
    .where(eq(tenderMatches.watchlistId, w.id));
  const stale: string[] = [];
  const compiled = compileCriteria(w.criteria);
  for (let i = 0; i < existing.length; i += BATCH) {
    const chunk = existing.slice(i, i + BATCH);
    const rows = await deps.db.select(MATCH_COLUMNS).from(tenders).where(and(scope, inArray(tenders.id, chunk.map((e) => e.tenderId))));
    const keep = new Set(rows.filter((t) => t.status !== 'open' || matchTender(t, compiled, { now: new Date(0) }).matched).map((t) => t.id));
    for (const e of chunk) if (!keep.has(e.tenderId)) stale.push(e.id);
  }
  for (let i = 0; i < stale.length; i += BATCH) await deps.db.delete(tenderMatches).where(inArray(tenderMatches.id, stale.slice(i, i + BATCH)));
  if (!w.active) return 0;
  // Candidates are already limited to `scope`, so the direct insert below never pairs this org with a hidden tender.
  const cands = await candidateTenders(deps, w.criteria as WatchlistCriteriaDto, scope);
  let created = 0;
  for (let i = 0; i < cands.length; i += BATCH) {
    const ins = await deps.db.insert(tenderMatches)
      .values(cands.slice(i, i + BATCH).map((c) => ({ orgId: w.orgId, tenderId: c.id, watchlistId: w.id, reasons: c.reasons, relevance: c.relevance, createdAt: now })))
      .onConflictDoNothing()
      .returning({ id: tenderMatches.id });
    created += ins.length;
  }
  return created;
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

watchlistsRoutes.post('/watchlists/preview', requireAuth, rateLimit('watchlist.preview.user'), async (c) => {
  const deps = c.var.deps;
  const { criteria } = await parseJson(c, watchlistPreviewSchema);
  if (criteriaIsEmpty(criteria)) return c.json({ count: 0, sample: [] });
  const cands = await candidateTenders(deps, criteria, visibleTenderSource(c.var.org));
  cands.sort(byPreviewOrder);
  const top = cands.slice(0, 5);
  // List projection only for the sample (008/FR-028: no `raw`).
  const full = top.length ? await deps.db.select(tenderListColumns).from(tenders).where(inArray(tenders.id, top.map((x) => x.id))) : [];
  const fullBy = new Map(full.map((r) => [r.id, r]));
  const sample = await decorateTenders(deps, orgId(c), top.map((x) => fullBy.get(x.id)).filter((r): r is NonNullable<typeof r> => !!r));
  // Show the reasons this *draft* would produce.
  const reasonBy = new Map(top.map((x) => [x.id, x.reasons]));
  return c.json({ count: cands.length, sample: sample.map((s) => ({ ...s, previewReasons: reasonBy.get(s.id) ?? [] })) });
});

watchlistsRoutes.post('/watchlists', requireRole('analyst'), async (c) => {
  const deps = c.var.deps;
  const body = await parseJson(c, watchlistCreateSchema);
  requireCriteria(body.criteria);
  const org = orgId(c);
  const now = deps.clock.now();
  // Lock the org row so concurrent creates can't both pass the count (FR-027).
  const w = await deps.db.transaction(async (tx) => {
    await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, org)).for('update');
    const [{ n }] = await tx.select({ n: count() }).from(watchlists).where(eq(watchlists.orgId, org));
    if (n >= WATCHLIST_LIMIT) {
      throw new HttpError(409, 'watchlist_limit', `You can have up to ${WATCHLIST_LIMIT} watchlists — delete one first.`, { limit: WATCHLIST_LIMIT });
    }
    const [row] = await tx.insert(watchlists).values({
      orgId: org, name: body.name, criteria: body.criteria as WatchlistCriteria, active: body.active ?? true,
      createdBy: userId(c), createdAt: now, updatedAt: now,
    }).returning();
    return row;
  });
  const matched = await refreshMatches(deps, w, visibleTenderSource(c.var.org));
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
  if (body.criteria || (body.active === true && !w.active)) await refreshMatches(deps, updated, visibleTenderSource(c.var.org));
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
