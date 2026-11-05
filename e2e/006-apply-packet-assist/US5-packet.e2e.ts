/**
 * Spec 006 / US5 (#186): build one merged, bookmarked packet for the GeM technical upload.
 * QA task T066 (#259). Scenarios 1-15 of the spec (S1..S15 in the test names), FR-045..FR-060, SC-001, SC-005.
 *
 * PDF assertions: system poppler (`pdftotext`, `pdfinfo`, `pdfimages`, `pdftoppm`) for text / page counts / images, pdf-lib
 * (the API's copy, no new dependency) for the outline and the index link annotations.
 * axe: @axe-core/playwright is installed -> `a11y()` runs on the Packet step.
 *
 * Direct DB / blob-store access (documented in VERDICT.md "Not checked / method"): vault/tender-document rows and blob files are
 * manipulated only to create states the public API cannot produce: corrupt stored files, stored-size values above the 60 MB
 * input cap, a `building` row that is 11 minutes old, a storage write fault, 50+ history rows, a bid document.
 */
import { test, expect, evidence, collectRunArtifacts, a11y, noHorizontalOverflow } from '../support/fixtures';
import { seedApplyFixture, newApi, apiAs, signInAs, createWorkspace, upload, pdfBytes, E2E_DB_URL, E2E_PORT, type ApplyFixture, type Role } from '../support/seed-apply';
import { createNodeDb, packets, tenderDocuments, vaultDocuments } from '../../packages/db/src/index';
import type { Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomFillSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const req = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFHexString, PDFString } = req('../../apps/api/node_modules/pdf-lib') as typeof import('../../apps/api/node_modules/pdf-lib');
const { eq } = req('../../packages/db/node_modules/drizzle-orm') as typeof import('../../packages/db/node_modules/drizzle-orm');

const SPEC = '006';
const STORY = 'US5';
const EVID_DIR = join('qa', 'evidence', SPEC, STORY);
const BLOBS = resolve('.data', `e2e-blobs-${E2E_PORT}`);
const MB = 1024 * 1024;
const BID = 'GEM/2026/B/700001';
const FILE = 'GEM_2026_B_700001_technical_packet.pdf';

const DEFAULT_TITLES = [
  'Cover page & index',
  'Covering Letter for Technical Bid',
  'Undertaking regarding Non-Blacklisting / Non-Debarment',
  'Self-Certificate of Local Content (Make in India)',
  'GST registration certificate',
  'PAN card of the firm',
  'Audited balance sheets — last 3 financial years',
  'OEM authorisation certificate (MAF) for this bid',
];
const MAF_TITLE = 'OEM authorisation certificate (MAF) for this bid';

const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const toastWith = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text });

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

// ───────────── lazy per-worker fixtures ─────────────
interface Ctx { fx: ApplyFixture; ws: string }
const memo = new Map<string, Promise<unknown>>();
function lazy<T>(key: string, make: () => Promise<T>): Promise<T> {
  if (!memo.has(key)) memo.set(key, make());
  return memo.get(key) as Promise<T>;
}
async function mk(): Promise<Ctx> {
  const a = await newApi();
  const fx = await seedApplyFixture(a);
  await a.dispose();
  const ws = (await createWorkspace(fx)).id;
  return { fx, ws };
}
const named = (k: string) => lazy<Ctx>(k, mk);

async function db<T>(fn: (d: Awaited<ReturnType<typeof createNodeDb>>['db']) => Promise<T>): Promise<T> {
  const { db: d, close } = await createNodeDb(E2E_DB_URL);
  try { return await fn(d); } finally { await close(); }
}

async function call(fx: ApplyFixture, role: Role, method: 'get' | 'post' | 'put' | 'patch', path: string, data?: unknown) {
  const api = await apiAs(fx, role);
  const r = await api[method](path, data === undefined ? undefined : { data });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  const out = { status: r.status(), body, headers: r.headers() };
  await api.dispose();
  return out;
}
const detail = async (c: Ctx, role: Role = 'analyst') => (await call(c.fx, role, 'get', `/api/workspaces/${c.ws}`)).body;
const buildApi = (c: Ctx, items?: unknown[], role: Role = 'analyst') => call(c.fx, role, 'post', `/api/workspaces/${c.ws}/packets`, items ? { items } : {});

async function getBytes(fx: ApplyFixture, role: Role, path: string) {
  const api = await apiAs(fx, role);
  const r = await api.get(path);
  const out = { status: r.status(), headers: r.headers(), body: Buffer.from(await r.body()) };
  await api.dispose();
  return out;
}

async function openPacket(page: Page, context: any, c: Ctx, role: Role = 'analyst') {
  await signInAs(context, c.fx, role);
  await page.goto(`/workspaces/${c.ws}?step=packet`);
  await expect(page.getByRole('heading', { name: 'Packet contents' })).toBeVisible();
}
const list = (page: Page) => page.getByRole('list', { name: 'Documents in the packet, in order' });
const rowTitles = async (page: Page) => (await list(page).locator('li div.truncate.font-medium').allTextContents()).map((s) => s.trim());
const summary = (page: Page) => page.getByText('Estimated size').locator('xpath=../../..');

