/**
 * Spec 006 / US3 (#181): override a blocking item with a reason; coordinate in the Discussion rail.
 * QA task T040 (#226). Acceptance scenarios 1-11 of the spec; numbering is kept in the test names (S1 ... S11).
 *
 * Tests are independent (no serial mode): each resets override/stage state it touches. The first comment-related test
 * (S8) runs before any comment exists so the empty state can be asserted.
 */
import type { Page } from '@playwright/test';
import { test, expect, evidence, collectRunArtifacts, a11y } from '../support/fixtures';
import { seedApplyFixture, newApi, apiAs, signInAs, createWorkspace, setChecklist, upload, CHECKLIST, type ApplyFixture } from '../support/seed-apply';

const SPEC = '006';
const STORY = 'US3';
const DAY = 86_400_000;
const OEM = 'oem_authorization';
const OEM_LABEL = 'OEM authorisation certificate (MAF) for this bid';
const REASON = 'Renewed MAF arriving tomorrow from Dell';

let fx: ApplyFixture;
let wsId = '';

const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const toastWith = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text });
const row = (page: Page, id: string) => page.locator(`#item-${id}`);
const E = (body: any) => body.error ?? body;

async function call(role: 'owner' | 'bid_manager' | 'analyst' | 'viewer', method: 'get' | 'post' | 'delete' | 'patch', url: string, data?: unknown) {
  const api = await apiAs(fx, role);
  const r = await api[method](url, data === undefined ? undefined : { data });
  const text = await r.text();
  await api.dispose();
  let body: any = {};
  try { body = JSON.parse(text); } catch { /* 204 */ }
  return { status: r.status(), body };
}
const detail = async (role: 'analyst' | 'viewer' | 'bid_manager' = 'analyst') => (await call(role, 'get', `/api/workspaces/${wsId}`)).body;
/** Remove the OEM override (if any) and return the workspace to stage `go`. */
async function reset() {
  await call('bid_manager', 'delete', `/api/workspaces/${wsId}/overrides/${OEM}`);
  // Moving into Go is the Bid Manager's call (#527), so the reset runs as a bid_manager.
  await call('bid_manager', 'patch', `/api/workspaces/${wsId}`, { stage: 'go' });
}
async function openDocs(page: Page, context: any, role: 'owner' | 'bid_manager' | 'analyst' | 'viewer') {
  await signInAs(context, fx, role);
  await page.goto(`/workspaces/${wsId}?step=documents`);
  await expect(page.getByRole('tablist', { name: 'Filter checklist' })).toBeVisible();
}

