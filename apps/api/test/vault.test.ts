/** Profile & Vault API (T055; FR-020–FR-022, US3 acceptance 1–4). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { activityLog, companyProfiles, notifications, vaultDocuments, vaultDocumentVersions } from '@tp/db';
import { createApp } from '../src/app';
import { contentDisposition, safeFileName } from '../src/routes/vault';
import type { AppDeps } from '../src/deps';
import { runExpiryReminders } from '../src/services/reminders';
import { createTestContext, request, seedOrgWithRoles, signup, type TestContext } from './helpers';

// 4 Nov 2026 10:00 IST
const NOW = new Date('2026-11-04T04:30:00Z');

/** Every call yields distinct bytes (FR-067 duplicate detection would otherwise reject same-second fixtures). */
let pdfSeq = 0;
async function pdf(pages = 2): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.setSubject(`fixture ${++pdfSeq}`);
  for (let i = 0; i < pages; i++) d.addPage([200, 200]).drawText(`Page ${i + 1}`, { x: 20, y: 100 });
  return d.save();
}
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const file = (bytes: Uint8Array, name: string, type = 'application/pdf') => new File([bytes as BlobPart], name, { type });

let ctx: TestContext;
let org: Awaited<ReturnType<typeof seedOrgWithRoles>>;

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW });
  org = await seedOrgWithRoles(ctx.app);
});
afterAll(() => ctx?.close());

describe('profile', () => {
  it('returns an empty profile with low completeness', async () => {
    const r = await request(ctx.app, 'GET', '/profile', { cookie: org.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.body.profile.legalName).toBe('');
    expect(r.body.completeness).toBeLessThan(10);
    expect(r.body.issues[0].severity).toBe('error');
  });

  it('explains invalid GSTIN / PAN inline (acceptance 3)', async () => {
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { gstin: '27AAPFU0939F1ZA', pan: 'AAPXU0939F', pincode: '01234' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    expect(r.body.error.details.fields.gstin).toMatch(/check character/);
    expect(r.body.error.details.fields.pan).toMatch(/4th character/);
    expect(r.body.error.details.fields.pincode).toBeTruthy();
  });

  it('upserts, normalises and merges partial updates', async () => {
    const r = await request(ctx.app, 'PUT', '/profile', {
      cookie: org.analyst.cookie,
      json: {
        legalName: 'Sharma Infotech Pvt Ltd', gstin: '27aapfu0939f1zv', pan: 'AAPFU0939F', contactPhone: '98123 45678', mseCategory: 'small',
        udyamNumber: 'udyam-mh-26-0123456', miiClass: 'class_1', localContentPct: 60,
        financials: [{ fy: '2025-26', turnover: 6_00_00_000 }, { fy: 'FY 2024-2025', turnover: 4_50_00_000 }, { fy: '2023-24', turnover: 3_00_00_000 }],
        categories: ['Laptops'], operatingStates: ['Maharashtra', 'Goa'],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.profile.gstin).toBe('27AAPFU0939F1ZV');
    expect(r.body.profile.udyamNumber).toBe('UDYAM-MH-26-0123456');
    expect(r.body.profile.contactPhone).toBe('+919812345678');
    expect(r.body.profile.financials[1].fy).toBe('2024-25');
    expect(r.body.averageTurnover).toEqual({ avg: 4_50_00_000, years: ['2025-26', '2024-25', '2023-24'] });
    const before = r.body.completeness;

    const r2 = await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { signatoryName: 'Ravi Sharma', signatoryDesignation: 'Director' } });
    expect(r2.status).toBe(200);
    expect(r2.body.profile.legalName).toBe('Sharma Infotech Pvt Ltd');
    expect(r2.body.completeness).toBeGreaterThan(before);
  });

  it('rejects a PAN that does not match the stored GSTIN', async () => {
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { pan: 'AAACI1681G' } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.fields.pan).toMatch(/AAPFU0939F/);
  });

  // T013 — remaining profile rules (FR-003, FR-006, FR-007, FR-008)
  /** Each order-sensitive test seeds the fields it relies on (no expectedUpdatedAt → last write wins). */
  const seedProfile = async (o = org) => {
    const r = await request(ctx.app, 'PUT', '/profile', {
      cookie: o.analyst.cookie,
      json: { legalName: 'Sharma Infotech Pvt Ltd', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F', miiClass: 'class_1', localContentPct: 60, tradeName: 'Sharma IT' },
    });
    expect(r.status).toBe(200);
    return r.body.profile as { updatedAt: string };
  };

  it.each(['+91 98123-45678', '09812345678', '919812345678'])('normalises phone %s to E.164 (FR-006)', async (phone) => {
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { contactPhone: phone } });
    expect(r.status).toBe(200);
    expect(r.body.profile.contactPhone).toBe('+919812345678');
  });

  it('rejects a 3-digit HSN code (FR-008)', async () => {
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { hsnCodes: ['847'] } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    expect(r.body.error.details.fields['hsnCodes.0']).toBe('HSN/SAC codes have 4, 6 or 8 digits');
  });

  it('rejects Class-II with 55% local content (FR-007)', async () => {
    await seedProfile();
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { miiClass: 'class_2', localContentPct: 55 } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.fields.localContentPct).toBe('Class-II means 20% to under 50% local content');
    expect((await request(ctx.app, 'GET', '/profile', { cookie: org.viewer.cookie })).body.profile.miiClass).toBe('class_1');
  });

  it('rejects an invalid contact email (FR-006)', async () => {
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { contactEmail: 'bids@' } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.fields.contactEmail).toBe('Enter a valid email address');
  });

  it('requires sign-in to read the profile', async () => {
    const r = await request(ctx.app, 'GET', '/profile');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthorized');
  });

  it('logs profile.updated with only the keys that were sent (FR-003)', async () => {
    await seedProfile();
    const where = and(eq(activityLog.orgId, org.orgId), eq(activityLog.action, 'profile.updated'));
    const before = new Set((await ctx.db.select({ id: activityLog.id }).from(activityLog).where(where)).map((a) => a.id));
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { tradeName: 'Sharma IT', contactEmail: 'Bids@Sharma.in' } });
    expect(r.status).toBe(200);
    expect(r.body.profile.contactEmail).toBe('bids@sharma.in');
    expect(r.body.profile.legalName).toBe('Sharma Infotech Pvt Ltd');
    const added = (await ctx.db.select().from(activityLog).where(where)).filter((a) => !before.has(a.id));
    expect(added).toHaveLength(1);
    expect(((added[0]!.meta as { fields: string[] }).fields).sort()).toEqual(['contactEmail', 'tradeName']);
  });

  // T020 — optimistic concurrency (FR-014)
  it('saves when expectedUpdatedAt matches and answers 409 when someone else saved in between', async () => {
    try {
      const loaded = (await seedProfile()).updatedAt;
      expect(loaded).toBeTruthy();
      // A saves on top of the version both loaded → 200, and the activity log does not record expectedUpdatedAt as a field.
      ctx.clock.set('2026-11-04T09:15:00Z'); // 2:45 PM IST
      const a = await request(ctx.app, 'PUT', '/profile', { cookie: org.owner.cookie, json: { tradeName: 'Sharma IT Solutions', expectedUpdatedAt: loaded } });
      expect(a.status).toBe(200);
      expect(a.body.profile.updatedAt).toBe('2026-11-04T09:15:00.000Z');
      const [lastLog] = await ctx.db.select().from(activityLog).where(and(eq(activityLog.orgId, org.orgId), eq(activityLog.action, 'profile.updated'))).orderBy(desc(activityLog.createdAt)).limit(1);
      expect((lastLog!.meta as { fields: string[] }).fields).toEqual(['tradeName']);
      // B still holds the older copy → 409, nothing of B's is stored.
      ctx.clock.set('2026-11-04T09:20:00Z');
      const b = await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { tradeName: 'Stale edit', expectedUpdatedAt: loaded } });
      expect(b.status).toBe(409);
      expect(b.body.error.code).toBe('conflict');
      expect(b.body.error.message).toBe('Someone else saved the profile at 4 Nov 2026, 2:45 PM IST. Reload to see their changes.');
      expect(b.body.error.details).toEqual({ updatedAt: '2026-11-04T09:15:00.000Z' });
      const after = (await request(ctx.app, 'GET', '/profile', { cookie: org.viewer.cookie })).body.profile;
      expect(after.tradeName).toBe('Sharma IT Solutions');
      expect(after.updatedAt).toBe('2026-11-04T09:15:00.000Z');
      // null means "no profile saved yet" and therefore also conflicts with an existing row.
      const n = await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { tradeName: 'X', expectedUpdatedAt: null } });
      expect(n.status).toBe(409);
      expect(n.body.error.details.updatedAt).toBe('2026-11-04T09:15:00.000Z');
      // After reloading, B can save; omitting expectedUpdatedAt keeps last-write-wins for older clients.
      const b2 = await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { tradeName: 'Sharma IT', expectedUpdatedAt: after.updatedAt } });
      expect(b2.status).toBe(200);
      expect((await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { tradeName: 'Sharma IT' } })).status).toBe(200);
      const bad = await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { expectedUpdatedAt: 'yesterday' } });
      expect(bad.status).toBe(400);
    } finally {
      ctx.clock.set(NOW);
    }
  });

  it('expectedUpdatedAt: null saves the first profile of a fresh org', async () => {
    const fresh = await seedOrgWithRoles(ctx.app, 'Fresh Traders');
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: fresh.analyst.cookie, json: { legalName: 'Fresh Traders', expectedUpdatedAt: null } });
    expect(r.status).toBe(200);
    expect(r.body.profile.updatedAt).toBe(NOW.toISOString());
  });

  it('two concurrent saves of the same version: exactly one wins (row lock, FR-014)', async () => {
    const race = await seedOrgWithRoles(ctx.app, 'Race Existing');
    const base = await seedProfile(race);
    const results = await Promise.all(['A', 'B'].map((who) =>
      request(ctx.app, 'PUT', '/profile', { cookie: (who === 'A' ? race.owner : race.analyst).cookie, json: { tradeName: `Saved by ${who}`, expectedUpdatedAt: base.updatedAt } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    const stored = (await request(ctx.app, 'GET', '/profile', { cookie: race.viewer.cookie })).body.profile;
    expect(stored.tradeName).toBe(winner.body.profile.tradeName);
  });

  it('two concurrent first saves of a fresh org: exactly one wins', async () => {
    const race = await seedOrgWithRoles(ctx.app, 'Race Fresh');
    const results = await Promise.all(['A', 'B'].map((who) =>
      request(ctx.app, 'PUT', '/profile', { cookie: (who === 'A' ? race.owner : race.analyst).cookie, json: { legalName: `Saved by ${who}`, expectedUpdatedAt: null } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.error.details.updatedAt).toBe(NOW.toISOString());
  });

  it('compares at millisecond precision when updated_at has microseconds (e.g. set by SQL now())', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'Precise Co');
    await seedProfile(o);
    await ctx.db.execute(sql`update company_profiles set updated_at = '2026-11-04 04:30:00.123456+00'::timestamptz where org_id = ${o.orgId}`);
    const loaded = (await request(ctx.app, 'GET', '/profile', { cookie: o.analyst.cookie })).body.profile.updatedAt;
    expect(loaded).toBe('2026-11-04T04:30:00.123Z');
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: o.analyst.cookie, json: { tradeName: 'Precise', expectedUpdatedAt: loaded } });
    expect(r.status).toBe(200);
    // …and with a real now() timestamp.
    await ctx.db.execute(sql`update company_profiles set updated_at = now() where org_id = ${o.orgId}`);
    const loaded2 = (await request(ctx.app, 'GET', '/profile', { cookie: o.analyst.cookie })).body.profile.updatedAt;
    expect((await request(ctx.app, 'PUT', '/profile', { cookie: o.analyst.cookie, json: { tradeName: 'Precise 2', expectedUpdatedAt: loaded2 } })).status).toBe(200);
  });

  it('viewer cannot edit the profile', async () => {
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: org.viewer.cookie, json: { legalName: 'X' } });
    expect(r.status).toBe(403);
  });

  it('past contracts CRUD', async () => {
    const c = await request(ctx.app, 'POST', '/past-contracts', {
      cookie: org.analyst.cookie, json: { buyer: 'NIC, MeitY', title: 'Supply of 200 laptops', value: 1_20_00_000, startDate: '2024-04-01', endDate: '2024-09-30' },
    });
    expect(c.status).toBe(201);
    expect(c.body.buyerType).toBe('central');
    const bad = await request(ctx.app, 'POST', '/past-contracts', { cookie: org.analyst.cookie, json: { buyer: 'X', title: 'Y', value: 0, startDate: '2024-04-01', endDate: '2023-01-01' } });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details.fields)).toEqual(expect.arrayContaining(['value', 'endDate']));
    const p = await request(ctx.app, 'PATCH', `/past-contracts/${c.body.id}`, { cookie: org.analyst.cookie, json: { value: 1_50_00_000 } });
    expect(p.status).toBe(200);
    expect(p.body.value).toBe(1_50_00_000);
    const l = await request(ctx.app, 'GET', '/past-contracts', { cookie: org.viewer.cookie });
    expect(l.body.total).toBe(1);
    expect((await request(ctx.app, 'DELETE', `/past-contracts/${c.body.id}`, { cookie: org.viewer.cookie })).status).toBe(403);
    expect((await request(ctx.app, 'DELETE', `/past-contracts/${c.body.id}`, { cookie: org.analyst.cookie })).status).toBe(200);
    expect((await request(ctx.app, 'DELETE', `/past-contracts/${c.body.id}`, { cookie: org.analyst.cookie })).status).toBe(404);
  });
});

