/**
 * GeM ingestion service (T034; FR-001, FR-002, FR-004, FR-005, FR-007; Constitution II).
 *
 *   runIngestion(deps, { trigger: 'manual', pages: 3 }) → ingestion_runs row
 *
 * 1. Fetch BidPlus listing pages through the polite GemClient (≤ 1 req/s, back-off): incremental — stop after
 *    a page of known, unchanged bids — with a 20-page catch-up cap after a > 2 h gap since the last clean listing,
 *    or after a run that used up its cap (which then resumes past that depth) (FR-011); scheduled runs
 *    then search up to 10 rotating watchlist keywords (FR-012). > 50 % docs without a bid number or a missing
 *    `response.response.docs` fails the run as format drift and logs `ingestion.format_drift` (FR-014).
 * 2. Upsert tenders by (source, bidNumber); unchanged content hash → only `fetchedAt` moves.
 * 3. Record tender_events: created / updated / corrigendum / closed / cancelled with a field diff.
 *    A corrigendum (end date, quantity, EMD, …) marks existing analyses `stale`.
 * 4. Match new & changed tenders against every active watchlist (all orgs) → tender_matches (unique).
 * 5. Queue notifications per org member and their prefs: in-app (sent immediately), email / WhatsApp
 *    (pending → services/alerts.ts). Deduped by (user, channel, `tender:<tenderId>:<orgId>`).
 * GeM being down never loses data: the run is recorded as `failed` (or `partial`) with the error.
 */
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import {
  analyses, ingestionRuns, memberships, notificationPrefs, notifications, tenderEvents, tenderMatches, tenders, users, watchlists,
  type WatchlistCriteria,
} from '@tp/db';
import { INGESTION_RUN_BUDGET_MS } from '@tp/core/contracts/caps';
import { GemClient } from '@tp/core/gem/client';
import { summariseChanges } from '@tp/core/gem/changes';
import { diffTenders, isCorrigendum, isFormatDriftError, type NormalizedTender } from '@tp/core/gem/parse';
import { matchTender } from '@tp/core/match/matcher';
import type { AppDeps } from '../deps';
import { REAL_ONLY } from '../lib/tender-scope';

export interface RunIngestionOptions {
  trigger?: 'cron' | 'manual' | 'seed';
  /**
   * Fetch exactly up to this many listing pages (operator override, 1–20): no early stop, no catch-up.
   * When omitted the run pages incrementally (FR-011) up to `deps.gem.maxPages`, or the catch-up cap after a gap.
   */
  pages?: number;
  /** Optional free-text search sent to GeM. */
  search?: string;
  /** Inject a client (tests). Defaults to a GemClient over deps.fetch + deps.gem. */
  client?: Pick<GemClient, 'fetchTenders'>;
}

export type IngestionRunRow = typeof ingestionRuns.$inferSelect;

/** A run that has been "running" longer than this is considered dead and does not block new runs. */
export const RUN_LOCK_MS = 15 * 60_000;

/** A run more than this long after the last success pages up to CATCH_UP_PAGES (FR-011). */
export const CATCH_UP_AFTER_MS = 2 * 3_600_000;
export const CATCH_UP_PAGES = 20;
/** Keyword searches per scheduled run (FR-012); each is one GeM request on the same ≤ 1 req/s client. */
export const SEARCH_KEYWORDS_PER_RUN = 10;

export class IngestionBusyError extends Error {
  /** The running run, when it could be read (null if it finished between the conflict and the read). */
  constructor(readonly run: IngestionRunRow | null) {
    super('A GeM sync is already running');
    this.name = 'IngestionBusyError';
  }
}

/** True for a violation of `ingestion_runs_one_running_uq` (008/FR-025). */
export function isOneRunningViolation(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 3; cur = (cur as { cause?: unknown }).cause, depth++) {
    const pg = cur as { code?: string; constraint?: string };
    if (pg.code === '23505' && pg.constraint === 'ingestion_runs_one_running_uq') return true;
  }
  return false;
}

async function runningRun(deps: AppDeps): Promise<IngestionRunRow | null> {
  const [r] = await deps.db.select().from(ingestionRuns).where(eq(ingestionRuns.status, 'running')).orderBy(desc(ingestionRuns.startedAt)).limit(1);
  return r ?? null;
}

