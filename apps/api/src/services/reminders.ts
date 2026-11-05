/**
 * Vault expiry reminders (T053; FR-022). Runs on every scheduled tick (after alerts):
 * for each vault document crossing 30 / 7 / 1 days before expiry (or that has just expired), every
 * member of the org whose `expiryReminders` preference is on gets an in-app notification (status
 * `sent`) and — if email is on — a `pending` email row that the alerts dispatcher delivers.
 * `vault_documents.last_reminder_days` records the last threshold sent, and the notification dedupe key
 * includes the threshold and expiry date, so re-running never duplicates a reminder.
 */
import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { memberships, notificationPrefs, notifications, organizations, vaultDocuments } from '@tp/db';
import { docTypeInfo, istDate, reminderCopy, reminderDue, daysUntilExpiry } from '@tp/core/vault/status';
import type { AppDeps } from '../deps';

export interface ReminderReport { documents: number; notifications: number }

/** Upper bound on look-ahead: the 30-day threshold. */
const LOOKAHEAD_DAYS = 30;

export async function runExpiryReminders(deps: AppDeps, opts: { orgId?: string } = {}): Promise<ReminderReport> {
  const now = deps.clock.now();
  const horizon = istDate(new Date(now.getTime() + LOOKAHEAD_DAYS * 86_400_000));
  const conds = [isNotNull(vaultDocuments.expiryDate), lte(vaultDocuments.expiryDate, horizon)];
  if (opts.orgId) conds.push(eq(vaultDocuments.orgId, opts.orgId));
  const docs = await deps.db.select().from(vaultDocuments).where(and(...conds));
  const due = docs.map((d) => ({ d, threshold: reminderDue(d, now) })).filter((x): x is { d: typeof docs[number]; threshold: number } => x.threshold != null);
  const report: ReminderReport = { documents: 0, notifications: 0 };
  if (!due.length) return report;

  const orgIds = [...new Set(due.map((x) => x.d.orgId))];
  const [members, prefs, orgs] = await Promise.all([
    deps.db.select({ orgId: memberships.orgId, userId: memberships.userId }).from(memberships).where(inArray(memberships.orgId, orgIds)),
    deps.db.select().from(notificationPrefs).where(inArray(notificationPrefs.orgId, orgIds)),
    deps.db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, orgIds)),
  ]);
  const prefOf = new Map(prefs.map((p) => [`${p.orgId}:${p.userId}`, p]));
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  for (const { d, threshold } of due) {
    const days = daysUntilExpiry(d.expiryDate, now)!;
    const label = docTypeInfo(d.type).label;
    const when = reminderCopy(threshold, days);
    const title = threshold === 0 ? `${d.title} has expired` : `${d.title} ${when}`;
    const body = threshold === 0
      ? `Your ${label} "${d.title}" ${when}. Bids that need it will be blocked from "Ready to submit" until you upload the renewed copy.`
      : `Your ${label} "${d.title}" ${when} (on ${d.expiryDate}). Renew it and upload the new copy to the vault so your bids stay compliant.`;
    const dedupeKey = `expiry:${d.id}:${d.expiryDate}:${threshold}`;
    const link = `/vault?doc=${d.id}`;
    const rows: (typeof notifications.$inferInsert)[] = [];
    for (const m of members.filter((x) => x.orgId === d.orgId)) {
      const p = prefOf.get(`${m.orgId}:${m.userId}`);
      if (p && !p.expiryReminders) continue;
      const base = { orgId: d.orgId, userId: m.userId, kind: 'expiry' as const, title, body, link, dedupeKey };
      if (!p || p.inApp) rows.push({ ...base, channel: 'in_app', status: 'sent', sentAt: now, createdAt: now });
      if (!p || p.email) rows.push({ ...base, channel: 'email', status: 'pending', createdAt: now, title: `[${orgName.get(d.orgId) ?? 'TenderPilot'}] ${title}` });
    }
    if (rows.length) {
      const inserted = await deps.db.insert(notifications).values(rows).onConflictDoNothing().returning({ id: notifications.id });
      report.notifications += inserted.length;
    }
    await deps.db.update(vaultDocuments).set({ lastReminderDays: threshold }).where(and(eq(vaultDocuments.orgId, d.orgId), eq(vaultDocuments.id, d.id)));
    report.documents++;
  }
  deps.logger.info('expiry reminders', { ...report });
  return report;
}
