/**
 * Staleness (T010; FR-043, FR-044, FR-045). Marks completed analyses as outdated when one of their inputs
 * changed after they ran, recording why (`stale_reason`) and when (`stale_at`).
 *
 *   await markStale(tx, { orgId, tenderIds: [tenderId] }, 'document_added', deps.clock.now());
 *   await markStale(tx, { orgId, openOnly: true }, 'profile_changed', deps.clock.now());   // all open tenders
 *   await markStale(tx, { tenderIds: [id] }, 'corrigendum', deps.clock.now());              // every org
 *
 * Call it inside the transaction that makes the change (S2): the flag then commits with the change or not at all,
 * and a failure rolls the change back instead of leaving it committed but unflagged. `now` is the time of that
 * write (deps.clock.now() right before it), never an earlier run/request start: a running analysis compares it
 * with its `created_at` (FR-045).
 *
 * `done` and `running` analyses are touched; failed rows have no result to invalidate. A running row is
 * flagged too so that a change made while it runs is not lost: its completion keeps the flag when
 * `stale_at` >= its `created_at` (FR-045, see `keepStaleOnCompletion`). An analysis that is already stale gets
 * the newest time and, usually, the newest reason so the banner explains the latest change; EXCEPT that a reason
 * needing a full re-analysis (corrigendum, document_*, or stale with no recorded reason) is never replaced by one
 * a Re-score fixes (profile/vault/weights): otherwise a Re-score would clear a flag whose cause it cannot address
 * (FR-037).
 *
 * Locking (T074, review S1/S6): no advisory lock is taken here. The matching rows are locked in ascending id order
 * by a materialised CTE (`select … order by id for update`) and then updated by a join on that set, so two
 * overlapping markStale calls (e.g. a corrigendum for every org and a profile change for one) cannot deadlock.
 * Every other writer of analysis rows locks either a single row (run completion, override, a failed run) or
 * several rows in ascending id order too (`expireTimedOutRuns`, and Re-score, which locks its row together with the
 * timed-out running rows it expires), so no cycle can form with us.
 *
 * Input snapshot (review S4): a run reads the tender row and its documents in the same transaction that inserts its
 * `running` row, holding the org+tender lifecycle lock and `lockTenderInputs(…, 'shared')`. Writers of those inputs
 * take the lifecycle lock (an org's own upload/removal) or `lockTenderInputs(…, 'exclusive')` (corrigendum
 * ingestion, a new GeM copy) before their write + markStale, so either the run reads the change or markStale
 * sees the committed running row and flags it.
 */
import { and, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { analyses, tenders, type Db } from '@tp/db';
import { RESCORABLE_STALE_REASONS, isRescorableReason, type StaleReason } from '@tp/core/contracts/analyse';

/** The app database or a transaction on it. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** SQL for "this row is stale for a reason a Re-score cannot fix". */
const needsReanalysis = sql`(${analyses.stale} and (${analyses.staleReason} is null or ${analyses.staleReason} not in (${sql.join(RESCORABLE_STALE_REASONS.map((r) => sql`${r}`), sql`, `)})))`;

export interface StaleScope {
  /** Limit to one organization's analyses (omit for every org, e.g. a corrigendum). */
  orgId?: string;
  /** Limit to these tenders. An empty list matches nothing. */
  tenderIds?: string[];
  /** Limit to tenders that are still open (status `open` and not past their end date). */
  openOnly?: boolean;
}

/** Mark matching completed (or running) analyses stale. Returns the number of analyses updated. */
export async function markStale(db: DbOrTx, scope: StaleScope, reason: StaleReason, now: Date): Promise<number> {
  if (scope.tenderIds && scope.tenderIds.length === 0) return 0;
  if (!scope.orgId && !scope.tenderIds && !scope.openOnly) throw new Error('markStale needs an orgId, tenderIds or openOnly scope');
  const where: SQL[] = [inArray(analyses.status, ['done', 'running'])];
  if (scope.orgId) where.push(eq(analyses.orgId, scope.orgId));
  if (scope.tenderIds) where.push(inArray(analyses.tenderId, scope.tenderIds));
  if (scope.openOnly) {
    const open = db.select({ id: tenders.id }).from(tenders)
      .where(and(eq(tenders.status, 'open'), or(isNull(tenders.endAt), gt(tenders.endAt, now))));
    where.push(inArray(analyses.tenderId, open));
  }
  const staleReason = isRescorableReason(reason) ? sql`case when ${needsReanalysis} then ${analyses.staleReason} else ${reason} end` : sql`${reason}`;
  // Lock in a fixed order (FOR UPDATE applies after ORDER BY) in a materialised CTE, then update exactly those rows
  // through a join (a linear plan; `id in (subquery)` could not be planned as well). updated_at is left alone: the UI
  // shows it as "Analysed <time>".
  const res = await db.execute(sql`
    with l as materialized (
      select ${analyses.id} as id from ${analyses} where ${and(...where)} order by ${analyses.id} for update
    )
    update ${analyses} set stale = true, stale_at = ${now.toISOString()}::timestamptz, stale_reason = ${staleReason}
    from l where ${analyses.id} = l.id
    returning ${analyses.id}`);
  return (res as unknown as { rows: unknown[] }).rows.length;
}

/**
 * Serialises a run's input snapshot with tender-wide input changes (review S4). A run start takes it `shared`
 * (runs of different orgs do not block each other); corrigendum ingestion and storing a new GeM copy take it
 * `exclusive` before their write and markStale. Transaction-scoped; take it before any row lock.
 */
export const lockTenderInputs = (tx: DbOrTx, tenderId: string, mode: 'shared' | 'exclusive') =>
  mode === 'shared'
    ? tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`tender-inputs:${tenderId}`}, 0))`)
    : tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`tender-inputs:${tenderId}`}, 0))`);

/**
 * SET values for a run's final `running → done` write (FR-045): a stale flag that markStale put on the
 * running row (i.e. at or after the row's `created_at`) survives with its reason and time; otherwise the
 * fresh result is not stale. `>=` rather than `>`: a running row only gets stale fields from markStale after
 * its insert committed, so an equal timestamp is a same-millisecond change during the run, not an older one.
 * Evaluated by the UPDATE against the current row version, so a markStale that committed just before (or
 * that the UPDATE waited for) is seen; one that commits after finds the row `done` and flags it itself.
 */
export function keepStaleOnCompletion() {
  const keep = sql`(${analyses.stale} and ${analyses.staleAt} is not null and ${analyses.staleAt} >= ${analyses.createdAt})`;
  return {
    stale: sql<boolean>`coalesce(${keep}, false)`,
    staleReason: sql<StaleReason | null>`case when ${keep} then ${analyses.staleReason} end`,
    staleAt: sql<Date | null>`case when ${keep} then ${analyses.staleAt} end`,
  };
}
