/**
 * 005 / US3 (#116) — Store, find, preview and manage bid documents in a private vault.
 * One test per acceptance criterion (spec scenarios 1-16 + the review-fix behaviours). Evidence in qa/evidence/005/US3/.
 */
import { readFileSync } from 'node:fs';
import { test, expect, signupViaApi, uniqueUser, seedDemo, evidence, collectRunArtifacts } from '../support/fixtures';
import type { Page } from '@playwright/test';
import {
  MB, apiUpload, apiUploadOk, blobFiles, dropFile, istDay, makePdf, makePng, me, noHScroll, sql, viewerPage, type VaultDoc,
} from './support';

const SPEC = '005', STORY = 'US3';
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, name);

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

const toast = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
const uploadDialog = (page: Page) => page.getByRole('dialog', { name: 'Add a document' });
/** The preview drawer (a Sheet). It is the first dialog opened; the upload dialog is excluded by its title. */
const drawer = (page: Page) => page.getByRole('dialog').filter({ hasNot: page.getByText('Add a document') }).first();
const closeDrawer = async (page: Page) => { await drawer(page).getByRole('button', { name: 'Close' }).click(); await expect(page).not.toHaveURL(/doc=/); };
const cards = (page: Page) => page.locator('h3[title]');
const pickFile = (page: Page, f: { name: string; mimeType: string; buffer: Buffer }) => uploadDialog(page).locator('input[type=file]').setInputFiles(f);

/** Upload one file through the dialog; returns the POST /api/vault response. */
async function uiUpload(page: Page, o: { name: string; mime: string; bytes: Buffer; title?: string; issue?: string; expiry?: string }) {
  await page.getByRole('button', { name: 'Upload document' }).first().click();
  await pickFile(page, { name: o.name, mimeType: o.mime, buffer: o.bytes });
  const d = uploadDialog(page);
  if (o.title) await d.getByLabel('Title').fill(o.title);
  if (o.issue) await d.getByLabel('Issue date').fill(o.issue);
  if (o.expiry) await d.getByLabel('Expiry date').fill(o.expiry);
  const resp = page.waitForResponse((r) => r.url().endsWith('/api/vault') && r.request().method() === 'POST');
  await d.getByRole('button', { name: 'Upload document' }).click();
  return resp;
}

async function activityActions(request: import('@playwright/test').APIRequestContext, entityId: string): Promise<string[]> {
  const res = await request.get(`/api/activity?entityType=vault_document&entityId=${entityId}&pageSize=50`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()).items as { action: string }[]).map((a) => a.action);
}

const TEN = ['GST registration', 'PAN card', 'Udyam (MSE) certificate', 'Audited balance sheet', 'CA turnover certificate', 'OEM authorisation',
  'CRAC / completion certificate', 'Work / purchase order', 'ISO certificate', 'Make in India declaration'];

