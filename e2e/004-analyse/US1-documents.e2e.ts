/**
 * QA acceptance for spec 004 / US1 (#167): get the bid documents into TenderPilot (fetch from GeM or upload).
 * One test per acceptance criterion of the issue; screenshot evidence in qa/evidence/004/US1/.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Page, PlaywrightWorkerArgs } from '@playwright/test';

type Playwright = PlaywrightWorkerArgs['playwright'];
import { GEM_URL } from '../support/fixtures';
import {
  SPEC, collectRunArtifacts, evidence, expect, fixturePath, mockGem, signupViaApi, test, uniqueUser, uploadFixture, uploadFixtureViaApi,
  setDocumentMode, analyse,
} from './support';

const STORY = 'US1';
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

test.afterEach(async ({ page }) => {
  await collectRunArtifacts(SPEC, STORY, page);
  // Always leave mock-gem healthy for the next test.
  const ctx = page.context().request;
  await ctx.post(`${GEM_URL}/__admin/document-mode`, { data: { mode: 'normal' } }).catch(() => undefined);
  await ctx.post(`${GEM_URL}/__admin/fail`, { data: { mode: 'off' } }).catch(() => undefined);
});

// ---------- helpers ----------
interface ApiError { error: { code: string; message: string; details?: { fields?: Record<string, string> } } }
interface Tender { id: string; bidNumber: string; gemBidId: string | null; endAt: string | null; source: string }
const pdfFile = (name: string, buffer: Buffer, mimeType = 'application/pdf') => ({ name, mimeType, buffer });
const post = (r: APIRequestContext, tenderId: string, file?: { name: string; mimeType: string; buffer: Buffer }, kind = 'bid') =>
  r.post(`/api/tenders/${tenderId}/documents`, { multipart: file ? { kind, file } : { kind } });
const docRequests = async (r: APIRequestContext) => ((await (await r.get(`${GEM_URL}/__admin/state`)).json()) as { requests: { documents: number } }).requests.documents;

async function newOrg(playwright: Playwright, baseURL: string, prefix = 'qa') {
  const ctx = await playwright.request.newContext({ baseURL });
  const user = uniqueUser(prefix);
  const res = await ctx.post('/api/auth/signup', { data: user });
  expect(res.status(), await res.text()).toBe(201);
  return { ctx, user };
}

/** Invite `role` into the owner's org and accept the invitation from a fresh context (returns that member's context). */
async function addMember(owner: APIRequestContext, playwright: Playwright, baseURL: string, role: 'viewer' | 'analyst') {
  const user = uniqueUser(role);
  const inv = await owner.post('/api/org/invitations', { data: { email: user.email, role } });
  expect(inv.status(), await inv.text()).toBe(201);
  const token = ((await inv.json()) as { inviteUrl: string }).inviteUrl.split('/invite/')[1];
  const ctx = await playwright.request.newContext({ baseURL });
  const acc = await ctx.post('/api/auth/accept-invite', { data: { token, name: user.name, password: user.password } });
  expect(acc.ok(), await acc.text()).toBeTruthy();
  return { ctx, user };
}

const usedTenders = new Set<string>();
/** An open GeM-linked tender closing in 3+ days with no GeM-fetched document yet, not used by another test of this run. */
async function freshGemTender(r: APIRequestContext): Promise<Tender> {
  const minEnd = Date.now() + 3 * 86_400_000;
  const list = async () => {
    // Only bids mock-gem serves: the demo seed (smoke spec) also creates source 'gem' tenders with unknown GeM ids.
    const state = (await (await r.get(`${GEM_URL}/__admin/state`)).json()) as { bids: { id: string | number }[] };
    const known = new Set(state.bids.map((b) => String(b.id)));
    const res = await r.get('/api/tenders', { params: { status: 'open', sort: 'endAt', pageSize: 100 } });
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()) as { items: Tender[] }).items.filter((t) => t.source === 'gem' && !!t.gemBidId && known.has(String(t.gemBidId)) && !!t.endAt && Date.parse(t.endAt) >= minEnd && !usedTenders.has(t.id));
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const t of await list()) {
      const docs = (await (await r.get(`/api/tenders/${t.id}/documents`)).json()) as { items: { source: string }[] };
      if (docs.items.some((d) => d.source === 'gem')) continue;
      usedTenders.add(t.id);
      return t;
    }
    await mockGem(r, '/__admin/publish', { count: 6 });
    const run = await r.post('/api/ingestion/run', { data: { pages: 5 } });
    expect([200, 409], await run.text()).toContain(run.status());
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error('no fresh GeM tender available');
}

