/**
 * Spec 006 / US1 (#176): start a bid workspace and move it through the stages with the "Ready to submit" guard.
 * QA task T023 (#209). Scenarios 1-15 of the spec; numbering is kept in the test names.
 */
import { test, expect, evidence, collectRunArtifacts } from '../support/fixtures';
import { seedApplyFixture, newApi, apiAs, signInAs, createWorkspace, type ApplyFixture } from '../support/seed-apply';
import type { Page } from '@playwright/test';

const SPEC = '006';
const STORY = 'US1';
test.describe.configure({ mode: 'serial' });

let fx: ApplyFixture;
let wsId = '';       // workspace on the analysed tender (stage Go)
let ws2Id = '';      // workspace on the tender WITHOUT analysis

const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const BID = () => fx.tender.bidNumber;
/** API error envelope: { error: { code, message, details } } */
const E = (body: any) => body.error ?? body;

test.beforeAll(async () => {
  const seedApi = await newApi();
  fx = await seedApplyFixture(seedApi);
  await seedApi.dispose();
});

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

async function activityOf(role: 'owner' | 'analyst' | 'bid_manager', entityType: string, entityId: string) {
  const api = await apiAs(fx, role);
  const r = await api.get(`/api/activity?entityType=${entityType}&entityId=${entityId}&pageSize=100`);
  expect(r.status()).toBe(200);
  const body = await r.json();
  await api.dispose();
  return body.items as { action: string; meta: Record<string, any>; user: { id: string } | null }[];
}

test('S1-S3 API: create workspace 201 / repeat+race 200 / Viewer 403 / unknown tender 404', async () => {
  const viewer = await apiAs(fx, 'viewer');
  const v = await viewer.post(`/api/tenders/${fx.tender.id}/workspace`);
  expect(v.status()).toBe(403);
  expect(E(await v.json()).message).toContain('You need to be at least an Analyst to do that');

  const analyst = await apiAs(fx, 'analyst');
  const unknown = await analyst.post('/api/tenders/00000000-0000-4000-8000-000000000000/workspace');
  expect(unknown.status()).toBe(404);
  expect(await unknown.text()).toContain('Tender not found');

  // Scenario 1
  const res = await analyst.post(`/api/tenders/${fx.tender.id}/workspace`);
  expect(res.status()).toBe(201);
  const w = await res.json();
  wsId = w.id;
  expect(w.created).toBe(true);
  expect(w.stage).toBe('go');
  expect(w.owner.id).toBe(fx.users.analyst.id);
  expect(new Date(w.dueAt).getTime()).toBe(new Date(fx.tender.endAt).getTime());
  expect(w.assignees).toEqual([]);
  // Amended scenario 1 (FR-002, d976969): nothing is stored; automatic picks are resolved at read time in readiness.items.
  expect(w.mapping).toEqual({});
  const detail = await (await analyst.get(`/api/workspaces/${wsId}`)).json();
  const pick = (id: string) => detail.readiness.items.find((i: any) => i.item.id === id);
  expect(pick('gst')).toMatchObject({ docId: fx.docs.gst, auto: true });
  expect(pick('pan')).toMatchObject({ docId: fx.docs.pan, auto: true });
  expect(pick('balance_sheets')).toMatchObject({ docId: fx.docs.bsNew, auto: true });
  expect(pick('oem_authorization')).toMatchObject({ docId: fx.docs.oem, auto: true });
  expect(pick('udyam').docId).toBeNull();
  expect(detail.readiness.items.filter((i: any) => i.docId && i.auto)).toHaveLength(4);
  const wAct = await activityOf('analyst', 'workspace', wsId);
  const tAct = await activityOf('analyst', 'tender', fx.tender.id);
  expect(wAct.some((a) => a.action === 'workspace.created')).toBe(true);
  expect(tAct.some((a) => a.action === 'workspace.created' && a.meta.workspaceId === wsId)).toBe(true);

  // Scenario 2: repeat (any Analyst+)
  const again = await analyst.post(`/api/tenders/${fx.tender.id}/workspace`);
  expect(again.status()).toBe(200);
  const a2 = await again.json();
  expect(a2.created).toBe(false);
  expect(a2.id).toBe(wsId);
  const bm = await apiAs(fx, 'bid_manager');
  const again2 = await bm.post(`/api/tenders/${fx.tender.id}/workspace`);
  expect(again2.status()).toBe(200);
  expect((await again2.json()).id).toBe(wsId);

  // Race on the tender without analysis: exactly one 201, one 200, one row
  const [r1, r2, r3] = await Promise.all([
    analyst.post(`/api/tenders/${fx.tenderNoAnalysis.id}/workspace`),
    bm.post(`/api/tenders/${fx.tenderNoAnalysis.id}/workspace`),
    analyst.post(`/api/tenders/${fx.tenderNoAnalysis.id}/workspace`),
  ]);
  const bodies = await Promise.all([r1, r2, r3].map((r) => r.json()));
  expect([r1, r2, r3].map((r) => r.status()).sort()).toEqual([200, 200, 201]);
  expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
  ws2Id = bodies[0].id;
  const list = await (await analyst.get('/api/workspaces')).json();
  expect(list.items.filter((i: any) => i.id === ws2Id)).toHaveLength(1);
  expect(list.items.filter((i: any) => i.id === wsId)).toHaveLength(1);
  expect(bodies.find((b) => b.created)?.stage).toBe('identified');
  await Promise.all([viewer.dispose(), analyst.dispose(), bm.dispose()]);
});

