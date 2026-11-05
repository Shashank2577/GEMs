import { describe, expect, it } from 'vitest';
import { activeFilterCount, DEFAULT_FILTERS, filtersFromParams, filtersToCriteria, filtersToParams, isPristine, toApiQuery, VIEWS } from './filters';

describe('feed filters', () => {
  it('round-trips through URL params (multi-value, numbers, flags)', () => {
    const f = { ...DEFAULT_FILTERS, q: 'laptop', states: ['Maharashtra', 'Gujarat'], ministries: ['Ministry of Defence'], closingWithin: 7, minValue: 10_00_000, maxValue: null, matched: true, verdicts: ['go'], bidTypes: ['ra'], sort: 'endAt' as const };
    const p = filtersToParams(f);
    expect(p.getAll('state')).toEqual(['Maharashtra', 'Gujarat']);
    expect(p.get('sort')).toBe('endAt');
    expect(filtersFromParams(new URLSearchParams(p.toString()))).toEqual(f);
  });

  it('ignores junk sort values and defaults to open bids', () => {
    const f = filtersFromParams(new URLSearchParams('sort=hack&closing=abc&status=nope'));
    expect(f.sort).toBe(DEFAULT_FILTERS.sort);
    expect(f.closingWithin).toBeNull();
    expect(f.status).toBe('open');
    expect(isPristine(f)).toBe(true);
  });

  it('builds the API query and counts refinements', () => {
    const f = { ...DEFAULT_FILTERS, states: ['Kerala'], minValue: 5, matched: true };
    expect(toApiQuery(f)).toMatchObject({ state: ['Kerala'], minValue: 5, matched: 1, sort: '-createdAt', status: 'open' });
    expect(activeFilterCount(f)).toBe(2);
  });

  it('turns filters into watchlist criteria', () => {
    expect(filtersToCriteria({ ...DEFAULT_FILTERS, q: ' cctv camera ', states: ['Karnataka'], maxValue: 50_00_000 })).toMatchObject({
      keywords: ['cctv camera'], states: ['Karnataka'], maxValue: 50_00_000, minValue: null,
    });
  });

  it('saved views apply and are recognised', () => {
    for (const v of VIEWS) expect(v.match(v.apply(DEFAULT_FILTERS))).toBe(true);
  });
});
