import { describe, expect, it } from 'vitest';
import { expiresInDaysFor, tokenExpiry, tokenHintLabel } from './token-expiry';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();

describe('002/FR-037 tokenExpiry', () => {
  it('never-expiring tokens are neutral', () => {
    expect(tokenExpiry(null, NOW)).toEqual({ label: 'Never expires', tone: 'neutral' });
  });
  it('7+ days is neutral, under 7 days is amber, singular day', () => {
    expect(tokenExpiry(inDays(90), NOW)).toEqual({ label: 'Expires in 90 days', tone: 'neutral' });
    expect(tokenExpiry(inDays(7), NOW)).toEqual({ label: 'Expires in 7 days', tone: 'neutral' });
    expect(tokenExpiry(inDays(6.5), NOW)).toEqual({ label: 'Expires in 7 days', tone: 'neutral' }); // label and tone agree (rounded up)
    expect(tokenExpiry(inDays(6), NOW)).toEqual({ label: 'Expires in 6 days', tone: 'warning' });
    expect(tokenExpiry(inDays(3), NOW)).toEqual({ label: 'Expires in 3 days', tone: 'warning' });
    expect(tokenExpiry(inDays(0.2), NOW)).toEqual({ label: 'Expires in 1 day', tone: 'warning' });
  });
  it('past or exact expiry is red "Expired"', () => {
    expect(tokenExpiry(inDays(0), NOW)).toEqual({ label: 'Expired', tone: 'danger' });
    expect(tokenExpiry(inDays(-2), NOW)).toEqual({ label: 'Expired', tone: 'danger' });
  });
  it('hint label and expiry choice mapping', () => {
    expect(tokenHintLabel('a1B2')).toBe('tp_…a1B2');
    expect(tokenHintLabel(null)).toBe('tp_…');
    expect(expiresInDaysFor('90')).toBe(90);
    expect(expiresInDaysFor('365')).toBe(365);
    expect(expiresInDaysFor('never')).toBeNull();
  });
});
