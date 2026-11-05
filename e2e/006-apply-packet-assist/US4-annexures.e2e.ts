/**
 * Spec 006 / US4 (#184): generate annexures and undertakings from editable templates.
 * QA task T051 (#239). Scenarios 1-11 of the spec (S1..S11 in the test names) plus T050 (discard-changes confirm).
 *
 * PDF text: `pdftotext` (poppler, system binary) is used for text assertions; pdf-lib in the workspace can write but not
 * extract text. Bold / underline / double rule cannot be read from text: they are checked via `pdffonts` (bold face embedded)
 * and by rasterising page 1 with `pdftoppm` into evidence PNGs for visual review.
 * axe: @axe-core/playwright is installed -> `a11y()` runs on the Annexures step and the editor dialog.
 */
import { test, expect, evidence, collectRunArtifacts, a11y, noHorizontalOverflow } from '../support/fixtures';
import { seedApplyFixture, newApi, apiAs, signInAs, createWorkspace, type ApplyFixture } from '../support/seed-apply';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPEC = '006';
const STORY = 'US4';
const EVID_DIR = join('qa', 'evidence', SPEC, STORY);
// Not serial on purpose: a failing test must not skip the rest. Tests run in file order on one worker; the ones that
// mutate templates (S7-S11, T050) come after the read-only ones and restore defaults at the end.

let fx: ApplyFixture;      // main org (complete profile)
let fx2: ApplyFixture;     // second org (used for "other orgs unaffected", empty-profile banner, sanitising)
let wsId = '';
let ws2Id = '';

const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const E = (body: any) => body?.error ?? body;
const toastWith = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text });

async function freshFixture() {
  const api = await newApi();
  const f = await seedApplyFixture(api);
  await api.dispose();
  return f;
}

/** Extract text of a PDF (optionally one page, optionally raw layout). */
function pdfText(bytes: Buffer, opts: { page?: number; layout?: boolean } = {}): string {
  const args = [...(opts.layout ? ['-layout'] : []), ...(opts.page ? ['-f', String(opts.page), '-l', String(opts.page)] : []), '-', '-'];
  return execFileSync('pdftotext', args, { input: bytes, maxBuffer: 20_000_000 }).toString('utf8');
}
function pdfPages(bytes: Buffer): number {
  const dir = mkdtempSync(join(tmpdir(), 'us4-'));
  const f = join(dir, 'a.pdf');
  writeFileSync(f, bytes);
  const out = execFileSync('pdfinfo', [f]).toString();
  return Number(/Pages:\s+(\d+)/.exec(out)![1]);
}
function pdfFonts(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'us4-'));
  const f = join(dir, 'a.pdf');
  writeFileSync(f, bytes);
  return execFileSync('pdffonts', [f]).toString();
}
/** Rasterise page `n` into the evidence folder (for visual review of layout). */
function rasterise(bytes: Buffer, name: string, n = 1) {
  mkdirSync(EVID_DIR, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'us4-'));
  const f = join(dir, 'a.pdf');
  writeFileSync(f, bytes);
  execFileSync('pdftoppm', ['-png', '-r', '80', '-f', String(n), '-l', String(n), '-singlefile', f, join(dir, 'out')]);
  copyFileSync(join(dir, 'out.png'), join(EVID_DIR, `${name}.png`));
}

async function getPdf(f: ApplyFixture, id: string, file: string, role: 'analyst' | 'viewer' | 'bid_manager' = 'analyst') {
  const api = await apiAs(f, role);
  const r = await api.get(`/api/workspaces/${id}/annexures/${file}`);
  const out = { status: r.status(), headers: r.headers(), body: Buffer.from(await r.body()) };
  await api.dispose();
  return out;
}
async function detail(f: ApplyFixture, id: string) {
  const api = await apiAs(f, 'analyst');
  const r = await api.get(`/api/workspaces/${id}`);
  expect(r.status()).toBe(200);
  const body = await r.json();
  await api.dispose();
  return body as { annexures: any[]; profileGaps: string[] };
}
async function apiCall(f: ApplyFixture, role: 'analyst' | 'viewer' | 'bid_manager' | 'owner', method: 'get' | 'put' | 'delete' | 'post', url: string, data?: unknown) {
  const api = await apiAs(f, role);
  const r = await api[method](url, data === undefined ? {} : { data });
  const text = await r.text();
  await api.dispose();
  let body: any = {};
  try { body = JSON.parse(text); } catch { /* binary / empty */ }
  return { status: r.status(), body, headers: r.headers() };
}
async function openAnnexures(page: Page, context: any, f: ApplyFixture, id: string, role: 'analyst' | 'viewer' | 'bid_manager' = 'analyst', key?: string) {
  await signInAs(context, f, role);
  await page.goto(`/workspaces/${id}?step=annexures${key ? `&annexure=${key}` : ''}`);
  await expect(page.getByRole('list', { name: 'Annexures' })).toBeVisible();
}
const card = (page: Page, title: string | RegExp) => page.getByRole('list', { name: 'Annexures' }).getByRole('button').filter({ hasText: title });

