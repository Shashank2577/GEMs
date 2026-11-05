import { test, expect, signupViaApi, seedDemo, evidence, collectRunArtifacts } from '../support/fixtures';
import { IDS, FY3, istDate, getProfile, putProfile, uploadDoc, makeFullOrg, makeMidOrg, ring } from './support';

const S = '005', U = 'US2';
const ev = (page: Parameters<typeof evidence>[0], name: string) => evidence(page, S, U, name);

test.afterEach(async ({ page }) => { await collectRunArtifacts(S, U, page); });

const issuesPanel = (page: import('@playwright/test').Page) => page.locator('aside').getByRole('list');

test('AC1 fresh org GET /api/profile: 0%, null average, 17 ordered issues, first four errors', async ({ page }) => {
  await signupViaApi(page);
  const r = await page.request.get('/api/profile');
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.completeness).toBe(0);
  expect(body.averageTurnover).toBeNull();
  expect(body.issues).toHaveLength(17);
  const rank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const ranks = body.issues.map((i: { severity: string }) => rank[i.severity]);
  expect(ranks).toEqual([...ranks].sort((a: number, b: number) => a - b));
  expect(body.issues.slice(0, 4).map((i: { severity: string; message: string }) => [i.severity, i.message])).toEqual([
    ['error', 'Add your legal company name exactly as registered on GeM.'],
    ['error', 'Add your GSTIN — almost every GeM bid asks for it.'],
    ['error', 'Add the PAN of the bidding entity.'],
    ['error', 'Add turnover for the last 3 financial years (2023-24, 2024-25, 2025-26) — used for turnover criteria.'],
  ]);
  expect(ranks.filter((x: number) => x === 0)).toHaveLength(4);
  await page.goto('/profile');
  await expect(page.locator('aside').getByText('Let’s complete your profile')).toBeVisible();
  await ev(page, 'ac1-fresh-org-profile');
});

test('AC2 name+GSTIN+PAN saved in UI -> 27%; non-expired gst vault doc -> 32%', async ({ page }) => {
  await signupViaApi(page);
  await page.goto('/profile');
  await page.locator('#f-legalName').fill(IDS.legalName);
  await page.locator('#f-gstin').fill(IDS.gstin);
  await page.locator('#f-pan').fill(IDS.pan);
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved')).toBeVisible();
  expect((await getProfile(page)).completeness).toBe(27);
  await page.reload();
  await expect(ring(page, 27)).toBeVisible();
  await ev(page, 'ac2-27-percent');

  // expired gst doc does not count
  await uploadDoc(page, { type: 'gst', title: 'Expired GST', expiryDate: istDate(-1) });
  expect((await getProfile(page)).completeness).toBe(27);
  await uploadDoc(page, { type: 'gst', title: 'GST registration certificate' });
  expect((await getProfile(page)).completeness).toBe(32);
  await page.goto('/profile');
  await expect(ring(page, 32)).toBeVisible();
  await ev(page, 'ac2-32-percent');
});

test('AC3 card headings, ring colours, 6-issue cap with +N more, all-done message', async ({ page }) => {
  // < 55 : fresh org -> 0%, red, 6 shown + "+11 more"
  await signupViaApi(page);
  await page.goto('/profile');
  await expect(page.locator('aside').getByRole('heading', { name: 'Let’s complete your profile' })).toBeVisible();
  await expect(ring(page, 0).locator('circle').nth(1)).toHaveClass(/text-danger/);
  await expect(issuesPanel(page).getByRole('button')).toHaveCount(6);
  await expect(page.locator('aside').getByText('+11 more suggestions')).toBeVisible();
  await ev(page, 'ac3-band-lt55-red-max6-more');

  // 55-84 : amber
  await signupViaApi(page);
  await makeMidOrg(page);
  const mid = await getProfile(page);
  expect(mid.completeness).toBeGreaterThanOrEqual(55);
  expect(mid.completeness).toBeLessThanOrEqual(84);
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Good progress' })).toBeVisible();
  await expect(ring(page, mid.completeness).locator('circle').nth(1)).toHaveClass(/text-warning/);
  await ev(page, 'ac3-band-55-84-amber');

  // 85-99 : demo org 96 green
  await signupViaApi(page);
  await seedDemo(page.request);
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Almost there' })).toBeVisible();
  await expect(ring(page, 96).locator('circle').nth(1)).toHaveClass(/text-success/);
  await ev(page, 'ac3-band-85-99-green');

  // 100 : full org
  await signupViaApi(page);
  await makeFullOrg(page);
  const full = await getProfile(page);
  expect(full.completeness).toBe(100);
  expect(full.issues).toEqual([]);
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Bid-ready profile' })).toBeVisible();
  await expect(ring(page, 100).locator('circle').nth(1)).toHaveClass(/text-success/);
  await expect(page.locator('aside').getByText('Everything bids usually ask for is in place.')).toBeVisible();
  await ev(page, 'ac3-band-100-all-done');
});

