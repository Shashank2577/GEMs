import { useQuery } from '@tanstack/react-query';
import type { InvitePreview } from '@tp/core/contracts/auth';
import { api, ApiError, errorMessage } from '@/lib/api';

export const authKeys = {
  invite: (token: string) => ['auth', 'invite', token] as const,
};

/** `GET /api/auth/invite/:token` — public invitation preview (002/FR-016, FR-019). 404 `invite_invalid` when unusable. */
export function useInvitePreview(token: string) {
  return useQuery({
    queryKey: authKeys.invite(token),
    queryFn: () => api.get<InvitePreview>(`/auth/invite/${encodeURIComponent(token)}`),
    enabled: !!token,
    staleTime: 60_000,
  });
}

export const INVITE_INVALID_MESSAGE = 'This invitation link is invalid, already used or has expired. Ask your admin for a new invitation.';

/** The invitation itself can no longer be used (expired, revoked, already accepted, unknown). */
export const isInviteInvalid = (err: unknown) => err instanceof ApiError && (err.code === 'invite_invalid' || err.status === 404);

export const isInviteMismatch = (err: unknown) => err instanceof ApiError && err.code === 'invite_email_mismatch';

export const mismatchMessage = (email: string) => `This invitation was sent to ${email}. Sign out and continue as that account.`;

/**
 * Which form the accept-invite page shows (002/FR-019):
 * - `signed-in`: "Accept & join team" for the account the invitation was sent to;
 * - `mismatch`: signed in as someone else — explain and offer "Sign out" (002/FR-018);
 * - `existing`: signed out, the invited email already has an account → password only, "Sign in & join";
 * - `new`: signed out, no account → name + password, "Join team".
 */
export type InviteMode = 'signed-in' | 'mismatch' | 'existing' | 'new';

export function inviteMode(preview: Pick<InvitePreview, 'email' | 'existingUser'>, me: { user: { email: string } } | null): InviteMode {
  if (me) return me.user.email.toLowerCase() === preview.email.toLowerCase() ? 'signed-in' : 'mismatch';
  return preview.existingUser ? 'existing' : 'new';
}

/** Form-level message for an accept-invite failure (field errors and invalid/mismatch states are handled by the page). */
export function acceptInviteError(err: unknown): string {
  // 002/FR-010: "Too many attempts. Try again in N minutes." instead of a credentials error.
  if (err instanceof ApiError && err.status === 429) return err.message;
  if (isInviteInvalid(err)) return INVITE_INVALID_MESSAGE;
  return errorMessage(err);
}

/** `details.fields` of a 400/401 accept-invite error, e.g. `{ password: 'Incorrect password' }`. */
export function acceptInviteFieldErrors(err: unknown): { name?: string; password?: string } {
  if (!(err instanceof ApiError)) return {};
  const fields = (err.details as { fields?: Record<string, string> } | undefined)?.fields ?? {};
  return { name: fields.name, password: fields.password };
}
