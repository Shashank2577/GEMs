import { describe, expect, it } from 'vitest';
import { formatInrShort, summariseChanges } from '../../src/gem/changes';

// 2026-11-19 09:30 UTC = 3:00 pm IST
const END_FROM = '2026-11-19T09:30:00.000Z';
const END_TO = '2026-11-26T09:30:00.000Z';

describe('summariseChanges (FR-052)', () => {
  it('renders the end date, quantity and EMD with IST dates and ₹ amounts', () => {
    expect(summariseChanges({
      endAt: { from: END_FROM, to: END_TO },
      quantity: { from: 75, to: 90 },
      emdAmount: { from: 240000, to: 300000 },
    })).toBe('Bid end date: 19 Nov, 3:00 pm → 26 Nov, 3:00 pm IST · Quantity: 75 → 90 · EMD: ₹2.4 L → ₹3 L');
  });

  it('accepts Date objects and shows the year only when it differs', () => {
    expect(summariseChanges({ openingAt: { from: new Date('2026-12-30T06:30:00Z'), to: new Date('2027-01-02T06:30:00Z') } }))
      .toBe('Bid opening date: 30 Dec 2026, 12:00 pm → 2 Jan 2027, 12:00 pm IST');
  });

  it('rolls past midnight into the next IST day and handles 12 am', () => {
    expect(summariseChanges({ endAt: { from: '2026-11-19T18:30:00Z', to: '2026-11-20T18:45:00Z' } }))
      .toBe('Bid end date: 20 Nov, 12:00 am → 21 Nov, 12:15 am IST');
  });

  it('ignores case/whitespace-only string changes and identical instants', () => {
    expect(summariseChanges({
      title: { from: 'Supply of  Laptops', to: 'supply of laptops ' },
      endAt: { from: '2026-11-19T09:30:00Z', to: '2026-11-19T15:00:00+05:30' },
    })).toBe('');
  });

  it('reports real title changes, missing values, Nil EMD, crore values and ePBG', () => {
    expect(summariseChanges({
      title: { from: 'Laptops', to: 'Laptops and bags' },
      emdAmount: { from: null, to: 0 },
      estimatedValue: { from: 9_500_000, to: 12_500_000 },
      epbgPercent: { from: 3, to: 5 },
      documentUrl: { from: 'a', to: 'b' },
    })).toBe('EMD: none → Nil · Estimated value: ₹95 L → ₹1.25 Cr · ePBG: 3% → 5% · Bid document: replaced · Title: Laptops → Laptops and bags');
  });

  it('omits non-material fields and returns an empty string for no changes', () => {
    expect(summariseChanges({ status: { from: 'open', to: 'closed' }, city: { from: 'a', to: 'b' } })).toBe('');
    expect(summariseChanges({})).toBe('');
  });

  it('clips very long values', () => {
    const out = summariseChanges({ items: { from: 'x'.repeat(200), to: 'y' } });
    expect(out.length).toBeLessThan(90);
    expect(out).toContain('…');
  });

  it('formats rupees compactly', () => {
    expect(formatInrShort(45000)).toBe('₹45,000');
    expect(formatInrShort(150000)).toBe('₹1.5 L');
    expect(formatInrShort(20_000_000)).toBe('₹2 Cr');
  });
});
