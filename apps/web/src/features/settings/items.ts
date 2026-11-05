/**
 * Settings sub-pages (002/FR-039, FR-046): one list shared by the Settings side nav and the command palette's
 * "Settings" group, so both always offer the same sections with the same labels.
 */
import { Activity, BellRing, Building2, History, KeyRound, SlidersHorizontal, UserRound, Users, type LucideIcon } from 'lucide-react';
import type { Role } from '@/lib/types';

export interface SettingsItem {
  /** Sub-route under `/settings/` */
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
  /** Extra palette search terms (002/US7 scenario 10). */
  keywords: string[];
  /** Minimum role to see the item (default: viewer). */
  min?: Role;
  /**
   * `false` while a sub-page is not routed yet: hidden from the side nav and the palette so neither links to a
   * page that would only redirect. Every page is routed now (Activity log shipped with 002/FR-044, T085).
   */
  ready?: boolean;
}

export const SETTINGS_ITEMS: SettingsItem[] = [
  { to: 'organization', label: 'Organization', icon: Building2, description: 'Name and plan', keywords: ['org', 'company name', 'plan', 'rename'] },
  { to: 'account', label: 'Your account', icon: UserRound, description: 'Name, mobile, password', keywords: ['profile', 'password', 'mobile', 'sessions', 'leave organization'] },
  { to: 'team', label: 'Team & roles', icon: Users, description: 'Members and invitations', keywords: ['team', 'members', 'invite', 'roles', 'teammates', 'users'] },
  { to: 'notifications', label: 'Notifications', icon: BellRing, description: 'Email, WhatsApp, digests', keywords: ['notification settings', 'email', 'whatsapp', 'digest', 'alerts', 'preferences'] },
  { to: 'scoring', label: 'Scoring weights', icon: SlidersHorizontal, description: 'Tune Go / No-Go', keywords: ['scoring', 'weights', 'go no-go', 'score'] },
  { to: 'api-tokens', label: 'API tokens & extension', icon: KeyRound, description: 'Chrome co-pilot', keywords: ['api token', 'tokens', 'chrome extension', 'co-pilot', 'integration'] },
  { to: 'sync', label: 'Sync health', icon: Activity, description: 'GeM ingestion runs', keywords: ['sync', 'ingestion', 'gem runs', 'health'] },
  { to: 'activity', label: 'Activity log', icon: History, description: 'Who did what, when', keywords: ['activity', 'audit', 'history', 'log'] },
];

/** Items the current user may open: routed (`ready !== false`) and at or above `min` role. */
export function visibleSettingsItems(can: (min: Role) => boolean, items: SettingsItem[] = SETTINGS_ITEMS) {
  return items.filter((i) => i.ready !== false && (!i.min || can(i.min)));
}

/** cmdk `value` for a palette entry; distinct from the "Go to" Notifications item's value. */
export const settingsPaletteValue = (i: SettingsItem) => `${i.label} settings`;
