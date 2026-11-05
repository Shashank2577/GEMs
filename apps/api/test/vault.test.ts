/** Profile & Vault API (T055; FR-020–FR-022, US3 acceptance 1–4). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { activityLog, notifications, vaultDocuments } from '@tp/db';
import { runExpiryReminders } from '../src/services/reminders';
import { createTestContext, request, seedOrgWithRoles, signup, type TestContext } from './helpers';

// 4 Nov 2026 10:00 IST
const NOW = new Date('2026-11-04T04:30:00Z');

async function pdf(pages = 2): Promise<Uint8Array> {
  const d = await PDFDocument.create();
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
      const loaded = (await request(ctx.app, 'GET', '/profile', { cookie: org.analyst.cookie })).body.profile.updatedAt as string;
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
      const after = (await request(ctx.app, 'GET', '/profile', { cookie: org.viewer.cookie })).body.profile;
      expect(after.tradeName).toBe('Sharma IT Solutions');
      expect(after.updatedAt).toBe('2026-11-04T09:15:00.000Z');
      // null means "no profile saved yet" and therefore also conflicts with an existing row.
      expect((await request(ctx.app, 'PUT', '/profile', { cookie: org.analyst.cookie, json: { tradeName: 'X', expectedUpdatedAt: null } })).status).toBe(409);
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
