/**
 * Daily housekeeping (008/FR-070, ADR-0012, US7 scenario 5). `RETENTION` is the single source of truth for how long
 * operational data is kept; docs/runbook.md § Data retention links here. Runs as the `housekeeping` step of
 * `runScheduledJobs` on the first cron tick after 02:00 IST each IST day (claimed in `job_runs`, so exactly one tick
 * on one isolate runs it), deletes in batches of `HOUSEKEEPING_BATCH`, removes a packet's R2 object BEFORE its row (a
 * failed blob delete keeps the row for the next run, so no object is ever orphaned), and logs one JSON summary
 * `{ job: 'housekeeping', deleted: {…} }`. Every rule is idempotent: a second run deletes 0.
 *
 * Pattern (named, test-pinned retention constants) from erenmyeager15/india-government-tenders-scraper
 * `src/monitoring.ts` (Apache-2.0, see NOTICE).
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { jobRuns } from '@tp/db';
import type { AppDeps } from '../deps';

const DAY_MS = 86_400_000;
const IST_MS = 330 * 60_000;

/** 008/FR-070 retention table. Changing a value changes what is deleted in production: update the runbook too. */
export const RETENTION = {
  /** `sessions`: deleted 7 days after they expired. */
  sessionsAfterExpiryDays: 7,
  /** `invitations`: deleted 30 days after acceptance or expiry. */
  invitationsAfterDays: 30,
  /** `notifications` with status read / sent / skipped: deleted 180 days after creation. */
  notificationsDoneDays: 180,
  /** `notifications` with status failed: deleted 30 days after creation. */
  notificationsFailedDays: 30,
  /** `tender_events` of tenders that are no longer open: deleted 365 days after the event. */
  tenderEventsDays: 365,
  /** `tenders.raw` (the GeM payload) set to NULL 90 days after the tender closed (real tenders; demo rows keep it). */
  tenderRawAfterCloseDays: 90,
  /** `rate_limits` windows older than 1 day. */
  rateLimitsDays: 1,
  /** `packets` (row + R2 object): only the newest 5 per workspace are kept; a packet still building is never removed. */
  packetsKeepPerWorkspace: 5,
  // `gem_throttle` is never touched (one row); activity_log / llm_usage are kept (ADR-0012: 2 years, LATER).
} as const;

/** Rows per DELETE/UPDATE statement. */
export const HOUSEKEEPING_BATCH = 1_000;
/** Batches per rule per run (≤ 50k rows); anything left is picked up the next day. Keeps a run inside cron time. */
export const HOUSEKEEPING_MAX_BATCHES = 50;
/** Housekeeping runs on the first scheduled tick at or after this IST hour. */
export const HOUSEKEEPING_HOUR_IST = 2;
export const HOUSEKEEPING_JOB = 'housekeeping';

export interface HousekeepingCounts {
  sessions: number;
  invitations: number;
  notifications: number;
  tenderEvents: number;
  /** Tenders whose `raw` was set to NULL (not deleted rows). */
  tenderRaw: number;
  rateLimits: number;
  packets: number;
  packetBlobs: number;
}

export type HousekeepingResult =
  | { ran: true; day: string; deleted: HousekeepingCounts; ms: number }
  | { ran: false; day: string; reason: 'before_window' | 'already_ran' };

export const istDay = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
const istHour = (d: Date) => new Date(d.getTime() + IST_MS).getUTCHours();
const rowCount = (res: unknown) => (res as { rowCount?: number | null }).rowCount ?? 0;

/** Run `stmt(limit)` until a batch affects fewer than `limit` rows (or the per-run cap). */
async function batched(stmt: (limit: number) => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < HOUSEKEEPING_MAX_BATCHES; i++) {
    const n = await stmt(HOUSEKEEPING_BATCH);
    total += n;
    if (n < HOUSEKEEPING_BATCH) break;
  }
  return total;
}

/** `DELETE … WHERE ctid = ANY(ARRAY(SELECT ctid … WHERE <where> LIMIT n))` — works for any key shape. */
const deleteWhere = (db: AppDeps['db'], table: string, where: SQL) =>
  batched(async (limit) => rowCount(await db.execute(sql`
    delete from ${sql.identifier(table)} where ctid = any(array(select ctid from ${sql.identifier(table)} where ${where} limit ${limit}))`)));

