/**
 * 003 / US6 (#67) — Bid results, award status and competitor intelligence. QA task T076.
 * Covers spec scenarios 1-6 and FR-060..FR-064.
 *
 * Serial. One org (Owner / Analyst / Viewer) tracks six recorded bids through a computers watchlist. The setup test syncs
 * mock-gem ONCE (36 bids), closes the six tenders in SQL (end_at two days ago: the refresh only looks at tenders that closed
 * within 30 days) and arranges GeM through the mock-gem admin: `gemAward` awards 6421001 (Maharashtra), 6421009 (Gujarat),
 * 6421020 (Jharkhand) and evaluates 6421010 as `tech_evaluated`; 6421021 is left alone (GeM does not list it in the
 * submitted-bids search). The daily refresh is triggered through POST /api/__test/results/refresh (E2E_TEST_HOOKS=1).
 * Between runs the 24 h per-tender recheck window is passed by ageing tender_results.checked_at via SQL.
 *
 *   S1  refresh #1: tenders -> awarded + events, tender_results rows, GeM request count per checked tender    (scenario 1)
 *   S2  GET /result 200 shape + Result tab: evaluation badge, L1 row highlighted, ₹ Indian grouping, source link (scenario 2)
 *   S3  tech_evaluated -> 200 + bidders [] + exact "hasn't published" copy; not_listed lastCheck copy         (scenario 3)
 *   S4  "Result published: ..." in-app alert (bell + /notifications) for every member, 1 row per user; dedupe  (scenario 4)
 *   S5  Competitors: table ranked by wins, ₹ value, categories, category + state filter, flagged award, viewer read-only,
 *       empty state for an org with nothing tracked + awarded                                                  (scenario 5)
 *   S6  parser failure: a second API process whose GeM base URL is a pass-through proxy that serves an unreadable result
 *       page; the refresh records the error on the run and leaves the stored result untouched                  (scenario 6)
 *   A11y light/dark on the Result tab and the Competitors page; @mobile Result tab + Competitors at 375 px.
 *
 * Arrangement notes (honest scope): the "winner is not the lowest price" award cannot be produced by mock-gem (its recorded
 * pages always award L1), so one extra tracked tender (6421030) gets a tender_results row by SQL; the aggregation and the UI
 * flag on it are real. The mock cannot serve an unreadable result page either, hence the proxy in S6. E2E runs with
 * GEM_MIN_INTERVAL_MS=0, so the 1 req/s spacing itself is only asserted by the unit tests (client throttle); here the number of
 * GeM requests per checked tender is asserted instead.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { test, expect, evidence, collectRunArtifacts, checkA11y, mockGem, gemAward, uniqueUser, noHorizontalOverflow, GEM_URL } from '../support/fixtures';

const SPEC = '003', STORY = 'US6';
const PORT = process.env.E2E_PORT || 8788;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
const STATE_FILE = join('qa', '.runs', `us6-state-${PORT}.json`);

const BID_A = 'GEM/2026/B/6421001'; // Maharashtra, Laptop - Notebook  -> awarded
const BID_B = 'GEM/2026/B/6421009'; // Gujarat, Desktop Computers (Q2) -> awarded
const BID_C = 'GEM/2026/B/6421010'; // Maharashtra, Laptop - Notebook  -> tech_evaluated (not published)
const BID_D = 'GEM/2026/B/6421020'; // Jharkhand, Printer Cartridge    -> awarded, later unreadable (S6)
const BID_E = 'GEM/2026/B/6421021'; // Kerala, Laptop - Notebook       -> GeM does not list it (not_listed)
const BID_F = 'GEM/2026/B/6421030'; // Maharashtra, Server (Q2)        -> seeded award where the winner is not L1
const ALL_BIDS = [BID_A, BID_B, BID_C, BID_D, BID_E, BID_F];
const L1_SELLER = 'Kaveri Systems & Services Pvt Ltd';
const NOT_PUBLISHED = 'GeM hasn’t published the result yet. We check daily for 30 days after closing.';

const sql = (q: string) => execFileSync('psql', [DB, '-qtAX', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const note = (type: string, description: string) => test.info().annotations.push({ type, description });

type Creds = { email: string; password: string; id: string; name: string };
type Saved = { owner: Creds; analyst: Creds; viewer: Creds; org2: Creds; ids: Record<string, string>; orgId: string };
let S: Saved | undefined;

/** Clean ingestion state (and the mock GeM) so the spec passes alone or after other 003 specs. Needs a database named *e2e*. */
async function resetIngestionData(request: APIRequestContext) {
  if (!/e2e/i.test(new URL(DB).pathname)) throw new Error(`refusing to truncate ${DB} (database name must contain "e2e")`);
  sql('truncate tenders, ingestion_runs, notifications, watchlists cascade');
  await mockGem(request, '/__admin/reset');
  await mockGem(request, '/__admin/fail', { mode: 'off' });
}

