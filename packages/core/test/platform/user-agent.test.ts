import { describe, expect, it } from 'vitest';
import { forgotPasswordInputSchema, resetPasswordInputSchema, summarizeUserAgent } from '../../src/contracts/auth';

describe('summarizeUserAgent (002/FR-012)', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Chrome on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0', 'Edge on Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15', 'Safari on macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1', 'Safari on iOS'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0', 'Firefox on Linux'],
    ['curl/8.4.0', 'curl'],
    ['SomethingOdd/1.0 (Linux)', 'Unknown browser on Linux'],
    ['', 'Unknown device'],
  ])('%s → %s', (ua, expected) => {
    expect(summarizeUserAgent(ua)).toBe(expected);
  });

  it('handles null', () => expect(summarizeUserAgent(null)).toBe('Unknown device'));
});

describe('password reset contracts (002/FR-011)', () => {
  it('normalises the email and enforces the password minimum', () => {
    expect(forgotPasswordInputSchema.parse({ email: ' Priya@Sharma.IN ' })).toEqual({ email: 'priya@sharma.in' });
    expect(resetPasswordInputSchema.safeParse({ token: 'x'.repeat(43), newPassword: 'short' }).success).toBe(false);
    expect(resetPasswordInputSchema.safeParse({ token: 'x'.repeat(43), newPassword: 'long-enough-1' }).success).toBe(true);
  });
});
