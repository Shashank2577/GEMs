/**
 * Bulk fixtures for capacity work (spec 008 FR-033, NFR-001; US4 scenarios 4–5).
 *
 *   await insertBulkTenders(db, { count: 50_000 });                 // API perf tests (CI-sized)
 *   DATABASE_URL=… pnpm --filter @tp/db exec tsx src/fixtures/bulk-tenders.ts --count 500000   // load runs
 *   … --notifications 1000000 --pending 500                          // + dispatcher fixture
 *
 * Rows are generated inside Postgres with `generate_series` (500k rows in seconds, no client memory) and are
 * deterministic for a given count: ~6 % open (end in 1–30 days), the rest closed/cancelled/awarded in the past;
 * states, ministries and categories are skewed like real GeM data (a few large states, a long tail), values span
 * ₹10k–₹50 Cr with ~15 % unknown, and each row carries a ~1 KB `raw` payload so "no raw in lists" matters.
 * Every row uses `source = 'bulk'` (never `gem`), so `deleteBulkTenders` removes exactly what was added.
 */
import { sql } from 'drizzle-orm';
import { INDIAN_STATES } from '@tp/core/gem/states';
import type { Db } from '../client';

export const BULK_SOURCE = 'bulk';

/** Weighted towards the states that publish most GeM bids. */
const STATE_WEIGHTS: [string, number][] = [
  ['Maharashtra', 12], ['Uttar Pradesh', 11], ['Delhi', 9], ['Karnataka', 7], ['Tamil Nadu', 7], ['Gujarat', 6], ['Rajasthan', 6],
  ['West Bengal', 5], ['Madhya Pradesh', 5], ['Telangana', 4], ['Bihar', 4], ['Odisha', 3], ['Kerala', 3], ['Haryana', 3], ['Punjab', 3],
  ['Assam', 2], ['Jharkhand', 2], ['Chhattisgarh', 2], ['Uttarakhand', 2], ['Andhra Pradesh', 2], ['Jammu and Kashmir', 1],
  ['Himachal Pradesh', 1], ['Goa', 1],
];

const MINISTRIES = [
  'Ministry of Defence', 'Ministry of Railways', 'Ministry of Home Affairs', 'Ministry of Health and Family Welfare',
  'Ministry of Education', 'Ministry of Power', 'Ministry of Petroleum and Natural Gas', 'Ministry of Finance',
  'Ministry of Road Transport and Highways', 'Ministry of Agriculture and Farmers Welfare', 'Ministry of Coal',
  'Ministry of Electronics and Information Technology', 'Ministry of Steel', 'Ministry of Communications',
  'Department of Space', 'Ministry of Jal Shakti', 'Ministry of Rural Development', 'Ministry of Housing and Urban Affairs',
];

const CATEGORIES = [
  'Desktop Computers', 'Laptop - Notebook', 'Multifunction Machines', 'CCTV Cameras', 'Manpower Outsourcing Services',
  'Security Manpower Service', 'Office Chairs', 'UPS', 'Split Air Conditioner', 'LED Lights', 'Printer Cartridges',
  'Cleaning and Sanitation Services', 'Vehicle Hiring Services', 'Medical Consumables', 'Steel Almirah', 'Network Switches',
  'Diesel Generator', 'Water Purifier', 'Fire Extinguishers', 'Custom Bid for Services',
];

const pgArray = (xs: readonly string[]) => sql.raw(`ARRAY[${xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(',')}]::text[]`);

export interface BulkTenderOptions {
  count: number;
  /** Share of open tenders (default 0.06 → 30k of 500k). */
  openRatio?: number;
  /** Reference time for end/created dates (default now). */
  now?: Date;
  /** Rows per INSERT statement (default 50,000). */
  batchSize?: number;
  /** First sequence number (to append to an existing fixture). */
  startAt?: number;
}

