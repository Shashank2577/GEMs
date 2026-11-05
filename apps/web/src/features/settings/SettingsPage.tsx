/**
 * Settings (T073; US6): Organization, Plan & usage (008/FR-041c), Account, Team & roles, Notifications, Scoring weights, API tokens & extension,
 * Sync health. Sub-routes under /settings/* with a side nav (desktop) / scrollable tabs (phone).
 */
import { lazy, Suspense } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { Activity, BellRing, Building2, Gauge, KeyRound, SlidersHorizontal, UserRound, Users, type LucideIcon } from 'lucide-react';
import { PageHeader, SkeletonList } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import type { Role } from '@/lib/types';
import { cn } from '@/lib/utils';

const OrganizationSection = lazy(() => import('./sections/OrganizationSection'));
const UsageSection = lazy(() => import('./sections/UsageSection'));
const AccountSection = lazy(() => import('./sections/AccountSection'));
const TeamSection = lazy(() => import('./sections/TeamSection'));
const NotificationsSection = lazy(() => import('./sections/NotificationsSection'));
const ScoringSection = lazy(() => import('./sections/ScoringSection'));
const TokensSection = lazy(() => import('./sections/TokensSection'));
const SyncSection = lazy(() => import('./sections/SyncSection'));

interface Item { to: string; label: string; icon: LucideIcon; min?: Role; description: string }
const ITEMS: Item[] = [
  { to: 'organization', label: 'Organization', icon: Building2, description: 'Name and plan' },
  { to: 'usage', label: 'Plan & usage', icon: Gauge, description: 'Limits, trial and meters' },
  { to: 'account', label: 'Your account', icon: UserRound, description: 'Name, mobile, password' },
  { to: 'team', label: 'Team & roles', icon: Users, description: 'Members and invitations' },
  { to: 'notifications', label: 'Notifications', icon: BellRing, description: 'Email, WhatsApp, digests' },
  { to: 'scoring', label: 'Scoring weights', icon: SlidersHorizontal, description: 'Tune Go / No-Go' },
  { to: 'api-tokens', label: 'API tokens & extension', icon: KeyRound, description: 'Chrome co-pilot' },
  { to: 'sync', label: 'Sync health', icon: Activity, description: 'GeM ingestion runs' },
];

export default function SettingsPage() {
  const { can } = useAuth();
  const items = ITEMS.filter((i) => !i.min || can(i.min));
  return (
    <div>
      <PageHeader title="Settings" description="Your team, alerts, scoring and integrations." />
      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
        <nav aria-label="Settings sections" className="scrollbar-thin -mx-4 overflow-x-auto px-4 lg:mx-0 lg:overflow-visible lg:px-0">
          <ul className="flex gap-1 lg:sticky lg:top-20 lg:flex-col">
            {items.map((i) => (
              <li key={i.to} className="shrink-0">
                <NavLink to={`/settings/${i.to}`}
                  className={({ isActive }) => cn('flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] font-medium transition-colors focus-ring',
                    isActive ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                  <i.icon className="size-4 shrink-0" aria-hidden />
                  {i.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0">
          <Suspense fallback={<SkeletonList rows={4} />}>
            <Routes>
              <Route index element={<Navigate to="organization" replace />} />
              <Route path="organization" element={<OrganizationSection />} />
              <Route path="usage" element={<UsageSection />} />
              <Route path="account" element={<AccountSection />} />
              <Route path="team" element={<TeamSection />} />
              <Route path="notifications" element={<NotificationsSection />} />
              <Route path="scoring" element={<ScoringSection />} />
              <Route path="api-tokens" element={<TokensSection />} />
              <Route path="tokens" element={<Navigate to="/settings/api-tokens" replace />} />
              <Route path="sync" element={<SyncSection />} />
              <Route path="*" element={<Navigate to="/settings/organization" replace />} />
            </Routes>
          </Suspense>
        </div>
      </div>
    </div>
  );
}