/** Insert a tender without gem_bid_id / document_url straight into the e2e database (no API can create one). */
function insertTenderWithoutGemLink(): string {
  const bid = `GEM/2026/B/${9_000_000 + Math.floor(Math.random() * 999_999)}`;
  const sql = `insert into tenders (source, bid_number, title, source_url, content_hash, status, end_at)
    values ('gem', '${bid}', 'QA tender without GeM link', 'https://example.invalid/${bid}', 'qa-${Date.now()}', 'open', now() + interval '20 days') returning id;`;
  return execFileSync('psql', [E2E_DB, '-tAqc', sql], { encoding: 'utf8' }).trim().split('\n')[0];
}

/** A one-page PDF without any text layer (a "scan"). */
async function headerPdf(bidNumber: string): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = createRequire(join(process.cwd(), 'packages/core/package.json'))('pdf-lib') as typeof import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Bid Details', { x: 50, y: 780, size: 16, font });
  page.drawText(`Bid Number: ${bidNumber}`, { x: 50, y: 750, size: 12, font });
  return Buffer.from(await doc.save());
}

async function blankPdf(pages = 2): Promise<Buffer> {
  const { PDFDocument } = createRequire(join(process.cwd(), 'packages/core/package.json'))('pdf-lib') as typeof import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

const toastText = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
const goit = readFileSync(fixturePath('go-it-services'));
const dropzoneInput = (page: Page) => page.locator('input[type="file"]');

// ---------- criteria ----------

test('1 empty Documents tab: "No documents yet", type select defaults to Bid document, dropzone hint @mobile', async ({ page, playwright, baseURL }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await expect(page.getByText('Tender documents')).toBeVisible();
  await expect(page.getByText('No documents yet')).toBeVisible();
  await expect(page.getByText('Fetch the bid document from GeM, or upload the PDF you downloaded.')).toBeVisible();
  await expect(page.getByText('Upload a document').first()).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Document type' })).toContainText('Bid document');
  await expect(page.getByText('PDF up to 25 MB')).toBeVisible();
  await expect(page.getByRole('button', { name: /Fetch from GeM/ })).toBeVisible();
  await ev(page, '01-empty-documents-tab');
  void playwright; void baseURL;
});

test('2 upload go-it-services.pdf: 201 body, toast, row (Bid document, Uploaded, 4 pages, size, just now) @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  const body = await uploadFixture(page, t.id, 'go-it-services');
  expect(body).toMatchObject({ kind: 'bid', pageCount: 4, hasText: true, source: 'upload', fileName: 'go-it-services.pdf' });
  expect(body).toHaveProperty('orgId');
  await expect(toastText(page, 'go-it-services.pdf uploaded')).toBeVisible();
  await expect(toastText(page, '4 pages read')).toBeVisible();
  await ev(page, '02-upload-toast');
  const row = page.locator('li:not([data-sonner-toast])').filter({ hasText: 'go-it-services.pdf' });
  await expect(row).toContainText('Bid document');
  await expect(row).toContainText('Uploaded');
  await expect(row).toContainText('4 pages');
  await expect(row).toContainText(/\d+(\.\d+)? ?(KB|kB|MB|B)/);
  await expect(row).toContainText('just now');
  await ev(page, '02-upload-row');
});