// ───────────── PDF helpers ─────────────
function tmpFile(bytes: Buffer, ext = '.pdf') {
  const dir = mkdtempSync(join(tmpdir(), 'us5-'));
  const f = join(dir, `a${ext}`);
  writeFileSync(f, bytes);
  return { dir, f };
}
function pdfInfo(bytes: Buffer, page?: number): string {
  const { f } = tmpFile(bytes);
  return execFileSync('pdfinfo', page ? ['-f', String(page), '-l', String(page), f] : [f]).toString();
}
const pdfPageCount = (b: Buffer) => Number(/Pages:\s+(\d+)/.exec(pdfInfo(b))![1]);
/** Text of every page (split on form feed). */
function pdfPagesText(bytes: Buffer): string[] {
  const out = execFileSync('pdftotext', ['-layout', '-', '-'], { input: bytes, maxBuffer: 50_000_000 }).toString('utf8');
  const pages = out.split('\f');
  if (pages[pages.length - 1].trim() === '') pages.pop();
  return pages;
}
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
function rasterise(bytes: Buffer, name: string, n: number, dpi = 60) {
  mkdirSync(EVID_DIR, { recursive: true });
  const { dir, f } = tmpFile(bytes);
  execFileSync('pdftoppm', ['-png', '-r', String(dpi), '-f', String(n), '-l', String(n), '-singlefile', f, join(dir, 'out')]);
  copyFileSync(join(dir, 'out.png'), join(EVID_DIR, `${name}.png`));
}
async function outlineTitles(bytes: Buffer): Promise<{ titles: string[]; pageMode: string | null }> {
  const doc = await PDFDocument.load(bytes);
  const ctx = doc.context;
  const root = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict);
  const titles: string[] = [];
  let ref = root.get(PDFName.of('First'));
  while (ref instanceof PDFRef) {
    const d = ctx.lookup(ref, PDFDict);
    const t = d.get(PDFName.of('Title')) as any;
    titles.push(t instanceof PDFHexString || t instanceof PDFString ? t.decodeText() : String(t));
    ref = d.get(PDFName.of('Next'));
  }
  return { titles, pageMode: doc.catalog.get(PDFName.of('PageMode'))?.toString() ?? null };
}
/** Link annotations of page `pageNo` (1-based) -> 1-based destination page numbers. */
async function linkTargets(bytes: Buffer, pageNo: number): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  const annots = pages[pageNo - 1].node.lookup(PDFName.of('Annots'), PDFArray);
  const out: number[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const a = annots.lookup(i, PDFDict);
    if (a.get(PDFName.of('Subtype'))?.toString() !== '/Link') continue;
    const dest = a.lookup(PDFName.of('Dest'), PDFArray);
    const target = dest.get(0) as import('../../apps/api/node_modules/pdf-lib').PDFRef;
    out.push(pages.findIndex((p) => p.ref.toString() === target.toString()) + 1);
  }
  return out;
}

/** A valid PDF page carrying `bytes` of incompressible junk, so the merged output is genuinely large. */
async function bigPdf(bytes: number): Promise<Buffer> {
  const d = await PDFDocument.create();
  const p = d.addPage([595, 842]);
  const junk = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 65536) randomFillSync(junk.subarray(i, Math.min(bytes, i + 65536)));
  p.node.set(PDFName.of('Junk'), d.context.register(d.context.stream(junk)));
  return Buffer.from(await d.save({ useObjectStreams: false }));
}

async function uploadRaw(fx: ApplyFixture, name: string, buffer: Buffer, mimeType: string, fields: Record<string, string>) {
  const api = await apiAs(fx, 'analyst');
  const r = await api.post('/api/vault', { multipart: { file: { name, mimeType, buffer }, ...fields } });
  const text = await r.text();
  expect(r.status(), text).toBe(201);
  await api.dispose();
  return JSON.parse(text).id as string;
}
async function vaultBlobKey(id: string) {
  return db(async (d) => (await d.select().from(vaultDocuments).where(eq(vaultDocuments.id, id)))[0].blobKey);
}
async function overwriteBlob(id: string, bytes: Buffer) {
  const key = await vaultBlobKey(id);
  writeFileSync(join(BLOBS, key), bytes);
}

// ═════════════ S1 ═════════════
test('S1 default contents: 8 rows in order, Documents 8, Pages 11, green bar, Add more lists annexures/vault/bid docs', async ({ page, context }) => {
  const c = await lazy('main', async () => {
    const m = await mk();
    // a tender "bid document" (no public API for these): row + blob file
    const key = `org/${m.fx.orgId}/tender-docs/bid-doc-e2e.pdf`;
    mkdirSync(dirname(join(BLOBS, key)), { recursive: true });
    const bytes = await pdfBytes('BID DOC', 2);
    writeFileSync(join(BLOBS, key), bytes);
    await db((d) => d.insert(tenderDocuments).values({ tenderId: m.fx.tender.id, orgId: m.fx.orgId, kind: 'bid', fileName: 'GeM-Bidding-Document-E2E.pdf', blobKey: key, sizeBytes: bytes.length, pageCount: 2 }));
    return m;
  });
  await openPacket(page, context, c);
  expect(await rowTitles(page)).toEqual(DEFAULT_TITLES);
  await expect(summary(page).getByText('Documents', { exact: true }).locator('xpath=..')).toContainText('8');
  await expect(summary(page).getByText('Pages (est.)').locator('xpath=..')).toContainText('11');
  await expect(summary(page)).toContainText(/Estimated size\s*\d[\d.,]* ?(B|KB|MB)\s*\/ 20 MB/);
  await expect(summary(page).locator('[role="progressbar"] > div')).toHaveClass(/bg-success/);
  await expect(page.getByRole('button', { name: 'Default order' })).toHaveCount(0);
  // Add more
  const more = page.getByRole('heading', { name: 'Add more' }).locator('xpath=../..');
  await expect(more).toBeVisible();
  await expect(more.getByRole('button', { name: 'Add Balance sheet 2023-24' })).toBeVisible();
  await expect(more.getByRole('button', { name: 'Add GeM-Bidding-Document-E2E.pdf' })).toBeVisible();
  await expect(more.getByRole('button', { name: /Add .*Technical Compliance/i })).toBeVisible();
  await expect(more.getByRole('button', { name: /Request for/i })).toHaveCount(0);   // MAF request letter excluded
  await expect(more.getByText('Request for', { exact: false })).toHaveCount(0);
  const addLabels = await more.getByRole('button', { name: /^Add / }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  test.info().annotations.push({ type: 'add-more', description: addLabels.join(' | ') });
  // API agrees
  const d = await detail(c);
  expect(d.defaultPacketItems.map((i: any) => i.title)).toEqual(DEFAULT_TITLES);
  expect(d.defaultPacketItems.map((i: any) => i.kind)).toEqual(['cover', 'annexure', 'annexure', 'annexure', 'vault', 'vault', 'vault', 'vault']);
  expect(d.annexures.map((a: any) => a.key)).toContain('oem_auth_request');
  await shot(page, 'S1-default-contents');
});

// ═════════════ S2 ═════════════
test('S2 reorder by drag, Move up arrow and keyboard; Default order appears; order survives reload', async ({ page, context }) => {
  const c = await named('main');
  await openPacket(page, context, c);
  const gstGrip = page.getByRole('button', { name: 'Reorder GST registration certificate' });
  const panGrip = page.getByRole('button', { name: 'Reorder PAN card of the firm' });
  // (a) drag PAN above GST
  const g = (await gstGrip.boundingBox())!, p = (await panGrip.boundingBox())!;
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2 - 10, { steps: 4 });
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 8, { steps: 12 });
  await page.mouse.up();
  let titles = await rowTitles(page);
  expect(titles.indexOf('PAN card of the firm'), `after drag: ${titles.join(' | ')}`).toBeLessThan(titles.indexOf('GST registration certificate'));
  await expect(page.getByRole('button', { name: 'Default order' })).toBeVisible();
  await shot(page, 'S2-after-drag-default-order-button');
  // (b) reload keeps the order (same browser)
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Packet contents' })).toBeVisible();
  titles = await rowTitles(page);
  expect(titles.indexOf('PAN card of the firm')).toBeLessThan(titles.indexOf('GST registration certificate'));
  await expect(page.getByRole('button', { name: 'Default order' })).toBeVisible();
  await expect(page.getByText('Unsaved order on this device')).toBeVisible();
  await shot(page, 'S2-order-survives-reload');
  // (c) Default order resets
  await page.getByRole('button', { name: 'Default order' }).click();
  expect(await rowTitles(page)).toEqual(DEFAULT_TITLES);
  await expect(page.getByRole('button', { name: 'Default order' })).toHaveCount(0);
  // (d) Move up arrow on PAN
  await page.getByRole('button', { name: 'Move PAN card of the firm up' }).click();
  titles = await rowTitles(page);
  expect(titles.slice(4, 6)).toEqual(['PAN card of the firm', 'GST registration certificate']);
  await expect(page.getByRole('button', { name: 'Default order' })).toBeVisible();
  await page.getByRole('button', { name: 'Default order' }).click();
  expect(await rowTitles(page)).toEqual(DEFAULT_TITLES);
  // (e) keyboard on the grip: Space, ArrowUp, Space
  await panGrip.focus();
  await page.keyboard.press('Space');
  // wait for the keyboard sensor to pick the row up (and, since 006/HARDEN, announce it) before moving it
  await expect(panGrip).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(300); // let the sortable transition settle so the drop lands on the new slot
  await page.keyboard.press('Space');
  await expect.poll(async () => (await rowTitles(page)).slice(4, 6), { message: 'keyboard reorder' }).toEqual(['PAN card of the firm', 'GST registration certificate']);
  await expect(page.getByRole('button', { name: 'Default order' })).toBeVisible();
  await shot(page, 'S2-after-keyboard');
  await page.getByRole('button', { name: 'Default order' }).click();
});

