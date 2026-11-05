/**
 * Spec 006 / US7 (#191): record the submission and the outcome. QA task T095. Scenarios S1..S10, FR-079..FR-086.
 *
 * Every stateful scenario gets its own fixture (own org, tender, workspace), created lazily; UI scenarios that also run in the
 * `mobile` project (375px) key the fixture by project so desktop and mobile never share state.
 */
import { test, expect, evidence, collectRunArtifacts, a11y, noHorizontalOverflow } from '../support/fixtures';
import { seedApplyFixture, newApi, apiAs, signInAs, createWorkspace, setChecklist, CHECKLIST, type ApplyFixture, type Role } from '../support/seed-apply';
import type { Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPEC = '006';
const STORY = 'US7';
const EVID_DIR = join('qa', 'evidence', SPEC, STORY);
const RA_HTML = join('packages', 'core', 'test', 'fixtures', 'gem', 'ra-result.html');

const proj = () => test.info().project.name;
const isMobile = () => proj() === 'mobile';
// Evidence budget: only layout-relevant screenshots at 375px.
const MOBILE_SHOTS = new Set(['s1-done-on-gem', 's2-confirm-dialog', 's5-record-dialog-validation']);
const shot = async (page: Page, name: string) => {
  if (isMobile() && !MOBILE_SHOTS.has(name)) return;
  return evidence(page, SPEC, STORY, `${name}-${proj()}`);
};
const toastWith = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text });
const HEADER_CHROME = ['button[aria-label="Owner and assignees"]', 'button[aria-label="Internal due date"]', '[id^="radix-"]'];

