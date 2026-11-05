import { test, expect, signupViaApi, evidence, collectRunArtifacts } from '../support/fixtures';
import type { Page } from '@playwright/test';
import { joinOrgAs, VALID_GSTIN, VALID_PAN } from './support';

const SPEC = '005', STORY = 'US1';
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

const field = (page: Page, id: string) => page.locator(`#f-${id}`);
async function type(page: Page, id: string, v: string) { const f = field(page, id); await f.fill(v); return f; }
async function blur(page: Page) { await page.locator('h1').click(); }
/** The inline error rendered under a field (Field puts it in the same wrapper as the input). */
const fieldBlock = (page: Page, id: string) => field(page, id).locator('xpath=ancestor::div[.//label][1]');

test.describe('US1 validated company profile', () => {
  test('AC1 fresh org: header, hint, disabled save, 7 sections in order, meter 0% @mobile', async ({ page }, info) => {
    await signupViaApi(page);
    await page.goto('/profile');
    await expect(page.getByRole('heading', { level: 1, name: 'Company profile' })).toBeVisible();
    if (info.project.name === 'desktop') {
      await expect(page.getByText('Not saved yet')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    }
    const titles = await page.locator('section[id^="sec-"] h2').allTextContents();
    expect(titles).toEqual(['Company identity', 'Registrations & status', 'Financials', 'Experience', 'OEM authorisations', 'Categories & reach', 'Signatory & contact']);
    if (info.project.name === 'desktop') {
      await expect(page.getByText('Let’s complete your profile').locator('visible=true')).toBeVisible();
      await expect(page.getByRole('img', { name: 'Profile 0% complete' }).first()).toBeVisible();
    } else {
      await expect(page.getByRole('button', { name: 'Profile 0% complete' })).toBeVisible();
    }
    await ev(page, 'ac01-fresh-profile');
  });

  test('AC2 GSTIN upper-case, valid hint, Fill from GSTIN only fills empty PAN/State', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/profile');
    const g = await type(page, 'gstin', '27aapfu0939f1zv');
    await expect(g).toHaveValue(VALID_GSTIN);
    await expect(page.getByText(`✓ Valid · Maharashtra · PAN ${VALID_PAN}`)).toBeVisible();
    const fill = page.getByRole('button', { name: 'Fill from GSTIN' });
    await expect(fill).toBeVisible();
    await ev(page, 'ac02-gstin-valid-before-fill');
    await fill.click();
    await expect(field(page, 'pan')).toHaveValue(VALID_PAN);
    await expect(page.locator('#f-state')).toContainText('Maharashtra');
    await expect(page.getByText('✓ Firm / LLP')).toBeVisible();
    await ev(page, 'ac02-after-fill');

    // "only where empty": a pre-filled PAN is not overwritten (state left empty so the button stays available).
    await page.reload();
    await type(page, 'pan', 'AAACI1681G');
    await type(page, 'gstin', VALID_GSTIN);
    // the GSTIN/PAN mismatch is an error, but autofill must not clobber PAN
    await page.getByRole('button', { name: 'Fill from GSTIN' }).click();
    await expect(field(page, 'pan')).toHaveValue('AAACI1681G');
    await expect(page.locator('#f-state')).toContainText('Maharashtra');
    await ev(page, 'ac02-autofill-keeps-existing-pan');
  });

  test('AC3 invalid GSTIN messages', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/profile');
    await type(page, 'gstin', '27AAPFU0939F1ZA'); await blur(page);
    await expect(page.getByText('GSTIN check character does not match — please re-check for a typo')).toBeVisible();
    await ev(page, 'ac03-check-char');
    await type(page, 'gstin', '00AAPFU0939F1ZV'); await blur(page);
    await expect(page.getByText('"00" is not a valid GST state code (01–38, 97 or 99)')).toBeVisible();
    await ev(page, 'ac03-state-code');
    await type(page, 'gstin', '27AAPFU0939F1Z'); await blur(page);
    const msg = page.getByText(/GSTIN has 15 characters, e\.g\. 27AAPCS1234K1Z\d/);
    await expect(msg).toBeVisible();
    await expect(msg).toHaveText('GSTIN has 15 characters, e.g. 27AAPCS1234K1Z2');
    await ev(page, 'ac03-length');
  });

  test('AC4 inline errors with exact texts', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/profile');
    await type(page, 'pan', 'AAPXU0939F'); await blur(page);
    await expect(page.getByText('The 4th character "X" is not a valid PAN holder type (P, C, H, F, A, T, B, L, J or G)')).toBeVisible();
    await page.getByRole('switch', { name: 'We are a registered MSE' }).click();
    await type(page, 'udyamNumber', 'UDYAM-1'); await blur(page);
    await expect(page.getByText('Udyam number format is UDYAM-XX-00-0000000 (e.g. UDYAM-MH-26-0123456)')).toBeVisible();
    await type(page, 'cin', 'U72200MH2015PTC12345'); await blur(page);
    await expect(page.getByText('CIN has 21 characters, e.g. U72200MH2015PTC123456')).toBeVisible();
    await type(page, 'pincode', '012345'); await blur(page);
    await expect(page.getByText('PIN code is 6 digits and cannot start with 0')).toBeVisible();
    await type(page, 'contactPhone', '12345'); await blur(page);
    await expect(page.getByText('Enter a 10-digit Indian mobile number starting with 6–9')).toBeVisible();
    await type(page, 'contactEmail', 'bids@'); await blur(page);
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    await ev(page, 'ac04-inline-errors');
  });

  test('AC5 GSTIN/PAN mismatch blocks save client-side', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/profile');
    await type(page, 'legalName', 'Sharma Infotech Pvt Ltd');
    await type(page, 'gstin', VALID_GSTIN);
    await type(page, 'pan', 'AAACI1681G');
    let puts = 0;
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/profile')) puts++; });
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText('Please fix the highlighted fields')).toBeVisible();
    await expect(page.getByText('This GSTIN belongs to PAN AAPFU0939F, not AAACI1681G').first()).toBeVisible();
    await expect(field(page, 'gstin')).toBeFocused();
    expect(puts).toBe(0);
    await ev(page, 'ac05-mismatch-blocks-save');
  });

  test('AC6 API: invalid gstin/pan/pincode -> 400 validation_error per field, nothing stored', async ({ page }) => {
    await signupViaApi(page);
    const r = await page.request.put('/api/profile', { data: { gstin: '27AAPFU0939F1ZA', pan: 'AAPXU0939F', pincode: '01234' } });
    expect(r.status()).toBe(400);
    const body = await r.json();
    console.log('AC6 body', JSON.stringify(body));
    expect(body.error?.code ?? body.code).toBe('validation_error');
    const fields = (body.error?.details ?? body.details).fields;
    expect(fields.gstin).toMatch(/check character/i);
    expect(fields.pan).toMatch(/4th character/i);
    expect(fields.pincode).toBeTruthy();
    const get = await (await page.request.get('/api/profile')).json();
    expect(get.profile.gstin).toBeNull(); expect(get.profile.pan).toBeNull(); expect(get.profile.pincode).toBeNull();
    expect(get.profile.updatedAt).toBeNull();
    await page.goto('/profile'); await ev(page, 'ac06-nothing-stored');
  });

  test('AC7 API: PAN-only change conflicting with stored GSTIN -> 400 fields.pan', async ({ page }) => {
    await signupViaApi(page);
    expect((await page.request.put('/api/profile', { data: { legalName: 'Sharma Infotech', gstin: VALID_GSTIN } })).status()).toBe(200);
    const r = await page.request.put('/api/profile', { data: { pan: 'AAACI1681G' } });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error?.code ?? body.code).toBe('validation_error');
    expect((body.error?.details ?? body.details).fields.pan).toBe('Your GSTIN is registered to PAN AAPFU0939F');
    expect((await (await page.request.get('/api/profile')).json()).profile.pan).toBeNull();
    await page.goto('/profile'); await ev(page, 'ac07-pan-vs-stored-gstin');
  });

  test('AC8 API: partial upsert normalises, keeps omitted fields, logs profile.updated', async ({ page }) => {
    await signupViaApi(page);
    const a = await page.request.put('/api/profile', { data: { legalName: 'Sharma Infotech Pvt Ltd', gstin: '27aapfu0939f1zv', contactPhone: '98123 45678', udyamNumber: 'udyam-mh-26-0123456', mseCategory: 'small' } });
    expect(a.status(), await a.text()).toBe(200);
    const pa = (await a.json()).profile;
    expect(pa.gstin).toBe(VALID_GSTIN); expect(pa.contactPhone).toBe('+919812345678'); expect(pa.udyamNumber).toBe('UDYAM-MH-26-0123456');
    const b = await page.request.put('/api/profile', { data: { tradeName: 'Sharma IT' } });
    expect(b.status()).toBe(200);
    const pb = (await b.json()).profile;
    expect(pb).toMatchObject({ tradeName: 'Sharma IT', legalName: 'Sharma Infotech Pvt Ltd', gstin: VALID_GSTIN, contactPhone: '+919812345678', udyamNumber: 'UDYAM-MH-26-0123456', mseCategory: 'small' });
    const act = await (await page.request.get('/api/activity?entityType=profile&pageSize=50')).json();
    const rows = (act.items as { action: string; meta: { fields: string[] } }[]).filter((x) => x.action === 'profile.updated');
    expect(rows).toHaveLength(2);
    const sets = rows.map((x) => [...x.meta.fields].sort());
    expect(sets).toContainEqual(['contactPhone', 'gstin', 'legalName', 'mseCategory', 'udyamNumber']);
    expect(sets).toContainEqual(['tradeName']);
    await page.goto('/profile'); await ev(page, 'ac08-partial-upsert');
  });

  test('AC9 MII local-content rules', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/profile');
    await page.getByRole('radio', { name: /Class-I\b/ }).first().click();
    await type(page, 'localContentPct', '30'); await blur(page);
    await expect(page.getByText('Class-I needs at least 50% local content')).toBeVisible();
    await ev(page, 'ac09-class1-30');
    await page.getByRole('radio', { name: /Class-II/ }).first().click();
    await type(page, 'localContentPct', '55'); await blur(page);
    await expect(page.getByText('Class-II means 20% to under 50% local content')).toBeVisible();
    await ev(page, 'ac09-class2-55');
    await page.getByRole('radio', { name: /Non-local/ }).first().click();
    await expect(field(page, 'localContentPct')).toHaveCount(0);
    await ev(page, 'ac09-nonlocal-hides');
  });

  test('AC10 MSE switch', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/profile');
    const sw = page.getByRole('switch', { name: 'We are a registered MSE' });
    await expect(field(page, 'udyamNumber')).toHaveCount(0);
    await sw.click();
    await expect(field(page, 'udyamNumber')).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Enterprise category' }).or(page.getByLabel('Enterprise category')).first()).toBeVisible();
    await expect(page.locator('#f-mseSocialCategory')).toContainText('General');
    await ev(page, 'ac10-mse-on-small');
    await page.getByRole('radio', { name: 'Medium' }).or(page.getByRole('button', { name: 'Medium' })).first().click();
    await expect(page.getByText('Medium enterprises don’t get EMD exemption or MSE purchase preference.')).toBeVisible();
    await ev(page, 'ac10-medium-warning');
    await type(page, 'udyamNumber', 'UDYAM-MH-26-0123456');
    await sw.click();
    await expect(field(page, 'udyamNumber')).toHaveCount(0);
    await sw.click();
    await expect(field(page, 'udyamNumber')).toHaveValue('');
    await expect(page.locator('#f-mseSocialCategory')).toContainText('General');
    await ev(page, 'ac10-off-clears');
  });

  test('AC11 unsaved bar, N to fix, Discard, save toast and header hint @mobile', async ({ page }, info) => {
    await signupViaApi(page);
    await page.goto('/profile');
    const bar = page.getByRole('region', { name: 'Unsaved changes' });
    await type(page, 'legalName', 'Sharma Infotech Pvt Ltd');
    await expect(bar.getByText('Unsaved changes')).toBeVisible();
    await type(page, 'pincode', '012345');
    await expect(bar.getByText(/· 1 to fix/)).toBeVisible();
    await ev(page, 'ac11-unsaved-bar-with-errors');
    await bar.getByRole('button', { name: 'Discard' }).click();
    await expect(field(page, 'legalName')).toHaveValue('');
    await expect(field(page, 'pincode')).toHaveValue('');
    await expect(bar).toBeHidden();
    await type(page, 'legalName', 'Sharma Infotech Pvt Ltd');
    await bar.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Profile saved')).toBeVisible();
    await expect(page.getByText(/^\d+% complete · next: .+/)).toBeVisible();
    await ev(page, 'ac11-saved-toast');
    if (info.project.name === 'desktop') await expect(page.getByText('Saved just now')).toBeVisible();
    await expect(bar).toBeHidden();
  });

  test('AC12a beforeunload prompt when closing tab with unsaved edits', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/profile');
    await type(page, 'legalName', 'Unsaved Co');
    const dialogP = page.waitForEvent('dialog', { timeout: 8000 }).then(async (d) => { const t = d.type(); await d.dismiss(); return t; }).catch(() => 'none');
    await page.close({ runBeforeUnload: true });
    const sawType = await dialogP;
    expect(sawType).toBe('beforeunload');
    expect(page.isClosed()).toBe(false);
    await ev(page, 'ac12a-beforeunload-dismissed-page-stays');
  });

  test('AC12b in-app navigation shows Discard unsaved changes? dialog', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/profile');
    await type(page, 'legalName', 'Unsaved Co');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /dashboard/i }).click();
    const dlg = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(dlg.getByText('Discard unsaved changes?')).toBeVisible();
    await ev(page, 'ac12b-discard-dialog');
    await dlg.getByRole('button', { name: 'Stay' }).click();
    await expect(page).toHaveURL(/\/profile/);
    await expect(field(page, 'legalName')).toHaveValue('Unsaved Co');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /dashboard/i }).click();
    await page.getByRole('button', { name: 'Discard and leave' }).click();
    await expect(page).not.toHaveURL(/\/profile/);
  });

  test('AC13 viewer is read-only; PUT -> 403', async ({ page, browser }, info) => {
    await signupViaApi(page);
    await page.request.put('/api/profile', { data: { legalName: 'Sharma Infotech', gstin: VALID_GSTIN } });
    const { ctx } = await joinOrgAs(browser, page, 'viewer', info.project.use.baseURL!);
    const vp = await ctx.newPage();
    await vp.goto('/profile');
    await expect(vp.getByText('You have view-only access. Ask an owner or bid manager to make changes.')).toBeVisible();
    await expect(field(vp, 'legalName')).toBeDisabled();
    await expect(field(vp, 'gstin')).toBeDisabled();
    await expect(field(vp, 'gstin')).toHaveValue(VALID_GSTIN);
    for (const sel of [vp.getByRole('button', { name: 'Save profile' }), vp.getByRole('button', { name: 'Fill from GSTIN' }), vp.getByRole('region', { name: 'Unsaved changes' }), vp.getByRole('button', { name: /Add contract/ })]) await expect(sel).toHaveCount(0);
    // every enabled form control inside the profile fieldset: none
    expect(await vp.locator('fieldset input:enabled, fieldset textarea:enabled').count()).toBe(0);
    await evidence(vp, SPEC, STORY, `ac13-viewer-readonly-${info.project.name}`);
    const put = await vp.request.put('/api/profile', { data: { legalName: 'X' } });
    expect(put.status()).toBe(403);
    const b = await put.json();
    expect(b.error?.code ?? b.code).toBe('forbidden');
    expect(b.error?.message ?? b.message).toBe('You need to be at least an Analyst to do that');
    await ctx.close();
  });

  test('AC14 stale save -> 409 conflict with Reload', async ({ page, browser }, info) => {
    await signupViaApi(page);
    await page.request.put('/api/profile', { data: { legalName: 'Sharma Infotech' } });
    const { ctx } = await joinOrgAs(browser, page, 'analyst', info.project.use.baseURL!);
    await page.goto('/profile');
    await type(page, 'tradeName', 'B change on older copy');
    // A (second analyst) saves first, via API with the current version token.
    const cur = (await (await ctx.request.get('/api/profile')).json()).profile.updatedAt;
    const a = await ctx.request.put('/api/profile', { data: { tradeName: 'A change', expectedUpdatedAt: cur } });
    expect(a.status(), await a.text()).toBe(200);
    // B saves from the UI
    await page.getByRole('button', { name: 'Save profile' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Someone else saved the profile at' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Someone else saved the profile at .+\. Reload to see their changes\./);
    await expect(alert.getByRole('button', { name: 'Reload' })).toBeVisible();
    await ev(page, 'ac14-conflict-banner');
    // nothing of B's stored
    expect((await (await page.request.get('/api/profile')).json()).profile.tradeName).toBe('A change');
    // direct API 409 too
    const r = await page.request.put('/api/profile', { data: { tradeName: 'stale', expectedUpdatedAt: cur } });
    expect(r.status()).toBe(409);
    const body = await r.json();
    expect(body.error?.code ?? body.code).toBe('conflict');
    expect(body.error?.message ?? body.message).toMatch(/^Someone else saved the profile at .+ Reload to see their changes\.$/);
    await alert.getByRole('button', { name: 'Reload' }).click();
    await expect(field(page, 'tradeName')).toHaveValue('A change');
    await expect(alert).toBeHidden();
    await ctx.close();
  });

  test('Independent test: GSTIN + Fill + name + Save + reload persists', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/profile');
    await type(page, 'gstin', VALID_GSTIN);
    await page.getByRole('button', { name: 'Fill from GSTIN' }).click();
    await type(page, 'legalName', 'Sharma Infotech Pvt Ltd');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText('Profile saved')).toBeVisible();
    await page.reload();
    const p = (await (await page.request.get('/api/profile')).json()).profile;
    expect(p).toMatchObject({ gstin: VALID_GSTIN, pan: VALID_PAN, state: 'Maharashtra', legalName: 'Sharma Infotech Pvt Ltd' });
    await expect(field(page, 'gstin')).toHaveValue(VALID_GSTIN);
    await ev(page, 'independent-persisted');
  });

  test('Layout @mobile: pill nav, save bar above tab bar, no horizontal scroll', async ({ page }, info) => {
    await signupViaApi(page);
    await page.goto('/profile');
    await type(page, 'legalName', 'Layout Co');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    if (info.project.name === 'mobile') {
      const vw = page.viewportSize()!.width;
      expect(vw).toBeLessThanOrEqual(480);
      const pills = page.getByRole('navigation', { name: 'Profile sections' }).first();
      await expect(pills).toBeVisible();
      await expect(pills.getByRole('button', { name: 'Company identity' })).toBeVisible();
      const bar = page.getByRole('region', { name: 'Unsaved changes' });
      await expect(bar).toBeVisible();
      const tab = page.getByRole('navigation', { name: 'Primary' });
      await expect(tab).toBeVisible();
      // the bar slides in over 300ms; poll until it settles, then compare with the tab bar
      await expect.poll(async () => { const bb = (await bar.boundingBox())!, tb = (await tab.boundingBox())!; return Math.round(tb.y - (bb.y + bb.height)); }, { timeout: 5000 }).toBeGreaterThanOrEqual(-1);
    }
    await ev(page, 'layout');
  });
});