describe('vault', () => {
  let gstId: string;
  let isoId: string;

  it('uploads a PDF with no expiry → valid (acceptance 1), guessing type and counting pages', async () => {
    const bytes = await pdf(3);
    const r = await request(ctx.app, 'POST', '/vault', { cookie: org.analyst.cookie, form: { file: file(bytes, 'GST_REG06 Certificate.pdf'), number: '27AAPFU0939F1ZV', tags: '["statutory"]' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'gst', title: 'GST REG06 Certificate', status: 'valid', daysToExpiry: null, pageCount: 3, mimeType: 'application/pdf', tags: ['statutory'] });
    expect(r.body.uploadedBy.name).toBeTruthy();
    gstId = r.body.id;
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, gstId));
    expect(row!.blobKey).toBe(`org/${org.orgId}/vault/${gstId}/GST_REG06 Certificate.pdf`);
  });

  it('download round-trips the bytes', async () => {
    const bytes = await pdf(1);
    const up = await request(ctx.app, 'POST', '/vault', { cookie: org.analyst.cookie, form: { file: file(bytes, 'pan.pdf'), type: 'pan', title: 'Company PAN' } });
    const r = await request(ctx.app, 'GET', `/vault/${up.body.id}/download`, { cookie: org.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="pan.pdf"/);
    expect(new Uint8Array(await r.res.arrayBuffer())).toEqual(bytes);
    const inline = await request(ctx.app, 'GET', `/vault/${up.body.id}/download?inline=1`, { cookie: org.viewer.cookie });
    expect(inline.headers.get('content-disposition')).toMatch(/^inline/);
  });

  it('ISO expiring in 10 days → expiring (acceptance 2); PNG accepted', async () => {
    const r = await request(ctx.app, 'POST', '/vault', {
      cookie: org.analyst.cookie, form: { file: file(PNG, 'iso.png', 'image/png'), type: 'iso', title: 'ISO 9001:2015', issueDate: '2023-11-14', expiryDate: '2026-11-14' },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'expiring', daysToExpiry: 10, mimeType: 'image/png', fileName: 'iso.png' });
    isoId = r.body.id;
    const old = await request(ctx.app, 'POST', '/vault', { cookie: org.analyst.cookie, form: { file: file(await pdf(), 'oem.pdf'), type: 'oem_authorization', title: 'Dell MAF', expiryDate: '2026-10-01' } });
    expect(old.body.status).toBe('expired');
  });

  it('rejects bad uploads', async () => {
    const txt = await request(ctx.app, 'POST', '/vault', { cookie: org.analyst.cookie, form: { file: file(new TextEncoder().encode('hello'), 'a.pdf') } });
    expect(txt.status).toBe(415);
    const broken = await request(ctx.app, 'POST', '/vault', { cookie: org.analyst.cookie, form: { file: file(new TextEncoder().encode('%PDF-1.7 garbage'), 'b.pdf') } });
    expect(broken.status).toBe(422);
    const big = new Uint8Array(20 * 1024 * 1024 + 10); big.set([0x25, 0x50, 0x44, 0x46]);
    const tooBig = await request(ctx.app, 'POST', '/vault', { cookie: org.analyst.cookie, form: { file: file(big, 'big.pdf') } });
    expect(tooBig.status).toBe(413);
    const noFile = await request(ctx.app, 'POST', '/vault', { cookie: org.analyst.cookie, form: { type: 'gst' } });
    expect(noFile.status).toBe(400);
    const badDates = await request(ctx.app, 'POST', '/vault', { cookie: org.analyst.cookie, form: { file: file(await pdf(), 'x.pdf'), issueDate: '2025-01-01', expiryDate: '2024-01-01' } });
    expect(badDates.status).toBe(400);
    expect(badDates.body.error.details.fields.expiryDate).toBeTruthy();
  });

  it('lists with filters, search and sort', async () => {
    const all = await request(ctx.app, 'GET', '/vault', { cookie: org.viewer.cookie });
    expect(all.body.total).toBe(4);
    expect((await request(ctx.app, 'GET', '/vault?status=expiring', { cookie: org.viewer.cookie })).body.items.map((d: any) => d.id)).toEqual([isoId]);
    expect((await request(ctx.app, 'GET', '/vault?type=gst', { cookie: org.viewer.cookie })).body.total).toBe(1);
    expect((await request(ctx.app, 'GET', '/vault?category=Quality', { cookie: org.viewer.cookie })).body.total).toBe(1);
    expect((await request(ctx.app, 'GET', '/vault?q=statutory', { cookie: org.viewer.cookie })).body.items[0].id).toBe(gstId);
    expect((await request(ctx.app, 'GET', '/vault?q=27AAPFU', { cookie: org.viewer.cookie })).body.total).toBe(1);
    const byExpiry = await request(ctx.app, 'GET', '/vault?sort=expiry', { cookie: org.viewer.cookie });
    expect(byExpiry.body.items[0].status).toBe('expired');
    expect((await request(ctx.app, 'GET', '/vault?status=bogus', { cookie: org.viewer.cookie })).status).toBe(400);
  });

  it('summary', async () => {
    const r = await request(ctx.app, 'GET', '/vault/summary', { cookie: org.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 4, valid: 2, expiring: 1, expired: 1, byType: { gst: 1, pan: 1, iso: 1, oem_authorization: 1 } });
    expect(r.body.nextExpiries.map((e: any) => e.id)).toEqual([isoId]); // Dell MAF expired 34 days ago: out of the window
    expect(r.body.missingCommon).toContain('udyam');
    expect(r.body.missingCommon).not.toContain('gst');
  });

  it('patch updates metadata and resets reminders when expiry changes', async () => {
    await ctx.db.update(vaultDocuments).set({ lastReminderDays: 30 }).where(eq(vaultDocuments.id, isoId));
    const r = await request(ctx.app, 'PATCH', `/vault/${isoId}`, { cookie: org.analyst.cookie, json: { expiryDate: '2029-11-13', number: 'QMS-123' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'valid', number: 'QMS-123' });
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, isoId));
    expect(row!.lastReminderDays).toBeNull();
    const bad = await request(ctx.app, 'PATCH', `/vault/${isoId}`, { cookie: org.analyst.cookie, json: { expiryDate: '2020-01-01' } });
    expect(bad.status).toBe(400);
    // restore for the reminder test
    await request(ctx.app, 'PATCH', `/vault/${isoId}`, { cookie: org.analyst.cookie, json: { expiryDate: '2026-11-14' } });
  });

  it('replaces the file', async () => {
    const bytes = await pdf(5);
    const r = await request(ctx.app, 'PUT', `/vault/${gstId}/file`, { cookie: org.analyst.cookie, form: { file: file(bytes, 'gst-new.pdf') } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ fileName: 'gst-new.pdf', pageCount: 5, type: 'gst' });
    const d = await request(ctx.app, 'GET', `/vault/${gstId}/download`, { cookie: org.viewer.cookie });
    expect(new Uint8Array(await d.res.arrayBuffer())).toEqual(bytes);
  });

  it('viewer is refused upload, edit and delete (acceptance 4)', async () => {
    const up = await request(ctx.app, 'POST', '/vault', { cookie: org.viewer.cookie, form: { file: file(await pdf(), 'x.pdf') } });
    expect(up.status).toBe(403);
    expect((await request(ctx.app, 'PATCH', `/vault/${gstId}`, { cookie: org.viewer.cookie, json: { title: 'x' } })).status).toBe(403);
    expect((await request(ctx.app, 'DELETE', `/vault/${gstId}`, { cookie: org.viewer.cookie })).status).toBe(403);
    expect((await request(ctx.app, 'PUT', `/vault/${gstId}/file`, { cookie: org.viewer.cookie, form: { file: file(await pdf(), 'x.pdf') } })).status).toBe(403);
  });

  it('isolates organisations', async () => {
    const other = await signup(ctx.app, { orgName: 'Other Traders' });
    for (const [m, p] of [['GET', `/vault/${gstId}`], ['GET', `/vault/${gstId}/download`], ['PATCH', `/vault/${gstId}`], ['DELETE', `/vault/${gstId}`]] as const) {
      const r = await request(ctx.app, m, p, { cookie: other.cookie, json: m === 'PATCH' ? { title: 'x' } : undefined });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect((await request(ctx.app, 'GET', '/vault', { cookie: other.cookie })).body.total).toBe(0);
    expect((await request(ctx.app, 'GET', '/vault/summary', { cookie: other.cookie })).body.total).toBe(0);
    expect((await request(ctx.app, 'GET', '/profile', { cookie: other.cookie })).body.profile.legalName).toBe('');
    const pc = await request(ctx.app, 'POST', '/past-contracts', { cookie: other.cookie, json: { buyer: 'B', title: 'T', value: 1000, cracDocumentId: gstId } });
    expect(pc.status).toBe(400);
  });

  it('requires sign-in', async () => {
    expect((await request(ctx.app, 'GET', '/vault')).status).toBe(401);
    expect((await request(ctx.app, 'GET', '/profile')).status).toBe(401);
  });

  it('delete removes the row and the blob, and logs activity', async () => {
    const up = await request(ctx.app, 'POST', '/vault', { cookie: org.analyst.cookie, form: { file: file(await pdf(), 'temp.pdf') } });
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, up.body.id));
    expect(await ctx.deps.blobs.head(row!.blobKey)).not.toBeNull();
    const d = await request(ctx.app, 'DELETE', `/vault/${up.body.id}`, { cookie: org.analyst.cookie });
    expect(d.status).toBe(200);
    expect(await ctx.deps.blobs.head(row!.blobKey)).toBeNull();
    expect((await request(ctx.app, 'GET', `/vault/${up.body.id}`, { cookie: org.analyst.cookie })).status).toBe(404);
    const acts = await ctx.db.select().from(activityLog).where(and(eq(activityLog.orgId, org.orgId), eq(activityLog.entityId, up.body.id)));
    expect(acts.map((a) => a.action).sort()).toEqual(['vault.deleted', 'vault.uploaded']);
  });

  it('profile completeness counts vault documents', async () => {
    const r = await request(ctx.app, 'GET', '/profile', { cookie: org.viewer.cookie });
    expect(r.body.issues.some((i: any) => i.field === 'vault.gst')).toBe(false);
    expect(r.body.issues.some((i: any) => i.field === 'vault.udyam')).toBe(true);
  });
});

