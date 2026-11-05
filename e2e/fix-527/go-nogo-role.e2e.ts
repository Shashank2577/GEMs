/**
 * QA for PR #556 / issue #527 item 5: the Go/No-Go call (moving a bid INTO `go` or `dropped`) is Bid Manager+.
 *
 * Acceptance criteria (owner decision) -> tests:
 *   AC1  Analyst gets 403 on PATCH stage go/dropped (cookie + API token); nothing is written
 *   AC2  Analyst cannot create a workspace directly into go (Go verdict -> "analysing"); Bid Manager / Owner can
 *   AC3  Bid Manager / Owner can decide Go and Drop (no regression)
 *   AC4  Analyst keeps every other move (incl. out of go/dropped, skipping Go)
 *   AC5  UI: Go/Dropped disabled with a keyboard-reachable tooltip in "Move to…" and the workspace stage dropdown
 *   AC6  UI: Kanban Go column lock + graceful refusal for pointer, touch and keyboard drags with no PATCH sent
 *   AC7  a11y: the refused drop is announced as locked, never "Dropped in Go."
 *   AC8  375 px: no horizontal overflow
 *   AC9  Bid Manager UI flows unchanged (Move to Go works; Drop asks for confirmation)
 *
 * Evidence: qa/evidence/fix-527/<name>.png (evidence()) and one .webm per test (collectRunArtifacts()).
 */
import { createNodeDb, analyses, tenders } from '../../packages/db/src/index';
import type { Locator, Page } from '@playwright/test';
import {
  test, expect, evidence, collectRunArtifacts, signupViaApi, uniqueUser, seedDemo, inviteAs, atPhone, noHorizontalOverflow,
} from '../support/fixtures';
import { seedApplyFixture, newApi, apiAs, E2E_DB_URL, CHECKLIST, type ApplyFixture } from '../support/seed-apply';

const SPEC = 'fix-527';
const STORY = '.'; // evidence lands directly in qa/evidence/fix-527/
const TIP = 'Only a Bid Manager can make the Go/No-Go call';
const REFUSAL = 'Only a Bid Manager or Owner can make the Go/No-Go call.';
const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);

/** API checks have no UI: render the observed request -> status lines as a page so the screenshot carries the evidence. */
async function proof(page: Page, name: string, title: string, lines: string[]) {
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  await page.setContent(`<body style="font:14px ui-monospace,monospace;padding:24px;background:#fff;color:#111"><h2>${esc(title)}</h2><pre style="white-space:pre-wrap">${lines.map(esc).join('\n')}</pre></body>`);
  await shot(page, name);
}

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

// ───────────── helpers ─────────────

const col = (page: Page, stage: string) => page.locator(`section[data-stage="${stage}"]`);
const colCards = (page: Page, stage: string) => col(page, stage).locator('ol > li').filter({ has: page.locator('a[href^="/workspaces/"]') });
const handleOf = (card: Locator) => card.getByRole('button', { name: /^Move (?!to…)/ });
const menuBtnOf = (card: Locator) => card.getByRole('button', { name: /^Move to…/ });
const isPatch = (r: { method(): string; url(): string }) => r.method() === 'PATCH' && /\/api\/workspaces\/[^/]+$/.test(r.url());
const isPatchResponse = (r: { request(): { method(): string; url(): string } }) => isPatch(r.request());

async function demoOrg(page: Page) {
  await signupViaApi(page, { ...uniqueUser('own'), name: 'Priya Sharma' });
  await seedDemo(page.request);
}
async function openPipeline(page: Page) {
  await page.goto('/pipeline');
  await expect(page.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeVisible();
  await expect(colCards(page, 'identified').first()).toBeVisible();
}
async function keyboardDrag(page: Page, handle: Locator, columns: number) {
  await page.waitForTimeout(300);
  await handle.focus();
  await page.keyboard.press('Space');
  for (let i = 0; i < columns; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250); }
  await page.keyboard.press('Space');
}
const wsIdOf = async (card: Locator) => (await card.locator('a[href^="/workspaces/"]').getAttribute('href'))!.split('/').pop()!;

