/**
 * 008/US7 scenario 5 (FR-070, T107/T108): daily housekeeping on a fixed clock deletes EXACTLY the rows past each
 * RETENTION threshold (and the pruned packets' R2 objects, blob first), leaves everything else, logs one JSON summary
 * `{ job: 'housekeeping', deleted: {…} }`, runs once per IST day after 02:00 IST, and a second run deletes 0.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  bidWorkspaces, gemThrottle, invitations, jobRuns, notifications, packets, rateLimits, sessions, tenderEvents, tenders,
} from '@tp/db';
import type { Logger } from '../src/deps';
import { runScheduledJobs } from '../src/lib/scheduled';
import {
  HOUSEKEEPING_BATCH, HOUSEKEEPING_HOUR_IST, HOUSEKEEPING_MAX_PACKET_BLOBS, HOUSEKEEPING_STALE_CLAIM_MS, RETENTION, istDay, pruneOnce, runHousekeeping,
} from '../src/services/housekeeping';
import { createTestContext, signup, type SignedUp, type TestContext } from './helpers';

// 2026-11-06 02:30 IST — inside the daily window.
const NOW = new Date('2026-11-05T21:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs);
const HOUR = 3_600_000;

let ctx: TestContext;
let owner: SignedUp;
const logs: { msg: string; meta?: Record<string, unknown> }[] = [];
const logger: Logger = {
  info: (msg, meta) => logs.push({ msg, meta }), warn: (msg, meta) => logs.push({ msg, meta }), error: (msg, meta) => logs.push({ msg, meta }),
};
const deps = () => ({ ...ctx.deps, logger });
/** Ids of rows that must survive, per table. */
const keep: Record<string, string[]> = {};
const gone: Record<string, string[]> = {};
const blobKeys = { kept: [] as string[], pruned: [] as string[] };

