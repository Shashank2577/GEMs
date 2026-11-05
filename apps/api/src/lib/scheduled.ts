/**
 * Scheduled pipeline shared by the Worker `scheduled()` handler and the Node in-process cron:
 * ingestion → results (once per IST day from 10:00, 003/US6 FR-061) → alerts → reminders → cleanups → housekeeping
 * (once per IST day after 02:00, 008/FR-070), each isolated so one failure does not stop the others.
 */
import type { AppDeps } from '../deps';
import { IngestionBusyError, runIngestion } from '../services/ingest';
import { dispatchNotifications } from '../services/alerts';
import { runExpiryReminders } from '../services/reminders';
import { runHousekeeping } from '../services/housekeeping';
import { runDailyResults } from '../services/results';
import { pruneAuthState } from './rate-limit';
import { pruneRateLimits } from './rate-limiter';

export interface ScheduledReport { step: string; ok: boolean; ms: number; error?: string }

/** A scheduled invocation lives at most this long (Workers cron limit); RUN_LOCK_MS-style stale checks assume it. */
export const SCHEDULED_INVOCATION_MS = 15 * 60_000;
/** Kept free at the end of the invocation for the steps after results (alerts, reminders, cleanups, housekeeping). */
export const SCHEDULED_TAIL_RESERVE_MS = 2 * 60_000;

/**
 * Budget for the results step: what is left of the invocation after ingestion, minus the tail reserve (N5), so the
 * results refresh can never run the invocation past its 15 minutes. ≤ 0 → the refresh checks nothing this tick.
 */
export function resultsBudgetMs(startedAt: number, now = Date.now()): number {
  return Math.max(0, startedAt + SCHEDULED_INVOCATION_MS - SCHEDULED_TAIL_RESERVE_MS - now);
}

export async function runScheduledJobs(
  deps: AppDeps,
  opts: { trigger?: 'cron' | 'manual'; /** Wall-clock start of the invocation (ms epoch); defaults to now. */ startedAt?: number } = {},
): Promise<ScheduledReport[]> {
  const startedAt = opts.startedAt ?? Date.now();
  const steps: [string, () => Promise<unknown>][] = [
    ['ingestion', async () => {
      try {
        await runIngestion(deps, { trigger: opts.trigger ?? 'cron' });
      } catch (e) {
        // Overlapping tick or a manual Sync now holds the single running slot (008/FR-025) — not a failure.
        if (!(e instanceof IngestionBusyError)) throw e;
        deps.logger.info('ingestion skipped: already running', { runId: e.run?.id ?? null });
      }
    }],
    // Daily results refresh (job_runs claim + one running `results` run cluster-wide); a busy run is not a failure.
    ['results', () => runDailyResults(deps, { budgetMs: resultsBudgetMs(startedAt) })],
    ['alerts', () => dispatchNotifications(deps)],
    ['reminders', () => runExpiryReminders(deps)],
    ['auth-cleanup', () => pruneAuthState(deps.db, deps.clock.now())],
    ['rate-limit-cleanup', () => pruneRateLimits(deps.db, deps.clock.now())],
    ['housekeeping', () => runHousekeeping(deps)],
  ];
  const report: ScheduledReport[] = [];
  for (const [step, fn] of steps) {
    const t0 = Date.now();
    try {
      await fn();
      report.push({ step, ok: true, ms: Date.now() - t0 });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      deps.logger.error(`scheduled step failed: ${step}`, { error, job: step });
      try { deps.errors.capture(e, { job: step }); } catch { /* never let reporting stop the pipeline */ }
      report.push({ step, ok: false, ms: Date.now() - t0, error });
    }
  }
  deps.logger.info('scheduled run finished', { report });
  return report;
}