test.beforeAll(async () => {
  const api = await newApi();
  fx = await seedApplyFixture(api);
  await api.dispose();
  // Owner creates the workspace so the analyst (comment author) is neither owner nor assignee.
  wsId = (await createWorkspace(fx, fx.tender.id, 'owner')).id;
  // Assign the bid manager so owner + bid manager are the "owner and assignees" who get comment notifications.
  const r = await call('owner', 'patch', `/api/workspaces/${wsId}`, { assigneeIds: [fx.users.bid_manager.id] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
});

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

test('S1 Analyst sees no Override button; POST overrides as Analyst is 403', async ({ page, context }) => {
  await reset();
  await openDocs(page, context, 'analyst');
  await expect(row(page, OEM)).toContainText('Expired');
  await expect(row(page, OEM).getByRole('button', { name: /Override/ })).toHaveCount(0);
  await shot(page, 's1-analyst-no-override');
  const r = await call('analyst', 'post', `/api/workspaces/${wsId}/overrides`, { itemId: OEM, reason: REASON });
  expect(r.status).toBe(403);
  expect(JSON.stringify(r.body)).toContain('You need to be at least a Bid Manager to do that');
  expect((await detail()).workspace.overrides ?? []).toHaveLength(0);
});

test('S2 dialog copy, hint, 5-char rule, inline guidance @mobile', async ({ page, context }) => {
  await reset();
  await openDocs(page, context, 'bid_manager');
  await row(page, OEM).getByRole('button', { name: /^Override$/ }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('heading', { name: `Override “${OEM_LABEL}”` })).toBeVisible();
  await expect(dlg).toContainText('The item stops blocking “Ready to submit”. Your name and reason are recorded in the activity log. Make sure the bid will not be rejected for it.');
  await expect(dlg).toContainText('e.g. “Renewed MAF arrives Friday; upload before submission.”');
  const ta = dlg.getByRole('textbox');
  expect(await ta.getAttribute('maxlength')).toBe('500');
  await expect(dlg.locator('label', { hasText: 'Reason' })).toBeVisible();
  const confirm = dlg.getByRole('button', { name: /^Override$/ });
  await expect(confirm).toBeDisabled();
  await ta.fill('abcd');
  await expect(dlg.getByText('Explain in a few more words')).toBeVisible();
  await expect(confirm).toBeDisabled();
  await shot(page, 's2-dialog-4-chars');
  await ta.fill('    ab    '); // trimmed length 2
  await expect(confirm).toBeDisabled();
  await ta.fill('abcde');
  await expect(dlg.getByText('Explain in a few more words')).toHaveCount(0);
  await expect(confirm).toBeEnabled();
  await shot(page, 's2-dialog-5-chars');
  await a11y(page, 's2-override-dialog', { include: ['[role="dialog"]'] });
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  expect((await detail()).workspace.overrides ?? []).toHaveLength(0);
});

test('S3 confirm override: 201 body, toast, Overridden row, 100%, activity sentence', async ({ page, context }) => {
  await reset();
  await openDocs(page, context, 'bid_manager');
  await expect(page.getByRole('img', { name: 'Readiness 83 percent' })).toBeVisible();
  await row(page, OEM).getByRole('button', { name: /^Override$/ }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('textbox').fill(REASON);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/workspaces/${wsId}/overrides`) && r.request().method() === 'POST'),
    dlg.getByRole('button', { name: /^Override$/ }).click(),
  ]);
  expect(resp.status()).toBe(201);
  const body = await resp.json();
  expect(body.readiness.canMarkReady).toBe(true);
  expect(body.workspace.overrides[0]).toMatchObject({ itemId: OEM, reason: REASON, by: fx.users.bid_manager.id, byName: fx.users.bid_manager.name });
  expect(typeof body.workspace.overrides[0].at).toBe('string');
  await expect(toastWith(page, 'Override recorded')).toBeVisible();
  await expect(row(page, OEM)).toContainText('Overridden');
  await expect(row(page, OEM)).toContainText(`Override: ${REASON}`);
  const ring = page.getByRole('img', { name: 'Readiness 100 percent' });
  await expect(ring).toBeVisible();
  await expect(page.getByText('All required documents are covered')).toBeVisible();
  const rail = page.getByRole('complementary', { name: 'Discussion and activity' });
  await expect(rail).toContainText(`overrode “${OEM_LABEL}”: ${REASON}`);
  await expect(rail).toContainText(fx.users.bid_manager.name);
  await shot(page, 's3-overridden-100');
  await a11y(page, 's3-overridden', { include: [`#item-${OEM}`, 'aside[aria-label="Discussion and activity"]'] });
});

test('S4 Analyst moves stage to Ready to submit -> 200 once overridden (409 before)', async () => {
  await reset();
  const before = await call('analyst', 'patch', `/api/workspaces/${wsId}`, { stage: 'ready' });
  expect(before.status, 'guard blocks without override').toBe(409);
  const ov = await call('bid_manager', 'post', `/api/workspaces/${wsId}/overrides`, { itemId: OEM, reason: REASON });
  expect(ov.status).toBe(201);
  const r = await call('analyst', 'patch', `/api/workspaces/${wsId}`, { stage: 'ready' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.stage ?? r.body.workspace?.stage).toBe('ready');
  await reset();
});

test('S5 Remove override: 200, one blocker, toast, row Expired again; delete missing -> 404', async ({ page, context }) => {
  await reset();
  await call('bid_manager', 'post', `/api/workspaces/${wsId}/overrides`, { itemId: OEM, reason: REASON });
  await openDocs(page, context, 'bid_manager');
  await expect(row(page, OEM)).toContainText('Overridden');
  await shot(page, 's5-before-remove');
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/overrides/${OEM}`) && r.request().method() === 'DELETE'),
    row(page, OEM).getByRole('button', { name: 'Remove override' }).click(),
  ]);
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body.readiness.blockers ?? body.readiness.items.filter((i: any) => i.blocking)).toHaveLength(1);
  expect(body.readiness.canMarkReady).toBe(false);
  await expect(toastWith(page, 'Override removed')).toBeVisible();
  await expect(row(page, OEM)).toContainText('Expired');
  await expect(row(page, OEM)).not.toContainText('Overridden');
  await expect(page.getByText('1 blocker before “Ready to submit”')).toBeVisible();
  await shot(page, 's5-after-remove');
  const again = await call('bid_manager', 'delete', `/api/workspaces/${wsId}/overrides/${OEM}`);
  expect(again.status).toBe(404);
  expect(JSON.stringify(again.body)).toContain('Override not found');
});

test('S6 API 400: empty reason and unknown itemId', async () => {
  await reset();
  const empty = await call('bid_manager', 'post', `/api/workspaces/${wsId}/overrides`, { itemId: OEM, reason: '' });
  expect(empty.status).toBe(400);
  expect(JSON.stringify(empty.body)).toContain('Explain why in a few words (at least 5 characters)');
  const short = await call('bid_manager', 'post', `/api/workspaces/${wsId}/overrides`, { itemId: OEM, reason: 'abcd' });
  expect(short.status).toBe(400);
  const unknown = await call('bid_manager', 'post', `/api/workspaces/${wsId}/overrides`, { itemId: 'no_such_item', reason: REASON });
  expect(unknown.status).toBe(400);
  expect(JSON.stringify(unknown.body)).toContain('Not an item of this bid’s checklist');
  const long = await call('bid_manager', 'post', `/api/workspaces/${wsId}/overrides`, { itemId: OEM, reason: 'x'.repeat(501) });
  expect(long.status, 'reason over 500 chars').toBe(400);
  expect((await detail()).workspace.overrides ?? []).toHaveLength(0);
});

test('S7 409 nothing_to_override for Ready, Expiring and Generated items', async () => {
  // Add a mandatory ISO item with a document expiring in ~10 days -> state "expiring".
  const analystApi = await newApi(fx.states.analyst);
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  await upload(analystApi, 'iso', { type: 'iso', title: 'ISO 9001', issueDate: ymd(Date.now() - 300 * DAY), expiryDate: ymd(Date.now() + 10 * DAY) });
  await analystApi.dispose();
  await setChecklist(fx, [...CHECKLIST, { id: 'iso', label: 'ISO 9001 certificate', docType: 'iso', mandatory: true, reason: 'Quality' }]);
  try {
    const d = await detail();
    const states = Object.fromEntries(d.readiness.items.map((i: any) => [i.item.id, i.state]));
    expect(states.gst, JSON.stringify(states)).toBe('ready');
    expect(states.iso, JSON.stringify(states)).toBe('expiring');
    expect(states.non_blacklisting, JSON.stringify(states)).toBe('generated');
    for (const itemId of ['gst', 'iso', 'non_blacklisting']) {
      const r = await call('bid_manager', 'post', `/api/workspaces/${wsId}/overrides`, { itemId, reason: REASON });
      expect(r.status, `${itemId}: ${JSON.stringify(r.body)}`).toBe(409);
      expect(JSON.stringify(r.body)).toContain('nothing_to_override');
      expect(JSON.stringify(r.body)).toContain('Only a missing or expired item can be overridden.');
    }
    expect((await detail()).workspace.overrides ?? [], 'nothing stored silently').toHaveLength(0);
  } finally {
    await setChecklist(fx, CHECKLIST);
  }
});

test('S8 empty Discussion, Ctrl+Enter comment, avatar/time, notifications for owner + assignee', async ({ page, context }) => {
  await openDocs(page, context, 'analyst');
  const rail = page.getByRole('complementary', { name: 'Discussion and activity' });
  await expect(rail.getByText('No comments yet. Coordinate who is chasing which document.')).toBeVisible();
  await shot(page, 's8-empty-discussion');
  const box = rail.getByRole('textbox', { name: 'Write a comment' });
  await box.fill('Chasing Dell for the renewed MAF');
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/workspaces/${wsId}/comments`) && r.request().method() === 'POST'),
    box.press('Control+Enter'),
  ]);
  expect(resp.status()).toBe(201);
  const body = await resp.json();
  expect(body).toMatchObject({ body: 'Chasing Dell for the renewed MAF', user: { id: fx.users.analyst.id, name: fx.users.analyst.name } });
  expect(body.id).toBeTruthy();
  expect(body.createdAt).toBeTruthy();
  await expect(box).toHaveValue('');
  const item = rail.locator('ol').first().locator('li').first();
  await expect(item).toContainText('Chasing Dell for the renewed MAF');
  await expect(item).toContainText(fx.users.analyst.name);
  await expect(item.locator('time')).toBeVisible();
  await expect(item.locator('time')).toContainText(/just now|second|now|\bago\b|minute/i);
  await shot(page, 's8-comment-posted');
  // Second comment with the send button
  await box.fill('Second note via the button');
  await rail.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(rail).toContainText('Second note via the button');

  // Notifications: owner + assignee (bid manager) get it, the author does not.
  const title = `New comment on ${fx.tender.bidNumber}`;
  for (const role of ['owner', 'bid_manager'] as const) {
    const n = await call(role, 'get', '/api/notifications?pageSize=50');
    const hit = (n.body.items as any[]).find((x) => x.title === title && String(x.body).startsWith(`${fx.users.analyst.name}: Chasing Dell`));
    expect(hit, `${role} notification: ${JSON.stringify(n.body.items?.map((i: any) => i.title))}`).toBeTruthy();
  }
  const authorN = await call('analyst', 'get', '/api/notifications?pageSize=50');
  expect((authorN.body.items as any[]).filter((x) => x.title === title), 'author is not notified').toHaveLength(0);

  // Owner's bell in the UI
  await signInAs(context, fx, 'owner');
  await page.goto(`/workspaces/${wsId}`);
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByText(title).first()).toBeVisible();
  await shot(page, 's8-owner-bell');
});