// ═════════════ S3 ═════════════
test('S3 remove/add update counters; empty list shows "Nothing in the packet" and disables Build', async ({ page, context }) => {
  const c = await named('main');
  await openPacket(page, context, c);
  const docs = () => summary(page).getByText('Documents', { exact: true }).locator('xpath=..');
  const pages = () => summary(page).getByText('Pages (est.)').locator('xpath=..');
  await page.getByRole('button', { name: 'Remove PAN card of the firm' }).click();
  await expect(docs()).toContainText('7');
  await expect(pages()).toContainText('10');
  await page.getByRole('button', { name: 'Add Balance sheet 2023-24' }).click();
  await expect(docs()).toContainText('8');
  await expect(pages()).toContainText('12');   // +2 pages (2023-24 has 2 pages), -1 for PAN
  expect(await rowTitles(page)).toContain('Balance sheet 2023-24');
  await shot(page, 'S3-removed-and-added');
  // remove everything
  while ((await list(page).locator('li').count()) > 0) await page.getByRole('button', { name: /^Remove / }).first().click();
  await expect(page.getByText('Nothing in the packet')).toBeVisible();
  await expect(page.getByText('Add documents from the list below.')).toBeVisible();
  await expect(page.getByRole('button', { name: /(Re)?build packet/i })).toBeDisabled();
  await expect(docs()).toContainText('0');
  await shot(page, 'S3-empty-build-disabled');
  await page.getByRole('button', { name: 'Default order' }).click();
  expect(await rowTitles(page)).toEqual(DEFAULT_TITLES);
});

// ═════════════ S4 ═════════════
test('S4 Build: progress texts in the live region, 201 ready (11 pages, start pages), toast, latest card with warnings + buttons', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = await named('main');
  await openPacket(page, context, c);
  await page.route('**/api/workspaces/*/packets', async (route) => {
    if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 4200));   // slow the call so every phase text is observable
    await route.continue();
  });
  const respP = page.waitForResponse((r) => /\/api\/workspaces\/[^/]+\/packets$/.test(r.url()) && r.request().method() === 'POST', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Build packet' }).click();
  // exclude the global offline banner (007/US7), which is also a polite status region
  const live = page.locator('div[role="status"][aria-live="polite"]:not([data-testid="offline-banner"])');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  const seen: string[] = [];
  for (const t of ['Rendering annexures…', 'Merging documents…', 'Writing index & bookmarks…', 'Saving the packet…']) {
    await expect(live).toContainText(t, { timeout: 6_000 });
    seen.push(t);
    if (t.startsWith('Merging')) await shot(page, 'S4-building-live-region');
  }
  test.info().annotations.push({ type: 'live-region', description: seen.join(' -> ') });
  const resp = await respP;
  expect(resp.status()).toBe(201);
  const body = await resp.json();
  expect(body.status).toBe('ready');
  expect(body.pageCount).toBe(11);
  expect(body.items.map((i: any) => i.startPage)).toEqual([1, 3, 4, 5, 6, 7, 8, 11]);
  expect(body.downloadUrl).toBe(`/api/packets/${body.id}/download`);
  expect(body.warnings).toHaveLength(2);
  await page.unroute('**/api/workspaces/*/packets');
  // toast
  const toast = toastWith(page, 'Packet ready — 11 pages');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('2 warnings to review');
  await shot(page, 'S4-toast-and-latest-card');
  // latest card
  const cardEl = page.getByText('Latest packet is ready').locator('xpath=../../..');
  await expect(cardEl).toBeVisible();
  await expect(cardEl).toContainText(c.fx.users.analyst.name);
  await expect(cardEl).toContainText('just now');
  await expect(cardEl).toContainText('11 pages');
  await expect(cardEl).toContainText(/\d+(\.\d+)? (KB|MB)/);
  await expect(cardEl).toContainText(`${MAF_TITLE}: the vault document has expired — replace it or ask a Bid Manager to override.`);
  await expect(cardEl).toContainText(`“${MAF_TITLE}” uses an expired document (Dell MAF).`.replace(/[“”]/g, '"'));
  await expect(cardEl.getByRole('link', { name: 'Download PDF' })).toBeVisible();
  await expect(cardEl.getByRole('link', { name: 'Open' })).toBeVisible();
  await expect(cardEl.getByRole('button', { name: /Submit step/ })).toBeVisible();
  // the draft is dropped after a successful build
  expect(await page.evaluate((k) => localStorage.getItem(k), `tp:packet-order:${c.ws}`)).toBeNull();
  // download through the UI link
  const dl = page.waitForEvent('download');
  await cardEl.getByRole('link', { name: 'Download PDF' }).click();
  expect((await dl).suggestedFilename()).toBe(FILE);
  await shot(page, 'S4-latest-card-warnings-buttons');
  // Submit step navigates
  await cardEl.getByRole('button', { name: /Submit step/ }).click();
  await expect(page).toHaveURL(/step=submit/);
});