test('AC4a GSTIN suggestion scrolls to identity and focuses GSTIN (smooth by default, instant with reduced motion)', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__scrolls = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (arg?: any) { (window as any).__scrolls.push({ id: (this as Element).id, arg }); return orig.call(this, arg); };
  });
  await signupViaApi(page);
  await page.goto('/profile');
  const gstinIssue = page.getByRole('button', { name: 'Add your GSTIN — almost every GeM bid asks for it.' });
  await gstinIssue.click();
  await expect(page.locator('#f-gstin')).toBeFocused();
  let scrolls = await page.evaluate(() => (window as any).__scrolls);
  expect(scrolls.at(-1)).toMatchObject({ id: 'sec-identity', arg: { behavior: 'smooth' } });
  await ev(page, 'ac4-gstin-focused-smooth');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#f-legalName').focus();
  await page.evaluate(() => { (window as any).__scrolls = []; window.scrollTo(0, document.body.scrollHeight); });
  await gstinIssue.click();
  await expect(page.locator('#f-gstin')).toBeFocused();
  scrolls = await page.evaluate(() => (window as any).__scrolls);
  expect(scrolls.at(-1)).toMatchObject({ id: 'sec-identity', arg: { behavior: 'auto' } });
  await ev(page, 'ac4-gstin-focused-reduced-motion');
});

test('AC4b vault suggestions open upload dialog preset to GST registration and /vault?status=expired', async ({ page }) => {
  await signupViaApi(page);
  await makeMidOrg(page);
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Upload your GST registration certificate to the vault.' }).click();
  await expect(page).toHaveURL(/\/vault/);
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText('Add a document')).toBeVisible();
  await expect(dlg.getByLabel('Document type')).toContainText('GST registration');
  await ev(page, 'ac4-vault-upload-dialog-gst-preset');

  await signupViaApi(page);
  await seedDemo(page.request);
  await page.goto('/profile');
  await page.getByRole('button', { name: /in the vault has expired — upload the renewed copy\.$/ }).click();
  await expect(page).toHaveURL(/\/vault\?status=expired/);
  await ev(page, 'ac4-vault-status-expired');
});

test('AC5 meter recomputes live before saving; nav shows per-section counts and red dot on error sections', async ({ page }) => {
  await signupViaApi(page);
  let puts = 0;
  await page.route('**/api/profile', (route) => { if (route.request().method() === 'PUT') puts++; return route.continue(); });
  await page.goto('/profile');
  const nav = page.getByRole('navigation', { name: 'Profile sections' }).first();
  // fresh: identity = 3 errors + address warning = 4 ; financials = error 1 (info excluded)
  await expect(nav.getByRole('button', { name: /Company identity/ })).toContainText('4');
  await expect(nav.getByRole('button', { name: /Financials/ })).toContainText('1');
  await expect(ring(page, 0)).toBeVisible();
  await page.locator('#f-legalName').fill(IDS.legalName);
  await expect(ring(page, 8)).toBeVisible(); // 8 / 98, no save yet
  expect(puts).toBe(0);
  await expect(nav.getByRole('button', { name: /Company identity/ })).toContainText('3');
  await expect(page.getByRole('button', { name: 'Save profile' })).toBeEnabled();
  await page.locator('#f-gstin').fill('27AAPFU0939F1ZX'); // bad checksum
  await page.locator('#f-pan').focus(); // blur gstin
  await expect(nav.getByLabel('has errors')).toBeVisible();
  await expect(nav.getByRole('button', { name: /Company identity/ }).getByLabel('has errors')).toBeVisible();
  expect(puts).toBe(0);
  await ev(page, 'ac5-live-meter-and-red-dot');
});