describe('expiry reminders', () => {
  it('notifies members once per threshold and respects prefs (FR-022)', async () => {
    // Viewer opts out of expiry reminders; analyst opts out of email.
    const put = async (who: { cookie: string }, patch: Record<string, unknown>) => {
      const cur = await request(ctx.app, 'GET', '/me/notification-prefs', { cookie: who.cookie });
      const r = await request(ctx.app, 'PUT', '/me/notification-prefs', { cookie: who.cookie, json: { ...cur.body, ...patch } });
      expect(r.status).toBe(200);
    };
    await put(org.viewer, { expiryReminders: false });
    await put(org.analyst, { email: false });
    const r1 = await runExpiryReminders(ctx.deps);
    // ISO (10 days → 30-day reminder) and Dell MAF (expired 34 days ago → too old, skipped).
    expect(r1.documents).toBe(1);
    const rows = await ctx.db.select().from(notifications).where(eq(notifications.kind, 'expiry'));
    // owner + bid manager: in_app + email; analyst: in_app only; viewer: none.
    expect(rows.length).toBe(5);
    expect(rows.filter((n) => n.channel === 'in_app').every((n) => n.status === 'sent')).toBe(true);
    expect(rows.filter((n) => n.channel === 'email').every((n) => n.status === 'pending')).toBe(true);
    expect(rows.some((n) => n.userId === org.viewer.me.user.id)).toBe(false);
    expect(rows[0]!.title).toContain('expires in 10 days');
    expect(rows[0]!.link).toBe(`/vault?doc=${(await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.type, 'iso')))[0]!.id}`);

    // Idempotent
    const r2 = await runExpiryReminders(ctx.deps);
    expect(r2).toEqual({ documents: 0, notifications: 0 });

    // 4 days later → 7-day threshold crossed (6 days left)
    ctx.clock.set(new Date('2026-11-08T04:30:00Z'));
    const r3 = await runExpiryReminders(ctx.deps);
    expect(r3.documents).toBe(1);
    expect(r3.notifications).toBe(5);
    // Day after expiry → "expired" reminder
    ctx.clock.set(new Date('2026-11-15T04:30:00Z'));
    await runExpiryReminders(ctx.deps); // 1-day reminder would have been skipped straight to expired
    const [iso] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.type, 'iso'));
    expect(iso!.lastReminderDays).toBe(0);
    const titles = (await ctx.db.select().from(notifications).where(and(eq(notifications.kind, 'expiry'), eq(notifications.channel, 'in_app'), eq(notifications.userId, org.owner.me.user.id)))).map((n) => n.title);
    expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('has expired')]));
    ctx.clock.set(NOW);
  });
});

// T056 / T060 — past contracts with CRACs and OEM authorisations (US5; FR-054…FR-057, FR-061)
describe('past contracts & OEM authorisations (US5)', () => {
  let us5: Awaited<ReturnType<typeof seedOrgWithRoles>>;
  let other: Awaited<ReturnType<typeof seedOrgWithRoles>>;
  let cracId: string;
  let otherCracId: string;
  let mafId: string;
  let otherMafId: string;
  const upload = async (o: { cookie: string }, type: string, title: string, expiryDate?: string) => {
    const r = await request(ctx.app, 'POST', '/vault', { cookie: o.cookie, form: { file: file(await pdf(1), `${type}.pdf`), type, title, ...(expiryDate ? { expiryDate } : {}) } });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const contract = { buyer: 'Central Railway, Mumbai Division', title: 'Supply of 85 desktop computers', value: 58_20_000 };
  const NOT_IN_VAULT = 'That document is not in your vault';

  beforeAll(async () => {
    us5 = await seedOrgWithRoles(ctx.app, 'US5 Traders');
    other = await seedOrgWithRoles(ctx.app, 'US5 Other');
    cracId = await upload(us5.analyst, 'crac', 'CRAC Central Railway');
    otherCracId = await upload(other.analyst, 'crac', 'Other CRAC');
    mafId = await upload(us5.analyst, 'oem_authorization', 'HP MAF', '2028-03-31');
    otherMafId = await upload(other.analyst, 'oem_authorization', 'Other MAF', '2028-03-31');
  });

  it('links a CRAC from the own vault (independent test)', async () => {
    const r = await request(ctx.app, 'POST', '/past-contracts', { cookie: us5.analyst.cookie, json: { ...contract, cracDocumentId: cracId } });
    expect(r.status).toBe(201);
    expect(r.body.cracDocumentId).toBe(cracId);
    const l = await request(ctx.app, 'GET', '/past-contracts', { cookie: us5.viewer.cookie });
    expect(l.body.items.find((i: any) => i.id === r.body.id).cracDocumentId).toBe(cracId);
  });

  it.each([
    ['another org\'s document', () => otherCracId],
    ['a random UUID', () => '6f1c2d3e-4b5a-4c6d-8e7f-901234567890'],
  ])('rejects cracDocumentId of %s on POST and PATCH → 400 (FR-055)', async (_label, id) => {
    const r = await request(ctx.app, 'POST', '/past-contracts', { cookie: us5.analyst.cookie, json: { ...contract, cracDocumentId: id() } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    expect(r.body.error.details.fields.cracDocumentId).toBe(NOT_IN_VAULT);
    const c = await request(ctx.app, 'POST', '/past-contracts', { cookie: us5.analyst.cookie, json: contract });
    const p = await request(ctx.app, 'PATCH', `/past-contracts/${c.body.id}`, { cookie: us5.analyst.cookie, json: { cracDocumentId: id() } });
    expect(p.status).toBe(400);
    expect(p.body.error.details.fields.cracDocumentId).toBe(NOT_IN_VAULT);
    const stored = (await request(ctx.app, 'GET', '/past-contracts', { cookie: us5.viewer.cookie })).body.items.find((i: any) => i.id === c.body.id);
    expect(stored.cracDocumentId).toBeNull();
    await request(ctx.app, 'DELETE', `/past-contracts/${c.body.id}`, { cookie: us5.analyst.cookie });
  });

  it('PATCH with only endDate before the stored startDate → 400 (FR-054)', async () => {
    const c = await request(ctx.app, 'POST', '/past-contracts', { cookie: us5.analyst.cookie, json: { ...contract, startDate: '2025-04-01', endDate: '2025-06-30' } });
    const p = await request(ctx.app, 'PATCH', `/past-contracts/${c.body.id}`, { cookie: us5.analyst.cookie, json: { endDate: '2025-03-31' } });
    expect(p.status).toBe(400);
    expect(p.body.error.details.fields.endDate).toBe('End date is before the start date');
    const stored = (await request(ctx.app, 'GET', '/past-contracts', { cookie: us5.viewer.cookie })).body.items.find((i: any) => i.id === c.body.id);
    expect(stored.endDate).toBe('2025-06-30');
    await request(ctx.app, 'DELETE', `/past-contracts/${c.body.id}`, { cookie: us5.analyst.cookie });
  });

  it('another org\'s contract and malformed ids → 404 "Past contract not found"', async () => {
    const c = await request(ctx.app, 'POST', '/past-contracts', { cookie: us5.analyst.cookie, json: contract });
    for (const [method, path] of [['PATCH', `/past-contracts/${c.body.id}`], ['DELETE', `/past-contracts/${c.body.id}`], ['PATCH', '/past-contracts/not-a-uuid'], ['DELETE', '/past-contracts/123']] as const) {
      const r = await request(ctx.app, method, path, { cookie: other.analyst.cookie, json: method === 'PATCH' ? { value: 1 } : undefined });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.body.error.code).toBe('not_found');
      expect(r.body.error.message).toBe('Past contract not found');
    }
    const stored = (await request(ctx.app, 'GET', '/past-contracts', { cookie: us5.viewer.cookie })).body.items.find((i: any) => i.id === c.body.id);
    expect(stored.value).toBe(contract.value);
    expect((await request(ctx.app, 'GET', '/past-contracts', { cookie: other.viewer.cookie })).body.total).toBe(0);
    await request(ctx.app, 'DELETE', `/past-contracts/${c.body.id}`, { cookie: us5.analyst.cookie });
  });

  it('viewer cannot add or edit a contract → 403', async () => {
    expect((await request(ctx.app, 'POST', '/past-contracts', { cookie: us5.viewer.cookie, json: contract })).status).toBe(403);
    const c = await request(ctx.app, 'POST', '/past-contracts', { cookie: us5.analyst.cookie, json: contract });
    expect((await request(ctx.app, 'PATCH', `/past-contracts/${c.body.id}`, { cookie: us5.viewer.cookie, json: { value: 1 } })).status).toBe(403);
    await request(ctx.app, 'DELETE', `/past-contracts/${c.body.id}`, { cookie: us5.analyst.cookie });
  });

  it('lists by end date desc, then created desc (FR-056)', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'US5 Order');
    // created_at comes from the DB default, so sequential inserts are strictly ordered.
    // Undated contracts sort last (NULLS LAST), not as the newest.
    for (const [title, endDate] of [['Undated', null], ['Old', '2023-03-31'], ['Newest', '2025-09-30'], ['Same end, created first', '2024-12-31'], ['Same end, created later', '2024-12-31']]) {
      const r = await request(ctx.app, 'POST', '/past-contracts', { cookie: o.analyst.cookie, json: { buyer: 'NIC', title, value: 1000, endDate } });
      expect(r.status).toBe(201);
    }
    const l = await request(ctx.app, 'GET', '/past-contracts', { cookie: o.viewer.cookie });
    expect(l.body.total).toBe(5);
    expect(l.body.items.map((i: any) => i.title)).toEqual(['Newest', 'Same end, created later', 'Same end, created first', 'Old', 'Undated']);
  });

  it('logs added / updated (with fields) / deleted activity (FR-057)', async () => {
    const c = await request(ctx.app, 'POST', '/past-contracts', { cookie: us5.analyst.cookie, json: contract });
    await request(ctx.app, 'PATCH', `/past-contracts/${c.body.id}`, { cookie: us5.analyst.cookie, json: { value: 60_00_000, cracDocumentId: cracId } });
    await request(ctx.app, 'DELETE', `/past-contracts/${c.body.id}`, { cookie: us5.analyst.cookie });
    const acts = await ctx.db.select().from(activityLog).where(and(eq(activityLog.orgId, us5.orgId), eq(activityLog.entityId, c.body.id)));
    expect(acts.map((a) => a.action).sort()).toEqual(['profile.past_contract_added', 'profile.past_contract_deleted', 'profile.past_contract_updated']);
    expect(acts.every((a) => a.entityType === 'past_contract' && a.userId === us5.analyst.me.user.id)).toBe(true);
    const upd = acts.find((a) => a.action === 'profile.past_contract_updated')!;
    expect(((upd.meta as { fields: string[] }).fields).sort()).toEqual(['cracDocumentId', 'value']);
  });

  // T060 — FR-061
  const oem = (documentId: string | null) => ({ oemAuthorizations: [{ oem: 'HP', products: 'Desktops', validTill: '2028-03-31', documentId }] });

  it('saves an OEM row linked to an own oem_authorization document (ids compared case-insensitively)', async () => {
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: us5.analyst.cookie, json: oem(mafId.toUpperCase()) });
    expect(r.status).toBe(200);
    expect(r.body.profile.oemAuthorizations[0].documentId).toBe(mafId);
    expect((await request(ctx.app, 'PUT', '/profile', { cookie: us5.analyst.cookie, json: oem(null) })).status).toBe(200);
  });

  it.each([
    ['another org\'s OEM authorisation', () => otherMafId],
    ['a document of another type (CRAC)', () => cracId],
    ['a random UUID', () => '6f1c2d3e-4b5a-4c6d-8e7f-901234567890'],
  ])('rejects OEM documentId of %s → 400 (FR-061)', async (_label, id) => {
    expect((await request(ctx.app, 'PUT', '/profile', { cookie: us5.analyst.cookie, json: oem(mafId) })).status).toBe(200);
    const body = { oemAuthorizations: [{ oem: 'HP', products: '', documentId: mafId }, { oem: 'Dell', products: '', documentId: id() }] };
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: us5.analyst.cookie, json: body });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    expect(r.body.error.details.fields).toEqual({ 'oemAuthorizations.1.documentId': 'Pick an OEM authorisation from your vault' });
    // Nothing was written.
    const stored = (await request(ctx.app, 'GET', '/profile', { cookie: us5.viewer.cookie })).body.profile.oemAuthorizations;
    expect(stored).toHaveLength(1);
    expect(stored[0].documentId).toBe(mafId);
  });

  it('a stored link that went stale (retyped or deleted) never blocks an unrelated save; a new bad id still does', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'US5 Stale');
    const maf = await upload(o.analyst, 'oem_authorization', 'Lenovo MAF');
    const gone = await upload(o.analyst, 'oem_authorization', 'Acer MAF');
    const rows = [{ oem: 'Lenovo', products: '', documentId: maf }, { oem: 'Acer', products: '', documentId: gone }];
    expect((await request(ctx.app, 'PUT', '/profile', { cookie: o.analyst.cookie, json: { oemAuthorizations: rows } })).status).toBe(200);
    expect((await request(ctx.app, 'PATCH', `/vault/${maf}`, { cookie: o.analyst.cookie, json: { type: 'crac' } })).status).toBe(200);
    await ctx.db.delete(vaultDocuments).where(eq(vaultDocuments.id, gone));
    // Unrelated field, and the editor's usual full resend of the stored rows → both 200.
    expect((await request(ctx.app, 'PUT', '/profile', { cookie: o.analyst.cookie, json: { tradeName: 'Stale Co' } })).status).toBe(200);
    expect((await request(ctx.app, 'PUT', '/profile', { cookie: o.analyst.cookie, json: { tradeName: 'Stale Co 2', oemAuthorizations: rows } })).status).toBe(200);
    // A NEW invalid id is still refused.
    const r = await request(ctx.app, 'PUT', '/profile', { cookie: o.analyst.cookie, json: { oemAuthorizations: [...rows, { oem: 'HP', products: '', documentId: otherMafId }] } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.fields).toEqual({ 'oemAuthorizations.2.documentId': 'Pick an OEM authorisation from your vault' });
  });
});