/** Insert `count` synthetic tenders (source `bulk`). Returns the number inserted. */
export async function insertBulkTenders(db: Db, opts: BulkTenderOptions): Promise<number> {
  const { count, openRatio = 0.06, now = new Date(), batchSize = 50_000, startAt = 1 } = opts;
  const states = STATE_WEIGHTS.flatMap(([s, w]) => Array<string>(w).fill(s)).filter((s) => (INDIAN_STATES as readonly string[]).includes(s));
  const openPer10k = Math.round(openRatio * 10_000);
  let inserted = 0;
  for (let from = startAt; from < startAt + count; from += batchSize) {
    const to = Math.min(startAt + count - 1, from + batchSize - 1);
    const res = await db.execute(sql`
      insert into tenders (source, bid_number, gem_bid_id, bid_type, title, items, category, quantity, ministry, department,
        organisation, state, city, start_at, end_at, emd_amount, estimated_value, status, source_url, raw, content_hash,
        fetched_at, created_at, updated_at)
      select ${BULK_SOURCE}, 'GEM/BULK/B/' || i, (9000000 + i)::text,
        (array['bid','bid','bid','ra','service'])[1 + (i % 5)],
        c.category || ' — lot ' || (i % 97),
        jsonb_build_array(jsonb_build_object('name', c.category, 'quantity', 1 + (i % 50))),
        c.category, 1 + (i % 500), m.ministry, 'Department ' || (i % 41), 'Organisation ' || (i % 211),
        s.state, 'City ' || (i % 59),
        o.ref - make_interval(days => 5 + (i % 400)),
        case when o.open then o.ref + make_interval(days => 1 + (i % 30), hours => i % 24)
             else o.ref - make_interval(days => 1 + (i % 365)) end,
        case when i % 3 = 0 then null else (1 + (i % 50)) * 10000 end,
        case when i % 7 = 0 then null else ((i::bigint * 7919) % 5000 + 1) * 10000 end,
        case when o.open then 'open' when i % 23 = 0 then 'cancelled' when i % 11 = 0 then 'awarded' else 'closed' end,
        'https://bidplus.gem.gov.in/bidlists?bid=' || i,
        jsonb_build_object('b_id', 9000000 + i, 'fixture', 'bulk', 'pad', repeat('x', 1000)),
        md5(i::text),
        o.ref, o.ref - make_interval(mins => (i % 525600)), o.ref
      from generate_series(${from}::int, ${to}::int) as i
      cross join lateral (select ${now.toISOString()}::timestamptz as ref, ((i * 7) % 10000) < ${openPer10k} as open) o
      cross join lateral (select (${pgArray(states)})[1 + ((i * 31) % ${states.length})] as state) s
      cross join lateral (select (${pgArray(MINISTRIES)})[1 + ((i * 17) % ${MINISTRIES.length})] as ministry) m
      cross join lateral (select (${pgArray(CATEGORIES)})[1 + ((i * 13) % ${CATEGORIES.length})] as category) c
      on conflict (source, bid_number) do nothing`);
    inserted += (res as unknown as { rowCount?: number }).rowCount ?? 0;
  }
  await db.execute(sql`analyze tenders`);
  return inserted;
}

/** Delete every `bulk` tender (cascades to their events/documents/matches). */
export async function deleteBulkTenders(db: Db): Promise<void> {
  await db.execute(sql`delete from tenders where source = ${BULK_SOURCE}`);
}

export interface BulkNotificationOptions {
  orgId: string;
  userId: string;
  count: number;
  /** Rows left `pending` on email/WhatsApp (the dispatcher's work queue); the rest are sent/read in-app. */
  pending: number;
  now?: Date;
}

/** Insert `count` notifications for one user, of which `pending` are pending email/WhatsApp (US4 scenario 5). */
export async function insertBulkNotifications(db: Db, opts: BulkNotificationOptions): Promise<void> {
  const { orgId, userId, count, pending, now = new Date() } = opts;
  const every = Math.max(1, Math.floor(count / Math.max(1, pending)));
  await db.execute(sql`
    insert into notifications (org_id, user_id, channel, kind, title, body, link, dedupe_key, status, sent_at, created_at)
    select ${orgId}::uuid, ${userId}::uuid,
      case when p.pending then (array['email','whatsapp'])[1 + (i % 2)] else (array['in_app','email','whatsapp'])[1 + (i % 3)] end,
      'tender_match', 'New match: bulk ' || i, 'Bulk fixture notification ' || i, '/tenders/bulk-' || i, 'bulk:' || i,
      case when p.pending then 'pending' when i % 5 = 0 then 'read' else 'sent' end,
      case when p.pending then null else ${now.toISOString()}::timestamptz end,
      ${now.toISOString()}::timestamptz - make_interval(secs => i)
    from generate_series(1, ${count}::int) as i
    cross join lateral (select (i % ${every} = 0 and i / ${every} <= ${pending}) as pending) p
    on conflict do nothing`);
  await db.execute(sql`analyze notifications`);
}

// ───────────── CLI ─────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const url = process.env.DATABASE_URL ?? 'postgres://tp:tp@localhost:5433/tenderpilot';
  (async () => {
    const { createNodeDb } = await import('../client');
    const { db, close } = await createNodeDb(url);
    try {
      if (process.argv.includes('--delete')) { await deleteBulkTenders(db); console.log('bulk tenders deleted'); return; }
      const count = Number(arg('count') ?? 500_000);
      const t0 = Date.now();
      const n = await insertBulkTenders(db, { count, openRatio: Number(arg('open-ratio') ?? 0.06) });
      console.log(`inserted ${n} bulk tenders in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      const notifications = Number(arg('notifications') ?? 0);
      if (notifications > 0) {
        const r = await db.execute(sql`select m.org_id, m.user_id from memberships m order by m.created_at limit 1`);
        const owner = (r as unknown as { rows: { org_id: string; user_id: string }[] }).rows[0];
        if (!owner) throw new Error('--notifications needs at least one org member (sign up first)');
        await insertBulkNotifications(db, { orgId: owner.org_id, userId: owner.user_id, count: notifications, pending: Number(arg('pending') ?? 500) });
        console.log(`inserted ${notifications} notifications`);
      }
    } finally {
      await close();
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
