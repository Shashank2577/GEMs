/**
 * 003 / US1 (#62) — Polite, reliable GeM BidPlus ingestion with visible sync health. QA task T022.
 * Covers spec scenarios 1-9 (+ FR-013 cooldown, scenario 11). Serial: the scenarios build on one another's state
 * (empty DB -> first sync -> second sync -> outages -> recovery -> stale -> busy/timeout -> RBAC).
 * The manual-sync cooldown (FR-013, default 10 min since 008/FR-026, platform-wide, real clock) is asserted on the first sync; later syncs wait via `details.retryAt` and fail fast beyond 60 s.
 * Direct SQL (psql) is used only to read counts and to arrange "running"/"old" rows that cannot be produced via the API.
 */
import { execFileSync } from 'node:child_process';
import { request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { test, expect, evidence, collectRunArtifacts, mockGem, uniqueUser } from '../support/fixtures';

const SPEC = '003', STORY = 'US1';
const BASE = `http://localhost:${process.env.E2E_PORT || 8788}`;
const DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

const sql = (q: string) => execFileSync('psql', [DB, '-qtAX', '-c', q], { encoding: 'utf8' }).trim();
const count = (table: string, where = 'true') => Number(sql(`select count(*) from ${table} where ${where}`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);

type Creds = { email: string; password: string };
const state: { manager?: Creds; analyst?: Creds; viewer?: Creds; ownerReq?: APIRequestContext } = {};

async function loginPage(page: Page, c: Creds) {
  await page.context().clearCookies();
  const res = await page.request.post('/api/auth/login', { data: { email: c.email, password: c.password } });
  expect(res.status(), await res.text()).toBe(200);
}

/** POST /api/ingestion/run; if the FR-013 cooldown is active, wait it out (retryAt) and retry once. */
async function runSync(req: APIRequestContext, data: unknown = { pages: 5 }) {
  for (let i = 0; i < 3; i++) {
    const res = await req.post('/api/ingestion/run', { data });
    if (res.status() !== 429) return res;
    const retryAt = Date.parse((await res.json()).error.details.retryAt);
    const waitMs = Math.max(0, retryAt - Date.now()) + 1500;
    if (waitMs > 60_000) throw new Error(`manual sync cooldown is ${Math.round(waitMs / 1000)}s: age ingestion_runs in SQL first`);
    await sleep(waitMs);
  }
  throw new Error('cooldown never cleared');
}

async function openPill(page: Page) {
  await page.goto('/tenders');
  const pill = page.getByRole('button', { name: /GeM sync status/ });
  await expect(pill).toBeVisible();
  return pill;
}
const dotClass = (pill: ReturnType<Page['getByRole']>) => pill.locator('span.rounded-full').last().getAttribute('class');

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

test.describe('US1 ingestion', () => {
  test.setTimeout(300_000);

  test('setup: reset mock-gem, create org + Bid Manager / Analyst / Viewer', async ({ page }) => {
    await mockGem(page.request, '/__admin/reset');
    await mockGem(page.request, '/__admin/fail', { mode: 'off' });
    const owner = uniqueUser('owner');
    const own = await pwRequest.newContext({ baseURL: BASE });
    expect((await own.post('/api/auth/signup', { data: owner })).status()).toBe(201);
    state.ownerReq = own;
    for (const role of ['bid_manager', 'analyst', 'viewer'] as const) {
      const u = uniqueUser(role.replace('_', ''));
      const inv = await own.post('/api/org/invitations', { data: { email: u.email, role } });
      expect(inv.status(), await inv.text()).toBe(201);
      const token = (await inv.json()).inviteUrl.split('/invite/')[1];
      const anon = await pwRequest.newContext({ baseURL: BASE });
      const acc = await anon.post('/api/auth/accept-invite', { data: { token, name: u.name, password: u.password } });
      expect(acc.status(), await acc.text()).toBe(200);
      expect((await acc.json()).role ?? role).toBe(role);
      await anon.dispose();
      state[role === 'bid_manager' ? 'manager' : role] = { email: u.email, password: u.password };
    }
    expect(count('tenders')).toBe(0);
    expect(count('ingestion_runs')).toBe(0);
  });

  test('S8c: no run ever -> "Not synced yet", heading "Waiting for the first sync"', async ({ page }) => {
    await loginPage(page, state.manager!);
    const pill = await openPill(page);
    await expect(pill).toContainText('Not synced yet');
    await pill.click();
    await expect(page.getByText('Waiting for the first sync')).toBeVisible();
    await expect(page.getByText('No syncs yet.')).toBeVisible();
    await shot(page, 'S8c-never-synced');
  });

  test('S1 + FR-013: first sync (pages:5) creates 36 tenders; immediate re-sync is 429 sync_cooldown', async ({ page }) => {
    await loginPage(page, state.manager!);
    const res = await page.request.post('/api/ingestion/run', { data: { pages: 5 } });
    expect(res.status(), await res.text()).toBe(200);
    const run = await res.json();
    expect(run).toMatchObject({ status: 'success', pagesFetched: 4, tendersSeen: 36, tendersCreated: 36, tendersUpdated: 0, error: null });
    expect(count('tender_events', "kind='created'")).toBe(36);
    expect(count('tenders')).toBe(36);

    // FR-013 / scenario 11: cooldown right after a finished manual run.
    const again = await page.request.post('/api/ingestion/run', { data: { pages: 5 } });
    expect(again.status()).toBe(429);
    const body = await again.json();
    expect(body.error.code).toBe('sync_cooldown');
    expect(body.error.message).toMatch(/Next manual sync at .*IST/);
    expect(Date.parse(body.error.details.retryAt)).toBeGreaterThan(Date.now());
    expect(count('ingestion_runs')).toBe(1); // the refused call created no run

    const pill = await openPill(page);
    await pill.click();
    const btn = page.getByRole('button', { name: 'Sync now' });
    await expect(btn).toBeDisabled();
    await expect(page.locator('span[title^="Next manual sync at"]')).toHaveCount(1);
    await expect(page.getByRole('status')).toContainText(/Next manual sync at/);
    await shot(page, 'S1-S11-cooldown-popover');
    await page.keyboard.press('Escape');
    await page.goto('/tenders');
    await expect(page.getByText(/36\s+tenders/)).toBeVisible();
    await shot(page, 'S1-feed-36-tenders');
  });

  test('S2: GEM/2026/B/6421001 is normalised', async ({ page }) => {
    await loginPage(page, state.manager!);
    const res = await page.request.get('/api/tenders?q=6421001');
    expect(res.status()).toBe(200);
    const items = (await res.json()).items;
    const t = items.find((x: { bidNumber: string }) => x.bidNumber === 'GEM/2026/B/6421001');
    expect(t, JSON.stringify(items.map((x: { bidNumber: string }) => x.bidNumber))).toBeTruthy();
    expect(t).toMatchObject({ state: 'Maharashtra', emdAmount: 240000, estimatedValue: 9600000, bidType: 'bid', status: 'open' });
    expect(t.sourceUrl).toMatch(/\/showbidDocument\/7421001$/);
    await page.goto('/tenders?q=6421001');
    await expect(page.getByText('GEM/2026/B/6421001').first()).toBeVisible();
    await shot(page, 'S2-tender-6421001');
  });

  test('S3: second sync with nothing changed creates nothing (after cooldown)', async ({ page }) => {
    await loginPage(page, state.manager!);
    const before = { tenders: count('tenders'), events: count('tender_events'), notifs: count('notifications'), fetched: sql('select min(fetched_at) from tenders') };
    const res = await runSync(page.request);
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'success', tendersSeen: 36, tendersCreated: 0, tendersUpdated: 0, matchesCreated: 0 });
    expect(count('tenders')).toBe(before.tenders);
    expect(count('tender_events')).toBe(before.events);
    expect(count('notifications')).toBe(before.notifs);
    expect(sql('select min(fetched_at) from tenders') > before.fetched).toBe(true);
    const pill = await openPill(page);
    await pill.click();
    await expect(page.getByLabel('Recent syncs').getByText('0 new · 0 updated · 0 matches').first()).toBeVisible();
    await shot(page, 'S3-second-sync-no-change');
  });

  test('S4: mock-gem down -> run failed, data kept, red dot + "Last sync failed" (UI Sync now)', async ({ page }) => {
    await mockGem(page.request, '/__admin/fail', { mode: 'down' });
    await loginPage(page, state.manager!);
    const pill = await openPill(page);
    await pill.click();
    const btn = page.getByRole('button', { name: 'Sync now' });
    await expect(btn).toBeEnabled({ timeout: 150_000 }); // cooldown elapsed (UI re-evaluates every 5 s)
    await btn.click();
    await expect(page.getByText('Last sync failed')).toBeVisible({ timeout: 30_000 });
    const info = await (await page.request.get('/api/ingestion/runs')).json();
    expect(info.lastRun.status).toBe('failed');
    expect(info.lastRun.error).toMatch(/HTTP 503|unreachable/);
    expect(info.lastSuccessAt).not.toBeNull();
    expect(count('tenders')).toBe(36);
    await expect(page.getByText(new RegExp(info.lastRun.error.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).first()).toBeVisible();
    expect(await dotClass(pill)).toContain('bg-danger');
    await shot(page, 'S4-down-red-dot-last-sync-failed');
  });

  test('S5: mock-gem returns HTML -> run failed with "HTML" error', async ({ page }) => {
    await mockGem(page.request, '/__admin/fail', { mode: 'html' });
    await loginPage(page, state.manager!);
    const res = await runSync(page.request);
    expect(res.status()).toBe(200);
    const run = await res.json();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('HTML');
    expect(count('tenders')).toBe(36);
    const pill = await openPill(page);
    await pill.click();
    await expect(page.getByText('Last sync failed')).toBeVisible();
    await expect(page.getByText(/GeM returned HTML instead of JSON/).first()).toBeVisible();
    await shot(page, 'S5-html-failed');
  });

  test('S8a + S9: recovered sync -> green pulsing dot, "Synced ...", "· 36 open bids", runs list (UI Sync now)', async ({ page }) => {
    await mockGem(page.request, '/__admin/fail', { mode: 'off' });
    await loginPage(page, state.manager!);
    const pill = await openPill(page);
    await pill.click();
    const btn = page.getByRole('button', { name: 'Sync now' });
    await expect(btn).toBeEnabled({ timeout: 150_000 });
    await btn.click();
    await expect(page.getByText('GeM sync is healthy')).toBeVisible({ timeout: 30_000 });
    await expect(pill).toContainText(/Synced/);
    await expect(pill).toContainText('· 36 open bids');
    expect(await dotClass(pill)).toContain('bg-success');
    await expect(pill.locator('span.animate-ping')).toHaveCount(1);
    const list = page.getByLabel('Recent syncs');
    const rows = list.locator('li');
    expect(await rows.count()).toBeLessThanOrEqual(6);
    await expect(list).toContainText('Manual');
    for (const s of ['success', 'failed']) await expect(list.getByText(s, { exact: true }).first()).toBeVisible();
    await expect(list).toContainText(/\d+ new · \d+ updated · \d+ matches/);
    await expect(list).toContainText(/HTTP 503|unreachable/);
    await expect(page.getByText('Public listings only · ≤ 1 request/sec')).toBeVisible();
    await shot(page, 'S8a-S9-healthy-popover-runs');
  });

  test('S8b: last success older than 2 h -> amber dot + "Sync is overdue"', async ({ page }) => {
    // Age every run by 3 h (also clears the FR-013 cooldown) so the real endpoint reports a stale last success.
    sql("update ingestion_runs set started_at = started_at - interval '3 hours', finished_at = finished_at - interval '3 hours'");
    await loginPage(page, state.manager!);
    const pill = await openPill(page);
    await expect(pill).toContainText(/Synced 3 h|Synced 3 hours/i);
    expect(await dotClass(pill)).toContain('bg-warning');
    await pill.click();
    await expect(page.getByText('Sync is overdue')).toBeVisible();
    await shot(page, 'S8b-overdue-amber');
  });

  test('S6a: a run started <15 min ago blocks Sync now with 409 ingestion_running', async ({ page }) => {
    sql("insert into ingestion_runs (trigger, status, started_at) values ('cron','running', now() - interval '2 minutes')");
    await loginPage(page, state.manager!);
    const before = count('ingestion_runs');
    const res = await page.request.post('/api/ingestion/run', { data: { pages: 5 } });
    expect(res.status(), await res.text()).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ingestion_running');
    expect(body.error.message).toBe('A GeM sync is already running — results will appear shortly.');
    expect(count('ingestion_runs')).toBe(before);
    // UI: clicking Sync now surfaces the same message.
    const pill = await openPill(page);
    await pill.click();
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(page.getByText(/already running/).first()).toBeVisible();
    await shot(page, 'S6a-409-busy');
  });

  test('S6b: a run older than 15 min is reaped ("Timed out (worker stopped)") and the new run proceeds', async ({ page }) => {
    sql("update ingestion_runs set started_at = now() - interval '20 minutes' where status='running'");
    await loginPage(page, state.manager!);
    const res = await page.request.post('/api/ingestion/run', { data: { pages: 5 } });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).status).toBe('success');
    expect(count('ingestion_runs', "status='running'")).toBe(0);
    expect(count('ingestion_runs', "status='failed' and error = 'Timed out (worker stopped)'")).toBe(1);
    const pill = await openPill(page);
    await pill.click();
    await expect(page.getByText('Timed out (worker stopped)').first()).toBeVisible();
    await shot(page, 'S6b-timed-out-reaped');
  });

  test('S9: popover lists at most 6 runs (more exist) with badge, trigger and footer', async ({ page }) => {
    await loginPage(page, state.manager!);
    expect(count('ingestion_runs')).toBeGreaterThan(6);
    const pill = await openPill(page);
    await pill.click();
    await expect(page.getByLabel('Recent syncs').locator('li')).toHaveCount(6);
    await expect(page.getByText('Public listings only · ≤ 1 request/sec')).toBeVisible();
    await shot(page, 'S9-six-runs');
  });

  test('S7: Analyst and Viewer get 403 on Sync now and see no button; GET runs is 200 for all roles', async ({ page }) => {
    const roles: [string, Creds][] = [['analyst', state.analyst!], ['viewer', state.viewer!], ['bid_manager', state.manager!]];
    for (const [role, creds] of roles) {
      await loginPage(page, creds);
      const get = await page.request.get('/api/ingestion/runs');
      expect(get.status(), role).toBe(200);
      const post = await page.request.post('/api/ingestion/run', { data: { pages: 1 } });
      if (role === 'bid_manager') { expect([200, 429]).toContain(post.status()); continue; }
      expect(post.status(), role).toBe(403);
      expect((await post.json()).error.message).toBe('You need to be at least a Bid Manager to do that');
      const pill = await openPill(page);
      await pill.click();
      await expect(page.getByLabel('Recent syncs')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sync now' })).toHaveCount(0);
      await shot(page, `S7-${role}-no-sync-button`);
    }
    // Manager does see the button.
    await loginPage(page, state.manager!);
    const pill = await openPill(page);
    await pill.click();
    await expect(page.getByRole('button', { name: 'Sync now' })).toBeVisible();
    await shot(page, 'S7-bid-manager-has-sync-button');
  });
});

test('S8 mobile: sync-health pill at 375 px @mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const u = uniqueUser('mob');
  expect((await page.request.post('/api/auth/signup', { data: u })).status()).toBe(201);
  const pill = await openPill(page);
  await expect(pill).toContainText(/Synced|Not synced|Sync failing/);
  await expect(pill.getByText(/open bids/)).toBeHidden(); // hidden below 640 px
  const box = await pill.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'S8-pill-375px');
  await pill.click();
  await expect(page.getByLabel('Recent syncs')).toBeVisible();
  await shot(page, 'S8-popover-375px');
});
