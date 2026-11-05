import { describe, expect, it } from 'vitest';
import { asBidNumber, bidJumpTarget } from './bidJump';

describe('bid-number jump (FR-037)', () => {
  it('recognises exact GeM bid numbers only', () => {
    expect(asBidNumber('GEM/2026/B/6421001')).toBe('GEM/2026/B/6421001');
    expect(asBidNumber('  gem/2026/b/6421001 ')).toBe('GEM/2026/B/6421001');
    for (const bad of ['', 'laptop', 'GEM/2026/B/', 'GEM/26/B/1', 'GEM/2026/BB/1', 'GEM/2026/B/12a', 'GEM/2026/B/1 laptop', 'XGEM/2026/B/1']) {
      expect(asBidNumber(bad), bad).toBeNull();
    }
  });

  it('jumps only when exactly one tender has that bid number', () => {
    const q = 'GEM/2026/B/6421001';
    const one = { id: 'abc', bidNumber: q };
    expect(bidJumpTarget(q, [one])).toBe('/tenders/abc');
    expect(bidJumpTarget(' gem/2026/b/6421001 ', [one])).toBe('/tenders/abc');
    expect(bidJumpTarget(q, [one, { id: 'longer', bidNumber: 'GEM/2026/B/64210019' }])).toBe('/tenders/abc');
    expect(bidJumpTarget(q, [])).toBeNull();
    expect(bidJumpTarget(q, [one, { id: 'dup', bidNumber: q }])).toBeNull();
    expect(bidJumpTarget(q, [{ id: 'longer', bidNumber: 'GEM/2026/B/64210019' }])).toBeNull();
    expect(bidJumpTarget(q, undefined)).toBeNull();
    expect(bidJumpTarget('laptop', [one])).toBeNull();
  });
});
