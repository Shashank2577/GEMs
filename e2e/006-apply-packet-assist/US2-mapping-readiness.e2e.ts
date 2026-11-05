/**
 * Spec 006 / US2 (#179): map the checklist to vault documents and see bid readiness.
 * QA task T030 (#214). Scenarios 1-13 of the spec; numbering is kept in the test names.
 * Also covers the new a11y behaviour (T029): filter tablist with arrow keys, ring name "Readiness 83 percent".
 *
 * axe: @axe-core/playwright is not installed (and QA may not add dependencies) -> recorded as "not checked".
 */
import { test, expect, evidence, collectRunArtifacts } from '../support/fixtures';
import { seedApplyFixture, newApi, apiAs, signInAs, createWorkspace, setChecklist, upload, CHECKLIST, type ApplyFixture } from '../support/seed-apply';
import type { Page } from '@playwright/test';

const SPEC = '006';
const STORY = 'US2';
const DAY = 86_400_000;
// Not serial on purpose: a failing test must not skip the rest (QA evidence for every criterion). Tests run in file order
// on one worker; each one makes sure the workspace exists (ws()) and none depends on state left by another.

let fx: ApplyFixture;
let wsId = '';
async function ws() { if (!wsId) wsId = await workspaceOf(fx); return wsId; }

const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const E = (body: any) => body.error ?? body;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function freshFixture() {
  const api = await newApi();
  const f = await seedApplyFixture(api);
  await api.dispose();
  return f;
}
async function workspaceOf(f: ApplyFixture, tenderId = f.tender.id) { return (await createWorkspace(f, tenderId)).id; }
async function detail(f: ApplyFixture, id: string, role: 'analyst' | 'viewer' = 'analyst') {
  const api = await apiAs(f, role);
  const r = await api.get(`/api/workspaces/${id}`);
  expect(r.status()).toBe(200);
  const body = await r.json();
  await api.dispose();
  return body as { workspace: any; readiness: any };
}
const item = (d: { readiness: any }, id: string) => d.readiness.items.find((i: any) => i.item.id === id);
async function openDocs(page: Page, context: any, f: ApplyFixture, id: string, role: 'analyst' | 'viewer' | 'bid_manager' = 'analyst') {
  await signInAs(context, f, role);
  await page.goto(`/workspaces/${id}?step=documents`);
  await expect(page.getByRole('tablist', { name: 'Filter checklist' }).or(page.getByText('No checklist yet'))).toBeVisible();
}
const row = (page: Page, id: string) => page.locator(`#item-${id}`);
const toastWith = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text });
async function put(f: ApplyFixture, id: string, data: unknown, role: 'analyst' | 'viewer' = 'analyst') {
  const api = await apiAs(f, role);
  const r = await api.put(`/api/workspaces/${id}/mapping`, { data });
  const out = { status: r.status(), body: await r.json().catch(() => ({})) };
  await api.dispose();
  return out;
}
async function activityOf(f: ApplyFixture, entityId: string) {
  const api = await apiAs(f, 'analyst');
  const r = await api.get(`/api/activity?entityType=workspace&entityId=${entityId}&pageSize=100`);
  const body = await r.json();
  await api.dispose();
  return body.items as { action: string; meta: Record<string, any> }[];
}

test.beforeAll(async () => {
  fx = await freshFixture();
});

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

