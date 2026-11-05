/**
 * Vault-document matching shared by scoring (score.ts) and the checklist readiness (checklist.ts).
 * Leaf module: imports types only, so neither consumer creates an import cycle.
 */
import type { DocType } from './types';

export interface ScoreVaultDoc { id?: string; type: DocType; title?: string; expiryDate?: string | null; tags?: string[] }

/** Scoring validity rule: no expiry, or expiry date ≥ now (expiry is end of day 23:59:59 IST). */
export function isValidDoc(d: ScoreVaultDoc, now: Date) {
  if (!d.expiryDate) return true;
  const exp = new Date(`${d.expiryDate.slice(0, 10)}T23:59:59+05:30`);
  return exp.getTime() >= now.getTime();
}

export const certKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Does this vault document satisfy the named certificate (title/tags; ISO number must match)? Ignores validity. */
export function certMatches(name: string, d: ScoreVaultDoc): boolean {
  const k = certKey(name);
  return (
    (k.startsWith('iso') && d.type === 'iso' && certKey(`${d.title ?? ''} ${(d.tags ?? []).join(' ')}`).includes(k.replace('iso', ''))) ||
    (k === 'bis' && d.type === 'bis') ||
    certKey(d.title ?? '').includes(k)
  );
}

/** A valid (unexpired) vault document satisfies the named certificate. */
export const vaultHas = (name: string, vault: ScoreVaultDoc[], now: Date) => vault.some((d) => isValidDoc(d, now) && certMatches(name, d));
