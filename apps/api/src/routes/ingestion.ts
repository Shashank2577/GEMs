/**
 * Ingestion (T036; FR-001, FR-007, FR-013): manual "Sync now" for Bid Managers and sync health for everyone.
 * Cooldown (008/FR-026, supersedes 003 FR-013's 2 minutes): a finished manual run — from any org, since GeM is
 * shared — blocks the next manual run for `MANUAL_SYNC_COOLDOWN_MIN` (default 10) minutes → `429 sync_cooldown
 * {details.retryAt}`, with no GeM request. The window is read from `ingestion_runs`, so it holds cluster-wide.
 */
import { desc, eq, and, gte, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { ingestionRuns, tenders } from '@tp/db';
import { ingestionRunInputSchema, type IngestionRunDto } from '@tp/core/contracts/identify';
import type { AppDeps } from '../deps';
import { logActivity } from '../lib/activity';
import { HttpError } from '../lib/errors';
import { REAL_ONLY } from '../lib/tender-scope';
import { parseJson } from '../lib/validate';
import { orgId, requireAuth, requireRole, userId } from '../middleware/auth';
import { dispatchNotifications } from '../services/alerts';
import { IngestionBusyError, LISTING_RUNS, runIngestion, type IngestionRunRow } from '../services/ingest';
import type { AppEnv } from '../types';

export const ingestionRoutes = new Hono<AppEnv>();

export function runDto(r: IngestionRunRow): IngestionRunDto {
  return {
    id: r.id, trigger: r.trigger, status: r.status, pagesFetched: r.pagesFetched, tendersSeen: r.tendersSeen,
    tendersCreated: r.tendersCreated, tendersUpdated: r.tendersUpdated, matchesCreated: r.matchesCreated, error: r.error,
    startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
  };
}

const fmtTimeIst = (d: Date) =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();

/** When the next manual sync is allowed (008/FR-026), or null when it is allowed now. */
export async function nextManualSyncAt(deps: AppDeps): Promise<Date | null> {
  const [lastManual] = await deps.db.select({ finishedAt: ingestionRuns.finishedAt }).from(ingestionRuns)
    .where(and(LISTING_RUNS, eq(ingestionRuns.trigger, 'manual'), isNotNull(ingestionRuns.finishedAt)))
    .orderBy(desc(ingestionRuns.finishedAt)).limit(1);
  if (!lastManual?.finishedAt) return null;
  const retryAt = new Date(lastManual.finishedAt.getTime() + deps.config.manualSyncCooldownMin * 60_000);
  return deps.clock.now().getTime() < retryAt.getTime() ? retryAt : null;
}

ingestionRoutes.post('/ingestion/run', requireRole('bid_manager'), async (c) => {
  const deps = c.var.deps;
  const body = await parseJson(c, ingestionRunInputSchema);
  // Manual-sync cooldown: protects GeM from button-mashing across all orgs. Checked before anything touches GeM.
  const retryAt = await nextManualSyncAt(deps);
  if (retryAt) {
    throw new HttpError(429, 'sync_cooldown',
      `GeM was synced moments ago. Next manual sync at ${fmtTimeIst(retryAt)} IST.`, { retryAt: retryAt.toISOString() });
  }
  let run: IngestionRunRow;
  try {
    run = await runIngestion(deps, { trigger: 'manual', pages: body.pages, search: body.search });
  } catch (e) {
    if (e instanceof IngestionBusyError) {
      throw new HttpError(409, 'ingestion_running', 'A GeM sync is already running — results will appear shortly.', e.run ? { run: runDto(e.run) } : undefined);
    }
    throw e;
  }
  // Deliver instant alerts right away (best effort; the scheduler retries pending ones).
  try { await dispatchNotifications(deps); } catch (e) { deps.logger.warn('dispatch after manual sync failed', { error: (e as Error).message }); }
  await logActivity(deps.db, {
    orgId: orgId(c), userId: userId(c), action: 'ingestion.run', entityType: 'ingestion_run', entityId: run.id,
    meta: { status: run.status, created: run.tendersCreated, updated: run.tendersUpdated, matches: run.matchesCreated },
  });
  return c.json(runDto(run));
});

ingestionRoutes.get('/ingestion/runs', requireAuth, async (c) => {
  const deps = c.var.deps;
  const now = deps.clock.now();
  const [runs, [lastOk], [counts], retryAt] = await Promise.all([
    // Listing runs only: results-refresh runs (kind 'results') are not syncs, and their rows are derived from which
    // tenders orgs track, so they are never shown to every org here (Constitution IV).
    deps.db.select().from(ingestionRuns).where(LISTING_RUNS).orderBy(desc(ingestionRuns.startedAt)).limit(20),
    deps.db.select({ at: ingestionRuns.finishedAt }).from(ingestionRuns)
      .where(and(LISTING_RUNS, or(eq(ingestionRuns.status, 'success'), eq(ingestionRuns.status, 'partial'))))
      .orderBy(desc(ingestionRuns.finishedAt)).limit(1),
    deps.db.select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${and(eq(tenders.status, 'open'), or(isNull(tenders.endAt), gte(tenders.endAt, now)))})::int`,
    }).from(tenders).where(REAL_ONLY), // platform-wide counts: real tenders only, no demo (008/FR-016)
    nextManualSyncAt(deps),
  ]);
  return c.json({
    items: runs.map(runDto),
    lastSuccessAt: lastOk?.at?.toISOString() ?? null,
    lastRun: runs[0] ? runDto(runs[0]) : null,
    totalTenders: Number(counts?.total ?? 0),
    openTenders: Number(counts?.open ?? 0),
    nextManualSyncAt: retryAt?.toISOString() ?? null,
    manualSyncCooldownMin: deps.config.manualSyncCooldownMin,
  });
});
