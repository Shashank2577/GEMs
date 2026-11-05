/**
 * GeM ingestion service (T034; FR-001, FR-002, FR-004, FR-005, FR-007; Constitution II).
 *
 *   runIngestion(deps, { trigger: 'manual', pages: 3 }) → ingestion_runs row
 *
 * 1. Fetch N BidPlus listing pages through the polite GemClient (≤ 1 req/s, back-off).
 * 2. Upsert tenders by (source, bidNumber); unchanged content hash → only `fetchedAt` moves.
 * 3. Record tender_events: created / updated / corrigendum / closed / cancelled with a field diff.
 *    A corrigendum (end date, quantity, EMD, …) marks existing analyses `stale`.
 * 4. Match new & changed tenders against every active watchlist (all orgs) → tender_matches (unique).
 * 5. Queue notifications per org member and their prefs: in-app (sent immediately), email / WhatsApp
 *    (pending → services/alerts.ts). Deduped by (user, channel, `tender:<tenderId>:<orgId>`).
 * GeM being down never loses data: the run is recorded as `failed` (or `partial`) with the error.
 */
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import {
  analyses, ingestionRuns, memberships, notificationPrefs, notifications, tenderEvents, tenderMatches, tenders, users, watchlists,
  type WatchlistCriteria,
} from '@tp/db';
import { GemClient } from '@tp/core/gem/client';
import { diffTenders, isCorrigendum, type NormalizedTender } from '@tp/core/gem/parse';
import { matchTender } from '@tp/core/match/matcher';
import type { AppDeps } from '../deps';

export interface RunIngestionOptions {
  trigger?: 'cron' | 'manual' | 'seed';
  pages?: number;
  /** Optional free-text search sent to GeM. */
  search?: string;
  /** Inject a client (tests). Defaults to a GemClient over deps.fetch + deps.gem. */
  client?: Pick<GemClient, 'fetchTenders'>;
}

export type IngestionRunRow = typeof ingestionRuns.$inferSelect;

/** A run that has been "running" longer than this is considered dead and does not block new runs. */
export const RUN_LOCK_MS = 15 * 60_000;

export class IngestionBusyError extends Error {
  constructor(readonly run: IngestionRunRow) {
    super('A GeM sync is already running');
    this.name = 'IngestionBusyError';
  }
}

