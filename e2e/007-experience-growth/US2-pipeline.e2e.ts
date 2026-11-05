/**
 * 007 / US2 — Run bids on the pipeline Kanban (story #293, QA task T037 / #319).
 *
 * One test per acceptance scenario US2-1 … US2-19 (specs/007-experience-growth/spec.md) plus a pointer-drag smoke
 * test. Keyboard drag (dnd-kit KeyboardSensor) is used for determinism; the 409 blocker toast, Viewer read-only,
 * table-view persistence, Move-to menu, outcome dialog (with the L1 hint served by mock-gem), dropped toggle and
 * ?q= search are all driven through the real UI. Every test uses its own freshly signed-up demo org (the result
 * hint is rate limited per org/bid). Each scenario writes one named screenshot to qa/evidence/007/US2/; tests whose
 * title contains "[video]" also keep their video there (collectRunArtifacts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as pwRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import {
  test, expect, signupViaApi, uniqueUser, seedDemo, inviteAs, evidence007, collectRunArtifacts, atPhone, noHorizontalOverflow, a11y,
} from '../support/fixtures';

const STORY = 'US2';
const EVID_DIR = join('qa', 'evidence', '007', STORY);

test.afterEach(async ({ page }) => {
  if (test.info().title.includes('[video]')) await collectRunArtifacts('007', STORY, page);
});

// ───────────── helpers ─────────────

const STAGES = ['identified', 'analysing', 'go', 'preparing', 'ready', 'submitted', 'won', 'lost'] as const;
const LABEL: Record<string, string> = {
  identified: 'Identified', analysing: 'Analysing', go: 'Go', preparing: 'Preparing', ready: 'Ready to submit', submitted: 'Submitted',
  won: 'Won', lost: 'Lost', dropped: 'Dropped',
};
const COUNTS: Record<string, number> = { identified: 3, analysing: 2, go: 2, preparing: 2, ready: 1, submitted: 3, won: 2, lost: 1 };

interface Ws {
  id: string; stage: string; position: number; outcome: { result: string; l1Price?: number | null; at?: string } | null;
  owner: { id: string; name: string } | null; tender: { id: string; title: string; bidNumber: string; endAt: string | null; organisation: string | null };
  readiness: { blockers: number; analysed: boolean };
}

function saveJson(name: string, data: unknown) {
  mkdirSync(EVID_DIR, { recursive: true });
  writeFileSync(join(EVID_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

async function demoOwner(page: Page, name = 'Priya Sharma') {
  const user = await signupViaApi(page, { ...uniqueUser('own'), name });
  await seedDemo(page.request);
  return user;
}

async function listWs(req: APIRequestContext, qs = ''): Promise<{ items: Ws[]; total: number; byStage: Record<string, number> }> {
  const res = await req.get(`/api/workspaces${qs}`);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const col = (page: Page, stage: string) => page.locator(`section[data-stage="${stage}"]`);
const colCards = (page: Page, stage: string) => col(page, stage).locator('ol > li').filter({ has: page.locator('a[href^="/workspaces/"]') });
const cardByTitle = (page: Page, stage: string, title: string) => colCards(page, stage).filter({ hasText: title }).first();
const handleOf = (card: Locator) => card.getByRole('button', { name: /^Move (?!to…)/ });
const menuBtnOf = (card: Locator) => card.getByRole('button', { name: /^Move to…/ });

async function openPipeline(page: Page, qs = '') {
  await page.goto(`/pipeline${qs}`);
  await expect(page.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeVisible();
  await expect(col(page, 'identified')).toBeVisible();
  await expect(colCards(page, 'identified').first()).toBeVisible();
}

/** Keyboard drag: focus the card's "Move <title>" handle, Space to lift, one ArrowRight per column, Space to drop. */
async function keyboardDrag(page: Page, handle: Locator, columns: number, revealStage?: string) {
  void revealStage; // round 2: the board now scrolls off-screen columns into view itself
  await page.waitForTimeout(300);
  await handle.focus();
  await page.keyboard.press('Space');
  for (let i = 0; i < columns; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(250);
  }
  await page.keyboard.press('Space');
}

const patchResp = (page: Page) => page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/workspaces\/[^/]+$/.test(r.url()));

async function moveViaMenu(page: Page, card: Locator, target: string | RegExp) {
  await menuBtnOf(card).click();
  await page.getByRole('menuitem', { name: target }).click();
}

async function dashboard(req: APIRequestContext) {
  const res = await req.get('/api/dashboard');
  expect(res.status()).toBe(200);
  return res.json() as Promise<{ activity: { action: string; meta: Record<string, unknown>; user: { name: string } | null; target: { href: string; label: string } | null }[]; tiles: { winRate: number | null }; stats: { won: number; lost: number } }>;
}

// ───────────── US2-1 … US2-2 ─────────────