/** Apply every RETENTION rule once (no daily gate). Exported for tests and ops scripts. */
export async function pruneOnce(deps: AppDeps, now: Date): Promise<HousekeepingCounts> {
  const { db } = deps;
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const R = RETENTION;
  const sessions = await deleteWhere(db, 'sessions', sql`expires_at < ${ago(R.sessionsAfterExpiryDays)}::timestamptz`);
  const invitations = await deleteWhere(db, 'invitations', sql`(accepted_at < ${ago(R.invitationsAfterDays)}::timestamptz
    or (accepted_at is null and expires_at < ${ago(R.invitationsAfterDays)}::timestamptz))`);
  const notifications = await deleteWhere(db, 'notifications', sql`(status in ('read', 'sent', 'skipped') and created_at < ${ago(R.notificationsDoneDays)}::timestamptz)
    or (status = 'failed' and created_at < ${ago(R.notificationsFailedDays)}::timestamptz)`);
  const tenderEvents = await deleteWhere(db, 'tender_events', sql`created_at < ${ago(R.tenderEventsDays)}::timestamptz
    and exists (select 1 from tenders t where t.id = tender_events.tender_id and t.status <> 'open')`);
  const tenderRaw = await batched(async (limit) => rowCount(await db.execute(sql`
    update tenders set raw = null where id in (
      select id from tenders where raw is not null and status <> 'open' and source <> 'demo'
        and coalesce(end_at, updated_at) < ${ago(R.tenderRawAfterCloseDays)}::timestamptz limit ${limit})`)));
  const rateLimits = await deleteWhere(db, 'rate_limits', sql`window_start < ${ago(R.rateLimitsDays)}::timestamptz`);
  const { packets, packetBlobs } = await prunePackets(deps);
  return { sessions, invitations, notifications, tenderEvents, tenderRaw, rateLimits, packets, packetBlobs };
}

/** Packets beyond the newest `packetsKeepPerWorkspace` per workspace: R2 object first, then the row. */
async function prunePackets(deps: AppDeps): Promise<{ packets: number; packetBlobs: number }> {
  let packets = 0;
  let packetBlobs = 0;
  const failed = new Set<string>(); // blob delete failed this run: keep the row, never retry it in this run
  for (let i = 0; i < HOUSEKEEPING_MAX_BATCHES; i++) {
    const res = await deps.db.execute(sql`
      select id, blob_key from (
        select id, blob_key, status, row_number() over (partition by workspace_id order by created_at desc, id desc) as rn from packets
      ) p where rn > ${RETENTION.packetsKeepPerWorkspace} and status <> 'building'
      order by id limit ${HOUSEKEEPING_BATCH + failed.size}`);
    const rows = (res as unknown as { rows: { id: string; blob_key: string | null }[] }).rows.filter((r) => !failed.has(r.id));
    if (!rows.length) break;
    const done: string[] = [];
    for (const r of rows) {
      if (r.blob_key) {
        try {
          await deps.blobs.delete(r.blob_key); // idempotent: a missing object is not an error (T101)
          packetBlobs++;
        } catch (e) {
          failed.add(r.id);
          deps.logger.warn('housekeeping: packet blob delete failed; row kept for the next run', { packetId: r.id, error: (e as Error).message });
          continue;
        }
      }
      done.push(r.id);
    }
    if (done.length) {
      packets += rowCount(await deps.db.execute(sql`delete from packets where id = any(${`{${done.join(',')}}`}::uuid[])`));
    }
    if (rows.length < HOUSEKEEPING_BATCH) break;
  }
  return { packets, packetBlobs };
}

/**
 * The scheduled step. Gated to once per IST day after 02:00 IST via a `job_runs (job, day)` claim; a failed run
 * releases its claim so the next tick retries. `force` skips the gate (tests, manual ops).
 */
export async function runHousekeeping(deps: AppDeps, opts: { force?: boolean } = {}): Promise<HousekeepingResult> {
  const now = deps.clock.now();
  const day = istDay(now);
  if (!opts.force) {
    if (istHour(now) < HOUSEKEEPING_HOUR_IST) return { ran: false, day, reason: 'before_window' };
    const claimed = await deps.db.insert(jobRuns).values({ job: HOUSEKEEPING_JOB, day, startedAt: now }).onConflictDoNothing().returning({ day: jobRuns.day });
    if (!claimed.length) return { ran: false, day, reason: 'already_ran' };
  }
  const t0 = Date.now();
  try {
    const deleted = await pruneOnce(deps, now);
    const ms = Date.now() - t0;
    deps.logger.info('housekeeping finished', { job: HOUSEKEEPING_JOB, day, deleted, ms });
    if (!opts.force) {
      await deps.db.update(jobRuns).set({ finishedAt: deps.clock.now(), summary: { deleted, ms } })
        .where(and(eq(jobRuns.job, HOUSEKEEPING_JOB), eq(jobRuns.day, day)));
    }
    return { ran: true, day, deleted, ms };
  } catch (e) {
    if (!opts.force) await deps.db.delete(jobRuns).where(and(eq(jobRuns.job, HOUSEKEEPING_JOB), eq(jobRuns.day, day))).catch(() => {});
    throw e;
  }
}
