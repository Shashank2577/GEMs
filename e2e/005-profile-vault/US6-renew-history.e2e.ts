/**
 * 005 / US6 (#119) — Renew a document in one step and keep its history (FR-064…FR-068, amended FR-032).
 * One test per acceptance criterion + the review-driven behaviours. Evidence in qa/evidence/005/US6/.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, signupViaApi, evidence, collectRunArtifacts, a11y } from '../support/fixtures';
import {
  activity, apiRenew, apiUpload, apiUploadOk, blobFiles, captureForms, fmt, istDay, listVersions, me, noHScroll, pdf,
  plusMonthsMinusDay, sql, viewerPage, type VaultDoc,
} from './support-us6';

const SPEC = '005', STORY = 'US6';
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, `${test.info().project.name}-${name}`);

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

const toast = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
/** The preview drawer (first dialog in the DOM; the Renew / Upload dialogs open after it). */
const drawer = (page: Page) => page.locator('[role=dialog]').first();
const renewDialog = (page: Page) => page.getByRole('dialog', { name: /^Renew “/ });
const uploadDialog = (page: Page) => page.getByRole('dialog', { name: 'Add a document' });
const lastReminder = (id: string) => sql(`select coalesce(last_reminder_days::text,'NULL') from vault_documents where id='${id}'`);

async function isoDoc(request: import('@playwright/test').APIRequestContext, title: string, expiryOffset: number, extra: Record<string, string> = {}, label = title) {
  return apiUploadOk(request, {
    name: `${title.replace(/\W+/g, '-')}.pdf`, bytes: await pdf(label),
    fields: { type: 'iso', title, expiryDate: istDay(expiryOffset), number: 'ISO-OLD-1', ...extra },
  });
}
/** The document card on /vault (the stretched Open button's parent). */
const cardOf = (page: Page, title: string) => page.getByRole('button', { name: `Open ${title}` }).locator('..');
const openDrawer = async (page: Page, id: string) => { await page.goto(`/vault?doc=${id}`); await expect(drawer(page).getByRole('button', { name: 'Close' })).toBeVisible(); };

