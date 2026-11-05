/** Go / No-Go ring segment math (donut bug fix; FR-093). */
import { describe, expect, it } from 'vitest';
import { donutSegments } from './donut';

const C = 2 * Math.PI * 50;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('donutSegments', () => {
  it('returns no arcs when nothing is analysed (the track alone is drawn)', () => {
    expect(donutSegments([{ key: 'go', value: 0 }, { key: 'review', value: 0 }, { key: 'no_go', value: 0 }], C, 3)).toEqual([]);
  });

  it('splits the circumference proportionally, leaving one gap per non-zero arc', () => {
    const s = donutSegments([{ key: 'go', value: 17 }, { key: 'review', value: 0 }, { key: 'no_go', value: 3 }], C, 3);
    expect(s.map((x) => x.key)).toEqual(['go', 'no_go']);
    expect(sum(s.map((x) => x.length)) + 2 * 3).toBeCloseTo(C, 6);
    expect(s[0]!.length / s[1]!.length).toBeCloseTo(17 / 3, 6);
    // Arcs are visible (non-zero), start half a gap after 12 o'clock and never overlap.
    expect(s[0]!.start).toBeCloseTo(1.5, 6);
    expect(s[1]!.start).toBeCloseTo(s[0]!.start + s[0]!.length + 3, 6);
    expect(s[1]!.start + s[1]!.length).toBeLessThanOrEqual(C);
  });

  it('draws a single verdict as a full ring without gaps', () => {
    const s = donutSegments([{ key: 'go', value: 0 }, { key: 'review', value: 4 }, { key: 'no_go', value: 0 }], C, 3);
    expect(s).toEqual([{ key: 'review', value: 4, length: C, start: 0 }]);
  });

  it('keeps every arc finite and positive for three verdicts', () => {
    const s = donutSegments([{ key: 'go', value: 1 }, { key: 'review', value: 1 }, { key: 'no_go', value: 1 }], C, 3);
    expect(s).toHaveLength(3);
    for (const x of s) {
      expect(Number.isFinite(x.length)).toBe(true);
      expect(x.length).toBeGreaterThan(0);
    }
  });
});