test('AC6 financials empty state, Add FY buttons in order, used FYs not offered again', async ({ page }) => {
  await signupViaApi(page);
  await page.goto('/profile');
  await expect(page.getByText('Add at least one year')).toBeVisible();
  const add = (fy: string) => page.getByRole('button', { name: `Add FY ${fy}` });
  await expect(add('2025-26')).toBeVisible();
  await ev(page, 'ac6-empty-state');
  await add('2025-26').click();
  await expect(page.getByLabel('Turnover FY 2025-26')).toBeVisible();
  await expect(add('2024-25')).toBeVisible();
  await add('2024-25').click();
  await expect(add('2023-24')).toBeVisible();
  await add('2023-24').click();
  await expect(page.getByLabel('Turnover FY 2023-24')).toBeVisible();
  // First row (newest) FY picker: must not offer 2024-25 or 2023-24 (used), must offer own + unused older years.
  await page.getByRole('combobox', { name: 'Financial year' }).first().click();
  const opts = page.getByRole('option');
  await expect(opts.filter({ hasText: 'FY 2025-26' })).toHaveCount(1);
  await expect(opts.filter({ hasText: 'FY 2024-25' })).toHaveCount(0);
  await expect(opts.filter({ hasText: 'FY 2023-24' })).toHaveCount(0);
  await expect(opts.filter({ hasText: 'FY 2022-23' })).toHaveCount(1);
  await ev(page, 'ac6-fy-picker-excludes-used');
});

test('AC7 turnovers 6Cr/4.5Cr/3Cr -> Last 3 FYs card, dashed average line, API averageTurnover', async ({ page }) => {
  await signupViaApi(page);
  await page.goto('/profile');
  for (const fy of ['2025-26', '2024-25', '2023-24']) await page.getByRole('button', { name: `Add FY ${fy}` }).click();
  await page.getByLabel('Turnover FY 2025-26').fill('60000000');
  await page.getByLabel('Turnover FY 2024-25').fill('45000000');
  await page.getByLabel('Turnover FY 2023-24').fill('30000000');
  await expect(page.getByText('Last 3 FYs (2023-24, 2024-25, 2025-26) · ₹4,50,00,000')).toBeVisible();
  await expect(page.getByRole('figure', { name: 'Turnover by financial year' }).locator('.border-dashed')).toBeVisible();
  await ev(page, 'ac7-average-card-and-chart');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved')).toBeVisible();
  expect((await getProfile(page)).averageTurnover).toEqual({ avg: 45000000, years: ['2025-26', '2024-25', '2023-24'] });
});

test('AC8 financials API validation messages; negative net worth allowed', async ({ page }) => {
  await signupViaApi(page);
  const fieldsOf = async (financials: unknown[]) => {
    const r = await putProfile(page, { financials });
    return { status: r.status(), body: await r.json() };
  };
  let r = await fieldsOf([{ fy: '2024-25', turnover: 1 }, { fy: 'FY 2024-2025', turnover: 2 }]);
  expect(r.status).toBe(400);
  expect(r.body.error.details.fields['financials.1.fy']).toBe('2024-25 is listed twice');
  r = await fieldsOf([{ fy: '2024-26', turnover: 1 }]);
  expect(r.status).toBe(400);
  expect(r.body.error.details.fields['financials.0.fy']).toBe('Use a financial year like 2024-25');
  r = await fieldsOf([{ fy: '2024-25', turnover: -1 }]);
  expect(r.status).toBe(400);
  expect(r.body.error.details.fields['financials.0.turnover']).toBe('Turnover cannot be negative');
  r = await fieldsOf([{ fy: '2024-25', turnover: 1.5 }]);
  expect(r.status).toBe(400);
  expect(r.body.error.details.fields['financials.0.turnover']).toBe('Whole rupees only');
  r = await fieldsOf([{ fy: '2024-25', turnover: 100, netWorth: -5_000_000 }]);
  expect(r.status).toBe(200);
  expect((await getProfile(page)).profile.financials[0].netWorth).toBe(-5_000_000);
  // UI surfaces the duplicate message too: not reachable via picker, so API-level only.
  await page.goto('/profile');
  await ev(page, 'ac8-negative-net-worth-saved');
});

