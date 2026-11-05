/** Copy and helpers for renewal, version history and duplicate detection (US6; FR-064…FR-068). */
import type { VaultDocumentDto, VaultVersionDto } from '@tp/core/contracts/vault';
import { istDate, suggestExpiry } from '@tp/core/vault/status';
import { formatBytes } from '@/components/ui/dropzone';
import { ApiError } from '@/lib/api';
import { formatDateIST, relativeTime } from '@/lib/format';

export interface RenewDraft { issueDate: string; expiryDate: string; number: string }

/** Dialog defaults: issue date today (IST), expiry suggested from the type's validity, current number. */
export function renewDefaults(doc: Pick<VaultDocumentDto, 'type' | 'number'>, now: Date = new Date()): RenewDraft {
  const issueDate = istDate(now);
  return { issueDate, expiryDate: suggestExpiry(doc.type, issueDate) ?? '', number: doc.number ?? '' };
}

/** Toast after a renewal: "“<title>” renewed — valid till <date>" (FR-064). */
export function renewedMessage(doc: Pick<VaultDocumentDto, 'title' | 'expiryDate'>): string {
  return doc.expiryDate ? `“${doc.title}” renewed — valid till ${formatDateIST(doc.expiryDate)}` : `“${doc.title}” renewed`;
}

/** "<file name> · <size> · replaced <relative> by <name>" (US6 scenario 3). */
export function versionLine(v: VaultVersionDto, now: Date = new Date()): string {
  return `${v.fileName} · ${formatBytes(v.sizeBytes)} · replaced ${relativeTime(v.replacedAt, now)}${v.replacedBy ? ` by ${v.replacedBy.name}` : ''}`;
}

export interface DuplicateInfo { existingId: string; title: string }

/** The existing document when the API refused the file as a duplicate (409 `duplicate_document`, FR-067). */
export function duplicateOf(err: unknown): DuplicateInfo | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'duplicate_document') return null;
  const d = err.details as Partial<DuplicateInfo> | undefined;
  return d && typeof d.existingId === 'string' && typeof d.title === 'string' ? { existingId: d.existingId, title: d.title } : null;
}

/** "This file is already in your vault as “<title>”." */
export const duplicateMessage = (title: string) => `This file is already in your vault as “${title}”.`;
