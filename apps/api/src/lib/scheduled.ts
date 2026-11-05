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

export async function runScheduledJobs(deps: AppDeps, opts: { trigger?: 'cron' | 'manual' } = {}): Promise<ScheduledReport[]> {
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
    ['results', () => runDailyResults(deps)],
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
