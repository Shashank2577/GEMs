/**
 * 007 / US5 — Persona-aware dashboard widgets (story #296, QA task T063 / #339).
 *
 * One test per acceptance scenario US5-1 … US5-6 (specs/007-experience-growth/spec.md) plus a role matrix for
 * FR-071 / FR-072 / FR-073 across Owner, Bid Manager, Analyst and Viewer (invited with inviteAs) on a demo org.
 * API scenarios run through the real API, UI scenarios through the real UI. Each test writes named screenshots and
 * JSON to qa/evidence/007/US5/ and keeps its video there (collectRunArtifacts). @mobile = Pixel 7 project, phone
 * viewport forced to 375 px.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import {
  test, expect, signupViaApi, uniqueUser, inviteAs, evidence007, collectRunArtifacts, noHorizontalOverflow, atPhone,
} from '../support/fixtures';

const STORY = 'US5';
const EVID_DIR = join('qa', 'evidence', '007', STORY);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
const DAY = 86_400_000;
const MY_BIDS_EMPTY = 'Nothing assigned to you — bids you own or are assigned to will appear here.';
const ASK = 'Ask an Owner or Bid Manager to set up watchlists.';

test.afterEach(async ({ page }) => { await collectRunArtifacts('007', STORY, page); });

// ───────────── helpers ─────────────

function saveJson(name: string, data: unknown) {
  mkdirSync(EVID_DIR, { recursive: true });
  writeFileSync(join(EVID_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}
function sql(query: string): string {
  return execFileSync('psql', [E2E_DB, '-tAc', query], { encoding: 'utf8' }).trim();
}

type Ws = { id: string; stage: string; tender: { id: string; title: string; bidNumber: string } };
interface Dash {
  myWork: { workspaceId: string; title: string; bidNumber: string; stage: string; dueAt: string | null; endAt: string | null; readiness: { percent: number; blockers: number; analysed: boolean } }[];
  awaitingDecision: { workspaceId: string; title: string; score: number | null; verdict: string | null }[];
  pipeline: Record<string, number>;
  setupComplete: boolean;
  setup: { key: string; done: boolean }[];
}

async function dash(req: APIRequestContext): Promise<{ status: number; body: Dash }> {
  const r = await req.get('/api/dashboard');
  return { status: r.status(), body: await r.json() };
}
async function myId(req: APIRequestContext): Promise<string> {
  return (await (await req.get('/api/auth/me')).json()).user.id;
}
async function workspaces(req: APIRequestContext): Promise<Ws[]> {
  return (await (await req.get('/api/workspaces')).json()).items as Ws[];
}
async function patch(req: APIRequestContext, id: string, data: Record<string, unknown>) {
  const r = await req.patch(`/api/workspaces/${id}`, { data });
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}

async function freshOwner(page: Page) {
  return signupViaApi(page, { ...uniqueUser('own'), name: 'Aarav Shah' });
}
async function demoOwner(page: Page) {
  const user = await freshOwner(page);
  const s = await page.request.post('/api/demo/seed');
  expect(s.status(), await s.text()).toBe(201);
  return user;
}

/** Analyst owns A (Preparing, due tomorrow) and is an assignee on B (Go, due in 3 days) — the spec's US5-2 setup. */
async function assignAnalyst(owner: APIRequestContext, analystId: string) {
  const ws = await workspaces(owner);
  const a = ws.find((w) => w.stage === 'preparing')!;
  const b = ws.find((w) => w.stage === 'go')!;
  expect(a && b, 'demo org has a Preparing and a Go workspace').toBeTruthy();
  const now = Date.now();
  await patch(owner, a.id, { ownerId: analystId, dueAt: new Date(now + 1 * DAY).toISOString() });
  await patch(owner, b.id, { assigneeIds: [analystId], dueAt: new Date(now + 3 * DAY).toISOString() });
  return { a, b };
}

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const box = async (loc: ReturnType<Page['locator']>) => (await loc.boundingBox())!;
const funnelCount = async (page: Page, label: string) =>
  Number((await page.locator(`ul[aria-label="Bids by pipeline stage"] a[title^="${label}:"]`).locator('span').last().innerText()).trim());
