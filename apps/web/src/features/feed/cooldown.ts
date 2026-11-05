import type { IngestionRunDto, IngestionRunsResponse } from '@tp/core/contracts/identify';
import { MANUAL_SYNC_COOLDOWN_MIN } from '@tp/core/contracts/caps';

/** 008/FR-026 (supersedes 003 FR-013's 2 min): default gap between manual syncs; the server may configure another. */
export const MANUAL_SYNC_COOLDOWN_MS = MANUAL_SYNC_COOLDOWN_MIN * 60_000;

/**
 * When the next manual sync is allowed (mirrors `POST /ingestion/run` → `429 sync_cooldown`), or null when it is
 * allowed now. Only finished manual runs count; scheduled runs never start a cooldown.
 */
export function nextManualSyncAt(
  items: readonly Pick<IngestionRunDto, 'trigger' | 'finishedAt'>[], now: Date, cooldownMs = MANUAL_SYNC_COOLDOWN_MS,
): Date | null {
  let last = 0;
  for (const r of items) if (r.trigger === 'manual' && r.finishedAt) last = Math.max(last, Date.parse(r.finishedAt));
  const at = last + cooldownMs;
  return last && at > now.getTime() ? new Date(at) : null;
}

/** `details.retryAt` of a 429 `sync_cooldown` error, else null. */
export function cooldownRetryAt(error: unknown): string | null {
  const e = error as { status?: number; code?: string; details?: { retryAt?: unknown } } | null;
  return e?.status === 429 && e.code === 'sync_cooldown' && typeof e.details?.retryAt === 'string' ? e.details.retryAt : null;
}

/**
 * Sync now is disabled until the latest of: the server's `nextManualSyncAt` (authoritative: honours
 * MANUAL_SYNC_COOLDOWN_MIN and runs older than the 20 listed), the run list, and a 429's `retryAt`.
 */
export function syncCooldownUntil(
  data: { items: readonly Pick<IngestionRunDto, 'trigger' | 'finishedAt'>[] } & Partial<Pick<IngestionRunsResponse, 'nextManualSyncAt' | 'manualSyncCooldownMin'>>,
  now: Date,
  retryAt?: string | null,
): Date | null {
  const cooldownMs = (data.manualSyncCooldownMin ?? MANUAL_SYNC_COOLDOWN_MIN) * 60_000;
  const candidates = [data.nextManualSyncAt, retryAt].filter((x): x is string => !!x).map((x) => Date.parse(x));
  const local = nextManualSyncAt(data.items, now, cooldownMs);
  if (local) candidates.push(local.getTime());
  const until = Math.max(0, ...candidates.filter(Number.isFinite));
  return until > now.getTime() ? new Date(until) : null;
}