/**
 * Atomically reap stale running runs and insert ours (008/FR-025). The partial unique index
 * `ingestion_runs_one_running_uq` makes a concurrent second insert fail → IngestionBusyError, whichever
 * isolate/process it comes from.
 */
async function startRun(deps: AppDeps, trigger: IngestionRunRow['trigger'], now: Date): Promise<IngestionRunRow> {
  try {
    return await deps.db.transaction(async (tx) => {
      await tx.update(ingestionRuns).set({ status: 'failed', error: 'Timed out (worker stopped)', finishedAt: now })
        .where(and(eq(ingestionRuns.status, 'running'), lt(ingestionRuns.startedAt, new Date(now.getTime() - RUN_LOCK_MS))));
      const [row] = await tx.insert(ingestionRuns).values({ trigger, status: 'running', startedAt: now }).returning();
      return row;
    });
  } catch (e) {
    if (isOneRunningViolation(e)) throw new IngestionBusyError(await runningRun(deps));
    throw e;
  }
}

type TenderRow = typeof tenders.$inferSelect;
type Insertable = Omit<NormalizedTender, 'raw'> & { raw: Record<string, unknown> };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runIngestion(deps: AppDeps, opts: RunIngestionOptions = {}): Promise<IngestionRunRow> {
  const { db, clock, logger } = deps;
  const now = clock.now();

  // Single-flight: cheap read-check first (gives the caller the running row), then the atomic reap + insert,
  // which the partial unique index makes race-free across isolates (FR-025).
  const [busy] = await db.select().from(ingestionRuns)
    .where(and(eq(ingestionRuns.status, 'running'), gt(ingestionRuns.startedAt, new Date(now.getTime() - RUN_LOCK_MS))))
    .limit(1);
  if (busy) throw new IngestionBusyError(busy);
  const run = await startRun(deps, opts.trigger ?? 'cron', now);
  const stats = { pagesFetched: 0, tendersSeen: 0, tendersCreated: 0, tendersUpdated: 0, matchesCreated: 0 };
  let listingStop: IngestionRunRow['listingStop'] = null;
  const errors: string[] = [];

  // Every listing request takes a cluster-wide lease slot (FR-024); it may wait up to what is left of the run budget.
  const budgetEnds = Date.now() + INGESTION_RUN_BUDGET_MS;
  const client = opts.client ?? new GemClient(deps.fetch, {
    baseUrl: deps.gem.baseUrl,
    userAgent: deps.gem.userAgent,
    minIntervalMs: deps.gem.minIntervalMs,
    maxRetries: 3,
    backoffMs: deps.gem.minIntervalMs > 0 ? 2000 : 0,
    beforeRequest: () => deps.gemLease.acquire(Math.max(0, budgetEnds - Date.now())),
  });

  try {
    // 1. Fetch listing pages (FR-011): incremental with catch-up after a gap.
    const fetched = new Map<string, NormalizedTender>();
    const plan = await planPages(deps, opts, now);
    let rawSeen = 0;
    listingStop = plan.incremental ? 'cap' : 'explicit'; // unless we break out earlier
    for (let page = 1; page <= plan.maxPages; page++) {
      let res: Awaited<ReturnType<typeof client.fetchTenders>>;
      try {
        res = await client.fetchTenders({ page, search: opts.search, now });
      } catch (e) {
        listingStop = 'error';
        if (isFormatDriftError(e)) throw driftFailure(deps, e, { page });
        errors.push(`page ${page}: ${errMsg(e)}`);
        logger.warn('ingestion: page failed', { page, error: errMsg(e) });
        break; // stay polite: don't hammer a failing portal
      }
      stats.pagesFetched++;
      for (const t of res.tenders) fetched.set(t.bidNumber, t);
      rawSeen += res.rawCount;
      if (res.rawCount === 0 || rawSeen >= res.numFound) { listingStop = 'end'; break; }
      // Stop once a whole page is already known and unchanged — the rest is older news. When resuming after a
      // run that used up its cap, pages up to that run's depth are expected to be known, so keep going.
      if (plan.incremental && page >= plan.noStopBefore && res.tenders.length && await allKnownUnchanged(deps, res.tenders)) {
        listingStop = 'all_known';
        break;
      }
    }
    logger.info('ingestion: listing pages fetched', {
      runId: run.id, pages: stats.pagesFetched, cap: plan.maxPages, catchUp: plan.catchUp, noStopBefore: plan.noStopBefore,
      incremental: plan.incremental, stop: listingStop,
    });

    // 1b. Targeted keyword search pass (FR-012) on scheduled runs, through the same throttled client.
    if (shouldSearch(opts) && errors.length === 0) {
      const keywords = await searchKeywordsForRun(deps);
      for (const [i, kw] of keywords.entries()) {
        try {
          const res = await client.fetchTenders({ page: 1, search: kw, now });
          // GeM search is token-OR; results still go through the exact matcher below.
          for (const t of res.tenders) if (!fetched.has(t.bidNumber)) fetched.set(t.bidNumber, t);
        } catch (e) {
          if (isFormatDriftError(e)) throw driftFailure(deps, e, { search: kw });
          // Never put the keyword in the run row: GET /ingestion/runs is visible to every org (Constitution IV).
          errors.push(`keyword search ${i + 1}/${keywords.length}: ${errMsg(e)}`);
          logger.warn('ingestion: keyword search failed', { keyword: kw, error: errMsg(e) });
          break;
        }
      }
      if (keywords.length) logger.info('ingestion: keyword search pass', { runId: run.id, keywords });
    }
    stats.tendersSeen = fetched.size;

    // 2–3. Upsert + events.
    const changedIds: string[] = [];
    const corrigenda = new Map<string, Record<string, { from: unknown; to: unknown }>>();
    const cancelledIds: string[] = [];
    const list = [...fetched.values()];
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      const existing = await db.select().from(tenders)
        .where(and(eq(tenders.source, 'gem'), inArray(tenders.bidNumber, chunk.map((t) => t.bidNumber))));
      const byBid = new Map(existing.map((r) => [r.bidNumber, r]));
      for (const t of chunk) {
        try {
          const prev = byBid.get(t.bidNumber);
          const r = await upsertTender(deps, t as Insertable, prev ?? null, now);
          if (r.kind === 'created') { stats.tendersCreated++; changedIds.push(r.id); }
          if (r.kind === 'updated') { stats.tendersUpdated++; changedIds.push(r.id); if (r.corrigendum && r.changes) corrigenda.set(r.id, r.changes); if (r.cancelled) cancelledIds.push(r.id); }
        } catch (e) {
          errors.push(`${t.bidNumber}: ${errMsg(e)}`);
          logger.error('ingestion: upsert failed', { bidNumber: t.bidNumber, error: errMsg(e) });
        }
      }
    }

    // 4–5. Match + notify.
    if (changedIds.length) {
      const m = await matchAndNotify(deps, changedIds, now);
      stats.matchesCreated = m.matchesCreated;
    }
    if (corrigenda.size) await notifyCorrigenda(deps, corrigenda, now);
    if (cancelledIds.length) await notifyCancelled(deps, cancelledIds, now);
    // Bids whose deadline passed since we last saw them.
    await db.update(tenders).set({ status: 'closed', updatedAt: now }).where(and(eq(tenders.status, 'open'), lt(tenders.endAt, now)));

    const status: IngestionRunRow['status'] = errors.length === 0 ? 'success' : stats.pagesFetched > 0 ? 'partial' : 'failed';
    const [done] = await db.update(ingestionRuns).set({
      ...stats, listingStop, status, error: errors.length ? errors.slice(0, 5).join('; ').slice(0, 1000) : null, finishedAt: clock.now(),
    }).where(eq(ingestionRuns.id, run.id)).returning();
    logger.info('ingestion finished', { runId: run.id, status, ...stats });
    return done;
  } catch (e) {
    logger.error('ingestion failed', { runId: run.id, error: errMsg(e) });
    const [failed] = await db.update(ingestionRuns).set({ ...stats, listingStop, status: 'failed', error: errMsg(e).slice(0, 1000), finishedAt: clock.now() })
      .where(eq(ingestionRuns.id, run.id)).returning();
    return failed;
  }
}

