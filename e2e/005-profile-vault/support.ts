/** Helpers for the 005/US3 vault E2E (kept out of e2e/support/fixtures.ts on purpose). */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

export const E2E_PORT = Number(process.env.E2E_PORT || 8788);
export const DB_URL = process.env.E2E_DATABASE_URL || `postgres://tp:tp@localhost:5433/${process.env.E2E_DB_NAME || 'tenderpilot_e2e'}`;
export const BLOB_ROOT = join(process.cwd(), '.data', `e2e-blobs-${E2E_PORT}`);
// pdf-lib is a dependency of apps/api (not of the repo root), so resolve it from there.
const { PDFDocument } = createRequire(join(process.cwd(), 'apps', 'api', 'package.json'))('pdf-lib') as { PDFDocument: { create(): Promise<{ addPage(size: [number, number]): { drawText(t: string, o: object): void }; save(): Promise<Uint8Array> }> } };

export const MB = 1024 * 1024;

/** A real PDF with `pages` pages (each stamped with `label` so different files differ). `makePdf(text)` = one page carrying `text` (US5). */
export async function makePdf(pagesOrText: number | string = 1, label = 'TenderPilot QA'): Promise<Buffer> {
  const [pages, text] = typeof pagesOrText === 'string' ? [1, pagesOrText] : [pagesOrText, label];
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pages; i++) doc.addPage([300, 200]).drawText(`${text} - page ${i}/${pages}`, { x: 20, y: 100, size: 12 });
  return Buffer.from(await doc.save());
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A genuine, decodable w x h PNG (solid teal) built from bytes. */
export function makePng(w = 64, h = 48): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [0x0f, 0x76, 0x6e]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** IST calendar date (YYYY-MM-DD) `offset` days from today. */
export function istDay(offset = 0): string {
  const base = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()) + 'T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

export interface UploadOpts { name: string; bytes: Buffer; mime?: string; fields?: Record<string, string> }
/** Raw multipart POST /api/vault (no UI). */
export async function apiUpload(request: APIRequestContext, o: UploadOpts) {
  return request.post('/api/vault', {
    multipart: { file: { name: o.name, mimeType: o.mime ?? 'application/pdf', buffer: o.bytes }, ...(o.fields ?? {}) },
  });
}
export async function apiUploadOk(request: APIRequestContext, o: UploadOpts) {
  const res = await apiUpload(request, o);
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as VaultDoc;
}

export interface VaultDoc {
  id: string; type: string; title: string; number: string | null; issuer: string | null; issueDate: string | null; expiryDate: string | null;
  financialYear: string | null; tags: string[]; fileName: string; mimeType: string; sizeBytes: number; pageCount: number | null;
  uploadedBy: { id: string; name: string } | null; status: string; daysToExpiry: number | null; downloadUrl: string; createdAt: string; updatedAt: string;
}

export async function me(request: APIRequestContext): Promise<{ user: { id: string; name: string }; org: { id: string } }> {
  const res = await request.get('/api/auth/me');
  expect(res.ok(), await res.text()).toBeTruthy();
  const j = await res.json();
  return { user: j.user, org: j.org ?? j.organization ?? { id: j.orgId } };
}

/** Files (not sidecars) stored under an org's vault blob prefix. */
export function blobFiles(orgId: string): string[] {
  const root = join(BLOB_ROOT, 'org', orgId, 'vault');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else if (!e.name.endsWith('.meta.json')) out.push(`${rel}${e.name}`);
    }
  };
  walk(root, '');
  return out.sort();
}

export function sql(query: string): string {
  return execFileSync('psql', [DB_URL, '-At', '-c', query], { encoding: 'utf8' }).trim();
}

/** Create a Viewer in the signed-in owner's org through the real invite flow; returns a page signed in as that viewer. */
export async function viewerPage(browser: Browser, owner: APIRequestContext, baseURL: string, viewport: { width: number; height: number } | null) {
  const email = `viewer.${Date.now().toString(36)}@example.in`;
  const inv = await owner.post('/api/org/invitations', { data: { email, role: 'viewer' } });
  expect(inv.status(), await inv.text()).toBe(201);
  const token = ((await inv.json()) as { inviteUrl: string }).inviteUrl.split('/invite/')[1]!;
  const ctx = await browser.newContext({ baseURL, timezoneId: 'Asia/Kolkata', locale: 'en-IN', ...(viewport ? { viewport } : {}) });
  const accepted = await ctx.request.post('/api/auth/accept-invite', { data: { token, name: 'Vera Viewer', password: 'Qa!pass12345' } });
  expect(accepted.ok(), await accepted.text()).toBeTruthy();
  return { ctx, page: await ctx.newPage(), request: ctx.request, email };
}

/** Dispatch a real drag-and-drop of a generated file onto `target` (browser-side File; `size` pads it for big files). */
export async function dropFile(target: Locator, file: { name: string; mime: string; bytes?: Buffer; size?: number }) {
  const data = file.bytes ? Array.from(file.bytes) : null;
  await target.evaluate((el, f) => {
    const content = f.data ? new Uint8Array(f.data) : new Uint8Array(f.size ?? 1);
    const dt = new DataTransfer();
    dt.items.add(new File([content], f.name, { type: f.mime }));
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { name: file.name, mime: file.mime, data, size: file.size });
}

/** No horizontal page scroll; on failure the message names the widest offending elements. */
export async function noHScroll(page: Page, soft = false) {
  const w = await page.evaluate(() => {
    const c = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll('body *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.right > c + 1)
      .sort((a, b) => b.r.right - a.r.right).slice(0, 5)
      .map(({ el, r }) => `<${el.tagName.toLowerCase()} class="${String(el.getAttribute('class') ?? '').slice(0, 80)}"> right=${Math.round(r.right)} "${(el.textContent ?? '').trim().slice(0, 40)}"`);
    return { s: document.documentElement.scrollWidth, c, offenders };
  });
  (soft ? expect.soft : expect)(w.s, `scrollWidth ${w.s} > clientWidth ${w.c}; offenders: ${w.offenders.join(' | ')}`).toBeLessThanOrEqual(w.c + 1);
}

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

// Distinct small PNG per upload: identical bytes in one org are refused as duplicates since US6 (FR-067).
let pngSeq = 0;
const uniquePng = () => makePng(1 + (++pngSeq % 500), 1);

export async function uploadDoc(page: Page, fields: { type: string; title: string; expiryDate?: string }) {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    file: { name: `${fields.type}.png`, mimeType: 'image/png', buffer: uniquePng() },
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