interface Ctx { fx: ApplyFixture; ws: string; ws2: string }
const memo = new Map<string, Promise<unknown>>();
function lazy<T>(key: string, make: () => Promise<T>): Promise<T> {
  if (!memo.has(key)) memo.set(key, make());
  return memo.get(key) as Promise<T>;
}
type Mode = 'go' | 'ready';
/** `ready`: the MAF item is removed from the checklist so the bid can reach Ready to submit. `go`: the expired MAF stays a blocker. */
const named = (key: string, mode: Mode = 'ready') => lazy<Ctx>(`${key}:${mode}`, async () => {
  const a = await newApi();
  const fx = await seedApplyFixture(a);
  await a.dispose();
  const ws = (await createWorkspace(fx)).id;
  const ws2 = (await createWorkspace(fx, fx.tenderNoAnalysis.id)).id;
  if (mode === 'ready') {
    await setChecklist(fx, CHECKLIST.filter((i) => i.id !== 'oem_authorization'));
    const r = await call(fx, 'analyst', 'patch', `/api/workspaces/${ws}`, { stage: 'ready' });
    if (r.status !== 200) throw new Error(`could not reach ready: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return { fx, ws, ws2 };
});

async function call(fx: ApplyFixture, role: Role, method: 'get' | 'post' | 'put' | 'patch', path: string, data?: unknown) {
  const api = await apiAs(fx, role);
  const r = await api[method](path, data === undefined ? undefined : { data });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  const out = { status: r.status(), body: body && body.error && !body.stage ? { ...body.error, error: true } : body };
  await api.dispose();
  return out;
}
const activityOf = async (c: Ctx, ws = c.ws) => {
  const r = await call(c.fx, 'analyst', 'get', `/api/activity?entityType=workspace&entityId=${ws}&pageSize=100`);
  expect(r.status).toBe(200);
  return r.body.items as { action: string; meta: Record<string, any> }[];
};

function transcript() {
  const rows: unknown[] = [];
  return {
    add(label: string, request: string, res: { status: number; body: any }) { rows.push({ label, request, status: res.status, response: res.body }); },
    save(name: string) { mkdirSync(EVID_DIR, { recursive: true }); writeFileSync(join(EVID_DIR, `${name}.json`), JSON.stringify(rows, null, 2)); },
  };
}

async function openSubmit(page: Page, context: any, c: Ctx, role: Role = 'analyst', ws = c.ws) {
  await signInAs(context, c.fx, role);
  await page.goto(`/workspaces/${ws}?step=submit`);
  await expect(page.getByRole('heading', { name: 'Human-only steps' })).toBeVisible();
}
const dialog = (page: Page) => page.getByRole('dialog');
/** Tag the Submit step's content grid so axe can be scoped to the step (the workspace header is shipped UI of earlier stories). */
async function tagStep(page: Page) {
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')].find((e) => e.textContent === 'Human-only steps');
    let el: HTMLElement | null = h as HTMLElement;
    while (el && !(el.classList.contains('grid') && el.classList.contains('xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)]'))) el = el.parentElement;
    el?.setAttribute('data-qa-step', '1');
  });
}

test.describe('web + api', () => {
  test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

  test('S1 Ready workspace: "Done on GeM?" card with Mark as submitted (Analyst+; Viewer sees no button); axe 0 serious/critical @mobile', async ({ page, context }) => {
    const c = await named(`s1-${proj()}`);
    await openSubmit(page, context, c);
    await expect(page.getByRole('button', { name: /Stage: Ready to submit/ })).toBeVisible();
    await expect(page.getByText('Done on GeM?', { exact: true })).toBeVisible();
    await expect(page.getByText('After you press Final Submit on GeM, record it here so your team and pipeline stay in sync.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark as submitted' })).toBeEnabled();
    await shot(page, 's1-done-on-gem');
    if (isMobile()) await noHorizontalOverflow(page);
    await tagStep(page);
    await a11y(page, 'submit-step-ready', { include: ['[data-qa-step]'] });
    // Viewer: read-only
    await signInAs(context, c.fx, 'viewer');
    await page.goto(`/workspaces/${c.ws}?step=submit`);
    await expect(page.getByText('Done on GeM?', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark as submitted' })).toHaveCount(0);
    // Role gate on the API
    expect((await call(c.fx, 'viewer', 'post', `/api/workspaces/${c.ws}/submitted`, {})).status).toBe(403);
  });

  test('S2 Confirm dialog: title, text, 3 checkboxes + optional note; confirm disabled until all 3 ticked; axe @mobile', async ({ page, context }) => {
    const c = await named(`s2-${proj()}`);
    await openSubmit(page, context, c);
    await page.getByRole('button', { name: 'Mark as submitted' }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Confirm you submitted on GeM' })).toBeVisible();
    await expect(d.getByText('TenderPilot only records this — the submission itself happened on the GeM portal.')).toBeVisible();
    const boxes = d.getByRole('checkbox');
    await expect(boxes).toHaveCount(3);
    await expect(d.getByText('I entered the price myself on GeM')).toBeVisible();
    await expect(d.getByText('I authenticated with OTP / DSC / e-Sign')).toBeVisible();
    await expect(d.getByText('I clicked Final Submit and saw the confirmation')).toBeVisible();
    await expect(d.getByLabel(/Note \(optional\)/)).toBeVisible();
    const confirm = d.getByRole('button', { name: 'Mark as submitted' });
    await expect(confirm).toBeDisabled();
    await shot(page, 's2-confirm-dialog');
    await boxes.nth(0).click(); await expect(confirm).toBeDisabled();
    await boxes.nth(1).click(); await expect(confirm).toBeDisabled();
    await boxes.nth(2).click(); await expect(confirm).toBeEnabled();
    await boxes.nth(1).click(); await expect(confirm).toBeDisabled(); // un-tick one: disabled again
    await boxes.nth(1).click(); await expect(confirm).toBeEnabled();
    await a11y(page, 'confirm-dialog', { include: ['[role="dialog"]'] });
    if (isMobile()) await noHorizontalOverflow(page);
    // Nothing recorded by merely opening/ticking
    await d.getByRole('button', { name: 'Cancel' }).click();
    expect((await call(c.fx, 'analyst', 'get', `/api/workspaces/${c.ws}`)).body.workspace.stage).toBe('ready');
  });

  test('S3 Confirm: POST /submitted 200 stage submitted + submittedAt; toast; card "Submitted on GeM" + Record result; step check; activity with note', async ({ page, context }) => {
    const c = await named('s3');
    await openSubmit(page, context, c);
    await page.getByRole('button', { name: 'Mark as submitted' }).first().click();
    const d = dialog(page);
    for (const b of await d.getByRole('checkbox').all()) await b.click();
    await d.getByLabel(/Note \(optional\)/).fill('Submitted by Ravi with DSC');
    const post = page.waitForResponse((r) => r.url().includes(`/api/workspaces/${c.ws}/submitted`) && r.request().method() === 'POST');
    const before = Date.now();
    await d.getByRole('button', { name: 'Mark as submitted' }).click();
    const resp = await post;
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.stage).toBe('submitted');
    expect(Math.abs(new Date(body.submittedAt).getTime() - before)).toBeLessThan(60_000);
    await expect(toastWith(page, 'Marked as submitted. Good luck!')).toBeVisible();
    await expect(page.getByText('Submitted on GeM', { exact: true })).toBeVisible();
    await expect(page.getByText('When GeM publishes the result, record it here — the L1 price helps you price the next bid.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record result' })).toBeVisible();
    // Submit step shows a check (green circle with the check icon, hint "Submitted")
    const stepBtn = page.getByRole('navigation', { name: 'Bid steps' }).getByRole('button', { name: /Submit/ });
    await expect(stepBtn).toContainText('Submitted');
    await expect(stepBtn.locator('svg.lucide-check')).toBeVisible();
    // IST date-time on the card
    const ist = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(new Date(body.submittedAt));
    await expect(page.getByText('Submitted on GeM', { exact: true }).locator('xpath=following-sibling::div')).toContainText(ist);
    await expect(page.getByText(/marked the bid as submitted on GeM/)).toBeVisible();
    await shot(page, 's3-submitted');
    const acts = await activityOf(c);
    const sub = acts.find((a) => a.action === 'workspace.submitted');
    expect(sub?.meta).toMatchObject({ note: 'Submitted by Ravi with DSC', from: 'ready', openBlockers: 0 });
    const t = transcript();
    t.add('POST submitted (UI)', `POST /api/workspaces/${c.ws}/submitted`, { status: resp.status(), body });
    t.add('activity workspace.submitted', 'GET /api/activity?entityType=workspace', { status: 200, body: sub });
    t.save('api-s3-submitted');
  });

  test('S4 API: POST /submitted on Won -> 409, Lost -> 409, Dropped -> 409 (exact messages); empty body 200; bad inputs 400', async () => {
    const c = await named('s4', 'go');
    const t = transcript();
    const run = async (label: string, method: 'post' | 'patch', path: string, data: unknown) => { const r = await call(c.fx, 'analyst', method, path, data); t.add(label, `${method.toUpperCase()} ${path} ${JSON.stringify(data)}`, r); return r; };
    const sub = `/api/workspaces/${c.ws}/submitted`;
    const r1 = await run('submit {} from Go', 'post', sub, {});
    expect(r1.status).toBe(200);
    expect(r1.body.stage).toBe('submitted');
    expect(r1.body.submittedAt).toBeTruthy();
    const r1b = await run('submit with explicit submittedAt', 'post', sub, { submittedAt: '2026-11-01T10:00:00+05:30' });
    expect(r1b.status).toBe(200);
    expect(new Date(r1b.body.submittedAt).toISOString()).toBe('2026-11-01T04:30:00.000Z');
    expect((await run('note > 1000', 'post', sub, { note: 'x'.repeat(1001) })).status).toBe(400);
    // Won -> 409
    expect((await run('stage won', 'patch', `/api/workspaces/${c.ws}`, { stage: 'won' })).status).toBe(200);
    const w = await run('submit on won', 'post', sub, {});
    expect(w.status).toBe(409);
    expect(w.body.message).toBe('This bid already has an outcome recorded.');
    // Lost -> 409
    expect((await run('stage lost (correct result)', 'patch', `/api/workspaces/${c.ws}`, { stage: 'lost' })).status).toBe(200);
    const l = await run('submit on lost', 'post', sub, {});
    expect(l.status).toBe(409);
    expect(l.body.message).toBe('This bid already has an outcome recorded.');
    // Dropped -> 409 (second workspace, never submitted)
    expect((await run('stage dropped', 'patch', `/api/workspaces/${c.ws2}`, { stage: 'dropped' })).status).toBe(200);
    const dr = await run('submit on dropped', 'post', `/api/workspaces/${c.ws2}/submitted`, {});
    expect(dr.status).toBe(409);
    expect(dr.body.message).toBe('This bid was dropped. Move it back to the pipeline first.');
    // Other orgs / malformed ids
    expect((await run('malformed id', 'post', '/api/workspaces/not-a-uuid/submitted', {})).status).toBe(404);
    t.save('api-s4-submitted-409s');
  });

  test('S5 Record result dialog: Won/Lost, L1 hint + live ₹ preview, "Enter a number", Our price, Notes <= 1000; axe @mobile', async ({ page, context }) => {
    const c = await named(`s5-${proj()}`);
    expect((await call(c.fx, 'analyst', 'post', `/api/workspaces/${c.ws}/submitted`, {})).status).toBe(200);
    await openSubmit(page, context, c);
    await page.getByRole('button', { name: 'Record result' }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Record the result' })).toBeVisible();
    await expect(d.getByText('Prices here are for your records and analytics only — TenderPilot never enters prices on GeM.')).toBeVisible();
    await expect(d.getByRole('radio', { name: 'Won' })).toBeVisible();
    await expect(d.getByRole('radio', { name: 'Lost' })).toBeVisible();
    await expect(d.getByText('The lowest price disclosed by GeM')).toBeVisible();
    const l1 = d.getByLabel('L1 price (₹)');
    await l1.fill('29,50,000');
    await expect(d.getByText('₹29,50,000', { exact: true })).toBeVisible(); // live Indian-format preview
    await l1.fill('abc');
    await expect(d.getByText('Enter a number')).toBeVisible();
    await expect(d.getByRole('button', { name: 'Save result' })).toBeDisabled();
    await d.getByLabel('Our price (₹)').fill('x1');
    await expect(d.getByText('Enter a number')).toHaveCount(2);
    await shot(page, 's5-record-dialog-validation');
    await d.getByLabel('Our price (₹)').fill('31,00,000');
    await expect(d.getByText('₹31,00,000', { exact: true })).toBeVisible();
    await expect(d.getByLabel('Notes')).toHaveAttribute('maxlength', '1000');
    await d.getByLabel('Notes').fill('y'.repeat(1200));
    expect((await d.getByLabel('Notes').inputValue()).length).toBe(1000);
    await l1.fill('29,50,000');
    await expect(d.getByRole('button', { name: 'Save result' })).toBeEnabled();
    await a11y(page, 'record-dialog', { include: ['[role="dialog"]'] });
    if (isMobile()) await noHorizontalOverflow(page);
  });

  test('S6 Won with L1 29,50,000: PATCH 200 stage won + outcome.at; toast; "Bid won" card (Our price "—"); header badge; activity sentence', async ({ page, context }) => {
    const c = await named('s6');
    expect((await call(c.fx, 'analyst', 'post', `/api/workspaces/${c.ws}/submitted`, {})).status).toBe(200);
    await openSubmit(page, context, c);
    await page.getByRole('button', { name: 'Record result' }).click();
    const d = dialog(page);
    await d.getByLabel('L1 price (₹)').fill('29,50,000');
    const patch = page.waitForResponse((r) => r.url().includes(`/api/workspaces/${c.ws}`) && r.request().method() === 'PATCH');
    await d.getByRole('button', { name: 'Save result' }).click();
    const resp = await patch;
    expect(resp.status()).toBe(200);
    const req = resp.request().postDataJSON();
    expect(req.outcome).toMatchObject({ result: 'won', l1Price: 2950000, ourPrice: null });
    const body = await resp.json();
    expect(body.stage).toBe('won');
    expect(body.outcome).toMatchObject({ result: 'won', l1Price: 2950000 });
    expect(body.outcome.at).toBeTruthy();
    await expect(toastWith(page, 'Congratulations on the win!')).toBeVisible();
    await expect(page.getByText('Bid won', { exact: true })).toBeVisible();
    await expect(page.locator('dt', { hasText: 'L1 price' }).locator('xpath=following-sibling::dd')).toHaveText('₹29,50,000');
    await expect(page.locator('dt', { hasText: 'Our price' }).locator('xpath=following-sibling::dd')).toHaveText('—');
    await expect(page.getByText(/^Recorded /)).toBeVisible();
    await expect(page.getByText('Won · L1 ₹29.5 L')).toBeVisible();
    await expect(page.getByText('recorded the result: Won (L1 ₹29,50,000)')).toBeVisible();
    await shot(page, 's6-bid-won');
    const acts = await activityOf(c);
    expect(acts.find((a) => a.action === 'workspace.outcome_recorded')?.meta).toMatchObject({ result: 'won', l1Price: 2950000 });
    const t = transcript();
    t.add('PATCH outcome (UI)', `PATCH /api/workspaces/${c.ws} ${JSON.stringify(req)}`, { status: resp.status(), body });
    t.save('api-s6-won');
  });

  test('S6b Lost: toast "Result recorded", card "Bid lost", Lost badge in header', async ({ page, context }) => {
    const c = await named('s6b');
    expect((await call(c.fx, 'analyst', 'post', `/api/workspaces/${c.ws}/submitted`, {})).status).toBe(200);
    await openSubmit(page, context, c);
    await page.getByRole('button', { name: 'Record result' }).click();
    const d = dialog(page);
    await d.getByRole('radio', { name: 'Lost' }).click();
    await d.getByLabel('L1 price (₹)').fill('1850000');
    await d.getByLabel('Our price (₹)').fill('2100000');
    await d.getByLabel('Notes').fill('Lost on price');
    const patch = page.waitForResponse((r) => r.url().includes(`/api/workspaces/${c.ws}`) && r.request().method() === 'PATCH');
    await d.getByRole('button', { name: 'Save result' }).click();
    const resp = await patch;
    expect(resp.status()).toBe(200);
    expect((await resp.json()).stage).toBe('lost');
    await expect(toastWith(page, 'Result recorded')).toBeVisible();
    await expect(page.getByText('Bid lost', { exact: true })).toBeVisible();
    await expect(page.locator('dt', { hasText: 'Our price' }).locator('xpath=following-sibling::dd')).toHaveText('₹21,00,000');
    await expect(page.getByText('Lost on price')).toBeVisible();
    await expect(page.getByText(/^Lost · L1 /)).toBeVisible();
    await expect(page.getByText('recorded the result: Lost (L1 ₹18,50,000)')).toBeVisible();
    await shot(page, 's6b-bid-lost');
  });

  test('S7 Stage dropdown Won without outcome stores minimal {result, at}; card still shows "Bid won"', async ({ page, context }) => {
    const c = await named('s7');
    expect((await call(c.fx, 'analyst', 'post', `/api/workspaces/${c.ws}/submitted`, {})).status).toBe(200);
    await openSubmit(page, context, c);
    await page.getByRole('button', { name: /Change stage/ }).click();
    const patch = page.waitForResponse((r) => r.url().includes(`/api/workspaces/${c.ws}`) && r.request().method() === 'PATCH');
    await page.getByRole('menuitem').filter({ hasText: /^Won/ }).click();
    const resp = await patch;
    expect(resp.status()).toBe(200);
    expect(resp.request().postDataJSON()).toEqual({ stage: 'won' });
    const body = await resp.json();
    expect(body.stage).toBe('won');
    expect(Object.keys(body.outcome).sort()).toEqual(['at', 'result']);
    expect(body.outcome.result).toBe('won');
    await expect(page.getByText('Bid won', { exact: true })).toBeVisible();
    await expect(page.locator('dt', { hasText: 'L1 price' }).locator('xpath=following-sibling::dd')).toHaveText('—');
    await shot(page, 's7-stage-only-won');
    const t = transcript();
    t.add('PATCH stage won via dropdown', `PATCH /api/workspaces/${c.ws} {"stage":"won"}`, { status: resp.status(), body });
    t.save('api-s7-minimal-outcome');
  });

  test('S8 API: l1Price -5 / 1.5 / "abc" / 10^13+1 / ourPrice -1 -> 400; 10^13 and 0 accepted; notes > 2000 -> 400', async () => {
    const c = await named('s8', 'go');
    expect((await call(c.fx, 'analyst', 'post', `/api/workspaces/${c.ws}/submitted`, {})).status).toBe(200);
    const t = transcript();
    const patch = async (label: string, outcome: unknown) => {
      const data = { outcome };
      const r = await call(c.fx, 'analyst', 'patch', `/api/workspaces/${c.ws}`, data);
      t.add(label, `PATCH /api/workspaces/${c.ws} ${JSON.stringify(data)}`, r);
      return r;
    };
    for (const [label, outcome] of [
      ['l1Price -5', { result: 'won', l1Price: -5 }],
      ['l1Price 1.5', { result: 'won', l1Price: 1.5 }],
      ['l1Price "abc"', { result: 'won', l1Price: 'abc' }],
      ['l1Price 10^13 + 1', { result: 'won', l1Price: 10_000_000_000_001 }],
      ['l1Price 10^15', { result: 'won', l1Price: 1e15 }],
      ['ourPrice -1', { result: 'lost', l1Price: 100, ourPrice: -1 }],
      ['ourPrice 2.5', { result: 'lost', ourPrice: 2.5 }],
      ['notes 2001 chars', { result: 'won', notes: 'n'.repeat(2001) }],
      ['bad result', { result: 'draw' }],
    ] as [string, unknown][]) {
      const r = await patch(label, outcome);
      expect(r.status, label).toBe(400);
    }
    // none of the rejected writes changed anything
    const w = (await call(c.fx, 'analyst', 'get', `/api/workspaces/${c.ws}`)).body.workspace;
    expect(w.stage).toBe('submitted');
    expect(w.outcome ?? null).toBeNull();
    const edge = await patch('l1Price exactly 10^13 (boundary, accepted)', { result: 'won', l1Price: 10_000_000_000_000, ourPrice: 0 });
    expect(edge.status).toBe(200);
    expect(edge.body.outcome).toMatchObject({ result: 'won', l1Price: 1e13 });
    t.save('api-s8-price-validation');
  });

  test('S9 Suggest from GeM result: ra-result.html pre-fills L1 28,40,500 + seller (not saved until confirmed); no-table page -> message, nothing pre-filled @mobile', async ({ page, context }) => {
    const c = await named(`s9-${proj()}`);
    expect((await call(c.fx, 'analyst', 'post', `/api/workspaces/${c.ws}/submitted`, {})).status).toBe(200);
    await openSubmit(page, context, c);
    await page.getByRole('button', { name: 'Record result' }).click();
    const d = dialog(page);
    const input = d.locator('input[type=file]');
    await expect(d.getByRole('button', { name: 'Suggest from GeM result' })).toBeVisible();
    // no price table first: nothing pre-filled
    const dir = mkdtempSync(join(tmpdir(), 'us7-'));
    const noTable = join(dir, 'no-table.html');
    writeFileSync(noTable, '<html><body><h1>Government e Marketplace</h1><p>Welcome. No evaluation here.</p><table><tr><td>RA End Date</td><td>05-11-2026</td></tr></table></body></html>');
    await input.setInputFiles(noTable);
    await expect(d.getByText('No price table found in this page.')).toBeVisible();
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('');
    await expect(d.getByLabel('Notes')).toHaveValue('');
    await shot(page, 's9-no-table');
    // the real fixture
    const reqs: string[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET') reqs.push(`${r.method()} ${r.url()}`); });
    await input.setInputFiles(RA_HTML);
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('2840500');
    await expect(d.getByText('₹28,40,500', { exact: true })).toBeVisible();
    await expect(d.getByLabel('Notes')).toHaveValue(/Kaveri Systems & Services Pvt Ltd/);
    await expect(d.getByText(/Pre-filled the L1 price and seller \(Kaveri Systems & Services Pvt Ltd/)).toBeVisible();
    await expect(d.getByText('No price table found in this page.')).toHaveCount(0);
    expect(reqs, 'picking the file must not upload it anywhere').toEqual([]);
    await shot(page, 's9-suggested');
    // still just a suggestion: the human confirms
    expect((await call(c.fx, 'analyst', 'get', `/api/workspaces/${c.ws}`)).body.workspace.outcome ?? null).toBeNull();
    if (isMobile()) await noHorizontalOverflow(page);
    // a miss after a hit clears the earlier pre-fill
    await input.setInputFiles(noTable);
    await expect(d.getByText('No price table found in this page.')).toBeVisible();
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('');
  });

  test('S9b Hostile page: a 6 MB header cell / 200k <th> cells does not freeze the page (completes quickly)', async ({ page, context }) => {
    const c = await named('s9b');
    expect((await call(c.fx, 'analyst', 'post', `/api/workspaces/${c.ws}/submitted`, {})).status).toBe(200);
    await openSubmit(page, context, c);
    await page.getByRole('button', { name: 'Record result' }).click();
    const d = dialog(page);
    const dir = mkdtempSync(join(tmpdir(), 'us7-hostile-'));
    const big = join(dir, 'big-header.html');
    writeFileSync(big, `<html><body><table><tr><th>Rank ${'Seller Price '.repeat(500_000)}</th><th>Seller Name</th><th>Total Price</th></tr><tr><td>L1</td><td>X</td><td>1,00,000</td></tr></table></body></html>`);
    const many = join(dir, 'many-th.html');
    writeFileSync(many, `<html><body><table><tr>${'<th>Rank</th>'.repeat(200_000)}</tr><tr><td>L1</td><td>X</td><td>1,00,000</td></tr></table></body></html>`);
    const timings: Record<string, number> = {};
    for (const [label, file] of [['big-header', big], ['many-th', many]] as const) {
      const t0 = Date.now();
      await d.locator('input[type=file]').setInputFiles(file);
      // the page stays responsive: a message or pre-fill appears, and the main thread answers a round trip
      await expect(d.getByRole('status').first()).toBeVisible({ timeout: 8_000 });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
      timings[label] = Date.now() - t0;
      expect(timings[label], `${label} took ${timings[label]} ms`).toBeLessThan(5_000);
    }
    // dialog still usable afterwards
    await d.getByLabel('L1 price (₹)').fill('123');
    await expect(d.getByText('₹123', { exact: true })).toBeVisible();
    const t = transcript();
    t.add('hostile files', 'setInputFiles big-header.html (~6.5 MB) and many-th.html (~2.6 MB)', { status: 200, body: { timingsMs: timings, sizesBytes: { big: readFileSync(big).length, many: readFileSync(many).length } } });
    t.save('s9b-hostile-timings');
    await shot(page, 's9b-hostile-handled');
  });

  test('S10 Open blockers: confirm dialog lists "<n> checklist item(s) were still open: …" (does not block); activity records openBlockers', async ({ page, context }) => {
    const c = await named('s10', 'go');
    await openSubmit(page, context, c);
    // card-level notice
    await expect(page.getByText('1 checklist item(s) were still missing or expired.')).toBeVisible();
    await page.getByRole('button', { name: 'Mark as submitted' }).first().click();
    const d = dialog(page);
    await expect(d.getByText('1 checklist item(s) were still open: OEM authorisation certificate (MAF) for this bid')).toBeVisible();
    await shot(page, 's10-open-blockers');
    for (const b of await d.getByRole('checkbox').all()) await b.click();
    const post = page.waitForResponse((r) => r.url().includes(`/api/workspaces/${c.ws}/submitted`) && r.request().method() === 'POST');
    await d.getByRole('button', { name: 'Mark as submitted' }).click(); // informational: not blocked
    expect((await post).status()).toBe(200);
    await expect(toastWith(page, 'Marked as submitted. Good luck!')).toBeVisible();
    const sub = (await activityOf(c)).find((a) => a.action === 'workspace.submitted');
    expect(sub?.meta.openBlockers).toBe(1);
    const t = transcript();
    t.add('activity workspace.submitted', 'GET /api/activity?entityType=workspace', { status: 200, body: sub });
    t.save('api-s10-open-blockers');
    // a clean bid records 0
    const clean = await named('s3'); // already submitted in S3 with openBlockers 0 (asserted there)
    expect(clean.ws).toBeTruthy();
  });

  test('S11 FR-083: after recording an outcome with prices, GET /assist contains no price and no outcome field', async () => {
    const c = await named('s11', 'go');
    expect((await call(c.fx, 'analyst', 'post', `/api/workspaces/${c.ws}/submitted`, {})).status).toBe(200);
    const before = await call(c.fx, 'analyst', 'get', `/api/assist/${c.ws}`);
    const rec = await call(c.fx, 'analyst', 'patch', `/api/workspaces/${c.ws}`, { outcome: { result: 'won', l1Price: 2950001, ourPrice: 3100007, notes: 'secret-note-xyz' } });
    expect(rec.status).toBe(200);
    const after = await call(c.fx, 'analyst', 'get', `/api/assist/${c.ws}`);
    expect(after.status).toBe(200);
    const raw = JSON.stringify(after.body);
    for (const needle of ['2950001', '3100007', 'secret-note-xyz', '29,50,001', 'outcome', 'l1Price', 'ourPrice', 'l1Seller']) expect(raw, needle).not.toContain(needle);
    expect(Object.keys(after.body).sort()).toEqual(Object.keys(before.body).sort());
    expect(after.body.noFinancials).toBe(true);
    const t = transcript();
    t.add('GET /assist after outcome with prices', `GET /api/assist/${c.ws}`, after);
    t.save('api-s11-assist-no-outcome');
  });
});
