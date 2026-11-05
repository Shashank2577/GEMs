import type { Page } from '@playwright/test';
import { test, expect, signupViaApi, evidence, collectRunArtifacts, a11y } from '../support/fixtures';
import { getProfile, putProfile, istDate, joinOrgAs, uploadPdf, addContract, activityActions } from './support';

const S = '005', U = 'US5';
const ev = (page: Page, name: string) => evidence(page, S, U, name);
test.afterEach(async ({ page }) => { await collectRunArtifacts(S, U, page); });

const experience = (page: Page) => page.locator('section#sec-experience');
const oemSection = (page: Page) => page.locator('section#sec-oem');
const contractDialog = (page: Page) => page.getByRole('dialog', { name: /past contract/ });
const uploadDialog = (page: Page) => page.getByRole('dialog', { name: 'Add a document' });
const cracPicker = (page: Page) => contractDialog(page).getByRole('combobox', { name: /CRAC \/ completion certificate/ });
const BASE = { buyer: 'Central Railway, Mumbai Division', title: 'Supply of 85 desktop computers', value: 5_820_000 };

async function fillContract(page: Page, v: { buyer?: string; title?: string; value?: string; start?: string; end?: string; gem?: string; category?: string } = {}) {
  const d = contractDialog(page);
  await d.getByLabel('Buyer / organisation').fill(v.buyer ?? BASE.buyer);
  await d.getByLabel('Work / supply').fill(v.title ?? BASE.title);
  await d.getByLabel('Contract value').fill(v.value ?? '5820000');
  if (v.start) await d.getByLabel('Start date').fill(v.start);
  if (v.end) await d.getByLabel('Completion date').fill(v.end);
  if (v.category) await d.getByLabel('Category').fill(v.category);
  if (v.gem) await d.getByLabel('GeM contract no.').fill(v.gem);
}

async function openAddContract(page: Page) {
  await page.goto('/profile');
  await experience(page).getByRole('button', { name: 'Add contract' }).first().click();
  await expect(contractDialog(page)).toBeVisible();
}

const pickCrac = async (page: Page, name: string | RegExp) => {
  await cracPicker(page).click();
  await page.getByRole('option', { name }).click();
};

/** Upload through the open upload dialog using a generated PDF. */
async function uploadInDialog(page: Page, title: string, type?: string) {
  const dlg = uploadDialog(page);
  await dlg.locator('input[type=file]').setInputFiles({ name: 'cert.pdf', mimeType: 'application/pdf', buffer: await (await import('./support')).makePdf(title) });
  await dlg.getByLabel('Title').fill(title);
  if (type) {
    await dlg.getByRole('button', { name: /Document type|CRAC|certificate/i }).first().click();
    await page.getByRole('option', { name: new RegExp(type, 'i') }).first().click();
  }
}