test('AC9 only FY 2025-26 -> warning naming missing years; section contributes 4 of 12', async ({ page }) => {
  await signupViaApi(page);
  await putProfile(page, { ...IDS, financials: [{ fy: '2025-26', turnover: 60_000_000 }] });
  const p = await getProfile(page);
  const fin = p.issues.find((i: { field: string; severity: string }) => i.field === 'financials' && i.severity !== 'info');
  expect(fin).toMatchObject({ severity: 'warning', message: 'Add turnover for 2024-25, 2023-24 so the 3-year average is accurate.' });
  expect(p.completeness).toBe(31); // (26 identity + 4 of 12 financials) / 98
  await page.goto('/profile');
  await expect(page.getByRole('button', { name: 'Add turnover for 2024-25, 2023-24 so the 3-year average is accurate.' })).toBeVisible();
  await ev(page, 'ac9-partial-financials-warning');
});

test('AC10 demo org: 96%, Almost there, three specific warnings then the D-Link info', async ({ page }) => {
  await signupViaApi(page);
  await seedDemo(page.request);
  await page.goto('/profile');
  await expect(ring(page, 96)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Almost there' })).toBeVisible();
  const items = issuesPanel(page).getByRole('button');
  await expect(items).toHaveText([
    'Add turnover for 2025-26 so the 3-year average is accurate.',
    'OEM authorisation from Dell Technologies has expired — request a fresh one.',
    '"OEM authorisation – Dell Technologies (desktops & servers)" in the vault has expired — upload the renewed copy.',
    'Link the D-Link India authorisation letter from the vault so packets can attach it.',
  ]);
  await ev(page, 'ac10-demo-org-96');
  const api = await getProfile(page);
  expect(api.completeness).toBe(96);
  expect(api.issues.map((i: { severity: string }) => i.severity)).toEqual(['warning', 'warning', 'warning', 'info']);
  // CP PLUS and Dell rows are linked, D-Link is not
  const byOem = Object.fromEntries(api.profile.oemAuthorizations.map((o: { oem: string; documentId: string | null }) => [o.oem, o.documentId]));
  expect(byOem['CP PLUS']).toBeTruthy();
  expect(byOem['Dell Technologies']).toBeTruthy();
  expect(byOem['D-Link India'] ?? null).toBeNull();
});

test('AC11 OEM expiring in 20 days and OEM without linked doc give info suggestions with no score change', async ({ page }) => {
  await signupViaApi(page);
  await makeFullOrg(page);
  expect((await getProfile(page)).completeness).toBe(100);
  const doc = await uploadDoc(page, { type: 'oem_authorization', title: 'Acme MAF', expiryDate: istDate(40) });
  const r = await putProfile(page, { oemAuthorizations: [
    { oem: 'Acme Corp', products: 'Servers', validTill: istDate(20), documentId: doc.id },
    { oem: 'Zenith Ltd', products: 'Laptops', validTill: istDate(200), documentId: null },
  ] });
  expect(r.status(), await r.text()).toBe(200);
  const p = await getProfile(page);
  expect(p.completeness).toBe(100);
  expect(p.issues).toEqual([
    expect.objectContaining({ severity: 'info', message: 'OEM authorisation from Acme Corp expires in 20 days — ask for a renewed MAF.' }),
    expect.objectContaining({ severity: 'info', message: 'Link the Zenith Ltd authorisation letter from the vault so packets can attach it.' }),
  ]);
  await page.goto('/profile');
  await expect(ring(page, 100)).toBeVisible();
  await expect(page.getByRole('button', { name: 'OEM authorisation from Acme Corp expires in 20 days — ask for a renewed MAF.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Link the Zenith Ltd authorisation letter from the vault so packets can attach it.' })).toBeVisible();
  await ev(page, 'ac11-oem-info-suggestions');
});

test('AC3/AC5 mobile: compact completeness pill shows the live score @mobile', async ({ page }) => {
  await signupViaApi(page);
  await seedDemo(page.request);
  await page.goto('/profile');
  await expect(ring(page, 96)).toBeVisible();
  await ev(page, `mobile-compact-meter-${test.info().project.name}`);
});