const clampPages = (n: number) => Math.max(1, Math.min(CATCH_UP_PAGES, Math.floor(n) || 1));

const CLEAN_LISTING_STOPS = ['all_known', 'end', 'cap', 'explicit'] as const;

/**
 * The latest run whose *listing* phase completed cleanly (FR-011): status success, or partial for a reason after
 * listing (keyword search, an upsert). Runs from before `listing_stop` existed count when they fully succeeded.
 */
export async function lastCleanListing(deps: AppDeps) {
  const [row] = await deps.db.select({ finishedAt: ingestionRuns.finishedAt, pagesFetched: ingestionRuns.pagesFetched, listingStop: ingestionRuns.listingStop })
    .from(ingestionRuns)
    .where(and(
      isNotNull(ingestionRuns.finishedAt),
      or(eq(ingestionRuns.status, 'success'), eq(ingestionRuns.status, 'partial')),
      or(inArray(ingestionRuns.listingStop, [...CLEAN_LISTING_STOPS]), and(isNull(ingestionRuns.listingStop), eq(ingestionRuns.status, 'success'))),
    ))
    .orderBy(desc(ingestionRuns.finishedAt)).limit(1);
  return row ?? null;
}

export interface PagePlan {
  maxPages: number;
  incremental: boolean;
  catchUp: boolean;
  /** First page on which an all-known page may end the run (> 1 when resuming after a capped run). */
  noStopBefore: number;
}

