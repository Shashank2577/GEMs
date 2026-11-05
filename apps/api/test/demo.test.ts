/** Demo seed (T075; US7): POST /api/demo/seed, idempotency, tenancy, generated PDFs, role checks; DELETE /api/demo (007/US4). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { activityLog, analyses, bidWorkspaces, comments, companyProfiles, notifications, organizations, pastContracts, tenderDocuments, tenderMatches, tenders, vaultDocuments, watchlists } from '@tp/db';
import { seedDemo, removeDemo, demoPdf, demoBidNumber, planTenders, DEMO_COMPANY, DEMO_WATCHLISTS } from '@tp/db/demo';
import { matchAndNotify } from '../src/services/ingest';
import { createTestContext, request, seedOrgWithRoles, signup, type TestContext } from './helpers';

const NOW = new Date('2026-11-04T04:30:00Z'); // 10:00 IST

let ctx: TestContext;
let org: Awaited<ReturnType<typeof seedOrgWithRoles>>;

const countWhere = async (table: typeof analyses | typeof bidWorkspaces | typeof vaultDocuments, orgId: string) => {
  const [r] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.orgId, orgId));
  return r!.n;
};

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW });
  org = await seedOrgWithRoles(ctx.app, 'Demo Seed Org');
});
afterAll(() => ctx?.close());

describe('POST /api/demo/seed', () => {
  it('requires bid manager or owner', async () => {
    expect((await request(ctx.app, 'POST', '/demo/seed')).status).toBe(401);
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: org.viewer.cookie })).status).toBe(403);
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: org.analyst.cookie })).status).toBe(403);
  });

  it('seeds a realistic company, vault, watchlists, tenders, matches, analyses and pipeline', async () => {
    const r = await request(ctx.app, 'POST', '/demo/seed', { cookie: org.bidManager.cookie });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, created: true, tenders: 40, watchlists: 3, workspaces: 16, analyses: 20, pastContracts: 5, vaultDocuments: 15 });
    expect(r.body.matches).toBeGreaterThan(15);

    const me = await request(ctx.app, 'GET', '/auth/me', { cookie: org.owner.cookie });
    expect(me.body.org.onboardingState.demo).toBe(true);

    const profile = await request(ctx.app, 'GET', '/profile', { cookie: org.viewer.cookie });
    expect(profile.body.profile).toMatchObject({ legalName: DEMO_COMPANY.legalName, gstin: DEMO_COMPANY.gstin, mseCategory: 'micro', miiClass: 'class_1' });
    expect(profile.body.profile.financials).toHaveLength(3);
    // OEM rows are linked to their seeded vault letters, except D-Link India (spec 005 US2 scenario 10).
    const oemDocs = await ctx.db.select({ id: vaultDocuments.id, title: vaultDocuments.title }).from(vaultDocuments).where(eq(vaultDocuments.orgId, org.orgId));
    const docId = (t: string) => oemDocs.find((d) => d.title.startsWith(t))!.id;
    expect(profile.body.profile.oemAuthorizations.map((o: { oem: string; documentId?: string | null }) => [o.oem, o.documentId ?? null])).toEqual([
      ['CP PLUS', docId('OEM authorisation – CP PLUS')],
      ['Dell Technologies', docId('OEM authorisation – Dell Technologies')],
      ['D-Link India', null],
    ]);
    expect(profile.body.completeness).toBe(96);
    expect(profile.body.issues.filter((i: { severity: string }) => i.severity === 'info').map((i: { message: string }) => i.message))
      .toEqual(['Link the D-Link India authorisation letter from the vault so packets can attach it.']);

    // Every pipeline stage except "dropped" is represented.
    const stages = await ctx.db.selectDistinct({ s: bidWorkspaces.stage }).from(bidWorkspaces).where(eq(bidWorkspaces.orgId, org.orgId));
    expect(stages.map((s) => s.s).sort()).toEqual(['analysing', 'go', 'identified', 'lost', 'preparing', 'ready', 'submitted', 'won']);

    // Tender dates are relative to now: some closing today, some already closed.
    const rows = await ctx.db.select({ endAt: tenders.endAt, status: tenders.status, bidNumber: tenders.bidNumber }).from(tenders);
    expect(rows.some((t) => t.endAt! > NOW && t.endAt!.getTime() - NOW.getTime() < 12 * 3_600_000)).toBe(true);
    expect(rows.some((t) => t.status === 'closed')).toBe(true);
    expect(rows.every((t) => /^GEM\/2026\/B\/\d{7}$/.test(t.bidNumber))).toBe(true);
  });

  it('is idempotent — a second call creates nothing new', async () => {
    const before = await Promise.all([countWhere(analyses, org.orgId), countWhere(bidWorkspaces, org.orgId), countWhere(vaultDocuments, org.orgId)]);
    const r = await request(ctx.app, 'POST', '/demo/seed', { cookie: org.owner.cookie });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(false);
    const after = await Promise.all([countWhere(analyses, org.orgId), countWhere(bidWorkspaces, org.orgId), countWhere(vaultDocuments, org.orgId)]);
    expect(after).toEqual(before);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(tenders);
    expect(n).toBe(40);
  });

  it('links the demo OEM rows on a retried seed (profile written, links missing)', async () => {
    const [p] = await ctx.db.select({ oems: companyProfiles.oemAuthorizations }).from(companyProfiles).where(eq(companyProfiles.orgId, org.orgId));
    await ctx.db.update(companyProfiles).set({ oemAuthorizations: p!.oems.map(({ documentId: _d, ...o }) => o) }).where(eq(companyProfiles.orgId, org.orgId));
    const r = await request(ctx.app, 'POST', '/demo/seed', { cookie: org.owner.cookie });
    expect(r.status).toBe(200);
    const profile = await request(ctx.app, 'GET', '/profile', { cookie: org.viewer.cookie });
    expect(profile.body.profile.oemAuthorizations.map((o: { documentId?: string | null }) => !!o.documentId)).toEqual([true, true, false]);
  });

  it('stores real PDFs in the vault that download and merge (pdf-lib)', async () => {
    const list = await request(ctx.app, 'GET', '/vault', { cookie: org.viewer.cookie });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(15);
    const statuses = list.body.items.map((d: { status: string }) => d.status);
    expect(statuses).toContain('expired');
    expect(statuses).toContain('expiring');
    const dl = await request(ctx.app, 'GET', `/vault/${list.body.items[0].id}/download`, { cookie: org.viewer.cookie });
    expect(dl.status).toBe(200);
    const bytes = new Uint8Array(await dl.res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it('demo workspaces work with the Apply module (Kanban list)', async () => {
    const r = await request(ctx.app, 'GET', '/workspaces', { cookie: org.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(16);
    const ready = r.body.items.find((w: { stage: string }) => w.stage === 'ready');
    expect(ready.analysis.verdict).toBe('go');
    expect(ready.readiness.total).toBeGreaterThan(0);
    // The Dell-desktop bid is pinned to the expired Dell authorisation → "Ready" is blocked (409) with reasons.
    const blocked = r.body.items.find((w: { stage: string; readiness: { blockers: number } }) => w.stage === 'preparing' && w.readiness.blockers > 0);
    expect(blocked).toBeTruthy();
    const move = await request(ctx.app, 'PATCH', `/workspaces/${blocked.id}`, { cookie: org.analyst.cookie, json: { stage: 'ready' } });
    expect(move.status).toBe(409);
    expect(move.body.error.details.blockers.length).toBeGreaterThan(0);
  });

  it('keeps tenants isolated and never overwrites a filled-in profile', async () => {
    const other = await signup(ctx.app, { orgName: 'Shree Ganesh Traders' });
    const put = await request(ctx.app, 'PUT', '/profile', { cookie: other.cookie, json: { legalName: 'Shree Ganesh Traders LLP' } });
    expect(put.status).toBe(200);
    // Before seeding, the other org sees none of the first org's data.
    expect((await request(ctx.app, 'GET', '/workspaces', { cookie: other.cookie })).body.total).toBe(0);
    expect((await request(ctx.app, 'GET', '/vault', { cookie: other.cookie })).body.items).toHaveLength(0);
    // Demo tenders reach total + facets (one GROUPING SETS scan) only for an org that loaded the demo (008/FR-016).
    const open = (await ctx.db.select({ id: tenders.id }).from(tenders).where(and(eq(tenders.status, 'open'), sql`coalesce(${tenders.endAt}, 'infinity'::timestamptz) >= ${NOW}`))).length;
    expect(open).toBeGreaterThan(0);
    const demoFeed = await request(ctx.app, 'GET', '/tenders?pageSize=100', { cookie: org.viewer.cookie });
    expect(demoFeed.body.total).toBe(open);
    expect(demoFeed.body.facets.states.length).toBeGreaterThan(0);
    const plainFeed = await request(ctx.app, 'GET', '/tenders?pageSize=100', { cookie: other.cookie });
    expect(plainFeed.body).toMatchObject({ total: 0, items: [], facets: { states: [], ministries: [], categories: [] } });

    const r = await request(ctx.app, 'POST', '/demo/seed', { cookie: other.cookie });
    expect(r.status).toBe(201);
    const [p] = await ctx.db.select({ legalName: companyProfiles.legalName }).from(companyProfiles).where(eq(companyProfiles.orgId, other.me.org.id));
    expect(p!.legalName).toBe('Shree Ganesh Traders LLP');
    // Global tenders are shared (upserted), org data is per org.
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(tenders);
    expect(n).toBe(40);
    expect(await countWhere(bidWorkspaces, other.me.org.id)).toBe(16);
    expect(await countWhere(bidWorkspaces, org.orgId)).toBe(16);
  });
});

describe('seedDemo / demoPdf (library)', () => {
  it('works without a blob store', async () => {
    const owner = await signup(ctx.app, { orgName: 'No Blobs Pvt Ltd' });
    const userId = owner.me.user.id;
    const r = await seedDemo(ctx.db, { orgId: owner.me.org.id, userId, now: NOW });
    expect(r.workspaces).toBe(16);
    const again = await seedDemo(ctx.db, { orgId: owner.me.org.id, userId, now: NOW });
    expect(again.created).toBe(false);
  });

  it('generates a valid one-page PDF', async () => {
    const doc = await PDFDocument.load(demoPdf('GST certificate (Form REG-06)', ['GSTIN: 27AAJCA4721K1ZK', 'Pune – 411045']));
    expect(doc.getPageCount()).toBe(1);
  });
});

// ───────────── 008/US3: demo data never leaks to other orgs (FR-016) ─────────────

const DEMO_BIDS = new Set(Array.from({ length: 40 }, (_, i) => demoBidNumber(i)));
const demoTenderIds = async () => (await ctx.db.select({ id: tenders.id }).from(tenders).where(eq(tenders.source, 'demo'))).map((r) => r.id);

/** A real (ingested-looking) open GeM tender about laptops. */
async function gemLaptopTender(n: number) {
  const [t] = await ctx.db.insert(tenders).values({
    bidNumber: `GEM/2026/B/91000${n}`, title: `Laptop – Notebook supply lot ${n}`, category: 'Laptop - Notebook', state: 'Maharashtra',
    ministry: 'Ministry of Finance', endAt: new Date(NOW.getTime() + 10 * 86_400_000), estimatedValue: 900_000,
    sourceUrl: 'https://bidplus.gem.gov.in/all-bids', contentHash: `real-${n}`,
  }).returning();
  return t!;
}