/** A second tender with a done "go" analysis in the fixture org (so several roles can each create a workspace). */
async function addGoTender(fx: ApplyFixture, n: number) {
  const { db, close } = await createNodeDb(E2E_DB_URL);
  try {
    const endAt = new Date(Date.now() + 15 * 86_400_000);
    const [t] = await db.insert(tenders).values({
      bidNumber: `GEM/2026/B/7527${n}`, title: `QA #527 Go tender ${n}`, category: 'Laptop - Notebook', quantity: 10,
      organisation: 'Indian Oil Corporation Limited', state: 'Haryana', startAt: new Date(), endAt, emdAmount: 100000, estimatedValue: 1_000_000,
      items: [{ name: 'Laptop', quantity: 10, unit: 'nos' }], sourceUrl: 'https://bidplus.gem.gov.in/all-bids', contentHash: `qa527-${n}-${Date.now()}`,
    }).onConflictDoUpdate({ target: [tenders.source, tenders.bidNumber], set: { endAt, updatedAt: new Date() } }).returning();
    await db.insert(analyses).values({
      orgId: fx.orgId, tenderId: t.id, status: 'done', method: 'rules', checklist: CHECKLIST, score: 80, confidence: 0.8, verdict: 'go', requirements: [], factors: [],
    });
    return t.id;
  } finally { await close(); }
}

// ───────────── API criteria (AC1–AC4) ─────────────