// ═════════════ S5 ═════════════
test('S5 build from Go moves the stage to Preparing (activity "after building the packet"); later builds do not change the stage', async ({ page, context }) => {
  const c = await named('main');
  const d = await detail(c);
  expect(d.workspace.stage).toBe('preparing');
  const acts = d.activity as any[];
  const built = acts.find((a) => a.action === 'workspace.packet_built');
  expect(built?.meta.pageCount).toBe(11);
  const moved = acts.find((a) => a.action === 'workspace.stage_changed' && a.meta.to === 'preparing');
  expect(moved?.meta).toMatchObject({ from: 'go', to: 'preparing', auto: true });
  await openPacket(page, context, c);
  await expect(page.getByText('built the packet (11 pages)').first()).toBeVisible();
  await expect(page.getByText('moved it from Go to Preparing (after building the packet)').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Preparing/ }).or(page.getByText('Preparing', { exact: true })).first()).toBeVisible();
  await shot(page, 'S5-stage-preparing-activity');
  // a further build leaves the stage (and adds no second auto move)
  const r2 = await buildApi(c);
  expect(r2.status).toBe(201);
  const d2 = await detail(c);
  expect(d2.workspace.stage).toBe('preparing');
  expect((d2.activity as any[]).filter((a) => a.action === 'workspace.stage_changed' && a.meta.auto).length).toBe(1);
});

// ═════════════ S6 ═════════════
test('S6 download: headers, 11 pages, cover, index + links, outline, footer, blob key; saves packet.pdf', async ({ page, context }) => {
  const c = await named('main');
  const d = await detail(c);
  const latestId = d.packets[d.packets.length - 1].id as string;   // oldest = the UI build (11 pages)
  const first = d.packets.find((p: any) => p.id === latestId);
  expect(first.pageCount).toBe(11);
  const url = `/api/packets/${latestId}/download`;
  const r = await getBytes(c.fx, 'analyst', url);
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toBe('application/pdf');
  // spec text (pre-FR-059): attachment; filename="..." ; this PR adds the RFC 5987 filename* parameter (FR-059)
  expect(r.headers['content-disposition']).toBe(`attachment; filename="${FILE}"; filename*=UTF-8''${FILE}`);
  expect(r.headers['content-disposition']).toContain(`attachment; filename="${FILE}"`);
  expect(r.headers['cache-control']).toBe('private, no-store');
  expect(r.headers['x-content-type-options']).toBe('nosniff');
  const inl = await getBytes(c.fx, 'analyst', `${url}?inline=1`);
  expect(inl.headers['content-disposition']).toBe(`inline; filename="${FILE}"; filename*=UTF-8''${FILE}`);
  expect(r.body.subarray(0, 5).toString()).toBe('%PDF-');
  mkdirSync(EVID_DIR, { recursive: true });
  writeFileSync(join(EVID_DIR, 'packet.pdf'), r.body);
  expect(pdfPageCount(r.body)).toBe(11);

  const texts = pdfPagesText(r.body);
  expect(texts).toHaveLength(11);
  // cover
  const cover = flat(texts[0]);
  for (const s of ['TECHNICAL BID PACKET', 'Supply of Laptops batch 1', `Bid No. ${BID}`, 'BUYER', 'Indian Oil Corporation Limited', 'BID CLOSES', 'BIDDER', 'Sharma Infotech Pvt Ltd',
    'GSTIN', '27AAPFU0939F1ZV', 'PAN', 'AAPFU0939F', 'ADDRESS', '12 MIDC, Andheri East', 'CONTENTS', '7 documents, 11 pages (index on page 2)', 'PREPARED ON',
    'Prepared with TenderPilot — for human review and upload']) expect(cover, `cover has "${s}"`).toContain(s);
  // index
  const idx = flat(texts[1]);
  expect(idx).toContain('Index of documents');
  const titles7 = DEFAULT_TITLES.slice(1);
  titles7.forEach((t, i) => { expect(idx).toContain(String(i + 1).padStart(2, '0')); expect(idx).toContain(t.length > 44 ? t.slice(0, 30) : t); });
  const targets = await linkTargets(r.body, 2);
  expect(targets, 'index link destinations (page numbers)').toEqual([3, 4, 5, 6, 7, 8, 11]);
  // outline
  const ol = await outlineTitles(r.body);
  expect(ol.titles).toEqual(['Cover', 'Index', ...titles7]);
  expect(ol.pageMode).toBe('/UseOutlines');
  // footer on every page
  texts.forEach((t, i) => expect(flat(t), `footer p${i + 1}`).toMatch(new RegExp(`GEM/2026/B/700001\\s*·\\s*Page ${i + 1} of 11`)));
  rasterise(r.body, 'packet-p1-cover', 1);
  rasterise(r.body, 'packet-p2-index', 2);
  // blob key
  const row = await db(async (x) => (await x.select().from(packets).where(eq(packets.id, latestId)))[0]);
  expect(row.blobKey).toBe(`org/${c.fx.orgId}/packets/${latestId}/${FILE}`);
  expect(existsSync(join(BLOBS, row.blobKey!))).toBe(true);
  // viewer can download too (S11 repeats it); unauthenticated cannot
  const anon = await newApi();
  expect((await anon.get(url)).status()).toBe(401);
  await anon.dispose();
  // other org -> 404
  const other = await lazy('other', mk);
  expect((await getBytes(other.fx, 'analyst', url)).status).toBe(404);
  // show the PDF in the browser as evidence of the Open link
  await openPacket(page, context, c);
  await shot(page, 'S6-packet-step-after-build');
});

