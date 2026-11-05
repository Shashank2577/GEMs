import { describe, expect, it } from 'vitest';
import { nextTabIndex, readinessLabel } from './a11y';

describe('nextTabIndex (Documents filter tabs, 006/NFR-006)', () => {
  it('moves right/left with wrap-around', () => {
    expect(nextTabIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 1, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
  });
  it('jumps with Home/End', () => {
    expect(nextTabIndex('Home', 2, 3)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
  });
  it('ignores other keys and empty lists', () => {
    expect(nextTabIndex('Enter', 1, 3)).toBeNull();
    expect(nextTabIndex('ArrowDown', 1, 3)).toBeNull();
    expect(nextTabIndex('ArrowRight', 0, 0)).toBeNull();
  });
});

describe('readinessLabel', () => {
  it('names the ring', () => {
    expect(readinessLabel(83)).toBe('Readiness 83 percent');
    expect(readinessLabel(100)).toBe('Readiness 100 percent');
  });
});