describe('008/FR-016 demo isolation (US3 scenarios 1–2)', () => {
  let a: Awaited<ReturnType<typeof signup>>;
  let b: Awaited<ReturnType<typeof signup>>;

  beforeAll(async () => {
    a = await signup(ctx.app, { orgName: 'Org A Demo' });
    b = await signup(ctx.app, { orgName: 'Org B Real' });
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: a.cookie })).status).toBe(201);
  });

  it('demo tenders are stored with source = demo and raw.demo = true (T044)', async () => {
    const rows = await ctx.db.select({ bid: tenders.bidNumber, source: tenders.source, raw: tenders.raw }).from(tenders)
      .where(inArray(tenders.bidNumber, [...DEMO_BIDS]));
    expect(rows).toHaveLength(40);
    expect(rows.every((r) => r.source === 'demo' && (r.raw as { demo?: boolean }).demo === true)).toBe(true);
  });

  it('org A sees the 40 demo bids; org B sees none of them in the feed, detail, preview, dashboard or sync counts', async () => {
    const allA = await request(ctx.app, 'GET', '/tenders?status=all&pageSize=100', { cookie: a.cookie });
    expect(allA.body.items.filter((t: { bidNumber: string }) => DEMO_BIDS.has(t.bidNumber))).toHaveLength(40);

    const real = await gemLaptopTender(1);
    const allB = await request(ctx.app, 'GET', '/tenders?status=all&pageSize=100', { cookie: b.cookie });
    expect(allB.status).toBe(200);
    expect(allB.body.items.some((t: { bidNumber: string }) => DEMO_BIDS.has(t.bidNumber))).toBe(false);
    expect(allB.body.items.map((t: { id: string }) => t.id)).toContain(real.id);
    // Facets are computed on the same scope.
    const facetTotal = allB.body.facets.states.reduce((n: number, f: { count: number }) => n + f.count, 0);
    expect(facetTotal).toBe(allB.body.total);
    const search = await request(ctx.app, 'GET', '/tenders?status=all&q=CCTV', { cookie: b.cookie });
    expect(search.body.total).toBe(0);

    const [demoId] = await demoTenderIds();
    expect((await request(ctx.app, 'GET', `/tenders/${demoId}`, { cookie: b.cookie })).status).toBe(404);
    expect((await request(ctx.app, 'POST', `/tenders/${demoId}/seen`, { cookie: b.cookie })).status).toBe(404);
    expect((await request(ctx.app, 'GET', `/tenders/${demoId}`, { cookie: a.cookie })).status).toBe(200);

    const prevB = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: b.cookie, json: { criteria: { keywords: ['laptop', 'desktop', 'cctv'] } } });
    expect(prevB.status).toBe(200);
    expect(prevB.body.sample.some((t: { bidNumber: string }) => DEMO_BIDS.has(t.bidNumber))).toBe(false);
    expect(prevB.body.count).toBe(1); // only the real laptop tender
    const prevA = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: a.cookie, json: { criteria: { keywords: ['laptop', 'desktop', 'cctv'] } } });
    expect(prevA.body.count).toBeGreaterThan(1);

    const dashB = await request(ctx.app, 'GET', '/dashboard', { cookie: b.cookie });
    expect(dashB.body.tiles).toMatchObject({ newMatchesToday: 0, closingThisWeek: 0, activeBids: 0 });
    expect(dashB.body.closingSoon).toEqual([]);
    expect(dashB.body.recentMatches).toEqual([]);
    expect(dashB.body.stats.openTenders).toBe(1);
    const dashA = await request(ctx.app, 'GET', '/dashboard', { cookie: a.cookie });
    expect(dashA.body.stats.openTenders).toBeGreaterThan(30);

    const runs = await request(ctx.app, 'GET', '/ingestion/runs', { cookie: b.cookie });
    const [{ n: gemCount }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(tenders).where(eq(tenders.source, 'gem'));
    expect(runs.body.totalTenders).toBe(gemCount);
  });

  it('matching never pairs another org’s watchlist with a demo tender (T046)', async () => {
    const wl = await request(ctx.app, 'POST', '/watchlists', { cookie: b.cookie, json: { name: 'Laptops', criteria: { keywords: ['laptop'] } } });
    expect(wl.status).toBe(201);
    const ids = await demoTenderIds();
    // The next ingestion/matching pass over the demo tenders (e.g. a demo re-seed refreshing dates).
    const r = await matchAndNotify(ctx.deps, ids, NOW);
    expect(r).toEqual({ matchesCreated: 0, notificationsCreated: 0 });
    const bMatches = await ctx.db.select().from(tenderMatches).where(and(eq(tenderMatches.orgId, b.me.org.id), inArray(tenderMatches.tenderId, ids)));
    expect(bMatches).toHaveLength(0);
    const bNotes = await ctx.db.select().from(notifications).where(eq(notifications.orgId, b.me.org.id));
    expect(bNotes.filter((n) => ids.some((id) => n.link === `/tenders/${id}`))).toHaveLength(0);
    // A real GeM tender still matches and alerts.
    const real = await gemLaptopTender(2);
    expect((await matchAndNotify(ctx.deps, [real.id], NOW)).matchesCreated).toBeGreaterThanOrEqual(1);
    const listed = await request(ctx.app, 'GET', '/watchlists', { cookie: b.cookie });
    expect(listed.body.items[0].matchCount).toBe(2); // lots 1 and 2, no demo bids
  });

  it('a gem row still marked raw.demo = true (re-seeded by old code) stays invisible to non-demo orgs (S6)', async () => {
    const [leak] = await ctx.db.insert(tenders).values({
      bidNumber: 'GEM/2026/B/9999001', title: 'Laptop leak from an old seeder', category: 'Laptop - Notebook', state: 'Maharashtra',
      endAt: new Date(NOW.getTime() + 5 * 86_400_000), sourceUrl: 'https://bidplus.gem.gov.in/all-bids', contentHash: 'leak', raw: { demo: true },
    }).returning();
    const feed = await request(ctx.app, 'GET', '/tenders?status=all&pageSize=100', { cookie: b.cookie });
    expect(feed.body.items.some((t: { id: string }) => t.id === leak!.id)).toBe(false);
    expect((await request(ctx.app, 'GET', `/tenders/${leak!.id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await matchAndNotify(ctx.deps, [leak!.id], NOW)).matchesCreated).toBe(0);
  });

  it('N8: a demo org’s saved watchlist matches what its preview showed — silently, no alerts', async () => {
    const criteria = { keywords: ['cctv'] };
    const prev = await request(ctx.app, 'POST', '/watchlists/preview', { cookie: a.cookie, json: { criteria } });
    expect(prev.body.count).toBeGreaterThan(0);
    const notesBefore = (await ctx.db.select().from(notifications).where(eq(notifications.orgId, a.me.org.id))).length;
    const wl = await request(ctx.app, 'POST', '/watchlists', { cookie: a.cookie, json: { name: 'Demo CCTV', criteria } });
    expect(wl.status).toBe(201);
    const listed = await request(ctx.app, 'GET', '/watchlists', { cookie: a.cookie });
    const saved = listed.body.items.find((w: { id: string }) => w.id === wl.body.id);
    expect(saved.openCount).toBe(prev.body.count);
    expect((await ctx.db.select().from(notifications).where(eq(notifications.orgId, a.me.org.id))).length).toBe(notesBefore);
    // Org B's identical watchlist never matches the demo bids.
    const wlB = await request(ctx.app, 'POST', '/watchlists', { cookie: b.cookie, json: { name: 'CCTV', criteria } });
    const listedB = await request(ctx.app, 'GET', '/watchlists', { cookie: b.cookie });
    expect(listedB.body.items.find((w: { id: string }) => w.id === wlB.body.id).matchCount).toBe(0);
  });
});

describe('008/FR-016 R3: the seeder fingerprint content_hash = demo-<bid> also hides a row', () => {
  it('a gem copy of a demo bid without the raw marker is invisible to non-demo orgs and is deleted by the data-fix', async () => {
    const viewer = await signup(ctx.app, { orgName: 'Fingerprint Viewer' });
    const bid = demoBidNumber(3);
    const [copy] = await ctx.db.insert(tenders).values({
      source: 'gem', bidNumber: bid, title: 'Online UPS 10 kVA (stale demo copy)', category: 'UPS', state: 'Maharashtra',
      endAt: new Date(NOW.getTime() + 5 * 86_400_000), sourceUrl: 'https://bidplus.gem.gov.in/all-bids', contentHash: `demo-${bid}`, raw: {},
    }).returning();
    expect((await request(ctx.app, 'GET', `/tenders/${copy!.id}`, { cookie: viewer.cookie })).status).toBe(404);
    const feed = await request(ctx.app, 'GET', '/tenders?status=all&q=stale', { cookie: viewer.cookie });
    expect(feed.body.total).toBe(0);
    expect((await matchAndNotify(ctx.deps, [copy!.id], NOW)).matchesCreated).toBe(0);
    // A 'demo' row with the same bid number exists, so step 1 cannot convert the copy: step 1b deletes it.
    expect((await ctx.db.select().from(tenders).where(and(eq(tenders.source, 'demo'), eq(tenders.bidNumber, bid)))).length).toBe(1);
    for (const stmt of readFileSync(fileURLToPath(new URL('../../../packages/db/migrations/0010_demo_source_datafix.sql', import.meta.url)), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.replace(/--.*$/gm, '').trim()) await ctx.db.execute(sql.raw(stmt));
    }
    expect(await ctx.db.select().from(tenders).where(eq(tenders.id, copy!.id))).toHaveLength(0);
    expect((await ctx.db.select().from(tenders).where(and(eq(tenders.source, 'demo'), eq(tenders.bidNumber, bid)))).length).toBe(1);
  });
});

describe('008/T047 data-fix migration 0010_demo_source_datafix (US3 scenario 3)', () => {
  const MIGRATION = fileURLToPath(new URL('../../../packages/db/migrations/0010_demo_source_datafix.sql', import.meta.url));
  const runMigration = async () => {
    for (const stmt of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
      if (stmt.replace(/--.*$/gm, '').trim()) await ctx.db.execute(sql.raw(stmt));
    }
  };

  it('is data-only (no destructive DDL)', () => {
    const body = readFileSync(MIGRATION, 'utf8').replace(/--.*$/gm, '');
    expect(body).not.toMatch(/\b(DROP|RENAME|ALTER|TRUNCATE|CREATE)\b/i);
  });

  it('converts legacy demo rows to source = demo and removes their matches/alerts for non-demo orgs only', async () => {
    const demoOrg = await signup(ctx.app, { orgName: 'Legacy Demo Org' });
    const realOrg = await signup(ctx.app, { orgName: 'Legacy Real Org' });
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: demoOrg.cookie })).status).toBeLessThan(300);
    const ids = await demoTenderIds();
    const real = await gemLaptopTender(3);

    // Recreate the pre-008 state: demo tenders stored as 'gem' (one only recognisable by its content hash), and a
    // non-demo org that matched one of them and got alerted.
    await ctx.db.update(tenders).set({ source: 'gem' }).where(inArray(tenders.id, ids));
    await ctx.db.update(tenders).set({ raw: {} }).where(eq(tenders.id, ids[1]!));
    const [w] = await ctx.db.insert(watchlists).values({ orgId: realOrg.me.org.id, name: 'Everything', criteria: { keywords: ['laptop'], excludeKeywords: [], categories: [], hsnCodes: [], states: [], ministries: [], bidTypes: [] } }).returning();
    await ctx.db.insert(tenderMatches).values([
      { orgId: realOrg.me.org.id, tenderId: ids[0]!, watchlistId: w!.id },
      { orgId: realOrg.me.org.id, tenderId: ids[1]!, watchlistId: w!.id },
      { orgId: realOrg.me.org.id, tenderId: real.id, watchlistId: w!.id },
    ]);
    const note = (tenderId: string, key = `tender:${tenderId}:${realOrg.me.org.id}`) => ({
      orgId: realOrg.me.org.id, userId: realOrg.me.user.id, channel: 'in_app' as const, kind: 'tender_match' as const,
      title: 'New match', body: 'x', link: `/tenders/${tenderId}`, dedupeKey: key, status: 'sent' as const,
    });
    await ctx.db.insert(notifications).values([note(ids[0]!), note(ids[1]!, `legacy:${ids[1]}`), note(real.id)]);
    // Work the non-demo org built on leaked demo tenders (S6): an analysis, a workspace with a comment, an upload.
    await ctx.db.insert(analyses).values([
      { orgId: realOrg.me.org.id, tenderId: ids[0]!, status: 'done', method: 'rules', score: 50, verdict: 'review', factors: [], requirements: [], checklist: [] },
      { orgId: realOrg.me.org.id, tenderId: real.id, status: 'done', method: 'rules', score: 70, verdict: 'go', factors: [], requirements: [], checklist: [] },
    ]);
    const [ws] = await ctx.db.insert(bidWorkspaces).values([{ orgId: realOrg.me.org.id, tenderId: ids[0]! }, { orgId: realOrg.me.org.id, tenderId: real.id }]).returning();
    await ctx.db.insert(comments).values({ orgId: realOrg.me.org.id, workspaceId: ws!.id, userId: realOrg.me.user.id, body: 'On a fake bid' });
    await ctx.db.insert(tenderDocuments).values([
      { tenderId: ids[0]!, orgId: realOrg.me.org.id, fileName: 'x.pdf', blobKey: 'k/x.pdf', sizeBytes: 1 },
      { tenderId: ids[0]!, orgId: demoOrg.me.org.id, fileName: 'y.pdf', blobKey: 'k/y.pdf', sizeBytes: 1 },
    ]);
    const demoWsBefore = (await ctx.db.select().from(bidWorkspaces).where(eq(bidWorkspaces.orgId, demoOrg.me.org.id))).length;
    const demoAnalysesBefore = (await ctx.db.select().from(analyses).where(eq(analyses.orgId, demoOrg.me.org.id))).length;
    const demoOrgMatchesBefore = (await ctx.db.select().from(tenderMatches).where(eq(tenderMatches.orgId, demoOrg.me.org.id))).length;
    expect(demoOrgMatchesBefore).toBeGreaterThan(0);

    await runMigration();
    await runMigration(); // idempotent

    const sources = await ctx.db.select({ id: tenders.id, source: tenders.source }).from(tenders).where(inArray(tenders.id, [...ids, real.id]));
    expect(sources.filter((r) => r.id !== real.id).every((r) => r.source === 'demo')).toBe(true);
    expect(sources.find((r) => r.id === real.id)!.source).toBe('gem');

    const left = await ctx.db.select({ tenderId: tenderMatches.tenderId }).from(tenderMatches).where(eq(tenderMatches.orgId, realOrg.me.org.id));
    expect(left.map((m) => m.tenderId)).toEqual([real.id]);
    const notes = await ctx.db.select({ link: notifications.link }).from(notifications).where(eq(notifications.orgId, realOrg.me.org.id));
    expect(notes.map((n) => n.link)).toEqual([`/tenders/${real.id}`]);
    // The demo org keeps its demo matches.
    expect((await ctx.db.select().from(tenderMatches).where(eq(tenderMatches.orgId, demoOrg.me.org.id))).length).toBe(demoOrgMatchesBefore);
    // Non-demo org: work on demo tenders is gone, work on the real tender stays; the demo org keeps everything.
    expect((await ctx.db.select({ t: analyses.tenderId }).from(analyses).where(eq(analyses.orgId, realOrg.me.org.id))).map((r) => r.t)).toEqual([real.id]);
    expect((await ctx.db.select({ t: bidWorkspaces.tenderId }).from(bidWorkspaces).where(eq(bidWorkspaces.orgId, realOrg.me.org.id))).map((r) => r.t)).toEqual([real.id]);
    expect(await ctx.db.select().from(comments).where(eq(comments.workspaceId, ws!.id))).toHaveLength(0);
    expect((await ctx.db.select({ o: tenderDocuments.orgId }).from(tenderDocuments).where(eq(tenderDocuments.tenderId, ids[0]!))).map((r) => r.o)).toEqual([demoOrg.me.org.id]);
    expect((await ctx.db.select().from(bidWorkspaces).where(eq(bidWorkspaces.orgId, demoOrg.me.org.id))).length).toBe(demoWsBefore);
    expect((await ctx.db.select().from(analyses).where(eq(analyses.orgId, demoOrg.me.org.id))).length).toBe(demoAnalysesBefore);
    const [o] = await ctx.db.select({ s: organizations.onboardingState }).from(organizations).where(eq(organizations.id, demoOrg.me.org.id));
    expect(o!.s.demo).toBe(true);
    // Only demo-marked rows were reclassified (incl. the raw.demo gem leak inserted above); the real tender was not.
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(tenders)
      .where(and(eq(tenders.source, 'demo'), ne(tenders.contentHash, sql`'demo-' || ${tenders.bidNumber}`), sql`coalesce(${tenders.raw}->>'demo', '') <> 'true'`));
    expect(n).toBe(0);
  });
});

// ───────────── 007/US4: remove the demo data (T050; FR-065, SC-007) ─────────────

/** Demo tenders by every marker the app knows (source, raw.demo, seeder content hash). */
const allDemoTenderIds = async () => (await ctx.db.select({ id: tenders.id }).from(tenders)
  .where(sql`${tenders.source} = 'demo' or coalesce(${tenders.raw}->>'demo', '') = 'true' or ${tenders.contentHash} = 'demo-' || ${tenders.bidNumber}`)).map((r) => r.id);

const orgCounts = async (orgId: string) => {
  const ids = await allDemoTenderIds();
  const n = async (q: Promise<unknown[]>) => (await q).length;
  return {
    workspaces: await n(ctx.db.select({ id: bidWorkspaces.id }).from(bidWorkspaces).where(eq(bidWorkspaces.orgId, orgId))),
    demoWorkspaces: await n(ctx.db.select({ id: bidWorkspaces.id }).from(bidWorkspaces).where(and(eq(bidWorkspaces.orgId, orgId), inArray(bidWorkspaces.tenderId, ids)))),
    demoAnalyses: await n(ctx.db.select({ id: analyses.id }).from(analyses).where(and(eq(analyses.orgId, orgId), inArray(analyses.tenderId, ids)))),
    demoMatches: await n(ctx.db.select({ id: tenderMatches.id }).from(tenderMatches).where(and(eq(tenderMatches.orgId, orgId), inArray(tenderMatches.tenderId, ids)))),
    vault: await n(ctx.db.select({ id: vaultDocuments.id }).from(vaultDocuments).where(eq(vaultDocuments.orgId, orgId))),
    pastContracts: await n(ctx.db.select({ id: pastContracts.id }).from(pastContracts).where(eq(pastContracts.orgId, orgId))),
    demoNotifications: await n(ctx.db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.orgId, orgId), sql`${notifications.dedupeKey} like 'demo:%'`))),
    demoActivity: await n(ctx.db.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.orgId, orgId), sql`${activityLog.meta}->>'demo' = 'true'`))),
    watchlists: (await ctx.db.select({ name: watchlists.name }).from(watchlists).where(eq(watchlists.orgId, orgId))).map((w) => w.name).sort(),
  };
};

describe('DELETE /api/demo (US4 scenarios 10, 11, 14)', () => {
  let o: Awaited<ReturnType<typeof seedOrgWithRoles>>;
  let bystander: Awaited<ReturnType<typeof signup>>;
  let userWsId: string;
  let userCommentId: string;
  let realGst: { id: string; blobKey: string };
  let demoBlobKeys: string[];
  let bystanderBefore: Awaited<ReturnType<typeof orgCounts>>;
  const deletedBlobs: string[] = [];

  beforeAll(async () => {
    o = await seedOrgWithRoles(ctx.app, 'Removal Org');
    bystander = await signup(ctx.app, { orgName: 'Removal Bystander' });
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: o.owner.cookie })).status).toBe(201);
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: bystander.cookie })).status).toBe(201);

    // Spy on the app's blob store: removal must delete exactly the demo files.
    const blobs = ctx.deps.blobs;
    const realDelete = blobs.delete.bind(blobs);
    blobs.delete = async (key: string) => { deletedBlobs.push(key); return realDelete(key); };

    // Rows the user created themselves.
    const wl = await request(ctx.app, 'POST', '/watchlists', { cookie: o.owner.cookie, json: { name: 'My laptops', criteria: { keywords: ['laptop'] } } });
    expect(wl.status).toBe(201);
    const up = await request(ctx.app, 'POST', '/vault', {
      cookie: o.analyst.cookie,
      form: { file: new File([demoPdf('Real GST', ['GSTIN: 27AAPFU0939F1ZV']) as Uint8Array<ArrayBuffer>], 'Real GST.pdf', { type: 'application/pdf' }), type: 'gst', title: 'Real GST.pdf' },
    });
    expect(up.status).toBe(201);
    const [doc] = await ctx.db.select({ id: vaultDocuments.id, blobKey: vaultDocuments.blobKey }).from(vaultDocuments).where(eq(vaultDocuments.id, up.body.id));
    realGst = doc!;
    const real = await gemLaptopTender(77);
    const ws = await request(ctx.app, 'POST', `/tenders/${real.id}/workspace`, { cookie: o.analyst.cookie });
    expect(ws.status).toBe(201);
    userWsId = ws.body.id;
    const cm = await request(ctx.app, 'POST', `/workspaces/${userWsId}/comments`, { cookie: o.analyst.cookie, json: { body: 'Real bid — keep this' } });
    expect(cm.status).toBe(201);
    userCommentId = cm.body.id;

    // A user edit on a demo row: still demo data, removed with it (spec edge case).
    const list = await request(ctx.app, 'GET', '/workspaces', { cookie: o.viewer.cookie });
    const demoWs = list.body.items.find((w: { id: string }) => w.id !== userWsId);
    expect((await request(ctx.app, 'POST', `/workspaces/${demoWs.id}/comments`, { cookie: o.analyst.cookie, json: { body: 'On a sample bid' } })).status).toBe(201);

    demoBlobKeys = (await ctx.db.select({ k: vaultDocuments.blobKey }).from(vaultDocuments)
      .where(and(eq(vaultDocuments.orgId, o.orgId), ne(vaultDocuments.id, realGst.id)))).map((r) => r.k);
    expect(demoBlobKeys).toHaveLength(15);
    bystanderBefore = await orgCounts(bystander.me.org.id);
  });

  it('requires bid manager or owner (401 / 403 / 403)', async () => {
    expect((await request(ctx.app, 'DELETE', '/demo')).status).toBe(401);
    expect((await request(ctx.app, 'DELETE', '/demo', { cookie: o.viewer.cookie })).status).toBe(403);
    expect((await request(ctx.app, 'DELETE', '/demo', { cookie: o.analyst.cookie })).status).toBe(403);
    expect((await orgCounts(o.orgId)).demoWorkspaces).toBe(16);
  });

  it('removes only the demo rows and their blobs, keeps the user’s rows, flips onboardingState.demo and logs demo.removed', async () => {
    const before = await orgCounts(o.orgId);
    expect(before).toMatchObject({ demoWorkspaces: 16, demoAnalyses: 20, vault: 16, pastContracts: 5, demoNotifications: 6 });
    expect(before.demoMatches).toBeGreaterThan(15);

    const demoTendersBefore = (await allDemoTenderIds()).length;
    expect(demoTendersBefore).toBeGreaterThanOrEqual(40);
    const r = await request(ctx.app, 'DELETE', '/demo', { cookie: o.owner.cookie });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.removed).toMatchObject({
      workspaces: 16, analyses: 20, matches: before.demoMatches, comments: 3, pastContracts: 5, vaultDocuments: 15, watchlists: 3, profileReset: true,
    });
    expect(r.body.removed.notifications).toBeGreaterThanOrEqual(6);
    expect(r.body.removed.activity).toBeGreaterThanOrEqual(before.demoActivity);

    const after = await orgCounts(o.orgId);
    expect(after).toMatchObject({ workspaces: 1, demoWorkspaces: 0, demoAnalyses: 0, demoMatches: 0, vault: 1, pastContracts: 0, demoNotifications: 0, demoActivity: 0, watchlists: ['My laptops'] });
    // Nothing left that points at a demo workspace or tender.
    const ids = await allDemoTenderIds();
    expect(ids).toHaveLength(demoTendersBefore); // demo tenders are global and stay
    const notes = await ctx.db.select({ link: notifications.link }).from(notifications).where(eq(notifications.orgId, o.orgId));
    expect(notes.filter((n) => ids.some((id) => n.link === `/tenders/${id}`))).toHaveLength(0);
    expect(notes.filter((n) => n.link?.startsWith('/workspaces/') && n.link !== `/workspaces/${userWsId}`)).toHaveLength(0);

    // The user's own rows are intact.
    const [ws] = await ctx.db.select({ id: bidWorkspaces.id }).from(bidWorkspaces).where(eq(bidWorkspaces.orgId, o.orgId));
    expect(ws!.id).toBe(userWsId);
    expect((await ctx.db.select({ id: comments.id }).from(comments).where(eq(comments.orgId, o.orgId))).map((c) => c.id)).toEqual([userCommentId]);
    const vault = await request(ctx.app, 'GET', '/vault', { cookie: o.viewer.cookie });
    expect(vault.body.items.map((d: { fileName: string }) => d.fileName)).toEqual(['Real GST.pdf']);
    const dl = await request(ctx.app, 'GET', `/vault/${realGst.id}/download`, { cookie: o.viewer.cookie });
    expect(dl.status).toBe(200);

    // Blobs: every demo file deleted (after commit), the user's file untouched, no other org's file touched.
    expect([...deletedBlobs].sort()).toEqual(expect.arrayContaining([...demoBlobKeys].sort()));
    expect(deletedBlobs).not.toContain(realGst.blobKey);
    expect(deletedBlobs.every((k) => !k.includes(bystander.me.org.id))).toBe(true);
    for (const k of demoBlobKeys) expect(await ctx.deps.blobs.get(k)).toBeNull();

    // Org state + audit trail.
    const me = await request(ctx.app, 'GET', '/auth/me', { cookie: o.owner.cookie });
    expect(me.body.org.onboardingState.demo).toBe(false);
    const [removed] = await ctx.db.select().from(activityLog).where(and(eq(activityLog.orgId, o.orgId), eq(activityLog.action, 'demo.removed')));
    expect(removed).toBeTruthy();
    expect(removed!.userId).toBe(o.owner.me.user.id);
    expect((removed!.meta as Record<string, unknown>).demo).toBeUndefined();

    // US4-14: the profile still held the demo company → reset to empty.
    const profile = await request(ctx.app, 'GET', '/profile', { cookie: o.viewer.cookie });
    expect(profile.body.profile.legalName).toBe('');
    expect(profile.body.profile.gstin ?? null).toBeNull();

    // The pipeline and dashboard reflect it.
    expect((await request(ctx.app, 'GET', '/workspaces', { cookie: o.viewer.cookie })).body.total).toBe(1);
    const dash = await request(ctx.app, 'GET', '/dashboard', { cookie: o.owner.cookie });
    expect(dash.body.demo).toBe(false);
  });

  it('leaves another demo org untouched', async () => {
    expect(await orgCounts(bystander.me.org.id)).toEqual(bystanderBefore);
    const me = await request(ctx.app, 'GET', '/auth/me', { cookie: bystander.cookie });
    expect(me.body.org.onboardingState.demo).toBe(true);
    const [p] = await ctx.db.select({ legalName: companyProfiles.legalName }).from(companyProfiles).where(eq(companyProfiles.orgId, bystander.me.org.id));
    expect(p!.legalName).toBe(DEMO_COMPANY.legalName);
  });

  it('is idempotent — a second call answers 200 with all counts 0', async () => {
    deletedBlobs.length = 0;
    const r = await request(ctx.app, 'DELETE', '/demo', { cookie: o.bidManager.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      removed: { workspaces: 0, analyses: 0, matches: 0, comments: 0, notifications: 0, activity: 0, pastContracts: 0, vaultDocuments: 0, watchlists: 0, profileReset: false },
    });
    expect(deletedBlobs).toEqual([]);
    expect((await orgCounts(o.orgId)).watchlists).toEqual(['My laptops']);
    // NB-2: a removal that removed nothing logs nothing — still exactly one audit entry.
    expect(await ctx.db.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.orgId, o.orgId), eq(activityLog.action, 'demo.removed')))).toHaveLength(1);
  });

  it('the demo can be loaded again after removal', async () => {
    const r = await request(ctx.app, 'POST', '/demo/seed', { cookie: o.owner.cookie });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: true, workspaces: 17, vaultDocuments: 16 });
    expect((await orgCounts(o.orgId)).watchlists).toEqual([...DEMO_WATCHLISTS.map((w) => w.name), 'My laptops'].sort());
  });
});

describe('DELETE /api/demo — watchlist provenance (FR-065: user watchlists with a demo name survive)', () => {
  const [W0, W1, W2] = DEMO_WATCHLISTS.map((w) => w.name) as [string, string, string];
  const wlOf = async (orgId: string) => ctx.db.select({ id: watchlists.id, name: watchlists.name }).from(watchlists).where(eq(watchlists.orgId, orgId));
  const create = async (cookie: string, name: string) => {
    const r = await request(ctx.app, 'POST', '/watchlists', { cookie, json: { name, criteria: { keywords: ['laptop'] } } });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };

  it('removes only the watchlists the seed inserted — across a repeat seed and a second seed → remove cycle', async () => {
    const owner = await signup(ctx.app, { orgName: 'Watchlist Provenance Org' });
    const orgId = owner.me.org.id;
    // 1. Before seeding, the user makes a watchlist with a demo name: the seed skips that name.
    const userW0 = await create(owner.cookie, W0);
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: owner.cookie })).status).toBe(201);
    const seeded = await wlOf(orgId);
    expect(seeded.map((w) => w.name).sort()).toEqual([W0, W1, W2].sort());
    expect(seeded.find((w) => w.name === W0)!.id).toBe(userW0);
    // 2. The user deletes the demo W1 and re-creates one with the same name.
    const demoW1 = seeded.find((w) => w.name === W1)!.id;
    expect((await request(ctx.app, 'DELETE', `/watchlists/${demoW1}`, { cookie: owner.cookie })).status).toBeLessThan(300);
    const userW1 = await create(owner.cookie, W1);
    // 3. The user deletes the demo W2; a repeat seed re-creates it (recorded) and skips the user's W0 / W1.
    const demoW2 = seeded.find((w) => w.name === W2)!.id;
    expect((await request(ctx.app, 'DELETE', `/watchlists/${demoW2}`, { cookie: owner.cookie })).status).toBeLessThan(300);
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: owner.cookie })).status).toBe(200); // repeat seed
    const reseededW2 = (await wlOf(orgId)).find((w) => w.name === W2)!.id;
    expect(reseededW2).not.toBe(demoW2);
    const [marker] = await ctx.db.select({ meta: activityLog.meta }).from(activityLog).where(and(eq(activityLog.orgId, orgId), eq(activityLog.action, 'demo.seeded')));
    expect([...((marker!.meta as { watchlistIds: string[] }).watchlistIds)].sort()).toEqual([demoW1, demoW2, reseededW2].sort());

    const r = await request(ctx.app, 'DELETE', '/demo', { cookie: owner.cookie });
    expect(r.status).toBe(200);
    expect(r.body.removed.watchlists).toBe(1);
    expect((await wlOf(orgId)).map((w) => w.id).sort()).toEqual([userW0, userW1].sort());

    // 4. Second cycle: the seed adds only W2 (W0/W1 are the user's names); removal takes only that one again.
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: owner.cookie })).status).toBe(201);
    expect((await wlOf(orgId)).map((w) => w.name).sort()).toEqual([W0, W1, W2].sort());
    const r2 = await request(ctx.app, 'DELETE', '/demo', { cookie: owner.cookie });
    expect(r2.body.removed.watchlists).toBe(1);
    expect((await wlOf(orgId)).map((w) => w.id).sort()).toEqual([userW0, userW1].sort());
    const r3 = await request(ctx.app, 'DELETE', '/demo', { cookie: owner.cookie });
    expect(r3.body.removed.watchlists).toBe(0);
    expect((await wlOf(orgId)).map((w) => w.id).sort()).toEqual([userW0, userW1].sort());
  });

  it('legacy orgs (demo.seeded without recorded ids) fall back to the seeder fingerprint and still keep a re-created user watchlist', async () => {
    const owner = await signup(ctx.app, { orgName: 'Legacy Watchlist Org' });
    const orgId = owner.me.org.id;
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: owner.cookie })).status).toBe(201);
    // Simulate a seed by the previous code: the marker has no watchlistIds.
    await ctx.db.update(activityLog).set({ meta: sql`${activityLog.meta} - 'watchlistIds'` })
      .where(and(eq(activityLog.orgId, orgId), eq(activityLog.action, 'demo.seeded')));
    const demoW0 = (await wlOf(orgId)).find((w) => w.name === W0)!.id;
    expect((await request(ctx.app, 'DELETE', `/watchlists/${demoW0}`, { cookie: owner.cookie })).status).toBeLessThan(300);
    const userW0 = await create(owner.cookie, W0); // same creator as the seeder, same name — but no 16-day back-dating
    const r = await request(ctx.app, 'DELETE', '/demo', { cookie: owner.cookie });
    expect(r.body.removed.watchlists).toBe(2);
    expect((await wlOf(orgId)).map((w) => w.id)).toEqual([userW0]);
  });

  it('a repeat seed on a legacy marker backfills its ids before appending', async () => {
    const owner = await signup(ctx.app, { orgName: 'Legacy Backfill Org' });
    const orgId = owner.me.org.id;
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: owner.cookie })).status).toBe(201);
    await ctx.db.update(activityLog).set({ meta: sql`${activityLog.meta} - 'watchlistIds'` })
      .where(and(eq(activityLog.orgId, orgId), eq(activityLog.action, 'demo.seeded')));
    const before = await wlOf(orgId);
    const demoW2 = before.find((w) => w.name === W2)!.id;
    expect((await request(ctx.app, 'DELETE', `/watchlists/${demoW2}`, { cookie: owner.cookie })).status).toBeLessThan(300);
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: owner.cookie })).status).toBe(200); // repeat seed
    const after = await wlOf(orgId);
    const [marker] = await ctx.db.select({ meta: activityLog.meta }).from(activityLog).where(and(eq(activityLog.orgId, orgId), eq(activityLog.action, 'demo.seeded')));
    expect([...((marker!.meta as { watchlistIds: string[] }).watchlistIds)].sort()).toEqual(after.map((w) => w.id).sort());
    expect((await request(ctx.app, 'DELETE', '/demo', { cookie: owner.cookie })).body.removed.watchlists).toBe(3);
  });
});

describe('removeDemo (library; US4 scenario 14)', () => {
  it('keeps a profile the user edited away from the demo values, unlinking demo documents from it', async () => {
    const owner = await signup(ctx.app, { orgName: 'Edited Profile Org' });
    const orgId = owner.me.org.id;
    await seedDemo(ctx.db, { orgId, userId: owner.me.user.id, now: NOW });
    await ctx.db.update(companyProfiles).set({ legalName: 'Aarav Technologies (Real) LLP' }).where(eq(companyProfiles.orgId, orgId));
    // A real past contract that points at a demo CRAC must survive with the link cleared.
    const [crac] = await ctx.db.select({ id: vaultDocuments.id }).from(vaultDocuments).where(and(eq(vaultDocuments.orgId, orgId), eq(vaultDocuments.type, 'crac')));
    await ctx.db.insert(pastContracts).values({ orgId, buyer: 'NIC', title: 'Real contract', value: 100_000, gemContractNo: 'GEMC-REAL-1', cracDocumentId: crac!.id });

    const r = await removeDemo(ctx.db, { orgId }); // no blob store: metadata only
    expect(r).toMatchObject({ workspaces: 16, vaultDocuments: 15, pastContracts: 5, watchlists: 3, profileReset: false });
    const [p] = await ctx.db.select().from(companyProfiles).where(eq(companyProfiles.orgId, orgId));
    expect(p!.legalName).toBe('Aarav Technologies (Real) LLP');
    expect(p!.oemAuthorizations.every((x) => !x.documentId)).toBe(true);
    const pcs = await ctx.db.select().from(pastContracts).where(eq(pastContracts.orgId, orgId));
    expect(pcs.map((x) => [x.gemContractNo, x.cracDocumentId])).toEqual([['GEMC-REAL-1', null]]);
  });

  it('passes blob keys to the given store only after the rows are gone', async () => {
    const owner = await signup(ctx.app, { orgName: 'Spy Blob Org' });
    const orgId = owner.me.org.id;
    await seedDemo(ctx.db, { orgId, userId: owner.me.user.id, now: NOW, blobs: ctx.deps.blobs });
    const seen: { key: string; rowsLeft: number }[] = [];
    const spy = {
      delete: async (key: string) => {
        const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(vaultDocuments).where(eq(vaultDocuments.blobKey, key)) as [{ n: number }];
        seen.push({ key, rowsLeft: n });
      },
    };
    const r = await removeDemo(ctx.db, { orgId, blobs: spy });
    expect(r.vaultDocuments).toBe(15);
    expect(seen).toHaveLength(15);
    expect(seen.every((s) => s.rowsLeft === 0 && s.key.startsWith(`org/${orgId}/vault/demo-`))).toBe(true);
  });
});

describe('isDemo on tender DTOs (007/FR-067, US4-13)', () => {
  it('flags demo tenders in the list and detail, and only those; raw stays hidden', async () => {
    const owner = await signup(ctx.app, { orgName: 'Sample Badge Org' });
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: owner.cookie })).status).toBe(201);
    const [real] = await ctx.db.insert(tenders).values({
      bidNumber: 'GEM/2026/B/9900001', sourceUrl: 'https://bidplus.gem.gov.in/bid/9900001', title: 'Real live bid for isDemo check', items: [], status: 'open',
      endAt: new Date(NOW.getTime() + 5 * 86_400_000), raw: {}, contentHash: 'isdemo-real-1',
    }).returning();
    const list = await request(ctx.app, 'GET', '/tenders?pageSize=100&status=all', { cookie: owner.cookie });
    expect(list.status).toBe(200);
    const items = list.body.items as { id: string; bidNumber: string; isDemo: boolean }[];
    expect(items.length).toBeGreaterThan(30);
    expect(items.filter((t) => t.isDemo).length).toBeGreaterThanOrEqual(30);
    expect(items.find((t) => t.id === real!.id)).toMatchObject({ isDemo: false });
    for (const t of items) expect(t).not.toHaveProperty('raw');

    const demoItem = items.find((t) => t.isDemo)!;
    const demoDetail = await request(ctx.app, 'GET', `/tenders/${demoItem.id}`, { cookie: owner.cookie });
    expect(demoDetail.body).toMatchObject({ id: demoItem.id, isDemo: true });
    expect(demoDetail.body).not.toHaveProperty('raw');
    const realDetail = await request(ctx.app, 'GET', `/tenders/${real!.id}`, { cookie: owner.cookie });
    expect(realDetail.body).toMatchObject({ isDemo: false });
  });
});

describe('demo tender dates are relative to now (planTenders)', () => {
  const IST = 330 * 60_000;
  const istDayEnd = (t: number) => Math.floor((t + IST) / 86_400_000) * 86_400_000 - IST + 86_400_000;

  // US1-4 / US1-6 (007) failed in the evening: +5 h / +9 h from 19:05 IST is after IST midnight, so closingToday was 0.
  it.each(['00:10', '03:00', '09:30', '15:00', '19:05', '22:30', '23:30'])('two tenders close later today (IST) when loaded at %s IST', (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const now = new Date(Date.UTC(2026, 10, 5, h!, m!) - IST);
    const plan = planTenders(now);
    const today = plan.filter((t) => t.endAt.getTime() > now.getTime() && t.endAt.getTime() < istDayEnd(now.getTime()));
    const closingToday = [plan[6]!, plan[7]!];
    for (const t of closingToday) {
      expect(t.endAt.getTime(), `tender ${t.idx} closes after load time`).toBeGreaterThan(now.getTime());
      expect(t.endAt.getTime(), `tender ${t.idx} closes before IST midnight`).toBeLessThan(istDayEnd(now.getTime()));
    }
    expect(closingToday[0]!.endAt.getTime()).toBeLessThan(closingToday[1]!.endAt.getTime());
    expect(today.length).toBeGreaterThanOrEqual(2);
    // The "this week" tenders and closed history are unaffected by the clamp.
    expect(plan[8]!.endAt.getTime() - now.getTime()).toBeGreaterThan(24 * 3_600_000);
    expect(plan[0]!.endAt.getTime()).toBeLessThan(now.getTime());
  });
});
