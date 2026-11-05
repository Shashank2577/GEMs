/**
 * GET /api/health (008/FR-044): liveness + ingestion freshness + alert backlog for the external uptime monitor.
 * Unauthenticated and org-agnostic: only platform-wide aggregates, never org data. 503 on any `reasons[]` entry.
 */
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { ingestionRuns, notificationPrefs, notifications } from '@tp/db';
import type { AppDeps } from '../deps';
import { DIGEST_HOUR_IST } from '../services/alerts';
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

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** The report served when the database cannot be reached (also used by worker.ts when bootstrap fails). */
export function unreachableHealth(version: string): HealthReport {
  return {
    ok: false, db: false, version,
    ingestion: { lastSuccessAt: null, ageMinutes: null, lastStatus: null, state: 'never' },
    alerts: { pendingOlderThan30m: 0 },
    reasons: ['db_unreachable'],
  };
}

/**
 * Daily-digest `tender_match` rows are held on purpose until the next DIGEST_HOUR_IST slot (services/alerts.ts), so they
 * only count as backlog once the slot that should have sent them is more than 30 minutes past. Returns the creation
 * cutoff: a held row created before it is overdue.
 */
export function dailyDigestCutoff(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  let slot = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), DIGEST_HOUR_IST) - IST_OFFSET_MS;
  if (slot > now.getTime()) slot -= DAY_MS;
  // Within 30 min of the slot the dispatcher may not have run yet: judge against the previous slot.
  if (now.getTime() - slot < ALERT_BACKLOG_MS) slot -= DAY_MS;
  return new Date(slot);
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
    // Ingestion health is about listing runs; the daily results refresh (kind 'results', 003/US6) is separate.
    const listing = eq(ingestionRuns.kind, 'listing');
    const isDigestRow = sql`coalesce(${notificationPrefs.frequency} = 'daily' and ${notifications.kind} = 'tender_match', false)`;
    const [, [lastOk], [lastRun], [firstRun], [backlog]] = await Promise.all([
      q(deps.db.execute(sql`select 1`)),
      q(deps.db.select({ at: ingestionRuns.finishedAt }).from(ingestionRuns)
        .where(and(listing, inArray(ingestionRuns.status, ['success', 'partial'])))
        .orderBy(desc(ingestionRuns.finishedAt)).limit(1)),
      q(deps.db.select({ status: ingestionRuns.status }).from(ingestionRuns).where(listing).orderBy(desc(ingestionRuns.startedAt)).limit(1)),
      q(deps.db.select({ at: ingestionRuns.startedAt }).from(ingestionRuns).where(listing).orderBy(asc(ingestionRuns.startedAt)).limit(1)),
      // Only outbound channels the dispatcher sends (in-app rows stay pending until read). Uses notifications_pending_idx.
      q(deps.db.select({ n: sql<number>`count(*)::int` }).from(notifications)
        .leftJoin(notificationPrefs, and(eq(notificationPrefs.orgId, notifications.orgId), eq(notificationPrefs.userId, notifications.userId)))
        .where(and(
          eq(notifications.status, 'pending'),
          inArray(notifications.channel, ['email', 'whatsapp']),
          lt(notifications.createdAt, new Date(now.getTime() - ALERT_BACKLOG_MS)),
          or(sql`not ${isDigestRow}`, lt(notifications.createdAt, dailyDigestCutoff(now))),
        ))),
    ]);
    const at = lastOk?.at ?? null;
    report.ingestion.lastStatus = lastRun?.status ?? null;
    if (at) {
      const age = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000));
      report.ingestion.lastSuccessAt = at.toISOString();
      report.ingestion.ageMinutes = age;
      report.ingestion.state = age > maxAge ? 'stale' : 'ok';
      if (age > maxAge) reasons.push('ingestion_stale');
    } else if (firstRun?.at && now.getTime() - firstRun.at.getTime() > maxAge * 60_000) {
      // Runs exist but none ever succeeded within the threshold: as bad as a stale feed (a fresh stack stays `never`).
      report.ingestion.state = 'stale';
      reasons.push('ingestion_stale');
    }
    report.alerts.pendingOlderThan30m = Number(backlog?.n ?? 0);
    if (report.alerts.pendingOlderThan30m > 0) reasons.push('alerts_backlog');
  } catch (e) {
    // Any failed or slow query means we cannot vouch for the database; only the message is logged (no SQL params).
    deps.logger.error('health: database unreachable', { error: (e as Error).message });
    return unreachableHealth(deps.config.version);
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