/** A real touch tap on the Pixel 7 project; a click on the desktop project (no touch support there). */
const tap = async (page: Page, loc: ReturnType<Page['locator']>) => {
  if (test.info().project.use.hasTouch) await loc.tap(); else await loc.click();
};
/** A brand-new bid_manager+ is sent to /onboarding once per browser session; visit the dashboard twice to land on it. */
async function openEmptyDashboard(page: Page) {
  await page.goto('/dashboard');
  await page.waitForURL(/\/onboarding/);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /command centre fills up/ })).toBeVisible();
}
const dialog = (page: Page) => page.locator('[role="dialog"],[role="alertdialog"]');

// ───────────── US5-1 ─────────────

test('US5-1 fresh org + Viewer: no "Create a watchlist", no "Explore with demo data"; shows the ask text', async ({ page, browser }) => {
  await freshOwner(page);
  const viewer = await inviteAs(page.request, 'viewer');
  const vp = await viewer.newPage(browser);
  await vp.goto('/dashboard');
  await expect(vp.getByRole('heading', { name: /command centre fills up/ })).toBeVisible();
  await expect(vp.getByText(ASK).first()).toBeVisible();
  await expect(vp.getByRole('button', { name: /Explore with demo data/ })).toHaveCount(0);
  await expect(vp.getByRole('link', { name: /Create (a )?watchlist/i })).toHaveCount(0);
  await expect(vp.getByRole('button', { name: /Create (a )?watchlist/i })).toHaveCount(0);
  await expect(vp.getByText('Finish setting up')).toHaveCount(0);
  await evidence007(vp, STORY, 'US5-1-viewer-fresh-org-ask-text-no-create-watchlist');

  // Contrast: the Owner of the same org does get the CTAs.
  await openEmptyDashboard(page);
  await expect(page.getByRole('link', { name: /Create (a )?watchlist/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Explore with demo data/ })).toBeVisible();
  saveJson('US5-1-viewer', { askText: true, createWatchlist: 0, exploreDemo: 0, ownerSeesCreateWatchlist: true });
  await evidence007(page, STORY, 'US5-1-owner-same-org-has-the-ctas');
});

test('US5-1 @mobile Viewer at 375 px: ask text, no CTA, no horizontal overflow', async ({ page, browser }) => {
  await freshOwner(page);
  const viewer = await inviteAs(page.request, 'viewer');
  const vp = await viewer.newPage(browser);
  await atPhone(vp);
  await vp.goto('/dashboard');
  await expect(vp.getByText(ASK).first()).toBeVisible();
  await expect(vp.getByRole('link', { name: /Create (a )?watchlist/i })).toHaveCount(0);
  await noHorizontalOverflow(vp);
  await evidence007(vp, STORY, 'US5-1-viewer-fresh-org-mobile-375');
});

// ───────────── US5-2 (API) ─────────────

test('US5-2 GET /api/dashboard myWork for the Analyst: A (owner, due tomorrow) then B (assignee, due in 3 days)', async ({ page }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const { a, b } = await assignAnalyst(page.request, await myId(analyst.api));
  const r = await dash(analyst.api);
  expect(r.status).toBe(200);
  const mw = r.body.myWork;
  expect(mw.map((w) => w.workspaceId)).toEqual([a.id, b.id]);
  for (const [item, ws, stage] of [[mw[0], a, 'preparing'], [mw[1], b, 'go']] as const) {
    expect(item.title).toBe(ws.tender.title);
    expect(item.bidNumber).toBe(ws.tender.bidNumber);
    expect(item.stage).toBe(stage);
    expect(item.dueAt).toBeTruthy();
    expect(item.endAt).toBeTruthy();
    expect(typeof item.readiness.percent).toBe('number');
    expect(typeof item.readiness.blockers).toBe('number');
  }
  expect(Date.parse(mw[0].dueAt!)).toBeLessThan(Date.parse(mw[1].dueAt!));
  expect(mw.length).toBeLessThanOrEqual(5);

  // ≤ 5 and excluded stages: give the analyst 7 more workspaces incl. submitted/won/lost/dropped ones.
  const owner = page.request;
  const aid = await myId(analyst.api);
  const all = await workspaces(owner);
  const others = all.filter((w) => ![a.id, b.id].includes(w.id));
  for (const w of others.slice(0, 12)) await patch(owner, w.id, { ownerId: aid });
  const big = await dash(analyst.api);
  const stages = big.body.myWork.map((w) => w.stage);
  expect(big.body.myWork.length).toBeLessThanOrEqual(5);
  expect(stages.some((s) => ['submitted', 'won', 'lost', 'dropped'].includes(s))).toBe(false);
  const dues = big.body.myWork.map((w) => (w.dueAt ? Date.parse(w.dueAt) : Infinity));
  expect([...dues].sort((x, y) => x - y)).toEqual(dues);
  const excludedAssigned = sql(`select count(*) from bid_workspaces where owner_id = '${aid}' and stage in ('submitted','won','lost','dropped')`);
  const ownerView = (await dash(owner)).body.myWork.length;
  saveJson('US5-2-mywork-analyst', { setup: r.body.myWork, afterAssigningMany: big.body.myWork, excludedStagesAssignedToAnalyst: excludedAssigned, ownerMyWorkCount: ownerView });
  expect(Number(excludedAssigned), 'test data really included excluded stages').toBeGreaterThan(0);
});

