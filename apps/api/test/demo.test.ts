/** Demo seed (T075; US7): POST /api/demo/seed, idempotency, tenancy, generated PDFs, role checks. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { analyses, bidWorkspaces, comments, companyProfiles, notifications, organizations, tenderDocuments, tenderMatches, tenders, vaultDocuments, watchlists } from '@tp/db';
import { seedDemo, demoPdf, demoBidNumber, DEMO_COMPANY } from '@tp/db/demo';
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
    for (const stmt of readFileSync(fileURLToPath(new URL('../../../packages/db/migrations/0009_demo_source_datafix.sql', import.meta.url)), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.replace(/--.*$/gm, '').trim()) await ctx.db.execute(sql.raw(stmt));
    }
    expect(await ctx.db.select().from(tenders).where(eq(tenders.id, copy!.id))).toHaveLength(0);
    expect((await ctx.db.select().from(tenders).where(and(eq(tenders.source, 'demo'), eq(tenders.bidNumber, bid)))).length).toBe(1);
  });
});

describe('008/T047 data-fix migration 0009_demo_source_datafix (US3 scenario 3)', () => {
  const MIGRATION = fileURLToPath(new URL('../../../packages/db/migrations/0009_demo_source_datafix.sql', import.meta.url));
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