/**
 * Paging plan (FR-011). Explicit `pages` → fetch up to that many pages, no early stop. Otherwise incremental:
 * stop after a page of known, unchanged bids; normal cap `gem.maxPages`. Catch-up (cap CATCH_UP_PAGES) when the
 * last clean listing is older than 2 h (or there is none), or when it used up its page cap without reaching an
 * all-known page — then this run resumes past that depth before an all-known page may stop it.
 */
export async function planPages(deps: AppDeps, opts: RunIngestionOptions, now: Date): Promise<PagePlan> {
  if (opts.pages != null) return { maxPages: clampPages(opts.pages), incremental: false, catchUp: false, noStopBefore: 1 };
  const last = await lastCleanListing(deps);
  const gap = !last?.finishedAt || now.getTime() - last.finishedAt.getTime() > CATCH_UP_AFTER_MS;
  const capped = last?.listingStop === 'cap';
  const catchUp = gap || capped;
  // A capped run that already went CATCH_UP_PAGES deep can't be resumed further; fall back to a plain catch-up.
  const noStopBefore = capped && last.pagesFetched < CATCH_UP_PAGES ? last.pagesFetched + 1 : 1;
  return { maxPages: catchUp ? CATCH_UP_PAGES : clampPages(deps.gem.maxPages), incremental: true, catchUp, noStopBefore };
}

/** True when every bid on the page is already stored with the same content hash. */
async function allKnownUnchanged(deps: AppDeps, page: NormalizedTender[]): Promise<boolean> {
  const rows = await deps.db.select({ bidNumber: tenders.bidNumber, contentHash: tenders.contentHash }).from(tenders)
    .where(and(eq(tenders.source, 'gem'), inArray(tenders.bidNumber, page.map((t) => t.bidNumber))));
  const hashes = new Map(rows.map((r) => [r.bidNumber, r.contentHash]));
  return page.every((t) => hashes.get(t.bidNumber) === t.contentHash);
}

/** FR-012: only scheduled runs without an explicit free-text search add the keyword pass. */
const shouldSearch = (opts: RunIngestionOptions) => (opts.trigger ?? 'cron') === 'cron' && !opts.search;

/**
 * Up to SEARCH_KEYWORDS_PER_RUN distinct active watchlist keywords (all orgs, case-folded, sorted), rotating
 * across runs. The window starts at (number of finished success/partial scheduled runs × 10) mod n; the
 * current run is still `running`, so it is not counted. Failed runs don't advance the window (their keywords
 * are retried), and adding/removing keywords shifts it, so coverage is "every keyword within ⌈n/10⌉ healthy
 * runs" only while the keyword set is stable.
 */