test('S1 ring 83% amber, heading, sub-line, buttons, blocker chip; ring accessible name @mobile', async ({ page, context }) => {
  await ws();
  await openDocs(page, context, fx, wsId);
  const ring = page.getByRole('img', { name: 'Readiness 83 percent' });
  await expect(ring).toBeVisible();
  await expect(ring).toContainText('83%');
  // amber = the warning token (>= 60 and < 100)
  expect(await ring.locator('circle').nth(1).getAttribute('stroke')).toBe('hsl(var(--warning))');
  await expect(page.getByText('1 blocker before “Ready to submit”')).toBeVisible();
  await expect(page.getByText('5 of 6 required items covered · 7 items in the checklist')).toBeVisible();
  await expect(page.getByRole('link', { name: /Upload to vault/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Annexures', exact: true })).toBeVisible();
  const chip = page.getByRole('list', { name: 'Blockers' }).getByRole('link');
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText('Expired · OEM authorisation certificate (MAF) for this bid');
  await expect(chip).toHaveAttribute('href', '#item-oem_authorization');
  await expect(chip).toHaveClass(/text-danger/);
  await shot(page, 's1-ring-and-blocker');
  await chip.click();
  await expect(page).toHaveURL(/#item-oem_authorization/);
  const d = await detail(fx, wsId);
  expect(d.readiness).toMatchObject({ percent: 83, total: 6, covered: 5, canMarkReady: false });
});

test('S2 rows: states, badges, documents, buttons, Generated rows with Preview', async ({ page, context }) => {
  await ws();
  await openDocs(page, context, fx, wsId);
  const gst = row(page, 'gst');
  await expect(gst).toContainText('Ready');
  await expect(gst).toContainText('Required');
  await expect(gst).toContainText('Auto-matched');
  await expect(gst).toContainText('GST REG-06');
  const pan = row(page, 'pan');
  await expect(pan).toContainText('Ready');
  await expect(pan).toContainText('Auto-matched');
  await expect(pan).toContainText('PAN card');
  const bs = row(page, 'balance_sheets');
  await expect(bs).toContainText('Ready');
  await expect(bs).toContainText('Auto-matched');
  await expect(bs).toContainText('Balance sheet 2024-25');
  await expect(bs).toContainText('FY 2024-25');
  await expect(bs).not.toContainText('Balance sheet 2023-24');
  const oem = row(page, 'oem_authorization');
  await expect(oem).toContainText('Expired');
  await expect(oem).toContainText('Required');
  await expect(oem).toContainText('Dell MAF');
  await expect(oem.locator('[class*="bg-danger-soft"]').first()).toBeVisible(); // red-tinted card / expired badge
  await expect(oem.locator('> div').first()).toHaveClass(/border-danger/);
  await expect(oem.getByRole('button', { name: /^Change/ })).toBeVisible();
  await expect(oem.getByRole('link', { name: /Upload renewed/ })).toBeVisible();
  const ud = row(page, 'udyam');
  await expect(ud).toContainText('Missing');
  await expect(ud).toContainText('Optional');
  await expect(ud).toContainText('No matching document in the vault.');
  await expect(ud.getByRole('button', { name: /Choose document/ })).toBeVisible();
  const upl = ud.locator('a[href^="/vault?upload=1"]');
  await expect(upl).toBeVisible();
  await expect(upl).toHaveAttribute('href', '/vault?upload=1&uploadType=udyam');
  for (const id of ['non_blacklisting', 'mii_self_cert']) {
    const g = row(page, id);
    await expect(g).toContainText('Generated');
    await expect(g).toContainText('Generated from your profile');
    await expect(g).toContainText('Print, sign and stamp before upload');
    await expect(g.getByRole('button', { name: 'Preview' })).toBeVisible();
  }
  await shot(page, 's2-rows');
  // API contract for the same facts
  const d = await detail(fx, wsId);
  expect(item(d, 'gst')).toMatchObject({ state: 'ready', auto: true, docId: fx.docs.gst });
  expect(item(d, 'balance_sheets')).toMatchObject({ state: 'ready', auto: true, docId: fx.docs.bsNew });
  expect(item(d, 'oem_authorization')).toMatchObject({ state: 'expired', blocking: true, docId: fx.docs.oem });
  expect(item(d, 'udyam')).toMatchObject({ state: 'missing', docId: null });
  expect(item(d, 'non_blacklisting').state).toBe('generated');
  // "Upload renewed" / "Upload Udyam registration" jump into the vault pre-set to the type
  await upl.click();
  await expect(page).toHaveURL(/\/vault/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await shot(page, 's2-upload-udyam-vault');
});

test('S2 Udyam missing-row button is labelled "Upload Udyam registration"', async ({ page, context }) => {
  await openDocs(page, context, fx, await ws());
  const upl = row(page, 'udyam').locator('a[href^="/vault?upload=1"]');
  await expect(upl).toHaveText('Upload Udyam registration');
});

test('S3 filter tabs All 7 / Needs attention 2 / Covered 5, aria-selected, tabpanel, arrow-key navigation @mobile', async ({ page, context }) => {
  await ws();
  await openDocs(page, context, fx, wsId);
  const tabs = page.getByRole('tablist', { name: 'Filter checklist' }).getByRole('tab');
  await expect(tabs).toHaveText(['All 7', 'Needs attention 2', 'Covered 5']);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('li[id^="item-"]')).toHaveCount(7);
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('li[id^="item-"]')).toHaveCount(2);
  await expect(row(page, 'oem_authorization')).toBeVisible();
  await expect(row(page, 'udyam')).toBeVisible();
  await shot(page, 's3-needs-attention');
  await tabs.nth(2).click();
  await expect(page.locator('li[id^="item-"]')).toHaveCount(5);
  await expect(row(page, 'oem_authorization')).toHaveCount(0);

  // a11y (T029): tabpanel wiring + roving tabindex + arrow keys
  const panel = page.getByRole('tabpanel');
  const panelId = await panel.getAttribute('id');
  expect(panelId).toBeTruthy();
  for (let i = 0; i < 3; i++) {
    await expect(tabs.nth(i)).toHaveAttribute('aria-controls', panelId!);
    const id = await tabs.nth(i).getAttribute('id');
    if (await tabs.nth(i).getAttribute('aria-selected') === 'true') await expect(panel).toHaveAttribute('aria-labelledby', id!);
  }
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('tabindex', '0');
  await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1');
  await tabs.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('li[id^="item-"]')).toHaveCount(2);
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(2)).toBeFocused();
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight'); // wraps
  await expect(tabs.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowLeft'); // wraps back
  await expect(tabs.nth(2)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tabs.nth(2)).toBeFocused();
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toHaveAttribute('aria-labelledby', (await tabs.nth(2).getAttribute('id'))!);
  await shot(page, 's3-covered-keyboard');
});

test('S3 empty filter shows "Nothing here — Everything in this view is covered."', async ({ page, context }) => {
  const f = await freshFixture();
  await setChecklist(f, CHECKLIST.filter((i) => ['gst', 'pan', 'non_blacklisting'].includes(i.id)));
  const id = await workspaceOf(f);
  await openDocs(page, context, f, id);
  const tabs = page.getByRole('tablist', { name: 'Filter checklist' }).getByRole('tab');
  await expect(tabs).toHaveText(['All 3', 'Needs attention 0', 'Covered 3']);
  await tabs.nth(1).click();
  await expect(page.getByText('Nothing here')).toBeVisible();
  await expect(page.getByText('Everything in this view is covered.')).toBeVisible();
  await expect(page.locator('li[id^="item-"]')).toHaveCount(0);
  await shot(page, 's3-empty-filter');
});

test('S4 Change popover: focused search, type group with checked Dell MAF, Other documents, footer buttons', async ({ page, context }) => {
  await ws();
  await openDocs(page, context, fx, wsId);
  await row(page, 'oem_authorization').getByRole('button', { name: /^Change/ }).click();
  const pop = page.getByRole('dialog');
  const search = pop.getByPlaceholder('Search the vault…');
  await expect(search).toBeVisible();
  await expect(search).toBeFocused();
  await expect(pop.getByText('OEM authorisation', { exact: true })).toBeVisible();
  const dell = pop.getByRole('button', { name: /Dell MAF/ });
  await expect(dell).toBeVisible();
  await expect(dell.locator('svg.lucide-check')).toBeVisible();
  await expect(pop.getByText('Other documents', { exact: true })).toBeVisible();
  await expect(pop.getByRole('button', { name: /Balance sheet 2023-24/ })).toBeVisible();
  await expect(pop.getByRole('button', { name: /Auto-match/ })).toBeVisible();
  await expect(pop.getByRole('button', { name: /Not available/ })).toBeVisible();
  const upl = pop.getByRole('link', { name: /Upload new/ });
  await expect(upl).toHaveAttribute('href', '/vault?upload=1&uploadType=oem_authorization');
  await search.fill('2023');
  await expect(pop.getByRole('button', { name: /Balance sheet 2023-24/ })).toBeVisible();
  await expect(pop.getByRole('button', { name: /Dell MAF/ })).toHaveCount(0);
  await search.fill('zzzz-nothing');
  await expect(pop.getByText('No documents match.')).toBeVisible();
  await search.fill('');
  await shot(page, 's4-popover');
});

test('S4 "Other documents" group is capped at 30 rows', async ({ page, context }) => {
  const f = await freshFixture();
  const id = await workspaceOf(f);
  const api = await apiAs(f, 'analyst');
  for (let batch = 0; batch < 4; batch++) {
    await Promise.all(Array.from({ length: 9 }, (_, i) => upload(api, `extra-${batch}-${i}`, { type: 'other', title: `Extra doc ${batch * 9 + i + 1}` })));
  }
  await api.dispose(); // 36 extra + 4 pre-existing docs of other types -> 40 candidates under "Other documents"
  await openDocs(page, context, f, id);
  await row(page, 'oem_authorization').getByRole('button', { name: /^Change/ }).click();
  const pop = page.getByRole('dialog');
  await expect(pop.getByText('Other documents', { exact: true })).toBeVisible();
  const total = await pop.locator('button:has(.truncate)').count();
  const typed = await pop.getByRole('button', { name: /Dell MAF/ }).count();
  expect(total - typed).toBe(30);
  await shot(page, 's4-popover-capped');
});

test('S5 pick another document: PUT 200 {workspace, readiness}, toast, badge gone, activity logged', async ({ page, context }) => {
  await ws();
  await openDocs(page, context, fx, wsId);
  const oem = row(page, 'oem_authorization');
  await expect(oem).toContainText('Auto-matched');
  await oem.getByRole('button', { name: /^Change/ }).click();
  const put = page.waitForResponse((r) => r.url().includes(`/api/workspaces/${wsId}/mapping`) && r.request().method() === 'PUT');
  await page.getByRole('dialog').getByRole('button', { name: /Balance sheet 2023-24/ }).click();
  const resp = await put;
  expect(resp.status()).toBe(200);
  expect(resp.request().postDataJSON()).toEqual({ oem_authorization: fx.docs.bsOld });
  const body = await resp.json();
  expect(Object.keys(body).sort()).toEqual(['readiness', 'workspace']);
  expect(body.workspace.mapping.oem_authorization).toBe(fx.docs.bsOld);
  await expect(toastWith(page, 'Using “Balance sheet 2023-24”')).toBeVisible();
  await expect(oem).toContainText('Balance sheet 2023-24');
  await expect(oem).not.toContainText('Auto-matched');
  await shot(page, 's5-picked');
  const acts = await activityOf(fx, wsId);
  const ch = acts.find((a) => a.action === 'workspace.mapping_changed');
  expect(ch?.meta).toMatchObject({ items: ['oem_authorization'], mapping: { oem_authorization: fx.docs.bsOld } });
  await expect(page.getByText('changed the document for 1 checklist item(s)').first()).toBeVisible();
  await shot(page, 's5-activity');
});

test('S6 Not available -> null, toast, row Missing with note; Auto-match -> key removed, toast, back to Dell MAF Auto-matched', async ({ page, context }) => {
  await ws();
  await openDocs(page, context, fx, wsId);
  const oem = row(page, 'oem_authorization');
  await oem.getByRole('button', { name: /^Change/ }).click();
  let put = page.waitForResponse((r) => r.url().includes('/mapping') && r.request().method() === 'PUT');
  await page.getByRole('dialog').getByRole('button', { name: /Not available/ }).click();
  expect((await put).status()).toBe(200);
  await expect(toastWith(page, 'Marked as not available')).toBeVisible();
  await expect(oem).toContainText('Missing');
  await expect(oem).toContainText('Marked as not available.');
  await expect(oem).not.toContainText('Auto-matched');
  expect((await detail(fx, wsId)).workspace.mapping.oem_authorization).toBeNull();
  await shot(page, 's6-not-available');

  await oem.getByRole('button', { name: /Choose document/ }).click();
  put = page.waitForResponse((r) => r.url().includes('/mapping') && r.request().method() === 'PUT');
  await page.getByRole('dialog').getByRole('button', { name: /Auto-match/ }).click();
  const autoResp = await put;
  expect(autoResp.request().postDataJSON()).toEqual({ oem_authorization: 'auto' });
  expect(autoResp.status()).toBe(200);
  await expect(toastWith(page, 'TenderPilot will pick the best document')).toBeVisible();
  await expect(oem).toContainText('Dell MAF');
  await expect(oem).toContainText('Auto-matched');
  await expect(oem).toContainText('Expired');
  const d = await detail(fx, wsId);
  expect(Object.keys(d.workspace.mapping)).not.toContain('oem_authorization');
  await shot(page, 's6-auto-match');
});

test('S7 uploading a udyam document later auto-matches the untouched item (no mapping call)', async ({ page, context }) => {
  await ws();
  const before = await detail(fx, wsId);
  expect(item(before, 'udyam').state).toBe('missing');
  const api = await apiAs(fx, 'analyst');
  const udyam = await upload(api, 'udyam', { type: 'udyam', title: 'Udyam certificate', issueDate: ymd(Date.now() - 100 * DAY) });
  await api.dispose();
  const mappingCalls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/mapping') && r.method() !== 'GET') mappingCalls.push(`${r.method()} ${r.url()}`); });
  await openDocs(page, context, fx, wsId);
  const ud = row(page, 'udyam');
  await expect(ud).toContainText('Ready');
  await expect(ud).toContainText('Auto-matched');
  await expect(ud).toContainText('Udyam certificate');
  expect(mappingCalls).toEqual([]);
  const d = await detail(fx, wsId);
  expect(item(d, 'udyam')).toMatchObject({ state: 'ready', auto: true, docId: udyam });
  expect(Object.keys(d.workspace.mapping)).not.toContain('udyam');
  await expect(page.getByRole('tablist').getByRole('tab').nth(2)).toHaveText('Covered 6');
  await shot(page, 's7-udyam-auto');
});

test('S7 explicit "Not available" stays Missing even after a udyam document is uploaded', async ({ page, context }) => {
  const f = await freshFixture();
  const id = await workspaceOf(f);
  expect((await put(f, id, { udyam: null })).status).toBe(200);
  const api = await apiAs(f, 'analyst');
  await upload(api, 'udyam', { type: 'udyam', title: 'Udyam certificate' });
  await api.dispose();
  await openDocs(page, context, f, id);
  const ud = row(page, 'udyam');
  await expect(ud).toContainText('Missing');
  await expect(ud).toContainText('Marked as not available.');
  await expect(ud).not.toContainText('Auto-matched');
  expect(item(await detail(f, id), 'udyam')).toMatchObject({ state: 'missing', docId: null });
  await shot(page, 's7-explicit-not-available');
});

test('S8 API validation: unknown item 400, foreign doc 400, deleted doc 400, Viewer 403', async () => {
  await ws();
  const analyst = await apiAs(fx, 'analyst');
  const unknown = await analyst.put(`/api/workspaces/${wsId}/mapping`, { data: { not_an_item: fx.docs.gst } });
  expect(unknown.status()).toBe(400);
  let j = E(await unknown.json());
  expect(j.code).toBe('validation_error');
  expect(j.details.fields.not_an_item).toBe('Not an item of this bid’s checklist');

  // foreign: a document of another organisation (the outsider's org)
  const other = await newApi();
  const out = await other.post('/api/auth/login', { data: { email: fx.outsider.email, password: fx.outsider.password } });
  expect(out.ok(), await out.text()).toBeTruthy();
  const foreignId = await upload(other, 'foreign-gst', { type: 'gst', title: 'Foreign GST' });
  await other.dispose();
  const foreign = await analyst.put(`/api/workspaces/${wsId}/mapping`, { data: { gst: foreignId } });
  expect(foreign.status()).toBe(400);
  j = E(await foreign.json());
  expect(j.code).toBe('validation_error');
  expect(j.details.fields.gst).toBe('Document not found in your vault');

  // deleted: upload, delete, then map
  const tmp = await upload(analyst, 'tmp-gst', { type: 'gst', title: 'Temp GST' });
  expect((await analyst.delete(`/api/vault/${tmp}`)).status()).toBeLessThan(300);
  const deleted = await analyst.put(`/api/workspaces/${wsId}/mapping`, { data: { gst: tmp } });
  expect(deleted.status()).toBe(400);
  expect(E(await deleted.json()).details.fields.gst).toBe('Document not found in your vault');
  // nothing was stored by the rejected calls
  expect(Object.keys((await detail(fx, wsId)).workspace.mapping)).not.toContain('gst');

  const viewer = await put(fx, wsId, { gst: fx.docs.gst }, 'viewer');
  expect(viewer.status).toBe(403);
  expect(E(viewer.body).message).toContain('You need to be at least an Analyst to do that');
  await analyst.dispose();
});

test('S8 Viewer sees no Change / Choose document / Upload controls on the Documents step', async ({ page, context }) => {
  await ws();
  await openDocs(page, context, fx, wsId, 'viewer');
  await expect(row(page, 'gst')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Change|Choose document/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Upload renewed|Upload Udyam/ })).toHaveCount(0);
  await shot(page, 's8-viewer');
});