test('3 with an existing analysis the upload toast offers Re-analyse, which starts a new analysis', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  const first = await analyse(page.request, t.id);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await expect(page.locator('li:not([data-sonner-toast])').filter({ hasText: 'go-it-services.pdf' })).toBeVisible();
  // wait for the analysis query to settle so the tab knows an analysis exists
  await page.waitForLoadState('networkidle');
  await uploadFixture(page, t.id, 'review-hardware-oem', 'atc');
  const toast = toastText(page, 'review-hardware-oem.pdf uploaded');
  await expect(toast).toBeVisible();
  const action = toast.getByRole('button', { name: 'Re-analyse' });
  await expect(action).toBeVisible();
  await ev(page, '03-reanalyse-toast');
  const reanalysed = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/tenders/${t.id}/analyse`));
  // The (unrelated) bid-number-mismatch warning toast stacks over this one, so click through the DOM.
  await action.evaluate((el: HTMLElement) => el.click());
  const res = await reanalysed;
  expect(res.status()).toBe(201);
  expect(((await res.json()) as { id: string }).id).not.toBe(first.id);
  await ev(page, '03-after-reanalyse');
});

test('4 non-PDF: 415 unsupported_media_type + error toast, nothing stored', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml fake docx payload '.repeat(20))]);
  const res = await post(page.request, t.id, pdfFile('report.docx', docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  expect(res.status()).toBe(415);
  const err = (await res.json()) as ApiError;
  expect(err.error.code).toBe('unsupported_media_type');
  expect(err.error.message).toMatch(/^Only PDF files can be analysed\./);
  // renamed .docx -> .pdf (spec scenario 4) also rejected
  const renamed = await post(page.request, t.id, pdfFile('renamed.pdf', docx));
  expect(renamed.status()).toBe(415);
  expect(((await renamed.json()) as ApiError).error.message).toBe('Only PDF files can be analysed. Export the document to PDF and try again.');
  // UI toast
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await dropzoneInput(page).setInputFiles(pdfFile('renamed.pdf', docx));
  await expect(toastText(page, 'Only PDF files can be analysed')).toBeVisible();
  await ev(page, '04-non-pdf-toast');
  const docs = (await (await page.request.get(`/api/tenders/${t.id}/documents`)).json()) as { total: number };
  expect(docs.total).toBe(0);
});

test('5 > 25 MB: 413 payload_too_large "The file is larger than 25 MB"', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(26 * 1024 * 1024, 0x20)]);
  const res = await post(page.request, t.id, pdfFile('big.pdf', big));
  expect(res.status()).toBe(413);
  const err = (await res.json()) as ApiError;
  expect(err.error).toMatchObject({ code: 'payload_too_large', message: 'The file is larger than 25 MB' });
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await dropzoneInput(page).setInputFiles(pdfFile('big.pdf', big));
  await expect(toastText(page, /larger than 25 MB/)).toBeVisible();
  await ev(page, '05-oversize-toast');
});

test('6 empty file -> 400 bad_request; missing file -> 400 validation_error with details.fields.file = Required', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  const empty = await post(page.request, t.id, pdfFile('empty.pdf', Buffer.alloc(0)));
  expect(empty.status()).toBe(400);
  expect(((await empty.json()) as ApiError).error).toMatchObject({ code: 'bad_request', message: 'The file is empty' });
  const missing = await post(page.request, t.id, undefined);
  expect(missing.status()).toBe(400);
  const err = (await missing.json()) as ApiError;
  expect(err.error).toMatchObject({ code: 'validation_error', message: 'Choose a PDF file to upload' });
  expect(err.error.details?.fields?.file).toBe('Required');
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await dropzoneInput(page).setInputFiles(pdfFile('empty.pdf', Buffer.alloc(0)));
  await expect(toastText(page, 'The file is empty')).toBeVisible();
  await ev(page, '06-empty-file-toast');
});

test('7 corrupt and password-protected PDFs -> 422 unreadable_pdf', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  const corrupt = await post(page.request, t.id, pdfFile('corrupt.pdf', Buffer.from('%PDF-1.4\nthis is not really a pdf, the xref and trailer are missing\n')));
  expect(corrupt.status()).toBe(422);
  expect(((await corrupt.json()) as ApiError).error).toMatchObject({ code: 'unreadable_pdf', message: 'We could not read this PDF. It may be password-protected or damaged.' });
  const locked = readFileSync(join(process.cwd(), 'e2e/004-analyse/fixtures/password-protected.pdf'));
  const pw = await post(page.request, t.id, pdfFile('locked.pdf', locked));
  expect(pw.status()).toBe(422);
  expect(((await pw.json()) as ApiError).error.code).toBe('unreadable_pdf');
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await dropzoneInput(page).setInputFiles(pdfFile('locked.pdf', locked));
  await expect(toastText(page, 'We could not read this PDF')).toBeVisible();
  await ev(page, '07-unreadable-pdf-toast');
});

test('8+9 Fetch from GeM: 201 {fetched:1}, toast, From GeM row, counter +1; second fetch 200 {fetched:0}, toast, no GeM request @mobile', async ({ page, playwright, baseURL }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  const before = await docRequests(page.request);
  const first = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/tenders/${t.id}/fetch-documents`));
  await page.getByRole('button', { name: /Fetch from GeM/ }).click();
  const res = await first;
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { fetched: number; total: number; items: { fileName: string; kind: string; source: string }[] };
  expect(body).toMatchObject({ fetched: 1, total: 1 });
  expect(body.items[0]).toMatchObject({ kind: 'bid', source: 'gem' });
  await expect(toastText(page, 'Bid document downloaded from GeM')).toBeVisible();
  const row = page.locator('li:not([data-sonner-toast])').filter({ hasText: 'From GeM' });
  await expect(row).toContainText(/GEM-2026-B-\d+\.pdf/);
  await expect(row).toContainText('Bid document');
  await ev(page, '08-fetched-from-gem');
  expect(await docRequests(page.request)).toBe(before + 1);

  // second fetch, same org via UI
  await page.locator('[data-sonner-toast]').first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
  const second = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/tenders/${t.id}/fetch-documents`));
  await page.getByRole('button', { name: /Fetch from GeM/ }).click();
  const res2 = await second;
  expect(res2.status()).toBe(200);
  expect(((await res2.json()) as { fetched: number }).fetched).toBe(0);
  await expect(toastText(page, 'The GeM bid document is already here')).toBeVisible();
  await ev(page, '09-already-here');
  // another org's analyst: also 200/fetched:0
  const other = await newOrg(playwright, baseURL!, 'other');
  const r3 = await other.ctx.post(`/api/tenders/${t.id}/fetch-documents`);
  expect(r3.status()).toBe(200);
  expect(((await r3.json()) as { fetched: number }).fetched).toBe(0);
  expect(await docRequests(page.request)).toBe(before + 1);
});

test('10a mock-gem down -> 502 gem_unavailable with the generic message (API + toast)', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  await mockGem(page.request, '/__admin/fail', { mode: 'down' });
  const generic = 'Could not download the bid document from GeM right now. Try again in a few minutes or upload the PDF.';
  const direct = await page.request.post(`/api/tenders/${t.id}/fetch-documents`);
  expect(direct.status()).toBe(502);
  expect(((await direct.json()) as ApiError).error).toEqual({ code: 'gem_unavailable', message: generic });
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await page.getByRole('button', { name: /Fetch from GeM/ }).click();
  await expect(toastText(page, generic)).toBeVisible();
  await ev(page, '10a-gem-down-toast');
});

test('10b GeM answers 404 -> "GeM no longer serves this bid document. Upload the PDF instead."', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  await setDocumentMode(page.request, '404');
  const msg = 'GeM no longer serves this bid document. Upload the PDF instead.';
  const direct = await page.request.post(`/api/tenders/${t.id}/fetch-documents`);
  expect(direct.status()).toBe(502);
  expect(((await direct.json()) as ApiError).error).toEqual({ code: 'gem_unavailable', message: msg });
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await page.getByRole('button', { name: /Fetch from GeM/ }).click();
  await expect(toastText(page, msg)).toBeVisible();
  await ev(page, '10b-gem-404-toast');
});

test('10c oversize GeM document -> 502 with the "larger than 25 MB — download it from GeM" message', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  await setDocumentMode(page.request, 'oversize');
  const msg = 'The GeM document is larger than 25 MB — download it from GeM and upload it here.';
  const direct = await page.request.post(`/api/tenders/${t.id}/fetch-documents`);
  expect(direct.status()).toBe(502);
  expect(((await direct.json()) as ApiError).error.message).toBe(msg);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await page.getByRole('button', { name: /Fetch from GeM/ }).click();
  await expect(toastText(page, msg)).toBeVisible();
  await ev(page, '10c-gem-oversize-toast');
});

test('11 tender without a GeM link: no Fetch button, "Upload the bid PDF you downloaded from GeM."; API 422 no_gem_document', async ({ page }) => {
  await signupViaApi(page);
  const id = insertTenderWithoutGemLink();
  await page.goto(`/tenders/${id}?tab=documents`);
  await expect(page.getByText('No documents yet')).toBeVisible();
  await expect(page.getByText('Upload the bid PDF you downloaded from GeM.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Fetch from GeM/ })).toHaveCount(0);
  await ev(page, '11-no-gem-link');
  const res = await page.request.post(`/api/tenders/${id}/fetch-documents`);
  expect(res.status()).toBe(422);
  expect(((await res.json()) as ApiError).error.code).toBe('no_gem_document');
});

test('12 viewer: list with View/Download, no Fetch, "Viewers can read documents…"; POST as viewer -> 403 @mobile', async ({ page, playwright, baseURL }) => {
  const owner = await newOrg(playwright, baseURL!, 'own');
  const t = await freshGemTender(owner.ctx);
  await uploadFixtureViaApi(owner.ctx, t.id, 'go-it-services');
  // the page becomes the viewer
  const inv = await owner.ctx.post('/api/org/invitations', { data: { email: uniqueUser('viewer').email, role: 'viewer' } });
  const email = ((await inv.json()) as { email: string }).email;
  const token = ((await inv.json()) as { inviteUrl: string }).inviteUrl.split('/invite/')[1];
  const acc = await page.request.post('/api/auth/accept-invite', { data: { token, name: 'QA Viewer', password: 'Qa!pass12345' } });
  expect(acc.ok(), `${email} ${await acc.text()}`).toBeTruthy();
  await page.goto(`/tenders/${t.id}?tab=documents`);
  const row = page.locator('li:not([data-sonner-toast])').filter({ hasText: 'go-it-services.pdf' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: /View/ })).toBeVisible();
  await expect(row.getByRole('link', { name: /Download go-it-services\.pdf/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Fetch from GeM/ })).toHaveCount(0);
  await expect(page.getByText('Viewers can read documents. Ask an analyst to upload new ones.')).toBeVisible();
  await expect(page.getByText('PDF up to 25 MB')).toHaveCount(0);
  await ev(page, '12-viewer-documents-tab');
  const denied = await post(page.request, t.id, pdfFile('go-it-services.pdf', goit));
  expect(denied.status()).toBe(403);
  expect(((await denied.json()) as ApiError).error.code).toBe('forbidden');
});

test('13 org isolation: other org cannot list or download an upload (404); GeM docs visible to both', async ({ playwright, baseURL }) => {
  const a = await newOrg(playwright, baseURL!, 'orga');
  const b = await newOrg(playwright, baseURL!, 'orgb');
  const t = await freshGemTender(a.ctx);
  const up = await uploadFixtureViaApi(a.ctx, t.id, 'go-it-services');
  const fetched = await a.ctx.post(`/api/tenders/${t.id}/fetch-documents`);
  expect(fetched.status()).toBe(201);
  const gemDoc = ((await fetched.json()) as { items: { id: string }[] }).items[0];
  const listB = (await (await b.ctx.get(`/api/tenders/${t.id}/documents`)).json()) as { items: { id: string; source: string }[] };
  expect(listB.items.map((d) => d.id)).not.toContain(up.id);
  expect(listB.items.map((d) => d.id)).toContain(gemDoc.id);
  const dl = await b.ctx.get(`/api/tenders/${t.id}/documents/${up.id}/download`);
  expect(dl.status()).toBe(404);
  expect(((await dl.json()) as ApiError).error.code).toBe('not_found');
  expect((await b.ctx.get(`/api/tenders/${t.id}/documents/${gemDoc.id}/download`)).status()).toBe(200);
  const listA = (await (await a.ctx.get(`/api/tenders/${t.id}/documents`)).json()) as { items: { id: string }[] };
  expect(listA.items.map((d) => d.id).sort()).toEqual([up.id, gemDoc.id].sort());
  expect((await a.ctx.get(`/api/tenders/${t.id}/documents/${up.id}/download`)).status()).toBe(200);
});

test('14 View opens inline with safe headers; Download keeps the file name', async ({ page, context }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  const up = await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  const inline = await page.request.get(`/api/tenders/${t.id}/documents/${up.id}/download?inline=1`);
  expect(inline.status()).toBe(200);
  expect(inline.headers()['content-disposition']).toMatch(/^inline;/);
  expect(inline.headers()['cache-control']).toBe('private, no-store');
  expect(inline.headers()['x-content-type-options']).toBe('nosniff');
  expect(inline.headers()['content-type']).toContain('application/pdf');
  const attach = await page.request.get(`/api/tenders/${t.id}/documents/${up.id}/download`);
  expect(attach.headers()['content-disposition']).toMatch(/^attachment; filename="go-it-services\.pdf"/);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  const row = page.locator('li:not([data-sonner-toast])').filter({ hasText: 'go-it-services.pdf' });
  const view = row.getByRole('link', { name: /View/ });
  await expect(view).toHaveAttribute('target', '_blank');
  await expect(view).toHaveAttribute('href', new RegExp(`/documents/${up.id}/download\\?inline=1`));
  // Headless Chromium has no PDF viewer, so check the browser's actual response for the View link's request.
  const viewed = context.waitForEvent('response', (r) => r.url().includes(`/documents/${up.id}/download`) && r.url().includes('inline=1'));
  await view.click();
  const vr = await viewed;
  expect(vr.status()).toBe(200);
  expect(vr.headers()['content-disposition']).toMatch(/^inline;/);
  expect(vr.headers()['cache-control']).toBe('private, no-store');
  expect(vr.headers()['x-content-type-options']).toBe('nosniff');
  for (const p of context.pages()) if (p !== page) await p.close();
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: /Download go-it-services\.pdf/ }).click()]);
  expect(download.suggestedFilename()).toBe('go-it-services.pdf');
  await ev(page, '14-view-download');
});

test('15 scanned PDF: accepted (hasText:false), toast "no text found; it may be a scan", badge "No text — scanned?" @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  const scan = await blankPdf(2);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  const uploaded = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/tenders/${t.id}/documents`));
  await dropzoneInput(page).setInputFiles(pdfFile('scan.pdf', scan));
  const res = await uploaded;
  expect(res.status()).toBe(201);
  expect(await res.json()).toMatchObject({ hasText: false, pageCount: 2 });
  await expect(toastText(page, '2 pages read — no text found; it may be a scan')).toBeVisible();
  await expect(page.locator('li:not([data-sonner-toast])').filter({ hasText: 'scan.pdf' })).toContainText('No text — scanned?');
  await ev(page, '15-scanned-pdf');
});