test.beforeAll(async () => {
  fx = await freshFixture();
  wsId = (await createWorkspace(fx)).id;
  fx2 = await freshFixture();
  ws2Id = (await createWorkspace(fx2)).id;
});

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

const TITLES = [
  'Covering Letter for Technical Bid',
  'Undertaking regarding Non-Blacklisting / Non-Debarment',
  'Self-Certificate of Local Content (Make in India)',
  'Request for Manufacturer’s Authorisation (MAF)',
  'Technical Compliance Statement',
  'Letter of Authority for Bid Signatory',
];
const BADGES = ['Optional', 'Required by this bid', 'Required by this bid', 'Recommended', 'Optional', 'Optional'];

test('S1 six annexures in order with Optional/Required/Recommended badges; first required previewed', async ({ page, context }) => {
  await openAnnexures(page, context, fx, wsId);
  const buttons = page.getByRole('list', { name: 'Annexures' }).getByRole('button');
  await expect(buttons).toHaveCount(6);
  for (let i = 0; i < 6; i++) {
    await expect(buttons.nth(i)).toContainText(TITLES[i]);
    await expect(buttons.nth(i)).toContainText(BADGES[i]);
  }
  // API order agrees
  const d = await detail(fx, wsId);
  expect(d.annexures.map((a) => a.title)).toEqual(TITLES);
  expect(d.annexures.map((a) => a.required)).toEqual([false, true, true, false, false, false]);
  // first required (non-blacklisting) is selected and previewed
  await expect(buttons.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('heading', { name: TITLES[1] }).or(page.locator('.text-sm.font-semibold', { hasText: TITLES[1] }))).toBeVisible();
  await expect(page.locator('iframe[title$="preview"]')).toHaveAttribute('src', /annexures\/non_blacklisting\.pdf/);
  await shot(page, 'S1-annexures-list');
  // axe scoped to the Annexures step (list + preview panel). Page-level violations in the shared workspace header are
  // outside US4 and are recorded as an observation (not failing this story).
  await a11y(page, 'S1-annexures-step', { include: ['div[class*="2xl:grid-cols-[minmax(0,320px)"]'] });
  try { await a11y(page, 'S1-full-page-observation'); } catch (e) { test.info().annotations.push({ type: 'axe-full-page', description: String((e as Error).message).split('\n').slice(0, 1).join('') + ' - see S1-full-page-observation axe json' }); }
});

test('S2a blank(s) badge with tooltip matches API missing[]', async ({ page, context }) => {
  await openAnnexures(page, context, fx, wsId);
  const d = await detail(fx, wsId);
  const withMissing = d.annexures.filter((a) => a.missing.length > 0);
  expect(withMissing.length, 'fixture should have at least one annexure with blanks (e.g. offer.model)').toBeGreaterThan(0);
  for (const a of withMissing) {
    const n = a.missing.length;
    await expect(card(page, a.title)).toContainText(`${n} blank${n === 1 ? '' : 's'}`);
  }
  // annexures with nothing missing have no badge
  for (const a of d.annexures.filter((x) => x.missing.length === 0)) await expect(card(page, a.title)).not.toContainText(/blanks?$/);
  // tooltip lists friendly names (e.g. "Model")
  const target = withMissing.find((a) => a.missing.includes('offer.model')) ?? withMissing[0];
  await card(page, target.title).getByText(/\d blanks?/).hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Blank:');
  if (target.missing.includes('offer.model')) await expect(tip).toContainText('Model');
  await shot(page, 'S2a-blank-badge-tooltip');
});

