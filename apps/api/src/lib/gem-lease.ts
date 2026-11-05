/**
 * Cluster-wide GeM lease (008/FR-024, NFR-002, Constitution II): every request to GeM — listing pages from cron or
 * Sync now, document fetches from any org, on any isolate or Node process — takes the next free slot from the single
 * `gem_throttle` row, so GeM never sees more than one request per `minIntervalMs` from TenderPilot as a whole.
 *
 *   await acquireGemSlot(db, 1000, 25_000);           // sleeps until our slot, or throws 503 gem_busy
 *   new GemClient(fetch, { beforeRequest: () => deps.gemLease.acquire(25_000) });
 *
 * One atomic upsert per request (row-locked, DB clock): my slot = greatest(now, next_slot_at); next_slot_at = my slot
 * + interval. If my slot is more than `maxWaitMs` away nothing is reserved and the caller gets 503 `gem_busy`.
 * The upsert also recreates the row if it is missing (the seed row lives in migration 0011; tests truncate it).
 */
import { sql } from 'drizzle-orm';
import type { Db } from '@tp/db';
import type { GemLease } from '../deps';
import { serviceUnavailable } from './errors';

export const GEM_THROTTLE_ID = 'gem';
export const GEM_BUSY_MESSAGE = 'GeM is busy — we’ll retry shortly.';

export interface GemSlot {
  /** When this caller may send its request (DB clock). */
  slotAt: Date;
  /** How long the caller waited in total (including re-acquiring after waking up late). */
  waitedMs: number;
}

export interface GemLeaseOptions {
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * A caller that wakes up more than this long after its slot (busy event loop, CPU-starved isolate) gives the slot
   * up and reserves a new one, so a late sender can never end up closer than `interval − tolerance` to the next
   * caller (spec tolerance: 20 ms). Default 20.
   */
  lateToleranceMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reserve the next slot without waiting. Returns null — and reserves nothing — when the slot would be more than
 * `maxWaitMs` away.
 */
export async function reserveGemSlot(db: Db, minIntervalMs: number, maxWaitMs: number): Promise<{ slotAt: Date; waitMs: number } | null> {
  const step = sql`(${Math.max(0, minIntervalMs)}::double precision * interval '1 millisecond')`;
  const maxWait = sql`(${Math.max(0, maxWaitMs)}::double precision * interval '1 millisecond')`;
  const res = await db.execute(sql`
    insert into gem_throttle as g (id, next_slot_at) values (${GEM_THROTTLE_ID}, clock_timestamp() + ${step})
    on conflict (id) do update set next_slot_at = greatest(clock_timestamp(), g.next_slot_at) + ${step}
      where greatest(clock_timestamp(), g.next_slot_at) <= clock_timestamp() + ${maxWait}
    returning next_slot_at - ${step} as slot_at,
      greatest(0, extract(epoch from (next_slot_at - ${step} - clock_timestamp())) * 1000)::double precision as wait_ms`);
  const row = (res as unknown as { rows: { slot_at: Date | string; wait_ms: number | string }[] }).rows[0];
  if (!row) return null;
  return { slotAt: new Date(row.slot_at), waitMs: Math.max(0, Math.ceil(Number(row.wait_ms))) };
}

/** Wait for this caller's GeM slot. Throws 503 `gem_busy` when it is more than `maxWaitMs` away. */
export async function acquireGemSlot(db: Db, minIntervalMs: number, maxWaitMs: number, opts: GemLeaseOptions = {}): Promise<GemSlot> {
  const sleep = opts.sleep ?? defaultSleep;
  const tolerance = opts.lateToleranceMs ?? 20;
  // Injected sleeps (tests) skip the late check unless a tolerance is given explicitly.
  const checkLate = opts.sleep === undefined || opts.lateToleranceMs !== undefined;
  const started = Date.now();
  for (;;) {
    // Measure lateness from when the reservation was SENT: a reply delayed by pool contention or a busy event loop
    // must count as lateness (target ≤ the real slot time, so this errs on the safe side).
    const sentAt = Date.now();
    const slot = await reserveGemSlot(db, minIntervalMs, Math.max(0, maxWaitMs - (sentAt - started)));
    if (!slot) throw serviceUnavailable('gem_busy', GEM_BUSY_MESSAGE, { maxWaitMs });
    const target = sentAt + slot.waitMs;
    const remaining = target - Date.now();
    if (remaining > 0) await sleep(remaining);
    // Woke up too late: the next caller may already be sending. Our slot is spent; take a fresh one.
    if (checkLate && Date.now() - target > tolerance) continue;
    return { slotAt: slot.slotAt, waitedMs: Date.now() - started };
  }
}

/** Postgres-backed `GemLease` for AppDeps. */
export function createPgGemLease(db: Db, minIntervalMs: number, opts: GemLeaseOptions = {}): GemLease {
  return { async acquire(maxWaitMs) { await acquireGemSlot(db, minIntervalMs, maxWaitMs, opts); } };
}