test('S9 deleted mapped doc -> explicit item Missing; auto items fall back to the next best', async ({ page, context }) => {
  const f = await freshFixture();
  const id = await workspaceOf(f);
  // explicit choice for the MAF slot (any doc), auto for balance sheets (newest FY wins)
  expect((await put(f, id, { oem_authorization: f.docs.oem })).status).toBe(200);
  const before = await detail(f, id);
  expect(item(before, 'balance_sheets')).toMatchObject({ docId: f.docs.bsNew, auto: true });
  const api = await apiAs(f, 'analyst');
  expect((await api.delete(`/api/vault/${f.docs.oem}`)).status()).toBeLessThan(300);
  expect((await api.delete(`/api/vault/${f.docs.bsNew}`)).status()).toBeLessThan(300);
  await api.dispose();
  const d = await detail(f, id);
  expect(d.workspace.mapping.oem_authorization).toBe(f.docs.oem); // dangling id still stored...
  expect(item(d, 'oem_authorization')).toMatchObject({ state: 'missing', docId: null }); // ...but resolves to nothing
  expect(item(d, 'balance_sheets')).toMatchObject({ state: 'ready', auto: true, docId: f.docs.bsOld }); // fell back
  await openDocs(page, context, f, id);
  await expect(row(page, 'oem_authorization')).toContainText('Missing');
  await expect(row(page, 'oem_authorization')).not.toContainText('Dell MAF');
  await expect(row(page, 'balance_sheets')).toContainText('Balance sheet 2023-24');
  await expect(row(page, 'balance_sheets')).toContainText('Auto-matched');
  await shot(page, 's9-deleted-doc');
});