test('US2-1: Viewer GET /api/workspaces -> 16 items + byStage; ?stage=won,lost -> 3; ?stage=archived -> 400 on stage', async ({ page, browser }) => {
  await demoOwner(page);
  const viewer = await inviteAs(page.request, 'viewer');
  const all = await listWs(viewer.api);
  expect(all.total).toBe(16);
  expect(all.items).toHaveLength(16);
  expect(all.byStage).toMatchObject(COUNTS);
  const wl = await listWs(viewer.api, '?stage=won,lost');
  expect(wl.total).toBe(3);
  expect(wl.items.map((i) => i.stage).sort()).toEqual(['lost', 'won', 'won']);
  const bad = await viewer.api.get('/api/workspaces?stage=archived');
  expect(bad.status()).toBe(400);
  const badBody = await bad.json();
  expect(badBody.error.code).toBe('validation_error');
  expect(badBody.error.details.fields.stage, 'details.fields.stage').toBeTruthy();
  saveJson('US2-01-api-responses', { all: { status: 200, total: all.total, itemCount: all.items.length, byStage: all.byStage }, wonLost: { total: wl.total }, archived: { status: bad.status(), body: badBody } });
  const vp = await viewer.newPage(browser);
  await vp.goto('/pipeline');
  await expect(colCards(vp, 'identified').first()).toBeVisible();
  await evidence007(vp, STORY, 'US2-01-viewer-lists-16-bids');
});

test('US2-2: /pipeline desktop -> eight columns in order, counts 3,2,2,2,1,3,2,1, hints, "16 bids · EMD ₹… at stake"', async ({ page }) => {
  await demoOwner(page);
  await openPipeline(page);
  const sections = page.locator('section[data-stage]');
  await expect(sections).toHaveCount(8);
  const order = await sections.evaluateAll((els) => els.map((e) => e.getAttribute('data-stage')));
  expect(order).toEqual([...STAGES]);
  const hints: Record<string, string> = { ready: 'Packet complete — submit on GeM yourself' };
  for (const s of STAGES) {
    const c = col(page, s);
    await expect(c.getByRole('heading', { level: 2 })).toContainText(LABEL[s]);
    await expect(c.getByRole('heading', { level: 2 })).toContainText(String(COUNTS[s]));
    await expect(colCards(page, s)).toHaveCount(COUNTS[s]);
  }
  await expect(col(page, 'ready')).toContainText(hints.ready);
  await expect(page.getByText(/16 bids · EMD ₹[\d.,]+\s?\w* at stake/)).toBeVisible();
  // EMD tooltip text
  await col(page, 'preparing').getByText(/^EMD ₹/).first().hover();
  await expect(page.getByText('Total EMD (earnest money) in this column').first()).toBeVisible();
  await evidence007(page, STORY, 'US2-02-board-eight-columns');
});

// ───────────── US2-3 … US2-4 ─────────────

test('US2-3 [video]: Analyst keyboard-drags first Identified card onto Analysing -> toast, PATCH {stage, position}, persists on reload', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  const first = colCards(ap, 'identified').first();
  const title = (await first.locator('p.line-clamp-2').innerText()).trim();
  const before = await listWs(analyst.api, '?stage=identified');
  const movedId = (await first.locator('a[href^="/workspaces/"]').getAttribute('href'))!.split('/').pop()!;
  const patch = patchResp(ap);
  await keyboardDrag(ap, handleOf(first), 1, 'analysing');
  const resp = await patch;
  const body = resp.request().postDataJSON();
  expect(resp.status()).toBe(200);
  expect(body.stage).toBe('analysing');
  expect(typeof body.position).toBe('number');
  expect(resp.url()).toContain(movedId);
  await expect(ap.getByText('Moved to Analysing')).toBeVisible();
  await evidence007(ap, STORY, 'US2-03-moved-to-analysing-toast');
  await ap.reload();
  await expect(colCards(ap, 'analysing')).toHaveCount(3);
  await expect(colCards(ap, 'identified')).toHaveCount(2);
  await expect(cardByTitle(ap, 'analysing', title)).toBeVisible();
  const after = await listWs(analyst.api);
  expect(after.items.find((i) => i.id === movedId)!.stage).toBe('analysing');
  saveJson('US2-03-patch', { request: body, status: resp.status(), identifiedBefore: before.total, byStageAfter: after.byStage });
});

test('US2-3b: pointer drag smoke (mouse, >6 px activation) moves a card to the next column', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  const card = colCards(ap, 'identified').first();
  const handle = handleOf(card);
  await card.hover();
  const hb = (await handle.boundingBox())!;
  const target = (await colCards(ap, 'analysing').first().boundingBox())!;
  const patch = patchResp(ap);
  await ap.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await ap.mouse.down();
  await ap.mouse.move(hb.x + hb.width / 2 + 12, hb.y + hb.height / 2 + 12, { steps: 4 });
  await ap.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 30 });
  await ap.waitForTimeout(250);
  await ap.mouse.up();
  const resp = await patch;
  expect(resp.status()).toBe(200);
  expect(resp.request().postDataJSON().stage).toBe('analysing');
  await expect(ap.getByText('Moved to Analysing')).toBeVisible();
  await expect(colCards(ap, 'analysing')).toHaveCount(3);
  await evidence007(ap, STORY, 'US2-03b-pointer-drag-smoke');
});

