/**
 * Platform contracts: auth, current user, organization, members, invitations, notification
 * preferences, API tokens and activity (contracts/api.md § Platform).
 */
import { z } from 'zod';
import { emailSchema, paginationQuerySchema, phoneE164Schema, roleSchema, type RoleName } from './common';

export const PASSWORD_MIN_LENGTH = 8;
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`).max(200);
const nameSchema = z.string().trim().min(1, 'Required').max(120);

// ───────────── Auth inputs ─────────────

export const signupInputSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  orgName: z.string().trim().min(2, 'Company name is too short').max(160),
});
export type SignupInput = z.infer<typeof signupInputSchema>;

export const loginInputSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Required').max(200),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const switchOrgInputSchema = z.object({ orgId: z.string().uuid() });
export type SwitchOrgInput = z.infer<typeof switchOrgInputSchema>;

export const acceptInviteInputSchema = z.object({
  token: z.string().min(10).max(200),
  name: nameSchema.optional(),
  password: z.string().max(200).optional(),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteInputSchema>;

export const updateMeInputSchema = z.object({
  name: nameSchema.optional(),
  phone: phoneE164Schema.nullable().optional(),
});
export type UpdateMeInput = z.infer<typeof updateMeInputSchema>;

export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;

// ───────────── Password reset (002/FR-011) ─────────────

export const forgotPasswordInputSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordInputSchema>;

export const resetPasswordInputSchema = z.object({
  token: z.string().min(10).max(200),
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;

/** Minutes a password reset link stays valid. */
export const PASSWORD_RESET_TTL_MINUTES = 60;

// ───────────── Sessions (002/FR-012) ─────────────

export interface SessionSummary {
  id: string;
  /** True for the session making the request ("This device"). */
  current: boolean;
  /** Raw User-Agent recorded at sign-in (may be null for sessions created before FR-012). */
  userAgent: string | null;
  /** Human summary, e.g. "Chrome on Windows". */
  device: string;
  createdAt: string;
  lastSeenAt: string | null;
}
export interface SessionsResponse { items: SessionSummary[]; total: number }
export interface RevokeOtherSessionsResponse { revoked: number }

/** "Mozilla/5.0 (Windows NT 10.0…) … Chrome/120…" → "Chrome on Windows". Unknown parts → "Unknown browser/device". */
export function summarizeUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser =
    /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
        : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
          : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
            : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
              : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
                : /^curl\//i.test(ua) ? 'curl'
                  : null;
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /CrOS/.test(ua) ? 'ChromeOS'
            : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
              : /Linux/.test(ua) ? 'Linux'
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? (os ? `Unknown browser on ${os}` : 'Unknown device');
}

// ───────────── Me ─────────────

export interface MeUser { id: string; name: string; email: string; phone: string | null }
export interface MeOrg {
  id: string; name: string; slug: string; plan: string;
  onboardingState: Record<string, boolean>;
  scoringWeights?: Record<string, number> | null;
}
export interface Me {
  user: MeUser;
  org: MeOrg;
  role: RoleName;
  orgs: { id: string; name: string; slug: string; role: RoleName }[];
}

/** Public preview of an invitation (GET /auth/invite/:token). */
export interface InvitePreview {
  orgName: string; email: string; role: RoleName; invitedBy: string | null;
  expiresAt: string; existingUser: boolean;
}

// ───────────── Notification preferences ─────────────

export const notificationPrefsSchema = z.object({
  inApp: z.boolean(),
  email: z.boolean(),
  whatsapp: z.boolean(),
  frequency: z.enum(['instant', 'daily']),
  expiryReminders: z.boolean(),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

// ───────────── API tokens ─────────────

export const API_TOKEN_PREFIX = 'tp_';
/** Allowed token lifetimes in days; `null` = never expires (002/FR-037). */
export const API_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;
export const API_TOKEN_DEFAULT_EXPIRY_DAYS = 90;
/** Max active (non-expired) tokens per user per organization (002/FR-037). */
export const API_TOKEN_LIMIT = 10;
export const createApiTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]).default(API_TOKEN_DEFAULT_EXPIRY_DAYS),
});
export type CreateApiTokenInput = z.input<typeof createApiTokenInputSchema>;
export interface ApiTokenSummary {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
  /** ISO timestamp; null = never expires. */
  expiresAt: string | null;
  /** Last 4 characters of the secret (`tp_…<hint>`); null for tokens created before hints existed. */
  hint: string | null;
}
/** Returned once on creation; `token` is never retrievable again. */
export interface CreatedApiToken extends ApiTokenSummary { token: string }

// ───────────── Organization & members ─────────────

export const inviteInputSchema = z.object({ email: emailSchema, role: roleSchema });
export type InviteInput = z.infer<typeof inviteInputSchema>;

export const changeRoleInputSchema = z.object({ role: roleSchema });
export type ChangeRoleInput = z.infer<typeof changeRoleInputSchema>;

export const updateOrgInputSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  /** Merged into the existing onboarding state (keys set to the given booleans). */
  onboardingState: z.record(z.string(), z.boolean()).optional(),
  /** Replaces the scoring weights; `null` resets to defaults. */
  scoringWeights: z.record(z.string(), z.number().min(0).max(100)).nullable().optional(),
});
export type UpdateOrgInput = z.infer<typeof updateOrgInputSchema>;

export interface Member {
  userId: string; name: string; email: string; phone: string | null; role: RoleName; joinedAt: string;
}
export interface PendingInvitation {
  id: string; email: string; role: RoleName; invitedBy: { id: string; name: string } | null;
  createdAt: string; expiresAt: string;
}
export interface MembersResponse { items: Member[]; total: number; invitations: PendingInvitation[] }
export interface CreatedInvitation { id: string; email: string; role: RoleName; inviteUrl: string; expiresAt: string }

// ───────────── Activity ─────────────

export const activityQuerySchema = paginationQuerySchema.extend({
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(100).optional(),
  userId: z.string().uuid().optional(),
});
export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export interface ActivityItem {
  id: string;
  user: { id: string; name: string } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}