test('S9 empty/whitespace/over-long comments rejected; Viewer sees comments but no composer; Viewer POST 403', async ({ page, context }) => {
  const url = `/api/workspaces/${wsId}/comments`;
  for (const body of ['', '   \n\t ']) {
    const r = await call('analyst', 'post', url, { body });
    expect(r.status, JSON.stringify(body)).toBe(400);
    expect(JSON.stringify(r.body)).toContain('Write a comment');
  }
  const over = await call('analyst', 'post', url, { body: 'y'.repeat(4001) });
  expect(over.status).toBe(400);
  const max = await call('analyst', 'post', url, { body: 'z'.repeat(4000) });
  expect(max.status, 'exactly 4000 is allowed').toBe(201);
  await call('analyst', 'delete', `${url}/${max.body.id}`);
  const viewerPost = await call('viewer', 'post', url, { body: 'hello' });
  expect(viewerPost.status).toBe(403);

  await openDocs(page, context, 'viewer');
  const rail = page.getByRole('complementary', { name: 'Discussion and activity' });
  await expect(rail).toContainText('Chasing Dell for the renewed MAF');
  await expect(rail.getByRole('textbox', { name: 'Write a comment' })).toHaveCount(0);
  await expect(rail.getByRole('button', { name: 'Comment', exact: true })).toHaveCount(0);
  await shot(page, 's9-viewer-no-composer');
  // composer disabled for blank body
  await signInAs(context, fx, 'analyst');
  await page.goto(`/workspaces/${wsId}`);
  await expect(page.getByRole('complementary', { name: 'Discussion and activity' }).getByRole('button', { name: 'Comment', exact: true })).toBeDisabled();
});

