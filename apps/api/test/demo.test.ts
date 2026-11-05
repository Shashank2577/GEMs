/** Demo seed (T075; US7): POST /api/demo/seed, idempotency, tenancy, generated PDFs, role checks. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { analyses, bidWorkspaces, companyProfiles, tenders, vaultDocuments } from '@tp/db';
import { seedDemo, demoPdf, DEMO_COMPANY } from '@tp/db/demo';
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
