import { describe, expect, it } from 'vitest';
import type { TenderListItem } from '@tp/core/contracts/identify';
import { reasonChips } from './TenderCard';
import { PAGE_SIZE } from './api';

const t = (reasons: string[][]) => ({ matches: reasons.map((r) => ({ reasons: r })) }) as unknown as TenderListItem;

describe('feed constants', () => {
  it('first page is 25 cards', () => expect(PAGE_SIZE).toBe(25));
});

describe('reasonChips', () => {
  it('shows up to 3 unique chips plus a +n more count', () => {
    expect(reasonChips(t([['a', 'b'], ['b', 'c', 'd']]))).toEqual({ chips: ['a', 'b', 'c'], more: 1 });
  });
  it('has no overflow for 3 or fewer', () => {
    expect(reasonChips(t([['a', 'b', 'c']]))).toEqual({ chips: ['a', 'b', 'c'], more: 0 });
  });
});
