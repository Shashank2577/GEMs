/**
 * 007 / US4 — Explore with demo data, then remove it (story #295, QA task T057 / #333).
 *
 * One test per acceptance scenario US4-1 … US4-14 (specs/007-experience-growth/spec.md) plus the story's
 * "Independent Test" (fresh org -> Explore with demo data -> badge, 16 cards, 15 docs; real watchlist; Remove ->
 * 0 workspaces, 0 docs, exactly one watchlist). UI scenarios are driven through the real UI; API scenarios through the
 * real API. Each scenario writes named screenshots to qa/evidence/007/US4/ and keeps its video there
 * (collectRunArtifacts). Layout-sensitive scenarios carry @mobile.
 *
 * Noted gap (not a failure): the "Sample" badge is not rendered on the dashboard lists and the pipeline cards
 * (FR-067 follow-up); US4-13 records it as an annotation and captures screenshots of both surfaces.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as pwRequest, type APIRequestContext, type Page, type Response } from '@playwright/test';
import {
  test, expect, signupViaApi, uniqueUser, inviteAs, evidence007, collectRunArtifacts, noHorizontalOverflow, putProfile,
} from '../support/fixtures';

const STORY = 'US4';
const EVID_DIR = join('qa', 'evidence', '007', STORY);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

test.afterEach(async ({ page }) => { await collectRunArtifacts('007', STORY, page); });

/** Make sure a few real (mock-GeM) tenders exist so US4-10b has a non-demo tender to open a workspace on. */
test.beforeAll(async ({}, info) => {
  const api = await pwRequest.newContext({ baseURL: info.project.use.baseURL! });
  try {
    const u = uniqueUser('ingest');
    if ((await api.post('/api/auth/signup', { data: u })).status() !== 201) return;
    const have = await api.get('/api/tenders?pageSize=1');
    if (have.ok() && (await have.json()).total > 0) return;
    for (let i = 0; i < 3; i++) {
      const r = await api.post('/api/ingestion/run', { data: { pages: 5 } });
      if (r.status() !== 429) break;
      const retryAt = Date.parse((await r.json()).error.details.retryAt);
      await new Promise((res) => setTimeout(res, Math.max(0, retryAt - Date.now()) + 1500));
    }
  } finally { await api.dispose(); }
});

// ───────────── helpers ─────────────

