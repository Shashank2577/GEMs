import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError, ME_KEY, queryClient, resetSessionCache } from './api';
import type { Me, Role } from './types';

export type { Me, Role } from './types';

const ROLE_RANK: Record<Role, number> = { viewer: 0, analyst: 1, bid_manager: 2, owner: 3 };

/** can('analyst', 'bid_manager') → false. `min` is the minimum role required. */
export function can(role: Role | null | undefined, min: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export { ME_KEY };

/** GET /api/auth/me. `data` is null when signed out (401). */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api.get<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
  });
}

interface AuthContextValue {
  me: Me | null;
  role: Role | null;
  isLoading: boolean;
  can: (min: Role) => boolean;
  login: (input: { email: string; password: string }) => Promise<Me>;
  signup: (input: { name: string; email: string; password: string; orgName: string }) => Promise<Me>;
  acceptInvite: (input: { token: string; name?: string; password?: string }) => Promise<Me>;
  /** Set a new password from an emailed link; signs in (002/FR-011). */
  resetPassword: (input: { token: string; newPassword: string }) => Promise<Me>;
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<Me>;
  /**
   * Leave the active organization (002/FR-027). The server moves the session to the next org; with none left the
   * user is signed out. Resolves with the left org's name and `nextOrgId` (null = signed out).
   */
  leaveOrg: () => Promise<{ orgName: string; nextOrgId: string | null }>;
}

/**
 * 002/FR-027: leave the active org. The server moves the session to the next org (or none); then load the new `Me`,
 * or sign out when no org is left. Once the DELETE succeeded this never rejects: a failing `/auth/me` falls back to
 * dropping the org-scoped cache and refetching `ME_KEY`.
 */
export async function leaveOrganization(me: Me | null, setMe: (m: Me | null) => void): Promise<{ orgName: string; nextOrgId: string | null }> {
  const orgName = me?.org.name ?? 'the organization';
  const { nextOrgId } = await api.delete<{ ok: true; nextOrgId: string | null }>('/org/members/me');
  if (nextOrgId) {
    try {
      setMe(await api.get<Me>('/auth/me'));
    } catch {
      // Keep the (now stale) user only to avoid a sign-out flash; drop every org-scoped query and refetch /auth/me.
      resetSessionCache(me);
      void queryClient.invalidateQueries({ queryKey: ME_KEY, exact: true });
    }
  } else {
    try { await api.post('/auth/logout'); } catch { /* the membership is gone either way */ }
    setMe(null);
  }
  return { orgName, nextOrgId };
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const meQuery = useMe();
  const me = meQuery.data ?? null;

  /** Replace the signed-in user and drop every other cached query (keeps the observed ME_KEY query). */
  const setMe = useCallback((m: Me | null) => resetSessionCache(m), []);

  // `authFlow`: a 401 here is a form error, not a session end (002/FR-013).
  const meta = { authFlow: true };
  const loginM = useMutation({ meta, mutationFn: (b: { email: string; password: string }) => api.post<Me>('/auth/login', b) });
  const signupM = useMutation({ meta, mutationFn: (b: { name: string; email: string; password: string; orgName: string }) => api.post<Me>('/auth/signup', b) });
  const inviteM = useMutation({ meta, mutationFn: (b: { token: string; name?: string; password?: string }) => api.post<Me>('/auth/accept-invite', b) });
  const resetM = useMutation({ meta, mutationFn: (b: { token: string; newPassword: string }) => api.post<Me>('/auth/reset-password', b) });

  const value = useMemo<AuthContextValue>(() => ({
    me,
    role: me?.role ?? null,
    isLoading: meQuery.isLoading,
    can: (min) => can(me?.role, min),
    login: async (b) => { const m = await loginM.mutateAsync(b); setMe(m); return m; },
    signup: async (b) => { const m = await signupM.mutateAsync(b); setMe(m); return m; },
    acceptInvite: async (b) => { const m = await inviteM.mutateAsync(b); setMe(m); return m; },
    resetPassword: async (b) => { const m = await resetM.mutateAsync(b); setMe(m); return m; },
    logout: async () => {
      try { await api.post('/auth/logout'); } catch { /* ignore */ }
      setMe(null);
    },
    switchOrg: async (orgId) => {
      const m = await api.post<Me>('/auth/switch-org', { orgId });
      setMe(m);
      return m;
    },
    leaveOrg: () => leaveOrganization(me, setMe),
  }), [me, meQuery.isLoading, loginM, signupM, inviteM, resetM, setMe]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Convenience: `const allowed = useCan('analyst')` */
export function useCan(min: Role) {
  return can(useAuth().role, min);
}

/** Route guard: redirects to /login?next=<current path> when signed out. */
export function RequireAuth({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const { me, isLoading } = useAuth();
  const loc = useLocation();
  if (isLoading) return <>{fallback ?? null}</>;
  if (!me) {
    const next = loc.pathname + loc.search;
    return <Navigate to={`/login${next && next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`} replace />;
  }
  return <>{children}</>;
}

/** Renders children only if the current role is at least `min`. */
export function RoleGate({ min, children, fallback = null }: { min: Role; children: ReactNode; fallback?: ReactNode }) {
  return can(useAuth().role, min) ? <>{children}</> : <>{fallback}</>;
}

/** Only allow relative in-app redirect targets. */
export function safeNext(next: string | null | undefined, fallback = '/dashboard') {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return fallback;
  return next;
}