test('S10 Discussion toggle at 375px and sticky rail at >=1024px @mobile', async ({ page, context }) => {
  if (!(await detail()).comments.length) expect((await call('analyst', 'post', `/api/workspaces/${wsId}/comments`, { body: 'Chasing Dell for the renewed MAF' })).status).toBe(201);
  await signInAs(context, fx, 'analyst');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/workspaces/${wsId}?step=documents`);
  const n = (await detail()).comments.length;
  const seg = page.getByRole('radiogroup', { name: 'Workspace view' }).or(page.getByRole('group', { name: 'Workspace view' })).or(page.locator('[aria-label="Workspace view"]'));
  await expect(seg).toBeVisible();
  await expect(seg).toContainText('Bid steps');
  await expect(seg).toContainText(`Discussion (${n})`);
  await expect(page.getByRole('navigation', { name: 'Bid steps' })).toBeVisible();
  await shot(page, 's10-mobile-steps');
  await seg.getByText(/^Discussion/).click();
  const rail = page.getByRole('complementary', { name: 'Discussion and activity' });
  await expect(rail).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Bid steps' })).toBeHidden();
  await expect(rail).toContainText('Chasing Dell for the renewed MAF');
  await expect(rail.getByRole('heading', { name: /Activity/ })).toBeVisible();
  const w = (await rail.boundingBox())!.width;
  expect(w, 'rail is full-width on mobile').toBeGreaterThan(375 - 48);
  const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }));
  expect(m.s).toBeLessThanOrEqual(m.i);
  await shot(page, 's10-mobile-discussion');
  await seg.getByText('Bid steps').click();
  await expect(page.getByRole('navigation', { name: 'Bid steps' })).toBeVisible();
  await expect(rail).toBeHidden();

  // >= 1024px: sticky 300-340px right column, segmented control hidden
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(seg).toBeHidden();
  await expect(rail).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Bid steps' })).toBeVisible();
  const css = await rail.evaluate((el) => ({ pos: getComputedStyle(el).position, w: el.getBoundingClientRect().width, x: el.getBoundingClientRect().x }));
  expect(css.pos).toBe('sticky');
  expect(css.w).toBeGreaterThanOrEqual(300);
  expect(css.w).toBeLessThanOrEqual(340);
  expect(css.x).toBeGreaterThan(900);
  await shot(page, 's10-desktop-rail');
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(seg).toBeHidden();
  const w1024 = (await rail.boundingBox())!.width;
  expect(w1024).toBeGreaterThanOrEqual(300);
  expect(w1024).toBeLessThanOrEqual(340);
  await a11y(page, 's10-rail', { include: ['aside[aria-label="Discussion and activity"]'] });
});

test('S11 @mention notifies a non-owner/non-assignee; author or Bid Manager can delete a comment, others 403', async ({ page, context }) => {
  const viewer = fx.users.viewer; // member who is neither owner nor assignee
  const mention = `@${viewer.name} can you check the MAF scan?`;
  const posted = await call('analyst', 'post', `/api/workspaces/${wsId}/comments`, { body: mention });
  expect(posted.status).toBe(201);
  const vn = await call('viewer', 'get', '/api/notifications?pageSize=50');
  const hit = (vn.body.items as any[]).find((x) => String(x.title).includes('mentioned you') && String(x.body).includes('can you check the MAF scan?'));
  expect(hit, JSON.stringify(vn.body.items?.map((i: any) => i.title))).toBeTruthy();
  expect(hit.title).toBe(`${fx.users.analyst.name} mentioned you on ${fx.tender.bidNumber}`);
  expect((vn.body.items as any[]).filter((x) => String(x.body).includes('can you check the MAF scan?'))).toHaveLength(1);
  // owner/assignee still get the regular comment notification (no duplicate for the mentioned viewer)
  const on = await call('owner', 'get', '/api/notifications?pageSize=50');
  expect((on.body.items as any[]).some((x) => String(x.body).includes('can you check the MAF scan?'))).toBe(true);
  // no mention of a non-member -> nobody extra
  const nobody = await call('analyst', 'post', `/api/workspaces/${wsId}/comments`, { body: '@Nobody Atall hello' });
  expect(nobody.status).toBe(201);
  await call('analyst', 'delete', `/api/workspaces/${wsId}/comments/${nobody.body.id}`);

  // Delete permissions via API
  const url = (id: string) => `/api/workspaces/${wsId}/comments/${id}`;
  const forbidden = await call('analyst', 'delete', url(posted.body.id).replace(posted.body.id, (await call('bid_manager', 'post', `/api/workspaces/${wsId}/comments`, { body: 'Bid manager note' })).body.id));
  expect(forbidden.status, 'analyst cannot delete someone else’s comment').toBe(403);
  expect((await call('viewer', 'delete', url(posted.body.id))).status, 'viewer cannot delete').toBe(403);
  expect((await call('analyst', 'delete', url('00000000-0000-4000-8000-000000000000'))).status).toBe(404);

  // UI: author deletes own; bid manager deletes someone else's
  await signInAs(context, fx, 'analyst');
  await page.goto(`/workspaces/${wsId}`);
  const rail = page.getByRole('complementary', { name: 'Discussion and activity' });
  const bmNote = rail.locator('li').filter({ hasText: 'Bid manager note' });
  await expect(bmNote.getByRole('button', { name: /Comment actions/ }), 'analyst has no menu on others’ comments').toHaveCount(0);
  const mine = rail.locator('li').filter({ hasText: 'can you check the MAF scan?' });
  await mine.getByRole('button', { name: /Comment actions/ }).click();
  await page.getByRole('menuitem', { name: 'Delete comment' }).click();
  await expect(page.getByRole('alertdialog').or(page.getByRole('dialog'))).toContainText('Delete this comment?');
  await shot(page, 's11-delete-confirm');
  const [del] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/comments/') && r.request().method() === 'DELETE'),
    page.getByRole('button', { name: 'Delete comment' }).last().click(),
  ]);
  expect(del.status()).toBe(204);
  await expect(toastWith(page, 'Comment deleted')).toBeVisible();
  await expect(rail).not.toContainText('can you check the MAF scan?');
  await shot(page, 's11-own-deleted');

  await signInAs(context, fx, 'bid_manager');
  await page.goto(`/workspaces/${wsId}`);
  const other = rail.locator('li').filter({ hasText: 'Chasing Dell for the renewed MAF' });
  await other.getByRole('button', { name: /Comment actions/ }).click();
  await page.getByRole('menuitem', { name: 'Delete comment' }).click();
  const [del2] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/comments/') && r.request().method() === 'DELETE'),
    page.getByRole('button', { name: 'Delete comment' }).last().click(),
  ]);
  expect(del2.status()).toBe(204);
  await expect(rail).not.toContainText('Chasing Dell for the renewed MAF');
  await shot(page, 's11-bm-deleted-others');
  // Viewer has no delete menu at all
  await signInAs(context, fx, 'viewer');
  await page.goto(`/workspaces/${wsId}`);
  await expect(rail.getByRole('button', { name: /Comment actions/ })).toHaveCount(0);
  void E;
});

test('S12 Overridden row at 375px passes axe (NFR-006) @mobile', async ({ page, context }) => {
  await reset();
  const r = await call('bid_manager', 'post', `/api/workspaces/${wsId}/overrides`, { itemId: OEM, reason: REASON });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await signInAs(context, fx, 'bid_manager');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/workspaces/${wsId}?step=documents`);
  await expect(row(page, OEM)).toContainText('Overridden');
  await expect(row(page, OEM)).toContainText(`Override: ${REASON}`);
  await shot(page, 's12-overridden-row-375');
  await a11y(page, 's12-overridden-row', { include: [`#item-${OEM}`] });
  await reset();
});
