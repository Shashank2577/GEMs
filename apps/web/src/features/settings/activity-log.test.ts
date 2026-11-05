import { describe, expect, it } from 'vitest';
import { describeActivity, KNOWN_ACTIONS, SELF_CONTAINED } from '@/features/dashboard/activity';
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
  it('prefers the server target, then meta, then a generic noun', () => {
    expect(activityObject({ action: 'workspace.created', meta: { workspaceId: 'x' }, target: { label: 'Road repairs' } })).toBe('Road repairs');
    expect(activityObject({ action: 'vault.uploaded', meta: { fileName: 'gst.pdf' } })).toBe('gst.pdf');
    expect(activityObject({ action: 'profile.updated', meta: {} })).toBe('company profile');
  });
  it('FR-044: every known non-self-contained action reads as "Actor verb object" even with empty meta and no target', () => {
    for (const action of KNOWN_ACTIONS) {
      if (SELF_CONTAINED.has(action)) continue;
      expect(activityObject({ action, meta: {}, target: null }), action).toBeTruthy();
      expect(describeActivity({ action, meta: {} }).length, action).toBeGreaterThan(0);
    }
  });
  it('type groups cover every entityType the API writes', () => {
    const covered = new Set(ACTIVITY_TYPES.flatMap((t) => t.value.split(',')));
    for (const t of ['workspace', 'tender', 'vault_document', 'watchlist', 'profile', 'past_contract', 'annexure_template', 'user', 'invitation', 'api_token', 'organization', 'ingestion_run']) {
      expect(covered.has(t), t).toBe(true);
    }
  });
  it('has unique type values', () => { expect(new Set(ACTIVITY_TYPES.map((t) => t.value)).size).toBe(ACTIVITY_TYPES.length); });
});