async function shot(page: Page, name: string) {
  const project = test.info().project.name;
  const h = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
  if (project === 'desktop' && h <= 1800) return evidence(page, SPEC, STORY, `${name}-${project}`);
  const dir = join('qa', 'evidence', SPEC, STORY);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}-${project}.png`);
  await page.screenshot({ path: file, scale: 'css' });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
  return file;
}

async function login(page: Page, c: { email: string; password: string }) {
  await page.context().clearCookies();
  const res = await page.request.post('/api/auth/login', { data: { email: c.email, password: c.password } });
  expect(res.status(), await res.text()).toBe(200);
}
async function apiAs(c: { email: string; password: string }) {
  const r = await pwRequest.newContext({ baseURL: BASE });
  const res = await r.post('/api/auth/login', { data: { email: c.email, password: c.password } });
  expect(res.status(), await res.text()).toBe(200);
  return r;
}
async function anonStatus(path: string) {
  const r = await pwRequest.newContext({ baseURL: BASE });
  const res = await r.get(path);
  await r.dispose();
  return res.status();
}
async function syncNow(req: APIRequestContext) {
  sql("update ingestion_runs set started_at = started_at - interval '10 minutes', finished_at = finished_at - interval '10 minutes' where finished_at is not null");
  for (let i = 0; i < 3; i++) {
    const res = await req.post('/api/ingestion/run', { data: { pages: 5 } });
    if (res.status() !== 429) { expect(res.status(), await res.text()).toBe(200); return res.json(); }
    const retryAt = Date.parse((await res.json()).error.details.retryAt);
    await sleep(Math.max(0, retryAt - Date.now()) + 1500);
  }
  throw new Error('cooldown never cleared');
}
type Refresh = { id: string; status: string; checked: number; stored: number; awarded: number; error: string | null };
async function refresh(req: APIRequestContext, base?: string): Promise<Refresh> {
  const res = await req.post(`${base ?? ''}/api/__test/results/refresh`);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
/** Pass the 24 h per-tender recheck window. */
const ageChecks = () => sql("update tender_results set checked_at = checked_at - interval '2 days' where checked_at is not null");
const mockRequests = async (req: APIRequestContext) => ((await (await req.get(`${GEM_URL}/__admin/state`)).json()) as { requests: Record<string, number> }).requests;

const bell = (page: Page) => page.getByRole('button', { name: /^Notifications(, \d+ unread)?$/ });
const resultTab = (page: Page) => page.getByRole('tab', { name: 'Result' });
async function openResult(page: Page, tenderId: string) {
  await page.goto(`/tenders/${tenderId}?tab=result`);
  await expect(resultTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('evaluation-status')).toBeVisible();
}
async function setScheme(page: Page, scheme: 'light' | 'dark') {
  await page.evaluate((s) => { try { localStorage.setItem('tp-theme', s); } catch { /* ignore */ } }, scheme);
  await page.emulateMedia({ colorScheme: scheme });
  await page.reload();
  await expect(page.locator('html')).toHaveClass(scheme === 'dark' ? /dark/ : /^(?!.*dark)/);
}

test.beforeAll(async ({ request }, info) => { if (info.project.name === 'desktop') await resetIngestionData(request); });
test.beforeEach(async () => {
  test.skip(/@mobile/.test(test.info().title) && test.info().project.name === 'desktop', 'covered by the mobile project');
  if (S || test.info().title.startsWith('setup')) return;
  S = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Saved;
});
test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

test.describe('US6 results & competitor intelligence', () => {
  test.setTimeout(240_000);

  test('setup: org + members, ONE sync (36 bids), watchlist tracks 6 bids, tenders closed, GeM awards/evaluates', async ({ page }) => {
    S = undefined;
    const ownerU = uniqueUser('owner');
    const own = await pwRequest.newContext({ baseURL: BASE });
    expect((await own.post('/api/auth/signup', { data: ownerU })).status()).toBe(201);
    const me = async (r: APIRequestContext) => ((await (await r.get('/api/auth/me')).json()) as { user: { id: string } }).user.id;
    const owner: Creds = { email: ownerU.email, password: ownerU.password, id: await me(own), name: ownerU.name };
    const orgId = sql(`select org_id from memberships where user_id='${owner.id}'`);
    const invite = async (role: 'analyst' | 'viewer'): Promise<Creds> => {
      const u = uniqueUser(role);
      const inv = await own.post('/api/org/invitations', { data: { email: u.email, role } });
      expect(inv.status(), await inv.text()).toBe(201);
      const token = (await inv.json()).inviteUrl.split('/invite/')[1];
      const anon = await pwRequest.newContext({ baseURL: BASE });
      const acc = await anon.post('/api/auth/accept-invite', { data: { token, name: u.name, password: u.password } });
      expect(acc.status(), await acc.text()).toBe(200);
      const id = await me(anon);
      await anon.dispose();
      return { email: u.email, password: u.password, id, name: u.name };
    };
    const analyst = await invite('analyst');
    const viewer = await invite('viewer');
    // A second org that tracks nothing: its Competitors page is the empty state (and it cannot see org 1's awards).
    const o2 = uniqueUser('orgtwo');
    const r2 = await pwRequest.newContext({ baseURL: BASE });
    expect((await r2.post('/api/auth/signup', { data: o2 })).status()).toBe(201);
    const org2: Creds = { email: o2.email, password: o2.password, id: await me(r2), name: o2.name };

    const run = await syncNow(own);
    expect(run).toMatchObject({ status: 'success', tendersCreated: 36 });
    const wl = await own.post('/api/watchlists', { data: { name: 'Computers', criteria: { keywords: ['laptop', 'computer', 'desktop', 'server', 'printer'] } } });
    expect(wl.status(), await wl.text()).toBe(201);

    const ids: Record<string, string> = {};
    for (const b of ALL_BIDS) {
      ids[b] = sql(`select id from tenders where bid_number='${b}'`);
      expect(sql(`select count(*) from tender_matches where tender_id='${ids[b]}' and org_id='${orgId}'`), `${b} is tracked through a match`).toBe('1');
    }
    // Closed two days ago (the refresh looks at tenders that closed within 30 days) ...
    sql(`update tenders set end_at = now() - interval '2 days' where bid_number in (${ALL_BIDS.map((b) => `'${b}'`).join(',')})`);
    // ... and GeM's side: award three, evaluate one, leave one unlisted.
    for (const b of [BID_A, BID_B, BID_D]) expect((await gemAward(page.request, b)).ok, b).toBe(true);
    expect((await gemAward(page.request, BID_C, 'tech_evaluated')).ok).toBe(true);
    // 6421030: an award whose winner (L2, awarded) is not the lowest price - seeded, mock-gem always awards L1.
    const bidders = [
      { rank: 1, seller: L1_SELLER, price: 2840500, level: 'L1', awarded: false },
      { rank: 2, seller: 'Aarav Infotech Pvt Ltd', price: 2950000, level: 'L2', awarded: true },
      { rank: 3, seller: 'Northline Computers', price: 3125000, level: 'L3', awarded: false },
    ];
    sql(`insert into tender_results (tender_id, evaluation_status, bidders, categories, source_url, fetched_at, checked_at) values ('${ids[BID_F]}', 'awarded', '${JSON.stringify(bidders)}'::jsonb, '[]'::jsonb, 'https://bidplus.gem.gov.in/bidding/bid/getBidResultView/7421030', now(), now())`);
    sql(`update tenders set status='awarded' where id='${ids[BID_F]}'`);

    mkdirSync(join('qa', '.runs'), { recursive: true });
    S = { owner, analyst, viewer, org2, ids, orgId };
    writeFileSync(STATE_FILE, JSON.stringify(S));
    note('setup', JSON.stringify({ bids: ALL_BIDS.length, orgId }));
    await own.dispose(); await r2.dispose();
  });

  test('S1 scenario 1: refresh #1 checks closed tracked tenders; awarded ones become `awarded` + events; no result page for the unevaluated', async ({ page }) => {
    const s = S!;
    const before = await mockRequests(page.request);
    expect(sql("select count(*) from ingestion_runs where kind='results'")).toBe('0');
    expect(sql(`select status from tenders where id='${s.ids[BID_A]}'`)).toBe('open');
    const r = await refresh(page.request);
    note('refresh#1', JSON.stringify(r));
    // Candidates: A, B, C, D, E (F is final: awarded with a table). Stored: A, B, C, D. Newly awarded: A, B, D. E: not listed -> not stored.
    expect(r).toMatchObject({ status: 'success', checked: 5, stored: 4, awarded: 3, error: null });
    const after = await mockRequests(page.request);
    const resultViews = after.results - before.results;
    const searches = after.listing - before.listing;
    note('gem-requests', JSON.stringify({ resultViews, submittedSearches: searches, tendersChecked: r.checked }));
    expect(resultViews, 'one result view per awarded tender, none for tech_evaluated / unlisted').toBe(3);
    expect(searches, 'one submitted-bids search per checked tender (no paging)').toBe(r.checked);

    for (const b of [BID_A, BID_B, BID_D]) {
      expect(sql(`select status from tenders where id='${s.ids[b]}'`), `${b} status`).toBe('awarded');
      expect(sql(`select count(*) from tender_events where tender_id='${s.ids[b]}' and kind='awarded'`), `${b} awarded event`).toBe('1');
      expect(sql(`select evaluation_status || '/' || jsonb_array_length(bidders) from tender_results where tender_id='${s.ids[b]}'`)).toBe('awarded/4');
    }
    expect(sql(`select status from tenders where id='${s.ids[BID_C]}'`), 'tech-evaluated tender is not awarded').toBe('open');
    expect(sql(`select evaluation_status || '/' || jsonb_array_length(bidders) from tender_results where tender_id='${s.ids[BID_C]}'`)).toBe('technical_evaluated/0');
    expect(sql(`select count(*) from tender_events where tender_id='${s.ids[BID_C]}' and kind='technical_evaluated'`)).toBe('1');
    expect(sql(`select count(*) from tender_results where tender_id='${s.ids[BID_E]}' and evaluation_status<>'not_evaluated'`), 'unlisted bid is never stored as evaluated').toBe('0');
    const run = sql("select kind || '/' || status || '/' || tenders_seen || '/' || tenders_updated || '/' || tenders_created from ingestion_runs where kind='results' order by started_at desc limit 1");
    expect(run).toBe('results/success/5/4/3');

    // A second refresh inside the 24 h window: awarded results are final, C was just checked; only E (GeM never listed it, so its
    // check was not spent) is asked again.
    const cChecked = sql(`select checked_at from tender_results where tender_id='${s.ids[BID_C]}'`);
    const again = await refresh(page.request);
    note('refresh#2-same-day', JSON.stringify(again));
    expect(again.checked, 'only the never-listed bid is asked again').toBe(1);
    expect(again.awarded).toBe(0);
    expect(sql(`select checked_at from tender_results where tender_id='${s.ids[BID_C]}'`), 'C not re-checked within 24 h').toBe(cChecked);
    expect(sql("select count(*) from ingestion_runs where kind='results'")).toBe('2');
  });

  test('S2 scenario 2: GET /result 200 shape; Result tab shows Awarded badge, L1 row highlighted, ₹ Indian grouping, GeM source link', async ({ page }) => {
    const s = S!;
    const api = await apiAs(s.analyst);
    const res = await api.get(`/api/tenders/${s.ids[BID_A]}/result`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    note('result', JSON.stringify({ evaluationStatus: body.evaluationStatus, bidders: body.bidders.length, fetchedAt: body.fetchedAt, lastCheck: body.lastCheck }));
    expect(body.evaluationStatus).toBe('awarded');
    expect(body.fetchedAt).toBeTruthy();
    expect(body.bidders.map((b: { rank: number; level: string; price: number }) => [b.rank, b.level, b.price])).toEqual([[1, 'L1', 2840500], [2, 'L2', 2950000], [3, 'L3', 3125000], [4, 'L4', 3310000]]);
    expect(body.bidders[0]).toMatchObject({ seller: L1_SELLER, level: 'L1', awarded: true });
    expect(body.sourceUrl).toContain('getBidResultView');
    expect(await anonStatus(`/api/tenders/${s.ids[BID_A]}/result`), 'signed out').toBe(401);

    await login(page, s.analyst);
    await page.goto(`/tenders/${s.ids[BID_A]}`);
    await expect(resultTab(page)).toBeVisible();
    await resultTab(page).click();
    await expect(page).toHaveURL(/tab=result/);
    await expect(page.getByTestId('evaluation-status')).toHaveText('Awarded');
    const table = page.getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(5); // header + 4 bidders
    const l1 = table.locator('tr[data-l1]');
    await expect(l1).toHaveCount(1);
    await expect(l1).toContainText('L1');
    await expect(l1).toContainText(L1_SELLER);
    await expect(l1).toContainText('₹28,40,500');
    await expect(l1).toContainText('Awarded');
    const bg = (el: Element) => getComputedStyle(el).backgroundColor;
    const l1Bg = await l1.evaluate(bg);
    const l2Bg = await table.getByRole('row').filter({ hasText: 'Aarav Infotech' }).evaluate(bg);
    note('row-background', JSON.stringify({ l1: l1Bg, l2: l2Bg }));
    expect(l1Bg, 'L1 row is visibly tinted vs. L2').not.toBe(l2Bg);
    await expect(table).toContainText('₹29,50,000');
    await expect(table).toContainText('₹31,25,000');
    await expect(table).toContainText('₹33,10,000');
    const link = page.getByRole('link', { name: /View the result on GeM/ });
    await expect(link).toHaveAttribute('href', /getBidResultView/);
    await expect(link).toHaveAttribute('target', '_blank');
    await shot(page, 'S2-result-tab-awarded');
  });

  test('S3 scenario 3: tech-evaluated tender -> 200 + bidders [] + the "hasn’t published" copy; unlisted bid says GeM does not list it', async ({ page }) => {
    const s = S!;
    const api = await apiAs(s.analyst);
    const res = await api.get(`/api/tenders/${s.ids[BID_C]}/result`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    note('pending', JSON.stringify({ evaluationStatus: body.evaluationStatus, evaluationLabel: body.evaluationLabel, bidders: body.bidders.length, lastCheck: body.lastCheck }));
    expect(body).toMatchObject({ evaluationStatus: 'technical_evaluated', evaluationLabel: 'Technical evaluated', bidders: [], lastCheck: 'ok' });

    await login(page, s.analyst);
    await openResult(page, s.ids[BID_C]);
    await expect(page.getByTestId('evaluation-status')).toHaveText('Technical evaluated');
    await expect(page.getByTestId('result-pending')).toHaveText(NOT_PUBLISHED);
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByTestId('result-check-failed')).toHaveCount(0);
    await shot(page, 'S3-result-tab-not-published');

    // Never listed by GeM's search: not_evaluated, empty, with the not_listed notice.
    const e = await (await api.get(`/api/tenders/${s.ids[BID_E]}/result`)).json();
    note('not_listed', JSON.stringify({ evaluationStatus: e.evaluationStatus, lastCheck: e.lastCheck, fetchedAt: e.fetchedAt }));
    expect(e).toMatchObject({ bidders: [], lastCheck: 'not_listed', fetchedAt: null });
    await openResult(page, s.ids[BID_E]);
    await expect(page.getByTestId('result-pending')).toHaveText(NOT_PUBLISHED);
    await expect(page.getByTestId('result-check-failed')).toContainText('GeM doesn’t list this bid’s evaluation yet. We’ll check again tomorrow.');
    await shot(page, 'S3-result-tab-not-listed');

    // A tender that was never checked at all (no row): 200, not_evaluated, empty.
    const never = sql("select id from tenders where status='open' and end_at > now() and id not in (select tender_id from tender_results) limit 1");
    const n = await api.get(`/api/tenders/${never}/result`);
    expect(n.status()).toBe(200);
    expect(await n.json()).toMatchObject({ evaluationStatus: 'not_evaluated', bidders: [] });
  });

  test('S4 scenario 4: "Result published: <title> — L1 <seller> at ₹<price>" for every member, once per tender; re-publishing does not duplicate', async ({ page }) => {
    const s = S!;
    const rows = (user: string, tender: string) => Number(sql(`select count(*) from notifications where kind='result' and channel='in_app' and user_id='${user}' and link='/tenders/${tender}'`));
    for (const u of [s.owner, s.analyst, s.viewer]) {
      for (const b of [BID_A, BID_B, BID_D]) expect(rows(u.id, s.ids[b]), `${u.name} / ${b}`).toBe(1);
      for (const b of [BID_C, BID_E]) expect(rows(u.id, s.ids[b]), 'no alert before a result is published').toBe(0);
    }
    expect(sql(`select count(*) from notifications where kind='result' and user_id='${s.org2.id}'`), 'org that does not track the tender').toBe('0');
    const titleA = sql(`select title from tenders where id='${s.ids[BID_A]}'`);
    const n = await (await apiAs(s.analyst)).get('/api/notifications?kind=result&pageSize=50');
    expect(n.status()).toBe(200);
    const items = (await n.json()).items as { title: string; body: string; kind: string; link: string }[];
    const a = items.find((i) => i.link === `/tenders/${s.ids[BID_A]}`)!;
    note('alert', JSON.stringify({ title: a.title, body: a.body }));
    expect(a.title.startsWith('Result published: ')).toBe(true);
    expect(a.title).toContain(` — L1 ${L1_SELLER} at ₹28,40,500`);
    expect(a.title).toContain(titleA.slice(0, 30));
    expect(a.kind).toBe('result');

    await login(page, s.analyst); // (the Owner's /dashboard redirects to the onboarding wizard)
    await page.goto('/dashboard');
    await expect(bell(page)).toBeVisible();
    await bell(page).click();
    const pop = page.getByRole('dialog');
    const item = pop.getByRole('list', { name: 'Latest notifications' }).getByRole('listitem').filter({ hasText: 'Result published:' }).first();
    await expect(item).toBeVisible();
    await expect(item).toContainText(`L1 ${L1_SELLER} at ₹`);
    await shot(page, 'S4-bell-result-published');
    await page.keyboard.press('Escape');
    await page.goto('/notifications');
    await expect(page.getByText('Result published:').first()).toBeVisible();
    await shot(page, 'S4-notifications-result');

    // Dedupe: put B back to "financial evaluated, table not published", pass the recheck window, refresh -> B is awarded again
    // (no second `awarded` event, no second alert).
    const evBefore = sql(`select count(*) from tender_events where tender_id='${s.ids[BID_B]}' and kind='awarded'`);
    const totalBefore = sql("select count(*) from notifications where kind='result'");
    sql(`update tender_results set evaluation_status='financial_evaluated', bidders='[]'::jsonb where tender_id='${s.ids[BID_B]}'`);
    ageChecks();
    const r = await refresh(page.request);
    note('refresh#re-publish', JSON.stringify(r));
    expect(r.stored).toBeGreaterThanOrEqual(1);
    expect(sql(`select evaluation_status || '/' || jsonb_array_length(bidders) from tender_results where tender_id='${s.ids[BID_B]}'`), 'table re-read').toBe('awarded/4');
    expect(sql("select count(*) from notifications where kind='result'"), 'no duplicate alert').toBe(totalBefore);
    expect(sql(`select count(*) from tender_events where tender_id='${s.ids[BID_B]}' and kind='awarded'`)).toBe(evBefore);
    expect(rows(s.owner.id, s.ids[BID_B])).toBe(1);
  });

  test('S5 scenario 5: Insights → Competitors ranked by wins with ₹ value + categories; category / state filter; flagged award; any role; empty state', async ({ page }) => {
    const s = S!;
    const viewer = await apiAs(s.viewer);
    const res = await viewer.get('/api/insights/competitors');
    expect(res.status(), 'a Viewer may read').toBe(200);
    const body = await res.json();
    note('competitors', JSON.stringify({ total: body.total, tenders: body.tenders, flaggedAwards: body.flaggedAwards, top: body.items[0] }));
    expect(body).toMatchObject({ tenders: 4, flaggedAwards: 1, total: 4 });
    expect(body.items[0]).toMatchObject({ seller: L1_SELLER, wins: 3, awardedValue: 8521500, anomalies: 0 });
    expect(body.items[1]).toMatchObject({ seller: 'Aarav Infotech Pvt Ltd', wins: 1, awardedValue: 2950000, anomalies: 1 });
    const gj = await (await viewer.get('/api/insights/competitors?state=Gujarat')).json();
    expect(gj).toMatchObject({ tenders: 1, total: 4 });
    expect(gj.items[0]).toMatchObject({ seller: L1_SELLER, wins: 1 });
    const lap = await (await viewer.get(`/api/insights/competitors?category=${encodeURIComponent('Laptop - Notebook')}`)).json();
    expect(lap.tenders).toBe(1);
    expect((await viewer.get('/api/insights/competitors?page=0')).status(), 'bad query').toBe(400);
    expect(await anonStatus('/api/insights/competitors'), 'signed out').toBe(401);

    await login(page, s.viewer);
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Competitors', exact: true }).first().click();
    await expect(page).toHaveURL(/\/competitors/);
    await expect(page.getByRole('heading', { name: 'Competitors', exact: true }).first()).toBeVisible();
    const table = page.getByRole('table', { name: /Competitor sellers ranked by wins/ });
    await expect(table).toBeVisible();
    const row1 = table.getByRole('row').nth(1);
    await expect(row1).toContainText(L1_SELLER);
    await expect(row1).toContainText('₹85,21,500');
    await expect(row1).toContainText('Printer Cartridge');
    await expect(table.getByRole('row').nth(2)).toContainText('Aarav Infotech Pvt Ltd');
    await expect(table.getByRole('row').nth(2)).toContainText('₹29,50,000');
    await expect(table.getByRole('row').nth(2)).toContainText('flagged award');
    await expect(page.getByText('Flagged: not lowest price')).toBeVisible();
    await shot(page, 'S5-competitors-table');

    await page.getByRole('combobox', { name: 'State' }).click();
    await page.getByRole('option', { name: 'Gujarat', exact: true }).click();
    await expect(page).toHaveURL(/state=Gujarat/);
    await expect(table.getByRole('row')).toHaveCount(5); // header + 4 bidders of the one Gujarat award
    await expect(table.getByRole('row').nth(1)).toContainText('₹28,40,500');
    await shot(page, 'S5-competitors-filter-state');
    await page.getByRole('combobox', { name: 'State' }).click();
    await page.getByRole('option', { name: 'All states' }).click();
    await page.getByRole('combobox', { name: 'Category' }).click();
    await page.getByRole('option', { name: 'Laptop - Notebook', exact: true }).click();
    await expect(page).toHaveURL(/category=Laptop/);
    await expect(table.getByRole('row').nth(1)).toContainText(L1_SELLER);
    await expect(page.getByText('Awarded tenders analysed')).toBeVisible();
    await shot(page, 'S5-competitors-filter-category');
    await page.getByRole('combobox', { name: 'Category' }).click();
    await page.getByRole('option', { name: 'Server (Q2)', exact: true }).click();
    await expect(table.getByRole('row').nth(1)).toContainText('Aarav Infotech Pvt Ltd');
    await expect(table.getByRole('row').nth(1)).toContainText('flagged award');
    await shot(page, 'S5-competitors-flagged-award');

    // The Result tab states the same anomaly, with the rupee gap.
    await openResult(page, s.ids[BID_F]);
    await expect(page.getByTestId('result-anomaly')).toContainText('Winner is not the lowest price');
    await expect(page.getByTestId('result-anomaly')).toContainText('₹1,09,500');
    await shot(page, 'S5-result-tab-flagged');

    // Empty state: an org with no tracked awarded tenders
    await login(page, s.org2);
    await page.goto('/competitors');
    await expect(page.getByText('No awarded results for your tracked tenders yet')).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await shot(page, 'S5-competitors-empty');
    const empty = await (await apiAs(s.org2)).get('/api/insights/competitors');
    expect(await empty.json()).toMatchObject({ items: [], total: 0, tenders: 0 });
  });

  test('S6 scenario 6: unreadable result page -> error recorded on the run, existing result data untouched', async ({ page }) => {
    const s = S!;
    const tD = s.ids[BID_D];
    const snap = () => sql(`select md5(evaluation_status || bidders::text || categories::text || coalesce(source_url,'') || fetched_at::text) || '|' || evaluation_status || '|' || jsonb_array_length(bidders) from tender_results where tender_id='${tD}'`);
    expect(snap().endsWith('|awarded|4')).toBe(true);
    // The refresh skips final results (awarded + table). Arrange the case "GeM answers awarded, we already hold data": D keeps
    // its stored table but is back at financial_evaluated, so it is due again.
    sql(`update tender_results set evaluation_status='financial_evaluated' where tender_id='${tD}'`);
    sql(`update tenders set status='closed' where id='${tD}'`);
    const stored = snap();
    ageChecks();

    // Second API process, same DB, GeM = pass-through proxy that serves an unreadable result page.
    let proxy: Server | undefined; let api2: ChildProcess | undefined;
    const proxyPort = Number(PORT) + 50, api2Port = Number(PORT) + 51;
    try {
      proxy = createServer(async (req, res) => {
        try {
          if ((req.url ?? '').includes('/getBidResultView/')) {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<html><body><h1>Bid Result</h1><div class="new-layout">The result is now shown in an interactive widget.</div></body></html>');
            return;
          }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) if (v && !['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) headers[k] = String(v);
          const up = await fetch(`${GEM_URL}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'manual' });
          const out: Record<string, string | string[]> = {};
          up.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'].includes(k)) out[k] = v; });
          const cookies = up.headers.getSetCookie();
          if (cookies.length) out['set-cookie'] = cookies;
          res.writeHead(up.status, out);
          res.end(Buffer.from(await up.arrayBuffer()));
        } catch (e) { res.writeHead(502); res.end(String(e)); }
      });
      await new Promise<void>((ok) => proxy!.listen(proxyPort, '127.0.0.1', ok));
      api2 = spawn('pnpm', ['--filter', '@tp/api', 'start'], {
        detached: true, stdio: 'ignore',
        env: { ...process.env, PORT: String(api2Port), DATABASE_URL: DB, AUTO_MIGRATE: '0', BLOB_DIR: `.data/e2e-blobs-${api2Port}`, GEM_BASE_URL: `http://127.0.0.1:${proxyPort}`, GEM_MIN_INTERVAL_MS: '0', APP_URL: `http://localhost:${api2Port}`, E2E_TEST_HOOKS: '1' },
      });
      const base2 = `http://127.0.0.1:${api2Port}`;
      for (let i = 0; i < 60; i++) { if ((await fetch(`${base2}/api/health`).catch(() => null))?.ok) break; await sleep(1000); }

      const runsBefore = Number(sql("select count(*) from ingestion_runs where kind='results'"));
      const r = await refresh(page.request, base2);
      note('refresh#unreadable', JSON.stringify(r));
      expect(Number(sql("select count(*) from ingestion_runs where kind='results'"))).toBe(runsBefore + 1);
      expect(r.checked).toBeGreaterThanOrEqual(1);
      expect(r.status, 'the run is not a clean success').not.toBe('success');
      expect(r.error, 'error recorded on the run').toContain('GeM result page could not be read');
      expect(sql(`select error from ingestion_runs where id='${r.id}'`)).toContain('could not be read');
      const after = snap();
      note('stored-data', JSON.stringify({ before: stored, after }));
      expect(after, 'status, bidders, categories, source, fetched_at identical').toBe(stored);
      expect(sql(`select error from tender_results where tender_id='${tD}'`)).toContain('could not be read');
      expect(sql(`select count(*) from tender_events where tender_id='${tD}' and kind='awarded'`), 'no second awarded event').toBe('1');
      expect(sql(`select count(*) from notifications where kind='result' and link='/tenders/${tD}'`), 'no new alert (3 members from refresh #1)').toBe('3');
      // The API and UI keep the stored table and say the page could not be read.
      const api = await apiAs(s.analyst);
      const body = await (await api.get(`/api/tenders/${tD}/result`)).json();
      expect(body).toMatchObject({ lastCheck: 'unreadable' });
      expect(body.bidders).toHaveLength(4);
      await login(page, s.analyst);
      await openResult(page, tD);
      await expect(page.getByTestId('result-check-failed')).toContainText('GeM’s result page couldn’t be read.');
      await expect(page.getByTestId('result-check-failed')).toContainText('Showing the result from');
      await expect(page.getByRole('table').getByRole('row')).toHaveCount(5);
      await shot(page, 'S6-result-tab-unreadable-kept');
    } finally {
      proxy?.close();
      if (api2?.pid) { try { process.kill(-api2.pid, 'SIGTERM'); } catch { /* gone */ } }
      sql(`update tender_results set evaluation_status='awarded', error=null where tender_id='${tD}'`);
      sql(`update tenders set status='awarded' where id='${tD}'`);
    }
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`A11y ${scheme}: Result tab (awarded table) passes axe (WCAG 2.1 A/AA)`, async ({ page }) => {
      const s = S!;
      await login(page, s.analyst);
      await openResult(page, s.ids[BID_A]);
      await setScheme(page, scheme);
      await expect(page.getByRole('table')).toBeVisible();
      await shot(page, `A11y-${scheme}-result-tab`);
      await checkA11y(page);
    });
    test(`A11y ${scheme}: Result tab (not published) passes axe`, async ({ page }) => {
      const s = S!;
      await login(page, s.analyst);
      await openResult(page, s.ids[BID_E]);
      await setScheme(page, scheme);
      await expect(page.getByTestId('result-pending')).toBeVisible();
      await shot(page, `A11y-${scheme}-result-tab-pending`);
      await checkA11y(page);
    });
    test(`A11y ${scheme}: Competitors page passes axe`, async ({ page }) => {
      const s = S!;
      await login(page, s.viewer);
      await page.goto('/competitors');
      await setScheme(page, scheme);
      await expect(page.getByRole('table', { name: /Competitor sellers/ })).toBeVisible();
      await shot(page, `A11y-${scheme}-competitors`);
      await checkA11y(page);
    });
  }

  test('S2 @mobile: Result tab at 375 px — badge, L1 row highlighted, cards, ₹ grouping, no horizontal scroll', async ({ page }) => {
    const s = S!;
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, s.analyst);
    await openResult(page, s.ids[BID_A]);
    await expect(page.getByTestId('evaluation-status')).toHaveText('Awarded');
    const l1 = page.locator('li[data-l1]');
    await expect(l1).toHaveCount(1);
    await expect(l1).toContainText(L1_SELLER);
    await expect(l1).toContainText('₹28,40,500');
    await expect(page.getByRole('table')).toBeHidden();
    await noHorizontalOverflow(page);
    await shot(page, 'S2-mobile-result-tab-awarded');
    await openResult(page, s.ids[BID_C]);
    await expect(page.getByTestId('result-pending')).toHaveText(NOT_PUBLISHED);
    await noHorizontalOverflow(page);
    await shot(page, 'S3-mobile-result-tab-not-published');
  });

  test('S5 @mobile: Competitors at 375 px — cards, ₹ value, flagged, filters usable, no horizontal scroll', async ({ page }) => {
    const s = S!;
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, s.viewer);
    await page.goto('/competitors');
    const list = page.getByRole('list', { name: /Competitor sellers ranked by wins/ });
    await expect(list).toBeVisible();
    await expect(list.getByRole('listitem').first()).toContainText(L1_SELLER);
    await expect(list.getByRole('listitem').first()).toContainText('₹85,21,500');
    await expect(list.getByRole('listitem').nth(1)).toContainText('Aarav Infotech Pvt Ltd');
    await noHorizontalOverflow(page);
    await shot(page, 'S5-mobile-competitors');
    await page.getByRole('combobox', { name: 'State' }).click();
    await page.getByRole('option', { name: 'Gujarat', exact: true }).click();
    await expect(list.getByRole('listitem').first()).toContainText('₹28,40,500');
    await noHorizontalOverflow(page);
    await shot(page, 'S5-mobile-competitors-filtered');
  });
});
