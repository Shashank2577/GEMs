import { describe, expect, it } from 'vitest';
import { nextReminderLine, reminderRunMessage } from './reminders';

describe('reminder copy (T051, T053; FR-052, FR-053)', () => {
  it('run toast', () => {
    expect(reminderRunMessage({ documents: 0, notifications: 0 })).toBe('No reminders due');
    expect(reminderRunMessage({ documents: 1, notifications: 5 })).toBe('Reminders sent for 1 document');
    expect(reminderRunMessage({ documents: 3, notifications: 12 })).toBe('Reminders sent for 3 documents');
  });
  it('drawer next-reminder line', () => {
    expect(nextReminderLine(null)).toBe('All reminders sent');
    expect(nextReminderLine({ days: 7, date: '2026-11-07' })).toBe('Next reminder: 7 days before expiry (07 Nov 2026)');
    expect(nextReminderLine({ days: 1, date: '2026-11-13' })).toBe('Next reminder: 1 day before expiry (13 Nov 2026)');
  });
});