test('S10 doc expiring in 12 days: Expiring soon, "Expires in 12 day(s).", covered, in warnings, not a blocker', async ({ page, context }) => {
  const f = await freshFixture();
  const api = await apiAs(f, 'analyst');
  const r = await api.patch(`/api/vault/${f.docs.oem}`, { data: { expiryDate: ymd(Date.now() + 12 * DAY) } });
  expect(r.status(), await r.text()).toBe(200);
  await api.dispose();
  const id = await workspaceOf(f);
  expect((await put(f, id, { oem_authorization: f.docs.oem })).status).toBe(200);
  const d = await detail(f, id);
  const it = item(d, 'oem_authorization');
  expect(it).toMatchObject({ state: 'expiring', blocking: false, docId: f.docs.oem });
  expect(it.note).toMatch(/^Expires in 1[23] day\(s\)\.$/);
  expect(d.readiness.warnings.map((w: any) => w.itemId)).toContain('oem_authorization');
  expect(d.readiness.blockers).toEqual([]);
  expect(d.readiness.canMarkReady).toBe(true);
  expect(d.readiness.percent).toBe(100);
  await openDocs(page, context, f, id);
  const oem = row(page, 'oem_authorization');
  await expect(oem).toContainText('Expiring soon');
  await expect(oem).toContainText('Required');
  await expect(oem.getByRole('link', { name: 'Upload renewed' })).toBeVisible();
  await expect(page.getByText('All required documents are covered')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Readiness 100 percent' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Blockers' })).toHaveCount(0);
  await shot(page, 's10-expiring');
  // note text rendered for an exact 12 days (UI shows the API note)
  expect(it.note).toBe('Expires in 12 day(s).');
});

