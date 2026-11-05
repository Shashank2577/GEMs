/**
 * Scheduled pipeline shared by the Worker `scheduled()` handler and the Node in-process cron:
 * ingestion → alerts → reminders, each isolated so one failure does not stop the others.
 */
import type { AppDeps } from '../deps';
import { runIngestion } from '../services/ingest';
import { dispatchNotifications } from '../services/alerts';
import { runExpiryReminders } from '../services/reminders';

export interface ScheduledReport { step: string; ok: boolean; ms: number; error?: string }

export async function runScheduledJobs(deps: AppDeps, opts: { trigger?: 'cron' | 'manual' } = {}): Promise<ScheduledReport[]> {
  const steps: [string, () => Promise<unknown>][] = [
    ['ingestion', () => runIngestion(deps, { trigger: opts.trigger ?? 'cron' })],
    ['alerts', () => dispatchNotifications(deps)],
    ['reminders', () => runExpiryReminders(deps)],
  ];
  const report: ScheduledReport[] = [];
  for (const [step, fn] of steps) {
    const t0 = Date.now();
    try {
      await fn();
      report.push({ step, ok: true, ms: Date.now() - t0 });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      deps.logger.error(`scheduled step failed: ${step}`, { error });
      report.push({ step, ok: false, ms: Date.now() - t0, error });
    }
  }
  deps.logger.info('scheduled run finished', { report });
  return report;
}