// ───────────── US5-3 ─────────────

test('US5-3 Analyst dashboard: "My bids" directly after the KPI tiles with A and B, stage badge, Due date, readiness', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const { a, b } = await assignAnalyst(page.request, await myId(analyst.api));
  const ap = await analyst.newPage(browser);
  await ap.goto('/dashboard');
  const mine = region(ap, 'My bids');
  await expect(mine).toBeVisible();
  const rows = mine.locator('li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(a.tender.title);
  await expect(rows.nth(0)).toContainText('Preparing');
  await expect(rows.nth(1)).toContainText(b.tender.title);
  await expect(rows.nth(1)).toContainText('Go');
  for (const i of [0, 1]) {
    await expect(rows.nth(i)).toContainText(/Due \d/);
    await expect(rows.nth(i).getByRole('progressbar')).toBeVisible();
    await expect(rows.nth(i)).toContainText(/\d+%|Not analysed/);
    await expect(rows.nth(i).locator('[data-overdue]')).toHaveCount(0); // future dates are not red
  }
  // Placement: directly after the KPI tiles (below the last tile, above "Closing soon").
  const kpi = await box(ap.getByText('Docs expiring', { exact: true }).first());
  const mb = await box(mine);
  const closing = await box(ap.getByText('Closing soon', { exact: true }).first());
  expect(mb.y).toBeGreaterThan(kpi.y + kpi.height);
  expect(mb.y).toBeLessThan(closing.y);
  saveJson('US5-3-placement', { kpiBottom: kpi.y + kpi.height, myBidsTop: mb.y, closingSoonTop: closing.y });
  await evidence007(ap, STORY, 'US5-3-analyst-my-bids-after-kpi-tiles');
});

test('US5-3 overdue due dates are red (data-overdue) and a bid with no assignments shows the empty text', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const empty = await inviteAs(page.request, 'analyst');
  const { a, b } = await assignAnalyst(page.request, await myId(analyst.api));
  await patch(page.request, b.id, { dueAt: new Date(Date.now() - 2 * DAY).toISOString() });
  const ap = await analyst.newPage(browser);
  await ap.goto('/dashboard');
  const rows = region(ap, 'My bids').locator('li');
  await expect(rows).toHaveCount(2);
  // Overdue B sorts first (earlier due), and is red; A is not.
  const overdue = rows.locator('[data-overdue="true"]');
  await expect(overdue).toHaveCount(1);
  await expect(rows.first()).toContainText(b.tender.title);
  await expect(overdue).toContainText(/Due \d/);
  const colour = await overdue.evaluate((e) => getComputedStyle(e).color);
  const normal = await rows.nth(1).locator('span.tabular').last().evaluate((e) => getComputedStyle(e).color);
  expect(colour).not.toBe(normal);
  await evidence007(ap, STORY, 'US5-3-overdue-red-due-date');

  const ep = await empty.newPage(browser);
  await ep.goto('/dashboard');
  await expect(region(ep, 'My bids').getByText(MY_BIDS_EMPTY)).toBeVisible();
  await expect(region(ep, 'My bids').locator('li')).toHaveCount(0);
  saveJson('US5-3-overdue-and-empty', { overdueColour: colour, normalColour: normal, aId: a.id, emptyText: MY_BIDS_EMPTY });
  await evidence007(ep, STORY, 'US5-3-empty-state-nothing-assigned');
});

