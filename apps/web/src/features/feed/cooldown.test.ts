import { describe, expect, it } from 'vitest';
import { MANUAL_SYNC_COOLDOWN_MS, cooldownRetryAt, nextManualSyncAt, syncCooldownUntil } from './cooldown';

const NOW = new Date('2026-11-05T04:30:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const run = (trigger: 'manual' | 'cron' | 'seed', finishedAt: string | null) => ({ trigger, finishedAt });

describe('nextManualSyncAt (008/FR-026; was 003 FR-013)', () => {
  it('defaults to 10 minutes', () => expect(MANUAL_SYNC_COOLDOWN_MS).toBe(10 * 60_000));

  it('is null with no runs or no manual runs', () => {
    expect(nextManualSyncAt([], NOW)).toBeNull();
    expect(nextManualSyncAt([run('cron', ago(10_000)), run('seed', ago(5_000))], NOW)).toBeNull();
  });

  it('ignores manual runs that have not finished', () => {
    expect(nextManualSyncAt([run('manual', null)], NOW)).toBeNull();
  });

  it('returns finishedAt + 10 min inside the window, using the latest finished manual run', () => {
    const items = [run('cron', ago(1_000)), run('manual', ago(30_000)), run('manual', ago(100_000))];
    expect(nextManualSyncAt(items, NOW)).toEqual(new Date(NOW.getTime() - 30_000 + MANUAL_SYNC_COOLDOWN_MS));
  });

  it('is allowed exactly at the boundary and after it', () => {
    expect(nextManualSyncAt([run('manual', ago(MANUAL_SYNC_COOLDOWN_MS - 1))], NOW)).toEqual(new Date(NOW.getTime() + 1));
    expect(nextManualSyncAt([run('manual', ago(MANUAL_SYNC_COOLDOWN_MS))], NOW)).toBeNull();
    expect(nextManualSyncAt([run('manual', ago(MANUAL_SYNC_COOLDOWN_MS + 1))], NOW)).toBeNull();
  });
});

describe('syncCooldownUntil (008/FR-026)', () => {
  const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  it('prefers the server value, which covers runs beyond the list and a configured cooldown', () => {
    expect(syncCooldownUntil({ items: [], nextManualSyncAt: later(5 * 60_000), manualSyncCooldownMin: 10 }, NOW)).toEqual(new Date(later(5 * 60_000)));
    expect(syncCooldownUntil({ items: [run('manual', ago(60_000))], nextManualSyncAt: null, manualSyncCooldownMin: 3 }, NOW))
      .toEqual(new Date(NOW.getTime() - 60_000 + 3 * 60_000));
  });
  it('uses a 429 retryAt immediately, and the latest of all sources', () => {
    expect(syncCooldownUntil({ items: [] }, NOW, later(9 * 60_000))).toEqual(new Date(later(9 * 60_000)));
    expect(syncCooldownUntil({ items: [], nextManualSyncAt: later(1_000) }, NOW, later(2_000))).toEqual(new Date(later(2_000)));
  });
  it('is null once every source is in the past', () => {
    expect(syncCooldownUntil({ items: [run('manual', ago(11 * 60_000))], nextManualSyncAt: ago(1) }, NOW, ago(5))).toBeNull();
  });
});

describe('cooldownRetryAt', () => {
  it('reads details.retryAt of a 429 sync_cooldown only', () => {
    expect(cooldownRetryAt({ status: 429, code: 'sync_cooldown', details: { retryAt: '2026-11-05T04:40:00.000Z' } })).toBe('2026-11-05T04:40:00.000Z');
    expect(cooldownRetryAt({ status: 429, code: 'rate_limited', details: { retryAfter: 3 } })).toBeNull();
    expect(cooldownRetryAt(new Error('x'))).toBeNull();
    expect(cooldownRetryAt(null)).toBeNull();
  });
});