export async function searchKeywordsForRun(deps: AppDeps): Promise<string[]> {
  const lists = await deps.db.select({ criteria: watchlists.criteria }).from(watchlists).where(eq(watchlists.active, true));
  const all = [...new Set(lists.flatMap((w) => ((w.criteria as WatchlistCriteria).keywords ?? [])
    .map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 2)))].sort();
  if (!all.length) return [];
  if (all.length <= SEARCH_KEYWORDS_PER_RUN) return all;
  const [{ n }] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(ingestionRuns)
    .where(and(eq(ingestionRuns.trigger, 'cron'), or(eq(ingestionRuns.status, 'success'), eq(ingestionRuns.status, 'partial'))));
  const start = (Number(n) * SEARCH_KEYWORDS_PER_RUN) % all.length;
  return Array.from({ length: SEARCH_KEYWORDS_PER_RUN }, (_, i) => all[(start + i) % all.length]);
}

/** FR-014: log `ingestion.format_drift` at error level and fail the whole run with the drift message. */
function driftFailure(deps: AppDeps, e: unknown, where: Record<string, unknown>): Error {
  deps.logger.error('ingestion.format_drift', { ...where, error: errMsg(e) });
  return e instanceof Error ? e : new Error(errMsg(e));
}

async function upsertTender(
  deps: AppDeps, t: Insertable, prev: TenderRow | null, now: Date,
): Promise<{ id: string; kind: 'created' | 'updated' | 'unchanged'; corrigendum?: boolean; cancelled?: boolean; changes?: Record<string, { from: unknown; to: unknown }> }> {
  const { db } = deps;
  const values = {
    source: t.source, bidNumber: t.bidNumber, gemBidId: t.gemBidId, bidType: t.bidType, title: t.title, items: t.items,
    category: t.category, quantity: t.quantity, ministry: t.ministry, department: t.department, organisation: t.organisation,
    buyerOffice: t.buyerOffice, state: t.state, city: t.city, startAt: t.startAt, endAt: t.endAt, openingAt: t.openingAt,
    emdAmount: t.emdAmount, estimatedValue: t.estimatedValue, epbgPercent: t.epbgPercent, hsnCodes: t.hsnCodes,
    status: t.status, documentUrl: t.documentUrl, sourceUrl: t.sourceUrl, raw: t.raw, contentHash: t.contentHash, fetchedAt: now,
  };

  if (!prev) {
    // ON CONFLICT guards against a concurrent run inserting the same bid.
    const [row] = await db.insert(tenders).values({ ...values, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [tenders.source, tenders.bidNumber] }).returning({ id: tenders.id });
    if (!row) return { id: '', kind: 'unchanged' };
    await db.insert(tenderEvents).values({ tenderId: row.id, kind: 'created', changes: {}, createdAt: now });
    return { id: row.id, kind: 'created' };
  }

  if (prev.contentHash === t.contentHash) {
    await db.update(tenders).set({ fetchedAt: now }).where(eq(tenders.id, prev.id));
    return { id: prev.id, kind: 'unchanged' };
  }

  // Values that GeM no longer publishes on the listing (e.g. enriched from the PDF) are kept.
  const keep = <K extends keyof typeof values>(k: K) => (values[k] === null && prev[k as keyof TenderRow] !== null ? (prev[k as keyof TenderRow] as (typeof values)[K]) : values[k]);
  const merged = {
    ...values,
    emdAmount: keep('emdAmount'), estimatedValue: keep('estimatedValue'), epbgPercent: keep('epbgPercent'),
    openingAt: keep('openingAt'), hsnCodes: values.hsnCodes.length ? values.hsnCodes : prev.hsnCodes,
  };
  const changes = diffTenders(prev, merged);
  if (!Object.keys(changes).length) {
    await db.update(tenders).set({ fetchedAt: now, contentHash: t.contentHash, raw: t.raw }).where(eq(tenders.id, prev.id));
    return { id: prev.id, kind: 'unchanged' };
  }
  const corrigendum = isCorrigendum(changes);
  const kind = corrigendum ? 'corrigendum'
    : changes.status?.to === 'closed' ? 'closed'
      : changes.status?.to === 'cancelled' ? 'cancelled' : 'updated';
  await db.update(tenders).set({ ...merged, updatedAt: now }).where(eq(tenders.id, prev.id));
  await db.insert(tenderEvents).values({ tenderId: prev.id, kind, changes, createdAt: now });
  if (corrigendum) {
    // The reason matters: a corrigendum needs a full re-analysis, Re-score refuses it (FR-037, FR-043).
    await db.update(analyses).set({ stale: true, staleReason: 'corrigendum', staleAt: now, updatedAt: now }).where(eq(analyses.tenderId, prev.id));
  }
  return { id: prev.id, kind: 'updated', corrigendum, cancelled: changes.status?.to === 'cancelled', changes };
}

