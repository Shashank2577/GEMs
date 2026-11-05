import { describe, expect, it } from 'vitest';
import {
  activeFilterCount, DEFAULT_FILTERS, filtersFromParams, filtersToCriteria, filtersToParams, filtersToViewParams, isPristine, sameFilters, toApiQuery, VIEWS,
  viewParamsToFilters,
} from './filters';

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

describe('status selector (FR-036)', () => {
  it('round-trips open / closed / awarded / all and keeps open out of the URL', () => {
    for (const status of ['closed', 'awarded', 'all'] as const) {
      const f = { ...DEFAULT_FILTERS, status };
      const p = filtersToParams(f);
      expect(p.get('status')).toBe(status);
      expect(filtersFromParams(new URLSearchParams(p.toString())).status).toBe(status);
      expect(toApiQuery(f).status).toBe(status);
      expect(isPristine(f)).toBe(false);
      expect(activeFilterCount(f)).toBe(1);
    }
    expect(filtersToParams(DEFAULT_FILTERS).has('status')).toBe(false);
    expect(filtersFromParams(new URLSearchParams('status=cancelled')).status).toBe('open');
  });
});

describe('personal saved views (FR-035)', () => {
  it('round-trips filters through stored params and compares order-insensitively', () => {
    const f = { ...DEFAULT_FILTERS, states: ['Kerala', 'Goa'], closingWithin: 7, status: 'all' as const, sort: 'endAt' as const };
    const stored = filtersToViewParams(f);
    expect(stored).toEqual({ state: ['Kerala', 'Goa'], closing: ['7'], sort: ['endAt'], status: ['all'] });
    expect(viewParamsToFilters(stored)).toEqual(f);
    expect(sameFilters(f, { ...f, states: ['Goa', 'Kerala'] })).toBe(true);
    expect(sameFilters(f, { ...f, closingWithin: 3 })).toBe(false);
    expect(sameFilters(DEFAULT_FILTERS, viewParamsToFilters({}))).toBe(true);
    expect(viewParamsToFilters({ sort: ['hack'], evil: ['x'] })).toEqual(DEFAULT_FILTERS);
  });
});