test('US2-4: after the move, GET /api/dashboard latest activity is workspace.stage_changed {from: identified, to: analysing}', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  const first = colCards(ap, 'identified').first();
  const id = (await first.locator('a[href^="/workspaces/"]').getAttribute('href'))!.split('/').pop()!;
  const patch = patchResp(ap);
  await keyboardDrag(ap, handleOf(first), 1, 'analysing');
  expect((await patch).status()).toBe(200);
  await expect(ap.getByText('Moved to Analysing')).toBeVisible();
  const d = await (await analyst.api.get('/api/dashboard')).json();
  const latest = d.activity[0];
  saveJson('US2-04-dashboard-latest-activity', latest);
  expect(latest.action).toBe('workspace.stage_changed');
  expect(latest.meta).toMatchObject({ from: 'identified', to: 'analysing' });
  expect(latest.user.name).toBe(analyst.user.name);
  expect(latest.target.href).toBe(`/workspaces/${id}`);
  await ap.goto('/dashboard');
  await expect(ap.getByText(analyst.user.name).first()).toBeVisible();
  await evidence007(ap, STORY, 'US2-04-dashboard-activity-stage-changed');
});

// ───────────── US2-5 … US2-6 ─────────────

test('US2-5 [video]: dragging the blocked Preparing card (Dell desktops) to Ready -> 409 not_ready, snaps back, blocker toast + Open workspace', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  const blocked = colCards(ap, 'preparing').filter({ hasText: /blocker/i }).first();
  await expect(blocked).toBeVisible();
  const title = (await blocked.locator('p.line-clamp-2').innerText()).trim();
  const id = (await blocked.locator('a[href^="/workspaces/"]').getAttribute('href'))!.split('/').pop()!;
  const patch = patchResp(ap);
  await keyboardDrag(ap, handleOf(blocked), 1, 'ready');
  const resp = await patch;
  expect(resp.status()).toBe(409);
  const err = (await resp.json()).error;
  saveJson('US2-05-409-response', err);
  expect(err.code).toBe('not_ready');
  expect(err.details.blockers.length).toBeGreaterThanOrEqual(1);
  const toast = ap.getByText('Can’t move to Ready to submit yet');
  await expect(toast).toBeVisible();
  await expect(ap.getByText(/Missing: /)).toBeVisible();
  await expect(ap.getByText(err.message).first()).toBeVisible();
  await expect(cardByTitle(ap, 'preparing', title)).toBeVisible(); // snapped back
  await expect(colCards(ap, 'ready')).toHaveCount(1);
  await expect(colCards(ap, 'preparing')).toHaveCount(2);
  await evidence007(ap, STORY, 'US2-05-blocker-toast-card-snapped-back');
  await ap.getByRole('button', { name: 'Open workspace' }).click();
  await expect(ap).toHaveURL(new RegExp(`/workspaces/${id}`));
  await evidence007(ap, STORY, 'US2-05-open-workspace-navigated');
});

test('US2-6: workspace whose tender has no completed analysis -> PATCH stage=ready answers 409 conflict / not_analysed', async ({ page, browser }) => {
  await demoOwner(page);
  const demoCards = await listWs(page.request);
  // A second org starts a bid on a tender it never analysed.
  const orgB = await pwRequest.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const ub = uniqueUser('orgb');
    expect((await orgB.post('/api/auth/signup', { data: ub })).status()).toBe(201);
    const tenderId = demoCards.items[0].tender.id;
    const created = await orgB.post(`/api/tenders/${tenderId}/workspace`);
    expect(created.status(), await created.text()).toBe(201);
    const ws = await created.json();
    const r = await orgB.patch(`/api/workspaces/${ws.id}`, { data: { stage: 'ready' } });
    expect(r.status()).toBe(409);
    const body = await r.json();
    saveJson('US2-06-not-analysed-409', body);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toBe('Analyse the tender before marking the bid ready to submit.');
    expect(body.error.details.reason).toBe('not_analysed');
    // Same through the UI: Move to… -> Ready to submit
    const ctx = await browser.newContext({ storageState: await orgB.storageState(), baseURL: test.info().project.use.baseURL, viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto('/pipeline');
    const card = colCards(p, 'identified').first();
    await expect(card).toBeVisible();
    await moveViaMenu(p, card, /^Ready to submit/);
    await expect(p.getByText('Can’t move to Ready to submit yet')).toBeVisible();
    await expect(p.getByText('Analyse the tender before marking the bid ready to submit.').first()).toBeVisible();
    await evidence007(p, STORY, 'US2-06-not-analysed-toast');
    await ctx.close();
  } finally { await orgB.dispose(); }
});

// ───────────── US2-7 … US2-9 ─────────────

test('US2-7: Analyst moves a Submitted card to Won -> 200, outcome {won, at}, toast "Marked as won", win rate 75% (3 won, 1 lost)', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const pre = await dashboard(analyst.api);
  expect(pre.tiles.winRate).toBe(67);
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  const submitted = (await listWs(analyst.api, '?stage=submitted')).items.filter((w) => !w.outcome);
  expect(submitted.length).toBeGreaterThan(0);
  const target = submitted[0];
  const card = ap.locator(`section[data-stage="submitted"] li:has(a[href="/workspaces/${target.id}"])`);
  const patch = patchResp(ap);
  await moveViaMenu(ap, card, /^Won/);
  const resp = await patch;
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  saveJson('US2-07-patch-response', { status: resp.status(), outcome: body.outcome, stage: body.stage });
  expect(body.outcome.result).toBe('won');
  expect(Date.now() - Date.parse(body.outcome.at)).toBeLessThan(120_000);
  await expect(ap.getByText('Marked as won', { exact: true })).toBeVisible();
  await expect(ap.getByText(/Record the L1 price/)).toBeVisible();
  await evidence007(ap, STORY, 'US2-07-marked-as-won-toast');
  const post = await dashboard(analyst.api);
  expect(post.stats).toMatchObject({ won: 3, lost: 1 });
  expect(post.tiles.winRate).toBe(75);
  await ap.getByRole('button', { name: 'Skip' }).click();
  await ap.goto('/dashboard');
  await expect(ap.getByText('75%').first()).toBeVisible();
  await evidence007(ap, STORY, 'US2-07-dashboard-win-rate-75');
});

