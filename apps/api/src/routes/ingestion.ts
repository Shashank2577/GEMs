/**
 * Ingestion (T036; FR-001, FR-007, FR-013): manual "Sync now" for Bid Managers (2-min cooldown after a finished
 * manual run → `429 sync_cooldown {details.retryAt}`) and sync health for everyone.
 */
import { desc, eq, and, gte, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { ingestionRuns, tenders } from '@tp/db';
import { ingestionRunInputSchema, type IngestionRunDto } from '@tp/core/contracts/identify';
import { logActivity } from '../lib/activity';
import { HttpError } from '../lib/errors';
import { REAL_ONLY } from '../lib/tender-scope';
import { parseJson } from '../lib/validate';
import { orgId, requireAuth, requireRole, userId } from '../middleware/auth';
import { dispatchNotifications } from '../services/alerts';
import { IngestionBusyError, runIngestion, type IngestionRunRow } from '../services/ingest';
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

/** FR-013: a finished manual run blocks the next manual run (any org — GeM is shared) for this long. */
export const MANUAL_SYNC_COOLDOWN_MS = 2 * 60_000;

const fmtTimeIst = (d: Date) =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();

ingestionRoutes.post('/ingestion/run', requireRole('bid_manager'), async (c) => {
  const deps = c.var.deps;
  const body = await parseJson(c, ingestionRunInputSchema);
  // Manual-sync cooldown (FR-013): protects GeM from button-mashing across all orgs.
  const [lastManual] = await deps.db.select({ finishedAt: ingestionRuns.finishedAt }).from(ingestionRuns)
    .where(and(eq(ingestionRuns.trigger, 'manual'), isNotNull(ingestionRuns.finishedAt)))
    .orderBy(desc(ingestionRuns.finishedAt)).limit(1);
  if (lastManual?.finishedAt) {
    const retryAt = new Date(lastManual.finishedAt.getTime() + MANUAL_SYNC_COOLDOWN_MS);
    if (deps.clock.now().getTime() < retryAt.getTime()) {
      throw new HttpError(429, 'sync_cooldown',
        `GeM was synced moments ago. Next manual sync at ${fmtTimeIst(retryAt)} IST.`, { retryAt: retryAt.toISOString() });
    }
  }
  let run: IngestionRunRow;
  try {
    run = await runIngestion(deps, { trigger: 'manual', pages: body.pages, search: body.search });
  } catch (e) {
    if (e instanceof IngestionBusyError) throw new HttpError(409, 'ingestion_running', 'A GeM sync is already running — results will appear shortly.', { run: runDto(e.run) });
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
  const [runs, [lastOk], [counts]] = await Promise.all([
    deps.db.select().from(ingestionRuns).orderBy(desc(ingestionRuns.startedAt)).limit(20),
    deps.db.select({ at: ingestionRuns.finishedAt }).from(ingestionRuns)
      .where(or(eq(ingestionRuns.status, 'success'), eq(ingestionRuns.status, 'partial')))
      .orderBy(desc(ingestionRuns.finishedAt)).limit(1),
    deps.db.select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${and(eq(tenders.status, 'open'), or(isNull(tenders.endAt), gte(tenders.endAt, now)))})::int`,
    }).from(tenders).where(REAL_ONLY), // platform-wide counts: real tenders only, no demo (008/FR-016)
  ]);
  return c.json({
    items: runs.map(runDto),
    lastSuccessAt: lastOk?.at?.toISOString() ?? null,
    lastRun: runs[0] ? runDto(runs[0]) : null,
    totalTenders: Number(counts?.total ?? 0),
    openTenders: Number(counts?.open ?? 0),
  });
});
