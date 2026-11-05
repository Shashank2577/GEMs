/** Profile & Vault API (T055; FR-020–FR-022, US3 acceptance 1–4). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { activityLog, companyProfiles, notifications, vaultDocuments } from '@tp/db';
import { createApp } from '../src/app';
import type { AppDeps } from '../src/deps';
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
    const ascii = cd.match(/filename="([^"]*)"/)![1]!;
    expect(ascii).toMatch(/^[\x20-\x7e]+\.pdf$/);
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('प्रमाणपत्र.pdf')}`);
    expect(d.headers.get('cache-control')).toBe('private, no-store');
    expect(d.headers.get('x-content-type-options')).toBe('nosniff');
    expect(d.headers.get('content-length')).toBe(String(bytes.length));
    expect(new Uint8Array(await d.res.arrayBuffer())).toEqual(bytes);

    const inline = await request(ctx.app, 'GET', `/vault/${up.body.id}/download?inline=1`, { cookie: b.viewer.cookie });
    expect(inline.headers.get('content-disposition')).toMatch(/^inline; filename="[\x20-\x7e]+\.pdf"; filename\*=UTF-8''/);
    expect(inline.headers.get('cache-control')).toBe('private, no-store');
    expect(inline.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('replacing a PDF with a PNG deletes the old blob and updates mime type and page count (FR-032)', async () => {
    const up = await request(ctx.app, 'POST', '/vault', { cookie: b.analyst.cookie, form: { file: file(await pdf(4), 'udyam.pdf'), type: 'udyam', title: 'Udyam certificate', number: 'UDYAM-MH-26-0123456' } });
    expect(up.body.pageCount).toBe(4);
    const [before] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, up.body.id));
    const r = await request(ctx.app, 'PUT', `/vault/${up.body.id}/file`, { cookie: b.analyst.cookie, form: { file: file(PNG, 'udyam-scan.png', 'image/png') } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ fileName: 'udyam-scan.png', mimeType: 'image/png', pageCount: 1, sizeBytes: PNG.length, type: 'udyam', title: 'Udyam certificate', number: 'UDYAM-MH-26-0123456' });
    const [after] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, up.body.id));
    expect(after!.blobKey).not.toBe(before!.blobKey);
    expect(await ctx.deps.blobs.head(before!.blobKey)).toBeNull();
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
    const db = new Proxy(ctx.db, {
      get(target, prop, recv) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === vaultDocuments) throw new Error('simulated insert failure');
            return target.insert(table as typeof vaultDocuments);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
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

  it('IST boundary: at 2026-11-05T20:00Z (01:30 IST on the 6th) a document expiring 2026-11-05 is expired (FR-042)', async () => {
    const g = await seedOrgWithRoles(ctx.app, 'Midnight Traders');
    const id = await upload(g.analyst, 'ISO 14001 Midnight', '2026-11-05');
    try {
      // 23:30 IST on the 5th: still valid on its expiry date.
      ctx.clock.set(new Date('2026-11-05T18:00:00Z'));
      expect((await request(ctx.app, 'GET', `/vault/${id}`, { cookie: g.viewer.cookie })).body).toMatchObject({ status: 'expiring', daysToExpiry: 0 });

      ctx.clock.set(new Date('2026-11-05T20:00:00Z'));
      const doc = await request(ctx.app, 'GET', `/vault/${id}`, { cookie: g.viewer.cookie });
      expect(doc.body).toMatchObject({ status: 'expired', daysToExpiry: -1, nextReminder: null });
      const r = await runExpiryReminders(ctx.deps, { orgId: g.orgId });
      expect(r.documents).toBe(1);
      expect(await lastReminder(id)).toBe(0);
      const rows = await expiryRows(id);
      const inApp = rows.filter((n) => n.channel === 'in_app');
      expect(inApp.length).toBeGreaterThan(0);
      expect(inApp.every((n) => n.title === 'ISO 14001 Midnight has expired')).toBe(true);
      expect(inApp[0]!.body).toBe('Your ISO certificate "ISO 14001 Midnight" expired 1 day ago. Bids that need it will be blocked from "Ready to submit" until you upload the renewed copy.');
      expect(rows.every((n) => n.dedupeKey === `expiry:${id}:2026-11-05:0`)).toBe(true);
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