// ═════════════ S7 ═════════════
test('S7 foreign / unknown items -> 400 "Unknown packet item(s)", no row created', async () => {
  const c = await named('main');
  const other = await lazy('other', mk);
  const otherDoc = other.fx.docs.gst;
  // a bid document of ANOTHER tender
  const key = `org/${c.fx.orgId}/tender-docs/other-tender.pdf`;
  mkdirSync(dirname(join(BLOBS, key)), { recursive: true });
  writeFileSync(join(BLOBS, key), await pdfBytes('OTHER TENDER', 1));
  const [td] = await db((d) => d.insert(tenderDocuments).values({ tenderId: c.fx.tenderNoAnalysis.id, orgId: c.fx.orgId, kind: 'bid', fileName: 'other-tender.pdf', blobKey: key, sizeBytes: 1000, pageCount: 1 }).returning());
  const before = (await call(c.fx, 'analyst', 'get', `/api/workspaces/${c.ws}/packets`)).body.total;
  const cases: { name: string; items: any[]; titles: string[] }[] = [
    { name: 'vault doc of another org', items: [{ kind: 'cover', title: 'Cover' }, { kind: 'vault', refId: otherDoc, title: 'Foreign GST' }], titles: ['Foreign GST'] },
    { name: 'unknown annexure key', items: [{ kind: 'annexure', refId: 'no_such_key', title: 'Ghost annexure' }], titles: ['Ghost annexure'] },
    { name: 'tender document of another tender', items: [{ kind: 'tender_doc', refId: td.id, title: 'Other tender doc' }], titles: ['Other tender doc'] },
    { name: 'several at once', items: [{ kind: 'vault', refId: otherDoc, title: 'A' }, { kind: 'annexure', refId: 'zzz', title: 'B' }], titles: ['A', 'B'] },
  ];
  for (const k of cases) {
    const r = await buildApi(c, k.items);
    expect(r.status, k.name).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    expect(r.body.error.message).toBe(`Unknown packet item(s): ${k.titles.join(', ')}`);
    expect(r.body.error.details.items).toEqual(k.titles);
  }
  const after = (await call(c.fx, 'analyst', 'get', `/api/workspaces/${c.ws}/packets`)).body.total;
  expect(after, 'no packet row created').toBe(before);
});

// ═════════════ S8 ═════════════
test('S8 images placed on A4; corrupt / unsupported skipped with warnings; encrypted PDF warning', async () => {
  test.setTimeout(120_000);
  const c = await named('images');
  const { fx } = c;
  const mkSrc = await pdfBytes('IMAGE SOURCE', 1);
  const { dir, f } = tmpFile(mkSrc);
  execFileSync('pdftoppm', ['-png', '-r', '70', '-singlefile', f, join(dir, 'img')]);
  execFileSync('pdftoppm', ['-jpeg', '-r', '70', '-singlefile', f, join(dir, 'img')]);
  const png = readFileSync(join(dir, 'img.png')), jpg = readFileSync(join(dir, 'img.jpg'));
  const enc = await (async () => {
    const d = await PDFDocument.create(); d.addPage([595, 842]).drawText('ENCRYPTED', { x: 40, y: 700 });
    d.context.trailerInfo.Encrypt = d.context.register(d.context.obj({ Filter: 'Standard', V: 1, R: 2, O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('00'.repeat(32)), P: -4 }));
    return Buffer.from(await d.save());
  })();
  const good = await upload(await apiAs(fx, 'analyst'), 'ok-doc', { type: 'other', title: 'Good PDF' });
  const idPng = await uploadRaw(fx, 'scan.png', png, 'image/png', { type: 'other', title: 'Scanned PNG' });
  const idJpg = await uploadRaw(fx, 'scan.jpg', jpg, 'image/jpeg', { type: 'other', title: 'Scanned JPG' });
  const idEnc = await uploadRaw(fx, 'locked.pdf', enc, 'application/pdf', { type: 'other', title: 'Locked PDF' });
  const idBad = await upload(await apiAs(fx, 'analyst'), 'bad', { type: 'other', title: 'Corrupt scan' });
  const idTxt = await upload(await apiAs(fx, 'analyst'), 'txt', { type: 'other', title: 'Notes file' });
  await overwriteBlob(idBad, (await pdfBytes('SOON CORRUPT', 3)).subarray(0, 200));   // truncated PDF
  await overwriteBlob(idTxt, Buffer.from('this is just a text file, not a document\n'));
  const items = [{ kind: 'cover', title: 'Cover page & index' }, ...[
    [good, 'Good PDF'], [idPng, 'Scanned PNG'], [idJpg, 'Scanned JPG'], [idEnc, 'Locked PDF'], [idBad, 'Corrupt scan'], [idTxt, 'Notes file'],
  ].map(([refId, title]) => ({ kind: 'vault', refId, title }))];
  const r = await buildApi(c, items);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const w: string[] = r.body.warnings;
  expect(w).toContain('"Corrupt scan" is damaged and could not be opened — skipped.');
  expect(w).toContain('"Notes file" is not a PDF, PNG or JPG file — skipped.');
  expect(w).toContain('"Locked PDF" is password-protected; its pages may not display correctly. Upload an unlocked copy to the vault.');
  const byTitle = Object.fromEntries(r.body.items.map((i: any) => [i.title, i]));
  expect(byTitle['Corrupt scan'].included).toBe(false);
  expect(byTitle['Notes file'].included).toBe(false);
  for (const t of ['Good PDF', 'Scanned PNG', 'Scanned JPG', 'Locked PDF']) expect(byTitle[t].included, t).toBe(true);
  expect(r.body.items.filter((i: any) => i.included).map((i: any) => i.startPage)).toEqual([1, 3, 4, 5, 6]);
  expect(r.body.pageCount).toBe(6);
  const pdf = (await getBytes(fx, 'analyst', r.body.downloadUrl)).body;
  expect(pdfPageCount(pdf)).toBe(6);
  // images are on their own A4 pages (4 = PNG, 5 = JPG)
  for (const pg of [4, 5]) {
    expect(pdfInfo(pdf, pg)).toMatch(/Page\s+\d+ size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/);
    const imgs = execFileSync('pdfimages', ['-list', '-f', String(pg), '-l', String(pg), tmpFile(pdf).f]).toString();
    expect(imgs.trim().split('\n').length, `page ${pg} has an image\n${imgs}`).toBeGreaterThanOrEqual(3);
  }
  rasterise(pdf, 'S8-png-on-a4-page4', 4);
  rasterise(pdf, 'S8-index-skipped-omitted', 2);
  const idx = flat(pdfPagesText(pdf)[1]);
  expect(idx).toContain('Good PDF');
  expect(idx).toContain('Scanned PNG');
  expect(idx).not.toContain('Corrupt scan');
  expect(idx).not.toContain('Notes file');
  writeFileSync(join(EVID_DIR, 'S8-warnings.json'), JSON.stringify({ warnings: w, items: r.body.items }, null, 2));
});