async function count(table: string): Promise<number> {
  const r = await ctx.db.execute(sql.raw(`select count(*)::int as n from "${table}"`));
  return (r as unknown as { rows: { n: number }[] }).rows[0]!.n;
}

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW });
  owner = await signup(ctx.app, { orgName: 'Housekeeping Co' });
  const org = owner.me.org.id;
  const user = owner.me.user.id;
  // signup itself leaves rows (an active session, current rate-limit windows): they must all survive.
  await ctx.db.delete(rateLimits);

  // sessions: expired 7 d + 1 h ago → delete; expired 7 d − 1 h ago → keep.
  const s = await ctx.db.insert(sessions).values([
    { userId: user, tokenHash: 'hk-old', expiresAt: ago(RETENTION.sessionsAfterExpiryDays, HOUR) },
    { userId: user, tokenHash: 'hk-recent', expiresAt: ago(RETENTION.sessionsAfterExpiryDays, -HOUR) },
  ]).returning({ id: sessions.id });
  gone.sessions = [s[0]!.id]; keep.sessions = [s[1]!.id];

  // invitations: accepted 31 d ago, expired unaccepted 31 d ago → delete; accepted 29 d ago, pending → keep.
  const inv = (email: string, acceptedAt: Date | null, expiresAt: Date) => ({ orgId: org, email, role: 'viewer' as const, tokenHash: `hk-${email}`, invitedBy: user, acceptedAt, expiresAt });
  const i = await ctx.db.insert(invitations).values([
    inv('a@hk.in', ago(31), ago(20)), inv('b@hk.in', null, ago(31)),
    inv('c@hk.in', ago(29), ago(20)), inv('d@hk.in', null, new Date(NOW.getTime() + 5 * DAY)),
  ]).returning({ id: invitations.id });
  gone.invitations = [i[0]!.id, i[1]!.id]; keep.invitations = [i[2]!.id, i[3]!.id];

  // notifications: read/sent/skipped 181 d, failed 31 d → delete; sent 179 d, failed 29 d, pending 400 d, read 1 d → keep.
  const note = (status: 'read' | 'sent' | 'skipped' | 'failed' | 'pending', createdAt: Date, k: string) => ({
    orgId: org, userId: user, channel: 'in_app' as const, kind: 'system' as const, title: k, body: k, dedupeKey: `hk-${k}`, status, createdAt,
  });
  const n = await ctx.db.insert(notifications).values([
    note('read', ago(181), 'r181'), note('sent', ago(181), 's181'), note('skipped', ago(181), 'k181'), note('failed', ago(31), 'f31'),
    note('sent', ago(179), 's179'), note('failed', ago(29), 'f29'), note('pending', ago(400), 'p400'), note('read', ago(1), 'r1'),
  ]).returning({ id: notifications.id });
  gone.notifications = n.slice(0, 4).map((x) => x.id); keep.notifications = n.slice(4).map((x) => x.id);

  // tenders: closed 91 d ago (raw nulled), closed 89 d ago (raw kept), open (kept), demo closed 91 d ago (kept).
  const t = (bid: string, status: 'open' | 'closed', endAt: Date, source = 'gem') => ({
    bidNumber: bid, title: bid, status, endAt, source, sourceUrl: `https://bidplus.gem.gov.in/${bid}`, contentHash: bid, raw: { b_id: bid },
  });
  const tr = await ctx.db.insert(tenders).values([
    t('GEM/2026/B/1', 'closed', ago(RETENTION.tenderRawAfterCloseDays + 1)), t('GEM/2026/B/2', 'closed', ago(RETENTION.tenderRawAfterCloseDays - 1)),
    t('GEM/2026/B/3', 'open', new Date(NOW.getTime() + 5 * DAY)), t('GEM/2026/B/4', 'closed', ago(400), 'demo'),
  ]).returning({ id: tenders.id });
  gone.tenderRaw = [tr[0]!.id]; keep.tenderRaw = [tr[1]!.id, tr[2]!.id, tr[3]!.id];

  // tender_events: closed tender 366 d → delete; closed tender 364 d, open tender 400 d → keep.
  const ev = await ctx.db.insert(tenderEvents).values([
    { tenderId: tr[0]!.id, kind: 'created', createdAt: ago(366) },
    { tenderId: tr[0]!.id, kind: 'updated', createdAt: ago(364) },
    { tenderId: tr[2]!.id, kind: 'created', createdAt: ago(400) },
  ]).returning({ id: tenderEvents.id });
  gone.tenderEvents = [ev[0]!.id]; keep.tenderEvents = [ev[1]!.id, ev[2]!.id];

  // rate_limits: window 1 d + 1 h old → delete; 1 h old → keep.
  await ctx.db.insert(rateLimits).values([
    { key: 'api.ip:1.2.3.4', windowStart: ago(RETENTION.rateLimitsDays, HOUR), count: 3 },
    { key: 'api.ip:1.2.3.4', windowStart: ago(0, HOUR), count: 3 },
  ]);

  // packets: workspace W1 has 8 (7 ready + the OLDEST still building) → the 2 oldest ready ones beyond the newest 5
  // go (blob first); the building one stays. Workspace W2 has 3 → all stay.
  const [w1, w2] = await ctx.db.insert(bidWorkspaces).values([
    { orgId: org, tenderId: tr[2]!.id }, { orgId: org, tenderId: tr[1]!.id },
  ]).returning({ id: bidWorkspaces.id });
  const pk = async (ws: string, i: number, status: 'ready' | 'building' = 'ready') => {
    const key = `org/${org}/packets/hk-${ws.slice(0, 8)}-${i}/packet.pdf`;
    await ctx.deps.blobs.put(key, new TextEncoder().encode(`%PDF packet ${i}`), { contentType: 'application/pdf' });
    const [row] = await ctx.db.insert(packets).values({ orgId: org, workspaceId: ws, status, blobKey: key, createdAt: ago(0, (100 - i) * HOUR) }).returning({ id: packets.id });
    return { id: row!.id, key };
  };
  const p1 = [await pk(w1!.id, 0, 'building')];
  for (let i = 1; i <= 7; i++) p1.push(await pk(w1!.id, i));
  const p2 = [await pk(w2!.id, 1), await pk(w2!.id, 2), await pk(w2!.id, 3)];
  // newest 5 of W1 = i 3..7; beyond: i 0 (building → kept), 1, 2 (pruned).
  gone.packets = [p1[1]!.id, p1[2]!.id]; keep.packets = [p1[0]!.id, ...p1.slice(3).map((p) => p.id), ...p2.map((p) => p.id)];
  blobKeys.pruned = [p1[1]!.key, p1[2]!.key]; blobKeys.kept = [p1[0]!.key, ...p1.slice(3).map((p) => p.key), ...p2.map((p) => p.key)];
});
afterAll(() => ctx?.close());

