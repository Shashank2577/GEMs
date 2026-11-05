import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { uniqueUser } from '../support/fixtures';

export type Role = 'viewer' | 'analyst' | 'bid_manager';

/**
 * Invite a second user into the SAME org as `owner` (POST /api/org/invitations, owner session) and accept the
 * invitation in a fresh browser context. Returns that context (authenticated) so tests can drive its page/request.
 */
export async function joinOrgAs(browser: Browser, ownerPage: Page, role: Role, baseURL: string): Promise<{ ctx: BrowserContext; email: string }> {
  const u = uniqueUser(role);
  const inv = await ownerPage.request.post('/api/org/invitations', { data: { email: u.email, role } });
  expect(inv.status(), await inv.text()).toBe(201);
  const { inviteUrl } = (await inv.json()) as { inviteUrl: string };
  const token = inviteUrl.split('/invite/')[1]!;
  const ctx = await browser.newContext({ baseURL, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  const acc = await ctx.request.post('/api/auth/accept-invite', { data: { token, name: u.name, password: u.password } });
  expect(acc.ok(), await acc.text()).toBeTruthy();
  return { ctx, email: u.email };
}

export const VALID_GSTIN = '27AAPFU0939F1ZV';
export const VALID_PAN = 'AAPFU0939F';


export const IDS = { legalName: 'Aarav Technologies Pvt Ltd', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F' };

/** Real "today" in IST as YYYY-MM-DD, plus N days. */
export function istDate(plusDays = 0): string {
  const base = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  base.setDate(base.getDate() + plusDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${base.getFullYear()}-${p(base.getMonth() + 1)}-${p(base.getDate())}`;
}

export async function getProfile(page: Page) {
  const r = await page.request.get('/api/profile');
  expect(r.status()).toBe(200);
  return r.json();
}

export async function putProfile(page: Page, data: unknown) {
  return page.request.put('/api/profile', { data });
}

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export async function uploadDoc(page: Page, fields: { type: string; title: string; expiryDate?: string }) {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    file: { name: `${fields.type}.png`, mimeType: 'image/png', buffer: PNG },
    type: fields.type, title: fields.title,
  };
  if (fields.expiryDate) multipart.expiryDate = fields.expiryDate;
  const r = await page.request.post('/api/vault', { multipart });
  expect(r.status(), await r.text()).toBe(201);
  return r.json();
}

export const FY3 = [
  { fy: '2025-26', turnover: 60_000_000, netWorth: 10_000_000, audited: true },
  { fy: '2024-25', turnover: 45_000_000, netWorth: 9_000_000, audited: true },
  { fy: '2023-24', turnover: 30_000_000, netWorth: 8_000_000, audited: true },
];

/** Org scoring 100% with zero issues (total weight 98): everything filled, 3 contracts, gst/pan/CA docs. */
export async function makeFullOrg(page: Page) {
  const r = await putProfile(page, {
    ...IDS, address: 'Office 402, Baner Road, Pune', state: 'Maharashtra', pincode: '411045', incorporationDate: '2016-03-14',
    miiClass: 'class_1', financials: FY3, categories: ['Desktop Computers'], hsnCodes: ['8471'], operatingStates: ['Maharashtra'],
    signatoryName: 'Ananya Kulkarni', signatoryDesignation: 'Director', contactEmail: 'bids@aaravtech.in', contactPhone: '9822012345',
  });
  expect(r.status(), await r.text()).toBe(200);
  for (let i = 0; i < 3; i++) {
    const c = await page.request.post('/api/past-contracts', { data: { buyer: `Buyer ${i}`, buyerType: 'central', title: `Supply ${i}`, value: 1_000_000 + i } });
    expect(c.status(), await c.text()).toBe(201);
  }
  await uploadDoc(page, { type: 'gst', title: 'GST certificate' });
  await uploadDoc(page, { type: 'pan', title: 'PAN card' });
  await uploadDoc(page, { type: 'ca_turnover_certificate', title: 'CA certificate' });
}

/** Org scoring 59% ("Good progress"): identity+address, 3 FYs, categories, contact, no docs/contracts/MII. */
export async function makeMidOrg(page: Page) {
  const r = await putProfile(page, {
    ...IDS, address: 'Office 402, Baner Road, Pune', state: 'Maharashtra', pincode: '411045', financials: FY3,
    categories: ['Desktop Computers'], signatoryName: 'Ananya Kulkarni', signatoryDesignation: 'Director',
    contactEmail: 'bids@aaravtech.in', contactPhone: '9822012345',
  });
  expect(r.status(), await r.text()).toBe(200);
}

export const ring = (page: Page, pct: number) => page.getByRole('img', { name: `Profile ${pct}% complete` }).first();

// ---- US5 helpers (PDF uploads, contract/OEM API shortcuts) ----
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('../../apps/api/node_modules/pdf-lib') as typeof import('../../apps/api/node_modules/pdf-lib');

/** A real one-page PDF (pdf-lib) carrying `text`. */
export async function makePdf(text: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  page.drawText(text, { x: 50, y: 780, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await pdf.save());
}

/** Upload a generated PDF through POST /api/vault; returns the created document DTO. */
export async function uploadPdf(page: Page, fields: { type: string; title: string; expiryDate?: string }) {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    file: { name: `${fields.title.replace(/\W+/g, '-').toLowerCase()}.pdf`, mimeType: 'application/pdf', buffer: await makePdf(fields.title) },
    type: fields.type, title: fields.title,
  };
  if (fields.expiryDate) multipart.expiryDate = fields.expiryDate;
  const r = await page.request.post('/api/vault', { multipart });
  expect(r.status(), await r.text()).toBe(201);
  return r.json() as Promise<{ id: string; type: string; title: string; expiryDate: string | null }>;
}

export async function addContract(page: Page, data: Record<string, unknown>) {
  const r = await page.request.post('/api/past-contracts', { data: { buyerType: 'central', ...data } });
  expect(r.status(), await r.text()).toBe(201);
  return r.json() as Promise<{ id: string; title: string; cracDocumentId: string | null; value: number }>;
}

/** Action names from the dashboard activity feed (newest first). */
export async function activityActions(page: Page): Promise<string[]> {
  const r = await page.request.get('/api/dashboard');
  expect(r.status()).toBe(200);
  return ((await r.json()) as { activity: { action: string }[] }).activity.map((a) => a.action);
}