// ═════════════ S9 ═════════════
test('S9a >20 MB output: still saved, exact warning text', async () => {
  test.setTimeout(180_000);
  const c = await named('bigout');
  const a = await uploadRaw(c.fx, 'scan-a.pdf', await bigPdf(11_400_000), 'application/pdf', { type: 'other', title: 'Large scan A' });
  const b = await uploadRaw(c.fx, 'scan-b.pdf', await bigPdf(11_400_000), 'application/pdf', { type: 'other', title: 'Large scan B' });
  const r = await buildApi(c, [{ kind: 'cover', title: 'Cover page & index' }, { kind: 'vault', refId: a, title: 'Large scan A' }, { kind: 'vault', refId: b, title: 'Large scan B' }]);
  expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(201);
  expect(r.body.status).toBe('ready');
  expect(r.body.sizeBytes).toBeGreaterThan(20 * MB);
  const mb = (r.body.sizeBytes / MB).toFixed(1);
  expect(r.body.warnings).toContain(`The packet is ${mb} MB, above the 20.0 MB upload limit. Compress large scans in the vault or split the packet before uploading on GeM.`);
  const dl = await getBytes(c.fx, 'analyst', r.body.downloadUrl);
  expect(dl.status).toBe(200);
  expect(dl.body.length).toBe(r.body.sizeBytes);
  writeFileSync(join(EVID_DIR, 'S9a-oversize-warning.json'), JSON.stringify({ sizeBytes: r.body.sizeBytes, warnings: r.body.warnings }, null, 2));
});

test('S9b UI estimate: green, amber above 15 MB, red above 20 MB with message', async ({ page, context }) => {
  const c = await named('sizes');
  const setSize = (bytes: number) => db((d) => d.update(vaultDocuments).set({ sizeBytes: bytes }).where(eq(vaultDocuments.id, c.fx.docs.bsNew)));
  const bar = () => summary(page).locator('[role="progressbar"] > div');
  await openPacket(page, context, c);
  await expect(bar()).toHaveClass(/bg-success/);
  await setSize(16 * MB);     // stored-size field only (the estimate reads it); no 16 MB file exists
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Packet contents' })).toBeVisible();
  await expect(bar()).toHaveClass(/bg-warning/);
  await expect(page.getByText('Above GeM’s typical per-file limit')).toHaveCount(0);
  await shot(page, 'S9b-amber-over-15MB');
  await setSize(21 * MB);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Packet contents' })).toBeVisible();
  await expect(bar()).toHaveClass(/bg-danger/);
  await expect(page.getByText('Above GeM’s typical per-file limit — remove large scans or compress them in the vault.')).toBeVisible();
  await expect(summary(page).locator('span.text-danger')).toContainText('/ 20 MB');
  await shot(page, 'S9b-red-over-20MB');
});

// ═════════════ S10 ═════════════
test('S10 > 26 documents -> "Index of documents (continued)", start pages shifted', async () => {
  test.setTimeout(240_000);
  const c = await named('many');
  const api = await apiAs(c.fx, 'analyst');
  const ids: string[] = [];
  for (let i = 1; i <= 27; i++) ids.push(await upload(api, `doc-${i}`, { type: 'other', title: `Doc ${String(i).padStart(2, '0')}` }));
  await api.dispose();
  const items = (n: number) => [{ kind: 'cover', title: 'Cover page & index' }, ...ids.slice(0, n).map((refId, i) => ({ kind: 'vault', refId, title: `Doc ${String(i + 1).padStart(2, '0')}` }))];
  // 26 docs: one index page
  const r26 = await buildApi(c, items(26));
  expect(r26.status).toBe(201);
  expect(r26.body.pageCount).toBe(1 + 1 + 26);
  expect(r26.body.items[1].startPage).toBe(3);
  const t26 = pdfPagesText((await getBytes(c.fx, 'analyst', r26.body.downloadUrl)).body);
  expect(flat(t26[2])).not.toContain('Index of documents (continued)');
  // 27 docs: index continues
  const r27 = await buildApi(c, items(27));
  expect(r27.status).toBe(201);
  expect(r27.body.pageCount).toBe(1 + 2 + 27);
  expect(r27.body.items.map((i: any) => i.startPage)).toEqual([1, ...Array.from({ length: 27 }, (_, i) => 4 + i)]);
  const pdf = (await getBytes(c.fx, 'analyst', r27.body.downloadUrl)).body;
  const t = pdfPagesText(pdf);
  expect(flat(t[1])).toContain('Index of documents');
  expect(flat(t[1])).not.toContain('(continued)');
  expect(flat(t[2])).toContain('Index of documents (continued)');
  expect((t[1].match(/Doc \d\d/g) ?? []).length).toBe(26);
  expect((t[2].match(/Doc \d\d/g) ?? []).length).toBe(1);
  expect(flat(t[0])).toContain('27 documents, 30 pages (index on page 2)');
  expect(await linkTargets(pdf, 2)).toEqual(Array.from({ length: 26 }, (_, i) => 4 + i));
  expect(await linkTargets(pdf, 3)).toEqual([30]);
  t.forEach((x, i) => expect(flat(x)).toMatch(new RegExp(`Page ${i + 1} of 30`)));
  rasterise(pdf, 'S10-index-continued-p3', 3);
  rasterise(pdf, 'S10-index-p2', 2);
});