test('S4 workspace page header: breadcrumb, title, stage, score, EMD, Owner and Due @mobile', async ({ page, context }) => {
  wsId = wsId || (await createWorkspace(fx)).id; // idempotent; lets the mobile project run this test alone
  await signInAs(context, fx, 'analyst');
  await page.goto(`/workspaces/${wsId}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(fx.tender.title);
  await expect(page).toHaveTitle(/GEM\/2026\/B\/700001 · Bid workspace/);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveText(/Pipeline.*GEM\/2026\/B\/700001/);
  await expect(page.getByRole('button', { name: /Stage: Go\. Change stage/ })).toBeVisible();
  await expect(page.getByText('Indian Oil Corporation Limited').first()).toBeVisible();
  await expect(page.getByText(/EMD\s*₹1,50,000/)).toBeVisible();
  const elig = page.getByRole('button', { name: /Eligibility/ });
  await expect(elig).toContainText('78');
  await expect(elig).toContainText('Go');
  await expect(page.getByRole('button', { name: 'Owner and assignees' })).toContainText('Owner');
  await expect(page.getByRole('button', { name: 'Internal due date' })).toContainText('Due');
  // countdown present (closing in ~15 days)
  await expect(page.getByText(/15\s*d|14\s*d|in 1[45] days|15 days/i).first()).toBeVisible();
  await shot(page, 's4-header');
});

test('S5 clicking the bid number copies it and shows a check icon', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signInAs(context, fx, 'analyst');
  await page.goto(`/workspaces/${wsId}`);
  const chip = page.getByRole('button', { name: `Copy bid number ${BID()}` });
  await expect(chip.locator('svg.lucide-copy')).toBeVisible();
  await chip.click();
  await expect(chip.locator('svg.lucide-check')).toBeVisible();
  await expect(chip.locator('svg.lucide-copy')).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(BID());
  await shot(page, 's5-copied');
  await expect(chip.locator('svg.lucide-copy')).toBeVisible({ timeout: 4000 }); // reverts after ~1.4 s
});

test('S6+S7 stage dropdown lists 9 stages in order; Ready to submit refused with expired MAF (toast + Fix documents)', async ({ page, context }) => {
  await signInAs(context, fx, 'analyst');
  await page.goto(`/workspaces/${wsId}`);
  await page.getByRole('button', { name: /Change stage/ }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Move to stage')).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveCount(9);
  const labels = ['Identified', 'Analysing', 'Go', 'Preparing', 'Ready to submit', 'Submitted', 'Won', 'Lost', 'Dropped'];
  for (let i = 0; i < labels.length; i++) await expect(items.nth(i)).toContainText(labels[i]);
  await expect(items.nth(2).locator('svg.lucide-check')).toBeVisible(); // current stage Go
  await expect(items.nth(4)).toContainText('1 blocker');
  await expect(items.nth(4).getByText('1 blocker')).toHaveClass(/text-danger/);
  await shot(page, 's6-dropdown');

  // Scenario 7 (UI): choose Ready to submit
  const patch = page.waitForResponse((r) => r.url().includes(`/api/workspaces/${wsId}`) && r.request().method() === 'PATCH');
  await items.nth(4).click();
  const resp = await patch;
  expect(resp.status()).toBe(409);
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: '1 required document is missing or expired' });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Replace it in the vault, or ask a Bid Manager to override with a reason.');
  await expect(toast).toContainText('OEM authorisation certificate (MAF) for this bid');
  await shot(page, 's7-toast');
  await expect(page.getByRole('button', { name: /Stage: Go\./ })).toBeVisible(); // unchanged
  await toast.getByRole('button', { name: 'Fix documents' }).click();
  await expect(page).toHaveURL(/step=documents/);
  await shot(page, 's7-fix-documents');

  // Scenario 7 (API contract)
  const api = await apiAs(fx, 'analyst');
  const r = await api.patch(`/api/workspaces/${wsId}`, { data: { stage: 'ready' } });
  expect(r.status()).toBe(409);
  const j = E(await r.json());
  expect(j.code).toBe('not_ready');
  expect(j.message).toBe('1 required document is missing or expired. Replace it in the vault, or ask a Bid Manager to override with a reason.');
  expect(j.details.blockers).toEqual([{ itemId: 'oem_authorization', label: 'OEM authorisation certificate (MAF) for this bid', state: 'expired' }]);
  expect((await (await api.get(`/api/workspaces/${wsId}`)).json()).workspace.stage).toBe('go');
  await api.dispose();
});

test('S8 no analysis: Ready to submit -> 409 conflict not_analysed; S15 card readiness 0 / "Not analysed"', async ({ page, context }) => {
  const api = await apiAs(fx, 'analyst');
  const r = await api.patch(`/api/workspaces/${ws2Id}`, { data: { stage: 'ready' } });
  expect(r.status()).toBe(409);
  const j = E(await r.json());
  expect(j.code).toBe('conflict');
  expect(j.message).toBe('Analyse the tender before marking the bid ready to submit.');
  expect(j.details.reason).toBe('not_analysed');

  // Scenario 15
  const list = await (await api.get('/api/workspaces')).json();
  const card = list.items.find((i: any) => i.id === ws2Id);
  expect(card.readiness).toEqual({ percent: 0, total: 0, covered: 0, blockers: 0, analysed: false });
  const detail = await (await api.get(`/api/workspaces/${ws2Id}`)).json();
  expect(detail.readiness.analysed).toBe(false);
  await api.dispose();

  await signInAs(context, fx, 'analyst');
  await page.goto(`/workspaces/${ws2Id}`);
  await expect(page.getByRole('navigation', { name: 'Bid steps' }).getByRole('button', { name: /Documents/ })).toContainText('Not analysed');
  // UI path: the toast for the not_analysed conflict
  await page.getByRole('button', { name: /Change stage/ }).click();
  await page.getByRole('menuitem').nth(4).click();
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Analyse the tender before marking the bid ready to submit.' });
  await expect(toast).toBeVisible();
  await shot(page, 's8-s15-not-analysed');
});

test('S9 move to Preparing: 200, toast, position, activity "moved it from Go to Preparing"', async ({ page, context }) => {
  await signInAs(context, fx, 'analyst');
  await page.goto(`/workspaces/${wsId}`);
  await page.getByRole('button', { name: /Change stage/ }).click();
  const patch = page.waitForResponse((r) => r.url().includes(`/api/workspaces/${wsId}`) && r.request().method() === 'PATCH');
  await page.getByRole('menuitem').filter({ hasText: 'Preparing' }).click();
  const resp = await patch;
  expect(resp.status()).toBe(200);
  expect((await resp.json()).stage).toBe('preparing');
  await expect(page.getByText('Moved to Preparing')).toBeVisible();
  await expect(page.getByRole('button', { name: /Stage: Preparing\./ })).toBeVisible();
  await expect(page.getByText(/moved it from Go to Preparing/)).toBeVisible();
  await shot(page, 's9-preparing');

  const acts = await activityOf('analyst', 'workspace', wsId);
  const ch = acts.find((a) => a.action === 'workspace.stage_changed');
  expect(ch?.meta).toMatchObject({ from: 'go', to: 'preparing' });
  expect(ch?.user?.id).toBe(fx.users.analyst.id);
  const api = await apiAs(fx, 'analyst');
  const w = (await (await api.get(`/api/workspaces/${wsId}`)).json()).workspace;
  expect(w.stage).toBe('preparing');
  expect(w.position).toBe(1); // only workspace in Preparing: max(0)+1 (position is 1-based per spec)
  await api.dispose();
});

test('S10 Bid Manager makes the Analyst owner and assigns the Viewer: toast, avatars, notification, activity', async ({ page, context }) => {
  const analystApi = await apiAs(fx, 'analyst');
  // Start from owner = Bid Manager so the hand-over to the Analyst is a real change
  const pre = await analystApi.patch(`/api/workspaces/${wsId}`, { data: { ownerId: fx.users.bid_manager.id } });
  expect(pre.status()).toBe(200);
  const bmApi = await apiAs(fx, 'bid_manager');
  const countFor = async (api: any) => (await (await api.get('/api/notifications')).json()).items.filter((n: any) => n.title === `You were assigned to ${BID()}`).length;
  const bmBefore = await countFor(bmApi); // the set-up step above notified the Bid Manager once

  await signInAs(context, fx, 'bid_manager');
  await page.goto(`/workspaces/${wsId}`);
  await page.getByRole('button', { name: 'Owner and assignees' }).click();
  const pop = page.getByRole('dialog');
  const analystRow = pop.locator('li').filter({ hasText: fx.users.analyst.email });
  await analystRow.getByRole('button', { name: 'Own', exact: true }).click();
  await expect(page.getByText('Owner updated')).toBeVisible();
  await pop.getByRole('button', { name: `Assign ${fx.users.viewer.name}` }).click();
  await expect(pop.getByRole('button', { name: `Unassign ${fx.users.viewer.name}` })).toBeVisible();
  await shot(page, 's10-owner-popover');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Owner and assignees' })).toContainText(`Owner ${fx.users.analyst.name.split(' ')[0]}`);

  const w = (await (await analystApi.get(`/api/workspaces/${wsId}`)).json()).workspace;
  expect(w.owner.id).toBe(fx.users.analyst.id);
  expect(w.assignees.map((a: any) => a.id)).toEqual([fx.users.viewer.id]);

  const viewerApi = await apiAs(fx, 'viewer');
  const vn = (await (await viewerApi.get('/api/notifications')).json()).items.filter((n: any) => n.title === `You were assigned to ${BID()}`);
  expect(vn).toHaveLength(1);
  expect(vn[0].link).toBe(`/workspaces/${wsId}`);
  const an = (await (await analystApi.get('/api/notifications')).json()).items.filter((n: any) => n.title === `You were assigned to ${BID()}`);
  expect(an.length).toBeGreaterThanOrEqual(1);
  expect(await countFor(bmApi)).toBe(bmBefore); // the acting Bid Manager is never notified of their own action
  const acts = await activityOf('analyst', 'workspace', wsId);
  expect(acts.some((a) => a.action === 'workspace.assigned')).toBe(true);
  await Promise.all([analystApi.dispose(), viewerApi.dispose(), bmApi.dispose()]);
});

test('S11 API validation: non-member assignee 400; unknown property 400; unknown stage 400', async () => {
  const api = await apiAs(fx, 'analyst');
  const r = await api.patch(`/api/workspaces/${wsId}`, { data: { assigneeIds: [fx.outsider.id] } });
  expect(r.status()).toBe(400);
  const j = E(await r.json());
  expect(j.code).toBe('validation_error');
  expect(j.message).toBe('Only members of your organization can be assigned');
  expect(j.details.fields.assigneeIds).toBe('Not a member of this organization');
  expect((await api.patch(`/api/workspaces/${wsId}`, { data: { foo: 1 } })).status()).toBe(400);
  expect((await api.patch(`/api/workspaces/${wsId}`, { data: { stage: 'won_big' } })).status()).toBe(400);
  await api.dispose();
});

test('S12 due date: stored 18:00 IST, max = closing date, warning when later, Clear sets null', async ({ page, context }) => {
  await signInAs(context, fx, 'analyst');
  await page.goto(`/workspaces/${wsId}`);
  const dueBtn = page.getByRole('button', { name: 'Internal due date' });
  await dueBtn.click();
  const input = page.getByRole('textbox', { name: 'Due date' });
  const endIst = new Date(new Date(fx.tender.endAt).getTime() + 330 * 60_000).toISOString().slice(0, 10);
  await expect(input).toHaveAttribute('max', endIst);
  const target = new Date(Date.now() + 5 * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
  await input.fill(target);
  await expect(page.getByText('Due date updated')).toBeVisible();
  const api = await apiAs(fx, 'analyst');
  let w = (await (await api.get(`/api/workspaces/${wsId}`)).json()).workspace;
  expect(w.dueAt).toBe(new Date(`${target}T18:00:00+05:30`).toISOString());
  await shot(page, 's12-due-set');

  // later than closing -> warning border
  const later = new Date(new Date(fx.tender.endAt).getTime() + 3 * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
  await input.fill(later);
  await expect(dueBtn).toHaveClass(/border-warning/);
  await shot(page, 's12-due-late-warning');
  await input.fill(target);

  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByText('Set date')).toBeVisible();
  w = (await (await api.get(`/api/workspaces/${wsId}`)).json()).workspace;
  expect(w.dueAt).toBeNull();
  await shot(page, 's12-due-cleared');
  await api.dispose();
});

test('S13 Viewer sees no dropdown or edit controls anywhere', async ({ page, context }) => {
  await signInAs(context, fx, 'viewer');
  await page.goto(`/workspaces/${wsId}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(fx.tender.title);
  await expect(page.getByRole('button', { name: /Change stage/ })).toHaveCount(0);
  await expect(page.locator('h1').locator('xpath=ancestor::div[contains(@class,"relative")][1]').locator('svg.lucide-chevron-down')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Owner and assignees' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Internal due date' })).toBeDisabled();
  const forbidden = /override|build|rebuild|save|mark.*submitted|record.*submi|generate|upload|auto-match|not available|post comment|^send$/i;
  for (const step of ['qualify', 'documents', 'annexures', 'packet', 'submit']) {
    await page.goto(`/workspaces/${wsId}?step=${step}`);
    await expect(page.getByRole('navigation', { name: 'Bid steps' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const names = await page.getByRole('button').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim()));
    // "Build the packet" on the Annexures step is a next-step navigation button (onNext), not a build action; the real build action lives on the Packet step.
    const bad = names.filter((n) => forbidden.test(n) && !/^Build the packet\s*$/.test(n));
    expect(bad, `controls visible to Viewer on step ${step}`).toEqual([]);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    if (step === 'documents' || step === 'submit') await shot(page, `s13-viewer-${step}`);
  }
});

