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

/** Expiry choices for the create dialog; `never` maps to `expiresInDays: null`. */
export const TOKEN_EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
] as const;
export type TokenExpiryChoice = (typeof TOKEN_EXPIRY_OPTIONS)[number]['value'];
export const expiresInDaysFor = (v: TokenExpiryChoice): 30 | 90 | 365 | null => (v === 'never' ? null : (Number(v) as 30 | 90 | 365));
