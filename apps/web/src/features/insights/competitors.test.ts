import { describe, expect, it } from 'vitest';
import { ALL, hasFilters, parseFilters, rangeLabel, rankOf, selectValue, toQuery, toSearchParams, totalPages } from './competitors';

describe('competitor filters', () => {
  it('parses and normalises URL params', () => {
    expect(parseFilters(new URLSearchParams(''))).toEqual({ category: undefined, state: undefined, page: 1 });
    expect(parseFilters(new URLSearchParams('category=Laptops&state=%20Kerala%20&page=3'))).toEqual({ category: 'Laptops', state: 'Kerala', page: 3 });
    expect(parseFilters(new URLSearchParams('page=0')).page).toBe(1);
    expect(parseFilters(new URLSearchParams('page=abc')).page).toBe(1);
    expect(parseFilters(new URLSearchParams('page=99999')).page).toBe(1000);
  });
  it('round-trips to the URL omitting defaults', () => {
    expect(toSearchParams({ page: 1 }).toString()).toBe('');
    expect(toSearchParams({ category: 'A B', state: 'Goa', page: 2 }).toString()).toBe('category=A+B&state=Goa&page=2');
  });
  it('builds the API query', () => {
    expect(toQuery({ page: 1 })).toEqual({ page: 1, pageSize: 25 });
    expect(toQuery({ category: 'X', state: 'Y', page: 2 })).toEqual({ category: 'X', state: 'Y', page: 2, pageSize: 25 });
  });
  it('falls back to "all" for values missing from the facets', () => {
    expect(selectValue('Goa', ['Goa'])).toBe('Goa');
    expect(selectValue('Nope', ['Goa'])).toBe(ALL);
    expect(selectValue(undefined, ['Goa'])).toBe(ALL);
  });
  it('detects active filters', () => {
    expect(hasFilters({ page: 1 })).toBe(false);
    expect(hasFilters({ state: 'Goa', page: 1 })).toBe(true);
  });
});

describe('paging helpers', () => {
  it('computes pages, rank and range', () => {
    expect(totalPages(0)).toBe(1);
    expect(totalPages(25)).toBe(1);
    expect(totalPages(26)).toBe(2);
    expect(rankOf(0, 1)).toBe(1);
    expect(rankOf(4, 3)).toBe(55);
    expect(rangeLabel(1, 0, 0)).toBe('No sellers');
    expect(rangeLabel(1, 1, 1)).toBe('Showing 1–1 of 1 seller');
    expect(rangeLabel(2, 11, 36)).toBe('Showing 26–36 of 36 sellers');
  });
});
