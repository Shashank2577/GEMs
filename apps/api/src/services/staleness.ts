/**
 * Staleness (T010; FR-043, FR-044). Marks completed analyses as outdated when one of their inputs
 * changed after they ran, recording why (`stale_reason`) and when (`stale_at`).
 *
 *   await markStale(deps.db, { orgId, tenderIds: [tenderId] }, 'document_added', deps.clock.now());
 *   await markStale(deps.db, { orgId, openOnly: true }, 'profile_changed', now);   // all open tenders
 *   await markStale(deps.db, { tenderIds: [id] }, 'corrigendum', now);              // every org
 *
 * Only `done` analyses are touched (running/failed rows have no result to invalidate). An analysis that
 * is already stale gets the newest time and, usually, the newest reason so the banner explains the latest
 * change; EXCEPT that a reason needing a full re-analysis (corrigendum, document_*, or stale with no
 * recorded reason) is never replaced by one a Re-score fixes (profile/vault/weights): otherwise a Re-score
 * would clear a flag whose cause it cannot address (FR-037).
 */
import { and, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { analyses, tenders, type Db } from '@tp/db';
import { RESCORABLE_STALE_REASONS, isRescorableReason, type StaleReason } from '@tp/core/contracts/analyse';

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

/** Mark matching completed analyses stale. Returns the number of analyses updated. */
export async function markStale(db: Db, scope: StaleScope, reason: StaleReason, now: Date): Promise<number> {
  if (scope.tenderIds && scope.tenderIds.length === 0) return 0;
  if (!scope.orgId && !scope.tenderIds && !scope.openOnly) throw new Error('markStale needs an orgId, tenderIds or openOnly scope');
  const where: SQL[] = [eq(analyses.status, 'done')];
  if (scope.orgId) where.push(eq(analyses.orgId, scope.orgId));
  if (scope.tenderIds) where.push(inArray(analyses.tenderId, scope.tenderIds));
  if (scope.openOnly) {
    const open = db.select({ id: tenders.id }).from(tenders)
      .where(and(eq(tenders.status, 'open'), or(isNull(tenders.endAt), gt(tenders.endAt, now))));
    where.push(inArray(analyses.tenderId, open));
  }
  const rows = await db.update(analyses)
    // updatedAt is left alone: the UI shows it as "Analysed <time>".
    .set({
      stale: true, staleAt: now,
      staleReason: isRescorableReason(reason) ? sql`case when ${needsReanalysis} then ${analyses.staleReason} else ${reason} end` : reason,
    })
    .where(and(...where))
    .returning({ id: analyses.id });
  return rows.length;
}
