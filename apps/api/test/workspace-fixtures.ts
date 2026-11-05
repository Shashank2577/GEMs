/** Shared seed for the Apply API tests (workspace / packet / assist). */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { analyses, tenders, type ChecklistItem } from '@tp/db';
import { request, seedOrgWithRoles, type TestContext } from './helpers';

// 4 Nov 2026 10:00 IST
export const NOW = new Date('2026-11-04T04:30:00Z');

export async function pdf(label: string, pages = 1): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) d.addPage([595, 842]).drawText(`${label} page ${i + 1}`, { x: 40, y: 700, size: 14, font: f });
  return d.save();
}
export const file = (bytes: Uint8Array, name: string, type = 'application/pdf') => new File([bytes as BlobPart], name, { type });

export const CHECKLIST: ChecklistItem[] = [
  { id: 'gst', label: 'GST registration certificate', docType: 'gst', mandatory: true, reason: 'Seller identity' },
  { id: 'pan', label: 'PAN card of the firm', docType: 'pan', mandatory: true, reason: 'Seller identity' },
  { id: 'balance_sheets', label: 'Audited balance sheets — last 3 financial years', docType: 'balance_sheet', mandatory: true, reason: 'Turnover' },
  { id: 'oem_authorization', label: 'OEM authorisation certificate (MAF) for this bid', docType: 'oem_authorization', mandatory: true, reason: 'OEM' },
  { id: 'udyam', label: 'Udyam registration certificate (MSE)', docType: 'udyam', mandatory: false, reason: 'MSE preference' },
  { id: 'non_blacklisting', label: 'Non-blacklisting / non-debarment undertaking', docType: null, mandatory: true, reason: 'ATC', generated: 'non_blacklisting' },
  { id: 'mii_self_cert', label: 'Make in India self-certificate (local content %)', docType: null, mandatory: true, reason: 'MII', generated: 'mii_self_cert' },
];

export async function seedTender(ctx: TestContext, n = 1) {
  const [t] = await ctx.db.insert(tenders).values({
    bidNumber: `GEM/2026/B/70000${n}`, title: `Supply of Laptops batch ${n}`, category: 'Laptop - Notebook', quantity: 40,
    ministry: 'Ministry of Petroleum and Natural Gas', department: 'Department of Petroleum', organisation: 'Indian Oil Corporation Limited',
    buyerOffice: 'Panipat Refinery', state: 'Haryana', startAt: new Date('2026-11-01T04:30:00Z'), endAt: new Date('2026-11-20T09:30:00Z'),
    emdAmount: 150000, estimatedValue: 3_200_000, items: [{ name: 'Laptop i5 16GB', quantity: 40, unit: 'nos' }],
    sourceUrl: 'https://bidplus.gem.gov.in/all-bids', contentHash: `h${n}`,
  }).returning();
  return t;
}

export async function seedAnalysis(ctx: TestContext, orgId: string, tenderId: string, checklist = CHECKLIST) {
  const [a] = await ctx.db.insert(analyses).values({
    orgId, tenderId, status: 'done', method: 'rules', checklist, score: 78, confidence: 0.8, verdict: 'go',
    requirements: [{ key: 'delivery_days', label: 'Delivery days', numeric: 30, value: 30, mandatory: true, source: { page: 1 }, method: 'RULE', confidence: 0.9 }],
    factors: [],
  }).returning();
  return a;
}

export async function upload(ctx: TestContext, cookie: string, name: string, fields: Record<string, string>, pages = 1) {
  const r = await request(ctx.app, 'POST', '/vault', { cookie, form: { file: file(await pdf(name.toUpperCase(), pages), `${name}.pdf`), ...fields } });
  if (r.status !== 201) throw new Error(`upload ${name} failed: ${r.status} ${r.text}`);
  return r.body as { id: string };
}

/** Org with all roles, a complete profile, a tender with a "go" analysis and vault documents (OEM MAF expired). */
export async function seedApply(ctx: TestContext) {
  const org = await seedOrgWithRoles(ctx.app);
  const p = await request(ctx.app, 'PUT', '/profile', {
    cookie: org.owner.cookie,
    json: {
      legalName: 'Sharma Infotech Pvt Ltd', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F', address: '12 MIDC, Andheri East', state: 'Maharashtra', pincode: '400093',
      mseCategory: 'small', udyamNumber: 'UDYAM-MH-19-0012345', miiClass: 'class_1', localContentPct: 62,
      signatoryName: 'Ravi Sharma', signatoryDesignation: 'Director', contactName: 'Ravi Sharma', contactEmail: 'bids@sharma.in', contactPhone: '+919812345678',
      oemAuthorizations: [{ oem: 'Dell', products: 'Laptops' }],
    },
  });
  if (p.status !== 200) throw new Error(`profile failed: ${p.status} ${p.text}`);
  const tender = await seedTender(ctx);
  const analysis = await seedAnalysis(ctx, org.orgId, tender.id);
  const docs = {
    gst: await upload(ctx, org.analyst.cookie, 'gst', { type: 'gst', title: 'GST REG-06' }),
    pan: await upload(ctx, org.analyst.cookie, 'pan', { type: 'pan', title: 'PAN card' }),
    bsOld: await upload(ctx, org.analyst.cookie, 'bs-2023', { type: 'balance_sheet', title: 'Balance sheet 2023-24', financialYear: '2023-24' }, 2),
    bsNew: await upload(ctx, org.analyst.cookie, 'bs-2024', { type: 'balance_sheet', title: 'Balance sheet 2024-25', financialYear: '2024-25' }, 3),
    oem: await upload(ctx, org.analyst.cookie, 'maf', { type: 'oem_authorization', title: 'Dell MAF', issueDate: '2025-09-01', expiryDate: '2026-10-01' }),
  };
  return { org, tender, analysis, docs };
}
