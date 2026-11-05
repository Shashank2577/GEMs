/** Helpers for the 005/US3 vault E2E (kept out of e2e/support/fixtures.ts on purpose). */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { expect, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';

export const E2E_PORT = Number(process.env.E2E_PORT || 8788);
export const DB_URL = process.env.E2E_DATABASE_URL || `postgres://tp:tp@localhost:5433/${process.env.E2E_DB_NAME || 'tenderpilot_e2e'}`;
export const BLOB_ROOT = join(process.cwd(), '.data', `e2e-blobs-${E2E_PORT}`);
// pdf-lib is a dependency of apps/api (not of the repo root), so resolve it from there.
const { PDFDocument } = createRequire(join(process.cwd(), 'apps', 'api', 'package.json'))('pdf-lib') as { PDFDocument: { create(): Promise<{ addPage(size: [number, number]): { drawText(t: string, o: object): void }; save(): Promise<Uint8Array> }> } };

export const MB = 1024 * 1024;

/** A real PDF with `pages` pages (each stamped with `label` so different files differ). */
export async function makePdf(pages = 1, label = 'TenderPilot QA'): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pages; i++) doc.addPage([300, 200]).drawText(`${label} - page ${i}/${pages}`, { x: 20, y: 100, size: 12 });
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
