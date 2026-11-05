/** Copy for US4 notification UX (002/FR-032, FR-034). Pure so it can be unit-tested. */
import type { TestAlertOutcome, TestAlertResult } from '@tp/core/contracts/auth';

export const WHATSAPP_STOPS_WARNING = 'WhatsApp alerts will stop until you add a mobile number.';

/**
 * Account section (T065): warn before saving when the user is clearing a stored mobile while WhatsApp alerts
 * are on for the active org. `null` when there is nothing to warn about.
 */
export function whatsappStopsWarning(opts: { storedPhone: string | null | undefined; draftPhone: string; whatsappOn: boolean | undefined }): string | null {
  return opts.whatsappOn && !!opts.storedPhone && !opts.draftPhone.trim() ? WHATSAPP_STOPS_WARNING : null;
}

const CHANNEL_LABEL = { inApp: 'In-app', email: 'Email', whatsapp: 'WhatsApp' } as const;

function line(channel: keyof TestAlertResult, outcome: TestAlertOutcome, hasPhone: boolean): string {
  const label = CHANNEL_LABEL[channel];
  switch (outcome) {
    case 'sent': return `${label} sent`;
    case 'failed': return `${label} failed to send`;
    case 'off': return `${label} is off`;
    case 'skipped':
      return channel === 'whatsapp' && !hasPhone ? 'WhatsApp needs a mobile number' : `${label} not configured on this server`;
  }
}

/** Per-channel outcome toast for "Send a test alert" (T067). */
export function testAlertToast(result: TestAlertResult, hasPhone: boolean): { kind: 'success' | 'warning'; title: string; lines: string[] } {
  const channels = ['inApp', 'email', 'whatsapp'] as const;
  const lines = channels.map((ch) => line(ch, result[ch], hasPhone));
  const anySent = channels.some((ch) => result[ch] === 'sent');
  const anyProblem = channels.some((ch) => result[ch] === 'failed' || result[ch] === 'skipped');
  if (!anySent) {
    return { kind: 'warning', title: channels.every((ch) => result[ch] === 'off') ? 'All alert channels are off' : 'Test alert not delivered', lines };
  }
  return { kind: anyProblem ? 'warning' : 'success', title: 'Test alert sent', lines };
}