test.describe('US5 Experience', () => {
  test('AC1 empty Experience section shows "No past contracts yet" with Add contract @mobile', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/profile');
    const sec = experience(page);
    await expect(sec.getByText('No past contracts yet')).toBeVisible();
    await expect(sec.getByText('Add completed orders with their values — they’re matched against each bid’s experience criteria.')).toBeVisible();
    await expect(sec.getByRole('button', { name: 'Add contract' })).toBeVisible();
    await ev(page, `ac01-empty-experience-${test.info().project.name}`);
  });

  test('AC2 empty submit shows three errors with no request; end before start shows date error', async ({ page }) => {
    await signupViaApi(page);
    await openAddContract(page);
    const writes: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/past-contracts') && r.method() !== 'GET') writes.push(r.method()); });
    const d = contractDialog(page);
    await d.getByRole('button', { name: 'Add contract' }).click();
    await expect(d.getByText('Buyer is required')).toBeVisible();
    await expect(d.getByText('Describe the work or supply')).toBeVisible();
    await expect(d.getByText('Contract value must be more than ₹0')).toBeVisible();
    expect(writes).toEqual([]);
    await ev(page, 'ac02-empty-submit-errors');

    await fillContract(page, { start: '2025-06-30', end: '2025-06-01' });
    await d.getByRole('button', { name: 'Add contract' }).click();
    await expect(d.getByText('End date is before the start date')).toBeVisible();
    expect(writes).toEqual([]);
    await ev(page, 'ac02-end-before-start');
  });

  test('AC3 valid contract -> 201, toast, summary line, completeness rises @mobile', async ({ page }) => {
    await signupViaApi(page);
    const before = (await getProfile(page)).completeness as number;
    await openAddContract(page);
    await fillContract(page, { start: '2025-01-10', end: '2025-06-30', gem: 'GEMC-511687712345', category: 'Desktop computers' });
    await ev(page, `ac03-filled-${test.info().project.name}`);
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/past-contracts') && r.request().method() === 'POST');
    await contractDialog(page).getByRole('button', { name: 'Add contract' }).click();
    const r = await resp;
    expect(r.status()).toBe(201);
    const dto = await r.json();
    expect(dto).toMatchObject({ buyer: BASE.buyer, title: BASE.title, value: 5_820_000, buyerType: 'central', startDate: '2025-01-10', endDate: '2025-06-30', gemContractNo: 'GEMC-511687712345', cracDocumentId: null });
    await expect(page.getByText('Contract added', { exact: true })).toBeVisible();
    await expect(page.getByText('Experience criteria will use it on the next analysis.')).toBeVisible();
    await expect(experience(page).getByText('1 contract · total ₹58.2 L · largest ₹58.2 L')).toBeVisible();
    await expect(contractDialog(page)).toBeHidden();
    await ev(page, `ac03-added-${test.info().project.name}`);
    await expect.poll(async () => (await getProfile(page)).completeness as number).toBeGreaterThan(before);
    const after = (await getProfile(page)).completeness as number;
    test.info().annotations.push({ type: 'completeness', description: `${before}% -> ${after}%` });
  });

  test('AC4 CRAC picker lists only Experience documents; rows show Linked / No CRAC; API returns cracDocumentId', async ({ page }) => {
    await signupViaApi(page);
    const crac = await uploadPdf(page, { type: 'crac', title: 'Railway CRAC 2025' });
    const po = await uploadPdf(page, { type: 'work_order', title: 'Railway purchase order' });
    await uploadPdf(page, { type: 'gst', title: 'GST registration' });
    await uploadPdf(page, { type: 'oem_authorization', title: 'Dell MAF letter' });
    await openAddContract(page);
    await cracPicker(page).click();
    const opts = (await page.getByRole('option').allTextContents()).map((t) => t.trim());
    expect(opts).toEqual(expect.arrayContaining(['Not linked', 'Railway CRAC 2025', 'Railway purchase order', 'Upload a new CRAC…']));
    expect(opts).not.toContain('GST registration');
    expect(opts).not.toContain('Dell MAF letter');
    expect(opts).toHaveLength(4);
    await ev(page, 'ac04-crac-picker-options');
    if (!(await page.getByRole('option', { name: 'Railway CRAC 2025' }).isVisible())) await cracPicker(page).click(); // screenshot may dismiss the listbox
    await page.getByRole('option', { name: 'Railway CRAC 2025' }).click();
    await fillContract(page);
    await contractDialog(page).getByRole('button', { name: 'Add contract' }).click();
    await expect(page.getByText('Contract added', { exact: true })).toBeVisible();

    await experience(page).getByRole('button', { name: 'Add contract' }).first().click();
    await fillContract(page, { buyer: 'State PWD', title: 'Furniture supply', value: '100000' });
    await contractDialog(page).getByRole('button', { name: 'Add contract' }).click();
    await expect(experience(page).getByText('2 contracts', { exact: false })).toBeVisible();
    const table = experience(page).getByRole('table');
    await expect(table.getByRole('row', { name: /desktop computers/ }).getByText('Linked')).toBeVisible();
    await expect(table.getByRole('row', { name: /Furniture supply/ }).getByText('No CRAC')).toBeVisible();
    await ev(page, 'ac04-linked-and-no-crac-rows');

    const list = await (await page.request.get('/api/past-contracts')).json();
    const linked = list.items.find((c: { title: string }) => c.title === BASE.title);
    expect(linked.cracDocumentId).toBe(crac.id);
    expect(po.id).not.toBe(crac.id);
  });

  test('AC4b @mobile table collapses to cards without Period/Proof', async ({ page }, info) => {
    await signupViaApi(page);
    await addContract(page, { ...BASE, startDate: '2025-01-10', endDate: '2025-06-30' });
    await page.goto('/profile');
    const sec = experience(page);
    await expect(sec.getByText('1 contract · total ₹58.2 L · largest ₹58.2 L')).toBeVisible();
    if (info.project.name === 'mobile') {
      await expect(sec.getByRole('table')).toBeHidden();
      const card = sec.getByRole('listitem').first().getByRole('button').first(); // row-open button of the card (#493)
      await expect(card).toBeVisible();
      await expect(sec.getByText('No CRAC')).toBeHidden();
      await expect(sec.getByText('Proof')).toBeHidden();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      expect(overflow).toBe(false);
      await card.click();
      await expect(contractDialog(page)).toBeVisible();
      await expect(contractDialog(page).getByLabel('Buyer / organisation')).toHaveValue(BASE.buyer);
    } else {
      await expect(sec.getByRole('table')).toBeVisible();
      await expect(sec.getByRole('columnheader', { name: 'Proof' })).toBeVisible();
      await expect(sec.getByRole('columnheader', { name: 'Period' })).toBeVisible();
    }
    await ev(page, `ac04b-layout-${info.project.name}`);
  });

  test('AC5 API: foreign / random cracDocumentId 400; PATCH end < stored start 400; cross-org PATCH/DELETE 404', async ({ page, browser }) => {
    await signupViaApi(page);
    const mine = await addContract(page, { ...BASE, startDate: '2025-03-01', endDate: '2025-06-30' });

    const other = await browser.newContext({ baseURL: test.info().project.use.baseURL, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
    const op = await other.newPage();
    await signupViaApi(op);
    const foreignDoc = await uploadPdf(op, { type: 'crac', title: 'Other org CRAC' });
    const foreignContract = await addContract(op, { ...BASE, title: 'Other org contract' });

    const bad1 = await page.request.post('/api/past-contracts', { data: { ...BASE, buyerType: 'central', cracDocumentId: foreignDoc.id } });
    expect(bad1.status()).toBe(400);
    const b1 = await bad1.json();
    expect(b1.error.code ?? b1.code).toBe('validation_error');
    expect(JSON.stringify(b1)).toContain('That document is not in your vault');
    expect(b1.error?.details?.fields?.cracDocumentId ?? b1.details?.fields?.cracDocumentId).toBe('That document is not in your vault');

    const bad2 = await page.request.post('/api/past-contracts', { data: { ...BASE, buyerType: 'central', cracDocumentId: '0b7d2f0e-5b1c-4d3a-9d55-7a1d6f6c1a11' } });
    expect(bad2.status()).toBe(400);
    expect(JSON.stringify(await bad2.json())).toContain('That document is not in your vault');

    const patchEnd = await page.request.patch(`/api/past-contracts/${mine.id}`, { data: { endDate: '2025-02-01' } });
    expect(patchEnd.status()).toBe(400);
    expect(JSON.stringify(await patchEnd.json())).toContain('End date is before the start date');

    const xPatch = await page.request.patch(`/api/past-contracts/${foreignContract.id}`, { data: { title: 'hijack' } });
    expect(xPatch.status()).toBe(404);
    expect(JSON.stringify(await xPatch.json())).toContain('Past contract not found');
    const xDel = await page.request.delete(`/api/past-contracts/${foreignContract.id}`);
    expect(xDel.status()).toBe(404);
    expect(JSON.stringify(await xDel.json())).toContain('Past contract not found');
    // victim untouched
    const still = await (await op.request.get('/api/past-contracts')).json();
    expect(still.items.map((c: { title: string }) => c.title)).toEqual(['Other org contract']);
    await other.close();

    // UI renders the server error when a stale foreign id is submitted? Evidence of API outcome in the page itself:
    await page.goto('/profile');
    await expect(experience(page).getByText('1 contract')).toBeVisible();
    await ev(page, 'ac05-api-checks-org-unchanged');
  });

  test('AC6 edit via row, delete via confirm dialog; activity add/update/delete logged', async ({ page }) => {
    await signupViaApi(page);
    await openAddContract(page);
    await fillContract(page);
    await contractDialog(page).getByRole('button', { name: 'Add contract' }).click();
    await expect(experience(page).getByText('1 contract · total ₹58.2 L · largest ₹58.2 L')).toBeVisible();

    // edit: click the row
    await experience(page).getByRole('row', { name: new RegExp(BASE.title) }).click();
    await expect(contractDialog(page).getByRole('heading', { name: 'Edit past contract' })).toBeVisible();
    await contractDialog(page).getByLabel('Contract value').fill('7500000');
    await contractDialog(page).getByRole('button', { name: 'Save contract' }).click();
    await expect(page.getByText('Contract updated', { exact: true })).toBeVisible();
    await expect(experience(page).getByText('1 contract · total ₹75 L · largest ₹75 L')).toBeVisible();
    await ev(page, 'ac06-edited');

    // delete via the row's actions menu
    await experience(page).getByRole('button', { name: `Actions for ${BASE.title}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    // Any stray Edit dialog (see AC6b) is dismissed so this test can verify the delete flow itself.
    const strayEdit = page.getByRole('dialog', { name: 'Edit past contract' });
    if (await strayEdit.isVisible().catch(() => false)) await page.keyboard.press('Escape');
    const confirm = page.getByRole('dialog', { name: 'Delete this contract?' });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(`“${BASE.title}” for ${BASE.buyer} will no longer count towards experience criteria.`)).toBeVisible();
    await ev(page, 'ac06-delete-confirm');
    const del = page.waitForResponse((r) => r.url().includes('/api/past-contracts/') && r.request().method() === 'DELETE');
    await confirm.getByRole('button', { name: 'Delete contract' }).click();
    expect((await del).status()).toBe(200);
    await expect(page.getByText('Contract deleted', { exact: true })).toBeVisible();
    await expect(experience(page).getByText('No past contracts yet')).toBeVisible();
    await ev(page, 'ac06-deleted');

    const actions = await activityActions(page);
    for (const a of ['profile.past_contract_added', 'profile.past_contract_updated', 'profile.past_contract_deleted']) expect(actions, a).toContain(a);
  });

  test('AC6b choosing Delete in the actions menu opens only the confirmation (no Edit dialog behind it)', async ({ page }) => {
    await signupViaApi(page);
    await addContract(page, BASE);
    await page.goto('/profile');
    await experience(page).getByRole('button', { name: `Actions for ${BASE.title}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete this contract?' }).or(page.locator('[role=dialog][data-state=open]', { hasText: 'Delete this contract?' }))).toBeVisible();
    await ev(page, 'ac06b-delete-menu-dialogs');
    const open = await page.locator('[role=dialog][data-state=open]').evaluateAll((els) => els.map((e) => (e.querySelector('h2')?.textContent ?? '').trim()));
    expect(open).toEqual(['Delete this contract?']);
  });

  test('AC7 list ordered by end date desc then created desc', async ({ page }) => {
    await signupViaApi(page);
    await addContract(page, { buyer: 'B1', title: 'C-old', value: 100_000, endDate: '2023-01-15' });
    await addContract(page, { buyer: 'B2', title: 'C-new-first', value: 200_000, endDate: '2025-08-01' });
    await addContract(page, { buyer: 'B3', title: 'C-new-second', value: 300_000, endDate: '2025-08-01' });
    await addContract(page, { buyer: 'B4', title: 'C-mid', value: 400_000, endDate: '2024-05-05' });
    const api = await (await page.request.get('/api/past-contracts')).json();
    expect(api.total).toBe(4);
    expect(api.items.map((c: { title: string }) => c.title)).toEqual(['C-new-second', 'C-new-first', 'C-mid', 'C-old']);
    await page.goto('/profile');
    await expect(experience(page).getByRole('table').getByText('C-old')).toBeVisible();
    const titles = await experience(page).getByRole('table').getByRole('row').locator('td:first-child .truncate.font-medium').allTextContents();
    expect(titles).toEqual(['C-new-second', 'C-new-first', 'C-mid', 'C-old']);
    await ev(page, 'ac07-order');
  });

  test('Roles: viewer sees no Add/Edit/Delete and API writes are 403', async ({ page, browser }) => {
    await signupViaApi(page);
    const c = await addContract(page, BASE);
    const { ctx } = await joinOrgAs(browser, page, 'viewer', test.info().project.use.baseURL as string);
    const vp = await ctx.newPage();
    await vp.goto('/profile');
    await expect(experience(vp).getByText('1 contract · total ₹58.2 L · largest ₹58.2 L')).toBeVisible();
    await expect(experience(vp).getByRole('button', { name: 'Add contract' })).toHaveCount(0);
    await expect(experience(vp).getByRole('button', { name: /Actions for/ })).toHaveCount(0);
    expect((await vp.request.post('/api/past-contracts', { data: { ...BASE, buyerType: 'central' } })).status()).toBe(403);
    expect((await vp.request.delete(`/api/past-contracts/${c.id}`)).status()).toBe(403);
    await evidence(vp, S, U, 'roles-viewer-readonly');
    await vp.close();
    await ctx.close();
  });
});

test.describe('US5 review-driven behaviours', () => {
  test('AC10 "Upload a new CRAC…" opens upload dialog above contract dialog, selects new CRAC, keeps draft', async ({ page }) => {
    await signupViaApi(page);
    await openAddContract(page);
    await fillContract(page, { start: '2025-01-10', end: '2025-06-30', category: 'Desktop computers' });
    await cracPicker(page).click();
    await page.getByRole('option', { name: 'Upload a new CRAC…' }).click();
    const up = uploadDialog(page);
    await expect(up).toBeVisible();
    await expect(up.getByRole('button', { name: 'Document type' })).toContainText('CRAC / completion certificate'); // preset type
    // stacked above: the topmost element at the upload dialog's centre belongs to the upload dialog
    const box = (await up.boundingBox())!;
    const topIsUpload = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y); return !!el?.closest('[role=dialog]')?.textContent?.includes('Add a document');
    }, [box.x + box.width / 2, box.y + 40]);
    expect(topIsUpload).toBe(true);
    await ev(page, 'ac10-upload-dialog-over-contract-dialog');
    await uploadInDialog(page, 'Fresh CRAC from Western Railway');
    await up.getByRole('button', { name: 'Upload document' }).click();
    await expect(up).toBeHidden();
    const d = contractDialog(page);
    await expect(d).toBeVisible();
    await expect(cracPicker(page)).toContainText('Fresh CRAC from Western Railway');
    await expect(d.getByLabel('Buyer / organisation')).toHaveValue(BASE.buyer);
    await expect(d.getByLabel('Work / supply')).toHaveValue(BASE.title);
    await expect(d.getByLabel('Start date')).toHaveValue('2025-01-10');
    await expect(d.getByLabel('Category')).toHaveValue('Desktop computers');
    await ev(page, 'ac10-new-crac-selected-draft-kept');
    await d.getByRole('button', { name: 'Add contract' }).click();
    await expect(page.getByText('Contract added', { exact: true })).toBeVisible();
    const items = (await (await page.request.get('/api/past-contracts')).json()).items;
    const docs = (await (await page.request.get('/api/vault')).json()).items as { id: string; title: string; type: string }[];
    const newDoc = docs.find((x) => x.title === 'Fresh CRAC from Western Railway')!;
    expect(newDoc.type).toBe('crac');
    expect(items[0].cracDocumentId).toBe(newDoc.id);
  });

  test('AC10b keyboard-only: Esc closes only the upload dialog; contract draft intact', async ({ page }) => {
    await signupViaApi(page);
    await uploadPdf(page, { type: 'crac', title: 'Existing CRAC' });
    await openAddContract(page);
    await fillContract(page, { category: 'Laptops' });
    await cracPicker(page).focus();
    await page.keyboard.press('Enter');                                   // open listbox
    await page.getByRole('option', { name: 'Upload a new CRAC…' }).focus();
    await page.keyboard.press('Enter');                                   // choose it
    await expect(uploadDialog(page)).toBeVisible();
    // Wait until the picker's listbox layer is fully gone and the dialog's open animation has finished: while either
    // is still in flight, the topmost dismissable layer can swallow the Escape (observed flake, ~1 in 13 runs).
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await uploadDialog(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    // keyboard focus must move into the upload dialog (focus trap) before Esc is meaningful
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')?.textContent?.includes('Add a document'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(uploadDialog(page)).toBeHidden();
    const d = contractDialog(page);
    await expect(d).toBeVisible();
    await expect(d.getByLabel('Buyer / organisation')).toHaveValue(BASE.buyer);
    await expect(d.getByLabel('Work / supply')).toHaveValue(BASE.title);
    await expect(d.getByLabel('Category')).toHaveValue('Laptops');
    await expect(cracPicker(page)).toContainText('Not linked');
    await ev(page, 'ac10b-esc-closed-only-upload-dialog');
    // focus is back inside the contract dialog, so a second Esc closes it
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
  });

  test('AC10c uploading a non-Experience type shows the warning toast and does not link it', async ({ page }) => {
    await signupViaApi(page);
    await openAddContract(page);
    await fillContract(page);
    await cracPicker(page).click();
    await page.getByRole('option', { name: 'Upload a new CRAC…' }).click();
    await uploadInDialog(page, 'Company GST certificate', 'GST');
    await uploadDialog(page).getByRole('button', { name: 'Upload document' }).click();
    await expect(page.getByText('Uploaded to the vault, but only Experience documents can be linked as proof')).toBeVisible();
    await expect(uploadDialog(page)).toBeHidden();
    await expect(contractDialog(page)).toBeVisible();
    await expect(cracPicker(page)).toContainText('Not linked');
    await expect(contractDialog(page).getByLabel('Buyer / organisation')).toHaveValue(BASE.buyer);
    await ev(page, 'ac10c-non-experience-warning');
    const docs = (await (await page.request.get('/api/vault')).json()).items as { title: string; type: string }[];
    expect(docs.find((d) => d.title === 'Company GST certificate')?.type).toBe('gst');
  });
});

test.describe('US5 OEM authorisations', () => {
  test('AC8 OEM empty prompt, row fields, required error, picker lists only oem_authorization, saved with profile @mobile', async ({ page }) => {
    await signupViaApi(page);
    const maf = await uploadPdf(page, { type: 'oem_authorization', title: 'Dell MAF 2026', expiryDate: istDate(200) });
    await uploadPdf(page, { type: 'crac', title: 'A CRAC' });
    await uploadPdf(page, { type: 'gst', title: 'A GST' });
    await page.goto('/profile');
    const sec = oemSection(page);
    await expect(sec.getByText('Reselling branded products? Add each manufacturer authorisation — bids for OEM items usually require a valid MAF.')).toBeVisible();
    await ev(page, `ac08-oem-empty-${test.info().project.name}`);
    await sec.getByRole('button', { name: 'Add OEM authorisation' }).click();
    await expect(sec.getByLabel('Products covered')).toBeVisible();

    // required OEM -> "OEM name is required" on save
    await sec.getByLabel('Products covered').fill('Latitude laptops');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(sec.getByText('OEM name is required')).toBeVisible();
    await ev(page, `ac08-oem-required-${test.info().project.name}`);

    await sec.getByPlaceholder('e.g. Dell India').fill('Dell');
    await sec.getByLabel('Valid till').fill(istDate(20));
    await expect(sec.getByText(/expires in|Expiring|day/i).first()).toBeVisible(); // expiry badge
    await sec.getByRole('combobox', { name: /Vault document/ }).click();
    const opts = (await page.getByRole('option').allTextContents()).map((t) => t.trim());
    expect(opts).toEqual(['Not linked', 'Dell MAF 2026']);
    await page.getByRole('option', { name: 'Dell MAF 2026' }).click();
    await ev(page, `ac08-oem-filled-${test.info().project.name}`);
    const save = page.waitForResponse((r) => r.url().endsWith('/api/profile') && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save profile' }).click();
    expect((await save).status()).toBe(200);
    await expect(page.getByText('Profile saved')).toBeVisible();
    const p = (await getProfile(page)).profile;
    expect(p.oemAuthorizations).toEqual([expect.objectContaining({ oem: 'Dell', products: 'Latitude laptops', validTill: istDate(20), documentId: maf.id })]);
    await page.reload();
    await expect(oemSection(page).getByPlaceholder('e.g. Dell India')).toHaveValue('Dell');
    await expect(oemSection(page).getByLabel('Valid till')).toHaveValue(istDate(20));
    await ev(page, `ac08-oem-persisted-${test.info().project.name}`);
  });

  test('AC9 PUT /profile with foreign / wrong-type / random OEM documentId -> 400 "Pick an OEM authorisation from your vault"', async ({ page, browser }) => {
    await signupViaApi(page);
    const crac = await uploadPdf(page, { type: 'crac', title: 'Not a MAF' });
    const okMaf = await uploadPdf(page, { type: 'oem_authorization', title: 'Real MAF' });
    const other = await browser.newContext({ baseURL: test.info().project.use.baseURL, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
    const op = await other.newPage();
    await signupViaApi(op);
    const foreignMaf = await uploadPdf(op, { type: 'oem_authorization', title: 'Foreign MAF' });
    await other.close();

    const MSG = 'Pick an OEM authorisation from your vault';
    for (const [label, id] of [['wrong type', crac.id], ['foreign org', foreignMaf.id], ['random uuid', '3f1c2b7a-9d4e-4f6a-8b21-0c5d7e9a1f33']] as const) {
      const r = await putProfile(page, { oemAuthorizations: [{ oem: 'Dell', products: '', validTill: null, documentId: id }] });
      expect(r.status(), label).toBe(400);
      const body = await r.json();
      expect(JSON.stringify(body), label).toContain('validation_error');
      expect((body.error?.details ?? body.details).fields['oemAuthorizations.0.documentId'], label).toBe(MSG);
    }
    // second row bad -> index 1
    const r2 = await putProfile(page, { oemAuthorizations: [{ oem: 'Dell', documentId: okMaf.id }, { oem: 'HP', documentId: crac.id }] });
    expect(r2.status()).toBe(400);
    expect(JSON.stringify(await r2.json())).toContain('"oemAuthorizations.1.documentId":"Pick an OEM authorisation from your vault"');
    // nothing was persisted by the failed saves
    expect((await getProfile(page)).profile.oemAuthorizations ?? []).toEqual([]);
    // valid link accepted
    const ok = await putProfile(page, { oemAuthorizations: [{ oem: 'Dell', products: '', validTill: null, documentId: okMaf.id }] });
    expect(ok.status(), await ok.text()).toBe(200);
    await page.goto('/profile');
    await ev(page, 'ac09-oem-api-validated');
  });

  test('AC11 "Use document expiry" fills Valid till and hint shows "Document expires <date>"', async ({ page }) => {
    await signupViaApi(page);
    const expiry = istDate(120);
    await uploadPdf(page, { type: 'oem_authorization', title: 'HP MAF', expiryDate: expiry });
    await page.goto('/profile');
    const sec = oemSection(page);
    await sec.getByRole('button', { name: 'Add OEM authorisation' }).click();
    await sec.getByPlaceholder('e.g. Dell India').fill('HP');
    await expect(sec.getByRole('button', { name: /Use document expiry/ })).toHaveCount(0); // nothing linked yet
    await sec.getByRole('combobox', { name: /Vault document/ }).click();
    await page.getByRole('option', { name: 'HP MAF' }).click();
    const pretty = new Date(`${expiry}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    await expect(sec.getByText(/Document expires/)).toBeVisible();
    await expect(sec.getByText(/Document expires/)).toContainText(pretty.replace(/^0/, ''));
    await ev(page, 'ac11-doc-expiry-hint');
    await sec.getByRole('button', { name: 'Use document expiry' }).click();
    await expect(sec.getByLabel('Valid till')).toHaveValue(expiry);
    await expect(sec.getByText(/Document expires/)).toHaveCount(0);
    await expect(sec.getByRole('button', { name: /Use document expiry/ })).toHaveCount(0); // now agrees
    await ev(page, 'ac11-valid-till-filled');
    // differing value offers the button again
    await sec.getByLabel('Valid till').fill(istDate(30));
    await expect(sec.getByRole('button', { name: /Use document expiry \(/ })).toBeVisible();
    await ev(page, 'ac11-differs-offers-button');
    await sec.getByRole('button', { name: /Use document expiry \(/ }).click();
    await expect(sec.getByLabel('Valid till')).toHaveValue(expiry);
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText('Profile saved')).toBeVisible();
    expect((await getProfile(page)).profile.oemAuthorizations[0].validTill).toBe(expiry);
  });
});

test.describe('US5 accessibility (axe)', () => {
  const setup = async (page: Page) => {
    await signupViaApi(page);
    await uploadPdf(page, { type: 'oem_authorization', title: 'Dell MAF', expiryDate: istDate(90) });
    await addContract(page, { ...BASE, startDate: '2025-01-10', endDate: '2025-06-30' });
    await page.goto('/profile');
    await experience(page).getByText('1 contract').waitFor();
    await oemSection(page).getByRole('button', { name: 'Add OEM authorisation' }).click();
  };

  test('Experience + OEM sections and the contract dialog: no serious/critical axe violations @mobile', async ({ page }) => {
    await setup(page);
    await a11y(page, 'profile-experience-oem', { include: ['section#sec-experience', 'section#sec-oem'] });
    await experience(page).getByRole('button', { name: 'Add contract' }).first().click();
    await expect(contractDialog(page)).toBeVisible();
    await a11y(page, 'contract-dialog', { include: ['[role=dialog]'] });
  });
});
