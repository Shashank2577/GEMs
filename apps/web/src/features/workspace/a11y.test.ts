import { describe, expect, it } from 'vitest';
import { nextTabIndex, packetReorderAnnouncements, readinessLabel } from './a11y';

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

describe('packetReorderAnnouncements (packet drag and drop, 006/NFR-006)', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const titles: Record<string, string> = { a: 'Cover', b: 'GST certificate', c: 'PAN card', d: 'D', e: 'E', f: 'F', g: 'G', h: 'H' };
  const a = packetReorderAnnouncements(ids, (id) => titles[id]);
  it('announces pick-up with title, position and total', () => {
    expect(a.onDragStart({ active: { id: 'c' } })).toBe('Picked up PAN card. Position 3 of 8.');
  });
  it('announces the position moved over', () => {
    expect(a.onDragOver({ active: { id: 'c' }, over: { id: 'b' } })).toBe('PAN card moved to position 2 of 8.');
    expect(a.onDragOver({ active: { id: 'c' }, over: null })).toBe('PAN card is no longer over a position in the packet.');
  });
  it('announces drop and cancel', () => {
    expect(a.onDragEnd({ active: { id: 'c' }, over: { id: 'b' } })).toBe('Dropped PAN card. Position 2 of 8.');
    expect(a.onDragEnd({ active: { id: 'c' }, over: null })).toBe('Dropped PAN card. Position 3 of 8, unchanged.');
    expect(a.onDragCancel({ active: { id: 'c' } })).toBe('Reordering cancelled. PAN card returned to position 3 of 8.');
  });
});