test('US2-8: Viewer -> no drag handles, "No bids" in empty columns, view-only note, PATCH answers 403', async ({ page, browser }) => {
  await demoOwner(page);
  const viewer = await inviteAs(page.request, 'viewer');
  const any = (await listWs(viewer.api)).items[0];
  const vp = await viewer.newPage(browser);
  await openPipeline(vp);
  await expect(vp.getByRole('button', { name: /^Move /})).toHaveCount(0);
  await expect(vp.getByRole('button', { name: /^Move to…/ })).toHaveCount(0);
  await expect(vp.getByText('You have view-only access. Ask an Analyst, Bid Manager or Owner to move bids between stages.')).toBeVisible();
  // A narrow search empties most columns: they must read "No bids" (not the drag hint "Drop a bid here").
  await vp.getByLabel('Search pipeline').fill('desktop');
  await expect(vp).toHaveURL(/q=desktop/);
  await expect(vp.getByText('No bids').first()).toBeVisible();
  await expect(vp.getByText('Drop a bid here')).toHaveCount(0);
  await evidence007(vp, STORY, 'US2-08-viewer-read-only-board');
  const res = await viewer.api.patch(`/api/workspaces/${any.id}`, { data: { stage: 'go' } });
  expect(res.status()).toBe(403);
  saveJson('US2-08-viewer-patch-403', { status: res.status(), body: await res.json() });
});

test('US2-9: PATCH /api/workspaces/<foreign-org-id> as Analyst answers 404', async ({ page }) => {
  await demoOwner(page);
  const foreign = (await listWs(page.request)).items[0];
  const orgB = await pwRequest.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    expect((await orgB.post('/api/auth/signup', { data: uniqueUser('orgb') })).status()).toBe(201);
    const analystB = await inviteAs(orgB, 'analyst');
    const res = await analystB.api.patch(`/api/workspaces/${foreign.id}`, { data: { stage: 'go' } });
    expect(res.status()).toBe(404);
    saveJson('US2-09-cross-org-404', { status: res.status(), body: await res.json() });
    // and nothing changed in the owning org
    expect((await listWs(page.request)).items.find((i) => i.id === foreign.id)!.stage).toBe(foreign.stage);
    await page.goto('/pipeline');
    await expect(colCards(page, 'identified').first()).toBeVisible();
    await evidence007(page, STORY, 'US2-09-owning-org-unchanged-after-foreign-patch');
  } finally { await orgB.dispose(); }
});

// ───────────── US2-10 … US2-12 ─────────────

test('US2-10: search "dell", closing in 3 days (URL closing=3), Clear filters returns all 16 and clears the URL', async ({ page }) => {
  await demoOwner(page);
  await openPipeline(page);
  const allCards = page.locator('section[data-stage] ol > li').filter({ has: page.locator('a[href^="/workspaces/"]') });
  await expect(allCards).toHaveCount(16);
  const box = page.getByLabel('Search pipeline');
  await expect(box).toHaveAttribute('placeholder', 'Search title, bid number or buyer');
  // The demo data contains no "dell" anywhere (titles are "Desktop Computers (Q2) …"), so the literal scenario matches 0 bids.
  await box.fill('dell');
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  await expect(page).toHaveURL(/q=dell/);
  await expect(allCards).toHaveCount(0);
  await evidence007(page, STORY, 'US2-10-search-dell-no-match');
  // Same behaviour with a term that exists: only cards containing it (title, bid number or buyer), case-insensitive.
  await box.fill('DESKTOP');
  await expect(page).toHaveURL(/q=DESKTOP/);
  await expect.poll(async () => { const t = await allCards.allInnerTexts(); return t.length === 2 && t.every((x) => x.toLowerCase().includes('desktop')); }).toBe(true);
  await evidence007(page, STORY, 'US2-10-search-desktop-case-insensitive');
  await box.fill('indian army'); // buyer match
  await expect.poll(async () => { const t = await allCards.allInnerTexts(); return t.length > 0 && t.every((x) => x.toLowerCase().includes('indian army')); }).toBe(true);
  await box.fill('6401337'); // bid-number match
  await expect.poll(async () => allCards.count()).toBe(1);
  // closing filter (applied on top of the search -> clear search first to test the window on its own)
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(allCards).toHaveCount(16);
  await page.getByRole('combobox', { name: 'Closing' }).click();
  await page.getByRole('option', { name: 'Closing in 3 days' }).click();
  await expect(page).toHaveURL(/closing=3/);
  const all = await listWs(page.request);
  const now = Date.now();
  const expected = all.items.filter((w) => w.tender.endAt && Date.parse(w.tender.endAt) >= now && Date.parse(w.tender.endAt) <= now + 72 * 3_600_000);
  await expect(allCards).toHaveCount(expected.length);
  expect(expected.length).toBeGreaterThan(0);
  expect(expected.length).toBeLessThan(16);
  await evidence007(page, STORY, 'US2-10-closing-in-3-days');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(allCards).toHaveCount(16);
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  await evidence007(page, STORY, 'US2-10-filters-cleared-16-cards');
});