/** T033 (#134): download headers, replace PDF → PNG, cross-org 404s, tags, literal `%`, empty file, insert rollback. */
describe('vault — headers, replace, isolation and rollback (T033)', () => {
  let b: Awaited<ReturnType<typeof seedOrgWithRoles>>;
  beforeAll(async () => { b = await seedOrgWithRoles(ctx.app, 'Vault Gaps Traders'); });

  it('download sends attachment / inline with ASCII filename + UTF-8 filename* and private, no-store (FR-030)', async () => {
    const bytes = await pdf(1);
    const up = await request(ctx.app, 'POST', '/vault', { cookie: b.analyst.cookie, form: { file: file(bytes, 'प्रमाणपत्र.pdf'), type: 'other', title: 'Hindi certificate' } });
    expect(up.status).toBe(201);
    expect(up.body.fileName).toBe('प्रमाणपत्र.pdf');
    const d = await request(ctx.app, 'GET', `/vault/${up.body.id}/download`, { cookie: b.viewer.cookie });
    expect(d.status).toBe(200);
    const cd = d.headers.get('content-disposition')!;
    expect(cd).toMatch(/^attachment; /);
    // No ASCII letters/digits survive → generic ASCII fallback; the real name travels in filename*.
    expect(cd).toContain('filename="document.pdf"');
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('प्रमाणपत्र.pdf')}`);
    expect(d.headers.get('cache-control')).toBe('private, no-store');
    expect(d.headers.get('x-content-type-options')).toBe('nosniff');
    expect(d.headers.get('content-length')).toBe(String(bytes.length));
    expect(new Uint8Array(await d.res.arrayBuffer())).toEqual(bytes);

    const inline = await request(ctx.app, 'GET', `/vault/${up.body.id}/download?inline=1`, { cookie: b.viewer.cookie });
    expect(inline.headers.get('content-disposition')).toMatch(/^inline; filename="document\.pdf"; filename\*=UTF-8''/);
    expect(inline.headers.get('cache-control')).toBe('private, no-store');
    expect(inline.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('replacing a PDF with a PNG keeps the old blob as a version and updates mime type and page count (FR-032, FR-065)', async () => {
    const up = await request(ctx.app, 'POST', '/vault', { cookie: b.analyst.cookie, form: { file: file(await pdf(4), 'udyam.pdf'), type: 'udyam', title: 'Udyam certificate', number: 'UDYAM-MH-26-0123456' } });
    expect(up.body.pageCount).toBe(4);
    const [before] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, up.body.id));
    const r = await request(ctx.app, 'PUT', `/vault/${up.body.id}/file`, { cookie: b.analyst.cookie, form: { file: file(PNG, 'udyam-scan.png', 'image/png') } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ fileName: 'udyam-scan.png', mimeType: 'image/png', pageCount: 1, sizeBytes: PNG.length, type: 'udyam', title: 'Udyam certificate', number: 'UDYAM-MH-26-0123456' });
    const [after] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, up.body.id));
    expect(after!.blobKey).not.toBe(before!.blobKey);
    // FR-065 (US6): the previous file is kept as a version instead of being deleted.
    expect(await ctx.deps.blobs.head(before!.blobKey)).not.toBeNull();
    expect(await ctx.deps.blobs.head(after!.blobKey)).not.toBeNull();
    const d = await request(ctx.app, 'GET', `/vault/${up.body.id}/download`, { cookie: b.viewer.cookie });
    expect(d.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await d.res.arrayBuffer())).toEqual(PNG);
    const acts = await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, up.body.id), eq(activityLog.action, 'vault.file_replaced')));
    expect(acts).toHaveLength(1);
  });

  it('answers 404 "Document not found" for another org\'s id on every route, and leaves it untouched (FR-034)', async () => {
    const up = await request(ctx.app, 'POST', '/vault', { cookie: b.analyst.cookie, form: { file: file(await pdf(), 'crac.pdf'), type: 'crac', title: 'CRAC NIC' } });
    const id = up.body.id as string;
    const other = await signup(ctx.app, { orgName: 'Intruder Pvt Ltd' });
    const calls: [string, string, Parameters<typeof request>[3]][] = [
      ['GET', `/vault/${id}`, {}],
      ['GET', `/vault/${id}/download`, {}],
      ['GET', `/vault/${id}/download?inline=1`, {}],
      ['PATCH', `/vault/${id}`, { json: { title: 'Hijacked' } }],
      ['PUT', `/vault/${id}/file`, { form: { file: file(PNG, 'evil.png', 'image/png') } }],
      ['DELETE', `/vault/${id}`, {}],
    ];
    for (const [m, p, o] of calls) {
      const r = await request(ctx.app, m, p, { ...o, cookie: other.cookie });
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.body.error, `${m} ${p}`).toEqual({ code: 'not_found', message: 'Document not found' });
    }
    for (const [m, p] of [['GET', '/vault/not-a-uuid'], ['GET', '/vault/123/download'], ['PATCH', '/vault/xyz'], ['DELETE', '/vault/xyz']] as const) {
      const r = await request(ctx.app, m, p, { cookie: b.analyst.cookie, json: m === 'PATCH' ? { title: 'x' } : undefined });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, id));
    expect(row).toMatchObject({ title: 'CRAC NIC', fileName: 'crac.pdf', mimeType: 'application/pdf' });
    expect(await ctx.deps.blobs.head(row!.blobKey)).not.toBeNull();
  });

  it('accepts tags as a comma list and as a JSON array (FR-022)', async () => {
    const comma = await request(ctx.app, 'POST', '/vault', { cookie: b.analyst.cookie, form: { file: file(await pdf(), 'a.pdf'), title: 'Comma tags', tags: ' gem, statutory ,,renewal ' } });
    expect(comma.status).toBe(201);
    expect(comma.body.tags).toEqual(['gem', 'statutory', 'renewal']);
    const json = await request(ctx.app, 'POST', '/vault', { cookie: b.analyst.cookie, form: { file: file(await pdf(), 'b.pdf'), title: 'JSON tags', tags: '["dell", "oem, partner"]' } });
    expect(json.status).toBe(201);
    expect(json.body.tags).toEqual(['dell', 'oem, partner']);
    const tooMany = await request(ctx.app, 'POST', '/vault', { cookie: b.analyst.cookie, form: { file: file(await pdf(), 'c.pdf'), tags: Array.from({ length: 21 }, (_, i) => `t${i}`).join(',') } });
    expect(tooMany.status).toBe(400);
  });

  it('search treats % and _ literally (FR-027)', async () => {
    const pct = await request(ctx.app, 'POST', '/vault', { cookie: b.analyst.cookie, form: { file: file(await pdf(), 'mii.pdf'), type: 'mii_certificate', title: 'MII 60% local content' } });
    expect(pct.status).toBe(201);
    const r = await request(ctx.app, 'GET', `/vault?q=${encodeURIComponent('60%')}`, { cookie: b.viewer.cookie });
    expect(r.body.items.map((d: any) => d.id)).toEqual([pct.body.id]);
    const onlyPct = await request(ctx.app, 'GET', `/vault?q=${encodeURIComponent('%')}`, { cookie: b.viewer.cookie });
    expect(onlyPct.body.items.map((d: any) => d.id)).toEqual([pct.body.id]);
    const underscore = await request(ctx.app, 'GET', `/vault?q=${encodeURIComponent('_')}`, { cookie: b.viewer.cookie });
    expect(underscore.body.total).toBe(0);
  });

  it('rejects a 0-byte file with 400 "The file is empty" and stores nothing (FR-023)', async () => {
    const before = await ctx.db.select({ id: vaultDocuments.id }).from(vaultDocuments).where(eq(vaultDocuments.orgId, b.orgId));
    const r = await request(ctx.app, 'POST', '/vault', { cookie: b.analyst.cookie, form: { file: file(new Uint8Array(0), 'empty.pdf') } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    expect(r.body.error.details.fields.file).toBe('The file is empty');
    const after = await ctx.db.select({ id: vaultDocuments.id }).from(vaultDocuments).where(eq(vaultDocuments.orgId, b.orgId));
    expect(after.length).toBe(before.length);
  });

  it('a failed DB insert removes the blob it just wrote (FR-023)', async () => {
    const written: string[] = [];
    const blobs: AppDeps['blobs'] = { ...ctx.deps.blobs, put: async (key, body, o) => { written.push(key); return ctx.deps.blobs.put(key, body, o); } };
    // The insert now runs inside a transaction with its stale flag (004 review S2): fail it on the db and on any tx.
    const failVaultInserts = <T extends object>(inner: T): T => new Proxy(inner, {
      get(target, prop, recv) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === vaultDocuments) throw new Error('simulated insert failure');
            return (target as typeof ctx.db).insert(table as typeof vaultDocuments);
          };
        }
        if (prop === 'transaction') {
          return (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
            (target as typeof ctx.db).transaction((tx) => fn(failVaultInserts(tx)) as Promise<never>, ...(rest as []));
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const db = failVaultInserts(ctx.db);
    const app = createApp({ ...ctx.deps, db, blobs });
    const r = await request(app, 'POST', '/vault', { cookie: b.analyst.cookie, form: { file: file(await pdf(), 'doomed.pdf'), title: 'Doomed' } });
    expect(r.status).toBe(500);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(new RegExp(`^org/${b.orgId}/vault/[0-9a-f-]{36}/doomed\\.pdf$`));
    expect(await ctx.deps.blobs.head(written[0]!)).toBeNull();
    expect(await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.title, 'Doomed'))).toHaveLength(0);
  });
});

/** T038 (#135): deleting a vault document unlinks profile OEM authorisations in the same request (FR-041). */
describe('vault delete unlinks OEM authorisations (T038)', () => {
  it('clears documentId only on authorisations pointing at the deleted document', async () => {
    const c = await seedOrgWithRoles(ctx.app, 'OEM Link Traders');
    const maf = await request(ctx.app, 'POST', '/vault', { cookie: c.analyst.cookie, form: { file: file(await pdf(), 'dell_maf.pdf'), type: 'oem_authorization', title: 'Dell MAF' } });
    const hp = await request(ctx.app, 'POST', '/vault', { cookie: c.analyst.cookie, form: { file: file(await pdf(), 'hp_maf.pdf'), type: 'oem_authorization', title: 'HP MAF' } });
    const crac = await request(ctx.app, 'POST', '/past-contracts', { cookie: c.analyst.cookie, json: { buyer: 'NIC', title: 'Laptops', value: 100000, cracDocumentId: maf.body.id } });
    expect(crac.status).toBe(201);
    const put = await request(ctx.app, 'PUT', '/profile', {
      cookie: c.analyst.cookie,
      json: { oemAuthorizations: [
        { oem: 'Dell', products: 'Laptops', validTill: '2027-03-31', documentId: maf.body.id },
        { oem: 'HP', products: 'Printers', documentId: hp.body.id },
        { oem: 'Dell', products: 'Desktops', documentId: maf.body.id },
        { oem: 'Lenovo', products: 'Tablets' },
      ] },
    });
    expect(put.status).toBe(200);

    const del = await request(ctx.app, 'DELETE', `/vault/${maf.body.id}`, { cookie: c.analyst.cookie });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    const prof = await request(ctx.app, 'GET', '/profile', { cookie: c.viewer.cookie });
    const auths = prof.body.profile.oemAuthorizations as { oem: string; products: string; validTill?: string | null; documentId?: string | null }[];
    expect(auths.map((a) => a.oem)).toEqual(['Dell', 'HP', 'Dell', 'Lenovo']);
    expect(auths[0]).toMatchObject({ oem: 'Dell', products: 'Laptops', validTill: '2027-03-31', documentId: null });
    expect(auths[1]!.documentId).toBe(hp.body.id);
    expect(auths[2]!.documentId).toBeNull();
    expect(auths[3]!.documentId ?? null).toBeNull();
    const pcs = await request(ctx.app, 'GET', '/past-contracts', { cookie: c.viewer.cookie });
    expect(pcs.body.items[0].cracDocumentId).toBeNull();
  });

  it('does not touch another org\'s profile that happens to hold the same id', async () => {
    const d = await seedOrgWithRoles(ctx.app, 'Mine Traders');
    const e = await seedOrgWithRoles(ctx.app, 'Theirs Traders');
    const doc = await request(ctx.app, 'POST', '/vault', { cookie: d.analyst.cookie, form: { file: file(await pdf(), 'oem.pdf'), type: 'oem_authorization', title: 'Acer MAF' } });
    // Simulate a stale cross-org reference written directly (the API never lets this happen).
    await ctx.db.insert(companyProfiles).values({ orgId: e.orgId, oemAuthorizations: [{ oem: 'Acer', products: 'All', documentId: doc.body.id }] });
    expect((await request(ctx.app, 'DELETE', `/vault/${doc.body.id}`, { cookie: d.analyst.cookie })).status).toBe(200);
    const [theirs] = await ctx.db.select().from(companyProfiles).where(eq(companyProfiles.orgId, e.orgId));
    expect(theirs!.oemAuthorizations[0]!.documentId).toBe(doc.body.id);
  });
});

/** T046 (#141) + T050 (#142): reminder isolation, IST boundary, expiry edit restarts the cycle, email title, manual run endpoint. */
describe('expiry reminders — isolation, IST boundary, renewals and manual run (T046, T050)', () => {
  const upload = async (who: { cookie: string }, title: string, expiryDate: string) => {
    const r = await request(ctx.app, 'POST', '/vault', { cookie: who.cookie, form: { file: file(await pdf(1), `${title}.pdf`), type: 'iso', title, expiryDate } });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const expiryRows = (docId: string) => ctx.db.select().from(notifications).where(and(eq(notifications.kind, 'expiry'), eq(notifications.link, `/vault?doc=${docId}`)));
  const lastReminder = async (docId: string) => (await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, docId)))[0]!.lastReminderDays;

  it('POST /vault/reminders/run: bid manager and owner 200, analyst and viewer 403, idempotent, own org only, logs activity (FR-052)', async () => {
    const e = await seedOrgWithRoles(ctx.app, 'Manual Run Traders');
    const f = await seedOrgWithRoles(ctx.app, 'Bystander Traders');
    const mine = await upload(e.analyst, 'ISO 9001 Manual', '2026-11-14');
    const theirs = await upload(f.analyst, 'ISO 9001 Bystander', '2026-11-14');

    for (const who of [e.analyst, e.viewer]) {
      const r = await request(ctx.app, 'POST', '/vault/reminders/run', { cookie: who.cookie });
      expect(r.status).toBe(403);
      expect(r.body.error.message).toBe('You need to be at least a Bid Manager to do that');
    }
    expect(await lastReminder(mine)).toBeNull();
    expect((await request(ctx.app, 'POST', '/vault/reminders/run')).status).toBe(401);

    const r1 = await request(ctx.app, 'POST', '/vault/reminders/run', { cookie: e.bidManager.cookie });
    expect(r1.status).toBe(200);
    expect(r1.body.documents).toBe(1);
    expect(r1.body.notifications).toBeGreaterThan(0);
    expect(r1.body.notifications).toBe((await expiryRows(mine)).length);
    expect(await lastReminder(mine)).toBe(30);
    // Another org's due document is untouched.
    expect(await lastReminder(theirs)).toBeNull();
    expect(await expiryRows(theirs)).toHaveLength(0);

    // Same day again → nothing new, for bid manager and owner alike.
    const r2 = await request(ctx.app, 'POST', '/vault/reminders/run', { cookie: e.bidManager.cookie });
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ documents: 0, notifications: 0 });
    const r3 = await request(ctx.app, 'POST', '/vault/reminders/run', { cookie: e.owner.cookie });
    expect(r3.status).toBe(200);
    expect(r3.body).toEqual({ documents: 0, notifications: 0 });
    expect(await expiryRows(mine)).toHaveLength(r1.body.notifications);

    const acts = await ctx.db.select().from(activityLog).where(and(eq(activityLog.orgId, e.orgId), eq(activityLog.action, 'vault.reminders_run')));
    expect(acts).toHaveLength(3);
    expect(acts.map((a) => a.meta)).toEqual(expect.arrayContaining([
      { documents: 1, notifications: r1.body.notifications },
      { documents: 0, notifications: 0 },
    ]));
    expect(acts.find((a) => (a.meta as { documents: number }).documents === 1)!.userId).toBe(e.bidManager.me.user.id);
  });

  it('run with every member opted out of expiry reminders reports 0 notifications (FR-052)', async () => {
    const h = await seedOrgWithRoles(ctx.app, 'Quiet Traders');
    for (const who of [h.owner, h.bidManager, h.analyst, h.viewer]) {
      const cur = await request(ctx.app, 'GET', '/me/notification-prefs', { cookie: who.cookie });
      expect((await request(ctx.app, 'PUT', '/me/notification-prefs', { cookie: who.cookie, json: { ...cur.body, expiryReminders: false } })).status).toBe(200);
    }
    const id = await upload(h.analyst, 'ISO 9001 Quiet', '2026-11-14');
    const r = await request(ctx.app, 'POST', '/vault/reminders/run', { cookie: h.bidManager.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ documents: 1, notifications: 0 });
    expect(await expiryRows(id)).toHaveLength(0);
  });

  it('IST boundary: at 2026-11-05T20:00Z (01:30 IST on the 6th) a document expiring 2026-11-05 is expired (FR-042)', async () => {
    const g = await seedOrgWithRoles(ctx.app, 'Midnight Traders');
    const id = await upload(g.analyst, 'ISO 14001 Midnight', '2026-11-05');
    try {
      // 23:30 IST on the 5th: still valid on its expiry date.
      ctx.clock.set(new Date('2026-11-05T18:00:00Z'));
      expect((await request(ctx.app, 'GET', `/vault/${id}`, { cookie: g.viewer.cookie })).body).toMatchObject({ status: 'expiring', daysToExpiry: 0 });

      ctx.clock.set(new Date('2026-11-05T20:00:00Z'));
      const doc = await request(ctx.app, 'GET', `/vault/${id}`, { cookie: g.viewer.cookie });
      // The expiry notice is due now (IST day 2026-11-06).
      expect(doc.body).toMatchObject({ status: 'expired', daysToExpiry: -1, nextReminder: { days: 0, date: '2026-11-06' } });
      const r = await runExpiryReminders(ctx.deps, { orgId: g.orgId });
      expect(r.documents).toBe(1);
      expect(await lastReminder(id)).toBe(0);
      const rows = await expiryRows(id);
      const inApp = rows.filter((n) => n.channel === 'in_app');
      expect(inApp.length).toBeGreaterThan(0);
      expect(inApp.every((n) => n.title === 'ISO 14001 Midnight has expired')).toBe(true);
      expect(inApp[0]!.body).toBe('Your ISO certificate "ISO 14001 Midnight" expired 1 day ago. Bids that need it will be blocked from "Ready to submit" until you upload the renewed copy.');
      expect(rows.every((n) => n.dedupeKey === `expiry:${id}:2026-11-05:0`)).toBe(true);
      expect((await request(ctx.app, 'GET', `/vault/${id}`, { cookie: g.viewer.cookie })).body.nextReminder).toBeNull();
    } finally {
      ctx.clock.set(NOW);
    }
  });

  it('editing the expiry after a sent reminder restarts the cycle with a new dedupe key; email titles carry "[<Org name>]" (FR-045, FR-049)', async () => {
    const d = await seedOrgWithRoles(ctx.app, 'Renewal Traders');
    const id = await upload(d.analyst, 'ISO 27001 Renewal', '2026-11-14');

    const first = await runExpiryReminders(ctx.deps, { orgId: d.orgId });
    expect(first.documents).toBe(1);
    const sent = await expiryRows(id);
    expect(sent.length).toBe(first.notifications);
    expect(sent.every((n) => n.dedupeKey === `expiry:${id}:2026-11-14:30`)).toBe(true);
    const emails = sent.filter((n) => n.channel === 'email');
    const inApps = sent.filter((n) => n.channel === 'in_app');
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((n) => n.title === '[Renewal Traders] ISO 27001 Renewal expires in 10 days' && n.status === 'pending')).toBe(true);
    expect(inApps.every((n) => n.title === 'ISO 27001 Renewal expires in 10 days' && n.status === 'sent')).toBe(true);
    expect((await request(ctx.app, 'GET', `/vault/${id}`, { cookie: d.viewer.cookie })).body.nextReminder).toEqual({ days: 7, date: '2026-11-07' });

    // Renewed: expiry moves out by 10 days → last_reminder_days reset, same threshold is sent again under a new key.
    const patch = await request(ctx.app, 'PATCH', `/vault/${id}`, { cookie: d.analyst.cookie, json: { expiryDate: '2026-11-24' } });
    expect(patch.status).toBe(200);
    expect(patch.body.nextReminder).toEqual({ days: 30, date: '2026-11-04' });
    expect(await lastReminder(id)).toBeNull();
    const second = await runExpiryReminders(ctx.deps, { orgId: d.orgId });
    expect(second).toEqual({ documents: 1, notifications: first.notifications });
    const all = await expiryRows(id);
    expect(all).toHaveLength(first.notifications * 2);
    const fresh = all.filter((n) => n.dedupeKey === `expiry:${id}:2026-11-24:30`);
    expect(fresh).toHaveLength(first.notifications);
    expect(fresh.filter((n) => n.channel === 'email').every((n) => n.title === '[Renewal Traders] ISO 27001 Renewal expires in 20 days')).toBe(true);
    expect(await lastReminder(id)).toBe(30);
    expect(await runExpiryReminders(ctx.deps, { orgId: d.orgId })).toEqual({ documents: 0, notifications: 0 });
  });

  it('reminders are org-isolated: a member only of org B gets none for org A documents (FR-051)', async () => {
    const a = await seedOrgWithRoles(ctx.app, 'Alpha Isolation Traders');
    const b = await seedOrgWithRoles(ctx.app, 'Beta Isolation Traders');
    const docA = await upload(a.analyst, 'ISO 9001 Alpha', '2026-11-14');

    // Scoped to org B → org A's due document is not processed.
    expect(await runExpiryReminders(ctx.deps, { orgId: b.orgId })).toEqual({ documents: 0, notifications: 0 });
    expect(await lastReminder(docA)).toBeNull();

    // Unscoped scheduler run → only org A members are notified.
    await runExpiryReminders(ctx.deps);
    const rows = await expiryRows(docA);
    const aMembers = new Set([a.owner, a.bidManager, a.analyst, a.viewer].map((m) => m.me.user.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((n) => aMembers.has(n.userId) && n.orgId === a.orgId)).toBe(true);
    for (const m of [b.owner, b.bidManager, b.analyst, b.viewer]) {
      const theirs = await ctx.db.select().from(notifications).where(and(eq(notifications.userId, m.me.user.id), eq(notifications.kind, 'expiry')));
      expect(theirs, m.email).toHaveLength(0);
    }
    for (const m of [a.owner, b.owner]) {
      const bell = await request(ctx.app, 'GET', '/notifications', { cookie: m.cookie });
      expect(bell.status).toBe(200);
      expect(JSON.stringify(bell.body).includes(`/vault?doc=${docA}`)).toBe(m === a.owner);
    }
  });
});

/** Review fixes on PR #477: stored names stay within filesystem limits and headers stay well-formed (FR-030). */
describe('safeFileName / contentDisposition', () => {
  const bytes = (x: string) => new TextEncoder().encode(x).length;
  const wellFormed = (x: string) => { expect(() => encodeURIComponent(x)).not.toThrow(); };

  it('keeps any script and caps the base at 180 UTF-8 bytes on a grapheme boundary', () => {
    const long = 'प्रमाणपत्र '.repeat(40) + '.pdf';
    const out = safeFileName(long, 'application/pdf');
    expect(out.endsWith('.pdf')).toBe(true);
    expect(bytes(out.slice(0, -4))).toBeLessThanOrEqual(180);
    expect(bytes(out)).toBeLessThan(255);
    expect(out.startsWith('प्रमाणपत्र')).toBe(true);
    wellFormed(out);
    // Never ends in a dangling combining mark (virama/vowel sign) cut off from its base consonant.
    expect(out.slice(0, -4).normalize('NFC')).toBe(out.slice(0, -4));
  });

  it('does not split an astral character at the boundary', () => {
    const out = safeFileName(`${'a'.repeat(178)}𝐀𝐀.pdf`, 'application/pdf');
    expect(out).toBe(`${'a'.repeat(178)}.pdf`);
    wellFormed(out);
    const exact = safeFileName(`${'a'.repeat(176)}𝐀.pdf`, 'application/pdf');
    expect(exact).toBe(`${'a'.repeat(176)}𝐀.pdf`);
  });

  it('neutralises CR/LF, path tricks and bidi overrides', () => {
    expect(safeFileName('bad\r\nname.pdf', 'application/pdf')).toBe('bad_name.pdf');
    expect(safeFileName('..', 'application/pdf')).toBe('document.pdf');
    expect(safeFileName('../../etc/passwd', 'application/pdf')).toBe('passwd.pdf');
    expect(safeFileName('...hidden.pdf', 'application/pdf')).toBe('hidden.pdf');
    expect(safeFileName('invoice\u202Efdp.exe', 'application/pdf')).toBe('invoice_fdp.pdf');
    expect(safeFileName('C:\\scans\\gst.PDF', 'image/png')).toBe('gst.png');
  });

  it('falls back to document.<ext> in the ASCII filename and RFC 8187-escapes filename*', () => {
    expect(contentDisposition('प्रमाणपत्र.pdf', false)).toBe(`attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent('प्रमाणपत्र.pdf')}`);
    expect(contentDisposition('GST (copy) it\'s*.png', true)).toBe(`inline; filename="GST (copy) it's*.png"; filename*=UTF-8''GST%20%28copy%29%20it%27s%2A.png`);
    expect(contentDisposition('ISO प्रमाणपत्र.pdf', false)).toMatch(/^attachment; filename="ISO _+\.pdf"/);
  });

  it('uploads a very long Devanagari file name without a filesystem error', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'Long Names Traders');
    const name = `${'प्रमाणपत्र_'.repeat(30)}.pdf`;
    const r = await request(ctx.app, 'POST', '/vault', { cookie: o.analyst.cookie, form: { file: file(await pdf(), name), type: 'other', title: 'Long name' } });
    expect(r.status).toBe(201);
    expect(bytes(r.body.fileName)).toBeLessThan(255);
    const d = await request(ctx.app, 'GET', `/vault/${r.body.id}/download`, { cookie: o.viewer.cookie });
    expect(d.status).toBe(200);
    expect(d.headers.get('content-disposition')).toContain(`filename*=UTF-8''${encodeURIComponent(r.body.fileName)}`);
  });
});

describe('vault delete — review fixes (FR-041)', () => {
  it('deletes a document in an org that has no company profile row', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'No Profile Traders');
    const doc = await request(ctx.app, 'POST', '/vault', { cookie: o.analyst.cookie, form: { file: file(await pdf(), 'pan.pdf'), type: 'pan', title: 'PAN' } });
    expect(await ctx.db.select().from(companyProfiles).where(eq(companyProfiles.orgId, o.orgId))).toHaveLength(0);
    const d = await request(ctx.app, 'DELETE', `/vault/${doc.body.id}`, { cookie: o.analyst.cookie });
    expect(d.status).toBe(200);
    expect(await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.body.id))).toHaveLength(0);
    expect(await ctx.db.select().from(companyProfiles).where(eq(companyProfiles.orgId, o.orgId))).toHaveLength(0);
  });

  it('matches the OEM documentId case-insensitively', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'Upper Case Traders');
    const doc = await request(ctx.app, 'POST', '/vault', { cookie: o.analyst.cookie, form: { file: file(await pdf(), 'maf.pdf'), type: 'oem_authorization', title: 'Lenovo MAF' } });
    const put = await request(ctx.app, 'PUT', '/profile', { cookie: o.analyst.cookie, json: { oemAuthorizations: [{ oem: 'Lenovo', products: 'Laptops', documentId: String(doc.body.id).toUpperCase() }] } });
    expect(put.status).toBe(200);
    expect((await request(ctx.app, 'DELETE', `/vault/${doc.body.id}`, { cookie: o.analyst.cookie })).status).toBe(200);
    const [row] = await ctx.db.select().from(companyProfiles).where(eq(companyProfiles.orgId, o.orgId));
    expect(row!.oemAuthorizations[0]).toMatchObject({ oem: 'Lenovo', documentId: null });
  });

  it('rolls back every unlink when the row delete fails', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'Rollback Traders');
    // One document linked from both places: it must be an oem_authorization for PUT /profile (FR-061);
    // cracDocumentId only requires vault ownership (FR-055).
    const doc = await request(ctx.app, 'POST', '/vault', { cookie: o.analyst.cookie, form: { file: file(await pdf(), 'maf.pdf'), type: 'oem_authorization', title: 'Dell MAF' } });
    expect(doc.status).toBe(201);
    expect((await request(ctx.app, 'POST', '/past-contracts', { cookie: o.analyst.cookie, json: { buyer: 'NIC', title: 'T', value: 1000, cracDocumentId: doc.body.id } })).status).toBe(201);
    expect((await request(ctx.app, 'PUT', '/profile', { cookie: o.analyst.cookie, json: { oemAuthorizations: [{ oem: 'Dell', products: 'x', documentId: doc.body.id }] } })).status).toBe(200);
    const failingTx = new Proxy(ctx.db, {
      get(target, prop, recv) {
        if (prop === 'transaction') {
          return (fn: (tx: unknown) => Promise<unknown>) => target.transaction((tx) => fn(new Proxy(tx, {
            get(t, p, r) {
              if (p === 'delete') return () => { throw new Error('simulated delete failure'); };
              const v = Reflect.get(t, p, r);
              return typeof v === 'function' ? v.bind(t) : v;
            },
          })));
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const app = createApp({ ...ctx.deps, db: failingTx });
    expect((await request(app, 'DELETE', `/vault/${doc.body.id}`, { cookie: o.analyst.cookie })).status).toBe(500);
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.body.id));
    expect(await ctx.deps.blobs.head(row!.blobKey)).not.toBeNull();
    const pcs = await request(ctx.app, 'GET', '/past-contracts', { cookie: o.viewer.cookie });
    expect(pcs.body.items[0].cracDocumentId).toBe(doc.body.id);
    const [prof] = await ctx.db.select().from(companyProfiles).where(eq(companyProfiles.orgId, o.orgId));
    expect(prof!.oemAuthorizations[0]!.documentId).toBe(doc.body.id);
  });
});

/** T064 (#152): renew in one step, version history, duplicate detection (US6; FR-064…FR-067). */
describe('vault renewal, versions and duplicates (T064)', () => {
  let r6: Awaited<ReturnType<typeof seedOrgWithRoles>>;
  beforeAll(async () => { r6 = await seedOrgWithRoles(ctx.app, 'Renewal Traders'); });

  const versionsOf = (docId: string) =>
    ctx.db.select().from(vaultDocumentVersions).where(eq(vaultDocumentVersions.documentId, docId));
  const isoUpload = async (title: string, bytes: Uint8Array, name = 'iso.pdf') => {
    const r = await request(ctx.app, 'POST', '/vault', { cookie: r6.analyst.cookie, form: { file: file(bytes, name), type: 'iso', title, issueDate: '2023-11-15', expiryDate: '2026-11-14', number: 'QMS-OLD' } });
    expect(r.status, r.text).toBe(201);
    return r.body as { id: string };
  };

  it('renew with a new expiry updates metadata, resets last_reminder_days and logs vault.renewed (FR-064)', async () => {
    const oldBytes = await pdf(1);
    const doc = await isoUpload('ISO 9001 Renew', oldBytes);
    await ctx.db.update(vaultDocuments).set({ lastReminderDays: 30 }).where(eq(vaultDocuments.id, doc.id));
    const r = await request(ctx.app, 'PUT', `/vault/${doc.id}/file`, {
      cookie: r6.analyst.cookie, form: { file: file(await pdf(3), 'iso-2026.pdf'), issueDate: '2026-11-04', expiryDate: '2029-11-03', number: 'QMS-NEW' },
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ issueDate: '2026-11-04', expiryDate: '2029-11-03', number: 'QMS-NEW', status: 'valid', fileName: 'iso-2026.pdf', pageCount: 3, title: 'ISO 9001 Renew' });
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.id));
    expect(row!.lastReminderDays).toBeNull();
    const acts = await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, doc.id), eq(activityLog.action, 'vault.renewed')));
    expect(acts).toHaveLength(1);
    expect(acts[0]!.meta).toMatchObject({ fromExpiry: '2026-11-14', toExpiry: '2029-11-03' });
  });

  it('a plain replace (no new expiry) keeps the reminder state and does not log vault.renewed', async () => {
    const doc = await isoUpload('ISO plain replace', await pdf(1));
    await ctx.db.update(vaultDocuments).set({ lastReminderDays: 30 }).where(eq(vaultDocuments.id, doc.id));
    const r = await request(ctx.app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(await pdf(1), 'scan.pdf') } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ expiryDate: '2026-11-14', issueDate: '2023-11-15', number: 'QMS-OLD' });
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.id));
    expect(row!.lastReminderDays).toBe(30);
    expect(await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, doc.id), eq(activityLog.action, 'vault.renewed')))).toHaveLength(0);
  });

  it('rejects renewal dates where issue > expiry (also against the stored expiry) and stores nothing', async () => {
    const doc = await isoUpload('ISO bad dates', await pdf(1));
    const [before] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.id));
    const bad = await request(ctx.app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(await pdf(1), 'x.pdf'), issueDate: '2026-12-01', expiryDate: '2026-11-30' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields.expiryDate).toBe('Expiry date is before the issue date');
    const vsStored = await request(ctx.app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(await pdf(1), 'x.pdf'), issueDate: '2027-01-01' } });
    expect(vsStored.status).toBe(400);
    const badDate = await request(ctx.app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(await pdf(1), 'x.pdf'), expiryDate: '2029-02-30' } });
    expect(badDate.status).toBe(400);
    const [after] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.id));
    expect(after).toEqual(before);
    expect(await versionsOf(doc.id)).toHaveLength(0);
  });

  it('keeps the previous file as a downloadable version, even when the new file has the same name (FR-065, FR-066)', async () => {
    const oldBytes = await pdf(2);
    const doc = await isoUpload('ISO versions', oldBytes, 'iso.pdf');
    const [before] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.id));
    const newBytes = await pdf(1);
    const r = await request(ctx.app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(newBytes, 'iso.pdf'), expiryDate: '2029-11-13' } });
    expect(r.status).toBe(200);
    const [after] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.id));
    expect(after!.blobKey).not.toBe(before!.blobKey);
    expect(after!.blobKey.startsWith(`org/${r6.orgId}/vault/${doc.id}/`)).toBe(true);

    // Viewer may list and download versions.
    const list = await request(ctx.app, 'GET', `/vault/${doc.id}/versions`, { cookie: r6.viewer.cookie });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const v = list.body.items[0];
    expect(v).toMatchObject({ fileName: 'iso.pdf', mimeType: 'application/pdf', sizeBytes: oldBytes.length, pageCount: 2, expiryDate: '2026-11-14', replacedBy: { id: r6.analyst.me.user.id } });
    expect(v.replacedBy.name).toBeTruthy();
    expect(v.downloadUrl).toBe(`/api/vault/${doc.id}/versions/${v.id}/download`);
    expect(typeof v.replacedAt).toBe('string');

    const d = await request(ctx.app, 'GET', `/vault/${doc.id}/versions/${v.id}/download`, { cookie: r6.viewer.cookie });
    expect(d.status).toBe(200);
    expect(new Uint8Array(await d.res.arrayBuffer())).toEqual(oldBytes);
    expect(d.headers.get('content-disposition')).toBe('attachment; filename="iso.pdf"; filename*=UTF-8\'\'iso.pdf');
    expect(d.headers.get('cache-control')).toBe('private, no-store');
    expect(d.headers.get('x-content-type-options')).toBe('nosniff');
    expect(d.headers.get('content-type')).toBe('application/pdf');
    const inline = await request(ctx.app, 'GET', `/vault/${doc.id}/versions/${v.id}/download?inline=1`, { cookie: r6.viewer.cookie });
    expect(inline.headers.get('content-disposition')).toMatch(/^inline; /);

    // The current file is the new one.
    const cur = await request(ctx.app, 'GET', `/vault/${doc.id}/download`, { cookie: r6.viewer.cookie });
    expect(new Uint8Array(await cur.res.arrayBuffer())).toEqual(newBytes);
  });

  it('keeps at most 5 versions: the 6th renewal prunes the oldest version and its blob (FR-065)', async () => {
    const doc = await isoUpload('ISO six renewals', await pdf(1), 'v0.pdf');
    for (let i = 1; i <= 6; i++) {
      const r = await request(ctx.app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(await pdf(1), `v${i}.pdf`) } });
      expect(r.status, r.text).toBe(200);
    }
    const rows = await versionsOf(doc.id);
    expect(rows).toHaveLength(5);
    const list = await request(ctx.app, 'GET', `/vault/${doc.id}/versions`, { cookie: r6.viewer.cookie });
    // Newest first: v5 … v1; v0 was pruned.
    expect(list.body.items.map((v: any) => v.fileName)).toEqual(['v5.pdf', 'v4.pdf', 'v3.pdf', 'v2.pdf', 'v1.pdf']);
    // The pruned v0 blob is gone; every kept version's blob is present.
    const keys = rows.map((x) => x.blobKey);
    expect(keys.some((k) => k.endsWith('/v0.pdf'))).toBe(false);
    for (const k of keys) expect(await ctx.deps.blobs.head(k)).not.toBeNull();
    expect(await ctx.deps.blobs.head(`org/${r6.orgId}/vault/${doc.id}/v0.pdf`)).toBeNull();
  });

  it('deleting a document removes its versions and their blobs (FR-065)', async () => {
    const doc = await isoUpload('ISO delete with versions', await pdf(1), 'a.pdf');
    await request(ctx.app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(await pdf(1), 'b.pdf') } });
    await request(ctx.app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(await pdf(1), 'c.pdf') } });
    const vs = await versionsOf(doc.id);
    expect(vs).toHaveLength(2);
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.id));
    const d = await request(ctx.app, 'DELETE', `/vault/${doc.id}`, { cookie: r6.analyst.cookie });
    expect(d.status).toBe(200);
    expect(await versionsOf(doc.id)).toHaveLength(0);
    for (const k of [row!.blobKey, ...vs.map((v) => v.blobKey)]) expect(await ctx.deps.blobs.head(k), k).toBeNull();
  });

  it('version routes are org-scoped: another org, another document or a bad id → 404 (FR-066)', async () => {
    const doc = await isoUpload('ISO isolated versions', await pdf(1), 'one.pdf');
    await request(ctx.app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(await pdf(1), 'two.pdf') } });
    const [v] = await versionsOf(doc.id);
    const sibling = await isoUpload('ISO sibling', await pdf(1), 'sib.pdf');
    const other = await signup(ctx.app, { orgName: 'Version Snoopers' });
    for (const p of [`/vault/${doc.id}/versions`, `/vault/${doc.id}/versions/${v!.id}/download`]) {
      const r = await request(ctx.app, 'GET', p, { cookie: other.cookie });
      expect(r.status, p).toBe(404);
      expect(r.body.error.code, p).toBe('not_found');
    }
    for (const p of [`/vault/${sibling.id}/versions/${v!.id}/download`, `/vault/${doc.id}/versions/not-a-uuid/download`, `/vault/xyz/versions`]) {
      expect((await request(ctx.app, 'GET', p, { cookie: r6.viewer.cookie })).status, p).toBe(404);
    }
    expect((await request(ctx.app, 'GET', `/vault/${sibling.id}/versions`, { cookie: r6.viewer.cookie })).body.items).toEqual([]);
    expect((await request(ctx.app, 'GET', `/vault/${doc.id}/versions`)).status).toBe(401);
  });

  it('duplicate upload → 409 duplicate_document {existingId,title}; allowDuplicate=1 → 201; other orgs unaffected (FR-067)', async () => {
    const bytes = await pdf(1);
    const first = await isoUpload('ISO original', bytes, 'orig.pdf');
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, first.id));
    expect(row!.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    const before = (await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.orgId, r6.orgId))).length;

    const dup = await request(ctx.app, 'POST', '/vault', { cookie: r6.analyst.cookie, form: { file: file(bytes, 'copy.pdf'), type: 'iso' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'duplicate_document', details: { existingId: first.id, title: 'ISO original' } });
    expect((await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.orgId, r6.orgId))).length).toBe(before);

    const anyway = await request(ctx.app, 'POST', '/vault', { cookie: r6.analyst.cookie, form: { file: file(bytes, 'copy.pdf'), type: 'iso', allowDuplicate: '1' } });
    expect(anyway.status).toBe(201);

    // Same bytes in another org are not a duplicate.
    const other = await signup(ctx.app, { orgName: 'Other Duplicates' });
    expect((await request(ctx.app, 'POST', '/vault', { cookie: other.cookie, form: { file: file(bytes, 'orig.pdf') } })).status).toBe(201);
  });

  it('replace with a file identical to another document → 409 unless allowDuplicate=1; the same document is not its own duplicate (FR-067)', async () => {
    const aBytes = await pdf(1);
    const a = await isoUpload('ISO dup A', aBytes, 'a.pdf');
    const b2 = await isoUpload('ISO dup B', await pdf(1), 'b.pdf');
    const dup = await request(ctx.app, 'PUT', `/vault/${b2.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(aBytes, 'a-copy.pdf') } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details).toEqual({ existingId: a.id, title: 'ISO dup A' });
    expect(await versionsOf(b2.id)).toHaveLength(0);
    const ok = await request(ctx.app, 'PUT', `/vault/${b2.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(aBytes, 'a-copy.pdf'), allowDuplicate: '1' } });
    expect(ok.status).toBe(200);
    const self = await request(ctx.app, 'PUT', `/vault/${a.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(aBytes, 'a-again.pdf') } });
    expect(self.status).toBe(409); // b2 now holds the same bytes
    const c = await isoUpload('ISO dup C', await pdf(1), 'c.pdf');
    const [cRow] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, c.id));
    const cBytes = new Uint8Array(await (await ctx.deps.blobs.get(cRow!.blobKey))!.arrayBuffer());
    expect((await request(ctx.app, 'PUT', `/vault/${c.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(cBytes, 'c-rescan.pdf') } })).status).toBe(200);
  });

  it('documents stored before hashing (content_sha256 null) are hashed lazily and still caught as duplicates (FR-067)', async () => {
    const bytes = await pdf(1);
    const legacy = await isoUpload('ISO legacy', bytes, 'legacy.pdf');
    await ctx.db.update(vaultDocuments).set({ contentSha256: null }).where(eq(vaultDocuments.id, legacy.id));
    const dup = await request(ctx.app, 'POST', '/vault', { cookie: r6.analyst.cookie, form: { file: file(bytes, 'legacy-copy.pdf') } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.existingId).toBe(legacy.id);
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, legacy.id));
    expect(row!.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two concurrent replaces of the same document: one 200, the other 409 conflict with its blob removed', async () => {
    const doc = await isoUpload('ISO race', await pdf(1), 'race.pdf');
    const written: string[] = [];
    // Hold both blob writes until both requests have read the row, so they really race.
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    const blobs: AppDeps['blobs'] = {
      ...ctx.deps.blobs,
      put: async (key, body, o) => {
        written.push(key);
        if (written.length === 2) release();
        await both;
        return ctx.deps.blobs.put(key, body, o);
      },
    };
    const app = createApp({ ...ctx.deps, blobs });
    const [a, b] = await Promise.all([
      request(app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(await pdf(1), 'a.pdf') } }),
      request(app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(await pdf(1), 'b.pdf') } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('conflict');
    expect(written).toHaveLength(2);
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.id));
    const loserKey = written.find((k) => k !== row!.blobKey)!;
    expect(written).toContain(row!.blobKey);
    expect(await ctx.deps.blobs.head(loserKey)).toBeNull();
    expect(await ctx.deps.blobs.head(row!.blobKey)).not.toBeNull();
    const vs = await versionsOf(doc.id);
    expect(vs.map((v) => v.fileName)).toEqual(['race.pdf']);
    expect(await ctx.deps.blobs.head(vs[0]!.blobKey)).not.toBeNull();
  });

  it('clearing the expiry on replace is not a renewal: no vault.renewed, reminder state kept (FR-064)', async () => {
    const doc = await isoUpload('ISO cleared expiry', await pdf(1));
    await ctx.db.update(vaultDocuments).set({ lastReminderDays: 7 }).where(eq(vaultDocuments.id, doc.id));
    const r = await request(ctx.app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(await pdf(1), 'n.pdf'), expiryDate: '' } });
    expect(r.status).toBe(200);
    expect(r.body.expiryDate).toBeNull();
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.id));
    expect(row!.lastReminderDays).toBe(7);
    expect(await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, doc.id), eq(activityLog.action, 'vault.renewed')))).toHaveLength(0);
  });

  it('lazy hashing marks rows whose blob is gone as "missing" and reads at most 5 blobs per request (FR-067)', async () => {
    const o = await seedOrgWithRoles(ctx.app, 'Lazy Hash Traders');
    // Seven legacy rows with identical size and unknown hash; one blob is gone.
    const sameSize = (n: number) => { const b = new Uint8Array(4096); b.set(PNG); b[100] = n; return b; };
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const up = await request(ctx.app, 'POST', '/vault', { cookie: o.analyst.cookie, form: { file: file(sameSize(i), `p${i}.png`, 'image/png'), title: `Legacy ${i}` } });
      expect(up.status, up.text).toBe(201);
      ids.push(up.body.id);
    }
    await ctx.db.update(vaultDocuments).set({ contentSha256: null }).where(eq(vaultDocuments.orgId, o.orgId));
    const [first] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, ids[0]!));
    await ctx.deps.blobs.delete(first!.blobKey);
    let gets = 0;
    const app = createApp({ ...ctx.deps, blobs: { ...ctx.deps.blobs, get: async (k) => { gets++; return ctx.deps.blobs.get(k); } } });
    const r1 = await request(app, 'POST', '/vault', { cookie: o.analyst.cookie, form: { file: file(sameSize(99), 'new.png', 'image/png') } });
    expect(r1.status).toBe(201);
    expect(gets).toBe(5);
    const rows = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.orgId, o.orgId));
    expect(rows.find((x) => x.id === ids[0])!.contentSha256).toBe('missing');
    expect(rows.filter((x) => x.contentSha256 === null)).toHaveLength(2);
    // The next upload continues with the remaining unknown rows and catches the duplicate among them.
    gets = 0;
    const r2 = await request(app, 'POST', '/vault', { cookie: o.analyst.cookie, form: { file: file(sameSize(6), 'again.png', 'image/png') } });
    expect(r2.status).toBe(409);
    expect(r2.body.error.details.existingId).toBe(ids[6]);
    expect(gets).toBe(2);
  });

  it('a DB failure during replace removes the new blob and leaves the old file, row and versions untouched', async () => {
    const oldBytes = await pdf(1);
    const doc = await isoUpload('ISO doomed renewal', oldBytes, 'same.pdf');
    const [before] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.id));
    const written: string[] = [];
    const blobs: AppDeps['blobs'] = { ...ctx.deps.blobs, put: async (key, body, o) => { written.push(key); return ctx.deps.blobs.put(key, body, o); } };
    const db = new Proxy(ctx.db, {
      get(target, prop, recv) {
        if (prop === 'transaction') {
          return (fn: Parameters<typeof target.transaction>[0]) => target.transaction(async (tx) => {
            await fn(tx);
            throw new Error('simulated commit failure');
          });
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const app = createApp({ ...ctx.deps, db, blobs });
    const r = await request(app, 'PUT', `/vault/${doc.id}/file`, { cookie: r6.analyst.cookie, form: { file: file(await pdf(1), 'same.pdf'), expiryDate: '2029-11-13' } });
    expect(r.status).toBe(500);
    expect(written).toHaveLength(1);
    expect(written[0]).not.toBe(before!.blobKey);
    expect(await ctx.deps.blobs.head(written[0]!)).toBeNull();
    const [after] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, doc.id));
    expect(after).toEqual(before);
    expect(await versionsOf(doc.id)).toHaveLength(0);
    const cur = await request(ctx.app, 'GET', `/vault/${doc.id}/download`, { cookie: r6.viewer.cookie });
    expect(new Uint8Array(await cur.res.arrayBuffer())).toEqual(oldBytes);
  });
});

/**
 * T076 (#164; NFR-001, SC-005): tenant-isolation sweep. Every id-addressed vault / past-contract route, called by
 * the Owner of another org (highest role, so only the org predicate can stop it), answers 404 not_found and
 * leaves the victim's data untouched; list/summary/profile/reminder routes never reveal or touch it.
 */
describe('tenant isolation sweep — every vault and past-contract route (T076)', () => {
  type Opts = Parameters<typeof request>[3];
  let victim: Awaited<ReturnType<typeof seedOrgWithRoles>>;
  let intruder: Awaited<ReturnType<typeof signup>>;
  let docId: string;
  let contractId: string;
  let versionId: string;
  let intruderDocId: string;

  beforeAll(async () => {
    victim = await seedOrgWithRoles(ctx.app, 'Victim Isolation Traders');
    intruder = await signup(ctx.app, { orgName: 'Intruder Isolation Traders' });
    // Due for a 7-day reminder at NOW, so a leaking reminder run would visibly touch it.
    const up = await request(ctx.app, 'POST', '/vault', { cookie: victim.analyst.cookie, form: { file: file(await pdf(), 'iso.pdf'), type: 'iso', title: 'ISO 9001 victim', expiryDate: '2026-11-11' } });
    expect(up.status, up.text).toBe(201);
    docId = up.body.id;
    // Renew once so the document has a previous version (US6).
    const renew = await request(ctx.app, 'PUT', `/vault/${docId}/file`, { cookie: victim.analyst.cookie, form: { file: file(await pdf(3), 'iso-renewed.pdf') } });
    expect(renew.status, renew.text).toBe(200);
    const versions = await request(ctx.app, 'GET', `/vault/${docId}/versions`, { cookie: victim.viewer.cookie });
    expect(versions.body.items).toHaveLength(1);
    versionId = versions.body.items[0].id;
    const own = await request(ctx.app, 'POST', '/vault', { cookie: intruder.cookie, form: { file: file(await pdf(4), 'mine.pdf'), type: 'other', title: 'Intruder doc' } });
    expect(own.status, own.text).toBe(201);
    intruderDocId = own.body.id;
    const pc = await request(ctx.app, 'POST', '/past-contracts', { cookie: victim.analyst.cookie, json: { buyer: 'NIC', buyerType: 'central', title: 'Victim supply', value: 5_00_000, cracDocumentId: docId } });
    expect(pc.status, pc.text).toBe(201);
    contractId = pc.body.id;
  });

  const routes: [method: string, path: () => string, opts: () => Promise<Opts> | Opts, message: string][] = [
    ['GET', () => `/vault/${docId}`, () => ({}), 'Document not found'],
    ['PATCH', () => `/vault/${docId}`, () => ({ json: { title: 'Hijacked', expiryDate: '2030-01-01' } }), 'Document not found'],
    ['PUT', () => `/vault/${docId}/file`, () => ({ form: { file: file(PNG, 'evil.png', 'image/png') } }), 'Document not found'],
    ['DELETE', () => `/vault/${docId}`, () => ({}), 'Document not found'],
    ['GET', () => `/vault/${docId}/download`, () => ({}), 'Document not found'],
    ['GET', () => `/vault/${docId}/download?inline=1`, () => ({}), 'Document not found'],
    ['GET', () => `/vault/${docId}/versions`, () => ({}), 'Document not found'],
    ['GET', () => `/vault/${docId}/versions/${versionId}/download`, () => ({}), 'Document not found'],
    ['GET', () => `/vault/${docId}/versions/${versionId}/download?inline=1`, () => ({}), 'Document not found'],
    // The victim's version id under the intruder's own document: still not reachable.
    ['GET', () => `/vault/${intruderDocId}/versions/${versionId}/download`, () => ({}), 'Version not found'],
    ['PATCH', () => `/past-contracts/${contractId}`, () => ({ json: { value: 1 } }), 'Past contract not found'],
    ['DELETE', () => `/past-contracts/${contractId}`, () => ({}), 'Past contract not found'],
  ];

  it.each(routes.map(([m, p, o, msg]) => ({ name: `${m} ${p.toString().match(/`(.*)`/)?.[1]}`, m, p, o, msg })))('$name → 404 for another org', async ({ m, p, o, msg }) => {
    const r = await request(ctx.app, m, p(), { ...(await o()), cookie: intruder.cookie });
    expect(r.status, r.text).toBe(404);
    expect(r.body.error).toEqual({ code: 'not_found', message: msg });
  });

  it('list, summary, profile and reminder routes never reveal or touch the other org\'s data', async () => {
    // The intruder sees exactly its own document.
    const list = await request(ctx.app, 'GET', '/vault', { cookie: intruder.cookie });
    expect(list.body.items.map((d: { id: string }) => d.id)).toEqual([intruderDocId]);
    expect((await request(ctx.app, 'GET', `/vault?q=${encodeURIComponent('ISO 9001 victim')}`, { cookie: intruder.cookie })).body.total).toBe(0);
    expect((await request(ctx.app, 'GET', '/vault/summary', { cookie: intruder.cookie })).body).toMatchObject({ total: 1, expiring: 0, nextExpiries: [] });
    expect((await request(ctx.app, 'GET', '/past-contracts', { cookie: intruder.cookie })).body).toEqual({ items: [], total: 0 });
    expect((await request(ctx.app, 'GET', '/profile', { cookie: intruder.cookie })).body.profile.legalName).toBe('');
    const run = await request(ctx.app, 'POST', '/vault/reminders/run', { cookie: intruder.cookie });
    expect(run.status).toBe(200);
    expect(run.body).toEqual({ documents: 0, notifications: 0 });
    // Cross-org references are refused as "not in your vault", not linked.
    const pc = await request(ctx.app, 'POST', '/past-contracts', { cookie: intruder.cookie, json: { buyer: 'B', buyerType: 'central', title: 'T', value: 1000, cracDocumentId: docId } });
    expect(pc.status).toBe(400);
    const oem = await request(ctx.app, 'PUT', '/profile', { cookie: intruder.cookie, json: { oemAuthorizations: [{ oem: 'Dell', products: 'x', documentId: docId }] } });
    expect(oem.status).toBe(400);
  });

  it('the victim\'s document, file, contract and reminder state are untouched', async () => {
    const [row] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, docId));
    expect(row).toMatchObject({ orgId: victim.orgId, title: 'ISO 9001 victim', expiryDate: '2026-11-11', fileName: 'iso-renewed.pdf', pageCount: 3, mimeType: 'application/pdf', lastReminderDays: null });
    expect(await ctx.deps.blobs.head(row!.blobKey)).not.toBeNull();
    const versions = await request(ctx.app, 'GET', `/vault/${docId}/versions`, { cookie: victim.viewer.cookie });
    expect(versions.body.items).toEqual([expect.objectContaining({ id: versionId, fileName: 'iso.pdf' })]);
    const old = await request(ctx.app, 'GET', `/vault/${docId}/versions/${versionId}/download`, { cookie: victim.viewer.cookie });
    expect(old.status).toBe(200);
    const pcs = await request(ctx.app, 'GET', '/past-contracts', { cookie: victim.viewer.cookie });
    expect(pcs.body.items).toEqual([expect.objectContaining({ id: contractId, value: 5_00_000, cracDocumentId: docId })]);
    const notes = await ctx.db.select().from(notifications).where(eq(notifications.orgId, victim.orgId));
    expect(notes).toHaveLength(0);
  });
});