// ───────────── matching & notifications ─────────────

interface Prefs { inApp: boolean; email: boolean; whatsapp: boolean; frequency: 'instant' | 'daily' }
const DEFAULT_PREFS: Prefs = { inApp: true, email: true, whatsapp: false, frequency: 'instant' };

/** Members of an org with their notification prefs (defaults when no prefs row exists). */
export async function orgRecipients(deps: AppDeps, orgIds: string[]) {
  if (!orgIds.length) return new Map<string, { userId: string; name: string; email: string; phone: string | null; prefs: Prefs }[]>();
  const rows = await deps.db
    .select({
      orgId: memberships.orgId, userId: users.id, name: users.name, email: users.email, phone: users.phone,
      inApp: notificationPrefs.inApp, emailPref: notificationPrefs.email, whatsapp: notificationPrefs.whatsapp, frequency: notificationPrefs.frequency,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(notificationPrefs, and(eq(notificationPrefs.orgId, memberships.orgId), eq(notificationPrefs.userId, memberships.userId)))
    .where(inArray(memberships.orgId, orgIds));
  const out = new Map<string, { userId: string; name: string; email: string; phone: string | null; prefs: Prefs }[]>();
  for (const r of rows) {
    const prefs: Prefs = r.inApp === null
      ? DEFAULT_PREFS
      : { inApp: r.inApp, email: !!r.emailPref, whatsapp: !!r.whatsapp, frequency: (r.frequency ?? 'instant') as Prefs['frequency'] };
    const list = out.get(r.orgId) ?? [];
    list.push({ userId: r.userId, name: r.name, email: r.email, phone: r.phone, prefs });
    out.set(r.orgId, list);
  }
  return out;
}

const fmtInrShort = (n: number | null | undefined) =>
  n == null ? null : n >= 1e7 ? `₹${+(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${+(n / 1e5).toFixed(2)} L` : `₹${n.toLocaleString('en-IN')}`;
const fmtIstDate = (d: Date | null) =>
  d ? d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : 'n/a';

/** Short notification body: buyer · closes · EMD · value. */
export function tenderAlertBody(t: Pick<TenderRow, 'ministry' | 'department' | 'state' | 'endAt' | 'emdAmount' | 'estimatedValue' | 'bidNumber'>, watchlistNames: string[]): string {
  const parts = [
    t.bidNumber,
    [t.department ?? t.ministry, t.state].filter(Boolean).join(', '),
    `closes ${fmtIstDate(t.endAt)} IST`,
    t.emdAmount ? `EMD ${fmtInrShort(t.emdAmount)}` : null,
    t.estimatedValue ? `value ${fmtInrShort(t.estimatedValue)}` : null,
  ].filter(Boolean);
  return `${parts.join(' · ')}${watchlistNames.length ? ` — matched “${watchlistNames.join('”, “')}”` : ''}`;
}

/**
 * Match the given tenders against all active watchlists (every org), store new matches and queue
 * notifications for each new (org, tender) pair. Safe to call repeatedly (unique indexes).
 */
export async function matchAndNotify(
  deps: AppDeps, tenderIds: string[], now: Date,
  opts: { orgId?: string; watchlistId?: string; notify?: boolean } = {},
): Promise<{ matchesCreated: number; notificationsCreated: number }> {
  const { db } = deps;
  // Duplicate ids (e.g. a tender both created and updated in one run) would otherwise yield duplicate rows across
  // `in (…)` chunks, inflating `matchesCreated` and repeating watchlist names in the alert body.
  tenderIds = [...new Set(tenderIds)];
  const conds = [eq(watchlists.active, true)];
  if (opts.orgId) conds.push(eq(watchlists.orgId, opts.orgId));
  if (opts.watchlistId) conds.push(eq(watchlists.id, opts.watchlistId));
  const lists = await db.select().from(watchlists).where(and(...conds));
  if (!lists.length || !tenderIds.length) return { matchesCreated: 0, notificationsCreated: 0 };
  const rows: TenderRow[] = [];
  for (let i = 0; i < tenderIds.length; i += 500) {
    // Only real tenders are matched here: demo tenders never alert anyone (008/FR-016). A demo org's own watchlist
    // refresh (routes/watchlists.ts#refreshMatches) matches its demo tenders silently, without this function.
    rows.push(...(await db.select().from(tenders).where(and(REAL_ONLY, inArray(tenders.id, tenderIds.slice(i, i + 500))))));
  }

  const hits: { t: TenderRow; w: (typeof lists)[number]; reasons: string[]; relevance: number }[] = [];
  for (const t of rows) {
    for (const w of lists) {
      const r = matchTender(t, w.criteria as WatchlistCriteria, { now });
      if (r.matched) hits.push({ t, w, reasons: r.reasons, relevance: r.relevance });
    }
  }
  // Insert in batches; only pairs that were actually new (not already stored) count and notify.
  const inserted = new Set<string>();
  for (let i = 0; i < hits.length; i += 500) {
    const ins = await db.insert(tenderMatches)
      .values(hits.slice(i, i + 500).map((h) => ({ orgId: h.w.orgId, tenderId: h.t.id, watchlistId: h.w.id, reasons: h.reasons, relevance: h.relevance, createdAt: now })))
      .onConflictDoNothing()
      .returning({ tenderId: tenderMatches.tenderId, watchlistId: tenderMatches.watchlistId });
    for (const x of ins) inserted.add(`${x.watchlistId}:${x.tenderId}`);
  }

  // (orgId, tenderId) → watchlist names that newly matched
  const fresh = new Map<string, { orgId: string; tender: TenderRow; names: string[]; reasons: string[] }>();
  let matchesCreated = 0;
  for (const { t, w, reasons } of hits) {
    if (!inserted.has(`${w.id}:${t.id}`)) continue;
    matchesCreated++;
    const key = `${w.orgId}:${t.id}`;
    const f = fresh.get(key) ?? { orgId: w.orgId, tender: t, names: [], reasons: [] };
    f.names.push(w.name);
    for (const reason of reasons) if (!f.reasons.includes(reason)) f.reasons.push(reason);
    fresh.set(key, f);
  }
  if (!fresh.size || opts.notify === false) return { matchesCreated, notificationsCreated: 0 };

  const recipients = await orgRecipients(deps, [...new Set([...fresh.values()].map((f) => f.orgId))]);
  const values: (typeof notifications.$inferInsert)[] = [];
  for (const f of fresh.values()) {
    const title = `New match: ${f.tender.title}`.slice(0, 200);
    const body = tenderAlertBody(f.tender, f.names);
    const link = `/tenders/${f.tender.id}`;
    const dedupeKey = `tender:${f.tender.id}:${f.orgId}`;
    for (const u of recipients.get(f.orgId) ?? []) {
      const base = { orgId: f.orgId, userId: u.userId, kind: 'tender_match' as const, title, body, link, dedupeKey, createdAt: now };
      if (u.prefs.inApp) values.push({ ...base, channel: 'in_app', status: 'sent', sentAt: now });
      if (u.prefs.email) values.push({ ...base, channel: 'email', status: 'pending' });
      if (u.prefs.whatsapp) {
        values.push(u.phone
          ? { ...base, channel: 'whatsapp', status: 'pending' }
          : { ...base, channel: 'whatsapp', status: 'skipped', error: 'Add a mobile number in your account to receive WhatsApp alerts' });
      }
    }
  }
  let notificationsCreated = 0;
  for (let i = 0; i < values.length; i += 500) {
    const ins = await db.insert(notifications).values(values.slice(i, i + 500)).onConflictDoNothing().returning({ id: notifications.id });
    notificationsCreated += ins.length;
  }
  return { matchesCreated, notificationsCreated };
}

/**
 * Alert every member of each org that tracks a tender (has a match) on their chosen channels: in-app is created `sent`,
 * email/WhatsApp `pending` for the dispatcher (WhatsApp `skipped` without a phone), same as match alerts. Deduped per
 * (user, channel, dedupeKey), so a repeat sync never re-alerts.
 */
async function notifyTracking(
  deps: AppDeps, tenderIds: string[], now: Date,
  make: (t: TenderRow, orgId: string) => { kind: 'corrigendum' | 'system'; title: string; body: string; dedupeKey: string } | null,
): Promise<void> {
  const { db } = deps;
  const tracked = await db.selectDistinct({ orgId: tenderMatches.orgId, tenderId: tenderMatches.tenderId })
    .from(tenderMatches).where(and(inArray(tenderMatches.tenderId, tenderIds), eq(tenderMatches.dismissed, false)));
  if (!tracked.length) return;
  const rows = await db.select().from(tenders).where(and(REAL_ONLY, inArray(tenders.id, [...new Set(tracked.map((t) => t.tenderId))])));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const recipients = await orgRecipients(deps, [...new Set(tracked.map((t) => t.orgId))]);
  const values: (typeof notifications.$inferInsert)[] = [];
  for (const tr of tracked) {
    const t = byId.get(tr.tenderId);
    const msg = t && make(t, tr.orgId);
    if (!t || !msg) continue;
    for (const u of recipients.get(tr.orgId) ?? []) {
      const base = { orgId: tr.orgId, userId: u.userId, ...msg, title: msg.title.slice(0, 200), link: `/tenders/${t.id}`, createdAt: now };
      if (u.prefs.inApp) values.push({ ...base, channel: 'in_app', status: 'sent', sentAt: now });
      if (u.prefs.email) values.push({ ...base, channel: 'email', status: 'pending' });
      if (u.prefs.whatsapp) {
        values.push(u.phone
          ? { ...base, channel: 'whatsapp', status: 'pending' }
          : { ...base, channel: 'whatsapp', status: 'skipped', error: 'Add a mobile number in your account to receive WhatsApp alerts' });
      }
    }
  }
  for (let i = 0; i < values.length; i += 500) await db.insert(notifications).values(values.slice(i, i + 500)).onConflictDoNothing();
}

/** Corrigendum alert (FR-051..053): kind `corrigendum`, body names every changed field (summariseChanges). */
async function notifyCorrigenda(deps: AppDeps, changesById: Map<string, Record<string, { from: unknown; to: unknown }>>, now: Date): Promise<void> {
  await notifyTracking(deps, [...changesById.keys()], now, (t, orgId) => {
    const summary = summariseChanges(changesById.get(t.id) ?? {});
    if (!summary) return null; // nothing material in substance: no alert
    return {
      kind: 'corrigendum',
      title: `Corrigendum: ${t.title}`,
      body: `${t.bidNumber} was amended on GeM — now closes ${fmtIstDate(t.endAt)} IST.${summary ? ` Changed: ${summary}.` : ''} Re-check the analysis before you bid.`,
      // Edge: keyed on the content hash, so an A→B→A revert re-uses A's hash and is deduped against the earlier alert.
      dedupeKey: `corrigendum:${t.id}:${t.contentHash}:${orgId}`,
    };
  });
}

/** A tracked tender was cancelled on GeM (FR-054). */
async function notifyCancelled(deps: AppDeps, tenderIds: string[], now: Date): Promise<void> {
  await notifyTracking(deps, tenderIds, now, (t, orgId) => ({
    kind: 'system',
    title: `Cancelled on GeM: ${t.title}`,
    body: `${t.bidNumber} was cancelled by the buyer on GeM. Stop work on this bid unless it is re-issued.`,
    // Edge: dedupe is per (tender, org), so a re-cancel after A→B→A (cancelled, re-issued, cancelled again) does not re-alert.
    dedupeKey: `cancelled:${t.id}:${orgId}`,
  }));
}