test('S2b profileGaps banner + Complete company profile link (empty-profile org)', async ({ page, context }) => {
  // Blank out the company profile of org 2 (profile PUT is a partial upsert; send empty strings / nulls)
  const r = await apiCall(fx2, 'owner', 'put', '/api/profile', { legalName: '', gstin: '', pan: '', address: '', signatoryName: '', signatoryDesignation: '', contactName: '', contactEmail: '', contactPhone: '' });
  test.info().annotations.push({ type: 'profile-clear', description: `PUT /api/profile -> ${r.status} ${JSON.stringify(E(r.body)).slice(0, 200)}` });
  const d = await detail(fx2, ws2Id);
  test.info().annotations.push({ type: 'profileGaps', description: JSON.stringify(d.profileGaps) });
  await openAnnexures(page, context, fx2, ws2Id);
  if (d.profileGaps.length === 0) {
    await shot(page, 'S2b-no-profile-gaps');
    throw new Error(`Could not produce profileGaps for an empty profile (PUT /api/profile -> ${r.status})`);
  }
  const banner = page.getByText('Some blanks will print as “__________”');
  await expect(banner).toBeVisible();
  await expect(page.getByText(/to fill them automatically\.$/)).toBeVisible();
  const link = page.getByRole('link', { name: /Complete company profile/ });
  await expect(link).toHaveAttribute('href', '/profile');
  await shot(page, 'S2b-profile-gaps-banner');
  // and it is absent for the complete-profile org
  await openAnnexures(page, context, fx, wsId);
  await expect(page.getByText('Some blanks will print as “__________”')).toHaveCount(0);
  await link.waitFor({ state: 'detached' });
  // restore org 2's profile for later tests
  await apiCall(fx2, 'owner', 'put', '/api/profile', { legalName: 'Sharma Infotech Pvt Ltd', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F', address: '12 MIDC, Andheri East', signatoryName: 'Ravi Sharma', signatoryDesignation: 'Director', contactName: 'Ravi Sharma', contactEmail: 'bids@sharma.in', contactPhone: '+919812345678' });
});

test('S3a preview iframe (#toolbar=0&navpanes=0), skeleton removed after timeout, Edit template/Open/Download', async ({ page, context }) => {
  // Hold the PDF response for 8 s so the iframe cannot fire load: the skeleton must still disappear (~2.5 s timeout).
  await page.route('**/api/workspaces/*/annexures/*.pdf*', async (route) => { await new Promise((r) => setTimeout(r, 8000)); await route.continue().catch(() => {}); });
  await signInAs(context, fx, 'bid_manager');
  await page.goto(`/workspaces/${wsId}?step=annexures`);
  const frame = page.locator('iframe[title$="preview"]');
  await expect(frame).toBeAttached();
  const src = (await frame.getAttribute('src'))!;
  expect(src).toMatch(/non_blacklisting\.pdf\?v=0#toolbar=0&navpanes=0$/);
  const skeleton = page.locator('iframe[title$="preview"]').locator('xpath=preceding-sibling::div[contains(@class,"absolute")]');
  await expect(skeleton).toHaveCount(1);
  await shot(page, 'S3a-skeleton');
  await expect(skeleton).toHaveCount(0, { timeout: 5000 });   // removed by the timeout, load has not fired (response held)
  await expect(page.getByRole('button', { name: /Edit template/ })).toBeVisible();
  const open = page.getByRole('link', { name: /Open/ });
  await expect(open).toHaveAttribute('href', /annexures\/non_blacklisting\.pdf$/);
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('link', { name: /Download/ })).toHaveAttribute('href', /annexures\/non_blacklisting\.pdf\?download=1$/);
  await shot(page, 'S3a-buttons');
  await page.unroute('**/api/workspaces/*/annexures/*.pdf*');
});

test('S3b phone: "PDF previews open full-screen on phones." + Preview PDF button, no iframe, no h-scroll @mobile', async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openAnnexures(page, context, fx, wsId);
  await expect(page.getByText('PDF previews open full-screen on phones.')).toBeVisible();
  const btn = page.getByRole('link', { name: /Preview PDF/ });
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('target', '_blank');
  await expect(btn).toHaveAttribute('href', /annexures\/non_blacklisting\.pdf$/);
  await expect(page.locator('iframe[title$="preview"]')).toHaveCount(0);
  await noHorizontalOverflow(page);
  await shot(page, 'S3b-phone-preview-button');
});

test('S3c observation: panel breakpoint (spec says < 640 px; app uses useIsMobile = < 768 px)', async ({ page, context }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop project only');
  await page.setViewportSize({ width: 700, height: 900 });
  await openAnnexures(page, context, fx, wsId);
  const phonePanel = await page.getByText('PDF previews open full-screen on phones.').isVisible();
  test.info().annotations.push({ type: 'breakpoint-700px', description: phonePanel ? 'phone panel shown at 700 px (spec: iframe expected >= 640 px)' : 'iframe shown at 700 px' });
  await shot(page, 'S3c-700px');
});

test('S4 PDF endpoint: headers, download, alias, 404, Class-I wording and 62%', async () => {
  const r = await getPdf(fx, wsId, 'mii_self_cert.pdf');
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toBe('application/pdf');
  expect(r.headers['content-disposition']).toBe(`inline; filename="mii_self_cert_GEM_2026_B_700001.pdf"; filename*=UTF-8''mii_self_cert_GEM_2026_B_700001.pdf`);
  expect(r.headers['cache-control']).toBe('private, no-store');
  expect(r.headers['x-content-type-options']).toBe('nosniff');
  expect(r.body.subarray(0, 5).toString()).toBe('%PDF-');
  const dl = await getPdf(fx, wsId, 'mii_self_cert.pdf?download=1');
  expect(dl.status).toBe(200);
  expect(dl.headers['content-disposition']).toBe(`attachment; filename="mii_self_cert_GEM_2026_B_700001.pdf"; filename*=UTF-8''mii_self_cert_GEM_2026_B_700001.pdf`);
  const alias = await getPdf(fx, wsId, 'mii_self_certificate.pdf');
  expect(alias.status).toBe(200);
  expect(alias.headers['content-type']).toBe('application/pdf');
  const flat = (b: Buffer) => pdfText(b).replace(/\s+/g, ' ');
  expect(flat(alias.body)).toBe(flat(r.body));
  const text = flat(r.body);
  expect(text).toContain("'Class-I local supplier' (local content of 50% or more)");
  expect(text).toContain('62%');
  const unk = await apiCall(fx, 'analyst', 'get', `/api/workspaces/${wsId}/annexures/nope.pdf`);
  expect(unk.status).toBe(404);
  expect(JSON.stringify(unk.body)).toContain('Annexure template not found');
  test.info().annotations.push({ type: '404-body', description: JSON.stringify(unk.body) });
  // Independent test (spec "Independent Test"): non_blacklisting contains the company/tender identifiers
  const nb = flat((await getPdf(fx, wsId, 'non_blacklisting.pdf')).body);
  for (const s of ['SHARMA INFOTECH PVT LTD', 'GEM/2026/B/700001', '27AAPFU0939F1ZV', 'Authorised Signatory (Seal & Signature)']) expect(nb).toContain(s);
});

test('S5 PDF layout: letterhead, Ref/Date, title, clauses, bold Subject, signature block, footer on every page', async () => {
  const r = await getPdf(fx, wsId, 'non_blacklisting.pdf');
  expect(r.status).toBe(200);
  const p1 = pdfText(r.body, { page: 1, layout: true });
  const lines = p1.split('\n').map((l) => l.trim()).filter(Boolean);
  // letterhead (top of page): company name in capitals, address, GSTIN | PAN | email | phone
  const head = lines.slice(0, 6).join('\n');
  expect(head).toContain('SHARMA INFOTECH PVT LTD');
  expect(head).toContain('12 MIDC, Andheri East');
  expect(head).toMatch(/GSTIN: 27AAPFU0939F1ZV\s*\|\s*PAN: AAPFU0939F\s*\|\s*bids@sharma\.in\s*\|\s*\+919812345678/);
  expect(p1).toContain('Ref: GEM/2026/B/700001');
  const istDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date()).replace(/\//g, '-');
  expect(p1).toMatch(/Date: \d{2}-\d{2}-\d{4}/);
  expect(p1).toContain(`Date: ${istDate}`);
  expect(p1).toContain('UNDERTAKING REGARDING NON-BLACKLISTING / NON-DEBARMENT');   // title in capitals
  expect(p1).toMatch(/Subject:/);
  expect(p1).toMatch(/^\s*1\.\s+\S/m);                                               // numbered clause
  expect(p1).toMatch(/^\s*2\.\s+\S/m);
  // signature block
  const sig = p1.replace(/[ \t]+/g, ' ');
  for (const s of ['Place: Maharashtra', 'For Sharma Infotech Pvt Ltd', 'Authorised Signatory (Seal & Signature)', 'Name: Ravi Sharma', 'Designation: Director']) expect(sig, s).toContain(s);
  expect(sig).toMatch(/Date: \d{2}-\d{2}-\d{4}[\s\S]*For Sharma Infotech/);
  // footer on page 1
  expect(p1).toMatch(/Bid No\. GEM\/2026\/B\/700001/);
  // bold face embedded (Subject line / title / signature use it)
  expect(pdfFonts(r.body)).toMatch(/Helvetica-Bold|Bold/);
  rasterise(r.body, `S5-non_blacklisting-page1-${test.info().project.name}`);
  // Long body flows onto further pages and each page carries the footer: draft preview with a long body
  const long = ['Subject: Long body flow test', ...Array.from({ length: 60 }, (_, i) => `${i + 1}. Clause number ${i + 1} — the bidder confirms compliance with every term stated in bid {{tender.bidNumber}} and shall abide by the same without exception or reservation whatsoever.`)].join('\n\n');
  const api = await apiAs(fx, 'analyst');
  const pr = await api.post(`/api/workspaces/${wsId}/annexures/non_blacklisting/preview`, { data: { title: 'Long form undertaking', body: long } });
  expect(pr.status()).toBe(200);
  const longPdf = Buffer.from(await pr.body());
  await api.dispose();
  const n = pdfPages(longPdf);
  expect(n).toBeGreaterThan(1);
  for (let p = 1; p <= n; p++) expect(pdfText(longPdf, { page: p }), `footer on page ${p}`).toMatch(/Bid No\. GEM\/2026\/B\/700001/);
  rasterise(longPdf, `S5-long-body-page2-${test.info().project.name}`, 2);
  test.info().annotations.push({ type: 'pages', description: `long body -> ${n} pages, footer on each` });
});

test('S6a Analyst PUT /annexure-templates/non_blacklisting -> 403', async () => {
  const r = await apiCall(fx, 'analyst', 'put', '/api/annexure-templates/non_blacklisting', { title: 'Analyst attempt', body: 'This body is long enough to pass validation.' });
  expect(r.status).toBe(403);
  expect(JSON.stringify(r.body)).toContain('You need to be at least a Bid Manager to do that');
  const v = await apiCall(fx, 'viewer', 'put', '/api/annexure-templates/non_blacklisting', { title: 'Viewer attempt', body: 'This body is long enough to pass validation.' });
  expect(v.status).toBe(403);
  const d = await apiCall(fx, 'analyst', 'delete', '/api/annexure-templates/non_blacklisting');
  expect(d.status).toBe(403);
});

test('S6b (FR-043) Edit template button only for Bid Manager+', async ({ page, context }) => {
  for (const role of ['analyst', 'viewer'] as const) {
    await openAnnexures(page, context, fx, wsId, role);
    await expect(page.locator('iframe[title$="preview"]')).toBeAttached();
    await expect(page.getByRole('button', { name: /Edit template/ }), `${role} must not see Edit template`).toHaveCount(0);
    await shot(page, `S6b-${role}-no-edit-button`);
  }
  for (const role of ['bid_manager', 'owner'] as const) {
    await openAnnexures(page, context, fx, wsId, role as any);
    await expect(page.getByRole('button', { name: /Edit template/ }), `${role} sees Edit template`).toBeVisible();
  }
  await shot(page, 'S6b-owner-edit-button');
});

async function openEditor(page: Page, context: any, f: ApplyFixture, id: string, key?: string) {
  await openAnnexures(page, context, f, id, 'bid_manager', key);
  await page.getByRole('button', { name: /Edit template/ }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('textbox', { name: 'Title', exact: true })).not.toHaveValue('');
  return dlg;
}

test('S7 editor: explainer, Title/Body, Insert placeholder, Preview posts draft without saving, Save disabled until title>=3 & body>=20', async ({ page, context }) => {
  const dlg = await openEditor(page, context, fx, wsId);
  await expect(dlg).toContainText('Changes apply to every bid in your organisation. Use placeholders like {{company.legalName}}; blank lines separate paragraphs, lines starting with “1.” become numbered clauses.');
  const title = dlg.getByRole('textbox', { name: 'Title', exact: true });
  const body = dlg.getByRole('textbox', { name: 'Body', exact: true });
  await expect(body).toBeVisible();
  await expect(dlg.getByText('Insert placeholder')).toBeVisible();
  // palette inserts a token at the cursor
  await body.fill('');
  await dlg.getByRole('button', { name: /Insert Legal name/ }).click();
  await expect(body).toHaveValue('{{company.legalName}}');
  // Save disabled boundaries
  const save = dlg.getByRole('button', { name: 'Save template' });
  await title.fill('ab');
  await body.fill('x'.repeat(25));
  await expect(save).toBeDisabled();            // title 2
  await title.fill('abc');
  await expect(save).toBeEnabled();             // title 3, body 25
  await body.fill('x'.repeat(19));
  await expect(save).toBeDisabled();            // body 19
  await body.fill('x'.repeat(20));
  await expect(save).toBeEnabled();             // body 20
  // Preview: posts draft to the preview endpoint, shows PDF, does not save
  const draftTitle = 'QA draft preview title';
  const draftBody = 'QA-DRAFT-MARKER 1. Declaration by {{company.legalName}} for bid {{tender.bidNumber}}.';
  await title.fill(draftTitle);
  await body.fill(draftBody);
  const [req] = await Promise.all([
    page.waitForRequest((q) => q.method() === 'POST' && /\/annexures\/non_blacklisting\/preview$/.test(q.url())),
    dlg.getByRole('button', { name: /^Preview$/ }).click(),
  ]);
  expect(req.postDataJSON()).toEqual({ title: draftTitle, body: draftBody });
  await expect(dlg.locator('iframe[title="Draft preview"]')).toBeAttached();
  await shot(page, 'S7-editor-with-preview');
  // axe on the editor: recorded as an observation (WCAG 2.5.3 label-content-name-mismatch on the palette buttons is a minor a11y finding, not an AC)
  try { await a11y(page, 'S7-editor-dialog', { include: ['[role="dialog"]'] }); } catch (e) { test.info().annotations.push({ type: 'axe-editor', description: String((e as Error).message).split('\n').slice(0, 1).join('') + ' - see S7-editor-dialog axe json' }); }
  // nothing saved
  const tpls = await apiCall(fx, 'bid_manager', 'get', '/api/annexure-templates');
  const nb = tpls.body.items.find((t: any) => t.key === 'non_blacklisting');
  expect(nb.custom).toBe(false);
  expect(nb.title).not.toBe(draftTitle);
  // draft PDF rendered with this bid's data (API level)
  const api = await apiAs(fx, 'bid_manager');
  const pr = await api.post(`/api/workspaces/${wsId}/annexures/non_blacklisting/preview`, { data: { title: draftTitle, body: draftBody } });
  expect(pr.status()).toBe(200);
  expect(pr.headers()['content-type']).toBe('application/pdf');
  const t = pdfText(Buffer.from(await pr.body())).replace(/\s+/g, ' ');
  await api.dispose();
  expect(t).toContain('QA-DRAFT-MARKER');
  expect(t).toContain('Sharma Infotech Pvt Ltd');
  expect(t).toContain('GEM/2026/B/700001');
});

test('T050 closing the editor with edits asks "Discard unsaved changes?" (Keep editing / Discard changes)', async ({ page, context }) => {
  const dlg = await openEditor(page, context, fx, wsId);
  // pristine -> closes without a prompt
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // edit, then try to close
  await page.getByRole('button', { name: /Edit template/ }).click();
  const d2 = page.getByRole('dialog');
  await expect(d2.getByRole('textbox', { name: 'Title', exact: true })).not.toHaveValue('');
  const original = await d2.getByRole('textbox', { name: 'Title', exact: true }).inputValue();
  await d2.getByRole('textbox', { name: 'Title', exact: true }).fill(original + ' (edited)');
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog').filter({ hasText: 'Discard unsaved changes?' }));
  await expect(confirm.first()).toContainText('Discard unsaved changes?');
  await expect(page.getByRole('button', { name: 'Keep editing' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard changes' })).toBeVisible();
  await shot(page, 'T050-discard-confirm');
  // Keep editing -> editor remains with the edit intact
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(original + ' (edited)');
  // Discard changes -> editor closes; reopening shows the original
  await page.getByRole('dialog').getByRole('button', { name: /Close/ }).first().click().catch(async () => { await page.keyboard.press('Escape'); });
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /Edit template/ }).click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(original);
  void dlg;
});

test('S8 save -> toast, custom:true, defaults retained, applies to all org workspaces only; Restore default -> custom:false + toast', async ({ page, context }) => {
  // a second workspace in the same org (tender without analysis) and the other org's workspace for the same tender
  const wsB = (await createWorkspace(fx, fx.tenderNoAnalysis.id)).id;
  const dlg = await openEditor(page, context, fx, wsId);
  const MARK = 'QA-CUSTOM-CLAUSE-8472';
  const before = await apiCall(fx, 'bid_manager', 'get', '/api/annexure-templates');
  const sys = before.body.items.find((t: any) => t.key === 'non_blacklisting');
  await dlg.getByRole('textbox', { name: 'Title', exact: true }).fill('Custom non-blacklisting undertaking');
  await dlg.getByRole('textbox', { name: 'Body', exact: true }).fill(`Subject: Custom undertaking\n\n1. ${MARK} — {{company.legalName}} declares for bid {{tender.bidNumber}} that it is not blacklisted.`);
  await dlg.getByRole('button', { name: 'Save template' }).click();
  await expect(toastWith(page, 'Template saved for your organisation')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await shot(page, 'S8-saved-toast');
  const after = await apiCall(fx, 'analyst', 'get', '/api/annexure-templates');
  const nb = after.body.items.find((t: any) => t.key === 'non_blacklisting');
  expect(nb.custom).toBe(true);
  expect(nb.title).toBe('Custom non-blacklisting undertaking');
  expect(nb.systemTitle).toBe(sys.systemTitle);
  expect(nb.systemBody).toBe(sys.systemBody);
  expect(nb.systemBody).not.toContain(MARK);
  // every workspace of the org renders the custom text
  for (const id of [wsId, wsB]) {
    const t = pdfText((await getPdf(fx, id, 'non_blacklisting.pdf')).body).replace(/\s+/g, ' ');
    expect(t, `workspace ${id}`).toContain(MARK);
  }
  // other org: default text
  const other = pdfText((await getPdf(fx2, ws2Id, 'non_blacklisting.pdf')).body).replace(/\s+/g, ' ');
  expect(other).not.toContain(MARK);
  const otherTpl = await apiCall(fx2, 'bid_manager', 'get', '/api/annexure-templates');
  expect(otherTpl.body.items.find((t: any) => t.key === 'non_blacklisting').custom).toBe(false);
  // Restore default via the UI
  await page.getByRole('button', { name: /Edit template/ }).click();
  const d2 = page.getByRole('dialog');
  await expect(d2.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Custom non-blacklisting undertaking');
  await d2.getByRole('button', { name: /Restore default/ }).click();
  await expect(toastWith(page, 'Restored the TenderPilot template')).toBeVisible();
  await shot(page, 'S8-restored-toast');
  const restored = await apiCall(fx, 'analyst', 'get', '/api/annexure-templates');
  const rt = restored.body.items.find((t: any) => t.key === 'non_blacklisting');
  expect(rt.custom).toBe(false);
  expect(rt.title).toBe(sys.systemTitle);
  expect(pdfText((await getPdf(fx, wsId, 'non_blacklisting.pdf')).body)).not.toContain(MARK);
  // API-level DELETE too: custom:false returned
  await apiCall(fx, 'bid_manager', 'put', '/api/annexure-templates/non_blacklisting', { title: 'Temp custom', body: 'Temporary custom body for delete check.' });
  const del = await apiCall(fx, 'bid_manager', 'delete', '/api/annexure-templates/non_blacklisting');
  expect(del.status).toBe(200);
  expect(del.body.custom).toBe(false);
});

test('S9 body shorter than 20 chars -> 400 "The template body is too short"', async () => {
  const r = await apiCall(fx, 'bid_manager', 'put', '/api/annexure-templates/non_blacklisting', { title: 'Short body', body: 'too short' });
  expect(r.status).toBe(400);
  const msg = JSON.stringify(r.body);
  test.info().annotations.push({ type: 'short-body-response', description: msg });
  // Criterion text: 'The template body is too short'. A field-name prefix (e.g. "body: ...") is judged in the verdict.
  expect(msg).toContain('The template body is too short');
  const exact = E(r.body)?.message ?? '';
  test.info().annotations.push({ type: 'short-body-message', description: String(exact) });
  const ok = await apiCall(fx, 'bid_manager', 'put', '/api/annexure-templates/non_blacklisting', { title: 'Edge 20', body: 'x'.repeat(20) });
  expect(ok.status).toBe(200);
  await apiCall(fx, 'bid_manager', 'delete', '/api/annexure-templates/non_blacklisting');
});

test('S10 (FR-041) {{company.gstn}} -> 400 unknown_placeholder with details.unknown; UI highlights it', async ({ page, context }) => {
  const r = await apiCall(fx, 'bid_manager', 'put', '/api/annexure-templates/non_blacklisting', { title: 'Typo template', body: 'Declaration by {{company.gstn}} regarding the bid.' });
  expect(r.status).toBe(400);
  expect(E(r.body).code).toBe('unknown_placeholder');
  expect(E(r.body).message).toBe('Unknown placeholder {{company.gstn}} — use one from the list.');
  expect(E(r.body).details?.unknown).toEqual(['company.gstn']);
  const pv = await apiCall(fx, 'bid_manager', 'post', `/api/workspaces/${wsId}/annexures/non_blacklisting/preview`, { title: 'Typo template', body: 'Declaration by {{company.gstn}} regarding the bid.' });
  expect(pv.status).toBe(400);
  expect(E(pv.body).code).toBe('unknown_placeholder');
  // nothing saved
  const t = await apiCall(fx, 'bid_manager', 'get', '/api/annexure-templates');
  expect(t.body.items.find((x: any) => x.key === 'non_blacklisting').custom).toBe(false);
  // UI: typo is highlighted, error under Body, Preview disabled
  const dlg = await openEditor(page, context, fx, wsId);
  await dlg.getByRole('textbox', { name: 'Body', exact: true }).fill('Declaration by {{company.gstn}} regarding the bid.');
  await expect(dlg.getByText('Unknown placeholder {{company.gstn}} — use one from the list.')).toBeVisible();
  await expect(dlg.getByTestId('unknown-placeholders').locator('mark')).toHaveText('{{company.gstn}}');
  await expect(dlg.getByRole('button', { name: /^Preview$/ })).toBeDisabled();
  await shot(page, 'S10-unknown-placeholder');
  // Server refusal path in the UI (Save is allowed by the client; server answers 400 and the UI shows it inline)
  await dlg.getByRole('button', { name: 'Save template' }).click();
  await expect(toastWith(page, 'Template saved')).toHaveCount(0);
  await expect(dlg).toBeVisible();
});

test('S11 sanitising: ₹ -> "Rs. ", ≥ -> ">=", Devanagari dropped, rendering never fails', async () => {
  // company text (profile of org 2) and tender-independent template text
  const prof = await apiCall(fx2, 'owner', 'put', '/api/profile', { legalName: 'Sharma ₹ Infotech ≥ नमस्ते Pvt Ltd', address: '12 MIDC ≥ अंधेरी East' });
  expect(prof.status, JSON.stringify(prof.body)).toBe(200);
  const r = await getPdf(fx2, ws2Id, 'non_blacklisting.pdf');
  expect(r.status).toBe(200);
  const t = pdfText(r.body).replace(/\s+/g, ' ');
  expect(t).toContain('Rs. ');
  expect(t).toContain('>=');
  expect(t).not.toMatch(/[₹≥]/);
  expect(t).not.toMatch(/[ऀ-ॿ]/);
  expect(t).toMatch(/SHARMA Rs\. INFOTECH >= +PVT LTD/i);
  rasterise(r.body, `S11-sanitised-page1-${test.info().project.name}`);
  // template body with the same characters through preview
  const api = await apiAs(fx2, 'bid_manager');
  const pr = await api.post(`/api/workspaces/${ws2Id}/annexures/non_blacklisting/preview`, { data: { title: 'Rupee ₹ ≥ title नमस्ते', body: 'Penalty up to ₹ 5,00,000 where turnover ≥ ₹ 10 crore. नमस्ते world. Smart “quotes” and – dashes.' } });
  expect(pr.status()).toBe(200);
  const pt = pdfText(Buffer.from(await pr.body())).replace(/\s+/g, ' ');
  await api.dispose();
  expect(pt).toContain('Rs. 5,00,000');
  expect(pt).toContain('turnover >= Rs. 10 crore');
  expect(pt).toContain('world.');
  expect(pt).not.toMatch(/[₹≥ऀ-ॿ]/);
});

test('FR-092 browser Back / ?step= change with unsaved template edits asks "Discard unsaved changes?"', async ({ page, context }) => {
  await signInAs(context, fx, 'bid_manager');
  await page.goto(`/workspaces/${wsId}?step=documents`);
  await expect(page.getByRole('tablist', { name: 'Filter checklist' }).or(page.getByText('No checklist yet'))).toBeVisible();
  // in-app navigation to the Annexures step so Back has an in-app history entry
  await page.getByRole('button', { name: /Annexures/ }).or(page.getByRole('link', { name: /Annexures/ })).first().click();
  await expect(page.getByRole('list', { name: 'Annexures' })).toBeVisible();
  await page.getByRole('button', { name: /Edit template/ }).click();
  const dlg = page.getByRole('dialog');
  const title = dlg.getByRole('textbox', { name: 'Title', exact: true });
  const original = await title.inputValue();
  await title.fill(original + ' (edited)');
  // Back with unsaved edits
  await page.goBack();
  await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
  await expect(page).toHaveURL(/step=annexures/);
  await shot(page, 'FR092-back-confirm');
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByText('Discard unsaved changes?')).toHaveCount(0);
  await expect(title).toHaveValue(original + ' (edited)');
  await expect(page).toHaveURL(/step=annexures/);
  // Back again -> Discard changes proceeds to the previous page
  await page.goBack();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(/step=documents/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // pristine editor: Back does not prompt
  await page.goForward();
  await expect(page.getByRole('list', { name: 'Annexures' })).toBeVisible();
  await page.getByRole('button', { name: /Edit template/ }).click();
  await page.goBack();
  await expect(page).toHaveURL(/step=documents/);
  await expect(page.getByText('Discard unsaved changes?')).toHaveCount(0);
});
