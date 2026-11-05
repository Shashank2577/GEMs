import { describe, expect, it } from 'vitest';
import { matchesClosing, positionAt } from './position';

describe('positionAt', () => {
  const s = [{ position: 1 }, { position: 2 }, { position: 4 }];
  it('handles empty columns, top, middle and bottom', () => {
    expect(positionAt([], 0)).toBe(1);
    expect(positionAt(s, 0)).toBe(0);
    expect(positionAt(s, 1)).toBe(1.5);
    expect(positionAt(s, 2)).toBe(3);
    expect(positionAt(s, 3)).toBe(5);
  });
});

describe('matchesClosing', () => {
  const now = Date.parse('2026-11-04T04:30:00Z');
  it('filters by window', () => {
    expect(matchesClosing(null, 'any', now)).toBe(true);
    expect(matchesClosing(null, '7', now)).toBe(false);
    expect(matchesClosing('2026-11-06T04:30:00Z', '3', now)).toBe(true);
    expect(matchesClosing('2026-11-10T04:30:00Z', '3', now)).toBe(false);
    expect(matchesClosing('2026-11-10T04:30:00Z', '7', now)).toBe(true);
    expect(matchesClosing('2026-11-01T04:30:00Z', 'closed', now)).toBe(true);
  });
});