test('S11 no analysis: empty state "No checklist yet" with "Analyse tender →" to /tenders/{id}', async ({ page, context }) => {
  const id = await workspaceOf(fx, fx.tenderNoAnalysis.id);
  await openDocs(page, context, fx, id);
  await expect(page.getByText('No checklist yet')).toBeVisible();
  await expect(page.getByText('Analyse the tender to get the list of documents this bid needs.')).toBeVisible();
  const cta = page.getByRole('link', { name: /Analyse tender/ });
  await expect(cta).toContainText('Analyse tender');
  await expect(cta).toHaveAttribute('href', `/tenders/${fx.tenderNoAnalysis.id}`);
  await expect(page.getByRole('tablist', { name: 'Filter checklist' })).toHaveCount(0);
  await shot(page, 's11-no-analysis');
  await cta.click();
  await expect(page).toHaveURL(new RegExp(`/tenders/${fx.tenderNoAnalysis.id}`));
});

test('S12 "other" items map only with relevance >= 0.5 or an exact item-id tag', async ({ page, context }) => {
  const f = await freshFixture();
  await setChecklist(f, [
    { id: 'iso_9001', label: 'ISO 9001 quality management certificate', docType: 'other', mandatory: false, reason: 'Quality' },
    { id: 'cert_fire', label: 'Fire safety compliance certificate', docType: 'other', mandatory: false, reason: 'Safety' },
    { id: 'site_visit', label: 'Site visit acknowledgement letter', docType: 'other', mandatory: false, reason: 'Visit' },
  ]);
  const api = await apiAs(f, 'analyst');
  const iso = await upload(api, 'iso', { type: 'other', title: 'ISO 9001 quality management certificate' }); // all words -> 1.0
  await upload(api, 'weak', { type: 'other', title: 'Quality brochure' });                                       // 1 shared word -> < 0.5
  const tagged = await upload(api, 'fire', { type: 'other', title: 'Misc scan 17', tags: 'cert_fire' });        // exact id tag
  await api.dispose();
  const id = await workspaceOf(f);
  const d = await detail(f, id);
  expect(item(d, 'iso_9001')).toMatchObject({ docId: iso, auto: true, state: 'ready' });
  expect(item(d, 'cert_fire')).toMatchObject({ docId: tagged, auto: true });
  expect(item(d, 'site_visit')).toMatchObject({ docId: null, state: 'missing' });
  await openDocs(page, context, f, id);
  await expect(row(page, 'iso_9001')).toContainText('ISO 9001 quality management certificate');
  await expect(row(page, 'iso_9001')).not.toContainText('Quality brochure');
  await expect(row(page, 'site_visit')).toContainText('Missing');
  await shot(page, 's12-other-items');
});

