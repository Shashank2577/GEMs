import { describe, expect, it } from 'vitest';
import { MANUAL_SYNC_COOLDOWN_MS, nextManualSyncAt } from './cooldown';

const NOW = new Date('2026-11-05T04:30:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const run = (trigger: 'manual' | 'cron' | 'seed', finishedAt: string | null) => ({ trigger, finishedAt });

describe('nextManualSyncAt (FR-013)', () => {
  it('is null with no runs or no manual runs', () => {
    expect(nextManualSyncAt([], NOW)).toBeNull();
    expect(nextManualSyncAt([run('cron', ago(10_000)), run('seed', ago(5_000))], NOW)).toBeNull();
  });

  it('ignores manual runs that have not finished', () => {
    expect(nextManualSyncAt([run('manual', null)], NOW)).toBeNull();
  });

  it('returns finishedAt + 2 min inside the window, using the latest finished manual run', () => {
    const items = [run('cron', ago(1_000)), run('manual', ago(30_000)), run('manual', ago(100_000))];
    expect(nextManualSyncAt(items, NOW)).toEqual(new Date(NOW.getTime() - 30_000 + MANUAL_SYNC_COOLDOWN_MS));
  });

  it('is allowed exactly at the boundary and after it', () => {
    expect(nextManualSyncAt([run('manual', ago(MANUAL_SYNC_COOLDOWN_MS - 1))], NOW)).toEqual(new Date(NOW.getTime() + 1));
    expect(nextManualSyncAt([run('manual', ago(MANUAL_SYNC_COOLDOWN_MS))], NOW)).toBeNull();
    expect(nextManualSyncAt([run('manual', ago(MANUAL_SYNC_COOLDOWN_MS + 1))], NOW)).toBeNull();
  });
});