test('US5-3 @mobile Analyst "My bids" at 375 px: rows readable, no horizontal overflow', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  await assignAnalyst(page.request, await myId(analyst.api));
  const ap = await analyst.newPage(browser);
  await atPhone(ap);
  await ap.goto('/dashboard');
  await expect(region(ap, 'My bids').locator('li')).toHaveCount(2);
  await region(ap, 'My bids').scrollIntoViewIfNeeded();
  await noHorizontalOverflow(ap);
  await evidence007(ap, STORY, 'US5-3-analyst-my-bids-mobile-375');
});

// ───────────── US5-4 (API) ─────────────

test('US5-4 Owner GET /api/dashboard awaitingDecision: both analysing+done workspaces, oldest first, ≤ 5, score and verdict', async ({ page }) => {
  await demoOwner(page);
  const r = await dash(page.request);
  expect(r.status).toBe(200);
  const ad = r.body.awaitingDecision;
  expect(ad.length).toBe(2);
  expect(ad.length).toBeLessThanOrEqual(5);
  for (const it of ad) {
    expect(typeof it.score).toBe('number');
    expect(['go', 'no_go', 'conditional']).toContain(it.verdict);
  }
  // Ground truth from the database: analysing workspaces whose latest analysis is done, oldest analysis first.
  const org = (await (await page.request.get('/api/auth/me')).json()).org.id;
  const expected = sql(`select w.id from bid_workspaces w join lateral (select x.status, x.updated_at from analyses x where x.org_id = w.org_id and x.tender_id = w.tender_id order by x.created_at desc, x.id desc limit 1) a on a.status = 'done' where w.org_id = '${org}' and w.stage = 'analysing' order by a.updated_at asc, w.created_at asc, w.id`).split('\n');
  expect(ad.map((x) => x.workspaceId)).toEqual(expected);
  const analysingTotal = Number(sql(`select count(*) from bid_workspaces where org_id = '${org}' and stage = 'analysing'`));
  saveJson('US5-4-awaiting-decision-owner', { awaitingDecision: ad, dbExpectedOrder: expected, analysingWorkspacesInOrg: analysingTotal });
  expect(r.body.pipeline.analysing).toBe(analysingTotal);

  // Another org's member sees none of this org's data.
  const other = await pwRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const u = uniqueUser('other');
  expect((await other.post('/api/auth/signup', { data: u })).status()).toBe(201);
  const o = await dash(other);
  expect(o.body.awaitingDecision).toEqual([]);
  expect(o.body.myWork).toEqual([]);
  await other.dispose();
});

// ───────────── US5-5 @mobile ─────────────

