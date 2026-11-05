/**
 * Daily GeM results refresh (003/US6: FR-061, FR-063; NFR-001; Constitution II, IV).
 *
 *   await refreshResults(deps)        // → ingestion_runs row of kind 'results'; throws ResultsBusyError if one runs
 *   await runDailyResults(deps)       // scheduled step: first tick at/after 10:00 IST, once per IST day
 *
 * 1. Candidates: ≤ RESULTS_BATCH real GeM tenders tracked by any org (lib/tracked.ts: non-dismissed match, analysis
 *    or workspace) that closed within the last RESULT_CHECK_DAYS days, are not cancelled, were not checked in the
 *    last 24 h, and are not already final (awarded with a bidder table). Never-checked first, then oldest check.
 * 2. Per tender, through one polite GemClient (≤ 1 req/s via the cluster-wide GeM lease, retries with back-off):
 *    submitted-bids search for the bid number → `b_buyer_status`; when it is 3 (awarded) → public result view →
 *    parseBidResultHtml.
 * 3. Writes, in ONE transaction per tender: `tender_results` upsert (evaluation_status only moves forward — a lower
 *    status from GeM never downgrades a stored one); a `technical_evaluated` / `financial_evaluated` tender event when
 *    the stage advances; on award `tenders.status = 'awarded'` + one `awarded` event (conditional on the old status so
 *    it happens once); and, when the bidder table is published, an in-app "Result published: <title> — L1 <seller> at
 *    ₹<price>" (kind `result`) for every member of every org that tracks the tender, deduped per
 *    (user, `result:<tender>:<org>`). A failure anywhere rolls all of it back, so a row is never final without its
 *    alerts.
 * 4. Failures (only `error` changes; status, bidders, categories, source_url, fetched_at are untouched — scenario 6):
 *    - unreadable / truncated / oversized result page: also advances `checked_at` (no re-asking for 24 h), moves on;
 *    - bid missing from the submitted-bids search: `checked_at` not advanced, moves on (not a run error);
 *    - GeM/transport/5xx/lease (or DB) failure: `checked_at` not advanced, and the run STOPS (NFR-001: don't hammer a
 *      failing portal); the rest wait for the next run. Candidates are ordered by last touch (`updated_at`), so a
 *      tender that keeps failing goes to the back of the queue instead of starving the others.
 *
 * Concurrency: at most one running `results` run cluster-wide — `ingestion_runs_one_running_uq` is per kind, so a
 * second concurrent start fails atomically (→ ResultsBusyError), independent of listing syncs. The daily gate is a
 * `job_runs ('results', IST day)` claim like housekeeping's. Run rows carry no bid numbers or org ids (which tenders
 * are tracked is org-derived); details go to the logs and the per-tender `tender_results.error`.
 */