function saveJson(name: string, data: unknown) {
  mkdirSync(EVID_DIR, { recursive: true });
  writeFileSync(join(EVID_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

const DEMO_COMPANY = 'Aarav Technologies Pvt Ltd';
const DEMO_GSTIN = '27AAJCA4721K1ZK';
const BANNER = 'You’re exploring sample data for Aarav Technologies Pvt Ltd.';
const CONFIRM = 'Remove all demo data? Your own watchlists, documents and bids stay.';
const dialog = (page: Page) => page.locator('[role="dialog"],[role="alertdialog"]');

/** psql against the e2e database (the notifications.channel column is not exposed by the API). */
function sql(query: string): string {
  return execFileSync('psql', [E2E_DB, '-tAc', query], { encoding: 'utf8' }).trim();
}

async function me(req: APIRequestContext) {
  const r = await req.get('/api/auth/me');
  expect(r.status()).toBe(200);
  return r.json();
}
const orgIdOf = async (req: APIRequestContext): Promise<string> => (await me(req)).org.id;

async function seed(req: APIRequestContext) {
  const r = await req.post('/api/demo/seed');
  return { status: r.status(), body: await r.json() };
}

async function remove(req: APIRequestContext) {
  const r = await req.delete('/api/demo');
  return { status: r.status(), body: await r.json() };
}

async function counts(req: APIRequestContext) {
  const ws = await (await req.get('/api/workspaces')).json();
  const vault = await (await req.get('/api/vault?pageSize=100')).json();
  const wl = await (await req.get('/api/watchlists')).json();
  const vItems = (vault.items ?? vault) as { title: string }[];
  const wItems = (wl.items ?? wl) as { name: string }[];
  return {
    workspaces: (ws.items as unknown[]).length,
    vault: vItems.length,
    watchlists: wItems.length,
    watchlistNames: wItems.map((w) => w.name),
    vaultTitles: vItems.map((d) => d.title),
  };
}

async function createWatchlist(req: APIRequestContext, name: string) {
  const r = await req.post('/api/watchlists', { data: { name, criteria: { keywords: ['laptop'] } } });
  expect(r.status(), await r.text()).toBe(201);
  return r.json();
}

/** A real PDF, small and unique (the vault rejects duplicates). */
function userPdf(tag: string) {
  return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%% ${tag} ${Math.random()}\n%%EOF`);
}
async function uploadUserDoc(req: APIRequestContext, title: string) {
  const r = await req.post('/api/vault', {
    multipart: { type: 'other', title, file: { name: 'Real GST.pdf', mimeType: 'application/pdf', buffer: userPdf(title) } },
  });
  expect(r.status(), await r.text()).toBe(201);
  return r.json();
}

async function freshOwner(page: Page, prefix = 'own') {
  return signupViaApi(page, { ...uniqueUser(prefix), name: 'Aarav Shah' });
}
async function freshDemoOwner(page: Page) {
  const user = await freshOwner(page);
  const s = await seed(page.request);
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return { user, seeded: s.body };
}
const prof = (p: any) => p.profile ?? p;
const legalName = (page: Page) => page.getByLabel('Legal name').first();

/** A brand-new owner is sent to /onboarding once per browser session; visit the dashboard twice to land on it. */
async function openEmptyDashboard(page: Page) {
  await page.goto('/dashboard');
  await page.waitForURL(/\/onboarding/); // the one-time redirect (sessionStorage flag is set by then)
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /command centre fills up/ })).toBeVisible();
}

// ───────────── US4-1 … US4-5: seed API ─────────────

test('US4-1 seed requires a session (401) and a Bid Manager (Viewer/Analyst 403)', async ({ page, browser, playwright }) => {
  const anon = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  const r401 = await anon.post('/api/demo/seed');
  expect(r401.status()).toBe(401);
  await anon.dispose();

  await freshOwner(page);
  const viewer = await inviteAs(page.request, 'viewer');
  const analyst = await inviteAs(page.request, 'analyst');
  const rv = await seed(viewer.api);
  const ra = await seed(analyst.api);
  expect(rv.status).toBe(403);
  expect(ra.status).toBe(403);
  expect((await counts(page.request)).workspaces).toBe(0); // the refused calls seeded nothing
  saveJson('US4-1-roles', { anonymous: r401.status(), viewer: rv, analyst: ra });

  const vp = await viewer.newPage(browser);
  await vp.goto('/dashboard');
  await expect(vp.getByRole('heading', { name: /command centre fills up/ })).toBeVisible();
  await expect(vp.getByRole('button', { name: 'Explore with demo data' })).toHaveCount(0);
  await evidence007(vp, STORY, 'US4-1-viewer-empty-dashboard-no-explore-button');
});

test('US4-2 Bid Manager seeds a fresh org: 201 with the full counts and onboardingState.demo = true', async ({ page }) => {
  await freshOwner(page);
  const bm = await inviteAs(page.request, 'bid_manager');
  const s = await seed(bm.api);
  expect(s.status).toBe(201);
  expect(s.body).toMatchObject({ ok: true, created: true, tenders: 40, watchlists: 3, workspaces: 16, analyses: 20, pastContracts: 5, vaultDocuments: 15 });
  expect(s.body.matches).toBeGreaterThan(15);
  expect((await me(bm.api)).org.onboardingState.demo).toBe(true);
  saveJson('US4-2-seed-response', s);

  await page.goto('/dashboard');
  await expect(page.getByText('Demo data', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(BANNER)).toBeVisible();
  await evidence007(page, STORY, 'US4-2-dashboard-after-bid-manager-seed');
});

test('US4-3 a second seed answers 200 created:false and changes nothing', async ({ page }) => {
  await freshOwner(page);
  const first = await seed(page.request);
  expect(first.status).toBe(201);
  const orgId = await orgIdOf(page.request);
  const analysesOf = () => sql(`select count(*) from analyses where org_id = '${orgId}'`);
  const demoTenders = () => sql(`select count(*) from tenders where raw->>'demo' = 'true'`);
  const before = { ...(await counts(page.request)), analyses: analysesOf(), demoTenders: demoTenders() };
  const second = await seed(page.request);
  expect(second.status).toBe(200);
  expect(second.body.created).toBe(false);
  expect(second.body).toMatchObject({ workspaces: 16, analyses: 20, vaultDocuments: 15, tenders: 40 });
  const after = { ...(await counts(page.request)), analyses: analysesOf(), demoTenders: demoTenders() };
  expect(after.workspaces).toBe(before.workspaces);
  expect(after.vault).toBe(before.vault);
  expect(after.analyses).toBe(before.analyses);
  expect(after.analyses).toBe('20');
  expect(after.demoTenders).toBe(before.demoTenders);
  expect(after.demoTenders).toBe('40');
  saveJson('US4-3-second-seed', { first: first.body, second, before, after });

  await page.goto('/pipeline');
  await expect(page.getByRole('heading', { name: 'Pipeline', exact: true }).first()).toBeVisible();
  await evidence007(page, STORY, 'US4-3-pipeline-16-cards-after-second-seed');
});

test('US4-4 the demo profile: Aarav Technologies, GSTIN, micro, class_1, 3 financial years', async ({ page }) => {
  await freshDemoOwner(page);
  const p = prof(await (await page.request.get('/api/profile')).json());
  saveJson('US4-4-profile', p);
  expect(p.legalName).toBe(DEMO_COMPANY);
  expect(p.gstin).toBe(DEMO_GSTIN);
  expect(p.mseCategory).toBe('micro');
  expect(p.miiClass).toBe('class_1');
  expect(p.financials).toHaveLength(3);
  await page.goto('/profile');
  await expect(legalName(page)).toHaveValue(DEMO_COMPANY);
  await evidence007(page, STORY, 'US4-4-demo-profile');
});

test('US4-5 an existing profile is never overwritten, but the org still gets its own 16 workspaces', async ({ page }) => {
  await freshOwner(page);
  await putProfile(page.request, { legalName: 'Shree Ganesh Traders LLP', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F' });
  const s = await seed(page.request);
  expect(s.status).toBe(201);
  expect(s.body.workspaces).toBe(16);
  const p = prof(await (await page.request.get('/api/profile')).json());
  expect(p.legalName).toBe('Shree Ganesh Traders LLP');
  expect((await counts(page.request)).workspaces).toBe(16);
  saveJson('US4-5-profile-kept', { seed: s.body, legalName: p.legalName });
  await page.goto('/profile');
  await expect(legalName(page)).toHaveValue('Shree Ganesh Traders LLP');
  await evidence007(page, STORY, 'US4-5-existing-profile-kept');
});

// ───────────── US4-6 … US4-7: vault PDFs, Kanban ─────────────

test('US4-6 every demo vault document downloads as a valid one-page PDF with the sample footer', async ({ page }) => {
  await freshDemoOwner(page);
  const list = await (await page.request.get('/api/vault?pageSize=100')).json();
  const items = (list.items ?? list) as { id: string; title: string }[];
  expect(items).toHaveLength(15);
  const rows: unknown[] = [];
  for (const d of items) {
    const res = await page.request.get(`/api/vault/${d.id}/download`);
    expect(res.status(), d.title).toBe(200);
    const ct = res.headers()['content-type'];
    const cd = res.headers()['content-disposition'];
    expect(ct, d.title).toContain('application/pdf');
    const buf = await res.body();
    const text = buf.toString('latin1');
    expect(text.startsWith('%PDF-'), d.title).toBe(true);
    expect(text).toContain('Sample document generated by TenderPilot demo data - not a real certificate.');
    const pages = (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
    expect(pages, `${d.title} pages`).toBe(1);
    rows.push({ title: d.title, contentType: ct, contentDisposition: cd, bytes: buf.length, pages });
  }
  saveJson('US4-6-pdf-downloads', rows);
  await page.goto('/vault');
  await expect(page.getByText(/Expired|Expiring/i).first()).toBeVisible();
  await evidence007(page, STORY, 'US4-6-vault-15-documents');
});

test('US4-7 the Ready card is a Go and the Preparing card on the expired Dell authorisation is blocked (409)', async ({ page }) => {
  await freshDemoOwner(page);
  const ws = await (await page.request.get('/api/workspaces')).json();
  const items = ws.items as { id: string; stage: string; tender: { title: string }; analysis: { verdict: string } | null }[];
  const stages = new Set(items.map((i) => i.stage));
  expect(stages.has('dropped')).toBe(false);
  expect(stages.size).toBeGreaterThanOrEqual(7);
  const ready = items.filter((i) => i.stage === 'ready');
  expect(ready.length).toBeGreaterThan(0);
  for (const r of ready) expect(r.analysis?.verdict).toBe('go');

  let blocked: { id: string; status: number; body: any } | null = null;
  for (const card of items.filter((i) => i.stage === 'preparing')) {
    const res = await page.request.patch(`/api/workspaces/${card.id}`, { data: { stage: 'ready' } });
    if (res.status() === 409) { blocked = { id: card.id, status: 409, body: await res.json() }; break; }
    await page.request.patch(`/api/workspaces/${card.id}`, { data: { stage: 'preparing' } }); // allowed to move: put it back
  }
  expect(blocked, 'a Preparing card must be blocked from Ready').not.toBeNull();
  expect(blocked!.body.error.code).toBe('not_ready');
  expect(JSON.stringify(blocked!.body.error.details.blockers)).toMatch(/oem_authorization.*expired/); // the OEM (Dell) authorisation is expired
  saveJson('US4-7-blocked-and-ready', { stages: [...stages], ready: ready.map((r) => ({ title: r.tender.title, verdict: r.analysis?.verdict })), blocked });

  await page.goto('/pipeline');
  await expect(page.getByRole('heading', { name: 'Pipeline', exact: true }).first()).toBeVisible();
  await evidence007(page, STORY, 'US4-7-kanban-all-stages');
});

// ───────────── US4-8 … US4-9: seeding from the banner, notifications ─────────────

test('US4-8 Explore with demo data on the dashboard banner: spinner, toast, badge without a reload @mobile', async ({ page }, info) => {
  await freshOwner(page);
  const mobile = info.project.name === 'mobile';
  await openEmptyDashboard(page);
  const explore = page.getByRole('button', { name: 'Explore with demo data' });
  await expect(explore).toBeVisible();
  await expect(page.getByText('Demo data', { exact: true })).toHaveCount(0);
  if (mobile) await noHorizontalOverflow(page);
  await evidence007(page, STORY, `US4-8-empty-dashboard-banner-${info.project.name}`);

  // slow the response so the loading state can be observed; a window marker proves nothing reloads
  await page.evaluate(() => { (window as any).__noReload = 'still-here'; });
  let navigations = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations += 1; });
  let seedStatus = 0;
  await page.route('**/api/demo/seed', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    const resp = await route.fetch();
    seedStatus = resp.status();
    await route.fulfill({ response: resp });
  });
  await explore.click();
  await expect(explore).toBeDisabled(); // loading state: the button is busy
  await evidence007(page, STORY, `US4-8-spinner-${info.project.name}`);

  await expect(page.getByText('Demo data loaded — explore away!')).toBeVisible();
  await expect(page.getByText('Demo data', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(BANNER)).toBeVisible();
  expect(seedStatus).toBe(201);
  expect(await page.evaluate(() => (window as any).__noReload)).toBe('still-here');
  expect(navigations).toBe(0);
  if (mobile) await noHorizontalOverflow(page);
  await evidence007(page, STORY, `US4-8-badge-and-toast-no-reload-${info.project.name}`);
  saveJson(`US4-8-no-reload-${info.project.name}`, { seedStatus, navigations, marker: 'survived' });
});

test('US4-9 demo notifications are in-app only and demo activity is flagged', async ({ page }) => {
  await freshDemoOwner(page);
  const orgId = await orgIdOf(page.request);
  const total = Number(sql(`select count(*) from notifications where org_id = '${orgId}'`));
  const inApp = Number(sql(`select count(*) from notifications where org_id = '${orgId}' and channel = 'in_app'`));
  expect(total).toBeGreaterThan(0);
  expect(inApp).toBe(total);
  const demoActs = Number(sql(`select count(*) from activity_log where org_id = '${orgId}' and meta->>'demo' = 'true'`));
  expect(demoActs).toBeGreaterThan(0);
  expect(sql(`select count(*) from activity_log where org_id = '${orgId}' and action = 'demo.seeded'`)).toBe('1');
  const feed = await (await page.request.get('/api/notifications')).json();
  saveJson('US4-9-channels', { notifications: total, inApp, demoFlaggedActivity: demoActs, apiTotal: feed.total });

  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' }).first()).toBeVisible();
  await evidence007(page, STORY, 'US4-9-in-app-notifications');
});

// ───────────── US4-10 … US4-12: removal ─────────────

test('US4-10 removal deletes only demo rows: user watchlists (even with a demo name), vault docs stay; idempotent', async ({ page }) => {
  await freshDemoOwner(page);
  const demoCounts = await counts(page.request);
  expect(demoCounts).toMatchObject({ workspaces: 16, vault: 15, watchlists: 3 });

  const mine = await createWatchlist(page.request, 'My laptops');
  const lookalike = await createWatchlist(page.request, 'IT hardware – Maharashtra & Goa'); // same name as a demo watchlist, made by the user
  await uploadUserDoc(page.request, 'Real GST');
  expect((await counts(page.request)).watchlists).toBe(5);

  const r = await remove(page.request);
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
  expect(r.body.removed).toMatchObject({ workspaces: 16, analyses: 20, pastContracts: 5, vaultDocuments: 15, watchlists: 3, profileReset: true });
  expect(r.body.removed.matches).toBeGreaterThan(0);
  expect(r.body.removed.comments).toBeGreaterThan(0);
  expect(r.body.removed.notifications).toBeGreaterThan(0);

  const after = await counts(page.request);
  expect(after.workspaces).toBe(0);
  expect(after.vaultTitles).toEqual(['Real GST']);
  expect(after.watchlistNames.sort()).toEqual(['IT hardware – Maharashtra & Goa', 'My laptops']);
  const wl = await (await page.request.get('/api/watchlists')).json();
  expect(((wl.items ?? wl) as { id: string }[]).map((w) => w.id).sort()).toEqual([mine.id, lookalike.id].sort());
  expect((await me(page.request)).org.onboardingState.demo).toBe(false);
  const orgId = await orgIdOf(page.request);
  expect(sql(`select count(*) from activity_log where org_id='${orgId}' and action='demo.removed'`)).toBe('1');
  expect(sql(`select count(*) from analyses where org_id='${orgId}'`)).toBe('0');
  expect(sql(`select count(*) from notifications where org_id='${orgId}' and dedupe_key like 'demo:%'`)).toBe('0');
  expect(sql(`select count(*) from past_contracts where org_id='${orgId}'`)).toBe('0');
  expect(sql(`select count(*) from vault_documents where org_id='${orgId}'`)).toBe('1');

  const again = await remove(page.request);
  expect(again.status).toBe(200);
  expect(Object.entries(again.body.removed).filter(([k]) => k !== 'profileReset').every(([, v]) => v === 0)).toBe(true);
  expect(again.body.removed.profileReset).toBe(false);
  expect(sql(`select count(*) from activity_log where org_id='${orgId}' and action='demo.removed'`)).toBe('1');
  saveJson('US4-10-removal', { demoCounts, first: r, after, second: again });

  await page.goto('/watchlists');
  await expect(page.getByText('My laptops').first()).toBeVisible();
  await evidence007(page, STORY, 'US4-10-watchlists-after-removal');
  await page.goto('/vault');
  await expect(page.getByText('Real GST').first()).toBeVisible();
  await evidence007(page, STORY, 'US4-10-vault-after-removal');
});

test('US4-10b removal keeps a user-created workspace on a real (non-demo) tender', async ({ page }) => {
  await freshOwner(page);
  const tenders = await (await page.request.get('/api/tenders?pageSize=50')).json();
  const real = (tenders.items as { id: string; isDemo?: boolean }[]).find((t) => !t.isDemo);
  test.skip(!real, 'no non-demo tender available in this environment');
  const created = await page.request.post(`/api/tenders/${real!.id}/workspace`);
  expect([200, 201], await created.text()).toContain(created.status());
  await seed(page.request);
  expect((await counts(page.request)).workspaces).toBe(17);
  const r = await remove(page.request);
  expect(r.body.removed.workspaces).toBe(16);
  const after = await (await page.request.get('/api/workspaces')).json();
  expect(after.items).toHaveLength(1);
  expect(after.items[0].tender.id).toBe(real!.id);
  saveJson('US4-10b-user-workspace', { removed: r.body.removed, remaining: after.items.map((i: any) => i.tender.title) });
  await page.goto('/pipeline');
  await expect(page.getByText(after.items[0].tender.title).first()).toBeVisible();
  await evidence007(page, STORY, 'US4-10b-user-workspace-kept');
});

test('US4-11 Viewer and Analyst cannot DELETE /api/demo (403); the org keeps its data', async ({ page, playwright }) => {
  await freshDemoOwner(page);
  const viewer = await inviteAs(page.request, 'viewer');
  const analyst = await inviteAs(page.request, 'analyst');
  const rv = await remove(viewer.api);
  const ra = await remove(analyst.api);
  expect(rv.status).toBe(403);
  expect(ra.status).toBe(403);
  const anon = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  expect((await anon.delete('/api/demo')).status()).toBe(401);
  await anon.dispose();
  expect((await counts(page.request)).workspaces).toBe(16);
  saveJson('US4-11-forbidden', { viewer: rv, analyst: ra });
  await page.goto('/dashboard');
  await expect(page.getByText(BANNER)).toBeVisible();
  await evidence007(page, STORY, 'US4-11-data-intact-after-403');
});

test('US4-12 banner, confirmation dialog, cancel keeps data, confirm removes it with a toast and an empty dashboard @mobile', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile';
  await freshOwner(page);
  await openEmptyDashboard(page);
  await page.getByRole('button', { name: 'Explore with demo data' }).click();
  await expect(page.getByText('Demo data loaded — explore away!')).toBeVisible();
  await expect(page.getByText(BANNER)).toBeVisible();
  const removeBtn = page.getByRole('button', { name: 'Remove demo data' });
  await expect(removeBtn).toBeVisible();
  if (mobile) await noHorizontalOverflow(page);
  await evidence007(page, STORY, `US4-12-demo-banner-${info.project.name}`);

  await removeBtn.click();
  await expect(dialog(page).getByText(CONFIRM)).toBeVisible();
  if (mobile) await noHorizontalOverflow(page);
  await evidence007(page, STORY, `US4-12-confirm-dialog-${info.project.name}`);

  await dialog(page).getByRole('button', { name: /cancel|keep|no/i }).first().click(); // cancel removes nothing
  await expect(dialog(page)).toHaveCount(0);
  expect((await counts(page.request)).workspaces).toBe(16);

  await removeBtn.click();
  await expect(dialog(page).getByText(CONFIRM)).toBeVisible();
  const delResp = page.waitForResponse((r: Response) => r.url().endsWith('/api/demo') && r.request().method() === 'DELETE');
  await dialog(page).getByRole('button', { name: 'Remove demo data' }).click();
  expect((await delResp).status()).toBe(200);
  await expect(page.getByText('Demo data removed')).toBeVisible();
  await expect(page.getByText(BANNER)).toHaveCount(0);
  await expect(page.getByText('Demo data', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /command centre fills up/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore with demo data' })).toBeVisible();
  expect(await counts(page.request)).toMatchObject({ workspaces: 0, vault: 0, watchlists: 0 });
  if (mobile) await noHorizontalOverflow(page);
  await evidence007(page, STORY, `US4-12-removed-toast-empty-dashboard-${info.project.name}`);
});

test('US4-12b Viewer and Analyst see the banner but no "Remove demo data" button', async ({ page, browser }) => {
  await freshDemoOwner(page);
  for (const role of ['viewer', 'analyst'] as const) {
    const u = await inviteAs(page.request, role);
    const p = await u.newPage(browser);
    await p.goto('/dashboard');
    await expect(p.getByText(BANNER)).toBeVisible();
    await expect(p.getByRole('button', { name: 'Remove demo data' })).toHaveCount(0);
    await expect(p.getByRole('button', { name: 'Explore with demo data' })).toHaveCount(0);
    await evidence007(p, STORY, `US4-12b-${role}-banner-without-buttons`);
  }
});

// ───────────── US4-13: Sample badge ─────────────

test('US4-13 demo tenders carry a Sample badge in the feed and on the tender page @mobile', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile';
  await freshDemoOwner(page);
  const ws = await (await page.request.get('/api/workspaces')).json();
  const tenderId = ws.items[0].tender.id as string;
  const feed = await (await page.request.get('/api/tenders?pageSize=100')).json();
  expect((feed.items as { isDemo?: boolean }[]).filter((t) => t.isDemo).length).toBeGreaterThan(0);
  expect((await (await page.request.get(`/api/tenders/${tenderId}`)).json()).isDemo).toBe(true);

  await page.goto('/tenders');
  const badge = page.getByText('Sample', { exact: true });
  await expect(badge.first()).toBeVisible();
  const n = await badge.count();
  if (mobile) await noHorizontalOverflow(page);
  await evidence007(page, STORY, `US4-13-feed-sample-badge-${info.project.name}`);

  await page.goto(`/tenders/${tenderId}`);
  await expect(page.getByText('Sample', { exact: true }).first()).toBeVisible();
  if (mobile) await noHorizontalOverflow(page);
  await evidence007(page, STORY, `US4-13-tender-page-sample-badge-${info.project.name}`);

  if (!mobile) {
    await page.goto('/tenders');
    const table = page.getByRole('button', { name: /table/i }).or(page.getByRole('radio', { name: /table/i })).first();
    if (await table.count()) {
      await table.click();
      await expect(page.getByRole('table')).toBeVisible();
      await expect(page.getByRole('table').getByText('Sample', { exact: true }).first()).toBeVisible();
      await evidence007(page, STORY, `US4-13-feed-table-sample-badge-${info.project.name}`);
    }
  }

  // NOTED GAP (FR-067 follow-up, known and deferred - not a failure): no Sample badge on dashboard lists / pipeline cards.
  await page.goto('/pipeline');
  await expect(page.getByRole('heading', { name: 'Pipeline', exact: true }).first()).toBeVisible();
  const onPipeline = await page.getByText('Sample', { exact: true }).count();
  if (!mobile) await evidence007(page, STORY, `US4-13-noted-gap-pipeline-no-badge-${info.project.name}`);
  await page.goto('/dashboard');
  await expect(page.getByText(BANNER)).toBeVisible();
  const onDashboard = await page.getByText('Sample', { exact: true }).count();
  info.annotations.push({ type: 'noted gap', description: `FR-067 follow-up (deferred): Sample badge count pipeline=${onPipeline}, dashboard=${onDashboard}` });
  saveJson(`US4-13-noted-gap-${info.project.name}`, { feedBadges: n, pipelineBadges: onPipeline, dashboardBadges: onDashboard, note: 'deferred FR-067 follow-up' });
  if (!mobile) await evidence007(page, STORY, `US4-13-noted-gap-dashboard-no-badge-${info.project.name}`);
});

// ───────────── US4-14: profile reset vs kept ─────────────

test('US4-14 a still-demo profile is reset on removal; a profile edited away from the demo values is kept', async ({ page }) => {
  await freshDemoOwner(page);
  expect(prof(await (await page.request.get('/api/profile')).json()).legalName).toBe(DEMO_COMPANY);
  const r = await remove(page.request);
  expect(r.body.removed.profileReset).toBe(true);
  const after = prof(await (await page.request.get('/api/profile')).json());
  expect(after.legalName ?? '').toBe('');
  expect(after.gstin ?? '').toBe('');
  await page.goto('/profile');
  await expect(legalName(page)).toHaveValue('');
  await evidence007(page, STORY, 'US4-14-profile-reset-after-removal');

  await freshDemoOwner(page);
  await putProfile(page.request, { legalName: 'Aarav Technologies Private Limited (edited)', tradeName: 'My own brand' });
  const rk = await remove(page.request);
  expect(rk.body.removed.profileReset).toBe(false);
  const kept = prof(await (await page.request.get('/api/profile')).json());
  expect(kept.legalName).toBe('Aarav Technologies Private Limited (edited)');
  saveJson('US4-14-profile', { resetCase: { removed: r.body.removed, after }, keptCase: { removed: rk.body.removed, legalName: kept.legalName } });
  await page.goto('/profile');
  await expect(legalName(page)).toHaveValue('Aarav Technologies Private Limited (edited)');
  await evidence007(page, STORY, 'US4-14-edited-profile-kept');
});

// ───────────── Independent Test ─────────────

test('Independent Test: fresh org -> Explore with demo data -> badge, 16 cards, 15 docs; real watchlist; Remove -> 0 / 0 / 1', async ({ page }) => {
  await freshOwner(page);
  await openEmptyDashboard(page);
  await page.getByRole('button', { name: 'Explore with demo data' }).click();
  await expect(page.getByText('Demo data loaded — explore away!')).toBeVisible();
  await expect(page.getByText('Demo data', { exact: true }).first()).toBeVisible();
  expect(await counts(page.request)).toMatchObject({ workspaces: 16, vault: 15, watchlists: 3 });

  await createWatchlist(page.request, 'My real watchlist');
  await page.reload();
  await page.getByRole('button', { name: 'Remove demo data' }).click();
  await dialog(page).getByRole('button', { name: 'Remove demo data' }).click();
  await expect(page.getByText('Demo data removed')).toBeVisible();
  expect(await counts(page.request)).toMatchObject({ workspaces: 0, vault: 0, watchlists: 1, watchlistNames: ['My real watchlist'] });
  await page.goto('/watchlists');
  await expect(page.getByText('My real watchlist').first()).toBeVisible();
  await evidence007(page, STORY, 'US4-independent-test-one-watchlist-left');
});
