/**
 * GET /api/health (008/FR-044): liveness + ingestion freshness + alert backlog for the external uptime monitor.
 * Unauthenticated and org-agnostic: only platform-wide aggregates, never org data. 503 on any `reasons[]` entry.
 */
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { ingestionRuns, notifications } from '@tp/db';
import type { AppDeps } from '../deps';
import type { AppEnv } from '../types';

export const HEALTH_QUERY_TIMEOUT_MS = 3000;
const ALERT_BACKLOG_MS = 30 * 60_000;

export type HealthReason = 'db_unreachable' | 'ingestion_stale' | 'alerts_backlog';

export interface HealthReport {
  ok: boolean;
  db: boolean;
  version: string;
  ingestion: { lastSuccessAt: string | null; ageMinutes: number | null; lastStatus: string | null; state: 'ok' | 'stale' | 'never' };
  alerts: { pendingOlderThan30m: number };
  reasons: HealthReason[];
}

/** Reject if `p` has not settled within `ms` (the underlying query is left to finish or fail on its own). */
function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`health query timed out after ${ms}ms`)), ms); });
  return Promise.race([Promise.resolve(p), t]).finally(() => clearTimeout(timer));
}

export async function buildHealth(deps: AppDeps, timeoutMs = HEALTH_QUERY_TIMEOUT_MS): Promise<HealthReport> {
  const now = deps.clock.now();
  const maxAge = deps.config.healthIngestionMaxAgeMin;
  const reasons: HealthReason[] = [];
  const report: HealthReport = {
    ok: true, db: true, version: deps.config.version,
    ingestion: { lastSuccessAt: null, ageMinutes: null, lastStatus: null, state: 'never' },
    alerts: { pendingOlderThan30m: 0 },
    reasons,
  };
  try {
    const q = <T>(p: PromiseLike<T>) => withTimeout(p, timeoutMs);
    const [, [lastOk], [lastRun], [backlog]] = await Promise.all([
      q(deps.db.execute(sql`select 1`)),
      q(deps.db.select({ at: ingestionRuns.finishedAt }).from(ingestionRuns)
        .where(inArray(ingestionRuns.status, ['success', 'partial']))
        .orderBy(desc(ingestionRuns.finishedAt)).limit(1)),
      q(deps.db.select({ status: ingestionRuns.status }).from(ingestionRuns).orderBy(desc(ingestionRuns.startedAt)).limit(1)),
      q(deps.db.select({ n: sql<number>`count(*)::int` }).from(notifications)
        .where(and(eq(notifications.status, 'pending'), lt(notifications.createdAt, new Date(now.getTime() - ALERT_BACKLOG_MS))))),
    ]);
    const at = lastOk?.at ?? null;
    report.ingestion.lastStatus = lastRun?.status ?? null;
    if (at) {
      const age = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000));
      report.ingestion.lastSuccessAt = at.toISOString();
      report.ingestion.ageMinutes = age;
      report.ingestion.state = age > maxAge ? 'stale' : 'ok';
      if (age > maxAge) reasons.push('ingestion_stale');
    }
    report.alerts.pendingOlderThan30m = Number(backlog?.n ?? 0);
    if (report.alerts.pendingOlderThan30m > 0) reasons.push('alerts_backlog');
  } catch (e) {
    // Any failed or slow query means we cannot vouch for the database; only the message is logged (no SQL params).
    report.db = false;
    reasons.length = 0;
    reasons.push('db_unreachable');
    report.ingestion = { lastSuccessAt: null, ageMinutes: null, lastStatus: null, state: 'never' };
    report.alerts.pendingOlderThan30m = 0;
    deps.logger.error('health: database unreachable', { error: (e as Error).message });
  }
  report.ok = reasons.length === 0;
  return report;
}

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get('/health', async (c) => {
  const report = await buildHealth(c.var.deps);
  if (!report.ok) c.var.deps.logger.warn('health: unhealthy', { reasons: report.reasons });
  return c.json(report, report.ok ? 200 : 503);
});
