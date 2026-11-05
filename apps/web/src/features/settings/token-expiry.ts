import { API_TOKEN_DEFAULT_EXPIRY_DAYS, API_TOKEN_EXPIRY_DAYS, type ApiTokenExpiryDays } from '@tp/core/contracts/auth';

/**
 * Token list expiry badge (002/FR-037): "Never expires", "Expires in N days" (amber under 7 days) or red "Expired".
 */
export type TokenExpiryTone = 'neutral' | 'warning' | 'danger';
export interface TokenExpiry { label: string; tone: TokenExpiryTone }

const DAY_MS = 24 * 60 * 60 * 1000;

export function tokenExpiry(expiresAt: string | null, now: Date = new Date()): TokenExpiry {
  if (!expiresAt) return { label: 'Never expires', tone: 'neutral' };
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (ms <= 0) return { label: 'Expired', tone: 'danger' };
  const days = Math.ceil(ms / DAY_MS);
  return { label: `Expires in ${days} ${days === 1 ? 'day' : 'days'}`, tone: days < 7 ? 'warning' : 'neutral' };
}

/** `tp_…a1B2`, or a plain `tp_…` for tokens created before hints were stored. */
export const tokenHintLabel = (hint: string | null) => `tp_…${hint ?? ''}`;

/** Expiry choices for the create dialog, built from API_TOKEN_EXPIRY_DAYS; `never` maps to `expiresInDays: null`. */
export type TokenExpiryChoice = `${ApiTokenExpiryDays}` | 'never';
const daysLabel = (d: number) => (d % 365 === 0 ? (d === 365 ? '1 year' : `${d / 365} years`) : `${d} days`);
export const TOKEN_EXPIRY_OPTIONS: { value: TokenExpiryChoice; label: string }[] = [
  ...API_TOKEN_EXPIRY_DAYS.map((d) => ({ value: String(d) as TokenExpiryChoice, label: daysLabel(d) })),
  { value: 'never', label: 'Never' },
];
export const DEFAULT_TOKEN_EXPIRY_CHOICE = String(API_TOKEN_DEFAULT_EXPIRY_DAYS) as TokenExpiryChoice;
export const expiresInDaysFor = (v: TokenExpiryChoice): ApiTokenExpiryDays | null => (v === 'never' ? null : (Number(v) as ApiTokenExpiryDays));