test('US2-11: Table view -> Tender/Stage/Score/Closes/EMD/Readiness/Owner, 16 rows by stage then closing, persists on reload, row opens workspace', async ({ page }) => {
  await demoOwner(page);
  await openPipeline(page);
  await page.getByRole('radio', { name: 'Table' }).click();
  const heads = await page.locator('table thead th').allInnerTexts();
  expect(heads.map((h) => h.trim().toLowerCase())).toEqual(['tender', 'stage', 'score', 'closes', 'emd', 'readiness', 'owner']);
  const rows = page.locator('table tbody tr');
  await expect(rows).toHaveCount(16);
  const ws = (await listWs(page.request)).items;
  const stageOrder = await rows.evaluateAll((trs) => trs.map((tr) => tr.querySelectorAll('td')[1]?.textContent?.trim() ?? ''));
  const labelIdx = (l: string) => STAGES.findIndex((s) => LABEL[s] === l);
  const idxs = stageOrder.map(labelIdx);
  expect(idxs.every((i) => i >= 0), `unknown stage labels in ${JSON.stringify(stageOrder)}`).toBe(true);
  expect([...idxs].sort((a, b) => a - b)).toEqual(idxs);
  // within one stage: closing date ascending (compare against API endAt via bid numbers)
  const bidNos = await rows.evaluateAll((trs) => trs.map((tr) => tr.querySelector('span.font-mono')?.textContent?.trim() ?? ''));
  const endOf = (bn: string) => ws.find((w) => w.tender.bidNumber === bn)?.tender.endAt ?? '';
  for (let i = 1; i < idxs.length; i++) if (idxs[i] === idxs[i - 1]) expect(endOf(bidNos[i]) >= endOf(bidNos[i - 1]), `row ${i} closing order`).toBe(true);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('tp:pipeline-view'))) ?? 'null')).toBe('table');
  await evidence007(page, STORY, 'US2-11-table-view');
  await page.reload();
  await expect(page.locator('table tbody tr')).toHaveCount(16);
  await expect(page.getByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');
  await evidence007(page, STORY, 'US2-11-table-view-after-reload');
  const target = ws.find((w) => w.tender.bidNumber === bidNos[0])!;
  await page.locator('table tbody tr').first().click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${target.id}`));
});

test('US2-12: /pipeline?stage=won -> Won column scrolled into view and outlined; Table view lists only Won rows', async ({ page }) => {
  await demoOwner(page);
  await page.goto('/pipeline?stage=won');
  const won = col(page, 'won');
  await expect(won).toBeVisible();
  await expect(won).toBeInViewport({ ratio: 0.9 });
  await expect(won).toHaveClass(/ring-2/);
  await expect(col(page, 'identified')).not.toHaveClass(/ring-2/);
  await expect(page.locator('section[data-stage]').nth(0)).not.toBeInViewport(); // board actually scrolled
  await evidence007(page, STORY, 'US2-12-won-column-focused');
  await page.getByRole('radio', { name: 'Table' }).click();
  const rows = page.locator('table tbody tr');
  await expect(rows).toHaveCount(2);
  const stages = await rows.evaluateAll((trs) => trs.map((tr) => tr.querySelectorAll('td')[1]?.textContent?.trim()));
  expect(stages).toEqual(['Won', 'Won']);
  await evidence007(page, STORY, 'US2-12-table-only-won-rows');
});

// ───────────── US2-13 ─────────────

test('US2-13 [video]: keyboard drag (Space, ->, ->, Space) lands two columns right with live-region announcements; Escape cancels', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  // Record every live-region message dnd-kit announces.
  await ap.evaluate(() => {
    const w = window as unknown as { __ann: string[] };
    w.__ann = [];
    const seen = new Set<Element>();
    const attach = (el: Element) => {
      if (seen.has(el)) return; seen.add(el);
      new MutationObserver(() => { const t = el.textContent?.trim(); if (t) w.__ann.push(t); }).observe(el, { childList: true, characterData: true, subtree: true });
    };
    const scan = () => document.querySelectorAll('[aria-live]').forEach(attach);
    scan(); new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  });
  const ann = () => ap.evaluate(() => (window as unknown as { __ann: string[] }).__ann);
  const first = colCards(ap, 'identified').first();
  const title = (await first.locator('p.line-clamp-2').innerText()).trim();
  const patch = patchResp(ap);
  await keyboardDrag(ap, handleOf(first), 2);
  const resp = await patch;
  expect(resp.request().postDataJSON().stage).toBe('go');
  await expect(ap.getByText('Moved to Go')).toBeVisible();
  const msgs = await ann();
  saveJson('US2-13-announcements', msgs);
  expect(msgs.some((m) => m.startsWith('Picked up') && m.includes(title)), JSON.stringify(msgs)).toBe(true);
  expect(msgs).toContain('Over Analysing.');
  expect(msgs).toContain('Over Go.');
  expect(msgs).toContain('Dropped in Go.');
  await expect(colCards(ap, 'go')).toHaveCount(3);
  await expect(cardByTitle(ap, 'go', title)).toBeVisible();
  await evidence007(ap, STORY, 'US2-13-keyboard-drop-two-columns-right');
  // Escape mid-drag
  const another = colCards(ap, 'identified').first();
  const t2 = (await another.locator('p.line-clamp-2').innerText()).trim();
  await handleOf(another).focus();
  await ap.keyboard.press('Space');
  await ap.keyboard.press('ArrowRight');
  await ap.waitForTimeout(200);
  await ap.keyboard.press('Escape');
  await expect.poll(ann).toContain('Drag cancelled.');
  await expect(cardByTitle(ap, 'identified', t2)).toBeVisible();
  await expect(colCards(ap, 'identified')).toHaveCount(1 + 1); // 3 - 1 moved, cancelled card still present
  await expect(colCards(ap, 'analysing')).toHaveCount(2);
  await evidence007(ap, STORY, 'US2-13-escape-cancels-card-returns');
});

test('US2-13 (literal): Space, ArrowRight, ArrowRight, Space on the first Identified card lands TWO columns right (Go)', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  const first = colCards(ap, 'identified').first();
  await handleOf(first).focus();
  await ap.keyboard.press('Space');
  await ap.keyboard.press('ArrowRight');
  await ap.waitForTimeout(300);
  await ap.keyboard.press('ArrowRight');
  await ap.waitForTimeout(300);
  const patch = patchResp(ap);
  await ap.keyboard.press('Space');
  const resp = await patch;
  const sent = resp.request().postDataJSON();
  saveJson('US2-13-literal-two-arrow-presses', { sent, status: resp.status() });
  await ap.waitForTimeout(500);
  await evidence007(ap, STORY, 'US2-13-literal-two-presses-result');
  expect(sent.stage, 'spec: two ArrowRight presses -> two columns to the right (go)').toBe('go');
});

test('US2-13 (off-screen column): keyboard drag from Preparing reaches Ready, which is off-screen at 1440 px, one column per ArrowRight', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  await expect(col(ap, 'ready')).not.toBeInViewport();
  const card = colCards(ap, 'preparing').first();
  await handleOf(card).focus();
  await ap.keyboard.press('Space');
  const seen: string[] = [];
  for (let i = 0; i < 2; i++) {
    await ap.keyboard.press('ArrowRight');
    await ap.waitForTimeout(400);
    seen.push((await ap.locator('[aria-live]').allInnerTexts()).join('').trim());
  }
  saveJson('US2-13-offscreen-column-announcements', seen);
  await expect(col(ap, 'ready')).toBeInViewport();
  await evidence007(ap, STORY, 'US2-13-keyboard-drag-offscreen-column');
  await ap.keyboard.press('Escape');
  expect(seen[0]).toBe('Over Ready to submit.');
  expect(seen[1]).toBe('Over Submitted.');
});

// ───────────── US2-14 (@mobile) ─────────────

test('US2-14 [video] @mobile: 375 px -> Jump to stage chips with counts, 84vw columns (max 320), snap scrolling, Won chip scrolls, no page-level horizontal overflow', async ({ page }) => {
  await demoOwner(page);
  await atPhone(page);
  await page.goto('/pipeline');
  const nav = page.getByRole('navigation', { name: 'Jump to stage' });
  await expect(nav).toBeVisible();
  const chips = nav.getByRole('button');
  await expect(chips).toHaveCount(8);
  for (const s of STAGES) await expect(nav.getByRole('button', { name: new RegExp(`^${LABEL[s]}\\s*${COUNTS[s]}$`) })).toBeVisible();
  const w = (await col(page, 'identified').boundingBox())!.width;
  expect(w).toBeGreaterThan(375 * 0.84 - 2);
  expect(w).toBeLessThanOrEqual(320.5);
  const scroller = col(page, 'identified').locator('xpath=..');
  expect(await scroller.evaluate((el) => getComputedStyle(el).scrollSnapType)).toMatch(/x/);
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await noHorizontalOverflow(page);
  await evidence007(page, STORY, 'US2-14-mobile-chips-board');
  await expect(col(page, 'won')).not.toBeInViewport();
  await nav.getByRole('button', { name: /^Won/ }).click();
  await expect(col(page, 'won')).toBeInViewport({ ratio: 0.9 });
  await noHorizontalOverflow(page);
  await evidence007(page, STORY, 'US2-14-mobile-won-chip-scrolled');
});

// ───────────── US2-15 ─────────────

test('US2-15: empty org -> "Your pipeline is empty" + Browse matched tenders; Table view with no matches -> "No bids match these filters"', async ({ page }) => {
  await signupViaApi(page);
  await page.goto('/pipeline');
  await expect(page.getByText('Your pipeline is empty')).toBeVisible();
  const link = page.getByRole('link', { name: 'Browse matched tenders' });
  await expect(link).toHaveAttribute('href', '/tenders?matched=1');
  await evidence007(page, STORY, 'US2-15-empty-pipeline');
  await link.click();
  await expect(page).toHaveURL(/\/tenders\?matched=1/);

  await seedDemo(page.request);
  await page.goto('/pipeline');
  await page.getByRole('radio', { name: 'Table' }).click();
  await expect(page.locator('table tbody tr')).toHaveCount(16);
  await page.getByRole('combobox', { name: 'Owner' }).click();
  await page.getByRole('option', { name: 'Unassigned' }).click(); // the demo seeder owns every bid
  await expect(page.getByText('No bids match these filters')).toBeVisible();
  await evidence007(page, STORY, 'US2-15-table-no-bids-match-filters');
});

test('US2-15 (search filter): Table view with a search that matches nothing -> "No bids match these filters"', async ({ page }) => {
  await demoOwner(page);
  await page.goto('/pipeline');
  await page.getByRole('radio', { name: 'Table' }).click();
  await expect(page.locator('table tbody tr')).toHaveCount(16);
  await page.getByLabel('Search pipeline').fill('zzz-no-such-bid');
  await expect(page).toHaveURL(/q=zzz-no-such-bid/);
  await page.waitForTimeout(1000);
  await evidence007(page, STORY, 'US2-15-table-search-no-match');
  await expect(page.getByText('No bids match these filters')).toBeVisible({ timeout: 3000 });
});

// ───────────── US2-16 … US2-19 ─────────────

test('US2-16: card "Move to…" menu -> Go behaves like drag (same PATCH, toast, activity); keyboard-operable', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  const card = colCards(ap, 'identified').first();
  const id = (await card.locator('a[href^="/workspaces/"]').getAttribute('href'))!.split('/').pop()!;
  const title = (await card.locator('p.line-clamp-2').innerText()).trim();
  await expect(menuBtnOf(card)).toHaveAttribute('aria-label', `Move to… (${title})`);
  await menuBtnOf(card).focus();
  await ap.keyboard.press('Enter'); // keyboard opens the menu
  const items = ap.getByRole('menuitem');
  await expect(items.first()).toBeVisible();
  const names = (await items.allInnerTexts()).map((t) => t.split('\n')[0].trim());
  expect(names).toEqual(['Analysing', 'Go', 'Preparing', 'Ready to submit', 'Submitted', 'Won', 'Lost', 'Dropped']);
  await expect(ap.getByRole('menuitem', { name: /^Won/ })).toBeDisabled().catch(async () => expect(ap.getByRole('menuitem', { name: /^Won/ })).toHaveAttribute('aria-disabled', 'true'));
  await evidence007(ap, STORY, 'US2-16-move-to-menu-open');
  const patch = patchResp(ap);
  await ap.getByRole('menuitem', { name: /^Go/ }).click();
  const resp = await patch;
  expect(resp.status()).toBe(200);
  const body = resp.request().postDataJSON();
  expect(body.stage).toBe('go');
  expect(typeof body.position).toBe('number');
  await expect(ap.getByText('Moved to Go')).toBeVisible();
  await expect(cardByTitle(ap, 'go', title)).toBeVisible();
  const d = await (await analyst.api.get('/api/dashboard')).json();
  expect(d.activity[0]).toMatchObject({ action: 'workspace.stage_changed', meta: { from: 'identified', to: 'go' }, target: { href: `/workspaces/${id}` } });
  await evidence007(ap, STORY, 'US2-16-moved-to-go-via-menu');
});

test('US2-17 [video]: Won via menu -> "Record the result" dialog with GeM L1 hint; Save sends outcome and header shows Won · L1; Skip keeps stage-only outcome', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  const subs = (await listWs(analyst.api, '?stage=submitted')).items.filter((w) => !w.outcome);
  expect(subs.length).toBeGreaterThanOrEqual(2);
  const [a, b] = subs;
  const cardA = ap.locator(`section[data-stage="submitted"] li:has(a[href="/workspaces/${a.id}"])`);
  const hintReq = ap.waitForResponse((r) => /\/api\/tenders\/[^/]+\/result-hint/.test(r.url()));
  await moveViaMenu(ap, cardA, /^Won/);
  const dlg = ap.getByRole('dialog', { name: 'Record the result' });
  await expect(dlg).toBeVisible();
  const hint = await (await hintReq).json();
  saveJson('US2-17-result-hint', hint);
  expect(hint.available).toBe(true);
  const useL1 = dlg.getByRole('button', { name: /Use L1 from GeM: ₹/ });
  await expect(useL1).toBeVisible();
  await evidence007(ap, STORY, 'US2-17-record-result-dialog-with-l1-hint');
  await useL1.click();
  await expect(dlg.getByLabel(/L1 price/)).toHaveValue(String(hint.l1Price));
  await dlg.getByLabel(/L1 price/).fill('29,50,000');
  await dlg.getByLabel(/Our price/).fill('30,10,000');
  await dlg.getByLabel(/Notes/).fill('QA: won on price');
  const save = patchResp(ap);
  await dlg.getByRole('button', { name: 'Save' }).click();
  const sresp = await save;
  expect(sresp.status()).toBe(200);
  expect(sresp.request().postDataJSON().outcome).toMatchObject({ result: 'won', l1Price: 2950000, ourPrice: 3010000, notes: 'QA: won on price' });
  await expect(ap.getByText('Result recorded')).toBeVisible();
  await ap.goto(`/workspaces/${a.id}`);
  await expect(ap.getByText(/^Won · L1 ₹\s?29\.5\s?L/)).toBeVisible();
  await evidence007(ap, STORY, 'US2-17-workspace-header-won-l1');
  // Skip path (Lost)
  await openPipeline(ap);
  const cardB = ap.locator(`section[data-stage="submitted"] li:has(a[href="/workspaces/${b.id}"])`);
  await moveViaMenu(ap, cardB, /^Lost/);
  const dlg2 = ap.getByRole('dialog', { name: 'Record the result' });
  await expect(dlg2).toBeVisible();
  await dlg2.getByRole('button', { name: 'Skip' }).click();
  await expect(dlg2).toHaveCount(0);
  const after = (await listWs(analyst.api)).items.find((w) => w.id === b.id)!;
  expect(after.stage).toBe('lost');
  expect(after.outcome?.result).toBe('lost');
  expect(after.outcome?.l1Price ?? null).toBeNull();
  await evidence007(ap, STORY, 'US2-17-skip-keeps-stage-only-outcome');
});

test('US2-18: moving a bid to Dropped asks for confirmation; "Show dropped (1)" toggle adds a ninth Dropped column', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  await expect(ap.getByRole('button', { name: /Show dropped/ })).toHaveCount(0);
  const card = colCards(ap, 'identified').first();
  const title = (await card.locator('p.line-clamp-2').innerText()).trim();
  await moveViaMenu(ap, card, /^Dropped/);
  const confirm = ap.getByRole('alertdialog').or(ap.getByRole('dialog')).filter({ hasText: 'Drop this bid?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('It leaves the active pipeline but keeps its history.');
  await evidence007(ap, STORY, 'US2-18-drop-confirmation');
  // Cancel first: nothing is sent, the card stays.
  await confirm.getByRole('button', { name: /Cancel/ }).click();
  await expect(confirm).toHaveCount(0);
  await expect(colCards(ap, 'identified')).toHaveCount(3);
  await moveViaMenu(ap, colCards(ap, 'identified').first(), /^Dropped/);
  const patch = patchResp(ap);
  await confirm.getByRole('button', { name: 'Drop bid' }).click();
  const resp = await patch;
  expect(resp.status()).toBe(200);
  expect(resp.request().postDataJSON().stage).toBe('dropped');
  await expect(colCards(ap, 'identified')).toHaveCount(2);
  const toggle = ap.getByRole('button', { name: 'Show dropped (1)' });
  await expect(toggle).toBeVisible();
  await expect(ap.locator('section[data-stage]')).toHaveCount(8);
  await expect(col(ap, 'dropped')).toHaveCount(0);
  await toggle.click();
  await expect(ap.locator('section[data-stage]')).toHaveCount(9);
  await expect(col(ap, 'dropped').getByRole('heading', { level: 2 })).toContainText('Dropped');
  await expect(colCards(ap, 'dropped')).toHaveCount(1);
  expect(JSON.parse((await ap.evaluate(() => localStorage.getItem('tp:pipeline-dropped'))) ?? 'null')).toBe(true);
  await evidence007(ap, STORY, 'US2-18-dropped-column-shown');
  await ap.reload();
  await expect(ap.locator('section[data-stage]')).toHaveCount(9); // persisted per browser
  void title;
});

test('US2-19: typing "dell" quickly sends at most one GET /api/workspaces?q=dell after 300 ms and syncs ?q= (survives reload)', async ({ page }) => {
  await demoOwner(page);
  await openPipeline(page);
  const reqs: { t: number; url: string }[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && /\/api\/workspaces\?/.test(r.url())) reqs.push({ t: Date.now(), url: r.url() }); });
  const box = page.getByLabel('Search pipeline');
  await box.click();
  const typedAt = Date.now();
  await box.pressSequentially('dell', { delay: 40 });
  const doneAt = Date.now();
  await page.waitForTimeout(1200);
  const qs = reqs.map((r) => new URL(r.url).searchParams.get('q'));
  saveJson('US2-19-requests', reqs.map((r) => ({ afterTypingStartMs: r.t - typedAt, afterTypingEndMs: r.t - doneAt, url: r.url })));
  expect(qs.filter((q) => q === 'dell').length, JSON.stringify(qs)).toBeLessThanOrEqual(1);
  expect(qs.filter((q) => q === 'dell').length, 'one request for q=dell').toBe(1);
  expect(qs.filter((q) => q && q !== 'dell'), 'no partial-keystroke requests').toEqual([]);
  const dellReq = reqs.find((r) => new URL(r.url).searchParams.get('q') === 'dell')!;
  expect(dellReq.t - doneAt).toBeGreaterThanOrEqual(250); // fired ~300 ms after the last keystroke
  await expect(page).toHaveURL(/[?&]q=dell/);
  await evidence007(page, STORY, 'US2-19-search-q-in-url');
  await page.reload();
  await expect(page.getByLabel('Search pipeline')).toHaveValue('dell');
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  await evidence007(page, STORY, 'US2-19-search-survives-reload');
});

// ───────────── cross-cutting ─────────────

test('a11y (observational): axe on the pipeline board and table; violations are recorded as annotations, not failures', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await openPipeline(ap);
  for (const [name, setup] of [['pipeline-board', async () => undefined], ['pipeline-table', async () => { await ap.getByRole('radio', { name: 'Table' }).click(); await expect(ap.locator('table tbody tr').first()).toBeVisible(); }]] as const) {
    await setup();
    try { await a11y(ap, name); } catch (e) { test.info().annotations.push({ type: 'a11y-observation', description: `${name}: ${String((e as Error).message).split('\n').slice(0, 30).join(' ').slice(0, 900)}` }); }
  }
});