test('US5-5 @mobile Owner at 375 px: one tap on Go → one PATCH, toast "Moved to Go", row gone, funnel updates; Drop asks "Drop this bid?"', async ({ page }) => {
  await demoOwner(page);
  await atPhone(page);
  await page.goto('/dashboard');
  const card = region(page, 'Awaiting your decision');
  await expect(card).toBeVisible();
  const rows = card.locator('li');
  await expect(rows).toHaveCount(2);
  const goBefore = await funnelCount(page, 'Go');
  const analysingBefore = await funnelCount(page, 'Analysing');
  const first = await dash(page.request);
  const [target, other] = first.body.awaitingDecision;
  await card.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await evidence007(page, STORY, 'US5-5-mobile-awaiting-decision-375');

  const goBtn = card.getByRole('button', { name: `Go: ${target.title}` });
  expect((await goBtn.boundingBox())!.height).toBeGreaterThanOrEqual(40); // finger-sized
  const patches: { method: string; url: string; body: string | null }[] = [];
  page.on('request', (rq) => { if (rq.method() === 'PATCH' && /\/api\/workspaces\//.test(rq.url())) patches.push({ method: rq.method(), url: rq.url(), body: rq.postData() }); });
  const done = page.waitForResponse((rs) => rs.request().method() === 'PATCH' && rs.url().includes(`/api/workspaces/${target.workspaceId}`));
  await tap(page, goBtn); // ONE tap
  const resp = await done;
  expect(resp.status()).toBe(200);
  await expect(page.getByText('Moved to Go', { exact: true }).first()).toBeVisible();
  await expect(dialog(page)).toHaveCount(0); // no confirmation for Go
  await expect(card.locator('li')).toHaveCount(1);
  await expect(card.getByText(target.title)).toHaveCount(0);
  await expect.poll(() => funnelCount(page, 'Go')).toBe(goBefore + 1);
  await expect.poll(() => funnelCount(page, 'Analysing')).toBe(analysingBefore - 1);
  expect(patches).toHaveLength(1);
  expect(JSON.parse(patches[0].body!)).toMatchObject({ stage: 'go' });
  expect(patches[0].url).toContain(target.workspaceId);
  const after = await workspaces(page.request);
  expect(after.find((w) => w.id === target.workspaceId)!.stage).toBe('go');
  await evidence007(page, STORY, 'US5-5-mobile-after-go-toast-row-gone-funnel');

  // Drop: asks for confirmation first, nothing is sent until confirmed.
  patches.length = 0;
  await tap(page, card.getByRole('button', { name: `Drop: ${other.title}` }));
  await expect(dialog(page).getByText('Drop this bid?')).toBeVisible();
  expect(patches).toHaveLength(0);
  expect((await workspaces(page.request)).find((w) => w.id === other.workspaceId)!.stage).toBe('analysing');
  await evidence007(page, STORY, 'US5-5-mobile-drop-confirmation-dialog');
  const dropped = page.waitForResponse((rs) => rs.request().method() === 'PATCH' && rs.url().includes(other.workspaceId));
  await tap(page, dialog(page).getByRole('button', { name: 'Drop', exact: true }));
  expect((await dropped).status()).toBe(200);
  expect(JSON.parse(patches[0].body!)).toMatchObject({ stage: 'dropped' });
  expect((await workspaces(page.request)).find((w) => w.id === other.workspaceId)!.stage).toBe('dropped');
  await expect(card.locator('li')).toHaveCount(0);
  await expect(card.getByText('No decisions pending')).toBeVisible();
  saveJson('US5-5-go-and-drop', { goPatch: { target: target.workspaceId, status: resp.status(), requests: 1 }, funnel: { goBefore, analysingBefore }, dropped: other.workspaceId, finalStages: { go: 'go', drop: 'dropped' } });
  await evidence007(page, STORY, 'US5-5-mobile-after-drop-card-empty');
});

test('US5-5 desktop Owner: Go is one click (no dialog), Drop cancel keeps the bid', async ({ page }) => {
  await demoOwner(page);
  await page.goto('/dashboard');
  const card = region(page, 'Awaiting your decision');
  await expect(card.locator('li')).toHaveCount(2);
  const [t1, t2] = (await dash(page.request)).body.awaitingDecision;
  await card.getByRole('button', { name: `Drop: ${t2.title}` }).click();
  await expect(dialog(page).getByText('Drop this bid?')).toBeVisible();
  await evidence007(page, STORY, 'US5-5-desktop-drop-confirmation');
  await dialog(page).getByRole('button', { name: /cancel/i }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await workspaces(page.request)).find((w) => w.id === t2.workspaceId)!.stage).toBe('analysing');
  await card.getByRole('button', { name: `Go: ${t1.title}` }).click();
  await expect(page.getByText('Moved to Go', { exact: true }).first()).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await expect(card.locator('li')).toHaveCount(1);
  await evidence007(page, STORY, 'US5-5-desktop-after-go');
});

// ───────────── US5-6 + FR-071/072/073 role matrix ─────────────

test('US5-6 org with incomplete setup: Analyst and Viewer get Go / No-Go not "Finish setting up"; Awaiting is read-only (Analyst) / hidden (Viewer)', async ({ page, browser }) => {
  await demoOwner(page);
  // Make setup incomplete while keeping the analysed workspaces: remove the vault documents (setup step "documents").
  const org = (await (await page.request.get('/api/auth/me')).json()).org.id;
  sql(`delete from vault_documents where org_id = '${org}'`);
  const d = await dash(page.request);
  expect(d.body.setupComplete, 'setup is incomplete').toBe(false);
  expect(d.body.awaitingDecision.length).toBe(2);
  const analyst = await inviteAs(page.request, 'analyst');
  const viewer = await inviteAs(page.request, 'viewer');
  const bm = await inviteAs(page.request, 'bid_manager');

  // Controls: Owner and Bid Manager still get the setup card.
  await page.goto('/dashboard');
  await expect(page.getByText('Finish setting up', { exact: true })).toBeVisible();
  const bp = await bm.newPage(browser);
  await bp.goto('/dashboard');
  await expect(bp.getByText('Finish setting up', { exact: true })).toBeVisible();

  const ap = await analyst.newPage(browser);
  await ap.goto('/dashboard');
  await expect(ap.getByText('Go / No-Go', { exact: true })).toBeVisible();
  await expect(ap.getByText('Finish setting up')).toHaveCount(0);
  const ac = region(ap, 'Awaiting your decision');
  await expect(ac).toBeVisible();
  await expect(ac.locator('li')).toHaveCount(2); // read-only list still shows the bids
  await expect(ac.getByRole('button', { name: /^(Go|Drop)/ })).toHaveCount(0);
  await expect(ac.getByText('Analysed bids waiting on a Bid Manager')).toBeVisible();
  await evidence007(ap, STORY, 'US5-6-analyst-go-nogo-card-awaiting-read-only');

  const vp = await viewer.newPage(browser);
  await vp.goto('/dashboard');
  await expect(vp.getByText('Go / No-Go', { exact: true })).toBeVisible();
  await expect(vp.getByText('Finish setting up')).toHaveCount(0);
  await expect(vp.getByText('Awaiting your decision')).toHaveCount(0);
  await expect(vp.getByText('My bids', { exact: true })).toHaveCount(0);
  await evidence007(vp, STORY, 'US5-6-viewer-go-nogo-card-no-widgets');
  saveJson('US5-6-setup-incomplete', { setupComplete: d.body.setupComplete, setup: d.body.setup, owner: 'Finish setting up', bidManager: 'Finish setting up', analyst: 'Go / No-Go, read-only Awaiting', viewer: 'Go / No-Go, no widgets' });
});

test('US5-6 @mobile Analyst at 375 px: read-only Awaiting card without Go / Drop, no overflow', async ({ page, browser }) => {
  await demoOwner(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  await atPhone(ap);
  await ap.goto('/dashboard');
  const ac = region(ap, 'Awaiting your decision');
  await expect(ac.locator('li')).toHaveCount(2);
  await expect(ac.getByRole('button')).toHaveCount(0);
  await ac.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(ap);
  await evidence007(ap, STORY, 'US5-6-analyst-awaiting-read-only-mobile-375');
});

test('FR-071/072 role matrix on a demo org: placement of My bids and the Awaiting card per role (Owner, Bid Manager, Analyst, Viewer)', async ({ page, browser }) => {
  await demoOwner(page);
  const bm = await inviteAs(page.request, 'bid_manager');
  const analyst = await inviteAs(page.request, 'analyst');
  const viewer = await inviteAs(page.request, 'viewer');
  const matrix: Record<string, unknown> = {};

  // Owner: My bids BELOW the first row (Closing soon row), Awaiting with buttons.
  await page.goto('/dashboard');
  const om = region(page, 'My bids');
  await expect(om).toBeVisible();
  const oClosing = await box(page.getByText('Closing soon', { exact: true }).first());
  const oNewMatches = await box(page.getByText('New matches', { exact: true }).first());
  const omb = await box(om);
  expect(omb.y).toBeGreaterThan(oClosing.y + 100);
  expect(omb.y).toBeLessThan(oNewMatches.y);
  const oa = region(page, 'Awaiting your decision');
  await expect(oa.getByRole('button', { name: /^Go:/ })).toHaveCount(2);
  await expect(oa.getByRole('button', { name: /^Drop:/ })).toHaveCount(2);
  matrix.owner = { myBids: 'below first row', awaiting: 'Go+Drop x2', myBidsTop: omb.y, closingSoonTop: oClosing.y, newMatchesTop: oNewMatches.y };
  await evidence007(page, STORY, 'FR-071-owner-my-bids-below-first-row');

  // Bid Manager: My bids directly after KPI tiles, Awaiting with buttons.
  const bp = await bm.newPage(browser);
  await bp.goto('/dashboard');
  const bmb = await box(region(bp, 'My bids'));
  const bKpi = await box(bp.getByText('Docs expiring', { exact: true }).first());
  const bClosing = await box(bp.getByText('Closing soon', { exact: true }).first());
  expect(bmb.y).toBeGreaterThan(bKpi.y + bKpi.height);
  expect(bmb.y).toBeLessThan(bClosing.y);
  await expect(region(bp, 'Awaiting your decision').getByRole('button', { name: /^Go:/ })).toHaveCount(2);
  await expect(region(bp, 'Awaiting your decision').getByRole('button', { name: /^Drop:/ })).toHaveCount(2);
  matrix.bidManager = { myBids: 'after KPI tiles', awaiting: 'Go+Drop x2', myBidsTop: bmb.y, kpiBottom: bKpi.y + bKpi.height, closingSoonTop: bClosing.y };
  await evidence007(bp, STORY, 'FR-071-bid-manager-both-cards');

  // Analyst: My bids after KPI tiles, Awaiting read-only.
  const ap = await analyst.newPage(browser);
  await ap.goto('/dashboard');
  await expect(region(ap, 'My bids')).toBeVisible();
  await expect(region(ap, 'Awaiting your decision')).toBeVisible();
  expect(await region(ap, 'Awaiting your decision').getByRole('button', { name: /^(Go|Drop)/ }).count()).toBe(0);
  matrix.analyst = { myBids: 'visible', awaiting: 'read-only (0 Go/Drop buttons)' };

  // Viewer: neither widget.
  const vp = await viewer.newPage(browser);
  await vp.goto('/dashboard');
  await expect(vp.getByText('Docs expiring', { exact: true }).first()).toBeVisible();
  await expect(vp.getByRole('region', { name: 'My bids' })).toHaveCount(0);
  await expect(vp.getByRole('region', { name: 'Awaiting your decision' })).toHaveCount(0);
  matrix.viewer = { myBids: 'hidden', awaiting: 'hidden' };
  await evidence007(vp, STORY, 'FR-072-viewer-neither-widget');

  // The API only gates the UI: a Viewer's PATCH is refused (403), so the hidden buttons are not a security boundary.
  const ws = (await dash(page.request)).body.awaitingDecision[0];
  const forbidden = await viewer.api.patch(`/api/workspaces/${ws.workspaceId}`, { data: { stage: 'go' } });
  matrix.viewerPatch = forbidden.status();
  expect(forbidden.status()).toBe(403);
  const analystPatch = await analyst.api.patch(`/api/workspaces/${ws.workspaceId}`, { data: { stage: 'go' } });
  matrix.analystPatchStatus = analystPatch.status(); // informational: analysts may move stages via the pipeline
  saveJson('FR-071-072-role-matrix', matrix);
});

test('FR-073 Viewer/Analyst on a fresh org: role-gated CTAs on the empty dashboard (Bid Manager / Owner see them)', async ({ page, browser }) => {
  await freshOwner(page);
  const bm = await inviteAs(page.request, 'bid_manager');
  const analyst = await inviteAs(page.request, 'analyst');
  const viewer = await inviteAs(page.request, 'viewer');
  const res: Record<string, unknown> = {};
  for (const [name, who, wantsDemo] of [['bid_manager', bm, true], ['analyst', analyst, false], ['viewer', viewer, false]] as const) {
    const p = await who.newPage(browser);
    if (name === 'bid_manager') await openEmptyDashboard(p);
    else { await p.goto('/dashboard'); await expect(p.getByRole('heading', { name: /command centre fills up/ })).toBeVisible(); }
    const demo = await p.getByRole('button', { name: /Explore with demo data/ }).count();
    const create = await p.getByRole('link', { name: /Create (a )?watchlist/i }).count();
    const ask = await p.getByText(ASK).count();
    res[name] = { exploreDemo: demo, createWatchlist: create, askText: ask > 0 };
    expect(demo > 0).toBe(wantsDemo);
    if (name === 'viewer') { expect(create).toBe(0); expect(ask).toBeGreaterThan(0); }
    // Every visible dashboard action link/button for this role must not 403: the viewer's page offers no write CTA.
    if (name === 'viewer') {
      const wl = await who.api.post('/api/watchlists', { data: { name: 'x', criteria: { keywords: ['x'] } } });
      res.viewerCreateWatchlistApi = wl.status();
      expect(wl.status()).toBe(403);
    }
  }
  saveJson('FR-073-gated-ctas', res);
});