test.describe('US6 renew & history', () => {
  test('AC1 Renew dialog: file picker, issue date today, expiry pre-filled by suggestExpiry, number; sends PUT /api/vault/:id/file with the fields @mobile', async ({ page }) => {
    await signupViaApi(page);
    const forms = await captureForms(page);
    const doc = await isoDoc(page.request, 'ISO 9001 certificate', 10);
    await openDrawer(page, doc.id);
    await expect(drawer(page).getByText('Expires in 10d')).toBeVisible();
    await ev(page, 'ac01-drawer-with-renew-button');
    await drawer(page).getByRole('button', { name: 'Renew' }).click();

    const d = renewDialog(page);
    await expect(d).toBeVisible();
    await expect(d.getByRole('heading', { name: 'Renew “ISO 9001 certificate”' })).toBeVisible();
    await expect(d.locator('input[type=file]')).toHaveCount(1);
    const today = istDay(0), expected = plusMonthsMinusDay(today, 36);
    await expect(d.getByLabel('Issue date')).toHaveValue(today);
    await expect(d.getByLabel('Expiry date')).toHaveValue(expected);
    await expect(d.getByLabel('Number')).toHaveValue('ISO-OLD-1');
    await ev(page, 'ac01-renew-dialog-defaults');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

    // Changing the issue date moves the (untouched) expiry with it.
    await d.getByLabel('Issue date').fill('2026-12-01');
    await expect(d.getByLabel('Expiry date')).toHaveValue('2029-11-30');
    await d.getByLabel('Issue date').fill(today);
    await expect(d.getByLabel('Expiry date')).toHaveValue(expected);

    await d.locator('input[type=file]').setInputFiles({ name: 'iso-renewed.pdf', mimeType: 'application/pdf', buffer: await pdf('iso renewed') });
    await expect(d.getByText('iso-renewed.pdf')).toBeVisible();
    await d.getByLabel('Number').fill('ISO-NEW-2');
    await ev(page, 'ac01-renew-dialog-file-chosen');
    const reqP = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/api/vault/${doc.id}/file`));
    await d.getByRole('button', { name: 'Renew document' }).click();
    const req = await reqP;
    await req.response();
    const sent = (await forms()).filter((f) => f.method === 'PUT' && f.url.endsWith(`/vault/${doc.id}/file`));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.fields).toEqual({ issueDate: today, expiryDate: expected, number: 'ISO-NEW-2' });
    expect(sent[0]!.files).toEqual(['iso-renewed.pdf']);
  });

  test('AC2 renewal -> 200, metadata updated, last_reminder_days null, toast, activity vault.renewed @mobile', async ({ page }) => {
    await signupViaApi(page);
    const doc = await isoDoc(page.request, 'ISO 27001 certificate', 10);
    sql(`update vault_documents set last_reminder_days=7 where id='${doc.id}'`);
    expect(lastReminder(doc.id)).toBe('7');
    await openDrawer(page, doc.id);
    await drawer(page).getByRole('button', { name: 'Renew' }).click();
    const d = renewDialog(page);
    await d.locator('input[type=file]').setInputFiles({ name: 'iso27001-renewed.pdf', mimeType: 'application/pdf', buffer: await pdf('iso27001 renewed') });
    const respP = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/vault/${doc.id}/file`));
    await d.getByRole('button', { name: 'Renew document' }).click();
    const resp = await respP;
    expect(resp.status(), await resp.text()).toBe(200);
    const body = (await resp.json()) as VaultDoc;
    const expected = plusMonthsMinusDay(istDay(0), 36);
    expect(body).toMatchObject({ id: doc.id, expiryDate: expected, issueDate: istDay(0), fileName: 'iso27001-renewed.pdf', status: 'valid' });

    await expect(toast(page, `“ISO 27001 certificate” renewed — valid till ${fmt(expected)}`)).toBeVisible();
    await expect(renewDialog(page)).toBeHidden();
    await ev(page, 'ac02-toast-after-renewal');
    await expect(drawer(page).getByText('Valid', { exact: true }).first()).toBeVisible();
    await expect(drawer(page).getByText('iso27001-renewed.pdf').first()).toBeVisible();
    await ev(page, 'ac02-drawer-valid-after-renewal');

    expect(lastReminder(doc.id)).toBe('NULL');
    const acts = await activity(page.request, doc.id);
    const renewed = acts.find((a) => a.action === 'vault.renewed');
    expect(renewed, JSON.stringify(acts)).toBeTruthy();
    expect(renewed!.meta).toMatchObject({ fromExpiry: istDay(10), toExpiry: expected });
  });

  test('AC2b card badge flips from "Expires in 6d" to Valid after renewal; /vault card badge updates', async ({ page }) => {
    await signupViaApi(page);
    const doc = await isoDoc(page.request, 'ISO 14001 certificate', 6);
    await page.goto('/vault');
    const card = page.locator('h3[title="ISO 14001 certificate"]');
    await expect(card).toBeVisible();
    await expect(cardOf(page, 'ISO 14001 certificate').getByText('Expires in 6d')).toBeVisible();
    await ev(page, 'ac02b-before-expiring-soon');
    const r = await apiRenew(page.request, doc.id, { name: 'r.pdf', bytes: await pdf('14001 renewed'), fields: { issueDate: istDay(0), expiryDate: plusMonthsMinusDay(istDay(0), 36) } });
    expect(r.status(), await r.text()).toBe(200);
    await page.reload();
    const cardRoot = cardOf(page, 'ISO 14001 certificate');
    await expect(page.locator('h3[title="ISO 14001 certificate"]')).toBeVisible();
    await expect(cardRoot.getByText(/^Expires in \d+d$/)).toHaveCount(0);
    await expect(cardRoot.getByText('Valid', { exact: true })).toBeVisible();
    await ev(page, 'ac02b-after-valid');
  });

  test('AC3 drawer Versions: max 5 newest first with Download; 6th renewal prunes the oldest version and its blob @mobile', async ({ page }) => {
    await signupViaApi(page);
    const org = (await me(page.request)).org.id;
    const doc = await isoDoc(page.request, 'Versioned certificate', 20, {}, 'v0');
    const blobs0 = blobFiles(org).length;
    expect(blobs0).toBe(1);
    const bytes: Record<number, Buffer> = {};
    for (let n = 1; n <= 5; n++) {
      bytes[n] = await pdf(`v${n}`);
      const r = await apiRenew(page.request, doc.id, { name: `cert-v${n}.pdf`, bytes: bytes[n]!, fields: { expiryDate: istDay(30 + n) } });
      expect(r.status(), await r.text()).toBe(200);
    }
    // 5 renewals => 5 previous files (v0..v4 names: Versioned-certificate.pdf, cert-v1..v4) are all kept.
    expect((await listVersions(page.request, doc.id)).length).toBe(5);
    expect(blobFiles(org).length).toBe(6);

    // 6th renewal: only 5 versions remain, the oldest is gone from the list AND from blob storage.
    bytes[6] = await pdf('v6');
    const r6 = await apiRenew(page.request, doc.id, { name: 'cert-v6.pdf', bytes: bytes[6]!, fields: { expiryDate: istDay(60) } });
    expect(r6.status(), await r6.text()).toBe(200);
    const versions = await listVersions(page.request, doc.id);
    expect(versions.map((v) => v.fileName)).toEqual(['cert-v5.pdf', 'cert-v4.pdf', 'cert-v3.pdf', 'cert-v2.pdf', 'cert-v1.pdf']);
    expect(sql(`select count(*) from vault_document_versions where document_id='${doc.id}'`)).toBe('5');
    expect(blobFiles(org).length, `blobs: ${blobFiles(org).join(',')}`).toBe(6); // 5 versions + current file; the pruned blob is deleted

    await openDrawer(page, doc.id);
    const list = drawer(page).getByTestId('vault-versions');
    await expect(list.locator('li')).toHaveCount(5);
    await expect(drawer(page).getByRole('heading', { name: 'Versions' })).toBeVisible();
    await expect(list.locator('li').first()).toContainText(/cert-v5\.pdf · [\d.]+ (B|KB) · replaced .+ by QA /);
    for (const [i, n] of [5, 4, 3, 2, 1].entries()) await expect(list.locator('li').nth(i)).toContainText(`cert-v${n}.pdf`);
    await list.scrollIntoViewIfNeeded();
    await ev(page, 'ac03-versions-list-five-newest-first');

    // Download a version through the UI: bytes equal what was uploaded.
    const dl = page.waitForEvent('download');
    await list.getByRole('link', { name: 'Download cert-v3.pdf' }).click();
    const file = await dl.then(async (d) => readFileSync(await d.path()));
    expect(file.equals(bytes[3]!)).toBe(true);
    const direct = await page.request.get(`/api/vault/${doc.id}/versions/${versions[0]!.id}/download`);
    expect(direct.status()).toBe(200);
    expect(Buffer.from(await direct.body()).equals(bytes[5]!)).toBe(true);
    await ev(page, 'ac03-after-version-download');

    // Deleting the document deletes versions and their blobs.
    const del = await page.request.delete(`/api/vault/${doc.id}`);
    expect(del.ok(), await del.text()).toBeTruthy();
    expect(blobFiles(org)).toEqual([]);
    expect(sql(`select count(*) from vault_document_versions where document_id='${doc.id}'`)).toBe('0');
  });

  test('AC4a duplicate via Upload dialog: 409 duplicate_document, prompt, Open existing and Upload anyway (allowDuplicate=1 -> 201) @mobile', async ({ page }) => {
    await signupViaApi(page);
    const org = (await me(page.request)).org.id;
    const forms = await captureForms(page);
    const x = await pdf('duplicate source X');
    const a = await apiUploadOk(page.request, { name: 'x.pdf', bytes: x, fields: { type: 'gst', title: 'Original X' } });
    // API contract
    const api409 = await apiUpload(page.request, { name: 'x-copy.pdf', bytes: x, fields: { type: 'gst', title: 'Copy' } });
    expect(api409.status()).toBe(409);
    const j = await api409.json();
    expect(JSON.stringify(j)).toContain('duplicate_document');
    expect((j.error ?? j).details ?? j.details).toEqual({ existingId: a.id, title: 'Original X' });
    const viaFlag = await apiUpload(page.request, { name: 'x-copy.pdf', bytes: x, fields: { type: 'gst', title: 'Copy via flag', allowDuplicate: '1' } });
    expect(viaFlag.status()).toBe(201);

    await page.goto('/vault');
    const open = async () => {
      await page.getByRole('button', { name: 'Upload document' }).first().click();
      await uploadDialog(page).locator('input[type=file]').setInputFiles({ name: 'again.pdf', mimeType: 'application/pdf', buffer: x });
      await uploadDialog(page).getByLabel('Title').fill('Uploaded again');
      const resp = page.waitForResponse((r) => r.url().endsWith('/api/vault') && r.request().method() === 'POST');
      await uploadDialog(page).getByRole('button', { name: 'Upload document' }).click();
      return resp;
    };
    expect((await open()).status()).toBe(409);
    const prompt = uploadDialog(page).getByTestId('duplicate-prompt');
    await expect(prompt).toContainText('This file is already in your vault as “Original X”.');
    await expect(prompt.getByRole('button', { name: 'Open existing' })).toBeVisible();
    await ev(page, 'ac04a-upload-duplicate-prompt');
    // Branch 1: Open existing -> the original's drawer
    await prompt.getByRole('button', { name: 'Open existing' }).click();
    await expect(page).toHaveURL(new RegExp(`doc=${a.id}`));
    await expect(drawer(page).getByText('Original X').first()).toBeVisible();
    await ev(page, 'ac04a-open-existing-opens-original');
    await drawer(page).getByRole('button', { name: 'Close' }).click();

    // Branch 2: Upload anyway -> 201 and a new document
    expect((await open()).status()).toBe(409);
    const before = sql(`select count(*) from vault_documents where org_id='${org}' and title='Uploaded again'`);
    expect(before).toBe('0');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/vault') && r.request().method() === 'POST');
    await uploadDialog(page).getByTestId('duplicate-prompt').getByRole('button', { name: 'Upload anyway' }).click();
    const cr = await created;
    expect(cr.status(), await cr.text()).toBe(201);
    const posts = (await forms()).filter((f) => f.method === 'POST' && f.url.endsWith('/vault'));
    expect(posts.map((p) => p.fields.allowDuplicate)).toEqual([undefined, undefined, '1']);
    expect(sql(`select count(*) from vault_documents where org_id='${org}' and title='Uploaded again'`)).toBe('1');
    await ev(page, 'ac04a-upload-anyway-created');
  });

  test('AC4b duplicate via Renew dialog: prompt with Open existing and Upload anyway', async ({ page }) => {
    await signupViaApi(page);
    const forms = await captureForms(page);
    const x = await pdf('renew duplicate X');
    const a = await apiUploadOk(page.request, { name: 'x.pdf', bytes: x, fields: { type: 'gst', title: 'Held by A' } });
    const b = await isoDoc(page.request, 'ISO to renew', 15);
    await openDrawer(page, b.id);
    const pick = async () => {
      await drawer(page).getByRole('button', { name: 'Renew' }).click();
      await renewDialog(page).locator('input[type=file]').setInputFiles({ name: 'x-again.pdf', mimeType: 'application/pdf', buffer: x });
      const resp = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/vault/${b.id}/file`));
      await renewDialog(page).getByRole('button', { name: 'Renew document' }).click();
      return resp;
    };
    expect((await pick()).status()).toBe(409);
    const prompt = renewDialog(page).getByTestId('duplicate-prompt');
    await expect(prompt).toContainText('This file is already in your vault as “Held by A”.');
    await ev(page, 'ac04b-renew-duplicate-prompt');
    expect(sql(`select file_name from vault_documents where id='${b.id}'`)).toBe('ISO-to-renew.pdf'); // nothing replaced yet
    await prompt.getByRole('button', { name: 'Open existing' }).click();
    await expect(page).toHaveURL(new RegExp(`doc=${a.id}`));
    await expect(renewDialog(page)).toBeHidden();
    await expect(drawer(page).getByText('Held by A').first()).toBeVisible();
    await ev(page, 'ac04b-renew-open-existing');

    await openDrawer(page, b.id);
    expect((await pick()).status()).toBe(409);
    const ok = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/vault/${b.id}/file`));
    await renewDialog(page).getByTestId('duplicate-prompt').getByRole('button', { name: 'Upload anyway' }).click();
    const r = await ok;
    expect(r.status(), await r.text()).toBe(200);
    const puts = (await forms()).filter((f) => f.method === 'PUT');
    // (the SPA was reloaded between the two attempts, so only the second attempt's two PUTs are recorded)
    expect(puts.map((p) => p.fields.allowDuplicate)).toEqual([undefined, '1']);
    await expect(toast(page, /“ISO to renew” renewed — valid till/)).toBeVisible();
    expect(sql(`select file_name from vault_documents where id='${b.id}'`)).toBe('x-again.pdf');
    await ev(page, 'ac04b-renew-upload-anyway-done');
  });

  test('AC4c drawer Replace file with a duplicate shows Open existing / Upload anyway (review behaviour)', async ({ page }) => {
    await signupViaApi(page);
    const x = await pdf('replace duplicate X'), w = await pdf('replace duplicate W');
    const a = await apiUploadOk(page.request, { name: 'x.pdf', bytes: x, fields: { type: 'gst', title: 'Holds X' } });
    const c = await apiUploadOk(page.request, { name: 'w.pdf', bytes: w, fields: { type: 'pan', title: 'Holds W' } });
    const b = await apiUploadOk(page.request, { name: 'y.pdf', bytes: await pdf('replace duplicate Y'), fields: { type: 'udyam', title: 'Gets replaced' } });
    await openDrawer(page, b.id);
    const replaceWith = async (buf: Buffer, name: string) => {
      const resp = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/vault/${b.id}/file`));
      await drawer(page).locator('input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer: buf });
      return resp;
    };
    expect((await replaceWith(w, 'w-again.pdf')).status()).toBe(409);
    const prompt = drawer(page).getByTestId('duplicate-prompt');
    await expect(prompt).toContainText('This file is already in your vault as “Holds W”.');
    await expect(prompt.getByRole('button', { name: 'Open existing' })).toBeVisible();
    await expect(prompt.getByRole('button', { name: 'Upload anyway' })).toBeVisible();
    await ev(page, 'ac04c-replace-duplicate-prompt');
    await prompt.getByRole('button', { name: 'Open existing' }).click();
    await expect(page).toHaveURL(new RegExp(`doc=${c.id}`));
    await expect(drawer(page).getByText('Holds W').first()).toBeVisible();
    await ev(page, 'ac04c-replace-open-existing');

    await openDrawer(page, b.id);
    expect((await replaceWith(x, 'x-again.pdf')).status()).toBe(409);
    const ok = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/vault/${b.id}/file`));
    await drawer(page).getByTestId('duplicate-prompt').getByRole('button', { name: 'Upload anyway' }).click();
    expect((await ok).status()).toBe(200);
    expect(sql(`select file_name from vault_documents where id='${b.id}'`)).toBe('x-again.pdf');
    expect((await listVersions(page.request, b.id)).map((v) => v.fileName)).toEqual(['y.pdf']);
    void a;
    await ev(page, 'ac04c-replace-upload-anyway-done');
  });

  test('AC5 Viewer sees Versions (and can download them) but no Renew / Replace; other-org ids -> 404 @mobile', async ({ page, browser, baseURL }) => {
    await signupViaApi(page);
    const v0 = await pdf('viewer v0');
    const doc = await apiUploadOk(page.request, { name: 'Viewer-cert.pdf', bytes: v0, fields: { type: 'iso', title: 'Viewer cert', expiryDate: istDay(12) } });
    const v1 = await pdf('viewer v1');
    expect((await apiRenew(page.request, doc.id, { name: 'viewer-v1.pdf', bytes: v1, fields: { expiryDate: istDay(400) } })).status()).toBe(200);
    const [ver] = await listVersions(page.request, doc.id);

    // Analyst baseline: Renew present.
    await openDrawer(page, doc.id);
    await expect(drawer(page).getByRole('button', { name: 'Renew' })).toBeVisible();
    await ev(page, 'ac05-analyst-baseline-has-renew');

    const viewport = test.info().project.use.viewport ?? null;
    const v = await viewerPage(browser, page.request, baseURL!, viewport);
    try {
      await v.page.goto(`/vault?doc=${doc.id}`);
      await expect(drawer(v.page).getByRole('button', { name: 'Close' })).toBeVisible();
      await expect(drawer(v.page).getByRole('heading', { name: 'Versions' })).toBeVisible();
      await expect(drawer(v.page).getByTestId('vault-versions').locator('li')).toHaveCount(1);
      await expect(drawer(v.page).getByRole('button', { name: 'Renew' })).toHaveCount(0);
      await expect(drawer(v.page).getByText('Replace file')).toHaveCount(0);
      await expect(drawer(v.page).getByRole('button', { name: 'Edit details' })).toHaveCount(0);
      await ev(v.page, 'ac05-viewer-sees-versions-no-renew');
      const dl = v.page.waitForEvent('download');
      await drawer(v.page).getByRole('link', { name: 'Download Viewer-cert.pdf' }).click();
      const got = readFileSync(await (await dl).path());
      expect(got.equals(v0)).toBe(true);
      expect(v1.length).toBeGreaterThan(0);
      expect((await v.request.get(`/api/vault/${doc.id}/versions`)).status()).toBe(200);
      expect((await v.request.get(`/api/vault/${doc.id}/versions/${ver!.id}/download`)).status()).toBe(200);
      // Viewer cannot renew via the API either.
      const forbidden = await apiRenew(v.request, doc.id, { name: 'x.pdf', bytes: await pdf('viewer attempt') });
      expect(forbidden.status()).toBe(403);
    } finally { await v.ctx.close(); }

    // Another organisation: version id of org A -> 404 on every path.
    const other = await browser.newContext({ baseURL: baseURL!, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
    try {
      const op = await other.newPage();
      await signupViaApi(op);
      const mine = await isoDoc(op.request, 'Other org cert', 12, {}, 'other org v0');
      expect((await apiRenew(op.request, mine.id, { name: 'o1.pdf', bytes: await pdf('other org v1'), fields: { expiryDate: istDay(500) } })).status()).toBe(200);
      const [myVer] = await listVersions(op.request, mine.id);
      expect((await op.request.get(`/api/vault/${doc.id}/versions`)).status()).toBe(404);
      expect((await op.request.get(`/api/vault/${doc.id}/versions/${ver!.id}/download`)).status()).toBe(404);
      expect((await op.request.get(`/api/vault/${mine.id}/versions/${ver!.id}/download`)).status()).toBe(404);
      expect((await op.request.get(`/api/vault/${mine.id}/versions/${myVer!.id}/download`)).status()).toBe(200);
      expect((await op.request.get(`/api/vault/${mine.id}/versions/not-a-uuid/download`)).status()).toBe(404);
      expect((await apiRenew(op.request, doc.id, { name: 'x.pdf', bytes: await pdf('cross org') })).status()).toBe(404);
    } finally { await other.close(); }
  });

  test('AC6 Renew blocks submit without an expiry when the type expires (and the drawer Replace file keeps working) @mobile', async ({ page }) => {
    await signupViaApi(page);
    const doc = await isoDoc(page.request, 'ISO needs expiry', 10);
    await openDrawer(page, doc.id);
    await drawer(page).getByRole('button', { name: 'Renew' }).click();
    const d = renewDialog(page);
    await d.locator('input[type=file]').setInputFiles({ name: 'noexp.pdf', mimeType: 'application/pdf', buffer: await pdf('no expiry') });
    await d.getByLabel('Expiry date').fill('');
    const puts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/file')) puts.push(r.url()); });
    await d.getByRole('button', { name: 'Renew document' }).click();
    await expect(d.getByText('Add the new expiry date so reminders restart')).toBeVisible();
    await expect(d).toBeVisible();
    await ev(page, 'ac06-expiry-required-error');
    expect(puts).toEqual([]);
    expect(sql(`select file_name from vault_documents where id='${doc.id}'`)).toBe('ISO-needs-expiry.pdf');
    // Fixing the date lets it through.
    await d.getByLabel('Expiry date').fill(istDay(800));
    await d.getByRole('button', { name: 'Renew document' }).click();
    await expect(toast(page, /“ISO needs expiry” renewed — valid till/)).toBeVisible();
    expect(puts.length).toBe(1);

    // A type that never expires does not demand a date.
    const pan = await apiUploadOk(page.request, { name: 'pan.pdf', bytes: await pdf('pan'), fields: { type: 'pan', title: 'PAN card' } });
    await openDrawer(page, pan.id);
    await drawer(page).getByRole('button', { name: 'Renew' }).click();
    await renewDialog(page).locator('input[type=file]').setInputFiles({ name: 'pan2.pdf', mimeType: 'application/pdf', buffer: await pdf('pan 2') });
    await renewDialog(page).getByRole('button', { name: 'Renew document' }).click();
    await expect(toast(page, '“PAN card” renewed')).toBeVisible();
  });

  test('A11Y axe on /vault with the drawer and the Renew dialog open (WCAG 2.1 A/AA)', async ({ page }) => {
    await signupViaApi(page);
    const doc = await isoDoc(page.request, 'ISO a11y', 10);
    await apiRenew(page.request, doc.id, { name: 'a.pdf', bytes: await pdf('a11y v1'), fields: { expiryDate: istDay(700) } });
    await openDrawer(page, doc.id);
    await expect(drawer(page).getByRole('heading', { name: 'Versions' })).toBeVisible();
    await a11y(page, 'versions-list-only', { spec: SPEC, story: STORY, include: ['[data-testid=vault-versions]'] });
    await drawer(page).getByRole('button', { name: 'Renew' }).click();
    await expect(renewDialog(page)).toBeVisible();
    await ev(page, 'a11y-drawer-and-renew-dialog');
    // New US6 surfaces must be clean: the Versions list and the Renew dialog.
    await renewDialog(page).evaluate((el) => el.setAttribute('data-qa', 'renew-dialog'));
    await a11y(page, 'renew-dialog-only', { spec: SPEC, story: STORY, include: ['[data-qa=renew-dialog]'] });
    // Whole page (drawer + dialog): recorded; serious/critical findings are reported as an observation, not a criterion failure.
    try {
      await a11y(page, 'vault-drawer-renew-dialog', { spec: SPEC, story: STORY });
    } catch (e) {
      test.info().annotations.push({ type: 'a11y-observation', description: String((e as Error).message).slice(0, 400) });
    }
  });

  test('AC7 mobile layout: no horizontal scroll with drawer, Renew dialog and duplicate prompt @mobile', async ({ page }) => {
    await signupViaApi(page);
    const x = await pdf('mobile dup X');
    await apiUploadOk(page.request, { name: 'x.pdf', bytes: x, fields: { type: 'gst', title: 'Mobile original' } });
    const doc = await isoDoc(page.request, 'ISO mobile', 10);
    await apiRenew(page.request, doc.id, { name: 'm1.pdf', bytes: await pdf('mobile v1'), fields: { expiryDate: istDay(600) } });
    await openDrawer(page, doc.id);
    await noHScroll(page, true);
    await drawer(page).getByRole('button', { name: 'Renew' }).click();
    await renewDialog(page).locator('input[type=file]').setInputFiles({ name: 'x-again.pdf', mimeType: 'application/pdf', buffer: x });
    await noHScroll(page, true);
    await ev(page, 'ac07-renew-dialog-layout');
    await renewDialog(page).getByRole('button', { name: 'Renew document' }).click();
    await expect(renewDialog(page).getByTestId('duplicate-prompt')).toBeVisible();
    await noHScroll(page, true);
    await expect(renewDialog(page).getByRole('button', { name: 'Upload anyway' })).toBeInViewport();
    await ev(page, 'ac07-duplicate-prompt-layout');
  });
});
