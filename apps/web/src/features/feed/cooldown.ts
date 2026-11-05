import type { IngestionRunDto } from '@tp/core/contracts/identify';

/** FR-013: the API refuses manual syncs for 2 min after a finished manual run (any org). */
export const MANUAL_SYNC_COOLDOWN_MS = 2 * 60_000;

/**
 * When the next manual sync is allowed (mirrors `POST /ingestion/run` → `429 sync_cooldown`), or null when it is
 * allowed now. Only finished manual runs count; scheduled runs never start a cooldown.
 */
export function nextManualSyncAt(items: readonly Pick<IngestionRunDto, 'trigger' | 'finishedAt'>[], now: Date): Date | null {
  let last = 0;
  for (const r of items) if (r.trigger === 'manual' && r.finishedAt) last = Math.max(last, Date.parse(r.finishedAt));
  const at = last + MANUAL_SYNC_COOLDOWN_MS;
  return last && at > now.getTime() ? new Date(at) : null;
}
