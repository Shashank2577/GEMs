/** Activity log helper (FR-033). Use dotted actions: `tender.analysed`, `vault.uploaded`, `workspace.stage_changed`. */
import { activityLog, type Db } from '@tp/db';

export interface ActivityInput {
  orgId: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  meta?: Record<string, unknown>;
}

/** `db` may be a transaction, so the entry commits (or rolls back) with the change it describes. */
export async function logActivity(db: Pick<Db, 'insert'>, a: ActivityInput): Promise<void> {
  await db.insert(activityLog).values({
    orgId: a.orgId,
    userId: a.userId ?? null,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId ?? null,
    meta: a.meta ?? {},
  });
}