test('S13 @mobile 375 px: rows stack, popover <= 92vw, no horizontal page scroll, ring and buttons do not overlap', async ({ page, context }) => {
  await ws();
  await page.setViewportSize({ width: 375, height: 812 });
  await openDocs(page, context, fx, wsId);
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await noHScroll()).toBe(true);
  for (const id of ['gst', 'oem_authorization', 'udyam']) {
    const r = row(page, id);
    await r.scrollIntoViewIfNeeded();
    const label = (await r.locator('.text-sm.font-medium').first().boundingBox())!;
    const box = (await r.locator('div.flex.w-full.flex-col').first().boundingBox())!;
    expect(box.y, `${id}: document box under the label`).toBeGreaterThanOrEqual(label.y + label.height - 1);
    const card = (await r.locator('> div').first().boundingBox())!;
    expect(card.x + card.width).toBeLessThanOrEqual(375 + 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
  }
  // ring and heading/buttons: no overlap
  const ring = (await page.getByRole('img', { name: /Readiness/ }).boundingBox())!;
  const heading = (await page.getByText('1 blocker before “Ready to submit”').boundingBox())!;
  expect(heading.x).toBeGreaterThanOrEqual(ring.x + ring.width - 1);
  const up = (await page.getByRole('link', { name: /Upload to vault/ }).boundingBox())!;
  const an = (await page.getByRole('button', { name: 'Annexures', exact: true }).boundingBox())!;
  const overlap = !(up.x + up.width <= an.x + 1 || an.x + an.width <= up.x + 1 || up.y + up.height <= an.y + 1 || an.y + an.height <= up.y + 1);
  expect(overlap, 'Upload to vault and Annexures buttons must not overlap').toBe(false);
  expect(up.x + up.width).toBeLessThanOrEqual(375);
  expect(an.x + an.width).toBeLessThanOrEqual(375);
  await shot(page, 's13-mobile-top');
  await row(page, 'oem_authorization').scrollIntoViewIfNeeded();
  await shot(page, 's13-mobile-rows');

  await row(page, 'oem_authorization').getByRole('button', { name: /^Change/ }).click();
  const pop = page.getByRole('dialog');
  await expect(pop.getByPlaceholder('Search the vault…')).toBeVisible();
  const pb = (await pop.boundingBox())!;
  expect(pb.width).toBeLessThanOrEqual(0.92 * 375 + 0.5);
  expect(pb.x).toBeGreaterThanOrEqual(-0.5);
  expect(pb.x + pb.width).toBeLessThanOrEqual(375 + 0.5);
  expect(await noHScroll()).toBe(true);
  await shot(page, 's13-mobile-popover');
});