describe('RETENTION table (FR-070)', () => {
  it('is pinned: these values are what production deletes', () => {
    expect(RETENTION).toEqual({
      sessionsAfterExpiryDays: 7, invitationsAfterDays: 30, notificationsDoneDays: 180, notificationsFailedDays: 30,
      tenderEventsDays: 365, tenderRawAfterCloseDays: 90, rateLimitsDays: 1, packetsKeepPerWorkspace: 5,
    });
    expect(HOUSEKEEPING_BATCH).toBe(1000);
    expect(HOUSEKEEPING_HOUR_IST).toBe(2);
  });
});

describe('housekeeping on a fixed clock (US7 scenario 5)', () => {
  it('before 02:00 IST the step does nothing', async () => {
    const early = { ...deps(), clock: { now: () => new Date('2026-11-05T20:00:00.000Z') } }; // 01:30 IST
    expect(await runHousekeeping(early)).toEqual({ ran: false, day: '2026-11-06', reason: 'before_window' });
    expect(await ctx.db.select().from(jobRuns)).toEqual([]);
  });

  it('the scheduled step deletes exactly the expired rows and R2 objects and logs the JSON summary', async () => {
    const throttleBefore = await ctx.db.select().from(gemThrottle);
    logs.length = 0;
    const report = await runScheduledJobs(deps(), { trigger: 'cron' });
    expect(report.find((r) => r.step === 'housekeeping')).toMatchObject({ ok: true });
    const line = logs.find((l) => l.msg === 'housekeeping finished');
    console.log(JSON.stringify({ level: 'info', msg: line?.msg, ...line?.meta, ms: undefined })); // the JSON log line (ms omitted)
    expect(line?.meta).toMatchObject({
      job: 'housekeeping', day: '2026-11-06',
      // rateLimits: 0 — the earlier `rate-limit-cleanup` step (2 × the longest window) already removed the stale window.
      deleted: { sessions: 1, invitations: 2, notifications: 4, tenderEvents: 1, tenderRaw: 1, rateLimits: 0, packets: 2, packetBlobs: 2 },
    });
    // The JSON logger prints exactly this object (one line).
    expect(JSON.parse(JSON.stringify(line!.meta))).toMatchObject({ job: 'housekeeping', deleted: { packets: 2 } });

    const ids = async (table: typeof sessions | typeof invitations | typeof notifications | typeof tenderEvents | typeof packets, list: string[]) =>
      (await ctx.db.select({ id: table.id }).from(table).where(inArray(table.id, list))).map((r) => r.id).sort();
    for (const [name, table] of [['sessions', sessions], ['invitations', invitations], ['notifications', notifications], ['tenderEvents', tenderEvents], ['packets', packets]] as const) {
      expect(await ids(table, gone[name]!), `${name} pruned`).toEqual([]);
      expect(await ids(table, keep[name]!), `${name} kept`).toEqual([...keep[name]!].sort());
    }
    const raws = await ctx.db.select({ id: tenders.id, raw: tenders.raw }).from(tenders);
    expect(raws.filter((r) => r.raw === null).map((r) => r.id)).toEqual(gone.tenderRaw);
    expect(raws.filter((r) => r.raw !== null).map((r) => r.id).sort()).toEqual([...keep.tenderRaw!].sort());
    expect(await count('tenders')).toBe(4); // rows are kept, only `raw` is nulled
    expect((await ctx.db.select().from(rateLimits)).map((r) => r.windowStart)).toEqual([ago(0, HOUR)]);
    for (const k of blobKeys.pruned) expect(await ctx.deps.blobs.head(k), k).toBeNull();
    for (const k of blobKeys.kept) expect(await ctx.deps.blobs.head(k), k).not.toBeNull();
    expect(await ctx.db.select().from(gemThrottle)).toEqual(throttleBefore); // untouched
    // The signup session (active) is still there.
    expect(await count('sessions')).toBe(2);
    const [run] = await ctx.db.select().from(jobRuns);
    expect(run).toMatchObject({ job: 'housekeeping', day: '2026-11-06' });
    expect(run!.finishedAt).toBeInstanceOf(Date);
  });

  it('runs once per IST day: a later tick the same day skips; a forced second run deletes 0 (idempotent)', async () => {
    expect(await runHousekeeping(deps())).toEqual({ ran: false, day: '2026-11-06', reason: 'already_ran' });
    const again = await runHousekeeping(deps(), { force: true });
    expect(again).toMatchObject({ ran: true, deleted: { sessions: 0, invitations: 0, notifications: 0, tenderEvents: 0, tenderRaw: 0, rateLimits: 0, packets: 0, packetBlobs: 0 } });
    // The next IST day after 02:00 runs again (and finds nothing).
    const tomorrow = { ...deps(), clock: { now: () => new Date(NOW.getTime() + DAY) } };
    expect(await runHousekeeping(tomorrow)).toMatchObject({ ran: true, day: '2026-11-07' });
    expect(istDay(NOW)).toBe('2026-11-06');
  });

  it('the rate_limits rule on its own: windows older than 1 day go, newer ones stay', async () => {
    await ctx.db.delete(rateLimits);
    await ctx.db.insert(rateLimits).values([
      { key: 'api.user:x', windowStart: ago(RETENTION.rateLimitsDays, HOUR), count: 1 },
      { key: 'api.user:x', windowStart: ago(RETENTION.rateLimitsDays, -HOUR), count: 1 },
    ]);
    expect((await pruneOnce(deps(), NOW)).rateLimits).toBe(1);
    expect((await ctx.db.select().from(rateLimits)).map((r) => r.windowStart)).toEqual([ago(RETENTION.rateLimitsDays, -HOUR)]);
  });

  it('a failed R2 delete keeps the packet row (no orphaned object) and a failed run releases its day claim', async () => {
    const org = owner.me.org.id;
    const [w] = await ctx.db.select({ id: bidWorkspaces.id }).from(bidWorkspaces).limit(1);
    const extra: string[] = [];
    for (let i = 0; i < 6; i++) {
      const [row] = await ctx.db.insert(packets).values({ orgId: org, workspaceId: w!.id, status: 'ready', blobKey: `org/${org}/packets/fail-${i}.pdf`, createdAt: new Date(NOW.getTime() + i * HOUR) }).returning({ id: packets.id });
      extra.push(row!.id);
    }
    const failing = { ...deps(), blobs: { ...ctx.deps.blobs, delete: async () => { throw new Error('R2 unavailable'); } } };
    const before = await count('packets');
    const r = await pruneOnce(failing, NOW);
    expect(r.packets).toBe(0);
    expect(await count('packets')).toBe(before);
    expect(logs.some((l) => l.msg.startsWith('housekeeping: packet blob delete failed'))).toBe(true);

    // A run that throws deletes its claim, so the next tick of the same day retries.
    const day3 = new Date(NOW.getTime() + 2 * DAY);
    const broken = { ...deps(), clock: { now: () => day3 }, blobs: { ...ctx.deps.blobs, delete: async () => { throw new Error('x'); } } };
    const throwing = { ...broken, db: new Proxy(ctx.db, { get: (target, prop) => (prop === 'execute' ? () => { throw new Error('db gone'); } : Reflect.get(target, prop)) }) as typeof ctx.db };
    await expect(runHousekeeping(throwing)).rejects.toThrow('db gone');
    expect((await ctx.db.select().from(jobRuns).where(eq(jobRuns.day, istDay(day3))))).toEqual([]);
    await ctx.db.delete(packets).where(inArray(packets.id, extra));
  });
  it('review S4: raw is never nulled on a demo row whose source was lost (raw.demo marker / demo- content hash)', async () => {
    const closed = ago(RETENTION.tenderRawAfterCloseDays + 10);
    const rows = await ctx.db.insert(tenders).values([
      { bidNumber: 'GEM/2026/B/S4-1', title: 'marker', status: 'closed', endAt: closed, source: 'gem', sourceUrl: 'https://x/s41', contentHash: 's4-1', raw: { demo: true, b_id: 1 } },
      { bidNumber: 'GEM/2026/B/S4-2', title: 'hash', status: 'closed', endAt: closed, source: 'gem', sourceUrl: 'https://x/s42', contentHash: 'demo-GEM/2026/B/S4-2', raw: { b_id: 2 } },
      { bidNumber: 'GEM/2026/B/S4-3', title: 'real', status: 'closed', endAt: closed, source: 'gem', sourceUrl: 'https://x/s43', contentHash: 's4-3', raw: { b_id: 3 } },
    ]).returning({ id: tenders.id, bidNumber: tenders.bidNumber });
    try {
      await pruneOnce(deps(), NOW);
      const after = await ctx.db.select({ bid: tenders.bidNumber, raw: tenders.raw }).from(tenders).where(inArray(tenders.id, rows.map((r) => r.id)));
      const byBid = Object.fromEntries(after.map((r) => [r.bid, r.raw]));
      expect(byBid['GEM/2026/B/S4-1']).toEqual({ demo: true, b_id: 1 });
      expect(byBid['GEM/2026/B/S4-2']).toEqual({ b_id: 2 });
      expect(byBid['GEM/2026/B/S4-3']).toBeNull();
    } finally {
      await ctx.db.delete(tenders).where(inArray(tenders.id, rows.map((r) => r.id)));
    }
  });

  it('review S5: an unfinished claim older than an hour (run died) is taken over the same day; a fresh one is not', async () => {
    const day5 = new Date(NOW.getTime() + 4 * DAY);
    const d = istDay(day5);
    await ctx.db.insert(jobRuns).values({ job: 'housekeeping', day: d, startedAt: new Date(day5.getTime() - HOUSEKEEPING_STALE_CLAIM_MS / 2) });
    const at = (t: Date) => ({ ...deps(), clock: { now: () => t } });
    expect(await runHousekeeping(at(day5))).toEqual({ ran: false, day: d, reason: 'already_ran' }); // 30 min old: maybe still running
    const later = new Date(day5.getTime() + HOUSEKEEPING_STALE_CLAIM_MS);
    expect(await runHousekeeping(at(later))).toMatchObject({ ran: true, day: d });
    const [run] = await ctx.db.select().from(jobRuns).where(eq(jobRuns.day, d));
    expect(run!.startedAt).toEqual(later);
    expect(run!.finishedAt).toBeInstanceOf(Date);
    // A finished run is never taken over, however old.
    expect(await runHousekeeping(at(new Date(later.getTime() + 3 * HOUR)))).toMatchObject({ ran: false, reason: 'already_ran' });
  });

  it('review S6: packet blobs go in deleteMany calls of ≤ 1,000 keys, at most HOUSEKEEPING_MAX_PACKET_BLOBS per run', async () => {
    expect(HOUSEKEEPING_MAX_PACKET_BLOBS).toBe(1_000);
    const org = owner.me.org.id;
    const [w] = await ctx.db.select({ id: bidWorkspaces.id }).from(bidWorkspaces).limit(1);
    const total = HOUSEKEEPING_MAX_PACKET_BLOBS + 300;
    const rows = Array.from({ length: total + RETENTION.packetsKeepPerWorkspace }, (_, i) => ({
      orgId: org, workspaceId: w!.id, status: 'ready' as const, blobKey: `org/${org}/packets/s6-${i}.pdf`, createdAt: new Date(NOW.getTime() - (i + 10) * HOUR),
    }));
    const inserted = await ctx.db.insert(packets).values(rows).returning({ id: packets.id });
    const calls: string[][] = [];
    const single: string[] = [];
    const blobs = { ...ctx.deps.blobs, delete: async (k: string) => { single.push(k); }, deleteMany: async (keys: string[]) => { calls.push(keys); } };
    try {
      const first = await pruneOnce({ ...deps(), blobs }, NOW);
      expect(single).toEqual([]);
      expect(calls.every((c) => c.length <= 1_000)).toBe(true);
      expect(calls.flat()).toHaveLength(HOUSEKEEPING_MAX_PACKET_BLOBS);
      expect(first).toMatchObject({ packetBlobs: HOUSEKEEPING_MAX_PACKET_BLOBS, packets: HOUSEKEEPING_MAX_PACKET_BLOBS });
      const second = await pruneOnce({ ...deps(), blobs }, NOW); // the rest the next run
      expect(second.packetBlobs).toBeGreaterThanOrEqual(300);
      expect(second.packets).toBe(second.packetBlobs);
      const left = await ctx.db.select({ id: packets.id }).from(packets).where(inArray(packets.id, inserted.map((r) => r.id)));
      expect(left.length).toBeLessThanOrEqual(RETENTION.packetsKeepPerWorkspace);
    } finally {
      await ctx.db.delete(packets).where(inArray(packets.id, inserted.map((r) => r.id)));
    }
  });
});
