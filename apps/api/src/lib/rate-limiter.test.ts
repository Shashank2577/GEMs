/** 008/FR-017: window maths and the in-memory limiter (unit; the Postgres limiter is tested in test/ops-limits.test.ts). */
import { describe, expect, it } from 'vitest';
import { createMemoryRateLimiter, noopRateLimiter, windowStartOf } from './rate-limiter';

const T = (iso: string) => new Date(iso);

describe('windowStartOf', () => {
  it('aligns windows to multiples of the window length since the epoch', () => {
    expect(windowStartOf(T('2026-11-04T04:30:10.500Z'), 60).toISOString()).toBe('2026-11-04T04:30:00.000Z');
    expect(windowStartOf(T('2026-11-04T04:59:59.999Z'), 3600).toISOString()).toBe('2026-11-04T04:00:00.000Z');
    expect(windowStartOf(T('2026-11-04T04:30:10Z'), 900).toISOString()).toBe('2026-11-04T04:30:00.000Z');
  });
});

describe('memory rate limiter', () => {
  it('allows `limit` hits per window, then reports retryAfter until the window ends', async () => {
    const rl = createMemoryRateLimiter();
    const now = T('2026-11-04T04:30:10Z');
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rl.hit('k', 3, 60, now));
    expect(results.map((r) => [r.count, r.allowed, r.remaining])).toEqual([[1, true, 2], [2, true, 1], [3, true, 0], [4, false, 0]]);
    expect(results[3]!.retryAfterSec).toBe(50);
    // Same window, later: still blocked, shorter wait.
    expect(await rl.hit('k', 3, 60, T('2026-11-04T04:30:59.2Z'))).toMatchObject({ allowed: false, retryAfterSec: 1 });
    // Next window: allowed again.
    expect(await rl.hit('k', 3, 60, T('2026-11-04T04:31:00Z'))).toMatchObject({ count: 1, allowed: true });
  });

  it('keys are independent and reset() forgets every window of a key', async () => {
    const rl = createMemoryRateLimiter();
    const now = T('2026-11-04T04:30:10Z');
    await rl.hit('a', 1, 60, now);
    expect((await rl.hit('a', 1, 60, now)).allowed).toBe(false);
    expect((await rl.hit('b', 1, 60, now)).allowed).toBe(true);
    await rl.reset('a');
    expect((await rl.hit('a', 1, 60, now)).allowed).toBe(true);
    expect(rl.size).toBe(2);
  });

  it('the no-op limiter always allows', async () => {
    expect(await noopRateLimiter.hit('k', 0, 60, new Date())).toMatchObject({ allowed: true });
  });
});
