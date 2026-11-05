import { describe, expect, it } from 'vitest';
import { anomalyNote, checkWindowCopy, EVALUATION_TONE, isPublished, lastCheckFailedCopy, winnerPremium } from './result';

const b = (o: Partial<{ rank: number; seller: string; price: number; level: string; awarded: boolean }> = {}) => ({ rank: 1, seller: 'Acme', price: 100000, level: 'L1', awarded: false, ...o });

describe('result helpers', () => {
  it('detects a published table', () => {
    expect(isPublished({ bidders: [] })).toBe(false);
    expect(isPublished({ bidders: [b()] })).toBe(true);
  });
  it('maps every evaluation status to a tone', () => {
    expect(EVALUATION_TONE.awarded).toBe('success');
    expect(Object.keys(EVALUATION_TONE)).toHaveLength(4);
  });
  it('describes the check window', () => {
    const now = new Date('2026-11-05T00:00:00Z');
    expect(checkWindowCopy(null, now)).toBeNull();
    expect(checkWindowCopy('garbage', now)).toBeNull();
    expect(checkWindowCopy('2026-12-04T06:30:00Z', now)).toBe('Checking daily until 04 Dec 2026.');
    expect(checkWindowCopy('2026-10-01T06:30:00Z', now)).toBe('The 30-day checking window ended on 01 Oct 2026.');
  });
  it('explains a failed check', () => {
    expect(lastCheckFailedCopy({ lastCheckFailed: false, fetchedAt: null })).toBeNull();
    expect(lastCheckFailedCopy({ lastCheckFailed: true, fetchedAt: null })).toMatch(/couldn’t reach GeM/);
    expect(lastCheckFailedCopy({ lastCheckFailed: true, fetchedAt: '2026-11-01T06:30:00Z' })).toMatch(/01 Nov 2026/);
  });
  it('computes the winner premium in rupees', () => {
    expect(winnerPremium({ winner: b({ price: 150000 }), lowestPrice: 100000 })).toBe(50000);
    expect(winnerPremium({ winner: b(), lowestPrice: 100000 })).toBeNull();
    expect(winnerPremium({ winner: null, lowestPrice: 1 })).toBeNull();
  });
  it('writes the anomaly note with Indian grouping', () => {
    const anomalies = [{ code: 'winner_not_lowest_price' as const, message: 'Winner is not the lowest price' }];
    expect(anomalyNote({ anomalies: [], winner: null, lowestPrice: null })).toBeNull();
    expect(anomalyNote({ anomalies, winner: b({ seller: 'Zed', price: 1250000 }), lowestPrice: 1000000 }))
      .toBe('Winner is not the lowest price: Zed quoted ₹2,50,000 above the lowest price (₹10,00,000).');
    expect(anomalyNote({ anomalies, winner: null, lowestPrice: null })).toBe('Winner is not the lowest price.');
  });
});