// ═════════════ S11 ═════════════
test('S11 earlier builds list + download; GET <= 50 newest first; Viewer can download, no Build, POST 403', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = await named('hist');
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) { const r = await buildApi(c); expect(r.status).toBe(201); ids.push(r.body.id); }
  // pad history beyond 50 with older 'ready' rows (no files) to check the cap
  const base = Date.now() - 3_600_000;
  await db((d) => d.insert(packets).values(Array.from({ length: 52 }, (_, i) => ({
    orgId: c.fx.orgId, workspaceId: c.ws, status: 'ready' as const, items: [], warnings: [], sizeBytes: 1000, pageCount: 1, createdBy: c.fx.users.analyst.id,
    createdAt: new Date(base - i * 60_000),
  }))));
  const list = await call(c.fx, 'viewer', 'get', `/api/workspaces/${c.ws}/packets`);
  expect(list.status).toBe(200);
  expect(list.body.items).toHaveLength(50);
  expect(list.body.items.slice(0, 3).map((p: any) => p.id)).toEqual([...ids].reverse());
  const times = list.body.items.map((p: any) => Date.parse(p.createdAt));
  expect([...times].sort((a, b) => b - a)).toEqual(times);
  // UI as analyst: latest + Earlier builds with Download this build
  await openPacket(page, context, c);
  const earlier = page.getByText('Earlier builds').locator('xpath=../..');
  await expect(earlier).toBeVisible();
  const links = earlier.getByRole('link', { name: 'Download this build' });
  await expect(links).toHaveCount(2);
  await expect(earlier).toContainText('11 pages');
  const href = await links.first().getAttribute('href');
  expect(href).toBe(`/api/packets/${ids[1]}/download`);
  const dl = page.waitForEvent('download');
  await links.first().click();
  expect((await dl).suggestedFilename()).toBe(FILE);
  await shot(page, 'S11-earlier-builds');
  // Viewer
  await openPacket(page, context, c, 'viewer');
  await expect(page.getByRole('button', { name: /(Re)?build packet/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Reorder|Remove|Move/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download this build' }).first()).toBeVisible();
  await shot(page, 'S11-viewer-no-build-button');
  const vd = await getBytes(c.fx, 'viewer', `/api/packets/${ids[0]}/download`);
  expect(vd.status).toBe(200);
  expect(vd.body.subarray(0, 5).toString()).toBe('%PDF-');
  const post = await buildApi(c, undefined, 'viewer');
  expect(post.status).toBe(403);
  expect(post.body.error.message).toBe('You need to be at least an Analyst to do that');
  expect((await call(c.fx, 'viewer', 'get', `/api/workspaces/${c.ws}/packets`)).status).toBe(200);
});

// ═════════════ S12 ═════════════
test('S12 build failure -> 500 packet_build_failed, "The last build failed", activity packet_failed', async ({ page, context }) => {
  const c = await named('fail');
  // Induce an unexpected exception inside the build: block the packet blob directory with a plain file so the blob write throws.
  const blockDir = join(BLOBS, 'org', c.fx.orgId);
  mkdirSync(blockDir, { recursive: true });
  writeFileSync(join(blockDir, 'packets'), 'not a directory');
  try {
    const r = await buildApi(c);
    expect(r.status, JSON.stringify(r.body)).toBe(500);
    expect(r.body.error.code).toBe('packet_build_failed');
    expect(r.body.error.message).toMatch(/^Build failed: /);
    expect(r.body.error.details.packet.status).toBe('failed');
    expect(r.body.error.details.packet.downloadUrl).toBeNull();
    const d = await detail(c);
    expect(d.packets[0].status).toBe('failed');
    expect(d.packets[0].warnings[0]).toBe(r.body.error.message);
    expect((d.activity as any[]).some((a) => a.action === 'workspace.packet_failed')).toBe(true);
    expect(d.workspace.stage, 'a failed build must not move the stage').toBe('go');
    // UI
    await openPacket(page, context, c);
    await expect(page.getByText('The last build failed')).toBeVisible();
    await expect(page.getByText(/Build failed: /).first()).toBeVisible();
    await expect(page.getByText('tried to build the packet (failed)').first()).toBeVisible();
    await shot(page, 'S12-last-build-failed');
    // and a click on Build in the UI surfaces the error toast
    await page.getByRole('button', { name: /(Re)?build packet/i }).click();
    await expect(toastWith(page, /Build failed/)).toBeVisible();
    await shot(page, 'S12-error-toast');
  } finally { rmSync(join(blockDir, 'packets'), { force: true }); }
  // recovers once storage is back
  const ok = await buildApi(c);
  expect(ok.status).toBe(201);
});

// ═════════════ S13 (FR-055) ═════════════
test('S13 (FR-055) teammate sees the last successful build\'s order; Default order resets', async ({ browser, page, context }) => {
  test.setTimeout(120_000);
  const c = await named('team');
  await openPacket(page, context, c);
  // analyst: PAN above GST, remove Balance sheets, build
  await page.getByRole('button', { name: 'Move PAN card of the firm up' }).click();
  await page.getByRole('button', { name: 'Remove Audited balance sheets — last 3 financial years' }).click();
  const custom = (await rowTitles(page));
  await page.getByRole('button', { name: 'Build packet' }).click();
  await expect(toastWith(page, /Packet ready/)).toBeVisible();
  // teammate in a different browser context (bid manager) sees the same order
  const ctx2 = await browser.newContext({ storageState: c.fx.states.bid_manager, viewport: { width: 1440, height: 900 } });
  const p2 = await ctx2.newPage();
  try {
    await p2.goto(`/workspaces/${c.ws}?step=packet`);
    await expect(p2.getByRole('heading', { name: 'Packet contents' })).toBeVisible();
    expect(await rowTitles(p2)).toEqual(custom);
    expect(custom.indexOf('PAN card of the firm')).toBeLessThan(custom.indexOf('GST registration certificate'));
    expect(custom).not.toContain('Audited balance sheets — last 3 financial years');
    await expect(p2.getByText('Order from the last successful build.')).toBeVisible();
    await expect(p2.getByRole('button', { name: 'Default order' })).toBeVisible();
    await evidence(p2, SPEC, STORY, `S13-teammate-sees-last-build-order-${test.info().project.name}`);
    const api = (await detail(c, 'bid_manager')).defaultPacketItems.map((i: any) => i.title);
    expect(api).toEqual(custom);
    await p2.getByRole('button', { name: 'Default order' }).click();
    expect(await rowTitles(p2)).toEqual(DEFAULT_TITLES);
    await expect(p2.getByRole('button', { name: 'Default order' })).toHaveCount(0);
  } finally { await ctx2.close(); }
  // POST {} builds that same proposed order (parity with what the UI shows)
  const parity = await buildApi(c);
  expect(parity.status).toBe(201);
  expect(parity.body.items.map((i: any) => i.title)).toEqual(custom);
  // the builder's own browser, after reload, also shows the shared order (draft was cleared by the build)
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Packet contents' })).toBeVisible();
  expect(await rowTitles(page)).toEqual(custom);
});

// ═════════════ S14 (FR-056) ═════════════
test('S14 (FR-056) inputs > 60 MB -> 413 packet_too_large before loading; no row', async ({ page, context }) => {
  const c = await named('limit');
  // The check sums the STORED sizes, so the vault size field is set directly (no 60 MB of real files needed).
  await db((d) => d.update(vaultDocuments).set({ sizeBytes: 72 * MB - 400_000 }).where(eq(vaultDocuments.id, c.fx.docs.oem)));
  const before = (await call(c.fx, 'analyst', 'get', `/api/workspaces/${c.ws}/packets`)).body.total;
  const r = await buildApi(c);
  expect(r.status).toBe(413);
  expect(r.body.error.code).toBe('packet_too_large');
  expect(r.body.error.message).toMatch(/^These documents add up to 7[12]\.\d MB — remove or compress some before building \(limit 60 MB\)\.$/);
  expect(r.body.error.details.limitBytes).toBe(60 * MB);
  const after = (await call(c.fx, 'analyst', 'get', `/api/workspaces/${c.ws}/packets`)).body.total;
  expect(after).toBe(before);
  // UI
  await openPacket(page, context, c);
  await page.getByRole('button', { name: /(Re)?build packet/i }).click();
  const t = toastWith(page, /add up to 7\d\.\d MB/);
  await expect(t).toBeVisible();
  await expect(t).toContainText('limit 60 MB');
  await shot(page, 'S14-413-toast');
  // removing the heavy document makes it buildable (Dell MAF out)
  const ok = await buildApi(c, [{ kind: 'cover', title: 'Cover page & index' }, { kind: 'vault', refId: c.fx.docs.gst, title: 'GST registration certificate' }]);
  expect(ok.status).toBe(201);
});

// ═════════════ S15 (FR-057) ═════════════
test('S15 (FR-057) a packet stuck in "building" for > 10 min is reported and persisted as failed', async ({ page, context }) => {
  const c = await named('stuck');
  const mkRow = (ageMin: number) => db(async (d) => (await d.insert(packets).values({
    orgId: c.fx.orgId, workspaceId: c.ws, status: 'building', items: [], warnings: [], createdBy: c.fx.users.analyst.id, createdAt: new Date(Date.now() - ageMin * 60_000),
  }).returning())[0]);
  const statusOf = (id: string) => db(async (d) => (await d.select().from(packets).where(eq(packets.id, id)))[0]);
  // control: 5 minutes old stays building
  const fresh = await mkRow(5);
  let d = await detail(c);
  expect(d.packets.find((p: any) => p.id === fresh.id).status).toBe('building');
  await db((x) => x.delete(packets).where(eq(packets.id, fresh.id)));
  // 11 minutes old -> failed
  const stuck = await mkRow(11);
  d = await detail(c);
  const dto = d.packets.find((p: any) => p.id === stuck.id);
  expect(dto.status).toBe('failed');
  expect(dto.warnings).toEqual(['Build interrupted — try again.']);
  const persisted = await statusOf(stuck.id);
  expect(persisted.status).toBe('failed');
  expect(persisted.warnings).toEqual(['Build interrupted — try again.']);
  // the packets list endpoint recovers too
  const stuck2 = await mkRow(12);
  const l = await call(c.fx, 'viewer', 'get', `/api/workspaces/${c.ws}/packets`);
  expect(l.body.items.find((p: any) => p.id === stuck2.id).status).toBe('failed');
  await openPacket(page, context, c);
  await expect(page.getByText('The last build failed')).toBeVisible();
  await expect(page.getByText('Build interrupted — try again.').first()).toBeVisible();
  await shot(page, 'S15-build-interrupted');
});

// ═════════════ accessibility ═════════════
test('A11y: axe on the Packet step (WCAG 2.1 A/AA), before and after a build', async ({ page, context }) => {
  const c = await named('main');
  await openPacket(page, context, c);
  // Scoped to the Packet step grid; page-level violations in the shared workspace header are outside US5 (observation only).
  try { await a11y(page, 'packet-step', { include: ['div[class*="xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)]"]'] }); } catch (e) {
    test.info().annotations.push({ type: 'axe-packet-step', description: String((e as Error).message).split('\n')[0] + ' - see packet-step axe json' });
    throw e;
  }
  try { await a11y(page, 'packet-full-page-observation'); } catch (e) {
    test.info().annotations.push({ type: 'axe-full-page', description: String((e as Error).message).split('\n')[0] + ' - see packet-full-page-observation axe json' });
  }
  await shot(page, 'A11y-packet-step');
});

// ═════════════ mobile ═════════════
test('@mobile packet step at 375 px: no horizontal page scroll, controls reachable', async ({ page, context }) => {
  const c = await named('main');
  if (!(await detail(c)).packets.length) expect((await buildApi(c)).status).toBe(201);
  await openPacket(page, context, c);
  await expect(page.getByRole('button', { name: 'Reorder GST registration certificate' })).toBeVisible();
  await expect(page.getByRole('button', { name: /(Re)?build packet/i })).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, 'mobile-packet-step');
  await page.getByText('Latest packet is ready').scrollIntoViewIfNeeded();
  await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, 'mobile-latest-card');
});