type TenderRow = typeof tenders.$inferSelect;
type Insertable = Omit<NormalizedTender, 'raw'> & { raw: Record<string, unknown> };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runIngestion(deps: AppDeps, opts: RunIngestionOptions = {}): Promise<IngestionRunRow> {
  const { db, clock, logger } = deps;
  const now = clock.now();
  const pages = Math.max(1, Math.min(20, opts.pages ?? deps.gem.maxPages));

  // Single-flight: don't start while another fresh run is going.
  const [busy] = await db.select().from(ingestionRuns)
    .where(and(eq(ingestionRuns.status, 'running'), gt(ingestionRuns.startedAt, new Date(now.getTime() - RUN_LOCK_MS))))
    .limit(1);
  if (busy) throw new IngestionBusyError(busy);
  // Reap dead runs.
  await db.update(ingestionRuns).set({ status: 'failed', error: 'Timed out (worker stopped)', finishedAt: now })
    .where(and(eq(ingestionRuns.status, 'running'), lt(ingestionRuns.startedAt, new Date(now.getTime() - RUN_LOCK_MS))));

  const [run] = await db.insert(ingestionRuns).values({ trigger: opts.trigger ?? 'cron', status: 'running', startedAt: now }).returning();
  const stats = { pagesFetched: 0, tendersSeen: 0, tendersCreated: 0, tendersUpdated: 0, matchesCreated: 0 };
  const errors: string[] = [];

  const client = opts.client ?? new GemClient(deps.fetch, {
    baseUrl: deps.gem.baseUrl,
    userAgent: deps.gem.userAgent,
    minIntervalMs: deps.gem.minIntervalMs,
    maxRetries: 3,
    backoffMs: deps.gem.minIntervalMs > 0 ? 2000 : 0,
  });

  try {
    // 1. Fetch pages.
    const fetched = new Map<string, NormalizedTender>();
    let rawSeen = 0;
    for (let page = 1; page <= pages; page++) {
      try {
        const res = await client.fetchTenders({ page, search: opts.search, now });
        stats.pagesFetched++;
        for (const t of res.tenders) fetched.set(t.bidNumber, t);
        rawSeen += res.rawCount;
        if (res.rawCount === 0 || rawSeen >= res.numFound) break;
      } catch (e) {
        errors.push(`page ${page}: ${errMsg(e)}`);
        logger.warn('ingestion: page failed', { page, error: errMsg(e) });
        break; // stay polite: don't hammer a failing portal
      }
    }
    stats.tendersSeen = fetched.size;

    // 2–3. Upsert + events.
    const changedIds: string[] = [];
    const corrigendumIds: string[] = [];
    const list = [...fetched.values()];
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      const existing = await db.select().from(tenders)
        .where(and(eq(tenders.source, 'gem'), inArray(tenders.bidNumber, chunk.map((t) => t.bidNumber))));
      const byBid = new Map(existing.map((r) => [r.bidNumber, r]));
      for (const t of chunk) {
        try {
          const prev = byBid.get(t.bidNumber);
          const r = await upsertTender(deps, t as Insertable, prev ?? null, now);
          if (r.kind === 'created') { stats.tendersCreated++; changedIds.push(r.id); }
          if (r.kind === 'updated') { stats.tendersUpdated++; changedIds.push(r.id); if (r.corrigendum) corrigendumIds.push(r.id); }
        } catch (e) {
          errors.push(`${t.bidNumber}: ${errMsg(e)}`);
          logger.error('ingestion: upsert failed', { bidNumber: t.bidNumber, error: errMsg(e) });
        }
      }
    }

    // 4–5. Match + notify.
    if (changedIds.length) {
      const m = await matchAndNotify(deps, changedIds, now);
      stats.matchesCreated = m.matchesCreated;
    }
    if (corrigendumIds.length) await notifyCorrigenda(deps, corrigendumIds, now);
    // Bids whose deadline passed since we last saw them.
    await db.update(tenders).set({ status: 'closed', updatedAt: now }).where(and(eq(tenders.status, 'open'), lt(tenders.endAt, now)));

    const status: IngestionRunRow['status'] = errors.length === 0 ? 'success' : stats.pagesFetched > 0 ? 'partial' : 'failed';
    const [done] = await db.update(ingestionRuns).set({
      ...stats, status, error: errors.length ? errors.slice(0, 5).join('; ').slice(0, 1000) : null, finishedAt: clock.now(),
    }).where(eq(ingestionRuns.id, run.id)).returning();
    logger.info('ingestion finished', { runId: run.id, status, ...stats });
    return done;
  } catch (e) {
    logger.error('ingestion failed', { runId: run.id, error: errMsg(e) });
    const [failed] = await db.update(ingestionRuns).set({ ...stats, status: 'failed', error: errMsg(e).slice(0, 1000), finishedAt: clock.now() })
      .where(eq(ingestionRuns.id, run.id)).returning();
    return failed;
  }
}

async function upsertTender(
  deps: AppDeps, t: Insertable, prev: TenderRow | null, now: Date,
): Promise<{ id: string; kind: 'created' | 'updated' | 'unchanged'; corrigendum?: boolean }> {
  const { db } = deps;
  const values = {
    source: t.source, bidNumber: t.bidNumber, gemBidId: t.gemBidId, bidType: t.bidType, title: t.title, items: t.items,
    category: t.category, quantity: t.quantity, ministry: t.ministry, department: t.department, organisation: t.organisation,
    buyerOffice: t.buyerOffice, state: t.state, city: t.city, startAt: t.startAt, endAt: t.endAt, openingAt: t.openingAt,
    emdAmount: t.emdAmount, estimatedValue: t.estimatedValue, epbgPercent: t.epbgPercent, hsnCodes: t.hsnCodes,
    status: t.status, documentUrl: t.documentUrl, sourceUrl: t.sourceUrl, raw: t.raw, contentHash: t.contentHash, fetchedAt: now,
  };

  if (!prev) {
    // ON CONFLICT guards against a concurrent run inserting the same bid.
    const [row] = await db.insert(tenders).values({ ...values, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [tenders.source, tenders.bidNumber] }).returning({ id: tenders.id });
    if (!row) return { id: '', kind: 'unchanged' };
    await db.insert(tenderEvents).values({ tenderId: row.id, kind: 'created', changes: {}, createdAt: now });
    return { id: row.id, kind: 'created' };
  }

  if (prev.contentHash === t.contentHash) {
    await db.update(tenders).set({ fetchedAt: now }).where(eq(tenders.id, prev.id));
    return { id: prev.id, kind: 'unchanged' };
  }

  // Values that GeM no longer publishes on the listing (e.g. enriched from the PDF) are kept.
  const keep = <K extends keyof typeof values>(k: K) => (values[k] === null && prev[k as keyof TenderRow] !== null ? (prev[k as keyof TenderRow] as (typeof values)[K]) : values[k]);
  const merged = {
    ...values,
    emdAmount: keep('emdAmount'), estimatedValue: keep('estimatedValue'), epbgPercent: keep('epbgPercent'),
    openingAt: keep('openingAt'), hsnCodes: values.hsnCodes.length ? values.hsnCodes : prev.hsnCodes,
  };
  const changes = diffTenders(prev, merged);
  if (!Object.keys(changes).length) {
    await db.update(tenders).set({ fetchedAt: now, contentHash: t.contentHash, raw: t.raw }).where(eq(tenders.id, prev.id));
    return { id: prev.id, kind: 'unchanged' };
  }
  const corrigendum = isCorrigendum(changes);
  const kind = corrigendum ? 'corrigendum'
    : changes.status?.to === 'closed' ? 'closed'
      : changes.status?.to === 'cancelled' ? 'cancelled' : 'updated';
  await db.update(tenders).set({ ...merged, updatedAt: now }).where(eq(tenders.id, prev.id));
  await db.insert(tenderEvents).values({ tenderId: prev.id, kind, changes, createdAt: now });
  if (corrigendum) {
    await db.update(analyses).set({ stale: true, updatedAt: now }).where(eq(analyses.tenderId, prev.id));
  }
  return { id: prev.id, kind: 'updated', corrigendum };
}

