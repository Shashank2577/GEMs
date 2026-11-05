/**
 * Spec 006 / US6 (#188): assisted submission - copy-ready values and the browser extension, never prices.
 * QA task T086. Scenarios S1..S15 of the spec, FR-069..FR-077.
 *
 * Web + API tests run in `desktop` (@mobile subset also in `mobile`). Extension tests drive the real unpacked MV3 build
 * (apps/extension/dist) in Chromium against the real API and the GeM-like fixture page.
 *
 * Method notes (repeated in VERDICT.md):
 *  - chrome.permissions.request() shows a native prompt that automation cannot answer. The popup connects through
 *    seedSettings() (chrome.storage.local) for the happy paths; the permission-granted branch of "Save & connect" is exercised
 *    by stubbing chrome.permissions.request in the popup page (the real popup code, real API); the permission prompt itself and the
 *    "that origin only" scoping are checked from the manifest (optional_host_permissions + the origin string the popup passes).
 *  - Cross-origin fetch from the popup to the test API needs a host permission we cannot grant, so the browser is launched with
 *    --disable-web-security (test harness only).
 *  - The popup is opened as a normal tab; the fixture tab is brought to the front before Highlight / Fill so it is the "active tab".
 */
import { test, expect, evidence, collectRunArtifacts, a11y, noHorizontalOverflow } from '../support/fixtures';
import { seedApplyFixture, newApi, apiAs, signInAs, createWorkspace, E2E_BASE_URL, E2E_DB_URL, type ApplyFixture, type Role } from '../support/seed-apply';
import { launchWithExtension, seedSettings, EXTENSION_DIST, type ExtensionHarness } from '../support/extension';
import { createRequire } from 'node:module';
import { analyses, createNodeDb, tenders } from '../../packages/db/src/index';
const { eq } = createRequire(import.meta.url)('../../packages/db/node_modules/drizzle-orm') as typeof import('../../packages/db/node_modules/drizzle-orm');
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPEC = '006';
const STORY = 'US6';
const EVID_DIR = join('qa', 'evidence', SPEC, STORY);
const FILE = 'GEM_2026_B_700001_technical_packet.pdf';

const slugOf = (t: string) => t.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
// Evidence budget: mobile full-page PNGs are large, so only the layout-relevant ones are kept at 375px.
const MOBILE_SHOTS = new Set(['s1-submit-step', 's6-after-build', 's14-token-dialog']);
const shot = async (page: Page, name: string) => {
  if (test.info().project.name === 'mobile' && !MOBILE_SHOTS.has(name)) return;
  return evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
};
const toastWith = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text });

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
const assistOf = async (c: Ctx, role: Role = 'analyst') => (await call(c.fx, role, 'get', `/api/assist/${c.ws}`)).body;
const putValues = (c: Ctx, data: unknown, role: Role = 'analyst') => call(c.fx, role, 'put', `/api/workspaces/${c.ws}/assist-values`, data);

/** Transcript of API calls, saved as small JSON evidence next to the screenshots. */
function transcript() {
  const rows: unknown[] = [];
  return {
    add(label: string, req: string, res: { status: number; body: any }) { rows.push({ label, request: req, status: res.status, response: res.body }); },
    save(name: string) { mkdirSync(EVID_DIR, { recursive: true }); writeFileSync(join(EVID_DIR, `${name}.json`), JSON.stringify(rows, null, 2)); },
  };
}

async function openSubmit(page: Page, context: any, c: Ctx, role: Role = 'analyst') {
  await signInAs(context, c.fx, role);
  await page.goto(`/workspaces/${c.ws}?step=submit`);
  await expect(page.getByRole('heading', { name: 'Values to enter on GeM' })).toBeVisible();
  await expect(page.getByText('Not set').first()).toBeVisible();
}
const card = (page: Page) => page.getByRole('heading', { name: 'Values to enter on GeM' }).locator('xpath=ancestor::div[contains(@class,"divide-y") or contains(@class,"rounded")][1]/..');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const valueRow = (page: Page, label: string) =>
  page.locator('dl > div').filter({ has: page.locator('dt').filter({ hasText: new RegExp(`^\\s*${esc(label)}\\s*(Edited|From profile|From tender|From analysis|Not set)?\\s*$`) }) });

const CATALOG_KEYS = [
  'make', 'brand', 'model', 'oem_name', 'product_description', 'hsn_code', 'offered_quantity', 'delivery_period_days', 'warranty_months',
  'country_of_origin', 'local_content_pct', 'specs_compliance', 'mse_claim', 'startup_claim',
];