test.describe('API: the Go/No-Go call by role', () => {
  test.describe.configure({ mode: 'serial' });
  let fx: ApplyFixture;
  test.beforeAll(async () => { const a = await newApi(); fx = await seedApplyFixture(a); await a.dispose(); });

  test('AC2 an Analyst cannot create a workspace straight into Go; Bid Manager and Owner can', async ({ page }) => {
    const analyst = await apiAs(fx, 'analyst');
    const created = await analyst.post(`/api/tenders/${fx.tender.id}/workspace`);
    expect(created.status()).toBe(201);
    const w = await created.json();
    expect(w.stage, 'Go verdict + Analyst -> analysing').toBe('analysing');
    // same through an API token
    const tok = (await (await analyst.post('/api/me/api-tokens', { data: { name: 'qa-527' } })).json()).token as string;
    const t2 = await addGoTender(fx, 2);
    const viaToken = await (await newApi()).post(`/api/tenders/${t2}/workspace`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(viaToken.status()).toBe(201);
    expect((await viaToken.json()).stage).toBe('analysing');
    // Bid Manager / Owner keep auto-Go
    const bm = await apiAs(fx, 'bid_manager');
    const t3 = await addGoTender(fx, 3);
    const bmCreated = await bm.post(`/api/tenders/${t3}/workspace`);
    expect(bmCreated.status()).toBe(201);
    expect((await bmCreated.json()).stage).toBe('go');
    const owner = await apiAs(fx, 'owner');
    const t4 = await addGoTender(fx, 4);
    const ownerCreated = await owner.post(`/api/tenders/${t4}/workspace`);
    expect((await ownerCreated.json()).stage).toBe('go');
    // the Analyst's bid shows up in the Bid Manager's "Awaiting your decision" queue (API + UI)
    const dash = await (await bm.get('/api/dashboard')).json();
    expect(dash.awaitingDecision.map((d: any) => d.workspaceId), 'analyst-created bid is awaiting the Bid Manager').toContain(w.id);
    await page.context().addCookies(fx.states.bid_manager.cookies);
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Skip for now' }).click({ timeout: 6000 }).catch(() => { /* already past onboarding */ });
    await page.waitForURL(/\/dashboard/);
    await expect(page.getByText('Awaiting your decision').first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Awaiting your decision' }).getByText(fx.tender.title)).toBeVisible();
    await shot(page, 'ac2-bm-dashboard-awaiting-analyst-created-bid');
    await proof(page, 'ac2-api-create-path', 'AC2 POST /api/tenders/:id/workspace on a Go verdict', [
      `Analyst (cookie)    -> 201 stage=${w.stage}`, `Analyst (API token) -> 201 stage=${(await viaToken.json()).stage}`,
      `Bid Manager         -> 201 stage=${(await bmCreated.json()).stage}`, `Owner               -> 201 stage=${(await ownerCreated.json()).stage}`,
    ]);
    fx.workspaceId = w.id;
  });

  test('AC1 Analyst 403 on PATCH go/dropped (cookie + token), nothing written; viewer stopped earlier', async ({ page }) => {
    const analyst = await apiAs(fx, 'analyst');
    const id = fx.workspaceId!;
    const tok = (await (await analyst.post('/api/me/api-tokens', { data: { name: 'qa-527-patch' } })).json()).token as string;
    const viaToken = await newApi();
    const before = (await (await analyst.get(`/api/workspaces/${id}`)).json()).workspace;
    const lines: string[] = [];
    for (const stage of ['go', 'dropped']) {
      const c = await analyst.patch(`/api/workspaces/${id}`, { data: { stage, position: 0 } });
      expect(c.status(), `cookie ${stage}`).toBe(403);
      const body = await c.json();
      expect(body.error).toEqual({ code: 'forbidden', message: REFUSAL });
      lines.push(`Analyst cookie PATCH {stage:'${stage}'} -> 403 ${JSON.stringify(body.error)}`);
      const t = await viaToken.patch(`/api/workspaces/${id}`, { data: { stage }, headers: { Authorization: `Bearer ${tok}` } });
      expect(t.status(), `token ${stage}`).toBe(403);
      expect((await t.json()).error.code).toBe('forbidden');
      lines.push(`Analyst API token PATCH {stage:'${stage}'} -> 403 forbidden`);
    }
    const after = (await (await analyst.get(`/api/workspaces/${id}`)).json()).workspace;
    expect(after.stage).toBe(before.stage);
    const viewer = await apiAs(fx, 'viewer');
    expect((await viewer.patch(`/api/workspaces/${id}`, { data: { stage: 'go' } })).status()).toBe(403);
    lines.push(`Viewer PATCH {stage:'go'} -> 403 (route gate)`);
    // cross-org: the outsider gets 404, not the role message
    const out = await newApi();
    await out.post('/api/auth/login', { data: { email: fx.outsider.email, password: fx.outsider.password } });
    expect((await out.patch(`/api/workspaces/${id}`, { data: { stage: 'go' } })).status()).toBe(404);
    lines.push(`Other-org user PATCH {stage:'go'} -> 404 (not 403)`, `Workspace stage after all refusals: ${after.stage} (unchanged)`);
    await proof(page, 'ac1-api-403', 'AC1 PATCH /api/workspaces/:id into go / dropped', lines);
  });

  test('AC3 + AC4 Bid Manager and Owner decide Go/Drop; the Analyst keeps every other move incl. out of go/dropped', async ({ page }) => {
    const id = fx.workspaceId!;
    const analyst = await apiAs(fx, 'analyst'), bm = await apiAs(fx, 'bid_manager'), owner = await apiAs(fx, 'owner');
    const lines: string[] = [];
    const patch = async (api: typeof analyst, stage: string) => {
      const status = (await api.patch(`/api/workspaces/${id}`, { data: { stage } })).status();
      lines.push(`${api === analyst ? 'Analyst' : api === bm ? 'Bid Manager' : 'Owner'} -> ${stage}: ${status}`);
      return status;
    };
    expect(await patch(analyst, 'preparing'), 'Analyst may skip Go (analysing -> preparing)').toBe(200);
    expect(await patch(analyst, 'analysing')).toBe(200);
    expect(await patch(analyst, 'identified')).toBe(200);
    expect(await patch(bm, 'go'), 'Bid Manager decides Go').toBe(200);
    expect(await patch(analyst, 'go'), 're-sending the current stage is a no-op').toBe(200);
    expect(await patch(analyst, 'preparing'), 'Analyst moves out of Go').toBe(200);
    expect(await patch(owner, 'dropped'), 'Owner decides No-Go').toBe(200);
    expect(await patch(analyst, 'analysing'), 'Analyst reverses a No-Go (deliberate, 006 amendment)').toBe(200);
    expect(await patch(bm, 'dropped')).toBe(200);
    expect(await patch(bm, 'go')).toBe(200);
    // the activity log records only the successful moves, by the right users
    const act = await (await owner.get(`/api/activity?entityType=workspace&entityId=${id}&pageSize=100`)).json();
    const moves = act.items.filter((a: any) => a.action === 'workspace.stage_changed');
    expect(moves.length).toBeGreaterThanOrEqual(8);
    expect(moves.some((m: any) => m.meta.to === 'go' && m.user?.id === fx.users.bid_manager.id)).toBe(true);
    expect(moves.every((m: any) => !(m.meta.to === 'go' || m.meta.to === 'dropped') || m.user?.id !== fx.users.analyst.id)).toBe(true);
    await proof(page, 'ac3-ac4-api-moves', 'AC3/AC4 stage moves by role (PATCH /api/workspaces/:id)', lines);
  });
});

// ───────────── UI criteria (AC5–AC9) ─────────────

test('AC5 Analyst: Go and Dropped are disabled with a keyboard-reachable tooltip in the card "Move to…" menu', async ({ page, browser }) => {
  await demoOrg(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  const card = colCards(ap, 'identified').first();
  await menuBtnOf(card).click();
  const patches: string[] = [];
  ap.on('request', (r) => { if (isPatch(r)) patches.push(r.url()); });
  for (const name of [/^Go/, /^Dropped/]) {
    const item = ap.getByRole('menuitem', { name });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toContainText('Bid Manager only');
    await item.focus(); // keyboard focus, no hover
    await expect(ap.getByRole('tooltip').filter({ hasText: TIP }).first()).toBeVisible();
  }
  await shot(ap, 'ac5-move-to-menu-go-disabled-focus-tooltip');
  await expect(ap.getByRole('menuitem', { name: /^Analysing/ })).not.toHaveAttribute('aria-disabled', 'true');
  await ap.getByRole('menuitem', { name: /^Go/ }).click({ force: true });
  await ap.waitForTimeout(300);
  expect(patches, 'selecting a disabled item sends nothing').toEqual([]);
});

test('AC5 Analyst: the workspace stage dropdown disables Go and Dropped with the tooltip; other stages work', async ({ page, browser }) => {
  await demoOrg(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  const id = await wsIdOf(colCards(ap, 'identified').first());
  await ap.goto(`/workspaces/${id}`);
  await ap.getByRole('button', { name: /Change stage/ }).click();
  for (const name of [/Go/, /Dropped/]) {
    const item = ap.getByRole('menuitem', { name }).first();
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await item.focus();
    await expect(ap.getByRole('tooltip').filter({ hasText: TIP }).first()).toBeVisible();
  }
  await shot(ap, 'ac5-workspace-stage-menu-dropped-disabled-focus-tooltip');
  const patches: string[] = [];
  ap.on('request', (r) => { if (isPatch(r)) patches.push(r.method()); });
  await ap.getByRole('menuitem', { name: /Dropped/ }).first().click({ force: true });
  await ap.waitForTimeout(300);
  expect(patches).toEqual([]);
  // another stage still works
  await ap.keyboard.press('Escape');
  await ap.getByRole('button', { name: /Change stage/ }).click();
  const resp = ap.waitForResponse(isPatchResponse);
  await ap.getByRole('menuitem', { name: /Analysing/ }).first().click();
  expect((await resp).status()).toBe(200);
});

test('AC6 + AC7 Analyst keyboard-drop on Go: locked column, refusal toast, card returns, no PATCH, locked announcement', async ({ page, browser }) => {
  await demoOrg(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  await expect(ap.getByTestId('locked-go')).toHaveAttribute('aria-label', TIP);
  await expect(ap.getByTestId('locked-analysing')).toHaveCount(0);
  await shot(ap, 'ac6-kanban-go-column-lock');
  const patches: string[] = [];
  ap.on('request', (r) => { if (isPatch(r)) patches.push(r.url()); });
  const goBefore = await colCards(ap, 'go').count();
  const first = colCards(ap, 'identified').first();
  const title = (await first.locator('p.line-clamp-2').innerText()).trim();
  await keyboardDrag(ap, handleOf(first), 2);
  await expect(ap.getByText(REFUSAL)).toBeVisible();
  await expect(colCards(ap, 'identified').filter({ hasText: title }).first()).toBeVisible();
  await expect(colCards(ap, 'go')).toHaveCount(goBefore);
  expect(patches).toEqual([]);
  const live = (await ap.locator('[aria-live]').allInnerTexts()).join(' ');
  expect(live).toContain('Go is locked: only a Bid Manager can make the Go/No-Go call.');
  expect(live).not.toContain('Dropped in Go');
  await shot(ap, 'ac7-keyboard-drop-refused-toast');
  // a non-decision column still accepts the drop
  const resp = ap.waitForResponse(isPatchResponse);
  await keyboardDrag(ap, handleOf(colCards(ap, 'identified').first()), 1);
  expect((await resp).status()).toBe(200);
});

test('AC6 Analyst pointer drag onto Go: the card is not shown in the locked column, refusal toast, no PATCH', async ({ page, browser }) => {
  await demoOrg(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  const patches: string[] = [];
  ap.on('request', (r) => { if (isPatch(r)) patches.push(r.url()); });
  const goBefore = await colCards(ap, 'go').count();
  const card = colCards(ap, 'identified').first();
  await card.hover();
  const from = (await handleOf(card).boundingBox())!;
  const to = (await colCards(ap, 'go').first().boundingBox())!;
  await ap.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await ap.mouse.down();
  await ap.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  await ap.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 30 });
  await ap.waitForTimeout(300);
  await expect(colCards(ap, 'go'), 'hovering the locked column must not place the card there').toHaveCount(goBefore);
  // (no screenshot mid-drag: a full-page capture resizes the viewport and cancels the drag)
  expect((await ap.locator('[aria-live]').allInnerTexts()).join(' ')).toContain('Go is locked: only a Bid Manager can make the Go/No-Go call.');
  await ap.mouse.up();
  await expect(ap.getByText(REFUSAL)).toBeVisible();
  await expect(colCards(ap, 'go')).toHaveCount(goBefore);
  expect(patches).toEqual([]);
  await shot(ap, 'ac6-pointer-drop-on-go-refused');
});

test('AC6 + AC8 @mobile 375 px: Analyst Move-to menu keeps Go/Dropped disabled; touch tap sends nothing; no horizontal overflow', async ({ page, browser }) => {
  await demoOrg(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await atPhone(ap);
  await ap.goto('/pipeline');
  await expect(colCards(ap, 'identified').first()).toBeVisible();
  await noHorizontalOverflow(ap);
  await shot(ap, 'ac8-pipeline-375');
  await menuBtnOf(colCards(ap, 'identified').first()).click();
  await expect(ap.getByRole('menuitem', { name: /^Go/ })).toHaveAttribute('aria-disabled', 'true');
  await expect(ap.getByRole('menuitem', { name: /^Dropped/ })).toHaveAttribute('aria-disabled', 'true');
  const patches: string[] = [];
  ap.on('request', (r) => { if (isPatch(r)) patches.push(r.url()); });
  const goItem = ap.getByRole('menuitem', { name: /^Go/ });
  if (test.info().project.name === 'mobile') await goItem.tap({ force: true }); else await goItem.click({ force: true });
  await ap.waitForTimeout(300);
  expect(patches).toEqual([]);
  await noHorizontalOverflow(ap);
  await shot(ap, 'ac8-move-to-menu-disabled-375');
});

test('AC9 Bid Manager: Go lock absent, Move to Go works (PATCH 200, toast), Drop asks for confirmation', async ({ page, browser }) => {
  await demoOrg(page);
  const bm = await inviteAs(page.request, 'bid_manager');
  const bp = await bm.newPage(browser);
  await openPipeline(bp);
  await expect(bp.getByTestId('locked-go')).toHaveCount(0);
  const card = colCards(bp, 'identified').first();
  await menuBtnOf(card).click();
  await expect(bp.getByRole('menuitem', { name: /^Go/ })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(bp.getByRole('menuitem', { name: /^Dropped/ })).not.toHaveAttribute('aria-disabled', 'true');
  const goBefore = await colCards(bp, 'go').count();
  const resp = bp.waitForResponse(isPatchResponse);
  await bp.getByRole('menuitem', { name: /^Go/ }).click();
  expect((await resp).status()).toBe(200);
  await expect(colCards(bp, 'go')).toHaveCount(goBefore + 1);
  await shot(bp, 'ac9-bid-manager-moved-to-go');
  const next = colCards(bp, 'identified').first();
  await menuBtnOf(next).click();
  await bp.getByRole('menuitem', { name: /^Dropped/ }).click();
  await expect(bp.getByRole('alertdialog').or(bp.getByRole('dialog')).filter({ hasText: 'Drop this bid?' })).toBeVisible();
  await shot(bp, 'ac9-bid-manager-drop-confirmation');
});

test('AC9 Bid Manager keyboard-drops a card on Go: accepted (PATCH 200), no refusal', async ({ page, browser }) => {
  await demoOrg(page);
  const bm = await inviteAs(page.request, 'bid_manager');
  const bp = await bm.newPage(browser);
  await openPipeline(bp);
  const goBefore = await colCards(bp, 'go').count();
  const resp = bp.waitForResponse(isPatchResponse);
  await keyboardDrag(bp, handleOf(colCards(bp, 'identified').first()), 2);
  expect((await resp).status()).toBe(200);
  await expect(colCards(bp, 'go')).toHaveCount(goBefore + 1);
  await expect(bp.getByText(REFUSAL)).toHaveCount(0);
  await shot(bp, 'ac9-bid-manager-keyboard-drop-on-go');
});

test('AC9 Bid Manager pointer-drags a card onto Go: accepted (PATCH 200)', async ({ page, browser }) => {
  await demoOrg(page);
  const bm = await inviteAs(page.request, 'bid_manager');
  const bp = await bm.newPage(browser);
  await openPipeline(bp);
  const goBefore = await colCards(bp, 'go').count();
  const card = colCards(bp, 'identified').first();
  await card.hover();
  const from = (await handleOf(card).boundingBox())!;
  const to = (await colCards(bp, 'go').first().boundingBox())!;
  const resp = bp.waitForResponse(isPatchResponse);
  await bp.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await bp.mouse.down();
  await bp.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  await bp.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 30 });
  await bp.waitForTimeout(300);
  await bp.mouse.up();
  expect((await resp).status()).toBe(200);
  await expect(colCards(bp, 'go')).toHaveCount(goBefore + 1);
  await shot(bp, 'ac9-bid-manager-pointer-drop-on-go');
});