test('16 (gap) bid-number mismatch: warnings, warning toast, "Different bid?" badge, document still stored', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  const uploaded = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/tenders/${t.id}/documents`));
  await dropzoneInput(page).setInputFiles(pdfFile('go-it-services.pdf', await headerPdf('GEM/2026/B/6133872')));
  const res = await uploaded;
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { warnings: { code: string; found: string }[] };
  expect(body.warnings).toEqual([{ code: 'bid_number_mismatch', found: 'GEM/2026/B/6133872' }]);
  await expect(toastText(page, `This PDF looks like GEM/2026/B/6133872, not ${t.bidNumber}`)).toBeVisible();
  await expect(page.locator('li:not([data-sonner-toast])').filter({ hasText: 'go-it-services.pdf' })).toContainText('Different bid?');
  await ev(page, '16-bid-number-mismatch');
  const docs = (await (await page.request.get(`/api/tenders/${t.id}/documents`)).json()) as { total: number };
  expect(docs.total).toBe(1);
});

test('17 (gap) remove own upload -> 204, row gone, analysis stale "A document was removed…"; GeM doc -> 403', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  const up = await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  const fetched = await page.request.post(`/api/tenders/${t.id}/fetch-documents`);
  expect(fetched.status()).toBe(201);
  const gemDoc = ((await fetched.json()) as { items: { id: string }[] }).items[0];
  await analyse(page.request, t.id);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  const row = page.locator('li:not([data-sonner-toast])').filter({ hasText: 'go-it-services.pdf' });
  await expect(row).toBeVisible();
  // GeM-fetched documents have no Remove action
  await expect(page.locator('li:not([data-sonner-toast])').filter({ hasText: 'From GeM' }).getByRole('button', { name: /More actions/ })).toHaveCount(0);
  await row.getByRole('button', { name: /More actions for go-it-services\.pdf/ }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await expect(page.getByText('Remove go-it-services.pdf?')).toBeVisible();
  await expect(page.getByText('The next analysis will no longer use it.')).toBeVisible();
  await ev(page, '17-remove-confirm');
  const del = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(`/api/tenders/${t.id}/documents/${up.id}`));
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  expect((await del).status()).toBe(204);
  await expect(page.locator('li:not([data-sonner-toast])').filter({ hasText: 'go-it-services.pdf' })).toHaveCount(0);
  const analysis = (await (await page.request.get(`/api/tenders/${t.id}/analysis`)).json()) as { stale: boolean; staleReason: string };
  expect(analysis).toMatchObject({ stale: true, staleReason: 'document_removed' });
  await page.goto(`/tenders/${t.id}`);
  await expect(page.getByText('A document was removed since this analysis.')).toBeVisible();
  await ev(page, '17-stale-banner');
  const forbidden = await page.request.delete(`/api/tenders/${t.id}/documents/${gemDoc.id}`);
  expect(forbidden.status()).toBe(403);
  expect(((await forbidden.json()) as ApiError).error).toMatchObject({ code: 'forbidden', message: 'Documents fetched from GeM are shared and cannot be removed' });
});
