import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActivityItem, ActivityQuery, ApiTokenSummary, CreateApiTokenInput, CreatedApiToken, CreatedInvitation, Me, MembersResponse, NotificationPrefs,
  RevokeOtherSessionsResponse, SessionsResponse, TestAlertResult,
} from '@tp/core/contracts/auth';
import type { ScoringWeights } from '@tp/core/contracts/analyse';
import type { IngestionRunsResponse } from '@tp/core/contracts/identify';
import { useNavigate } from 'react-router-dom';
import { toast } from '@/components/ui/toaster';
import { api, type Paged } from '@/lib/api';
import { ME_KEY, useAuth } from '@/lib/auth';
import { notificationKeys } from '@/features/notifications/api';

export const settingsKeys = {
  members: ['org', 'members'] as const,
  prefs: ['me', 'notification-prefs'] as const,
  tokens: ['me', 'api-tokens'] as const,
  sessions: ['me', 'sessions'] as const,
  weights: ['scoring-weights'] as const,
  runs: ['ingestion', 'runs'] as const,
  activity: ['activity'] as const,
};

function useSetMe() {
  const qc = useQueryClient();
  return (me: Me) => qc.setQueryData(ME_KEY, me);
}

// ── Organization ──
export function useUpdateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; onboardingState?: Record<string, boolean> }) => api.patch('/org', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_KEY }),
  });
}

// ── Account ──
export function useUpdateMe() {
  const setMe = useSetMe();
  return useMutation({ mutationFn: (body: { name?: string; phone?: string | null }) => api.patch<Me>('/me', body), onSuccess: setMe });
}
export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) => api.post('/me/password', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.sessions }),
  });
}

// ── Sessions (002/FR-012) ──
export function useSessions() {
  return useQuery({ queryKey: settingsKeys.sessions, queryFn: () => api.get<SessionsResponse>('/me/sessions') });
}
export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.delete(`/me/sessions/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.sessions }) });
}
export function useRevokeOtherSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RevokeOtherSessionsResponse>('/me/sessions/revoke-others'),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.sessions }),
  });
}

// ── Team ──
export function useMembers() {
  return useQuery({ queryKey: settingsKeys.members, queryFn: () => api.get<MembersResponse>('/org/members') });
}
function useMembersMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => { qc.invalidateQueries({ queryKey: settingsKeys.members }); qc.invalidateQueries({ queryKey: ['dashboard'] }); } });
}
export const useInvite = () => useMembersMutation((b: { email: string; role: string }) => api.post<CreatedInvitation>('/org/invitations', b));
export const useRevokeInvite = () => useMembersMutation((id: string) => api.delete(`/org/invitations/${id}`));
/** New link + 7-day expiry, emailed again (002/FR-020). */
export const useResendInvite = () => useMembersMutation((id: string) => api.post<CreatedInvitation>(`/org/invitations/${id}/resend`));
export const useChangeRole = () => useMembersMutation(({ userId, role }: { userId: string; role: string }) => api.patch(`/org/members/${userId}`, { role }));
export const useRemoveMember = () => useMembersMutation((userId: string) => api.delete(`/org/members/${userId}`));
/**
 * Leave the active org (002/FR-027): toast "You left <Org>." and land on the next org's dashboard, or on /login when
 * none is left. Success handling lives on the hook (not `mutate()` callbacks) because signing out unmounts the page.
 */
export function useLeaveOrg() {
  const { leaveOrg } = useAuth();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => leaveOrg(),
    onSuccess: ({ orgName, nextOrgId }) => {
      toast.success(`You left ${orgName}.`);
      navigate(nextOrgId ? '/dashboard' : '/login', { replace: true });
    },
  });
}

// ── Notifications ──
export function usePrefs() {
  return useQuery({ queryKey: settingsKeys.prefs, queryFn: () => api.get<NotificationPrefs>('/me/notification-prefs') });
}
export function useSavePrefs() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (b: NotificationPrefs) => api.put<NotificationPrefs>('/me/notification-prefs', b), onSuccess: (p) => qc.setQueryData(settingsKeys.prefs, p) });
}
/** "Send a test alert" across the enabled channels (002/FR-034); 429 when sent within the last minute. */
export function useSendTestAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<TestAlertResult>('/me/notifications/test'),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

// ── Scoring weights ──
export function useWeights() {
  return useQuery({ queryKey: settingsKeys.weights, queryFn: () => api.get<ScoringWeights>('/scoring-weights') });
}
export function useSaveWeights() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (w: Record<string, number>) => api.put<ScoringWeights>('/scoring-weights', w),
    onSuccess: (w) => { qc.setQueryData(settingsKeys.weights, w); qc.invalidateQueries({ queryKey: ME_KEY }); },
  });
}

// ── API tokens ──
export function useTokens() {
  return useQuery({ queryKey: settingsKeys.tokens, queryFn: () => api.get<Paged<ApiTokenSummary>>('/me/api-tokens') });
}
export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: CreateApiTokenInput) => api.post<CreatedApiToken>('/me/api-tokens', input), onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.tokens }) });
}
export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.delete(`/me/api-tokens/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.tokens }) });
}

// ── Sync health ──
export function useRuns() {
  return useQuery({ queryKey: settingsKeys.runs, queryFn: () => api.get<IngestionRunsResponse>('/ingestion/runs'), refetchInterval: 60_000 });
}
export function useRunIngestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/ingestion/run', {}),
    onSettled: () => { qc.invalidateQueries({ queryKey: settingsKeys.runs }); qc.invalidateQueries({ queryKey: ['tenders'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); },
  });
}

/** Copy text with a graceful fallback for non-secure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

// ── Activity log (002/FR-043, FR-044) ──
export function useActivity(params: ActivityQuery) {
  return useQuery({
    queryKey: [...settingsKeys.activity, params] as const,
    queryFn: () => api.get<Paged<ActivityItem>>('/activity', params as Record<string, string | number>),
    placeholderData: keepPreviousData,
  });
}
