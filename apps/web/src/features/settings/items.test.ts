/** 002/US7 scenario 10 (T095): the palette's Settings group finds sub-pages by keyword, and both the side nav and the
 * palette share one list that hides unrouted pages and respects roles. */
import { defaultFilter } from 'cmdk';
import { describe, expect, it } from 'vitest';
import { can as roleCan } from '@/lib/auth';
import type { Role } from '@/lib/types';
import { SETTINGS_ITEMS, settingsPaletteValue, visibleSettingsItems, type SettingsItem } from './items';

const byLabel = (label: string) => SETTINGS_ITEMS.find((i) => i.label === label)!;
const score = (i: SettingsItem, q: string) => defaultFilter(settingsPaletteValue(i), q, i.keywords);
const best = (q: string) => [...SETTINGS_ITEMS].sort((a, b) => score(b, q) - score(a, q))[0];

describe('SETTINGS_ITEMS', () => {
  it('lists every settings sub-page from FR-039 with unique routes', () => {
    expect(SETTINGS_ITEMS.map((i) => i.label)).toEqual([
      'Organization', 'Plan & usage', 'Your account', 'Team & roles', 'Notifications', 'Scoring weights', 'API tokens & extension', 'Sync health', 'Activity log',
    ]);
    expect(new Set(SETTINGS_ITEMS.map((i) => i.to)).size).toBe(SETTINGS_ITEMS.length);
    expect(new Set(SETTINGS_ITEMS.map(settingsPaletteValue)).size).toBe(SETTINGS_ITEMS.length);
  });

  it.each([
    ['team', 'Team & roles'],
    ['api token', 'API tokens & extension'],
    ['activity', 'Activity log'],
    ['notification settings', 'Notifications'],
    ['scoring', 'Scoring weights'],
    ['password', 'Your account'],
  ])('palette query "%s" ranks %s first', (q, label) => {
    expect(score(byLabel(label), q)).toBeGreaterThan(0);
    expect(best(q).label).toBe(label);
  });

  it('does not clash with the "Go to → Notifications" palette value', () => {
    expect(settingsPaletteValue(byLabel('Notifications'))).not.toBe('Notifications alerts inbox');
  });
});

describe('visibleSettingsItems', () => {
  const asRole = (r: Role) => (min: Role) => roleCan(r, min);

  it('shows Activity log (shipped in T085) and hides any page flagged ready:false', () => {
    const labels = visibleSettingsItems(asRole('owner')).map((i) => i.label);
    expect(labels).toContain('Activity log');
    expect(labels).toHaveLength(SETTINGS_ITEMS.length);
    const hidden: SettingsItem[] = [{ ...byLabel('Activity log'), ready: false }];
    expect(visibleSettingsItems(asRole('owner'), hidden)).toEqual([]);
  });

  it('shows a ready Activity log to every role, and filters by `min`', () => {
    const items: SettingsItem[] = [{ ...byLabel('Activity log'), ready: true }, { ...byLabel('Sync health'), min: 'bid_manager' }];
    expect(visibleSettingsItems(asRole('viewer'), items).map((i) => i.label)).toEqual(['Activity log']);
    expect(visibleSettingsItems(asRole('bid_manager'), items).map((i) => i.label)).toEqual(['Activity log', 'Sync health']);
  });
});
