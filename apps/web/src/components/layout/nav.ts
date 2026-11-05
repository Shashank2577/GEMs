import { Bell, Building2, FileStack, KanbanSquare, LayoutDashboard, Radar, Settings, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { Role } from '@/lib/types';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Minimum role to see the item (default: viewer) */
  min?: Role;
  /** Short label for the mobile tab bar */
  short?: string;
  keywords?: string[];
}

export const NAV_MAIN: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, short: 'Home', keywords: ['home', 'overview'] },
  { to: '/tenders', label: 'Tenders', icon: FileStack, short: 'Tenders', keywords: ['feed', 'bids', 'gem', 'bidplus'] },
  { to: '/watchlists', label: 'Watchlists', icon: Radar, keywords: ['alerts', 'filters', 'categories'] },
  { to: '/pipeline', label: 'Pipeline', icon: KanbanSquare, short: 'Pipeline', keywords: ['kanban', 'workspaces', 'bids'] },
  { to: '/vault', label: 'Document vault', icon: ShieldCheck, short: 'Vault', keywords: ['certificates', 'gst', 'pan', 'documents'] },
];

export const NAV_ORG: NavItem[] = [
  { to: '/profile', label: 'Company profile', icon: Building2, keywords: ['turnover', 'msme', 'udyam', 'company'] },
  { to: '/notifications', label: 'Notifications', icon: Bell, keywords: ['alerts', 'inbox'] },
  { to: '/settings', label: 'Settings', icon: Settings, keywords: ['team', 'members', 'preferences', 'tokens'] },
];

export const MOBILE_TABS: NavItem[] = [NAV_MAIN[0], NAV_MAIN[1], NAV_MAIN[3], NAV_MAIN[4]];