import { and, desc, eq, gte, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { ingestionRuns, jobRuns, notifications, tenderEvents, tenderResults, tenders } from '@tp/db';
import { INGESTION_RUN_BUDGET_MS } from '@tp/core/contracts/caps';
import { EVALUATION_STATUSES, RESULT_CHECK_DAYS, type EvaluationStatus } from '@tp/core/contracts/identify';
import { GemClient, GemError } from '@tp/core/gem/client';
import { parseBidResultHtml, type ResultBidder } from '@tp/core/gem/result';
import { istDay, istHour } from '@tp/core/time';
import type { AppDeps } from '../deps';
import { REAL_ONLY } from '../lib/tender-scope';
import { TRACKED_BY_ANY_ORG, trackingOrgIds } from '../lib/tracked';
import { isOneRunningViolation, orgRecipients, RUN_LOCK_MS, type IngestionRunRow } from './ingest';

export const RESULTS_JOB = 'results';
/** The daily refresh runs on the first scheduled tick at or after this IST hour. */
export const RESULTS_HOUR_IST = 10;
/** Tenders checked per run at most (FR-061). */
export const RESULTS_BATCH = 50;
/** A tender is checked again only after this long. */
export const RESULTS_RECHECK_MS = 24 * 3_600_000;
/** An unfinished daily claim older than this is taken over (a scheduled invocation lives ≤ 15 min). */
export const RESULTS_STALE_CLAIM_MS = 3_600_000;
/** Recorded when the submitted-bids search does not return the bid (B1: never read as "not evaluated"). */
export const BID_NOT_FOUND_ERROR = 'Bid not found in GeM submitted-bids search';

const DAY_MS = 86_400_000;

export class ResultsBusyError extends Error {
  constructor(readonly run: IngestionRunRow | null) {
    super('A results refresh is already running');
    this.name = 'ResultsBusyError';
  }
}

type ResultsClient = Pick<GemClient, 'fetchSubmittedPage' | 'fetchBidResult'>;

export interface RefreshResultsOptions {
  trigger?: 'cron' | 'manual';
  /** Inject a client (tests). Defaults to a GemClient over deps.fetch + deps.gem + the GeM lease. */
  client?: ResultsClient;
  /** Override the batch size (≤ RESULTS_BATCH). */
  limit?: number;
  /** Wall-clock budget (ms) for GeM work, capped at INGESTION_RUN_BUDGET_MS; the scheduler passes what is left. */
  budgetMs?: number;
}

const RESULTS_RUNS = eq(ingestionRuns.kind, 'results');
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function runningResultsRun(deps: AppDeps): Promise<IngestionRunRow | null> {
  const [r] = await deps.db.select().from(ingestionRuns).where(and(RESULTS_RUNS, eq(ingestionRuns.status, 'running')))
    .orderBy(desc(ingestionRuns.startedAt)).limit(1);
  return r ?? null;
}

/** Reap a dead `results` run and insert ours atomically; the per-kind partial unique index makes this race-free. */
async function startResultsRun(deps: AppDeps, trigger: 'cron' | 'manual', now: Date): Promise<IngestionRunRow> {
  try {
    return await deps.db.transaction(async (tx) => {
      await tx.update(ingestionRuns).set({ status: 'failed', error: 'Timed out (worker stopped)', finishedAt: now })
        .where(and(RESULTS_RUNS, eq(ingestionRuns.status, 'running'), lt(ingestionRuns.startedAt, new Date(now.getTime() - RUN_LOCK_MS))));
      const [row] = await tx.insert(ingestionRuns).values({ kind: 'results', trigger, status: 'running', startedAt: now }).returning();
      return row!;
    });
  } catch (e) {
    if (isOneRunningViolation(e)) throw new ResultsBusyError(await runningResultsRun(deps));
    throw e;
  }
}

type Candidate = { id: string; bidNumber: string; gemBidId: string | null; title: string; status: string; endAt: Date | null; prevStatus: EvaluationStatus | null };

/** FR-061 candidate selection (see the module comment). */
export async function resultCandidates(deps: AppDeps, now: Date, limit = RESULTS_BATCH): Promise<Candidate[]> {
  const rows = await deps.db.select({
    id: tenders.id, bidNumber: tenders.bidNumber, gemBidId: tenders.gemBidId, title: tenders.title, status: tenders.status,
    endAt: tenders.endAt, prevStatus: tenderResults.evaluationStatus,
  })
    .from(tenders)
    .leftJoin(tenderResults, eq(tenderResults.tenderId, tenders.id))
    .where(and(
      REAL_ONLY,
      ne(tenders.status, 'cancelled'),
      lt(tenders.endAt, now),
      gte(tenders.endAt, new Date(now.getTime() - RESULT_CHECK_DAYS * DAY_MS)),
      or(isNull(tenderResults.tenderId), isNull(tenderResults.checkedAt), lt(tenderResults.checkedAt, new Date(now.getTime() - RESULTS_RECHECK_MS))),
      // Final: awarded with a published bidder table — nothing left to learn.
      sql`not (coalesce(${tenderResults.evaluationStatus} = 'awarded', false) and jsonb_array_length(coalesce(${tenderResults.bidders}, '[]'::jsonb)) > 0)`,
      TRACKED_BY_ANY_ORG,
    ))
    // Never-touched first, then least recently touched (a failure moves a tender to the back, see the module comment).
    .orderBy(sql`${tenderResults.updatedAt} asc nulls first`, desc(tenders.endAt), tenders.id)
    .limit(Math.max(1, Math.min(RESULTS_BATCH, limit)));
  return rows as Candidate[];
}

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/** `b_buyer_status` 0..3 → evaluation status (unknown → not_evaluated). */
export function evaluationFromBuyerStatus(code: unknown): EvaluationStatus {
  const n = Number(first(code));
  return Number.isInteger(n) && n >= 0 && n < EVALUATION_STATUSES.length ? EVALUATION_STATUSES[n]! : 'not_evaluated';
}

/** ₹ with Indian digit grouping: 2950000 → "₹29,50,000". */
export const formatInr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** The L1 row: level "L1", else the lowest price. */
export function l1Bidder(bidders: ResultBidder[]): ResultBidder | null {
  if (!bidders.length) return null;
  return bidders.find((b) => b.level.toUpperCase() === 'L1') ?? [...bidders].sort((a, b) => a.price - b.price || a.rank - b.rank)[0]!;
}

/** "Result published: <title> — L1 <seller> at ₹<price>", the tender title shortened so the L1 part always fits 200 chars. */
export function resultAlertTitle(title: string, l1: ResultBidder): string {
  const suffix = ` — L1 ${l1.seller} at ${formatInr(l1.price)}`;
  const head = 'Result published: ';
  const room = Math.max(10, 200 - head.length - suffix.length);
  const t = title.length > room ? `${title.slice(0, room - 1).trimEnd()}…` : title;
  return `${head}${t}${suffix}`.slice(0, 200);
}

type Outcome =
  | { kind: 'status'; evaluation: EvaluationStatus; awardedNow: boolean }
  | { kind: 'published'; awardedNow: boolean; alerts: number }
  | { kind: 'unreadable'; error: string }
  | { kind: 'not_found'; error: string };

type Tx = Parameters<Parameters<AppDeps['db']['transaction']>[0]>[0];

const stage = (s: EvaluationStatus) => EVALUATION_STATUSES.indexOf(s);

/**
 * Record a failed attempt: only `error` (and `updated_at`) change; `checked_at` too when `advance` (GeM answered but
 * the page was unreadable). A new row starts at the defaults (not_evaluated, bidders [], checked_at null).
 */
async function recordFailure(deps: AppDeps, tenderId: string, error: string, now: Date, advance: boolean): Promise<void> {
  const e = error.slice(0, 500);
  await deps.db.insert(tenderResults).values({ tenderId, error: e, checkedAt: advance ? now : null, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: tenderResults.tenderId, set: { error: e, updatedAt: now, ...(advance ? { checkedAt: now } : {}) } });
}

/** Mark the tender awarded once (status-conditional) with its event; true when this call made the change. */
async function markAwarded(tx: Tx, t: Candidate, at: Date): Promise<boolean> {
  const [row] = await tx.update(tenders).set({ status: 'awarded', updatedAt: at })
    .where(and(eq(tenders.id, t.id), ne(tenders.status, 'awarded'), ne(tenders.status, 'cancelled')))
    .returning({ id: tenders.id });
  if (!row) return false;
  await tx.insert(tenderEvents).values({ tenderId: t.id, kind: 'awarded', changes: { status: { from: t.status, to: 'awarded' } }, createdAt: at });
  return true;
}

/**
 * Store a successful read. `evaluation_status` never moves backwards (the stored row is locked and compared); an
 * advance to technical/financial evaluation adds its tender event (the `awarded` one comes from markAwarded).
 */
async function storeResult(
  tx: Tx, t: Candidate, evaluation: EvaluationStatus, at: Date,
  extra: Partial<Pick<typeof tenderResults.$inferInsert, 'bidders' | 'categories' | 'sourceUrl'>> = {},
): Promise<EvaluationStatus> {
  const [cur] = await tx.select({ s: tenderResults.evaluationStatus }).from(tenderResults)
    .where(eq(tenderResults.tenderId, t.id)).for('update');
  const prev: EvaluationStatus = cur?.s ?? 'not_evaluated';
  const next = stage(evaluation) >= stage(prev) ? evaluation : prev;
  const values = { ...extra, evaluationStatus: next, fetchedAt: at, checkedAt: at, error: null, updatedAt: at };
  await tx.insert(tenderResults).values({ tenderId: t.id, ...values, createdAt: at })
    .onConflictDoUpdate({ target: tenderResults.tenderId, set: values });
  if (stage(next) > stage(prev) && (next === 'technical_evaluated' || next === 'financial_evaluated')) {
    await tx.insert(tenderEvents).values({ tenderId: t.id, kind: next, changes: { evaluation: { from: prev, to: next } }, createdAt: at });
  }
  return next;
}

export const UNREADABLE = 'GeM result page could not be read (format changed?)';

/** Why the last check failed, for the Result tab: GeM answered but doesn't list the bid / page unreadable / GeM unreachable. */
export function classifyResultError(error: string | null | undefined): 'ok' | 'not_listed' | 'unreadable' | 'unreachable' {
  if (!error) return 'ok';
  if (error === BID_NOT_FOUND_ERROR) return 'not_listed';
  if (error.startsWith(UNREADABLE)) return 'unreadable';
  return 'unreachable';
}

/** Check one tender against GeM and store what we learn. GeM/transport (and DB) errors propagate (the run stops). */
async function checkTender(deps: AppDeps, client: ResultsClient, t: Candidate): Promise<Outcome> {
  const page = await client.fetchSubmittedPage({ search: t.bidNumber });
  const want = t.bidNumber.trim().toUpperCase();
  const doc = page.docs.find((d) => String(first(d.b_bid_number) ?? '').trim().toUpperCase() === want);
  // B1: absence from the search says nothing about the stage — never store it as `not_evaluated`.
  if (!doc) return { kind: 'not_found', error: BID_NOT_FOUND_ERROR };
  const evaluation = evaluationFromBuyerStatus(doc.b_buyer_status);
  const gemBidId = String(first(doc.b_id) ?? '') || t.gemBidId;

  let result: Awaited<ReturnType<ResultsClient['fetchBidResult']>> = null;
  if (evaluation === 'awarded' && gemBidId) {
    try {
      result = await client.fetchBidResult(gemBidId);
    } catch (e) {
      // A declared-oversized page is this tender's problem, not a portal outage: unreadable, move on.
      if (e instanceof GemError && e.code === 'too_large') return { kind: 'unreadable', error: `${UNREADABLE}: page too large` };
      throw e;
    }
  }
  // N2: a body cut off at the byte cap is never parsed as if it were the whole table.
  const parsed = result ? (result.truncated ? { ok: false as const, reason: 'malformed' as const } : parseBidResultHtml(result.html)) : null;

  if (parsed && !parsed.ok && parsed.reason === 'malformed') {
    // US6 scenario 6: the page could not be read — keep everything we had, record why.
    return { kind: 'unreadable', error: result?.truncated ? `${UNREADABLE}: page too large` : UNREADABLE };
  }

  const at = deps.clock.now();
  if (parsed?.ok && parsed.bidders.length) {
    const bidders = [...parsed.bidders].sort((a, b) => a.rank - b.rank);
    const alerts = await resultAlerts(deps, t, bidders, at);
    return deps.db.transaction(async (tx) => {
      await storeResult(tx, t, 'awarded', at, { bidders, categories: parsed.categories.slice(0, 20), sourceUrl: result!.url });
      const awardedNow = await markAwarded(tx, t, at);
      // N1: the alerts commit with the row that makes the result final, or not at all.
      let n = 0;
      for (let i = 0; i < alerts.length; i += 500) {
        n += (await tx.insert(notifications).values(alerts.slice(i, i + 500)).onConflictDoNothing().returning({ id: notifications.id })).length;
      }
      return { kind: 'published' as const, awardedNow, alerts: n };
    });
  }

  // Status only (not awarded yet, or awarded but GeM has not published the bidder table): bidders untouched.
  return deps.db.transaction(async (tx) => {
    const stored = await storeResult(tx, t, evaluation, at);
    const awardedNow = stored === 'awarded' ? await markAwarded(tx, t, at) : false;
    return { kind: 'status' as const, evaluation: stored, awardedNow };
  });
}

/**
 * FR-063: in-app "Result published" rows for every member (in-app enabled) of every org tracking the tender, inserted
 * by checkTender inside the result's transaction. Deduped per (user, in_app, `result:<tenderId>:<orgId>`), so later
 * runs or a re-published table never alert twice.
 */
async function resultAlerts(deps: AppDeps, t: Candidate, bidders: ResultBidder[], now: Date): Promise<(typeof notifications.$inferInsert)[]> {
  const l1 = l1Bidder(bidders);
  if (!l1) return [];
  const orgIds = await trackingOrgIds(deps.db, t.id);
  if (!orgIds.length) return [];
  const recipients = await orgRecipients(deps, orgIds);
  const title = resultAlertTitle(t.title, l1);
  const winner = bidders.find((b) => b.awarded) ?? l1;
  const flagged = winner.price > Math.min(...bidders.map((b) => b.price));
  const body = `${t.bidNumber}: ${bidders.length} bidder${bidders.length === 1 ? '' : 's'} on GeM; awarded to ${winner.seller} at ${formatInr(winner.price)}.`
    + `${flagged ? ' The winner is not the lowest price.' : ''} See the Result tab.`;
  const values: (typeof notifications.$inferInsert)[] = [];
  for (const orgId of orgIds) {
    for (const u of recipients.get(orgId) ?? []) {
      if (!u.prefs.inApp) continue;
      values.push({
        orgId, userId: u.userId, channel: 'in_app', kind: 'result', title, body, link: `/tenders/${t.id}`,
        dedupeKey: `result:${t.id}:${orgId}`, status: 'sent', sentAt: now, createdAt: now,
      });
    }
  }
  return values;
}

/**
 * One results refresh (FR-061). Run stats reuse the ingestion_runs counters: `pagesFetched` = GeM requests,
 * `tendersSeen` = tenders checked, `tendersUpdated` = results stored, `tendersCreated` = tenders newly awarded.
 */
export async function refreshResults(deps: AppDeps, opts: RefreshResultsOptions = {}): Promise<IngestionRunRow> {
  const { db, clock, logger } = deps;
  const now = clock.now();
  const busy = await runningResultsRun(deps);
  if (busy && busy.startedAt.getTime() > now.getTime() - RUN_LOCK_MS) throw new ResultsBusyError(busy);
  const run = await startResultsRun(deps, opts.trigger ?? 'cron', now);

  const budgetEnds = Date.now() + Math.max(0, Math.min(INGESTION_RUN_BUDGET_MS, opts.budgetMs ?? INGESTION_RUN_BUDGET_MS));
  const gem = opts.client ? null : new GemClient(deps.fetch, {
    baseUrl: deps.gem.baseUrl,
    userAgent: deps.gem.userAgent,
    minIntervalMs: deps.gem.minIntervalMs,
    maxRetries: 3,
    backoffMs: deps.gem.minIntervalMs > 0 ? 2000 : 0,
    beforeRequest: () => deps.gemLease.acquire(Math.max(0, budgetEnds - Date.now())),
  });
  const client: ResultsClient = opts.client ?? gem!;
  const stats = { pagesFetched: 0, tendersSeen: 0, tendersCreated: 0, tendersUpdated: 0, matchesCreated: 0 };
  const errors: string[] = [];

  try {
    const candidates = await resultCandidates(deps, now, opts.limit);
    let stopped = false;
    for (const [i, t] of candidates.entries()) {
      if (Date.now() >= budgetEnds) {
        errors.push(`time budget reached; ${candidates.length - i} tender(s) left for the next run`);
        break;
      }
      const where = `tender ${i + 1}/${candidates.length}`;
      const before = gem?.requests ?? 0;
      try {
        const out = await checkTender(deps, client, t);
        stats.tendersSeen++;
        if (out.kind === 'unreadable') {
          await recordFailure(deps, t.id, out.error, deps.clock.now(), true);
          errors.push(`${where}: ${out.error}`);
          logger.warn('results: unreadable result page', { runId: run.id, bidNumber: t.bidNumber });
        } else if (out.kind === 'not_found') {
          // Not a run error (bids often appear in the search only once opened); asked again next run.
          await recordFailure(deps, t.id, out.error, deps.clock.now(), false);
          logger.info('results: bid not in the submitted-bids search', { runId: run.id, bidNumber: t.bidNumber });
        } else {
          stats.tendersUpdated++;
          if (out.awardedNow) stats.tendersCreated++;
        }
      } catch (e) {
        // GeM unreachable / 5xx after retries / lease busy (or a DB error): record it on the tender without spending
        // its daily check (N4), and stop (NFR-001).
        stats.tendersSeen++;
        await recordFailure(deps, t.id, `Check failed: ${errMsg(e)}`, deps.clock.now(), false).catch(() => {});
        errors.push(`${where}: check failed: ${errMsg(e)}`);
        logger.warn('results: GeM request failed; stopping this run', { runId: run.id, bidNumber: t.bidNumber, error: errMsg(e) });
        stopped = true;
      } finally {
        stats.pagesFetched += gem ? gem.requests - before : 0;
      }
      if (stopped) break;
    }
    const ok = stats.tendersUpdated;
    const status: IngestionRunRow['status'] = errors.length === 0 ? 'success' : ok > 0 ? 'partial' : 'failed';
    const [done] = await db.update(ingestionRuns).set({
      ...stats, status, error: errors.length ? errors.slice(0, 5).join('; ').slice(0, 1000) : null, finishedAt: clock.now(),
    }).where(eq(ingestionRuns.id, run.id)).returning();
    logger.info('results refresh finished', { runId: run.id, status, candidates: candidates.length, ...stats });
    return done!;
  } catch (e) {
    logger.error('results refresh failed', { runId: run.id, error: errMsg(e) });
    const [failed] = await db.update(ingestionRuns).set({ ...stats, status: 'failed', error: errMsg(e).slice(0, 1000), finishedAt: clock.now() })
      .where(eq(ingestionRuns.id, run.id)).returning();
    return failed!;
  }
}

export type DailyResultsOutcome =
  | { ran: true; day: string; run: IngestionRunRow }
  | { ran: false; day: string; reason: 'before_window' | 'already_ran' | 'busy' };

/**
 * The scheduled step: the first tick at/after 10:00 IST claims `job_runs ('results', day)` and runs the refresh; every
 * other tick that day, on any isolate, skips. A claim whose run never finished is taken over after
 * RESULTS_STALE_CLAIM_MS. A `failed` run (or a busy/throwing one) releases the claim so the next tick retries; the
 * 24 h per-tender recheck window keeps those retries from re-asking GeM about tenders already checked today.
 */
export async function runDailyResults(deps: AppDeps, opts: Pick<RefreshResultsOptions, 'budgetMs'> = {}): Promise<DailyResultsOutcome> {
  const now = deps.clock.now();
  const day = istDay(now);
  if (istHour(now) < RESULTS_HOUR_IST) return { ran: false, day, reason: 'before_window' };
  const claimed = await deps.db.insert(jobRuns).values({ job: RESULTS_JOB, day, startedAt: now })
    .onConflictDoUpdate({
      target: [jobRuns.job, jobRuns.day],
      set: { startedAt: now, finishedAt: null, summary: null },
      setWhere: sql`${jobRuns.finishedAt} is null and ${jobRuns.startedAt} < ${new Date(now.getTime() - RESULTS_STALE_CLAIM_MS)}`,
    })
    .returning({ day: jobRuns.day });
  if (!claimed.length) return { ran: false, day, reason: 'already_ran' };
  // Fenced on our claim time: a run presumed dead and taken over must not finish or release the new owner's claim.
  const ours = and(eq(jobRuns.job, RESULTS_JOB), eq(jobRuns.day, day), eq(jobRuns.startedAt, now));
  const release = () => deps.db.delete(jobRuns).where(ours).catch(() => {});
  let run: IngestionRunRow;
  try {
    run = await refreshResults(deps, { trigger: 'cron', budgetMs: opts.budgetMs });
  } catch (e) {
    await release();
    if (e instanceof ResultsBusyError) return { ran: false, day, reason: 'busy' };
    throw e;
  }
  if (run.status === 'failed') await release();
  else {
    await deps.db.update(jobRuns).set({
      finishedAt: deps.clock.now(),
      summary: { runId: run.id, status: run.status, checked: run.tendersSeen, stored: run.tendersUpdated, awarded: run.tendersCreated },
    }).where(ours);
  }
  return { ran: true, day, run };
}
