/** Copy for the manual reminder run (FR-052) and the drawer's next-reminder line (FR-053). */
import type { VaultDocumentDto } from '@tp/core/contracts/vault';
import { formatDateIST } from '@/lib/format';

export interface ReminderRunReport { documents: number; notifications: number }

/** Toast after **Send reminders now**: "Reminders sent for <n> document(s)" or "No reminders due". */
export function reminderRunMessage(r: ReminderRunReport): string {
  if (r.documents <= 0) return 'No reminders due';
  return `Reminders sent for ${r.documents} document${r.documents === 1 ? '' : 's'}`;
}

/** "Next reminder: 7 days before expiry (07 Nov 2026)" or "All reminders sent". */
export function nextReminderLine(next: VaultDocumentDto['nextReminder']): string {
  if (!next) return 'All reminders sent';
  return `Next reminder: ${next.days} day${next.days === 1 ? '' : 's'} before expiry (${formatDateIST(next.date)})`;
}
