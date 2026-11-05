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
 * Slots live on the DB clock; `ClockOffset` maps them to this process's clock with explicit error bounds.
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
 * Bounds on (DB clock − local clock), NTP-style. A query sent at local `sentAt` and answered at local `recvAt` that
 * read the DB clock as `dbMs` proves `dbMs − recvAt ≤ offset ≤ dbMs − sentAt`; intersecting the samples keeps the
 * tightest bounds. Waiting for a pool connection or the throttle row lock only widens one sample's upper side, and a
 * reply noticed late by a busy event loop only widens its lower side, so neither can move a slot earlier or later
 * than its bounds say (the bug of measuring from `sentAt` alone: a caller queued behind 19 others woke up early).
 */
export class ClockOffset {
  private lo = -Infinity;
  private hi = Infinity;
  private since = -Infinity;
  /** Bounds older than `maxAgeMs` are dropped (clock drift); an empty intersection (clock step) restarts too. */
  constructor(private readonly maxAgeMs = 5 * 60_000) {}

  add(sentAt: number, recvAt: number, dbMs: number): void {
    // ±1 ms: Date.now() has millisecond resolution, the DB clock microseconds.
    const lo = dbMs - recvAt - 1;
    const hi = dbMs - sentAt + 1;
    if (recvAt - this.since > this.maxAgeMs || lo > this.hi || hi < this.lo) {
      this.lo = lo; this.hi = hi; this.since = recvAt;
      return;
    }
    this.lo = Math.max(this.lo, lo);
    this.hi = Math.min(this.hi, hi);
  }

  /** Uncertainty of the offset in ms (Infinity before the first sample). */
  get width(): number { return this.hi - this.lo; }
  /** Earliest local time at which DB time `dbMs` can occur. */
  earliestLocal(dbMs: number): number { return dbMs - this.hi; }
  /** Latest local time at which DB time `dbMs` can occur. */
  latestLocal(dbMs: number): number { return dbMs - this.lo; }
}

const offsets = new WeakMap<object, ClockOffset>();
function clockOffsetFor(db: Db): ClockOffset {
  let o = offsets.get(db);
  if (!o) { o = new ClockOffset(); offsets.set(db, o); }
  return o;
}

/** One cheap DB clock reading, folded into `offset` (no row lock, so it narrows the bounds under contention). */
async function sampleClock(db: Db, offset: ClockOffset): Promise<void> {
  const sentAt = Date.now();
  const res = await db.execute(sql`select (extract(epoch from clock_timestamp()) * 1000)::double precision as db_ms`);
  const recvAt = Date.now();
  const row = (res as unknown as { rows: { db_ms: number | string }[] }).rows[0];
  if (row) offset.add(sentAt, recvAt, Number(row.db_ms));
}

/**
 * Reserve the next slot without waiting. Returns null — and reserves nothing — when the slot would be more than
 * `maxWaitMs` away. `slotMs` / `dbNowMs` are DB-clock epoch milliseconds (the latter read while reserving).
 */
export async function reserveGemSlot(
  db: Db, minIntervalMs: number, maxWaitMs: number,
): Promise<{ slotAt: Date; waitMs: number; slotMs: number; dbNowMs: number } | null> {
  const step = sql`(${Math.max(0, minIntervalMs)}::double precision * interval '1 millisecond')`;
  const maxWait = sql`(${Math.max(0, maxWaitMs)}::double precision * interval '1 millisecond')`;
  const res = await db.execute(sql`
    insert into gem_throttle as g (id, next_slot_at) values (${GEM_THROTTLE_ID}, clock_timestamp() + ${step})
    on conflict (id) do update set next_slot_at = greatest(clock_timestamp(), g.next_slot_at) + ${step}
      where greatest(clock_timestamp(), g.next_slot_at) <= clock_timestamp() + ${maxWait}
    returning (extract(epoch from next_slot_at - ${step}) * 1000)::double precision as slot_ms,
      (extract(epoch from clock_timestamp()) * 1000)::double precision as db_now_ms`);
  const row = (res as unknown as { rows: { slot_ms: number | string; db_now_ms: number | string }[] }).rows[0];
  if (!row) return null;
  const slotMs = Number(row.slot_ms);
  const dbNowMs = Number(row.db_now_ms);
  return { slotAt: new Date(slotMs), waitMs: Math.max(0, Math.ceil(slotMs - dbNowMs)), slotMs, dbNowMs };
}

/** Wait for this caller's GeM slot. Throws 503 `gem_busy` when it is more than `maxWaitMs` away. */
export async function acquireGemSlot(db: Db, minIntervalMs: number, maxWaitMs: number, opts: GemLeaseOptions = {}): Promise<GemSlot> {
  const sleep = opts.sleep ?? defaultSleep;
  const tolerance = opts.lateToleranceMs ?? 20;
  // Injected sleeps (tests) skip the late check unless a tolerance is given explicitly.
  const checkLate = opts.sleep === undefined || opts.lateToleranceMs !== undefined;
  const offset = clockOffsetFor(db);
  const started = Date.now();
  for (;;) {
    const sentAt = Date.now();
    const slot = await reserveGemSlot(db, minIntervalMs, Math.max(0, maxWaitMs - (sentAt - started)));
    if (!slot) throw serviceUnavailable('gem_busy', GEM_BUSY_MESSAGE, { maxWaitMs });
    offset.add(sentAt, Date.now(), slot.dbNowMs);
    // Too uncertain to place the slot within the tolerance: a few uncontended clock readings narrow it.
    for (let i = 0; checkLate && offset.width > tolerance / 2 && i < 5; i++) await sampleClock(db, offset);
    // Never early: sleep until the LATEST local time the slot can be. Late: past the EARLIEST time + tolerance, the
    // next caller (who also never sends early) may already be sending, so our slot is spent; take a fresh one. If
    // the bounds stay wider than the tolerance (pathological DB latency) only the late wake-up itself is checked.
    const target = offset.latestLocal(slot.slotMs);
    const lateAfter = (offset.width <= tolerance ? offset.earliestLocal(slot.slotMs) : target) + tolerance;
    const remaining = target - Date.now();
    if (remaining > 0) await sleep(remaining);
    if (checkLate && Date.now() > lateAfter) continue;
    return { slotAt: slot.slotAt, waitedMs: Date.now() - started };
  }
}

/** Postgres-backed `GemLease` for AppDeps. */
export function createPgGemLease(db: Db, minIntervalMs: number, opts: GemLeaseOptions = {}): GemLease {
  return { async acquire(maxWaitMs) { await acquireGemSlot(db, minIntervalMs, maxWaitMs, opts); } };
}