// ───────────── matching & notifications ─────────────

interface Prefs { inApp: boolean; email: boolean; whatsapp: boolean; frequency: 'instant' | 'daily' }
const DEFAULT_PREFS: Prefs = { inApp: true, email: true, whatsapp: false, frequency: 'instant' };

/** Members of an org with their notification prefs (defaults when no prefs row exists). */
export async function orgRecipients(deps: AppDeps, orgIds: string[]) {
  if (!orgIds.length) return new Map<string, { userId: string; name: string; email: string; phone: string | null; prefs: Prefs }[]>();
  const rows = await deps.db
    .select({
      orgId: memberships.orgId, userId: users.id, name: users.name, email: users.email, phone: users.phone,
      inApp: notificationPrefs.inApp, emailPref: notificationPrefs.email, whatsapp: notificationPrefs.whatsapp, frequency: notificationPrefs.frequency,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(notificationPrefs, and(eq(notificationPrefs.orgId, memberships.orgId), eq(notificationPrefs.userId, memberships.userId)))
    .where(inArray(memberships.orgId, orgIds));
  const out = new Map<string, { userId: string; name: string; email: string; phone: string | null; prefs: Prefs }[]>();
  for (const r of rows) {
    const prefs: Prefs = r.inApp === null
      ? DEFAULT_PREFS
      : { inApp: r.inApp, email: !!r.emailPref, whatsapp: !!r.whatsapp, frequency: (r.frequency ?? 'instant') as Prefs['frequency'] };
    const list = out.get(r.orgId) ?? [];
    list.push({ userId: r.userId, name: r.name, email: r.email, phone: r.phone, prefs });
    out.set(r.orgId, list);
  }
  return out;
}

const fmtInrShort = (n: number | null | undefined) =>
  n == null ? null : n >= 1e7 ? `₹${+(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${+(n / 1e5).toFixed(2)} L` : `₹${n.toLocaleString('en-IN')}`;
const fmtIstDate = (d: Date | null) =>
  d ? d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : 'n/a';

/** Short notification body: buyer · closes · EMD · value. */
export function tenderAlertBody(t: Pick<TenderRow, 'ministry' | 'department' | 'state' | 'endAt' | 'emdAmount' | 'estimatedValue' | 'bidNumber'>, watchlistNames: string[]): string {
  const parts = [
    t.bidNumber,
    [t.department ?? t.ministry, t.state].filter(Boolean).join(', '),
    `closes ${fmtIstDate(t.endAt)} IST`,
    t.emdAmount ? `EMD ${fmtInrShort(t.emdAmount)}` : null,
    t.estimatedValue ? `value ${fmtInrShort(t.estimatedValue)}` : null,
  ].filter(Boolean);
  return `${parts.join(' · ')}${watchlistNames.length ? ` — matched “${watchlistNames.join('”, “')}”` : ''}`;
}

/**
 * Match the given tenders against all active watchlists (every org), store new matches and queue
 * notifications for each new (org, tender) pair. Safe to call repeatedly (unique indexes).
 */
export async function matchAndNotify(
  deps: AppDeps, tenderIds: string[], now: Date,
  opts: { orgId?: string; watchlistId?: string; notify?: boolean } = {},
): Promise<{ matchesCreated: number; notificationsCreated: number }> {
  const { db } = deps;
  const conds = [eq(watchlists.active, true)];
  if (opts.orgId) conds.push(eq(watchlists.orgId, opts.orgId));
  if (opts.watchlistId) conds.push(eq(watchlists.id, opts.watchlistId));
  const lists = await db.select().from(watchlists).where(and(...conds));
  if (!lists.length || !tenderIds.length) return { matchesCreated: 0, notificationsCreated: 0 };
  const rows: TenderRow[] = [];
  for (let i = 0; i < tenderIds.length; i += 500) {
    rows.push(...(await db.select().from(tenders).where(inArray(tenders.id, tenderIds.slice(i, i + 500)))));
  }

  // (orgId, tenderId) → watchlist names that newly matched
  const fresh = new Map<string, { orgId: string; tender: TenderRow; names: string[]; reasons: string[] }>();
  let matchesCreated = 0;
  for (const t of rows) {
    for (const w of lists) {
      const r = matchTender(t, w.criteria as WatchlistCriteria, { now });
      if (!r.matched) continue;
      const [ins] = await db.insert(tenderMatches)
        .values({ orgId: w.orgId, tenderId: t.id, watchlistId: w.id, reasons: r.reasons, relevance: r.relevance, createdAt: now })
        .onConflictDoNothing()
        .returning({ id: tenderMatches.id });
      if (!ins) continue;
      matchesCreated++;
      const key = `${w.orgId}:${t.id}`;
      const f = fresh.get(key) ?? { orgId: w.orgId, tender: t, names: [], reasons: [] };
      f.names.push(w.name);
      for (const reason of r.reasons) if (!f.reasons.includes(reason)) f.reasons.push(reason);
      fresh.set(key, f);
    }
  }
  if (!fresh.size || opts.notify === false) return { matchesCreated, notificationsCreated: 0 };

  const recipients = await orgRecipients(deps, [...new Set([...fresh.values()].map((f) => f.orgId))]);
  const values: (typeof notifications.$inferInsert)[] = [];
  for (const f of fresh.values()) {
    const title = `New match: ${f.tender.title}`.slice(0, 200);
    const body = tenderAlertBody(f.tender, f.names);
    const link = `/tenders/${f.tender.id}`;
    const dedupeKey = `tender:${f.tender.id}:${f.orgId}`;
    for (const u of recipients.get(f.orgId) ?? []) {
      const base = { orgId: f.orgId, userId: u.userId, kind: 'tender_match' as const, title, body, link, dedupeKey, createdAt: now };
      if (u.prefs.inApp) values.push({ ...base, channel: 'in_app', status: 'sent', sentAt: now });
      if (u.prefs.email) values.push({ ...base, channel: 'email', status: 'pending' });
      if (u.prefs.whatsapp) {
        values.push(u.phone
          ? { ...base, channel: 'whatsapp', status: 'pending' }
          : { ...base, channel: 'whatsapp', status: 'skipped', error: 'Add a mobile number in your account to receive WhatsApp alerts' });
      }
    }
  }
  let notificationsCreated = 0;
  for (let i = 0; i < values.length; i += 500) {
    const ins = await db.insert(notifications).values(values.slice(i, i + 500)).onConflictDoNothing().returning({ id: notifications.id });
    notificationsCreated += ins.length;
  }
  return { matchesCreated, notificationsCreated };
}

/** In-app heads-up for orgs that track a tender which just received a corrigendum. */
async function notifyCorrigenda(deps: AppDeps, tenderIds: string[], now: Date): Promise<void> {
  const { db } = deps;
  const tracked = await db.selectDistinct({ orgId: tenderMatches.orgId, tenderId: tenderMatches.tenderId })
    .from(tenderMatches).where(inArray(tenderMatches.tenderId, tenderIds));
  if (!tracked.length) return;
  const rows = await db.select().from(tenders).where(inArray(tenders.id, [...new Set(tracked.map((t) => t.tenderId))]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const recipients = await orgRecipients(deps, [...new Set(tracked.map((t) => t.orgId))]);
  const values: (typeof notifications.$inferInsert)[] = [];
  for (const tr of tracked) {
    const t = byId.get(tr.tenderId);
    if (!t) continue;
    for (const u of recipients.get(tr.orgId) ?? []) {
      if (!u.prefs.inApp) continue;
      values.push({
        orgId: tr.orgId, userId: u.userId, channel: 'in_app', kind: 'deadline', status: 'sent', sentAt: now, createdAt: now,
        title: `Corrigendum: ${t.title}`.slice(0, 200),
        body: `${t.bidNumber} was amended on GeM — now closes ${fmtIstDate(t.endAt)} IST. Re-check the analysis before you bid.`,
        link: `/tenders/${t.id}`,
        dedupeKey: `corrigendum:${t.id}:${t.contentHash}:${tr.orgId}`,
      });
    }
  }
  if (values.length) await db.insert(notifications).values(values).onConflictDoNothing();
}
