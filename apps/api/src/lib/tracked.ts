/**
 * "Tracked" tenders (003/US6, FR-061, FR-063, FR-064; Constitution IV): an org tracks a tender when it has a
 * non-dismissed watchlist match, an analysis or a bid workspace for it. Used by the results refresh (which tenders
 * to check, which orgs to alert) and by the competitor insights (which tenders an org's numbers are built from).
 *
 *   db.select().from(tenders).where(trackedByOrg(orgId))      // this org only (insights)
 *   db.select().from(tenders).where(TRACKED_BY_ANY_ORG)       // results refresh candidates
 *   await trackingOrgIds(db, tenderId)                         // who to alert
 *
 * The SQL fragments correlate on `tenders.id`, so the outer query must select from `tenders` without an alias.
 */
import { sql, type SQL } from 'drizzle-orm';
import { tenders, type Db } from '@tp/db';

/** A dismissed match ("Not relevant") is not tracking: those orgs neither get result alerts nor see it in insights. */
export function trackedByOrg(orgId: string): SQL {
  return sql`(
    exists (select 1 from tender_matches m where m.tender_id = ${tenders.id} and m.org_id = ${orgId} and not m.dismissed)
    or exists (select 1 from analyses a where a.tender_id = ${tenders.id} and a.org_id = ${orgId})
    or exists (select 1 from bid_workspaces w where w.tender_id = ${tenders.id} and w.org_id = ${orgId})
  )`;
}

export const TRACKED_BY_ANY_ORG: SQL = sql`(
  exists (select 1 from tender_matches m where m.tender_id = ${tenders.id} and not m.dismissed)
  or exists (select 1 from analyses a where a.tender_id = ${tenders.id})
  or exists (select 1 from bid_workspaces w where w.tender_id = ${tenders.id})
)`;

/** Orgs that track `tenderId` (distinct, sorted). */
export async function trackingOrgIds(db: Db, tenderId: string): Promise<string[]> {
  const res = await db.execute(sql`
    select org_id from tender_matches where tender_id = ${tenderId} and not dismissed
    union select org_id from analyses where tender_id = ${tenderId}
    union select org_id from bid_workspaces where tender_id = ${tenderId}
    order by 1`);
  return (res as unknown as { rows: { org_id: string }[] }).rows.map((r) => r.org_id);
}
