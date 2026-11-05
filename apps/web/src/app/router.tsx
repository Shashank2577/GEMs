import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation, type RouteObject } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { LogoMark } from '@/components/layout/Logo';
import { dropLandingShell } from '@/features/landing/shell';
import { RequireAuth, safeNext, useAuth } from '@/lib/auth';

const LandingPage = lazy(() => import('@/features/landing/LandingPage'));
const LoginPage = lazy(() => import('@/features/auth/LoginPage'));
const SignupPage = lazy(() => import('@/features/auth/SignupPage'));
const AcceptInvitePage = lazy(() => import('@/features/auth/AcceptInvitePage'));
const ForgotPasswordPage = lazy(() => import('@/features/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('@/features/auth/ResetPasswordPage'));
const OnboardingPage = lazy(() => import('@/features/onboarding/OnboardingPage'));
const DashboardPage = lazy(() => import('@/features/dashboard/DashboardPage'));
const FeedPage = lazy(() => import('@/features/feed/FeedPage'));
const TenderPage = lazy(() => import('@/features/tender/TenderPage'));
const WatchlistsPage = lazy(() => import('@/features/watchlists/WatchlistsPage'));
const PipelinePage = lazy(() => import('@/features/pipeline/PipelinePage'));
const WorkspacePage = lazy(() => import('@/features/workspace/WorkspacePage'));
const VaultPage = lazy(() => import('@/features/vault/VaultPage'));
const ProfilePage = lazy(() => import('@/features/profile/ProfilePage'));
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage'));
const CompetitorsPage = lazy(() => import('@/features/insights/CompetitorsPage'));
const NotificationsPage = lazy(() => import('@/features/notifications/NotificationsPage'));
const NotFoundPage = lazy(() => import('./NotFoundPage'));
const UiGallery = import.meta.env.DEV ? lazy(() => import('./UiGallery')) : null;

/** Full-screen splash while the session or a top-level chunk loads. */
export function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background" role="status" aria-label="Loading TenderPilot">
      <LogoMark className="size-10 animate-pulse" />
    </div>
  );
}

const S = ({ children }: { children: ReactNode }) => <Suspense fallback={<Splash />}>{children}</Suspense>;

/** Public-only routes (landing, login, signup): signed-in users go to the app. */
function PublicOnly() {
  const { me, isLoading } = useAuth();
  const loc = useLocation();
  useEffect(() => { if (me) dropLandingShell(); }, [me]);
  // The landing page (and only it) renders while the session check is in flight: it is public marketing content and
  // waiting on /api/auth/me would delay LCP (007/NFR-003). A signed-in visitor is redirected as soon as the check settles.
  if (isLoading && loc.pathname !== '/') return <Splash />;
  if (me) return <Navigate to={safeNext(new URLSearchParams(loc.search).get('next'))} replace />;
  return <S><Outlet /></S>;
}

function Protected() {
  return <RequireAuth fallback={<Splash />}><Outlet /></RequireAuth>;
}

export const routes: RouteObject[] = [
  {
    element: <PublicOnly />,
    children: [
      { path: '/', element: <LandingPage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
    ],
  },
  { path: '/invite/:token', element: <S><AcceptInvitePage /></S> },
  // Not public-only: a signed-in user may open an emailed link; a successful reset replaces their session.
  { path: '/reset-password/:token', element: <S><ResetPasswordPage /></S> },
  {
    element: <Protected />,
    children: [
      { path: '/onboarding', element: <S><OnboardingPage /></S> },
      {
        element: <AppShell />,
        children: [
          { path: '/dashboard', element: <DashboardPage /> },
          { path: '/tenders', element: <FeedPage /> },
          { path: '/tenders/:id', element: <TenderPage /> },
          { path: '/watchlists', element: <WatchlistsPage /> },
          { path: '/pipeline', element: <PipelinePage /> },
          { path: '/workspaces/:id', element: <WorkspacePage /> },
          { path: '/competitors', element: <CompetitorsPage /> },
          { path: '/vault', element: <VaultPage /> },
          { path: '/profile', element: <ProfilePage /> },
          { path: '/settings/*', element: <SettingsPage /> },
          { path: '/notifications', element: <NotificationsPage /> },
        ],
      },
    ],
  },
  ...(UiGallery ? [{ path: '/dev/ui', element: <S><UiGallery /></S> }] : []),
  { path: '*', element: <S><NotFoundPage /></S> },
];

export const router = createBrowserRouter(routes);