test('S14 won/lost from Go -> 409 invalid_transition; allowed from Submitted', async () => {
  const api = await apiAs(fx, 'analyst');
  // Moving INTO Go is the Bid Manager's call (#527): an Analyst is refused, a Bid Manager succeeds.
  const bm = await apiAs(fx, 'bid_manager');
  const refused = await api.patch(`/api/workspaces/${wsId}`, { data: { stage: 'go' } });
  expect(refused.status()).toBe(403);
  expect(E(await refused.json())).toMatchObject({ code: 'forbidden', message: 'Only a Bid Manager or Owner can make the Go / No-Go decision.' });
  const refusedDrop = await api.patch(`/api/workspaces/${wsId}`, { data: { stage: 'dropped' } });
  expect(refusedDrop.status()).toBe(403);
  const g = await bm.patch(`/api/workspaces/${wsId}`, { data: { stage: 'go' } });
  expect(g.status()).toBe(200);
  await bm.dispose();
  for (const to of ['won', 'lost']) {
    const r = await api.patch(`/api/workspaces/${wsId}`, { data: { stage: to } });
    expect(r.status()).toBe(409);
    const j = E(await r.json());
    expect(j.code).toBe('invalid_transition');
    expect(j.message).toBe('Record the submission on GeM first — a bid can only be won or lost after it was submitted.');
  }
  expect((await (await api.get(`/api/workspaces/${wsId}`)).json()).workspace.stage).toBe('go');
  expect((await api.patch(`/api/workspaces/${wsId}`, { data: { stage: 'submitted' } })).status()).toBe(200);
  const won = await api.patch(`/api/workspaces/${wsId}`, { data: { stage: 'won' } });
  expect(won.status()).toBe(200);
  expect((await won.json()).stage).toBe('won');
  await api.dispose();
});

