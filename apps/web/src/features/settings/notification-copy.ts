/** Copy for US4 notification UX (002/FR-032, FR-034). Pure so it can be unit-tested. */
import type { TestAlertOutcome, TestAlertResult, TestAlertSkipReason } from '@tp/core/contracts/auth';

export const WHATSAPP_STOPS_WARNING = 'WhatsApp alerts will stop until you add a mobile number.';

/**
 * Account section (T065): warn before saving when the user is clearing a stored mobile while WhatsApp alerts
 * are on for the active org. `null` when there is nothing to warn about.
 */
export function whatsappStopsWarning(opts: { storedPhone: string | null | undefined; draftPhone: string; whatsappOn: boolean | undefined }): string | null {
  return opts.whatsappOn && !!opts.storedPhone && !opts.draftPhone.trim() ? WHATSAPP_STOPS_WARNING : null;
}

const CHANNEL_LABEL = { email: 'Email', whatsapp: 'WhatsApp' } as const;

function line(channel: 'email' | 'whatsapp', outcome: TestAlertOutcome, hasPhone: boolean, reason?: TestAlertSkipReason): string {
  const label = CHANNEL_LABEL[channel];
  switch (outcome) {
    case 'sent': return `${label} sent`;
    case 'failed': return `${label} failed to send`;
    case 'off': return `${label} is off`;
    case 'skipped':
      // Prefer the server's reason; older servers omit `skipReasons`, so fall back to inferring it from the profile.
      return (reason ?? (channel === 'whatsapp' && !hasPhone ? 'no_phone' : 'not_configured')) === 'no_phone'
        ? 'WhatsApp needs a mobile number'
        : `${label} not configured on this server`;
  }
}

/**
 * "Send a test alert" outcome (T067). The in-app row is always created; `lines` is the per-channel result shown
 * in the inline status line under the Notifications footer, `title` is the short toast.
 */
export function testAlertToast(result: TestAlertResult, hasPhone: boolean): { kind: 'success' | 'warning'; title: string; lines: string[] } {
  const external = ['email', 'whatsapp'] as const;
  const lines = ['In-app sent', ...external.map((ch) => line(ch, result[ch], hasPhone, result.skipReasons?.[ch]))];
  const problem = external.some((ch) => result[ch] === 'failed' || result[ch] === 'skipped');
  return { kind: problem ? 'warning' : 'success', title: problem ? 'Test alert sent with warnings' : 'Test alert sent', lines };
}