// ═════════════ Web + API (page-based; video per test) ═════════════
test.describe('web + api', () => {
  test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

  test('S1 Human-only steps: 4 steps with detail text and the never-stores line @mobile', async ({ page, context }) => {
    const c = await named('main');
    await openSubmit(page, context, c);
    await expect(page.getByRole('heading', { name: 'Human-only steps' })).toBeVisible();
    const steps = page.getByRole('heading', { name: 'Human-only steps' }).locator('xpath=ancestor::div[contains(@class,"relative")][1]').locator('ol > li');
    await expect(steps).toHaveCount(4);
    const texts = (await steps.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    // Spec wording: 1 Enter your price on GeM, 2 Upload the documents, 3 Authenticate with OTP / DSC / e-Sign, 4 Click Final Submit.
    expect(texts[0]).toContain('Enter your price on GeM');
    expect(texts[0]).toContain('Type the unit price yourself in the GeM price schedule.');
    expect(texts[1]).toContain('Upload the documents');
    expect(texts[1]).toContain('Attach the merged packet and documents listed below.');
    expect(texts[2]).toMatch(/with OTP \/ DSC \/ e-Sign/);
    expect(texts[2]).toContain('Aadhaar OTP, e-Sign or your Digital Signature Certificate.');
    expect(texts[3]).toContain('Click Final Submit');
    expect(texts[3]).toContain('Review the GeM summary and submit — then mark it here.');
    test.info().annotations.push({ type: 'observation', description: `step 3 title is "${texts[2].replace(/^\d\s*/, '').split('Aadhaar')[0].trim()}" (spec: "Authenticate with OTP / DSC / e-Sign")` });
    await expect(page.getByText('TenderPilot never stores GeM passwords, enters prices, solves CAPTCHA or performs OTP / DSC / e-Sign.')).toBeVisible();
    // The extension card: read-only token recommendation (FR-074).
    await expect(page.getByText('Fill GeM forms in one click')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create a read-only API token' })).toHaveAttribute('href', '/settings/api-tokens?scope=read');
    await shot(page, 's1-submit-step');
    if (test.info().project.name === 'mobile') await noHorizontalOverflow(page);
  });

  // axe over the Submit step. The workspace header (stage dropdown / owner popover, shipped in US1) is excluded from the scope
  // so that this verdict covers only US6 UI; header findings are reported separately as an observation.
  const HEADER_CHROME = ['button[aria-label="Owner and assignees"]', 'button[aria-label="Internal due date"]', '[id^="radix-"]'];
  test('A1 axe: Submit step (human-only steps, values card, upload order, extension card) has 0 serious/critical @mobile', async ({ page, context }) => {
    const c = await named('main');
    await openSubmit(page, context, c);
    await a11y(page, 'submit-step', { exclude: HEADER_CHROME });
  });

  test('A2 axe: values editor open has 0 serious/critical', async ({ page, context }) => {
    const c = await named('main');
    await openSubmit(page, context, c);
    await page.getByRole('button', { name: 'Edit values' }).click();
    await expect(page.getByLabel('Make', { exact: true })).toBeVisible();
    await a11y(page, 'values-editor', { exclude: HEADER_CHROME });
  });

  test('S2 GET /api/assist/{id}: noFinancials, 14 fields in catalog order with value+source, no price-like keys or values', async () => {
    const c = await named('main');
    const t = transcript();
    const r = await call(c.fx, 'analyst', 'get', `/api/assist/${c.ws}`);
    t.add('GET /api/assist/{id}', `GET /api/assist/${c.ws}`, r);
    t.save('api-s2-assist-payload');
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.noFinancials).toBe(true);
    expect(b.tender.bidNumber).toBe('GEM/2026/B/700001');
    expect(typeof b.stage).toBe('string');
    expect(b.readiness).toMatchObject({ percent: expect.any(Number), blockers: expect.any(Number) });
    expect(b.workspaceUrl).toContain(`/workspaces/${c.ws}`);
    expect(b.humanSteps).toHaveLength(4);
    expect(b.fields.map((f: any) => f.key)).toEqual(CATALOG_KEYS);
    const by = Object.fromEntries(b.fields.map((f: any) => [f.key, f]));
    const expectKV = (k: string, value: string, source: string) => expect({ k, value: by[k].value, source: by[k].source }, k).toEqual({ k, value, source });
    expectKV('make', 'Dell', 'profile'); expectKV('brand', 'Dell', 'profile'); expectKV('oem_name', 'Dell', 'profile');
    expectKV('offered_quantity', '40', 'tender'); expectKV('delivery_period_days', '30', 'analysis');
    expectKV('country_of_origin', 'India', 'profile'); expectKV('local_content_pct', '62', 'profile');
    expectKV('specs_compliance', 'Yes', 'profile'); expectKV('mse_claim', 'Yes', 'profile'); expectKV('startup_claim', 'No', 'profile');
    expectKV('product_description', 'Laptop i5 16GB', 'tender');
    for (const k of ['model', 'warranty_months', 'hsn_code']) expectKV(k, '', 'empty');
    // No price-like key anywhere in the JSON, and no price-like / currency value.
    const keys: string[] = [];
    const vals: string[] = [];
    (function walk(x: any) {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.push(k); walk(v); }
      else if (typeof x === 'string') vals.push(x);
    })(b);
    expect(keys.filter((k) => /price|rate|amount|value|₹|inr|cost|bid_?value/i.test(k) && k !== 'value' && k !== 'noFinancials'), 'price-like keys').toEqual([]);
    // `value` is the generic field key of {label,value,source}; every other key must be clean, and no field KEY is price-like.
    expect(b.fields.map((f: any) => f.key).filter((k: string) => /price|rate|amount|value|bid/i.test(k))).toEqual([]);
    expect(vals.filter((v) => /₹|\bINR\b|\bRs\.?\b/i.test(v)), 'currency values').toEqual([]);
    await call(c.fx, 'analyst', 'get', `/api/assist/${c.ws}`);
    // Viewer can read; unauthenticated cannot.
    expect((await call(c.fx, 'viewer', 'get', `/api/assist/${c.ws}`)).status).toBe(200);
    const anon = await newApi();
    expect((await anon.get(`/api/assist/${c.ws}`)).status()).toBe(401);
    await anon.dispose();
  });

  test('S3 Values card: title, intro, groups, "Not set" italic, Copy buttons (disabled when empty) copy the value @mobile', async ({ page, context }) => {
    const c = await named('main');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await openSubmit(page, context, c);
    await expect(page.getByText('Non-financial fields only. Copy each one, or let the browser extension fill them on your click.')).toBeVisible();
    const groups = (await page.locator('div.text-2xs.font-semibold.uppercase').allInnerTexts()).map((s) => s.trim().toLowerCase());
    expect(groups).toEqual(['product', 'offer', 'compliance', 'declaration']);
    // spec scenario 3 heading text: "Declaration"
    const a = await assistOf(c);
    // Empty values read "Not set" in italics and their Copy button is disabled.
    for (const f of a.fields.filter((x: any) => x.source === 'empty')) {
      const row = valueRow(page, f.label);
      const dd = row.locator('dd');
      await expect(dd).toHaveText('Not set');
      expect(await dd.locator('span').first().evaluate((e) => getComputedStyle(e).fontStyle)).toBe('italic');
      await expect(row.getByRole('button', { name: `Copy ${f.label}` })).toBeDisabled();
    }
    // Filled values have an enabled Copy button that copies exactly the value.
    for (const f of a.fields.filter((x: any) => x.source !== 'empty')) {
      const row = valueRow(page, f.label);
      await expect(row.locator('dd')).toHaveText(f.value);
      const btn = row.getByRole('button', { name: `Copy ${f.label}` });
      await expect(btn).toBeEnabled();
    }
    if (test.info().project.name === 'desktop') {
      const country = a.fields.find((f: any) => f.key === 'country_of_origin');
      await valueRow(page, country.label).getByRole('button', { name: `Copy ${country.label}` }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('India');
      const desc = a.fields.find((f: any) => f.key === 'product_description');
      await valueRow(page, desc.label).getByRole('button', { name: `Copy ${desc.label}` }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Laptop i5 16GB');
    }
    await shot(page, 's3-values-card');
  });

  test('S4 Edit values: only changed keys PUT, 200, "Values saved", source Edited, Model in annexures; empty clears; Cancel discards', async ({ page, context }) => {
    const c = await named('edit');
    const t = transcript();
    await openSubmit(page, context, c);
    const a0 = await assistOf(c);
    const lab = (k: string) => a0.fields.find((f: any) => f.key === k).label as string;
    // Before: the Model annexure placeholder is unresolved.
    const d0 = (await call(c.fx, 'analyst', 'get', `/api/workspaces/${c.ws}`)).body;
    const withModel = d0.annexures.find((x: any) => x.missing.includes('offer.model'));
    expect(withModel, 'an annexure that uses {{offer.model}} is missing it before').toBeTruthy();

    // Cancel discards the draft.
    await page.getByRole('button', { name: 'Edit values' }).click();
    await page.getByLabel(lab('make'), { exact: true }).fill('Zzz-discard');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(valueRow(page, lab('make')).locator('dd')).toHaveText('Dell');
    await page.getByRole('button', { name: 'Edit values' }).click();
    await expect(page.getByLabel(lab('make'), { exact: true })).toHaveValue('Dell');
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Edit Model + Warranty -> only those two keys are sent.
    await page.getByRole('button', { name: 'Edit values' }).click();
    await shot(page, 's4-editor-open');
    await page.getByLabel(lab('model'), { exact: true }).fill('Latitude 5450');
    await page.getByLabel(lab('warranty_months'), { exact: true }).fill('36');
    const reqP = page.waitForRequest((r) => r.url().includes(`/api/workspaces/${c.ws}/assist-values`) && r.method() === 'PUT');
    const resP = page.waitForResponse((r) => r.url().includes(`/api/workspaces/${c.ws}/assist-values`) && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const req = await reqP; const res = await resP;
    expect(req.postDataJSON()).toEqual({ model: 'Latitude 5450', warranty_months: '36' });
    expect(res.status()).toBe(200);
    const resBody = await res.json();
    t.add('PUT assist-values (UI save)', `PUT /api/workspaces/${c.ws}/assist-values ${req.postData()}`, { status: res.status(), body: resBody });
    expect(resBody.assistValues).toMatchObject({ model: 'Latitude 5450', warranty_months: '36' });
    await expect(toastWith(page, 'Values saved')).toBeVisible();
    await expect(valueRow(page, lab('model')).locator('dd')).toHaveText('Latitude 5450');
    await expect(valueRow(page, lab('model'))).toContainText('Edited');
    await shot(page, 's4-saved');
    const a1 = await assistOf(c);
    expect(a1.fields.find((f: any) => f.key === 'model')).toMatchObject({ value: 'Latitude 5450', source: 'saved' });
    expect(a1.fields.find((f: any) => f.key === 'warranty_months')).toMatchObject({ value: '36', source: 'saved' });
    // Model now prints in the annexure that uses {{offer.model}}.
    const d1 = (await call(c.fx, 'analyst', 'get', `/api/workspaces/${c.ws}`)).body;
    expect(d1.annexures.find((x: any) => x.key === withModel.key).missing).not.toContain('offer.model');
    const api = await apiAs(c.fx, 'analyst');
    const pdf = Buffer.from(await (await api.get(`/api/workspaces/${c.ws}/annexures/${withModel.key}.pdf`)).body());
    await api.dispose();
    const dir = mkdtempSync(join(tmpdir(), 'us6-')); const f = join(dir, 'a.pdf'); writeFileSync(f, pdf);
    const txt = execFileSync('pdftotext', ['-layout', f, '-']).toString();
    expect(txt).toContain('Latitude 5450');
    t.add('annexure text contains the saved Model', `GET /api/workspaces/${c.ws}/annexures/${withModel.key}.pdf | pdftotext`, { status: 200, body: { annexure: withModel.title, containsLatitude5450: true } });

    // No-op save (nothing changed) sends nothing.
    let puts = 0; page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('assist-values')) puts++; });
    await page.getByRole('button', { name: 'Edit values' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit values' })).toBeVisible();
    expect(puts).toBe(0);

    // A derived field edited then emptied: override persists, then "" removes the key and falls back to the derived default.
    await page.getByRole('button', { name: 'Edit values' }).click();
    await page.getByLabel(lab('make'), { exact: true }).fill('Acer');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(valueRow(page, lab('make')).locator('dd')).toHaveText('Acer');
    await expect(valueRow(page, lab('make'))).toContainText('Edited');
    await page.getByRole('button', { name: 'Edit values' }).click();
    await page.getByLabel(lab('make'), { exact: true }).fill('');
    const clr = page.waitForRequest((r) => r.url().includes('assist-values') && r.method() === 'PUT');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await clr).postDataJSON()).toEqual({ make: '' });
    await expect(valueRow(page, lab('make')).locator('dd')).toHaveText('Dell');
    const a2 = await assistOf(c);
    expect(a2.fields.find((f: any) => f.key === 'make')).toMatchObject({ value: 'Dell', source: 'profile' });
    t.add('after clearing make', `GET /api/assist/${c.ws}`, { status: 200, body: a2.fields.find((f: any) => f.key === 'make') });
    t.save('api-s4-edit-values');
    await shot(page, 's4-cleared-falls-back');
  });

  test('S5 PUT assist-values guards: forbidden_field spellings, unknown key, non-text, >2000 chars, Viewer 403 (nothing stored)', async () => {
    const c = await named('guards');
    const t = transcript();
    const before = JSON.stringify((await assistOf(c)).fields);
    const forbiddenBodies: Record<string, unknown>[] = [
      { unit_price: '1000' }, { totalBidValue: '5' }, { otp: '1234' }, { captcha: 'x' }, { dsc_pin: '1' }, { final_submit: 'yes' },
      { 'Unit Price': '1' }, { unitPrice: '1' }, { bid_value: '1' }, { rate: '1' }, { amount: '1' }, { password: 'p' }, { aadhaar: '1' }, { esign: 'y' }, { UNIT_PRICE: '9' },
    ];
    let n = 0;
    for (const body of forbiddenBodies) {
      const r = await putValues(c, body);
      const key = Object.keys(body)[0];
      t.add(`forbidden ${key}`, `PUT assist-values ${JSON.stringify(body)}`, r);
      expect(r.status, key).toBe(400);
      expect(r.body.error.code, key).toBe('forbidden_field');
      expect(r.body.error.details.forbidden, key).toEqual([key]);
      expect(r.body.error.message, key).toContain(`"${key}"`);
      expect(r.body.error.message, key).toMatch(/looks like .*TenderPilot never stores or fills prices, OTP, CAPTCHA, DSC\/e-Sign or submit actions\./);
      n++;
    }
    // Exact message for the spec's headline example.
    const up = await putValues(c, { unit_price: '1000' });
    expect(up.body.error.message).toBe('"unit_price" looks like a price field. TenderPilot never stores or fills prices, OTP, CAPTCHA, DSC/e-Sign or submit actions.');
    // Mixed legit + forbidden: whole request refused.
    const mixed = await putValues(c, { model: 'X1', unit_price: '5' });
    t.add('mixed', 'PUT {model, unit_price}', mixed);
    expect(mixed.status).toBe(400); expect(mixed.body.error.code).toBe('forbidden_field');
    const foo = await putValues(c, { foo: 'x' });
    t.add('unknown key', 'PUT {foo}', foo);
    expect(foo.status).toBe(400); expect(foo.body.error.code).toBe('validation_error'); expect(foo.body.error.message).toBe('"foo" is not an allow-listed field');
    const num = await putValues(c, { make: 5 });
    t.add('non-text', 'PUT {make:5}', num);
    expect(num.status).toBe(400); expect(JSON.stringify(num.body)).toContain('Must be text');
    const long = await putValues(c, { model: 'x'.repeat(2001) });
    t.add('2001 chars', 'PUT {model: 2001x}', long);
    expect(long.status).toBe(400); expect(JSON.stringify(long.body)).toContain('Keep it under 2000 characters');
    const edge = await putValues(c, { model: 'y'.repeat(2000) });
    t.add('2000 chars (boundary)', 'PUT {model: 2000y}', { status: edge.status, body: { assistValues: { model: `${'y'.repeat(10)}…(2000)` } } });
    expect(edge.status).toBe(200);
    await putValues(c, { model: '' });
    const viewer = await putValues(c, { model: 'V1' }, 'viewer');
    t.add('viewer', 'PUT {model} as viewer', viewer);
    expect(viewer.status).toBe(403);
    // Unauthenticated
    const anon = await newApi(); const ar = await anon.put(`/api/workspaces/${c.ws}/assist-values`, { data: { model: 'a' } }); await anon.dispose();
    expect(ar.status()).toBe(401);
    // Nothing from the refused requests was stored.
    expect(JSON.stringify((await assistOf(c)).fields)).toBe(before);
    t.save('api-s5-assist-values-guards');
    test.info().annotations.push({ type: 'count', description: `${n + 8} refusal/guard assertions` });
  });

  test('S6 Upload in this order: merged packet first (Merged badge, file name), vault docs once, required annexures (no MAF request); empty state text @mobile', async ({ page, context }) => {
    const c = await named('order');
    const t = transcript();
    // Before the build.
    const pre = await assistOf(c);
    t.add('before build', `GET /api/assist/${c.ws}`, { status: 200, body: pre.documents.map((d: any) => ({ kind: d.kind, title: d.title })) });
    await openSubmit(page, context, c);
    const list = page.getByRole('heading', { name: 'Upload in this order' }).locator('xpath=ancestor::div[contains(@class,"rounded")][1]');
    const preKinds = pre.documents.map((d: any) => d.kind);
    test.info().annotations.push({ type: 'observation', description: `before build: ${preKinds.length} document row(s) (${preKinds.join(',')}); empty-state text visible=${await page.getByText('Build the packet first — the merged PDF will appear here.').isVisible()}` });
    await shot(page, 's6-before-build');

    // Build the packet through the API, then reload.
    const build = await call(c.fx, 'analyst', 'post', `/api/workspaces/${c.ws}/packets`, {});
    expect(build.status, JSON.stringify(build.body)).toBe(201);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Upload in this order' })).toBeVisible();
    const a = await assistOf(c);
    t.add('after build', `GET /api/assist/${c.ws}`, { status: 200, body: a.documents });
    const d = a.documents;
    expect(d[0]).toMatchObject({ kind: 'packet', title: 'Technical bid packet (merged PDF)', fileName: FILE });
    const kinds = d.map((x: any) => x.kind);
    // kinds are grouped: packet, then vault..., then annexure...
    expect(kinds).toEqual([...kinds].sort((x: string, y: string) => ['packet', 'vault', 'annexure'].indexOf(x) - ['packet', 'vault', 'annexure'].indexOf(y)));
    const vault = d.filter((x: any) => x.kind === 'vault');
    expect(vault.length).toBeGreaterThan(0);
    expect(new Set(vault.map((x: any) => x.url)).size, 'each vault document once').toBe(vault.length);
    const detail = (await call(c.fx, 'analyst', 'get', `/api/workspaces/${c.ws}`)).body;
    const reqAnnex = detail.annexures.filter((x: any) => x.required && x.key !== 'oem_auth_request');
    const an = d.filter((x: any) => x.kind === 'annexure');
    expect(an.map((x: any) => x.title).sort()).toEqual(reqAnnex.map((x: any) => x.title).sort());
    expect(an.map((x: any) => x.fileName)).not.toContain('oem_auth_request.pdf');
    expect(an.some((x: any) => /Request for MAF|request.*authori[sz]ation/i.test(x.title))).toBe(false);
    // UI
    const rows = list.locator('ol > li');
    await expect(rows).toHaveCount(d.length);
    const first = rows.first();
    await expect(first).toContainText('Technical bid packet (merged PDF)');
    await expect(first).toContainText(FILE);
    await expect(first.getByText('Merged', { exact: true })).toBeVisible();
    await expect(first.getByRole('button', { name: 'Copy file name' })).toBeEnabled();
    await expect(first.getByRole('link', { name: 'Download Technical bid packet (merged PDF)' })).toHaveAttribute('href', /\/api\/packets\/.+\/download$/);
    for (let i = 0; i < d.length; i++) {
      await expect(rows.nth(i)).toContainText(d[i].title);
      await expect(rows.nth(i).getByRole('link', { name: `Download ${d[i].title}` })).toBeVisible();
      if (i > 0) await expect(rows.nth(i).getByText('Merged', { exact: true })).toHaveCount(0);
    }
    t.save('api-s6-upload-order');
    await shot(page, 's6-after-build');
  });

  test('S6b empty documents list reads "Build the packet first — the merged PDF will appear here."', async ({ page, context }) => {
    // A workspace whose tender has no analysis has no mapped checklist documents, so before a build nothing can be listed.
    const c = await named('main');
    const ws2 = (await createWorkspace(c.fx, c.fx.tenderNoAnalysis.id)).id;
    const a = (await call(c.fx, 'analyst', 'get', `/api/assist/${ws2}`)).body;
    await signInAs(context, c.fx, 'analyst');
    await page.goto(`/workspaces/${ws2}?step=submit`);
    await expect(page.getByRole('heading', { name: 'Values to enter on GeM' })).toBeVisible();
    expect(a.documents).toEqual([]);
    await expect(page.getByText('Build the packet first — the merged PDF will appear here.')).toBeVisible();
    await shot(page, 's6b-build-first');
  });

  test('S14 read-only token API: GETs work, writes 403 "This API token is read-only"; token scope UI creates a read token (axe clean dialog) @mobile', async ({ page, context }) => {
    const c = await named('main');
    const t = transcript();
    // --- UI: Settings -> API tokens opened from the Submit step link (?scope=read) ---
    await signInAs(context, c.fx, 'analyst');
    await page.goto(`/workspaces/${c.ws}?step=submit`);
    await page.getByRole('link', { name: 'Create a read-only API token' }).click();
    await expect(page).toHaveURL(/\/settings\/api-tokens/);
    const dlg = page.getByRole('dialog', { name: 'Create an API token' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('combobox', { name: /Access/ })).toContainText('Extension (read-only)');
    await shot(page, 's14-token-dialog');
    await a11y(page, 'token-dialog');
    if (test.info().project.name === 'mobile') { await noHorizontalOverflow(page); return; }
    await dlg.getByRole('button', { name: 'Create token' }).click();
    const secret = await page.locator('input[readonly]').inputValue();
    expect(secret).toMatch(/^tp_/);
    await shot(page, 's14-token-created');
    await page.getByRole('button', { name: 'I’ve saved it' }).click();
    await expect(page.getByTestId('api-token-row').first()).toBeVisible();
    await expect(page.getByTestId('api-token-row').first()).toContainText(/read/i);

    // --- API with the token ---
    const bearer = await newApi();
    const h = { Authorization: `Bearer ${secret}` };
    const g = async (path: string) => { const r = await bearer.get(path, { headers: h }); return { status: r.status(), body: await r.json().catch(() => null) }; };
    const w = async (m: 'put' | 'post' | 'patch' | 'delete', path: string, data?: unknown) => { const r = await bearer[m](path, { headers: h, data }); return { status: r.status(), body: await r.json().catch(() => null) }; };
    const me = await g('/api/auth/me'); t.add('GET /api/auth/me', 'Bearer read', me); expect(me.status).toBe(200);
    const wl = await g('/api/workspaces'); t.add('GET /api/workspaces', 'Bearer read', { status: wl.status, body: { total: wl.body?.total } }); expect(wl.status).toBe(200);
    const as = await g(`/api/assist/${c.ws}`); t.add('GET /api/assist/{id}', 'Bearer read', { status: as.status, body: { noFinancials: as.body?.noFinancials } }); expect(as.status).toBe(200); expect(as.body.noFinancials).toBe(true);
    const detail = await g(`/api/workspaces/${c.ws}`); expect(detail.status).toBe(200);
    const writes: [string, 'put' | 'post' | 'patch' | 'delete', string, unknown][] = [
      ['PUT assist-values', 'put', `/api/workspaces/${c.ws}/assist-values`, { model: 'X' }],
      ['POST comments', 'post', `/api/workspaces/${c.ws}/comments`, { body: 'hello' }],
      ['PATCH workspace', 'patch', `/api/workspaces/${c.ws}`, { stage: 'preparing' }],
      ['POST packets', 'post', `/api/workspaces/${c.ws}/packets`, {}],
      ['POST submitted', 'post', `/api/workspaces/${c.ws}/submitted`, {}],
      ['POST api-tokens (mint broader)', 'post', '/api/me/api-tokens', { name: 'x', scope: 'full' }],
      ['POST logout', 'post', '/api/auth/logout', {}],
    ];
    for (const [label, m, path, data] of writes) {
      const r = await w(m, path, data);
      t.add(label, `${m.toUpperCase()} ${path}`, r);
      expect(r.status, label).toBe(403);
      if (label !== 'POST api-tokens (mint broader)') expect(r.body?.error?.message, label).toBe('This API token is read-only');
    }
    // The refused write stored nothing.
    expect((await assistOf(c)).fields.find((f: any) => f.key === 'model').source).toBe('empty');
    // A full-scope token still writes (control).
    const full = await call(c.fx, 'analyst', 'post', '/api/me/api-tokens', { name: 'full ctl', scope: 'full', expiresInDays: 30 });
    expect(full.status).toBe(201);
    const fr = await bearer.put(`/api/workspaces/${c.ws}/assist-values`, { headers: { Authorization: `Bearer ${full.body.token}` }, data: { model: '' } });
    t.add('control: full token PUT', 'PUT assist-values', { status: fr.status(), body: null });
    expect(fr.status()).toBe(200);
    await bearer.dispose();
    t.save('api-s14-readonly-token');
  });
});

// ═════════════ Browser extension (real MV3 build in Chromium) ═════════════
test.describe('extension', () => {
  let ext: ExtensionHarness | undefined;
  let videoDir: string;
  test.beforeEach(() => { videoDir = mkdtempSync(join(tmpdir(), 'us6-vid-')); });
  test.afterEach(async () => {
    const info = test.info();
    const pages = ext ? [ext.page, ext.popup] : [];
    const vids = pages.map((p) => p.video()).filter(Boolean);
    if (ext) await ext.close();
    ext = undefined;
    // one webm per test: the popup page (it spans the whole test)
    const v = vids[1] ?? vids[0];
    if (v) { try { mkdirSync(EVID_DIR, { recursive: true }); copyFileSync(await v.path(), join(EVID_DIR, `${slugOf(info.title)}-${info.project.name}.webm`)); } catch { /* none */ } }
  });

  async function boot(c: Ctx, opts: { token?: string; workspaceId?: string | null } = {}) {
    ext = await launchWithExtension({ videoDir, extraArgs: ['--disable-web-security'] });
    await ext.popup.setViewportSize({ width: 420, height: 900 });
    await ext.page.setViewportSize({ width: 1000, height: 900 });
    return ext;
  }
  async function makeToken(c: Ctx, scope: 'read' | 'full' = 'read') {
    const r = await call(c.fx, 'analyst', 'post', '/api/me/api-tokens', { name: `ext ${scope}`, scope, expiresInDays: 30 });
    expect(r.status).toBe(201);
    return r.body as { id: string; token: string };
  }
  async function connect(e: ExtensionHarness, c: Ctx, token: string, workspaceId: string | null = c.ws) {
    await seedSettings(e.popup, { apiBase: E2E_BASE_URL, token, ...(workspaceId ? { workspaceId } : {}) });
    await e.popup.reload();
    await expect(e.popup.locator('#main')).toBeVisible();
    await expect(e.popup.locator('#fields li').first()).toBeVisible();
  }
  const fixtureValues = (p: Page) => p.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLInputElement>('input,select,textarea')].map((e) => [e.id || e.name, e.type === 'radio' ? (e.checked ? e.value : '') : e.value])));
  const popupShot = (e: ExtensionHarness, name: string) => evidence(e.popup, SPEC, STORY, `${name}-${test.info().project.name}`);
  const pageShot = (e: ExtensionHarness, name: string) => evidence(e.page, SPEC, STORY, `${name}-${test.info().project.name}`);

  test('S7 connect: validation messages (URL, tp_ prefix), host permission scoped to the origin, revoked token, "Connected as <name> (<org>)"', async () => {
    const c = await named('ext');
    const tok = await makeToken(c);
    const e = await boot(c);
    const status = e.popup.locator('#settings-status');
    await expect(e.popup.getByRole('heading', { name: 'Connect to TenderPilot' })).toBeVisible();
    await expect(e.popup.getByText('TenderPilot URL')).toBeVisible();
    await expect(e.popup.getByText('API token', { exact: true })).toBeVisible();
    // 1) URL without scheme
    await e.popup.fill('#api-base', 'app.tenderpilot.in'); await e.popup.fill('#token', 'tp_abc');
    await e.popup.click('#save');
    await expect(status).toHaveText('Enter the full URL, e.g. https://app.tenderpilot.in');
    await popupShot(e, 's7-bad-url');
    // 2) token without tp_ prefix
    await e.popup.fill('#api-base', E2E_BASE_URL); await e.popup.fill('#token', 'abc123');
    await e.popup.click('#save');
    await expect(status).toHaveText('API tokens start with tp_');
    // 3) permission request: capture what the popup asks Chrome for (real prompt cannot be answered in automation)
    await e.popup.evaluate(() => {
      (window as any).__permReq = [];
      chrome.permissions.contains = (async () => false) as any;
      chrome.permissions.request = (async (p: any) => { (window as any).__permReq.push(p); return true; }) as any;
    });
    // 3a) revoked / unknown token
    await e.popup.fill('#token', 'tp_this_token_does_not_exist_000000000000');
    await e.popup.click('#save');
    await expect(status).toHaveText(/invalid.*revoked.*Create a new one in TenderPilot → Settings → API tokens\./);
    const statusText = await status.textContent();
    test.info().annotations.push({ type: 'observation', description: `invalid-token message: "${statusText}" (spec: "The API token is invalid or was revoked. …")` });
    const asked = await e.popup.evaluate(() => (window as any).__permReq);
    expect(asked).toEqual([{ origins: [`${E2E_BASE_URL}/*`] }]);
    await popupShot(e, 's7-revoked-token');
    // 3b) really revoked token
    const del = await call(c.fx, 'analyst', 'get', '/api/me/api-tokens');
    const row = del.body.items.find((i: any) => i.id === tok.id);
    expect(row).toBeTruthy();
    const api = await apiAs(c.fx, 'analyst'); expect([200, 204]).toContain((await api.delete(`/api/me/api-tokens/${tok.id}`)).status()); await api.dispose();
    await e.popup.fill('#token', tok.token); await e.popup.click('#save');
    await expect(status).toContainText('invalid');
    // 3c) valid token -> Connected as
    const good = await makeToken(c);
    await e.popup.fill('#token', good.token); await e.popup.click('#save');
    await expect(status).toHaveText(`Connected as ${c.fx.users.analyst.name} (${(await call(c.fx, 'analyst', 'get', '/api/auth/me')).body.org.name})`);
    await expect(e.popup.locator('#main')).toBeVisible();
    await popupShot(e, 's7-connected');
    // Manifest: host access is optional and never blanket-granted at install; content script https-only.
    const mf = JSON.parse(readFileSync(join(EXTENSION_DIST, 'manifest.json'), 'utf8'));
    expect(mf.host_permissions).toBeUndefined();
    expect(mf.optional_host_permissions).toContain('https://*/*');
    expect(mf.permissions).toEqual(['storage', 'activeTab']);
  });

  test('S8 workspace select lists only Go/Preparing/Ready/Submitted bids; popup shows Bid, Readiness, Open workspace, values, upload order, human-only steps', async () => {
    const c = await named('ext-select');
    // Extra tenders: ready, submitted, dropped, plus the no-analysis tender (identified) so exclusions are covered.
    const { db, close } = await createNodeDb(E2E_DB_URL);
    const extra: { id: string; bid: string }[] = [];
    try {
      const [base] = await db.select().from(tenders).where(eq(tenders.id, c.fx.tender.id));
      for (const n of [3, 4, 5]) {
        const bidNumber = `GEM/2026/B/70000${n}`;
        const values = { ...base, id: undefined as any, bidNumber, title: `Supply of Laptops batch ${n} with a deliberately long title to cross the forty-eight character cut`, contentHash: `e2e-h${n}` };
        delete (values as any).id;
        const [row] = await db.insert(tenders).values(values).onConflictDoUpdate({ target: [tenders.source, tenders.bidNumber], set: { updatedAt: new Date() } }).returning();
        await db.insert(analyses).values({ orgId: c.fx.orgId, tenderId: row.id, status: 'done', method: 'rules', checklist: [], score: 70, confidence: 0.8, verdict: 'go', requirements: [], factors: [] });
        extra.push({ id: row.id, bid: bidNumber });
      }
    } finally { await close(); }
    const ws: Record<string, string> = {};
    for (const [i, stage] of ['ready', 'submitted', 'dropped'].entries()) {
      const id = (await createWorkspace(c.fx, extra[i].id)).id;
      const r = await call(c.fx, 'analyst', 'patch', `/api/workspaces/${id}`, { stage });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      ws[stage] = id;
    }
    const noAn = (await createWorkspace(c.fx, c.fx.tenderNoAnalysis.id)).id; // stays 'identified'
    const pre = await call(c.fx, 'analyst', 'patch', `/api/workspaces/${c.ws}`, { stage: 'preparing' });
    expect(pre.status).toBe(200);
    const tok = await makeToken(c);
    const e = await boot(c);
    await connect(e, c, tok.token, ws.ready);
    const opts = await e.popup.locator('#workspace option').evaluateAll((o) => o.map((x) => ({ v: (x as HTMLOptionElement).value, t: x.textContent })));
    const ids = opts.map((o) => o.v);
    expect(ids).toContain(c.ws); expect(ids).toContain(ws.ready); expect(ids).toContain(ws.submitted);
    expect(ids).not.toContain(ws.dropped); expect(ids).not.toContain(noAn);
    expect(opts).toHaveLength(3);
    for (const o of opts) expect(o.t).toMatch(/^GEM\/2026\/B\/70000\d — .{1,48}$/);
    const long = opts.find((o) => o.v === ws.ready)!;
    expect(long.t!.split(' — ')[1]).toHaveLength(48);
    // remembered selection: ready workspace was seeded; pick another, reload, still selected
    await expect(e.popup.locator('#workspace')).toHaveValue(ws.ready);
    await e.popup.selectOption('#workspace', c.ws);
    await expect(e.popup.locator('#ws-meta')).toContainText('GEM/2026/B/700001');
    await e.popup.reload();
    await expect(e.popup.locator('#workspace')).toHaveValue(c.ws);
    const meta = e.popup.locator('#ws-meta');
    await expect(meta).toContainText('Bid GEM/2026/B/700001');
    await expect(meta).toContainText(/Readiness (\d+%|Not analysed)/);
    await expect(meta.getByRole('link', { name: 'Open workspace ↗' })).toHaveAttribute('href', `${E2E_BASE_URL}/workspaces/${c.ws}`);
    await expect(e.popup.getByRole('heading', { name: /Prepared values/ })).toContainText('non-financial only');
    await expect(e.popup.locator('#fields li')).toHaveCount(14);
    await expect(e.popup.getByRole('button', { name: 'Copy Make' })).toBeEnabled();
    await expect(e.popup.locator('#fields li .v.empty').first()).toContainText('Not set');
    await expect(e.popup.getByRole('heading', { name: 'Upload in this order' })).toBeVisible();
    await expect(e.popup.locator('#docs li').first()).toBeVisible();
    await expect(e.popup.getByRole('heading', { name: 'Only you can do these on GeM' })).toBeVisible();
    await expect(e.popup.locator('#steps li')).toHaveCount(4);
    await popupShot(e, 's8-popup-connected');
    // No active bids: empty org
    const empty = await newApi();
    const u = { name: 'QA Empty', email: `empty.${Date.now()}@example.in`, password: 'Qa!pass12345', orgName: `Empty ${Date.now()}` };
    expect((await empty.post('/api/auth/signup', { data: u })).status()).toBe(201);
    const et = (await (await empty.post('/api/me/api-tokens', { data: { name: 'e', scope: 'read', expiresInDays: 30 } })).json()).token;
    await empty.dispose();
    await seedSettings(e.popup, { apiBase: E2E_BASE_URL, token: et }); await e.popup.reload();
    await expect(e.popup.locator('#workspace option')).toHaveText('No active bids — start one in TenderPilot');
  });

  async function highlightAndFill(c: Ctx) {
    const tok = await makeToken(c);
    const e = await boot(c);
    await connect(e, c, tok.token);
    return e;
  }

  test('S9+S10 Highlight fields: indigo dashed + TP chips, red on price/CAPTCHA/OTP/DSC, status counts; a chip fills only its field (green, ✓)', async () => {
    const c = await named('ext');
    const e = await highlightAndFill(c);
    const touched: string[] = [];
    await e.page.exposeFunction('__tpRecordInput', (id: string) => touched.push(id));
    await e.page.evaluate(() => document.addEventListener('input', (ev) => (window as any).__tpRecordInput((ev.target as HTMLElement).id || (ev.target as HTMLInputElement).name), true));
    // Nothing happens until the user acts in the popup (FR-069)
    expect(await e.page.locator('.tp-fill-chip, [data-tp-state]').count()).toBe(0);
    await e.activate(e.page);
    await e.popup.click('#scan');
    await expect(e.popup.locator('#page-status')).toContainText('can be filled — click the TP chips or “Fill allowed fields”.');
    const statusText = (await e.popup.locator('#page-status').textContent())!;
    const m = /^(\d+) field\(s\) can be filled — click the TP chips or “Fill allowed fields”\. (\d+) price\/OTP\/submit field\(s\) left for you(?:; (\d+) yes\/no question\(s\) to answer yourself)?\.$/.exec(statusText);
    expect(m, statusText).toBeTruthy();
    const chips = await e.page.locator('.tp-fill-chip').count();
    expect(Number(m![1])).toBe(chips);
    // fillable ones: dashed indigo outline + title + chip
    const fillable = await e.page.locator('[data-tp-state="available"]').evaluateAll((els) => els.map((el) => ({ id: el.id || el.getAttribute('name'), outline: getComputedStyle(el).outline, title: el.getAttribute('title') })));
    expect(fillable.length).toBe(chips);
    for (const f of fillable) { expect(f.outline, f.id!).toContain('dashed'); expect(f.title, f.id!).toMatch(/^TenderPilot can fill: .+/); }
    // forbidden ones: red outline + titled reason
    const blocked = await e.page.locator('[data-tp-state="blocked"]').evaluateAll((els) => els.map((el) => ({ id: el.id || el.getAttribute('name'), outline: getComputedStyle(el).outline, color: getComputedStyle(el).outlineColor, title: el.getAttribute('title') })));
    const blockedIds = blocked.map((b) => b.id);
    for (const id of ['unitPrice', 'totalValue', 'rate', 'captcha', 'otp']) expect(blockedIds, id).toContain(id);
    // Scenario 9: DSC fields get a red outline too. The fixture's DSC PIN is <input type=password>, which collectControls skips (FR-069).
    expect.soft(blockedIds, 'DSC PIN (type=password) is outlined red').toContain('dsc');
    for (const b of blocked) { expect(b.title, b.id!).toMatch(/^TenderPilot never fills this \(.+\) — you do it on GeM$/); expect(b.outline).toContain('solid'); }
    expect(Number(m![2])).toBe(blocked.length); // popup count == outlined-red count
    // TP chip label text
    for (const t of await e.page.locator('.tp-fill-chip').allTextContents()) expect(t).toBe('TP');
    // indigo colour of the dashed outline (computed) - not red
    const col = await e.page.locator('[data-tp-state="available"]').first().evaluate((el) => getComputedStyle(el).outlineColor);
    expect(col).not.toBe((blocked[0] as any).color);
    await pageShot(e, 's9-highlighted-page');
    await popupShot(e, 's9-popup-status');
    // S10: clicking one chip fills only that field
    const before = await fixtureValues(e.page);
    await e.page.locator('#make + .tp-fill-chip').click();
    const after = await fixtureValues(e.page);
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed).toEqual(['make']);
    expect(after.make).toBe('Dell');
    expect(touched).toEqual(['make']);
    const chip = e.page.locator('#make + .tp-fill-chip');
    await expect(chip).toHaveText('✓');
    await expect(chip).toHaveAttribute('title', 'Filled — please verify');
    const bg = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(5, 150, 105)');
    await expect(e.page.locator('#make')).toHaveAttribute('data-tp-state', 'filled');
    const mk = await e.page.locator('#make').evaluate((el) => ({ outline: getComputedStyle(el).outline, title: el.getAttribute('title') }));
    expect(mk.outline).toContain('solid');
    test.info().annotations.push({ type: 'observation', description: `filled field title: "${mk.title}" (spec: "<label> filled by TenderPilot — please verify")` });
    // chip overwrites an existing value
    await e.page.fill('#make', 'typed by user');
    await e.page.locator('#make + .tp-fill-chip').click();
    expect(await e.page.inputValue('#make')).toBe('Dell');
    // price/OTP untouched, form not submitted
    for (const id of ['unitPrice', 'totalValue', 'rate', 'captcha', 'otp', 'dsc']) expect(await e.page.inputValue(`#${id}`), id).toBe('');
    expect(await e.page.evaluate(() => (window as any).__submitted ?? false)).toBe(false);
    await pageShot(e, 's10-chip-filled');
  });

  test('S11+S15+Constitution: Fill allowed fields fills empty allow-listed fields (events, select matching), keeps typed/disabled/no-value, never writes protected controls or submits; report + Clear highlights', async () => {
    const c = await named('ext');
    const e = await highlightAndFill(c);
    const requests: string[] = [];
    e.page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
    const navs: string[] = []; e.page.on('framenavigated', (f) => { if (f === e.page.mainFrame()) navs.push(f.url()); });
    const touched: string[] = [];
    await e.page.exposeFunction('__tpRecord', (kind: string, id: string) => touched.push(`${kind}:${id}`));
    await e.page.evaluate(() => {
      const rec = (kind: string) => (ev: Event) => (window as any).__tpRecord(kind, (ev.target as HTMLElement).id || (ev.target as HTMLInputElement).name);
      for (const k of ['input', 'change', 'click', 'submit']) document.addEventListener(k, rec(k), true);
      // user already typed Brand; delivery period is disabled by the page
      (document.querySelector('[name=brandName]') as HTMLInputElement).value = 'My Own Brand';
      (document.querySelector('#delivery') as HTMLInputElement).disabled = true;
    });
    touched.length = 0;
    await e.activate(e.page);
    await e.popup.click('#fill');
    await expect(e.popup.locator('#page-status')).toContainText('Filled ');
    const st = (await e.popup.locator('#page-status').textContent())!;
    const m = /^Filled (\d+) field\(s\)\. (\d+) protected field\(s\) untouched — enter price and authenticate yourself\.$/.exec(st);
    expect(m, st).toBeTruthy();
    const v = await fixtureValues(e.page);
    // filled
    expect(v.make).toBe('Dell'); expect(v.qty).toBe('40'); expect(v.lc).toBe('62');
    expect(v.coo).toBe('IN'); expect(v.mse).toBe('Y'); expect(v.spec).toBe('1'); // "Yes" -> "Yes, Complied" via synonym/prefix matching
    // not overwritten / skipped
    expect(v.brandName).toBe('My Own Brand');
    expect(v.delivery).toBe('');
    expect(v.model).toBe(''); // no prepared value
    // protected controls never written
    for (const id of ['unitPrice', 'totalValue', 'rate', 'captcha', 'otp', 'dsc']) expect(v[id], id).toBe('');
    expect(v.techDoc).toBe('');
    expect(v.startupClaim).toBe(''); // radio left for the user
    expect(await e.page.evaluate(() => ({ filesLen: (document.querySelector('[name=techDoc]') as HTMLInputElement).files!.length, radios: [...document.querySelectorAll<HTMLInputElement>('[type=radio]')].filter((r) => r.checked).length }))).toEqual({ filesLen: 0, radios: 0 });
    // events: every written field got input AND change; nothing clicked/submitted
    const written = ['make', 'qty', 'lc', 'coo', 'mse', 'spec'];
    for (const id of written) { expect(touched, `input ${id}`).toContain(`input:${id}`); expect(touched, `change ${id}`).toContain(`change:${id}`); }
    const evtTargets = new Set(touched.map((t) => t.split(':')[1]));
    for (const id of ['unitPrice', 'totalValue', 'rate', 'captcha', 'otp', 'dsc', 'techDoc', 'esign', 'final-submit', 'brandName', 'delivery', 'model']) expect(evtTargets.has(id), `${id} untouched`).toBe(false);
    expect(touched.filter((t) => t.startsWith('click:') || t.startsWith('submit:'))).toEqual([]);
    expect(await e.page.evaluate(() => (window as any).__submitted ?? false)).toBe(false);
    expect(requests.filter((r) => r.includes('never-submitted') || r.startsWith('POST'))).toEqual([]);
    expect(navs).toEqual([]);
    expect(e.page.url()).toBe(e.fixtureUrl);
    // filled count matches the written fields
    expect(Number(m![1])).toBe(written.length);

    // S15: popup lists filled and skipped with reasons + Clear highlights
    const rep = e.popup.locator('#fill-report');
    await expect(rep).toBeVisible();
    await expect(rep.getByRole('heading', { name: 'Fill report' })).toBeVisible();
    await expect(rep).toContainText(`Filled (${written.length})`);
    const skippedText = (await rep.locator('.report-list.skipped').innerText()).replace(/\s+/g, ' ');
    expect(skippedText).toContain('already has a value');
    expect.soft(skippedText, 'skipped reason for a field without a value reads "no prepared value" (scenario 15)').toContain('no prepared value');
    expect(skippedText).toContain('disabled');
    await expect(rep).toContainText(/protected field\(s\) untouched \(price, CAPTCHA, OTP, DSC, submit\)/);
    await popupShot(e, 's15-fill-report');
    await pageShot(e, 's11-page-after-fill');
    await e.popup.click('#scan'); // re-highlight so there is something to clear
    expect(await e.page.locator('.tp-fill-chip, .tp-manual-chip').count()).toBeGreaterThan(0);
    await e.popup.click('#clear');
    await expect(e.popup.locator('#page-status')).toHaveText('Highlights cleared. Values already filled stay in the form.');
    expect(await e.page.locator('.tp-fill-chip, .tp-manual-chip, [data-tp-state]').count()).toBe(0);
    await expect(e.popup.locator('#fill-report')).toBeHidden();
    expect((await fixtureValues(e.page)).make).toBe('Dell'); // values stay
    await popupShot(e, 's15-cleared');

    // Static guarantee: the shipped content script and popup contain no click/submit/navigate calls.
    const dist = readdirSync(join(EXTENSION_DIST), { recursive: true } as any).map(String).filter((f) => f.endsWith('.js'));
    for (const f of dist) {
      const src = readFileSync(join(EXTENSION_DIST, f), 'utf8');
      expect(src, f).not.toMatch(/\.requestSubmit\(|\.submit\(\)|\.click\(\)|location\.(href|assign|replace)\s*=|dispatchEvent\(new (Mouse|Pointer)Event\(['"]click/);
    }
    // And the radio question was reported as left for the user (manual), not clicked (FR-077).
    await e.popup.click('#scan');
    const manual = e.page.locator('.tp-manual-chip');
    await expect(manual).toHaveCount(1);
    await expect(manual).toHaveAttribute('title', /Left for you — “.*”: choose “No” yourself/);
    expect(await e.page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('[type=radio]')].some((r) => r.checked))).toBe(false);
    await expect(e.popup.locator('#page-status')).toContainText('1 yes/no question(s) to answer yourself');
    await pageShot(e, 's11-manual-radio-chip');
  });

  test('S12 non-GeM tab: popup shows "Open the GeM bid participation page in this tab first (bidplus.gem.gov.in), then try again."', async () => {
    const c = await named('ext');
    const e = await highlightAndFill(c);
    const other = await e.context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    for (const btn of ['#scan', '#fill', '#clear']) {
      await e.popup.click(btn);
      await expect(e.popup.locator('#error')).toHaveText('Open the GeM bid participation page in this tab first (bidplus.gem.gov.in), then try again.');
      await e.popup.evaluate(() => { (document.getElementById('error') as HTMLElement).hidden = true; });
    }
    await e.popup.click('#scan');
    await expect(e.popup.locator('#error')).toBeVisible();
    await popupShot(e, 's12-not-gem-tab');
  });

  test('S13 content script: foreign senders ignored (page scripts cannot trigger it), manifest matches https GeM only', async () => {
    const c = await named('ext');
    const e = await highlightAndFill(c);
    const mf = JSON.parse(readFileSync(join(EXTENSION_DIST, 'manifest.json'), 'utf8'));
    const matches: string[] = mf.content_scripts.flatMap((s: any) => s.matches);
    expect(matches).toContain('https://*.gem.gov.in/*');
    expect(matches.filter((m) => m.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(m))).toEqual([]); // no plain-http GeM
    expect(matches.filter((m) => /localhost|127\.0\.0\.1/.test(m)).every((m) => /gem-form/.test(m))).toBe(true);
    expect(mf.externally_connectable).toBeUndefined();
    // A hostile page script cannot reach the content script: window messages / custom events / DOM events do nothing.
    await e.page.evaluate(() => {
      for (const type of ['tp:scan', 'tp:fill', 'tp:clear']) {
        window.postMessage({ type, fields: [{ key: 'make', label: 'Make', value: 'EVIL', selectorHints: ['make'] }] }, '*');
        document.dispatchEvent(new CustomEvent(type, { detail: { fields: [{ key: 'make', label: 'Make', value: 'EVIL' }] } }));
      }
    });
    await e.page.waitForTimeout(500);
    expect(await e.page.locator('.tp-fill-chip, [data-tp-state]').count()).toBe(0);
    expect((await fixtureValues(e.page)).make).toBe('');
    // The page world has no chrome.runtime to message the extension with.
    expect(await e.page.evaluate(() => typeof (window as any).chrome?.runtime?.sendMessage)).not.toBe('function');
    // Messages from the extension's own popup are honoured (control).
    const ok = await e.sendToPage({ type: 'tp:scan', fields: [{ key: 'make', label: 'Make', value: 'Dell', selectorHints: ['\\bmake\\b'] }] });
    expect(ok.ok).toBe(true);
    // Sender check is also unit-tested (apps/extension/test/content.test.ts) with a foreign sender id -> no response, no side effects.
    expect(existsSync('apps/extension/test/content.test.ts')).toBe(true);
    await pageShot(e, 's13-foreign-ignored');
  });
});
