import { describe, expect, it } from 'vitest';
import { WHATSAPP_STOPS_WARNING, testAlertToast, whatsappStopsWarning } from './notification-copy';

describe('whatsappStopsWarning (002/FR-032, T065)', () => {
  it('warns only when a stored mobile is being cleared while WhatsApp is on', () => {
    expect(whatsappStopsWarning({ storedPhone: '+919822012345', draftPhone: '  ', whatsappOn: true })).toBe(WHATSAPP_STOPS_WARNING);
    expect(WHATSAPP_STOPS_WARNING).toBe('WhatsApp alerts will stop until you add a mobile number.');
  });
  it('is silent when WhatsApp is off, prefs are unknown, a number remains, or there was no number', () => {
    expect(whatsappStopsWarning({ storedPhone: '+919822012345', draftPhone: '', whatsappOn: false })).toBeNull();
    expect(whatsappStopsWarning({ storedPhone: '+919822012345', draftPhone: '', whatsappOn: undefined })).toBeNull();
    expect(whatsappStopsWarning({ storedPhone: '+919822012345', draftPhone: '98220 12345', whatsappOn: true })).toBeNull();
    expect(whatsappStopsWarning({ storedPhone: null, draftPhone: '', whatsappOn: true })).toBeNull();
  });
});

describe('testAlertToast (002/FR-034, T067)', () => {
  it('lists the outcome per channel, in-app always first', () => {
    expect(testAlertToast({ inApp: 'sent', email: 'sent', whatsapp: 'skipped' }, true)).toEqual({
      kind: 'warning', title: 'Test alert sent with warnings',
      lines: ['In-app sent', 'Email sent', 'WhatsApp not configured on this server'],
    });
    expect(testAlertToast({ inApp: 'sent', email: 'sent', whatsapp: 'off' }, false)).toEqual({
      kind: 'success', title: 'Test alert sent', lines: ['In-app sent', 'Email sent', 'WhatsApp is off'],
    });
  });
  it('explains a missing mobile and provider failures', () => {
    const t = testAlertToast({ inApp: 'sent', email: 'failed', whatsapp: 'skipped' }, false);
    expect(t.kind).toBe('warning');
    expect(t.lines).toEqual(['In-app sent', 'Email failed to send', 'WhatsApp needs a mobile number']);
  });
  it('prefers the server skip reason over guessing from the profile', () => {
    expect(testAlertToast({ inApp: 'sent', email: 'off', whatsapp: 'skipped', skipReasons: { whatsapp: 'not_configured' } }, false).lines[2]).toBe('WhatsApp not configured on this server');
    expect(testAlertToast({ inApp: 'sent', email: 'off', whatsapp: 'skipped', skipReasons: { whatsapp: 'no_phone' } }, true).lines[2]).toBe('WhatsApp needs a mobile number');
  });
  it('is a plain success when email and WhatsApp are off', () => {
    expect(testAlertToast({ inApp: 'sent', email: 'off', whatsapp: 'off' }, true)).toMatchObject({ kind: 'success', title: 'Test alert sent' });
  });
});