test('S14 UI: Won/Lost rows are disabled with a hint while in Go', async ({ page, context }) => {
  await signInAs(context, fx, 'analyst');
  await page.goto(`/workspaces/${ws2Id}`); // Identified
  await page.getByRole('button', { name: /Change stage/ }).click();
  const won = page.getByRole('menuitem').filter({ hasText: 'Won' });
  await expect(won).toHaveAttribute('aria-disabled', 'true');
  await expect(won).toContainText('Mark as submitted first');
  await shot(page, 's14-won-disabled');
});

test('layout @mobile: header stacks, step strip scrolls, no horizontal page scroll', async ({ page, context }) => {
  await createWorkspace(fx); // idempotent (also lets the mobile project run this test alone)
  await signInAs(context, fx, 'analyst');
  await page.goto(`/workspaces/${fx.workspaceId}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const vp = page.viewportSize()!;
  const h1 = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
  const elig = await page.getByRole('button', { name: /Eligibility/ }).boundingBox();
  if (elig && vp.width < 1024) expect(elig.y).toBeGreaterThanOrEqual(h1.y + h1.height - 1); // stacked below the title
  const ox = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(ox.sw).toBeLessThanOrEqual(ox.cw);
  const strip = page.getByRole('navigation', { name: 'Bid steps' });
  const sc = await strip.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  if (vp.width < 640) {
    expect(sc.sw).toBeGreaterThan(sc.cw); // strip overflows and scrolls inside itself
    await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(strip.getByRole('button', { name: /Submit/ })).toBeInViewport();
  }
  await shot(page, 'layout-mobile');
  // the owner/due row and stage controls remain reachable
  await expect(page.getByRole('button', { name: 'Owner and assignees' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Internal due date' })).toBeVisible();
  const ox2 = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(ox2).toBe(true);
});
