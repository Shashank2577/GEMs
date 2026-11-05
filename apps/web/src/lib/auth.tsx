import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError } from './api';
import type { Me, Role } from './types';

export type { Me, Role } from './types';

const ROLE_RANK: Record<Role, number> = { viewer: 0, analyst: 1, bid_manager: 2, owner: 3 };

/** can('analyst', 'bid_manager') → false. `min` is the minimum role required. */
export function can(role: Role | null | undefined, min: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export const ME_KEY = ['auth', 'me'] as const;

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
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<Me>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQuery = useMe();
  const me = meQuery.data ?? null;

  const setMe = useCallback((m: Me | null) => qc.setQueryData(ME_KEY, m), [qc]);

  const loginM = useMutation({ mutationFn: (b: { email: string; password: string }) => api.post<Me>('/auth/login', b) });
  const signupM = useMutation({ mutationFn: (b: { name: string; email: string; password: string; orgName: string }) => api.post<Me>('/auth/signup', b) });
  const inviteM = useMutation({ mutationFn: (b: { token: string; name?: string; password?: string }) => api.post<Me>('/auth/accept-invite', b) });

  const value = useMemo<AuthContextValue>(() => ({
    me,
    role: me?.role ?? null,
    isLoading: meQuery.isLoading,
    can: (min) => can(me?.role, min),
    login: async (b) => { const m = await loginM.mutateAsync(b); qc.clear(); setMe(m); return m; },
    signup: async (b) => { const m = await signupM.mutateAsync(b); qc.clear(); setMe(m); return m; },
    acceptInvite: async (b) => { const m = await inviteM.mutateAsync(b); qc.clear(); setMe(m); return m; },
    logout: async () => {
      try { await api.post('/auth/logout'); } catch { /* ignore */ }
      qc.clear();
      setMe(null);
    },
    switchOrg: async (orgId) => {
      const m = await api.post<Me>('/auth/switch-org', { orgId });
      qc.clear();
      setMe(m);
      return m;
    },
  }), [me, meQuery.isLoading, loginM, signupM, inviteM, qc, setMe]);

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