test.describe('US3 vault', () => {
  test('AC1 empty vault shows onboarding with 10 tiles; a tile opens the upload dialog preset; ?upload=1 and page drop open it too', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/vault');
    await expect(page.getByRole('heading', { name: 'Build your bid-ready vault once, reuse it on every tender' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Documents most GeM bids ask for' })).toBeVisible();
    const tiles = page.locator('ul li button:has(span.font-medium)');
    await expect(tiles).toHaveCount(10);
    for (const t of TEN) await expect(page.getByRole('button', { name: new RegExp(`^${t.replace(/[()/]/g, '\\$&')}`) })).toBeVisible();
    await ev(page, 'ac01-onboarding-10-tiles');

    await page.getByRole('button', { name: /^Audited balance sheet/ }).click();
    await expect(uploadDialog(page)).toBeVisible();
    await expect(uploadDialog(page).locator('button[aria-haspopup="listbox"]')).toContainText('Audited balance sheet');
    await ev(page, 'ac01-tile-opens-dialog-preset');
    await uploadDialog(page).getByRole('button', { name: 'Cancel' }).click();

    // ?upload=1 (and the param is consumed)
    await page.goto('/vault?upload=1');
    await expect(uploadDialog(page)).toBeVisible();
    await expect(page).not.toHaveURL(/upload=1/);
    await uploadDialog(page).getByRole('button', { name: 'Cancel' }).click();

    // Independent test: drop GST_REG06_2023.pdf (2 pages) on the page
    await dropFile(page.getByRole('heading', { name: 'Document vault' }), { name: 'GST_REG06_2023.pdf', mime: 'application/pdf', bytes: await makePdf(2) });
    await expect(uploadDialog(page)).toBeVisible();
    await expect(uploadDialog(page).locator('button[aria-haspopup="listbox"]')).toContainText('GST registration');
    await expect(uploadDialog(page).getByLabel('Title')).toHaveValue('GST REG06 2023');
    await ev(page, 'ac01-page-drop-preselects-gst');
  });

  test('AC2 file name guesses type/title/FY; ISO issue date offers "Use 09 Jan 2029"', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/vault?upload=1');
    const d = uploadDialog(page);
    await pickFile(page, { name: 'BS_FY2024-25.pdf', mimeType: 'application/pdf', buffer: await makePdf(1) });
    await expect(d.locator('button[aria-haspopup="listbox"]')).toContainText('Audited balance sheet');
    await expect(d.getByLabel('Title')).toHaveValue('BS FY2024-25');
    await expect(d.getByRole('combobox').filter({ hasText: 'FY 2024-25' })).toBeVisible();
    await ev(page, 'ac02-guessed-metadata-balance-sheet');
    await d.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Upload document' }).first().click();
    await pickFile(page, { name: 'ISO_9001_cert.pdf', mimeType: 'application/pdf', buffer: await makePdf(1) });
    await expect(d.locator('button[aria-haspopup="listbox"]')).toContainText('ISO certificate');
    await d.getByLabel('Issue date').fill('2026-01-10');
    await expect(d.getByText('ISO certificates are typically valid for 3 years.')).toBeVisible();
    await ev(page, 'ac02-iso-validity-hint');
    await d.getByRole('button', { name: 'Use 09 Jan 2029' }).click();
    await expect(d.getByLabel('Expiry date')).toHaveValue('2029-01-09');
    await ev(page, 'ac02-iso-suggestion-applied');
  });

  test('AC3 valid PDF upload -> 201 DTO, toast, drawer opens, activity vault.uploaded, card shows PDF · 2p', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/vault?upload=1');
    const bytes = await makePdf(2, 'GST');
    await pickFile(page, { name: 'GST_REG06_2023.pdf', mimeType: 'application/pdf', buffer: bytes });
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/vault') && r.request().method() === 'POST');
    await uploadDialog(page).getByRole('button', { name: 'Upload document' }).click();
    const r = await resp;
    expect(r.status()).toBe(201);
    const dto = (await r.json()) as VaultDoc;
    expect(dto).toMatchObject({ status: 'valid', daysToExpiry: null, pageCount: 2, mimeType: 'application/pdf', type: 'gst', title: 'GST REG06 2023' });
    expect(dto.downloadUrl).toBe(`/api/vault/${dto.id}/download`);
    await expect(toast(page, '“GST REG06 2023” added to the vault')).toContainText('2 pages · stored privately');
    await expect(page).toHaveURL(new RegExp(`doc=${dto.id}`));
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).getByText('GST REG06 2023').first()).toBeVisible();
    await ev(page, 'ac03-upload-toast-and-drawer');
    expect(await activityActions(page.request, dto.id)).toContain('vault.uploaded');
    // card in the grid
    await closeDrawer(page);
    const card = page.locator('.group.relative').filter({ has: page.getByRole('button', { name: 'Open GST REG06 2023' }) });
    await expect(card).toContainText('No expiry');
    await expect(card).toContainText('PDF · 2p');
    await ev(page, 'ac03-card-valid-no-expiry-pdf-2p');
    // Independent test: download bytes equal the original
    await page.getByRole('button', { name: 'Open GST REG06 2023' }).click();
    const dl = page.waitForEvent('download');
    await drawer(page).getByRole('link', { name: 'Download' }).click();
    const file = await dl;
    expect(readFileSync(await file.path()!).equals(bytes)).toBe(true);
    expect(file.suggestedFilename()).toBe('GST_REG06_2023.pdf');
  });

  test('AC4 PNG expiring in 10 days -> expiring badge/toast; expired yesterday -> "Expired 1d ago"', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/vault');
    const png = makePng();
    let r = await uiUpload(page, { name: 'ISO_9001_cert.png', mime: 'image/png', bytes: png, title: 'ISO plus ten', expiry: istDay(10) });
    expect(r.status()).toBe(201);
    let dto = (await r.json()) as VaultDoc;
    expect(dto).toMatchObject({ status: 'expiring', daysToExpiry: 10, mimeType: 'image/png', pageCount: 1 });
    await expect(toast(page, '“ISO plus ten” added to the vault')).toContainText('It expires in 10 days — we’ll remind you.');
    await expect(drawer(page).getByText('Expires in 10d')).toBeVisible();
    await ev(page, 'ac04-expiring-in-10d');
    await closeDrawer(page);
    r = await uiUpload(page, { name: 'ISO_9001_old.png', mime: 'image/png', bytes: makePng(65, 48), // different bytes: duplicates are refused since US6 (FR-067)
      title: 'ISO yesterday', expiry: istDay(-1) });
    expect(r.status()).toBe(201);
    dto = (await r.json()) as VaultDoc;
    expect(dto).toMatchObject({ status: 'expired', daysToExpiry: -1 });
    await expect(toast(page, '“ISO yesterday” added to the vault')).toContainText('Heads up: this document has already expired.');
    await expect(drawer(page).getByText('Expired 1d ago').first()).toBeVisible();
    await ev(page, 'ac04-expired-1d-ago');
  });

  test('AC5 rejections: 415 / 422 / 413 / 400 x3 with exact messages and nothing stored (API + dialog)', async ({ page }) => {
    await signupViaApi(page);
    const orgId = (await me(page.request)).org.id;
    const rq = page.request;
    const err = async (res: import('@playwright/test').APIResponse) => (await res.json()).error as { code: string; message: string; details?: { fields?: Record<string, string> } };

    let res = await apiUpload(rq, { name: 'a.pdf', bytes: Buffer.from('this is plain text, not a pdf'), mime: 'application/pdf' });
    expect(res.status()).toBe(415);
    expect(await err(res)).toMatchObject({ code: 'unsupported_media_type', message: 'Only PDF, PNG and JPG files can be stored in the vault.' });

    res = await apiUpload(rq, { name: 'broken.pdf', bytes: Buffer.from('%PDF-1.7 garbage'), mime: 'application/pdf' });
    expect(res.status()).toBe(422);
    expect(await err(res)).toMatchObject({ code: 'unreadable_pdf', message: 'This PDF looks damaged and could not be opened. Re-export or re-scan it and try again.' });

    const big = Buffer.concat([await makePdf(1), Buffer.alloc(20 * MB + 10)]);
    res = await apiUpload(rq, { name: 'huge.pdf', bytes: big, mime: 'application/pdf' });
    expect(res.status()).toBe(413);
    expect(await err(res)).toMatchObject({ code: 'payload_too_large', message: 'Files can be at most 20 MB. Compress the scan or split it and try again.' });

    res = await rq.post('/api/vault', { multipart: { title: 'No file here' } });
    expect(res.status()).toBe(400);
    const e400 = await err(res);
    expect(e400.code).toBe('validation_error');
    expect(e400.details?.fields?.file).toBe('Choose a PDF, PNG or JPG file');

    res = await apiUpload(rq, { name: 'empty.pdf', bytes: Buffer.alloc(0), mime: 'application/pdf' });
    expect(res.status()).toBe(400);
    const eEmpty = await err(res);
    expect(eEmpty.code).toBe('validation_error');
    expect(eEmpty.message + JSON.stringify(eEmpty.details)).toContain('The file is empty');

    res = await apiUpload(rq, { name: 'dates.pdf', bytes: await makePdf(1), fields: { issueDate: '2025-01-01', expiryDate: '2024-01-01', title: 'Bad dates' } });
    expect(res.status()).toBe(400);
    const eDates = await err(res);
    expect(eDates.code).toBe('validation_error');
    expect(eDates.details?.fields?.expiryDate).toBe('Expiry date is before the issue date');

    // no row and no blob in any failure case
    const list = await (await rq.get('/api/vault')).json();
    expect(list.total).toBe(0);
    expect(blobFiles(orgId)).toEqual([]);
    expect(sql(`select count(*) from vault_documents where org_id='${orgId}'`)).toBe('0');

    // Same 415 / 422 messages as the user sees them under the file in the dialog
    await page.goto('/vault?upload=1');
    await pickFile(page, { name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('plain text renamed a.pdf') });
    await uploadDialog(page).getByLabel('Title').fill('Renamed text');
    await uploadDialog(page).getByRole('button', { name: 'Upload document' }).click();
    await expect(uploadDialog(page).getByRole('alert').filter({ hasText: 'Only PDF, PNG and JPG files can be stored in the vault.' })).toBeVisible();
    await ev(page, 'ac05-dialog-415-message');
    await pickFile(page, { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 garbage') });
    await uploadDialog(page).getByRole('button', { name: 'Upload document' }).click();
    await expect(uploadDialog(page).getByRole('alert').filter({ hasText: 'This PDF looks damaged and could not be opened. Re-export or re-scan it and try again.' })).toBeVisible();
    await ev(page, 'ac05-dialog-422-message');
    expect(blobFiles(orgId)).toEqual([]);
    expect((await (await rq.get('/api/vault')).json()).total).toBe(0);
  });

  test('AC6 25 MB file is refused client-side in the dropzone, on page drop, via Change and via Replace (FR-033)', async ({ page }) => {
    await signupViaApi(page);
    const doc = await apiUploadOk(page.request, { name: 'small.pdf', bytes: await makePdf(1), fields: { title: 'Small doc' } });
    const posts: string[] = [];
    page.on('request', (r) => { if (['POST', 'PUT'].includes(r.method()) && /\/api\/vault/.test(r.url())) posts.push(`${r.method()} ${r.url()}`); });
    await page.goto('/vault');
    const msg = 'scan25.pdf is larger than 20 MB.';
    const big = { name: 'scan25.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(25 * MB, 1) };

    // dropzone in the dialog
    await page.getByRole('button', { name: 'Upload document' }).first().click();
    await pickFile(page, big);
    await expect(uploadDialog(page).getByText(msg)).toBeVisible();
    await expect(uploadDialog(page).getByRole('button', { name: 'Upload document' })).toBeDisabled();
    await ev(page, 'ac06-dropzone-25mb');

    // Change: choose a valid file first, then a 25 MB one
    await pickFile(page, { name: 'ok.pdf', mimeType: 'application/pdf', buffer: await makePdf(1) });
    await expect(uploadDialog(page).getByText('ok.pdf')).toBeVisible();
    await pickFile(page, big);
    await expect(uploadDialog(page).getByRole('alert').filter({ hasText: msg })).toBeVisible();
    await ev(page, 'ac06-change-25mb');
    await uploadDialog(page).getByRole('button', { name: 'Cancel' }).click();

    // page-level drop
    await dropFile(page.getByRole('heading', { name: 'Document vault' }), { name: 'scan25.pdf', mime: 'application/pdf', size: 25 * MB });
    await expect(toast(page, msg)).toBeVisible();
    await expect(uploadDialog(page)).toHaveCount(0);
    await ev(page, 'ac06-page-drop-25mb');

    // Replace file in the drawer
    await page.goto(`/vault?doc=${doc.id}`);
    await expect(drawer(page)).toBeVisible();
    await drawer(page).locator('input[type=file]').setInputFiles(big);
    await expect(toast(page, msg).last()).toBeVisible();
    await ev(page, 'ac06-replace-25mb');
    expect(posts, posts.join('\n')).toEqual([]);
  });

  test('AC7 demo tiles 15/12/2/1, 90-day timeline markers, Expired tile toggles ?status=expired showing only Dell', async ({ page }) => {
    await signupViaApi(page);
    await seedDemo(page.request);
    await page.goto('/vault');
    const tile = (n: RegExp) => page.getByRole('button', { name: n });
    await expect(tile(/^All documents/)).toContainText('15');
    await expect(tile(/^Valid/)).toContainText('12');
    await expect(tile(/^Expiring soon/)).toContainText('2');
    await expect(tile(/^Expiring soon/)).toContainText('Within 30 days');
    await expect(tile(/^Expired/)).toContainText('1');
    await expect(tile(/^Expired/)).toContainText('Renew to keep bidding');
    await expect(page.getByRole('heading', { name: 'Expiring in the next 90 days' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^ISO 9001:2015 quality management certificate, Expires in 10d/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^CA certificate – average turnover.*, Expires in 25d/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '1 doc' })).toBeVisible();
    await ev(page, 'ac07-demo-tiles-and-timeline');
    if (test.info().project.name === 'desktop') {
      const boxes = await Promise.all([/^All documents/, /^Valid/, /^Expiring soon/, /^Expired/].map((n) => tile(n).boundingBox()));
      expect(new Set(boxes.map((b) => Math.round(b!.y))).size, 'four tiles in one row on desktop').toBe(1);
    }
    // the expired Dell marker opens its drawer
    await page.getByRole('button', { name: '1 doc' }).click();
    await expect(drawer(page).getByText('OEM authorisation – Dell Technologies (desktops & servers)').first()).toBeVisible();
    await closeDrawer(page);

    await tile(/^Expired/).click();
    await expect(page).toHaveURL(/status=expired/);
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toHaveText('OEM authorisation – Dell Technologies (desktops & servers)');
    await ev(page, 'ac07-expired-filter-only-dell');
    await tile(/^Expired/).click();
    await expect(page).not.toHaveURL(/status=/);
    await expect(cards(page)).toHaveCount(15);
  });

  test('AC8 search "dell" debounced into ?q=; category/type/sort filters in URL; grid/list persisted', async ({ page }) => {
    await signupViaApi(page);
    await seedDemo(page.request);
    await page.goto('/vault');
    await expect(cards(page)).toHaveCount(15);
    const t0 = Date.now();
    await page.getByLabel('Search documents').fill('dell');
    await expect(page).toHaveURL(/[?&]q=dell/);
    const ms = Date.now() - t0;
    test.info().annotations.push({ type: 'debounce', description: `URL updated ${ms} ms after fill (spec: <= 250 ms debounce)` });
    expect(ms).toBeLessThan(1500);
    await expect(page.getByText('1 of 15 documents')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('Dell');
    await ev(page, 'ac08-search-dell');
    await page.getByLabel('Search documents').fill('DELL');           // case-insensitive
    await expect(cards(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(cards(page)).toHaveCount(15);

    // category + type
    await page.getByRole('radio', { name: 'Financial' }).click();
    await expect(page).toHaveURL(/category=Financial/);
    await page.getByRole('combobox', { name: 'Document type' }).click();
    await page.getByRole('option', { name: 'Audited balance sheet' }).click();
    await expect(page).toHaveURL(/type=balance_sheet/);
    await expect(cards(page)).toHaveCount(3);
    for (const t of await cards(page).allTextContents()) expect(t).toContain('Audited balance sheet');
    await ev(page, 'ac08-financial-balance-sheets');
    await page.getByRole('button', { name: 'Clear filters' }).click();

    // sorts
    await page.getByRole('combobox', { name: 'Sort' }).click();
    await page.getByRole('option', { name: 'Expiring first' }).click();
    await expect(page).toHaveURL(/sort=expiry/);
    await expect(cards(page).first()).toContainText('Dell');
    const byExpiry = await cards(page).allTextContents();
    expect(byExpiry.slice(0, 4)).toEqual([
      expect.stringContaining('Dell'), expect.stringContaining('ISO 9001:2015'), expect.stringContaining('CA certificate'), expect.stringContaining('CP PLUS'),
    ]);
    // Everything after the four dated docs has no expiry date: the cards say "Added …", not "Expires …"
    const footers = await page.locator('div.border-t.pt-3 > span:first-child').allTextContents();
    expect(footers.slice(0, 4).every((f) => f.startsWith('Expires'))).toBe(true);
    expect(footers.slice(4).every((f) => f.startsWith('Added'))).toBe(true);
    await ev(page, 'ac08-sort-expiring-first');
    await page.getByRole('combobox', { name: 'Sort' }).click();
    await page.getByRole('option', { name: 'Title A–Z' }).click();
    await expect(page).toHaveURL(/sort=title/);
    await expect.poll(async () => (await cards(page).allTextContents())[0]).toContain('Audited balance sheet FY 2022-23');
    const titles = await cards(page).allTextContents();
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    await ev(page, 'ac08-sort-title-az');

    // grid/list persists
    await page.getByRole('radio', { name: 'List' }).click();
    await expect(page.getByRole('table')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('table')).toBeVisible();
    await ev(page, 'ac08-list-view-persisted-after-reload');
    await page.getByRole('radio', { name: 'Grid' }).click();
  });

  test('AC9 no-match empty states with Clear filters', async ({ page }) => {
    await signupViaApi(page);
    await apiUploadOk(page.request, { name: 'pan_card.pdf', bytes: await makePdf(1), fields: { title: 'PAN card', expiryDate: istDay(200) } });
    await page.goto('/vault');
    await page.getByLabel('Search documents').fill('zzzz-nothing');
    await expect(page.getByText('No documents match')).toBeVisible();
    await expect(page.getByText('Try a different search or clear the filters.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear filters' }).first()).toBeVisible();
    await ev(page, 'ac09-no-documents-match');
    await page.getByRole('button', { name: 'Clear filters' }).last().click();
    await expect(cards(page)).toHaveCount(1);

    await page.goto('/vault?status=expired');
    await expect(page.getByText('No documents match')).toBeVisible();
    await expect(page.getByText('Nothing has expired. Nice.')).toBeVisible();
    await ev(page, 'ac09-nothing-has-expired');
    await page.getByRole('button', { name: 'Clear filters' }).last().click();
    await expect(page).not.toHaveURL(/status=/);
    await expect(cards(page)).toHaveCount(1);
  });

  test('AC10 drawer: PDF iframe / image preview, metadata, uploader; Download attachment & Open inline with private no-store + nosniff', async ({ page }) => {
    const user = await signupViaApi(page);
    const pdf = await makePdf(3, 'Drawer');
    const png = makePng(80, 60);
    const a = await apiUploadOk(page.request, { name: 'audited_bs.pdf', bytes: pdf, fields: { title: 'Audited BS 2024', number: 'BS-001', issuer: 'Mehta & Co', issueDate: '2025-05-01', expiryDate: istDay(100), financialYear: '2024-25', tags: JSON.stringify(['finance']) } });
    const b = await apiUploadOk(page.request, { name: 'scan.png', bytes: png, mime: 'image/png', fields: { title: 'Scanned letter' } });
    expect(a.tags).toEqual(expect.any(Array));

    await page.goto('/vault');
    await page.getByRole('button', { name: 'Open Audited BS 2024' }).click();
    await expect(page).toHaveURL(new RegExp(`doc=${a.id}`));
    const d = drawer(page);
    const iframe = d.locator('iframe[title="Preview of Audited BS 2024"]');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('src', new RegExp(`/api/vault/${a.id}/download\\?inline=1`));
    for (const label of ['Number', 'Issued by', 'Issue date', 'Expiry date', 'Tags', 'File']) await expect(d.getByText(label, { exact: true })).toBeVisible();
    await expect(d.getByText('BS-001')).toBeVisible();
    await expect(d.getByText('Mehta & Co')).toBeVisible();
    await expect(d.getByText(/audited_bs\.pdf · .* · 3 pages/)).toBeVisible();
    await expect(d.getByText(new RegExp(`Uploaded .* by ${user.name}`))).toBeVisible();
    await ev(page, 'ac10-drawer-pdf-preview-metadata');
    const href = await d.getByRole('link', { name: 'Open' }).getAttribute('href');
    expect(href).toContain(`/api/vault/${a.id}/download`);
    expect(href).toContain('inline=1');
    await expect(d.getByRole('link', { name: 'Open' })).toHaveAttribute('target', '_blank');
    // Download via the button: bytes equal
    const dl = page.waitForEvent('download');
    await d.getByRole('link', { name: 'Download' }).click();
    expect(readFileSync(await (await dl).path()!).equals(pdf)).toBe(true);

    // headers
    const attach = await page.request.get(`/api/vault/${a.id}/download`);
    expect(attach.status()).toBe(200);
    expect(attach.headers()['content-disposition']).toMatch(/^attachment/);
    expect(attach.headers()['cache-control']).toBe('private, no-store');
    expect(attach.headers()['x-content-type-options']).toBe('nosniff');
    expect(attach.headers()['content-type']).toBe('application/pdf');
    expect(Buffer.from(await attach.body()).equals(pdf)).toBe(true);
    const inline = await page.request.get(`/api/vault/${a.id}/download?inline=1`);
    expect(inline.headers()['content-disposition']).toMatch(/^inline/);
    expect(inline.headers()['cache-control']).toBe('private, no-store');
    expect(inline.headers()['x-content-type-options']).toBe('nosniff');

    // image doc + "Does not expire"
    await closeDrawer(page);
    await page.getByRole('button', { name: 'Open Scanned letter' }).click();
    await expect(d.locator('img[alt="Scan of Scanned letter"]')).toBeVisible();
    await expect.poll(() => d.locator('img[alt="Scan of Scanned letter"]').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(80);
    await expect(d.getByText('Does not expire')).toBeVisible();
    await ev(page, 'ac10-drawer-image-preview');
    const pngRes = await page.request.get(`/api/vault/${b.id}/download`);
    expect(Buffer.from(await pngRes.body()).equals(png)).toBe(true);
    expect(pngRes.headers()['content-type']).toBe('image/png');
  });

  test('AC11 edit details -> PATCH 200, "Document updated", badge updates, last_reminder_days reset only on expiry change', async ({ page }) => {
    await signupViaApi(page);
    const doc = await apiUploadOk(page.request, { name: 'iso.pdf', bytes: await makePdf(1), fields: { title: 'ISO to edit', type: 'iso', expiryDate: istDay(8) } });
    sql(`update vault_documents set last_reminder_days=7 where id='${doc.id}'`);
    expect(sql(`select last_reminder_days from vault_documents where id='${doc.id}'`)).toBe('7');
    // title-only change keeps the reminder cycle
    const keep = await page.request.patch(`/api/vault/${doc.id}`, { data: { title: 'ISO to edit (renamed)' } });
    expect(keep.status()).toBe(200);
    expect(sql(`select last_reminder_days from vault_documents where id='${doc.id}'`)).toBe('7');

    await page.goto(`/vault?doc=${doc.id}`);
    await expect(drawer(page).getByText('Expires in 8d').first()).toBeVisible();
    await drawer(page).getByRole('button', { name: 'Edit details' }).click();
    await drawer(page).getByLabel('Expiry date').fill(istDay(60));
    await ev(page, 'ac11-edit-form');
    const resp = page.waitForResponse((r) => r.url().endsWith(`/api/vault/${doc.id}`) && r.request().method() === 'PATCH');
    await drawer(page).getByRole('button', { name: 'Save changes' }).click();
    const r = await resp;
    expect(r.status()).toBe(200);
    expect(await r.json()).toMatchObject({ expiryDate: istDay(60), status: 'valid', daysToExpiry: 60 });
    await expect(toast(page, 'Document updated')).toBeVisible();
    await expect(drawer(page).getByText('Expires in 8d')).toHaveCount(0);
    await expect(drawer(page).getByText('Valid').first()).toBeVisible();
    await ev(page, 'ac11-updated-badge');
    expect(sql(`select last_reminder_days is null from vault_documents where id='${doc.id}'`)).toBe('t');
  });

  test('AC12 replace file -> PUT 200 new file fields, metadata kept, toast, old blob kept as a version, vault.file_replaced', async ({ page }) => {
    await signupViaApi(page);
    const orgId = (await me(page.request)).org.id;
    const doc = await apiUploadOk(page.request, {
      name: 'old-cert.pdf', bytes: await makePdf(1, 'old'),
      fields: { title: 'Cert to replace', number: 'C-77', issuer: 'Issuer Ltd', issueDate: '2025-02-01', expiryDate: istDay(90), tags: JSON.stringify(['keep-me']) },
    });
    expect(blobFiles(orgId)).toEqual([`${doc.id}/old-cert.pdf`]);
    const fresh = await makePdf(3, 'renewed');
    await page.goto(`/vault?doc=${doc.id}`);
    await expect(drawer(page)).toBeVisible();
    await ev(page, 'ac12-before-replace');
    const resp = page.waitForResponse((r) => r.url().endsWith(`/api/vault/${doc.id}/file`) && r.request().method() === 'PUT');
    await drawer(page).locator('input[type=file]').setInputFiles({ name: 'renewed-cert.pdf', mimeType: 'application/pdf', buffer: fresh });
    const r = await resp;
    expect(r.status()).toBe(200);
    const nd = (await r.json()) as VaultDoc;
    expect(nd).toMatchObject({ fileName: 'renewed-cert.pdf', sizeBytes: fresh.length, pageCount: 3, mimeType: 'application/pdf' });
    expect({ title: nd.title, number: nd.number, issuer: nd.issuer, issueDate: nd.issueDate, expiryDate: nd.expiryDate, tags: nd.tags, type: nd.type })
      .toEqual({ title: doc.title, number: doc.number, issuer: doc.issuer, issueDate: doc.issueDate, expiryDate: doc.expiryDate, tags: doc.tags, type: doc.type });
    const t = toast(page, 'File replaced');
    await expect(t).toBeVisible();
    await expect(t).toContainText('Metadata kept. Update the expiry date if this is a renewed copy.');
    await expect(drawer(page).getByText(/renewed-cert\.pdf · .* · 3 pages/)).toBeVisible();
    await ev(page, 'ac12-after-replace');
    // FR-032 amended by US6 (FR-065): the new file gets a unique key and the old blob is kept as a version.
    const files = blobFiles(orgId);
    expect(files).toHaveLength(2);
    expect(files).toContain(`${doc.id}/old-cert.pdf`);
    expect(files.find((f) => f !== `${doc.id}/old-cert.pdf`)).toMatch(new RegExp(`^${doc.id}/[0-9a-f-]{36}/renewed-cert\\.pdf$`));
    expect(Buffer.from(await (await page.request.get(`/api/vault/${doc.id}/download`)).body()).equals(fresh)).toBe(true);
    expect(await activityActions(page.request, doc.id)).toContain('vault.file_replaced');
  });

  test('AC13 delete -> confirm, 200 {ok:true}, row+blob gone, CRAC and OEM links cleared, toast, drawer closes', async ({ page }) => {
    await signupViaApi(page);
    const orgId = (await me(page.request)).org.id;
    // Both linked from the profile's OEM list, so both must be oem_authorization documents (FR-061, US5); CRAC links only need vault ownership.
    const doc = await apiUploadOk(page.request, { name: 'crac.pdf', bytes: await makePdf(1), fields: { title: 'CRAC to delete', type: 'oem_authorization' } });
    const keep = await apiUploadOk(page.request, { name: 'other.pdf', bytes: await makePdf(1, 'other'), fields: { title: 'Untouched doc', type: 'oem_authorization' } });
    const pc = await page.request.post('/api/past-contracts', { data: { buyer: 'PMC', buyerType: 'state', title: 'CCTV supply', value: 5000000, cracDocumentId: doc.id } });
    expect(pc.status(), await pc.text()).toBe(201);
    const pcId = (await pc.json()).id as string;
    const prof = await page.request.put('/api/profile', { data: { oemAuthorizations: [
      { oem: 'Dell', products: 'Desktops', documentId: doc.id }, { oem: 'HP', products: 'Laptops', documentId: keep.id }, { oem: 'Lenovo', products: '' },
    ] } });
    expect(prof.status(), await prof.text()).toBe(200);

    await page.goto(`/vault?doc=${doc.id}`);
    await drawer(page).getByRole('button', { name: 'Delete document' }).click();
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog').filter({ hasText: 'Delete “CRAC to delete”?' })).last();
    await expect(confirm.getByText('Delete “CRAC to delete”?')).toBeVisible();
    await ev(page, 'ac13-delete-confirm');
    const resp = page.waitForResponse((r) => r.url().endsWith(`/api/vault/${doc.id}`) && r.request().method() === 'DELETE');
    await confirm.getByRole('button', { name: 'Delete document' }).click();
    const r = await resp;
    expect(r.status()).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    await expect(toast(page, '“CRAC to delete” deleted')).toBeVisible();
    await expect(drawer(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/doc=/);
    await ev(page, 'ac13-after-delete');

    expect((await page.request.get(`/api/vault/${doc.id}`)).status()).toBe(404);
    expect(sql(`select count(*) from vault_documents where id='${doc.id}'`)).toBe('0');
    expect(blobFiles(orgId)).toEqual([`${keep.id}/other.pdf`]);
    const contracts = (await (await page.request.get('/api/past-contracts')).json()).items as { id: string; cracDocumentId: string | null }[];
    expect(contracts.find((c) => c.id === pcId)!.cracDocumentId).toBeNull();
    const oem = (await (await page.request.get('/api/profile')).json()).profile.oemAuthorizations as { oem: string; documentId?: string | null }[];
    expect(oem.map((o) => [o.oem, o.documentId ?? null])).toEqual([['Dell', null], ['HP', keep.id], ['Lenovo', null]]);
    expect(await activityActions(page.request, doc.id)).toContain('vault.deleted');
  });

  test('AC14 Viewer: write controls absent/inactive, download works, write endpoints 403 forbidden', async ({ page, browser }) => {
    await signupViaApi(page);
    const baseURL = test.info().project.use.baseURL as string;
    const viewer = await viewerPage(browser, page.request, baseURL, page.viewportSize());
    try {
      // empty vault: onboarding tiles disabled
      await viewer.page.goto('/vault');
      await expect(viewer.page.getByRole('heading', { name: 'Build your bid-ready vault once, reuse it on every tender' })).toBeVisible();
      await expect(viewer.page.getByRole('button', { name: 'Upload document' })).toHaveCount(0);
      const tiles = viewer.page.getByRole('button', { name: /^Audited balance sheet/ });
      await expect(tiles).toBeDisabled();
      await expect(viewer.page.getByRole('button', { name: /^GST registration/ })).toBeDisabled();
      await ev(viewer.page, 'ac14-viewer-onboarding-tiles-disabled');

      // with a document
      const bytes = await makePdf(2, 'viewer');
      const doc = await apiUploadOk(page.request, { name: 'vcert.pdf', bytes, fields: { title: 'Viewer cert', expiryDate: istDay(200) } });
      await viewer.page.goto('/vault');
      await expect(viewer.page.getByRole('button', { name: 'Open Viewer cert' })).toBeVisible();
      await expect(viewer.page.getByRole('button', { name: 'Upload document' })).toHaveCount(0);
      await expect(viewer.page.getByText('Commonly asked for, not in your vault yet:')).toHaveCount(0);
      await dropFile(viewer.page.getByRole('heading', { name: 'Document vault' }), { name: 'GST_REG06_2023.pdf', mime: 'application/pdf', bytes: await makePdf(1) });
      await viewer.page.waitForTimeout(500);
      await expect(uploadDialog(viewer.page)).toHaveCount(0);
      await expect(viewer.page.getByText('Drop to add to the vault')).toHaveCount(0);
      await viewer.page.goto('/vault?upload=1');
      await expect(uploadDialog(viewer.page)).toHaveCount(0);
      await viewer.page.getByRole('button', { name: 'Open Viewer cert' }).click();
      const d = drawer(viewer.page);
      await expect(d.getByRole('link', { name: 'Download' })).toBeVisible();
      await expect(d.getByRole('link', { name: 'Open' })).toBeVisible();
      for (const n of ['Edit details', 'Delete document']) await expect(d.getByRole('button', { name: n })).toHaveCount(0);
      await expect(d.getByText('Replace file')).toHaveCount(0);
      await expect(d.locator('input[type=file]')).toHaveCount(0);
      await ev(viewer.page, 'ac14-viewer-drawer-no-write-controls');
      const dl = viewer.page.waitForEvent('download');
      await d.getByRole('link', { name: 'Download' }).click();
      expect(readFileSync(await (await dl).path()!).equals(bytes)).toBe(true);

      // API
      const rq = viewer.request;
      expect((await rq.get(`/api/vault/${doc.id}/download`)).status()).toBe(200);
      const calls = [
        await apiUpload(rq, { name: 'x.pdf', bytes: await makePdf(1) }),
        await rq.patch(`/api/vault/${doc.id}`, { data: { title: 'hacked' } }),
        await rq.put(`/api/vault/${doc.id}/file`, { multipart: { file: { name: 'x.pdf', mimeType: 'application/pdf', buffer: await makePdf(1) } } }),
        await rq.delete(`/api/vault/${doc.id}`),
      ];
      for (const res of calls) {
        expect(res.status(), `${res.url()} ${await res.text()}`).toBe(403);
        expect((await res.json()).error.code).toBe('forbidden');
      }
      expect((await (await page.request.get(`/api/vault/${doc.id}`)).json()).title).toBe('Viewer cert');   // untouched
    } finally { await viewer.ctx.close(); }
  });

  test('AC15 other org id / malformed id -> 404 "Document not found"; unauthenticated -> 401', async ({ page, request, playwright }) => {
    await signupViaApi(page);
    // org B via the standalone `request` context (separate cookie jar)
    const b = uniqueUser('orgb');
    expect((await request.post('/api/auth/signup', { data: b })).status()).toBe(201);
    const docB = await apiUploadOk(request, { name: 'b.pdf', bytes: await makePdf(1), fields: { title: 'Org B secret' } });
    const rq = page.request;
    const notFound = async (res: import('@playwright/test').APIResponse, label: string) => {
      expect(res.status(), `${label}: ${await res.text()}`).toBe(404);
      expect((await res.json()).error).toMatchObject({ code: 'not_found', message: 'Document not found' });
    };
    await notFound(await rq.get(`/api/vault/${docB.id}`), 'GET');
    await notFound(await rq.get(`/api/vault/${docB.id}/download`), 'download');
    await notFound(await rq.patch(`/api/vault/${docB.id}`, { data: { title: 'pwned' } }), 'PATCH');
    await notFound(await rq.put(`/api/vault/${docB.id}/file`, { multipart: { file: { name: 'x.pdf', mimeType: 'application/pdf', buffer: await makePdf(1) } } }), 'PUT');
    await notFound(await rq.delete(`/api/vault/${docB.id}`), 'DELETE');
    await notFound(await rq.get('/api/vault/not-a-uuid'), 'malformed GET');
    await notFound(await rq.get('/api/vault/not-a-uuid/download'), 'malformed download');
    await notFound(await rq.delete('/api/vault/12345'), 'malformed DELETE');
    // org B's doc is untouched and absent from org A's list
    const still = await (await request.get(`/api/vault/${docB.id}`)).json();
    expect(still.title).toBe('Org B secret');
    expect((await (await rq.get('/api/vault')).json()).total).toBe(0);
    await page.goto(`/vault?doc=${docB.id}`);
    await expect(toast(page, 'That document could not be found. It may have been deleted.')).toBeVisible();
    await ev(page, 'ac15-cross-org-doc-link-not-found');

    // unauthenticated
    const anon = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL as string });
    for (const [m, p] of [['GET', '/api/vault'], ['GET', `/api/vault/${docB.id}`], ['GET', `/api/vault/${docB.id}/download`], ['PATCH', `/api/vault/${docB.id}`], ['DELETE', `/api/vault/${docB.id}`], ['POST', '/api/vault']] as const) {
      const res = await anon.fetch(p, { method: m });
      expect(res.status(), `${m} ${p}`).toBe(401);
    }
    await anon.dispose();
  });

  test('AC16 /vault?doc=<deleted id> -> toast and doc param removed (FR-040)', async ({ page }) => {
    await signupViaApi(page);
    const doc = await apiUploadOk(page.request, { name: 'gone.pdf', bytes: await makePdf(1), fields: { title: 'Soon gone' } });
    expect((await page.request.delete(`/api/vault/${doc.id}`)).status()).toBe(200);
    await page.goto(`/vault?doc=${doc.id}`);
    await expect(toast(page, 'That document could not be found. It may have been deleted.')).toBeVisible();
    await expect(page).not.toHaveURL(/doc=/);
    await expect(drawer(page)).toHaveCount(0);
    await ev(page, 'ac16-deleted-doc-link');
    // an id that never existed and a malformed one behave the same
    await page.goto('/vault?doc=11111111-1111-4111-8111-111111111111');
    await expect(toast(page, 'That document could not be found. It may have been deleted.')).toBeVisible();
    await expect(page).not.toHaveURL(/doc=/);
    await page.goto('/vault?doc=garbage');
    await expect(toast(page, 'That document could not be found. It may have been deleted.')).toBeVisible();
    await expect(page).not.toHaveURL(/doc=/);
  });

  test('REVIEW-FIX long Hindi file name uploads and downloads (UTF-8 name budget)', async ({ page }) => {
    await signupViaApi(page);
    const name = `${'आयकर_रिटर्न_प्रमाणपत्र_'.repeat(8)}2024.pdf`;
    expect(Buffer.byteLength(name)).toBeGreaterThan(255);
    const bytes = await makePdf(1, 'hindi');
    const res = await apiUpload(page.request, { name, bytes, fields: { title: 'हिंदी दस्तावेज़' } });
    expect(res.status(), await res.text()).toBe(201);
    const dto = (await res.json()) as VaultDoc;
    expect(dto.fileName.endsWith('.pdf')).toBe(true);
    expect(Buffer.byteLength(dto.fileName)).toBeLessThanOrEqual(255);
    expect(dto.fileName).toContain('आयकर');
    const dl = await page.request.get(dto.downloadUrl);
    expect(dl.status()).toBe(200);
    expect(Buffer.from(await dl.body()).equals(bytes)).toBe(true);
    expect(dl.headers()['content-disposition']).toMatch(/filename\*=UTF-8''/);
    await page.goto(`/vault?doc=${dto.id}`);
    await expect(drawer(page).getByText('हिंदी दस्तावेज़').first()).toBeVisible();
    const download = page.waitForEvent('download');
    await drawer(page).getByRole('link', { name: 'Download' }).click();
    const f = await download;
    expect(readFileSync(await f.path()!).equals(bytes)).toBe(true);
    await ev(page, 'review-fix-hindi-filename');
  });

  test('AC1/AC7/AC10 mobile layout: 2x2 tiles, full-width drawer, no horizontal scroll @mobile', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'mobile project only');
    await signupViaApi(page);
    await page.goto('/vault');
    await expect(page.getByRole('heading', { name: 'Build your bid-ready vault once, reuse it on every tender' })).toBeVisible();
    await noHScroll(page, true);
    await ev(page, 'mobile-onboarding');
    await seedDemo(page.request);
    await page.goto('/vault');
    await expect(cards(page)).toHaveCount(15);
    const t = (n: RegExp) => page.getByRole('button', { name: n }).first().boundingBox();
    const [a, v, e, x] = await Promise.all([t(/^All documents/), t(/^Valid/), t(/^Expiring soon/), t(/^Expired/)]);
    expect(Math.abs(a!.y - v!.y)).toBeLessThan(2);
    expect(Math.abs(e!.y - x!.y)).toBeLessThan(2);
    expect(e!.y).toBeGreaterThan(a!.y + a!.height - 2);
    expect(Math.abs(a!.x - e!.x)).toBeLessThan(2);
    expect(v!.x).toBeGreaterThan(a!.x + a!.width - 2);
    await noHScroll(page, true);
    await ev(page, 'mobile-tiles-2x2');
    await page.getByRole('button', { name: /^Open Audited balance sheet FY 2024-25/ }).click();
    await expect.poll(async () => (await drawer(page).boundingBox())?.x ?? 999, { message: 'drawer slides in to x=0' }).toBeLessThanOrEqual(1);
    const box = await drawer(page).boundingBox();
    const vw = page.viewportSize()!.width;
    expect(box!.width, `drawer ${box!.width} of ${vw}`).toBeGreaterThanOrEqual(vw - 2);
    expect.soft(box!.width, `drawer is ${box!.width}px wide in a ${vw}px viewport`).toBeLessThanOrEqual(vw + 1);
    await ev(page, 'mobile-drawer-full-width');
    // NFR-006 is specified at 375 px: re-check the demo vault page at that width
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/vault');
    await expect(cards(page)).toHaveCount(15);
    await noHScroll(page, true);
    await ev(page, 'mobile-375px-vault');
  });
});
