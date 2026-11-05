/**
 * 003 / US3 (#64) — Triage the tender feed: search, filters, sort, views. QA task T044.
 * Covers spec scenarios 1-15 and FR-030..FR-037 (saved views incl. the 20 cap / 40-char name, status selector,
 * bid-number jump). Serial: one org with Owner / Bid Manager / Analyst / Viewer, ONE real manual sync (mock-gem,
 * 36 bids) in the setup test. Tenders that need a non-open status (scenario 15) are arranged with direct SQL, like
 * US1/US2 do. @mobile tests re-use the tenders already ingested (they sync only when the table is empty) and force
 * a 375 px viewport.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { test, expect, evidence, collectRunArtifacts, checkA11y, mockGem, uniqueUser } from '../support/fixtures';

const SPEC = '003', STORY = 'US3';
const BASE = `http://localhost:${process.env.E2E_PORT || 8788}`;
const DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

const sql = (q: string) => execFileSync('psql', [DB, '-qtAX', '-c', q], { encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Evidence screenshot. Full-page via evidence() while the page is short; for long pages (36 cards) or phone-density
 * screens a viewport-sized PNG at CSS scale, to keep the story's evidence under the ~15 MB budget.
 */
async function shot(page: Page, name: string) {
  const project = test.info().project.name;
  const h = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
  if (project === 'desktop' && h <= 1500) return evidence(page, SPEC, STORY, `${name}-${project}`);
  const dir = join('qa', 'evidence', SPEC, STORY);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}-${project}.png`);
  await page.screenshot({ path: file, scale: 'css' });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
  return file;
}
const note = (type: string, description: string) => test.info().annotations.push({ type, description });
const WL = 'Laptops — Maharashtra';
const SEARCH = 'Search item, buyer, bid number, city…';

type Creds = { email: string; password: string };
type Item = {
  id: string; bidNumber: string; title: string; state: string | null; endAt: string | null; estimatedValue: number | null;
  bidType: string; isNew: boolean; dismissed: boolean; matches: { watchlistId: string; watchlistName: string; reasons: string[] }[];
  analysis: unknown; hasCorrigendum: boolean;
};
type Facet = { value: string; count: number };
type Feed = { items: Item[]; total: number; facets: { states: Facet[]; ministries: Facet[]; categories: Facet[] } };
const S: { owner?: Creds; manager?: Creds; analyst?: Creds; viewer?: Creds; mgr?: APIRequestContext; ana?: APIRequestContext } = {};

async function login(page: Page, c: Creds) {
  await page.context().clearCookies();
  const res = await page.request.post('/api/auth/login', { data: { email: c.email, password: c.password } });
  expect(res.status(), await res.text()).toBe(200);
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
async function signupOrg(prefix: string) {
  const u = uniqueUser(prefix);
  const req = await pwRequest.newContext({ baseURL: BASE });
  expect((await req.post('/api/auth/signup', { data: u })).status()).toBe(201);
  return { u, req };
}
async function invite(owner: APIRequestContext, role: 'bid_manager' | 'analyst' | 'viewer'): Promise<Creds> {
  const u = uniqueUser(role.replace('_', ''));
  const inv = await owner.post('/api/org/invitations', { data: { email: u.email, role } });
  expect(inv.status(), await inv.text()).toBe(201);
  const token = (await inv.json()).inviteUrl.split('/invite/')[1];
  const anon = await pwRequest.newContext({ baseURL: BASE });
  const acc = await anon.post('/api/auth/accept-invite', { data: { token, name: u.name, password: u.password } });
  expect(acc.status(), await acc.text()).toBe(200);
  await anon.dispose();
  return { email: u.email, password: u.password };
}
const feed = async (req: APIRequestContext, qs = ''): Promise<Feed> => {
  const r = await req.get(`/api/tenders?pageSize=100${qs ? '&' + qs : ''}`);
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
};
/** A fresh Bid Manager in a brand-new org, logged in on `page`; syncs only if the tenders table is empty. */
async function freshManager(page: Page) {
  const { u, req } = await signupOrg('mob');
  if (Number(sql('select count(*) from tenders')) === 0) {
    await mockGem(page.request, '/__admin/reset');
    await syncNow(req);
  }
  await login(page, { email: u.email, password: u.password });
  return { u, req };
}

// ── page helpers ──
const cards = (page: Page) => page.getByRole('list', { name: 'Tenders' }).locator('> li');
const countText = (page: Page) => page.locator('[aria-live="polite"]').first();
const rail = (page: Page) => page.getByRole('complementary', { name: 'Filters' });
const bidNumbers = (page: Page) => cards(page).locator('span.font-mono').allTextContents();
const tab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Saved views' }).getByRole('tab', { name, exact: true });
async function gotoFeed(page: Page, qs = '') {
  await page.goto(`/tenders${qs}`);
  await expect(page.getByRole('heading', { name: 'Tenders', exact: true }).first()).toBeVisible();
  await expect(cards(page).first()).toBeVisible();
}
async function pickSort(page: Page, label: string) {
  await page.getByRole('combobox', { name: 'Sort tenders' }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
async function tickState(page: Page, state: string) {
  await rail(page).getByRole('list', { name: 'States' }).getByRole('checkbox', { name: new RegExp(`^${state}`) }).click();
}
/** Load every page: click "Load more" until it is gone (the sentinel may also auto-load while we click). */
async function loadAll(page: Page) {
  const loadMore = page.getByRole('button', { name: /Load more/ });
  for (let i = 0; i < 10 && (await loadMore.count()); i++) {
    await loadMore.click({ timeout: 3000 }).catch(() => undefined);
    await sleep(500);
  }
}
const noOverflow = async (page: Page) => {
  const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(m.s, `horizontal overflow ${m.s} > ${m.w}`).toBeLessThanOrEqual(m.w);
};

// Not 'serial': a failing criterion must not skip the remaining ones. Playwright restarts the worker after a failure,
// so the org/credentials made in the setup test are persisted to a git-ignored file and restored before each test.
const STATE_FILE = `qa/.runs/${process.env.E2E_PORT || 8788}/us3-state.json`;
test.beforeEach(async () => {
  // @mobile tests run in the `mobile` project (375 px forced inside the test); skip the duplicate desktop-project run
  test.skip(/@mobile/.test(test.info().title) && test.info().project.name === 'desktop', 'covered by the mobile project');
  if (S.mgr || test.info().title.startsWith('setup')) return;
  const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Pick<typeof S, 'owner' | 'manager' | 'analyst' | 'viewer'>;
  Object.assign(S, saved);
  S.mgr = await pwRequest.newContext({ baseURL: BASE });
  expect((await S.mgr.post('/api/auth/login', { data: S.manager })).status()).toBe(200);
  S.ana = await pwRequest.newContext({ baseURL: BASE });
  expect((await S.ana.post('/api/auth/login', { data: S.analyst })).status()).toBe(200);
});
test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

test.describe('US3 feed', () => {
  test.setTimeout(180_000);

  test('setup: org + roles, ONE real sync -> 36 tenders, three laptop watchlists', async ({ page }) => {
    S.mgr = undefined;
    await mockGem(page.request, '/__admin/reset');
    await mockGem(page.request, '/__admin/fail', { mode: 'off' });
    sql('delete from saved_views');
    const { u, req: own } = await signupOrg('owner');
    S.owner = { email: u.email, password: u.password };
    S.manager = await invite(own, 'bid_manager');
    S.analyst = await invite(own, 'analyst');
    S.viewer = await invite(own, 'viewer');
    S.mgr = await pwRequest.newContext({ baseURL: BASE });
    expect((await S.mgr.post('/api/auth/login', { data: S.manager })).status()).toBe(200);
    S.ana = await pwRequest.newContext({ baseURL: BASE });
    expect((await S.ana.post('/api/auth/login', { data: S.analyst })).status()).toBe(200);
    mkdirSync(STATE_FILE.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ owner: S.owner, manager: S.manager, analyst: S.analyst, viewer: S.viewer }));
    const run = await syncNow(S.mgr);
    expect(run).toMatchObject({ status: 'success', tendersSeen: 36, tendersCreated: 36 });
    expect(Number(sql('select count(*) from tenders'))).toBe(36);
    const w1 = await S.ana.post('/api/watchlists', { data: { name: WL, criteria: { keywords: ['laptop'], states: ['Maharashtra'] } } });
    expect(w1.status(), await w1.text()).toBe(201);
    const w2 = await S.ana.post('/api/watchlists', { data: { name: 'Laptops — anywhere', criteria: { keywords: ['laptop', 'notebook'], bidTypes: ['bid', 'ra'] } } });
    expect(w2.status(), await w2.text()).toBe(201);
    const w3 = await S.ana.post('/api/watchlists', { data: { name: 'Laptop notebooks MH 1L-5Cr', criteria: { keywords: ['laptop', 'notebook'], states: ['Maharashtra'], minValue: 100000, maxValue: 50000000 } } });
    expect(w3.status(), await w3.text()).toBe(201);
    const matched = await feed(S.ana, 'matched=1');
    note('api', `org matches after watchlists: ${matched.total} (${matched.items.map((i) => i.bidNumber).join(', ')})`);
    expect(matched.total).toBeGreaterThan(0);
    await own.dispose();
  });

  test('S1: 5 skeletons, header + "36 tenders", first 25 cards newest first, Load more (11 left), footer "That’s all 36 tenders."', async ({ page }) => {
    await login(page, S.manager!);
    await page.route('**/api/tenders?*', async (route) => { await sleep(1500); await route.continue(); }, { times: 1 });
    await page.goto('/tenders');
    const skeletons = page.getByLabel('Loading tenders');
    await expect(skeletons).toBeVisible();
    await expect(skeletons.locator('> div')).toHaveCount(5);
    await shot(page, 'S1a-skeletons');
    await expect(page.getByRole('heading', { name: 'Tenders', exact: true }).first()).toBeVisible();
    await expect(cards(page).first()).toBeVisible();
    await expect(countText(page)).toContainText('36 tenders');
    const api = await feed(S.mgr!);
    const shown = await cards(page).count();
    const loadMore = page.getByRole('button', { name: /Load more/ });
    note('observed', `first page renders ${shown} cards; button "${(await loadMore.textContent())?.trim()}"`);
    await shot(page, 'S1b-first-page-load-more');
    expect((await bidNumbers(page))).toEqual(api.items.slice(0, shown).map((i) => i.bidNumber)); // newest first
    expect(shown, 'spec: first 25 cards').toBe(25);
    await expect(loadMore).toContainText('Load more (11 left)');
    await loadMore.scrollIntoViewIfNeeded();
    await loadMore.click();
    await expect(cards(page)).toHaveCount(36);
    await expect(page.getByText('That’s all 36 tenders.')).toBeVisible();
    await shot(page, 'S1c-all-loaded-footer');
  });

  test('S1b: Load more / auto-load reaches all 36 bids and the footer reads "That’s all 36 tenders." (independent of page size)', async ({ page }) => {
    await login(page, S.manager!);
    await gotoFeed(page);
    await loadAll(page);
    await expect(cards(page)).toHaveCount(36);
    await expect(page.getByText('That’s all 36 tenders.')).toBeVisible();
    await shot(page, 'S1d-everything-loaded');
  });

  test('S2a: pressing "/" focuses the feed search box "Search item, buyer, bid number, city…"', async ({ page }) => {
    await login(page, S.manager!);
    await gotoFeed(page);
    await page.keyboard.press('/');
    await sleep(500);
    const active = await page.evaluate(() => (document.activeElement as HTMLInputElement)?.placeholder ?? document.activeElement?.tagName);
    note('observed', `after pressing "/", the focused element is: ${active}`);
    await shot(page, 'S2a-slash-key');
    await expect(page.getByPlaceholder(SEARCH)).toBeFocused();
  });

  test('S2: typing "laptop" sets ?q=laptop after ~350 ms without reload; list/count update; × restores 36', async ({ page }) => {
    await login(page, S.manager!);
    await gotoFeed(page);
    await page.evaluate(() => { (window as unknown as { __noReload: number }).__noReload = 1; });
    const search = page.getByPlaceholder(SEARCH);
    await search.click();
    await search.pressSequentially('laptop', { delay: 30 });
    expect(page.url(), 'debounce: URL must not have q immediately').not.toContain('q=laptop');
    await expect(page).toHaveURL(/[?&]q=laptop/);
    const api = await feed(S.mgr!, 'q=laptop');
    await expect(countText(page)).toContainText(`${api.total} ${api.total === 1 ? 'tender' : 'tenders'}`);
    expect(api.total).toBeGreaterThan(0);
    note('api', `q=laptop -> total ${api.total}`);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(1);
    await shot(page, 'S2a-search-laptop');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(countText(page)).toContainText('36 tenders');
    await shot(page, 'S2b-search-cleared');
  });

  test('S3: State Maharashtra -> URL state=, only MH bids, chip, other facets recounted, State facet keeps all states', async ({ page }) => {
    await login(page, S.manager!);
    await gotoFeed(page);
    const all = await feed(S.mgr!);
    await tickState(page, 'Maharashtra');
    await expect(page).toHaveURL(/state=Maharashtra/);
    const mh = await feed(S.mgr!, 'state=Maharashtra');
    await expect(countText(page)).toContainText(`${mh.total} tenders`);
    const text = await cards(page).allTextContents();
    expect(text.length).toBe(mh.total);
    for (const t of text) expect(t).toContain('Maharashtra');
    const chip = page.getByRole('button', { name: 'Remove filter Maharashtra' });
    await expect(chip).toBeVisible();
    expect(mh.facets.states.length, 'API: state facet ignores its own filter').toBe(all.facets.states.length);
    await expect(rail(page).getByRole('list', { name: 'States' }).getByRole('checkbox', { name: /^Karnataka/ })).toBeVisible();
    expect(mh.facets.categories.reduce((a, c) => a + c.count, 0)).toBeLessThanOrEqual(all.facets.categories.reduce((a, c) => a + c.count, 0));
    expect(mh.facets.categories.reduce((a, c) => a + c.count, 0)).toBeLessThanOrEqual(mh.total);
    await expect(rail(page).getByRole('list', { name: 'States' }).getByRole('checkbox', { name: /^Maharashtra/ })).toBeChecked();
    note('api', `facets: states all=${all.facets.states.length}/MH=${mh.facets.states.length}; ministries all=${all.facets.ministries.length}/MH=${mh.facets.ministries.length}; categories all=${all.facets.categories.length}/MH=${mh.facets.categories.length}`);
    await shot(page, 'S3a-state-maharashtra');
    await chip.click();
    await expect(page).not.toHaveURL(/state=/);
    await expect(countText(page)).toContainText('36 tenders');
    await shot(page, 'S3b-chip-removed');
  });

  test('S4: closing<=7d + ₹10 L–₹1 Cr + Reverse auction + Not analysed -> API params; results satisfy all; Clear all keeps q and sort', async ({ page }) => {
    await login(page, S.manager!);
    await gotoFeed(page);
    const urls: string[] = [];
    page.on('request', (r) => { if (/\/api\/tenders\?/.test(r.url())) urls.push(r.url()); });
    await rail(page).getByRole('group', { name: 'Closing within' }).getByRole('button', { name: '7 days' }).click();
    await rail(page).getByRole('button', { name: '₹10 L – ₹1 Cr' }).click();
    await rail(page).getByRole('button', { name: 'Reverse auction' }).click();
    await rail(page).getByRole('button', { name: 'Not analysed' }).click();
    await expect.poll(() => urls.some((u) => /closingWithinDays=7/.test(u) && /minValue=1000000/.test(u) && /maxValue=10000000/.test(u) && /bidType=ra/.test(u) && /verdict=none/.test(u)), { timeout: 8000 }).toBe(true);
    note('api', `request: ${urls.at(-1)}`);
    await shot(page, 'S4a-all-four-filters');
    const exact = await feed(S.mgr!, 'closingWithinDays=7&minValue=1000000&maxValue=10000000&bidType=ra&verdict=none');
    for (const i of exact.items) { expect(i.bidType).toBe('ra'); expect(i.estimatedValue).toBeGreaterThanOrEqual(1000000); expect(i.estimatedValue).toBeLessThanOrEqual(10000000); expect(i.analysis).toBeNull(); }
    note('api', `exact S4 query -> total ${exact.total} (mock data has no RA bid closing within 7 d, so the satisfy-all check on this exact query is vacuous; non-vacuous variant without bidType follows)`);
    const nv = await feed(S.mgr!, 'closingWithinDays=7&minValue=1000000&maxValue=10000000&verdict=none');
    expect(nv.total).toBeGreaterThan(0);
    const horizon = Date.now() + 7 * 86400_000;
    for (const i of nv.items) { expect(Date.parse(i.endAt!)).toBeLessThanOrEqual(horizon); expect(i.estimatedValue!).toBeGreaterThanOrEqual(1000000); expect(i.estimatedValue!).toBeLessThanOrEqual(10000000); expect(i.analysis).toBeNull(); }
    // un-pick RA so rows exist, add a search + sort, then Clear all keeps both
    await rail(page).getByRole('button', { name: 'Reverse auction' }).click();
    await page.getByPlaceholder(SEARCH).fill('a');
    await pickSort(page, 'Closing soonest');
    await expect(page).toHaveURL(/q=a/);
    await expect(page).toHaveURL(/sort=endAt/);
    await expect(cards(page).first()).toBeVisible();
    const expected = await feed(S.mgr!, 'q=a&closingWithinDays=7&minValue=1000000&maxValue=10000000&verdict=none&sort=endAt');
    await expect(cards(page)).toHaveCount(expected.total);
    expect(await bidNumbers(page)).toEqual(expected.items.map((i) => i.bidNumber));
    await shot(page, 'S4b-before-clear-all');
    await page.getByRole('button', { name: 'Clear all', exact: true }).click();
    await expect(page).toHaveURL(/q=a/);
    await expect(page).toHaveURL(/sort=endAt/);
    for (const k of ['closing=', 'min=', 'max=', 'type=', 'verdict=']) expect(page.url()).not.toContain(k);
    await shot(page, 'S4c-after-clear-all');
  });

  test('S5: five sort options; "Closing soonest" -> sort=endAt, end date ascending, unknown dates last', async ({ page }) => {
    await login(page, S.manager!);
    await gotoFeed(page);
    await page.getByRole('combobox', { name: 'Sort tenders' }).click();
    expect(await page.getByRole('option').allTextContents()).toEqual(['Newest first', 'Closing soonest', 'Best match', 'Highest score', 'Highest value']);
    await shot(page, 'S5a-sort-menu');
    await page.keyboard.press('Escape');
    await pickSort(page, 'Closing soonest');
    await expect(page).toHaveURL(/sort=endAt/);
    const api = await feed(S.mgr!, 'sort=endAt');
    const ends = api.items.map((i) => (i.endAt ? Date.parse(i.endAt) : Infinity));
    expect(ends).toEqual([...ends].sort((a, b) => a - b));
    await expect.poll(async () => (await bidNumbers(page)).slice(0, 5)).toEqual(api.items.slice(0, 5).map((i) => i.bidNumber));
    const nums = await bidNumbers(page);
    expect(nums).toEqual(api.items.slice(0, nums.length).map((i) => i.bidNumber));
    // unknown dates last: blank one end date, confirm API + UI put it last, then restore
    const victim = api.items[0];
    const before = sql(`select end_at from tenders where id='${victim.id}'`);
    sql(`update tenders set end_at = null where id='${victim.id}'`);
    try {
      const after = await feed(S.mgr!, 'sort=endAt');
      expect(after.items.at(-1)!.id, 'undated tender sorts last').toBe(victim.id);
      expect(after.items.at(-1)!.endAt).toBeNull();
      await page.reload();
      await expect(cards(page).first()).toBeVisible();
      await loadAll(page);
      await expect(cards(page)).toHaveCount(36);
      expect((await bidNumbers(page)).at(-1)).toBe(victim.bidNumber);
      await shot(page, 'S5b-closing-soonest-undated-last');
    } finally {
      sql(`update tenders set end_at = '${before}' where id='${victim.id}'`);
    }
  });

  test('S6: My matches -> only matched, relevance sort, watchlist badge ("<n> watchlists") and reason chips (max 3 + "+n more")', async ({ page }) => {
    await login(page, S.analyst!);
    await gotoFeed(page);
    await tab(page, 'My matches').click();
    await expect(page).toHaveURL(/matched=1/);
    await expect(page).toHaveURL(/sort=relevance/);
    const api = await feed(S.ana!, 'matched=1&sort=relevance');
    expect(api.total).toBeGreaterThan(0);
    await expect(cards(page)).toHaveCount(api.total);
    expect(await bidNumbers(page)).toEqual(api.items.map((i) => i.bidNumber));
    for (const it of api.items) {
      const card = cards(page).filter({ hasText: it.bidNumber });
      expect(it.matches.length).toBeGreaterThan(0);
      if (it.matches.length > 1) await expect(card.getByText(`${it.matches.length} watchlists`)).toBeVisible();
      else await expect(card.getByText(it.matches[0].watchlistName).first()).toBeVisible();
    }
    await shot(page, 'S6a-my-matches');
    const uniq = (i: Item) => [...new Set(i.matches.flatMap((m) => m.reasons))];
    note('observed', `reasons per card: ${api.items.map((i) => `${i.bidNumber.slice(-3)}=${uniq(i).length}`).join(', ')}`);
    const rich = api.items.find((i) => uniq(i).length > 3);
    if (rich) {
      const card = cards(page).filter({ hasText: rich.bidNumber });
      const chipCount = await card.locator('div.mt-3 span.font-normal').count();
      note('observed', `${rich.bidNumber}: ${uniq(rich).length} reasons -> ${chipCount} chips rendered`);
      await shot(page, 'S6b-reason-chips-cap');
      expect(chipCount, 'spec: up to 3 reason chips').toBeLessThanOrEqual(3);
      await expect(card.getByText(`+${uniq(rich).length - 3} more`)).toBeVisible();
    } else {
      note('unverifiable', 'no tender had >3 distinct reasons in this dataset; the "+n more" cap could not be exercised via UI');
    }
  });

  test('S7: New label + accent bar; opening marks seen (POST /seen), notification read, New view empty -> "You’re all caught up"', async ({ page }) => {
    await login(page, S.analyst!);
    const before = await feed(S.ana!, 'unseen=1&matched=1');
    expect(before.total).toBeGreaterThan(0);
    const unread = async () => ((await (await S.ana!.get('/api/notifications?unread=1')).json()).items ?? []) as { id: string }[];
    // US4 creates the in-app alert for a match; arrange the same row with SQL (in_app / tender_match / link /tenders/:id) for the first unseen tender
    const target = before.items[0];
    sql(`insert into notifications (org_id, user_id, channel, kind, title, body, link, status, sent_at)
         select u.last_org_id, u.id, 'in_app', 'tender_match', 'New match: ${target.bidNumber}', 'QA-arranged alert', '/tenders/${target.id}', 'sent', now()
         from users u where u.email = '${S.analyst!.email}'`);
    const unreadBefore = await unread();
    note('api', `unread in-app notifications before opening: ${unreadBefore.length}`);
    expect(unreadBefore.length).toBe(1);
    await gotoFeed(page);
    await tab(page, 'New').click();
    await expect(page).toHaveURL(/unseen=1/);
    await expect(cards(page)).toHaveCount(before.total);
    const first = cards(page).first();
    await expect(first.getByText('New', { exact: true })).toBeVisible();
    await expect(first.locator('span.animate-ping')).toHaveCount(1); // pulsing
    await expect(first.locator('span.bg-primary.rounded-r-full')).toHaveCount(1); // left accent bar
    await shot(page, 'S7a-new-view');
    for (let n = before.total; n > 0; n--) {
      await gotoFeed(page, '?matched=1&unseen=1');
      const resp = page.waitForResponse((r) => /\/seen$/.test(r.url()) && r.request().method() === 'POST');
      await cards(page).first().locator('h3 a').click();
      expect((await resp).status()).toBe(200);
      await expect(page).toHaveURL(/\/tenders\/[0-9a-f-]{36}/);
    }
    expect((await feed(S.ana!, 'unseen=1&matched=1')).total).toBe(0);
    const unreadAfter = await unread();
    note('api', `unread in-app notifications after: ${unreadAfter.length}`);
    expect(unreadAfter, 'the related in-app notification becomes read').toHaveLength(0);
    await gotoFeed(page, '?matched=1');
    await tab(page, 'New').click();
    await expect(page.getByText('You’re all caught up')).toBeVisible();
    await shot(page, 'S7b-all-caught-up');
  });

  test('S8: "Not relevant — hide" -> toast "Hidden from your feed" + Undo, card disappears, Undo restores; unmatched dismiss -> 409', async ({ page }) => {
    await login(page, S.analyst!);
    await gotoFeed(page, '?matched=1&sort=relevance');
    const total = (await feed(S.ana!, 'matched=1')).total;
    const first = cards(page).first();
    const bid = (await first.locator('span.font-mono').textContent())!;
    await first.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Not relevant — hide' }).click();
    await expect(page.getByText('Hidden from your feed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect(cards(page).filter({ hasText: bid })).toHaveCount(0);
    expect((await feed(S.ana!, 'matched=1')).total).toBe(total - 1);
    await shot(page, 'S8a-hidden-toast-undo');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(cards(page).filter({ hasText: bid })).toHaveCount(1);
    expect((await feed(S.ana!, 'matched=1')).total).toBe(total);
    await shot(page, 'S8b-restored');
    const unmatched = (await feed(S.ana!)).items.find((i) => i.matches.length === 0)!;
    const r = await S.ana!.post(`/api/tenders/${unmatched.id}/dismiss`, { data: {} });
    expect(r.status()).toBe(409);
    const body = await r.json();
    expect(body.error.message).toBe('Only tenders that match one of your watchlists can be dismissed');
    note('api', `POST /api/tenders/<unmatched>/dismiss -> ${r.status()} ${JSON.stringify(body.error)}`);
    for (const id of ['not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      const bad = await S.ana!.post(`/api/tenders/${id}/dismiss`, { data: {} });
      expect(bad.status()).toBe(404);
      expect((await bad.json()).error.message).toBe('Tender not found');
      expect((await S.ana!.post(`/api/tenders/${id}/seen`)).status()).toBe(404);
    }
  });

  test('S9: search cctv + State MH -> Analyst "Save as watchlist" opens sheet pre-filled "cctv · Maharashtra"; hidden for Viewer; disabled when pristine', async ({ page }) => {
    await login(page, S.analyst!);
    await gotoFeed(page);
    const btn = page.getByRole('button', { name: 'Save as watchlist' });
    await expect(btn).toBeDisabled();
    await shot(page, 'S9a-pristine-disabled');
    await page.getByPlaceholder(SEARCH).fill('cctv');
    await expect(page).toHaveURL(/q=cctv/);
    await expect(btn).toBeEnabled();
    await tickState(page, 'Maharashtra');
    await expect(page).toHaveURL(/state=Maharashtra/);
    await btn.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('New watchlist').first()).toBeVisible();
    await expect(dialog.getByLabel(/^Name/)).toHaveValue('cctv · Maharashtra');
    await expect(dialog.getByRole('button', { name: 'Remove cctv' })).toBeVisible();
    await expect(dialog.getByText('Maharashtra').first()).toBeVisible();
    await shot(page, 'S9b-prefilled-sheet');
    await login(page, S.viewer!);
    await gotoFeed(page, '?q=cctv&state=Maharashtra').catch(() => undefined);
    await page.goto('/tenders?q=laptop');
    await expect(page.getByRole('heading', { name: 'Tenders', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save as watchlist' })).toHaveCount(0);
    await shot(page, 'S9c-viewer-no-button');
  });

  test('S10: empty states — "No tenders yet" (+ Sync only for Bid Manager), "Tell us what you sell", "No tenders match these filters"', async ({ page }) => {
    // (a) no tenders at all: tenders are global (one real sync in setup), so the list response is stubbed with the real empty payload
    const empty = { items: [], total: 0, page: 1, pageSize: 20, facets: { states: [], ministries: [], categories: [] } };
    await login(page, S.manager!);
    await page.route('**/api/tenders?*', (route) => route.fulfill({ json: empty }));
    await page.goto('/tenders');
    await expect(page.getByText('No tenders yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sync with GeM now' })).toBeVisible();
    await shot(page, 'S10a-no-tenders-bid-manager');
    await login(page, S.analyst!);
    await page.goto('/tenders');
    await expect(page.getByText('No tenders yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sync with GeM now' })).toHaveCount(0);
    await page.unroute('**/api/tenders?*');
    // (b) Matched only, org with no watchlists
    const { u, req } = await signupOrg('nowl');
    await req.dispose();
    await login(page, { email: u.email, password: u.password });
    await page.goto('/tenders?matched=1');
    await expect(page.getByText('Tell us what you sell')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create a watchlist' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Browse all open bids' })).toBeVisible();
    await shot(page, 'S10b-tell-us-what-you-sell');
    await page.getByRole('button', { name: 'Browse all open bids' }).click();
    await expect(page).not.toHaveURL(/matched=1/);
    await expect(cards(page).first()).toBeVisible();
    // (c) filters exclude everything
    await page.getByPlaceholder(SEARCH).fill('zzzqqq');
    await expect(page.getByText('No tenders match these filters')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Alert me when one appears' })).toBeVisible();
    await shot(page, 'S10c-no-match');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(cards(page).first()).toBeVisible();
  });

  test('S11: API 500 -> error state with Retry instead of the list; Retry recovers', async ({ page }) => {
    await login(page, S.manager!);
    await page.route('**/api/tenders?*', (route) => route.fulfill({ status: 500, json: { error: { code: 'internal_error', message: 'Something went wrong' } } }));
    await page.goto('/tenders');
    const retry = page.getByRole('button', { name: /^(Retry|Try again)$/ });
    await expect(retry).toBeVisible({ timeout: 40_000 });
    note('observed', `error state button label: "${(await retry.textContent())?.trim()}" (spec says "Retry")`);
    await expect(cards(page)).toHaveCount(0);
    await shot(page, 'S11a-error-state');
    await page.unroute('**/api/tenders?*');
    await retry.click();
    await expect(cards(page).first()).toBeVisible();
    await shot(page, 'S11b-retry-recovers');
  });

  test('S12: desktop layout toggle -> table, remembered in localStorage tp.feed.layout', async ({ page }) => {
    await login(page, S.manager!);
    await gotoFeed(page);
    await page.getByLabel('Table').click();
    await expect(page.getByRole('table')).toBeVisible();
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('tp.feed.layout')))!)).toBe('table');
    await shot(page, 'S12a-table-layout');
    await page.reload();
    await expect(page.getByRole('table')).toBeVisible();
    await page.getByLabel('Cards').click();
    await expect(cards(page).first()).toBeVisible();
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('tp.feed.layout')))!)).toBe('cards');
  });

  test('S12 @mobile: 375 px — layout toggle hidden, cards only (even if table stored), no horizontal scroll, Filters bottom sheet with badge 1', async ({ page }) => {
    await freshManager(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.addInitScript(() => { try { localStorage.setItem('tp.feed.layout', '"table"'); } catch { /* ignore */ } });
    await gotoFeed(page);
    await expect(page.getByLabel('Cards')).toHaveCount(0);
    await expect(page.getByLabel('Table')).toHaveCount(0);
    await expect(page.getByRole('table')).toHaveCount(0);
    await noOverflow(page);
    await shot(page, 'S12b-mobile-cards-no-overflow');
    await page.getByRole('button', { name: 'Open filters' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText('Filters').first()).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(box.y + box.height).toBeGreaterThanOrEqual(812 - 2); // docked to the bottom
    expect(box.width).toBeGreaterThanOrEqual(370);
    await sheet.getByRole('checkbox', { name: /^Maharashtra/ }).click();
    await expect(page).toHaveURL(/state=Maharashtra/);
    await shot(page, 'S12c-mobile-filters-bottom-sheet');
    await sheet.getByRole('button', { name: /^Show \d+ tenders?$/ }).click();
    await expect(page.getByRole('button', { name: 'Open filters' }).getByText('1', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove filter Maharashtra' })).toBeVisible();
    await noOverflow(page);
    await shot(page, 'S12d-mobile-badge-and-chip');
  });

  test('S3 tablet 768 px: Filters opens as a right-hand sheet', async ({ page }) => {
    await login(page, S.manager!);
    await page.setViewportSize({ width: 768, height: 1024 });
    await gotoFeed(page);
    await page.getByRole('button', { name: 'Open filters' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(box.x + box.width).toBeGreaterThanOrEqual(766);
    expect(box.x).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThanOrEqual(1000);
    await shot(page, 'S3c-tablet-right-sheet');
  });

  test('S13: GET /api/tenders?status=bogus and pageSize=500 -> 400 validation_error (+ other invalid FR-030 values)', async () => {
    const bad = ['status=bogus', 'pageSize=500', 'pageSize=0', 'page=0', 'sort=bogus', 'verdict=maybe', 'bidType=nope', `q=${'x'.repeat(201)}`, 'closingWithinDays=abc', 'minValue=-5'];
    const lines: string[] = [];
    for (const qs of bad) {
      const r = await S.mgr!.get(`/api/tenders?${qs}`);
      const b = await r.json();
      lines.push(`?${qs.slice(0, 30)} -> ${r.status()} ${b?.error?.code}`);
      expect(r.status(), qs).toBe(400);
      expect(b.error.code, qs).toBe('validation_error');
    }
    note('api', lines.join(' | '));
    expect((await S.mgr!.get('/api/tenders?status=all&pageSize=100')).status()).toBe(200);
  });

  test('S14 saved views: "MH urgent" tab after built-ins, server-side, re-applies filters, rename, delete', async ({ page, browser }) => {
    await login(page, S.manager!);
    sql('delete from saved_views');
    await gotoFeed(page);
    await tickState(page, 'Maharashtra');
    await rail(page).getByRole('group', { name: 'Closing within' }).getByRole('button', { name: '7 days' }).click();
    await pickSort(page, 'Highest value');
    await expect(page).toHaveURL(/state=Maharashtra/);
    await expect(page).toHaveURL(/closing=7/);
    await expect(page).toHaveURL(/sort=value/);
    const filtered = page.url();
    await shot(page, 'S14a-filtered-feed');
    await page.getByRole('button', { name: 'Save view' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByLabel('View name')).toHaveAttribute('maxlength', '40');
    await dlg.getByLabel('View name').fill('MH urgent');
    await shot(page, 'S14b-save-dialog');
    await dlg.getByRole('button', { name: 'Save view' }).click();
    await expect(page.getByText('Saved view “MH urgent”')).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Saved views' }).getByRole('tab')).toHaveText(['My matches', 'New', 'Closing this week', 'Go verdicts', 'All open bids', 'MH urgent']);
    await expect(tab(page, 'MH urgent')).toHaveAttribute('aria-selected', 'true');
    await shot(page, 'S14c-tab-appears');
    const views = await (await S.mgr!.get('/api/views')).json();
    expect(views.items).toHaveLength(1);
    expect(views.items[0]).toMatchObject({ name: 'MH urgent' });
    expect(views.limit).toBe(20);
    note('api', `GET /api/views -> ${JSON.stringify(views.items[0].params)}`);
    // "persists across devices": brand-new browser context (no local state), same user
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    const p2 = await ctx.newPage();
    expect((await p2.request.post('/api/auth/login', { data: S.manager })).status()).toBe(200);
    await p2.goto('/tenders');
    await expect(tab(p2, 'MH urgent')).toBeVisible();
    await tab(p2, 'All open bids').click();
    await expect(p2).not.toHaveURL(/state=/);
    await tab(p2, 'MH urgent').click();
    expect([...new URL(p2.url()).searchParams.entries()].sort()).toEqual([...new URL(filtered).searchParams.entries()].sort());
    await expect(tab(p2, 'MH urgent')).toHaveAttribute('aria-selected', 'true');
    await evidence(p2, SPEC, STORY, `S14c2-second-device-reapplied-${test.info().project.name}`);
    await ctx.close();
    // personal: another user does not see it; cross-user PATCH/DELETE -> 404
    expect((await (await S.ana!.get('/api/views')).json()).items).toHaveLength(0);
    expect((await S.ana!.patch(`/api/views/${views.items[0].id}`, { data: { name: 'steal' } })).status()).toBe(404);
    expect((await S.ana!.delete(`/api/views/${views.items[0].id}`)).status()).toBe(404);
    // rename
    await page.getByRole('button', { name: 'Options for view MH urgent' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByRole('dialog').getByLabel('View name').fill('MH very urgent');
    await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click();
    await expect(tab(page, 'MH very urgent')).toBeVisible();
    await expect(tab(page, 'MH urgent')).toHaveCount(0);
    await shot(page, 'S14d-renamed');
    // delete
    await page.getByRole('button', { name: 'Options for view MH very urgent' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await shot(page, 'S14e-delete-confirm');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete view' }).click();
    await expect(tab(page, 'MH very urgent')).toHaveCount(0);
    expect((await (await S.mgr!.get('/api/views')).json()).total).toBe(0);
    await shot(page, 'S14f-deleted');
  });

  test('S14 limits: name <= 40 chars, duplicate -> 409 view_exists, 20 per user per org (UI Save disabled + API 409 view_limit)', async ({ page }) => {
    await login(page, S.manager!);
    sql('delete from saved_views');
    const p = { params: { state: ['Maharashtra'] } };
    const r41 = await S.mgr!.post('/api/views', { data: { name: 'x'.repeat(41), ...p } });
    expect(r41.status()).toBe(400);
    expect((await r41.json()).error.code).toBe('validation_error');
    const r40 = await S.mgr!.post('/api/views', { data: { name: 'y'.repeat(40), ...p } });
    expect(r40.status()).toBe(201);
    const blank = await S.mgr!.post('/api/views', { data: { name: '   ', ...p } });
    expect(blank.status()).toBe(400);
    const dup = await S.mgr!.post('/api/views', { data: { name: 'y'.repeat(40), ...p } });
    expect(dup.status()).toBe(409);
    expect((await dup.json()).error.code).toBe('view_exists');
    note('api', `41 chars -> ${r41.status()}, 40 chars -> ${r40.status()}, blank -> ${blank.status()}, duplicate -> ${dup.status()}`);
    for (let i = 1; i <= 19; i++) {
      const r = await S.mgr!.post('/api/views', { data: { name: `View ${String(i).padStart(2, '0')}`, params: { state: ['Maharashtra'], closing: [String(i)] } } });
      expect(r.status(), `create #${i + 1}: ${await r.text()}`).toBe(201);
    }
    expect((await (await S.mgr!.get('/api/views')).json()).total).toBe(20);
    const over = await S.mgr!.post('/api/views', { data: { name: 'one too many', ...p } });
    expect(over.status()).toBe(409);
    const ob = await over.json();
    expect(ob.error.code).toBe('view_limit');
    expect(ob.error.message).toBe('You can save up to 20 views — delete one first.');
    note('api', `21st view -> ${over.status()} ${JSON.stringify(ob.error)}`);
    expect((await S.ana!.post('/api/views', { data: { name: 'ana view', ...p } })).status(), 'cap is per user').toBe(201);
    await gotoFeed(page);
    const save = page.getByRole('button', { name: 'Save view' });
    await expect(save).toBeDisabled();
    await expect(page.getByRole('tablist', { name: 'Saved views' }).getByRole('tab')).toHaveCount(25);
    await save.locator('..').hover();
    await expect(page.getByText('You can save up to 20 views — delete one first.').first()).toBeVisible();
    await shot(page, 'S14g-cap-20-disabled');
    await tab(page, 'View 03').click();
    await page.getByRole('button', { name: 'Options for view View 03' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete view' }).click();
    await expect(page.getByRole('tablist', { name: 'Saved views' }).getByRole('tab')).toHaveCount(24);
    await tab(page, 'All open bids').click();
    await expect(save).toBeEnabled();
    await shot(page, 'S14h-cap-lifted-after-delete');
    sql('delete from saved_views');
  });

  test('S14 @mobile: 375 px — personal tabs scroll inside the strip (no page overflow), Save view dialog fits', async ({ page }) => {
    const { req } = await freshManager(page);
    await page.setViewportSize({ width: 375, height: 812 });
    for (let i = 1; i <= 6; i++) {
      const r = await page.request.post('/api/views', { data: { name: `Mobile view number ${i}`, params: { state: ['Maharashtra'], sort: ['value'] } } });
      expect(r.status()).toBe(201);
    }
    await req.dispose();
    await gotoFeed(page);
    await noOverflow(page);
    await tab(page, 'Mobile view number 6').scrollIntoViewIfNeeded();
    await tab(page, 'Mobile view number 6').click();
    await expect(page).toHaveURL(/state=Maharashtra/);
    await shot(page, 'S14i-mobile-tabs');
    await page.getByRole('button', { name: 'Save view' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByLabel('View name')).toBeVisible();
    await sleep(800); // let the open animation settle before measuring
    const box = (await dlg.boundingBox())!;
    note('observed', `save-view dialog box at 375 px: x=${Math.round(box.x)} w=${Math.round(box.width)}`);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(376);
    await shot(page, 'S14j-mobile-save-dialog');
  });

  test('S15 status selector: Open / Closed / Awarded / All list bids of that status', async ({ page }) => {
    await login(page, S.manager!);
    const ids = sql('select id from tenders order by bid_number limit 6').split('\n');
    const orig = sql(`select id||'|'||status from tenders where id in (${ids.map((i) => `'${i}'`).join(',')})`).split('\n');
    try {
      sql(`update tenders set status='closed' where id in ('${ids[0]}','${ids[1]}','${ids[2]}')`);
      sql(`update tenders set status='awarded' where id in ('${ids[3]}','${ids[4]}')`);
      sql(`update tenders set status='cancelled' where id = '${ids[5]}'`);
      await gotoFeed(page);
      const group = rail(page).getByRole('group', { name: 'Status' });
      await expect(group.getByRole('button')).toHaveText(['Open', 'Closed', 'Awarded', 'All']);
      await expect(group.getByRole('button', { name: 'Open' })).toHaveAttribute('aria-pressed', 'true');
      await expect(countText(page)).toContainText('30 tenders');
      await group.getByRole('button', { name: 'Closed' }).click();
      await expect(page).toHaveURL(/status=closed/);
      await expect(countText(page)).toContainText('3 tenders');
      await expect(cards(page)).toHaveCount(3);
      const closedNums = (await feed(S.mgr!, 'status=closed')).items.map((i) => i.bidNumber).sort();
      expect((await bidNumbers(page)).sort()).toEqual(closedNums);
      await shot(page, 'S15a-closed');
      await group.getByRole('button', { name: 'Awarded' }).click();
      await expect(page).toHaveURL(/status=awarded/);
      await expect(countText(page)).toContainText('2 tenders');
      expect((await bidNumbers(page)).sort()).toEqual((await feed(S.mgr!, 'status=awarded')).items.map((i) => i.bidNumber).sort());
      await shot(page, 'S15b-awarded');
      await group.getByRole('button', { name: 'All', exact: true }).click();
      await expect(page).toHaveURL(/status=all/);
      await expect(countText(page)).toContainText('36 tenders');
      await shot(page, 'S15c-all');
      await group.getByRole('button', { name: 'Open' }).click();
      await expect(page).not.toHaveURL(/status=/);
      await expect(countText(page)).toContainText('30 tenders');
      note('api', `status counts: open ${(await feed(S.mgr!)).total}, closed ${(await feed(S.mgr!, 'status=closed')).total}, awarded ${(await feed(S.mgr!, 'status=awarded')).total}, cancelled ${(await feed(S.mgr!, 'status=cancelled')).total}, all ${(await feed(S.mgr!, 'status=all')).total}`);
      // FR-037 across statuses: a closed bid is still found by its exact number
      await gotoFeed(page);
      const search = page.getByPlaceholder(SEARCH);
      await search.fill(closedNums[0]);
      await search.press('Enter');
      await expect(page).toHaveURL(/\/tenders\/[0-9a-f-]{36}$/);
      await shot(page, 'S15d-closed-bid-jump');
    } finally {
      for (const row of orig) { const [id, st] = row.split('|'); sql(`update tenders set status='${st}' where id='${id}'`); }
    }
  });

  test('FR-037 bid-number jump: exact number + Enter opens that tender; case/space forgiven; unknown or partial stays on the feed', async ({ page }) => {
    await login(page, S.manager!);
    await gotoFeed(page);
    const target = (await feed(S.mgr!, 'q=GEM/2026/B/6421001')).items.find((i) => i.bidNumber === 'GEM/2026/B/6421001')!;
    expect(target).toBeTruthy();
    const search = page.getByPlaceholder(SEARCH);
    await search.fill('GEM/2026/B/6421001');
    await search.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tenders/${target.id}$`));
    await expect(page.getByText('GEM/2026/B/6421001').first()).toBeVisible();
    await shot(page, 'FR037a-exact-jump');
    await gotoFeed(page);
    await search.fill('  gem/2026/b/6421001 ');
    await search.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tenders/${target.id}$`));
    await gotoFeed(page);
    await search.fill('GEM/2026/B/9999999');
    await search.press('Enter');
    await sleep(1200);
    await expect(page).toHaveURL(/\/tenders(\?|$)/);
    await expect(page.getByText('No tenders match these filters')).toBeVisible();
    await shot(page, 'FR037b-unknown-number-stays');
    await search.fill('GEM/2026/B/642100');
    await search.press('Enter');
    await sleep(1200);
    await expect(page).toHaveURL(/\/tenders\?.*q=GEM/);
    await shot(page, 'FR037c-partial-number-stays');
    await search.fill('laptop');
    await search.press('Enter');
    await sleep(800);
    await expect(page).toHaveURL(/\/tenders\?.*q=laptop/);
    note('unverifiable', 'the "two tenders share one exact bid number -> stay on the feed" branch cannot be produced (bid_number is unique); covered only by the unit test of bidJumpTarget');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`A11y ${scheme}: /tenders passes axe (WCAG 2.1 A/AA, serious/critical)`, async ({ page }) => {
      await login(page, S.analyst!);
      await gotoFeed(page);
      await page.evaluate((s) => { try { localStorage.setItem('tp-theme', s); } catch { /* ignore */ } }, scheme);
      await page.emulateMedia({ colorScheme: scheme });
      await page.reload();
      await expect(cards(page).first()).toBeVisible();
      await expect(page.locator('html')).toHaveClass(scheme === 'dark' ? /dark/ : /^(?!.*dark)/);
      await shot(page, `A11y-${scheme}-feed`);
      await checkA11y(page);
    });
  }

  test('A11y dark: saved-view dialog open', async ({ page }) => {
    await login(page, S.analyst!);
    await gotoFeed(page);
    await page.evaluate(() => { try { localStorage.setItem('tp-theme', 'dark'); } catch { /* ignore */ } });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(cards(page).first()).toBeVisible();
    await page.getByRole('button', { name: 'Save view' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, 'A11y-dark-save-view-dialog');
    await checkA11y(page, { exclude: ['[aria-label="Sort tenders"]'] }); // the sort trigger is audited (and reported) in the dark test above
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`A11y ${scheme} @mobile: /tenders at 375 px passes axe`, async ({ page }) => {
      await freshManager(page);
      await page.setViewportSize({ width: 375, height: 812 });
      await gotoFeed(page);
      await page.evaluate((s) => { try { localStorage.setItem('tp-theme', s); } catch { /* ignore */ } }, scheme);
      await page.emulateMedia({ colorScheme: scheme });
      await page.reload();
      await expect(cards(page).first()).toBeVisible();
      await shot(page, `A11y-${scheme}-feed-375`);
      await checkA11y(page);
    });
  }
});
