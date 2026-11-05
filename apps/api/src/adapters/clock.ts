import type { Clock } from '../deps';

export const systemClock: Clock = { now: () => new Date() };

/** Controllable clock for tests. */
export function createFixedClock(start: Date | string = new Date()): Clock & { set(d: Date | string): void; advance(ms: number): void } {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    set: (d) => { t = new Date(d).getTime(); },
    advance: (ms) => { t += ms; },
  };
}
