import { describe, expect, it } from 'vitest';
import { activityObject, activityParams, ACTIVITY_TYPES, pageCount, rangeLabel } from './activity-log';

describe('activity log helpers', () => {
  it('maps filters to API params and omits "all"', () => {
    expect(activityParams({ page: 1, member: 'all', type: 'all' })).toEqual({ page: 1, pageSize: 25 });
    expect(activityParams({ page: 2, member: 'u1', type: 'api_token' })).toEqual({ page: 2, pageSize: 25, userId: 'u1', entityType: 'api_token' });
  });
  it('formats the range label', () => {
    expect(rangeLabel(1, 25, 61)).toBe('Showing 1–25 of 61');
    expect(rangeLabel(3, 11, 61)).toBe('Showing 51–61 of 61');
    expect(rangeLabel(1, 0, 0)).toBe('No results');
  });
  it('counts pages', () => { expect(pageCount(0)).toBe(1); expect(pageCount(25)).toBe(1); expect(pageCount(26)).toBe(2); });
  it('shows only name/email from meta', () => {
    expect(activityObject({ meta: { name: 'CI', token: 'x' } })).toBe('CI');
    expect(activityObject({ meta: { email: 'a@b.in' } })).toBe('a@b.in');
    expect(activityObject({ meta: {} })).toBeNull();
  });
  it('has unique type values', () => { expect(new Set(ACTIVITY_TYPES.map((t) => t.value)).size).toBe(ACTIVITY_TYPES.length); });
});
