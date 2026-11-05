/**
 * 003 / US2 (#63) — Build, preview and manage watchlists. QA task T032.
 * Covers spec scenarios 1-14 (+ 15 / FR-028) and FR-020..FR-028.
 * Serial: the scenarios build on one state (36 ingested bids -> "Laptops — Maharashtra" -> pause/resume -> edit -> ...).
 * Tenders come from ONE real manual sync in the setup test (mock-gem fixtures). A few extra tenders needed to
 * exercise the matcher (scenarios 7/8, FR-028) are arranged with direct SQL, like US1 does; the matcher itself is
 * always exercised through the real preview / create endpoints and UI. The 2-minute manual-sync cooldown is cleared
 * by ageing the previous runs in SQL instead of waiting.
 */
import { execFileSync } from 'node:child_process';
import { request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { test, expect, evidence, collectRunArtifacts, checkA11y, mockGem, uniqueUser } from '../support/fixtures';

const SPEC = '003', STORY = 'US2';
const BASE = `http://localhost:${process.env.E2E_PORT || 8788}`;
const DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

const sql = (q: string) => execFileSync('psql', [DB, '-qtAX', '-c', q], { encoding: 'utf8' }).trim();
const count = (table: string, where = 'true') => Number(sql(`select count(*) from ${table} where ${where}`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const NAME = 'Laptops — Maharashtra';

type Creds = { email: string; password: string };
type Wl = { id: string; name: string; active: boolean; matchCount: number; openCount: number; newThisWeek: number; criteria: Record<string, unknown> };
const S: {
  owner?: Creds; manager?: Creds; analyst?: Creds; viewer?: Creds; mgrReq?: APIRequestContext;
  wlId?: string; orgA?: string; ownerB?: Creds; viewerB?: Creds; wlB?: string; pausedId?: string;
} = {};

async function login(page: Page, c: Creds) {
  await page.context().clearCookies();
  const res = await page.request.post('/api/auth/login', { data: { email: c.email, password: c.password } });
  expect(res.status(), await res.text()).toBe(200);
}

/** Clear the FR-013 manual-sync cooldown (age finished runs) and sync once through the real endpoint. */
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

const list = async (req: APIRequestContext): Promise<Wl[]> => (await (await req.get('/api/watchlists')).json()).items;
const bidNumbersOf = async (req: APIRequestContext, wlId: string) =>
  ((await (await req.get(`/api/tenders?watchlistId=${wlId}&pageSize=100`)).json()).items as { bidNumber: string }[]).map((t) => t.bidNumber).sort();

// ── builder helpers ──
const sheet = (page: Page) => page.getByRole('dialog');
const preview = (page: Page) => page.getByRole('complementary', { name: 'Preview' });
async function openBuilder(page: Page) {
  await page.getByRole('button', { name: 'New watchlist' }).click();
  await expect(sheet(page).getByText('New watchlist').first()).toBeVisible();
}
async function addChip(page: Page, placeholder: string | RegExp, value: string) {
  const input = sheet(page).getByPlaceholder(placeholder);
  await input.fill(value);
  await input.press('Enter');
}
async function pickState(page: Page, state: string) {
  await sheet(page).getByRole('button', { name: /^States\b/ }).click();
  await page.getByRole('textbox', { name: 'Search States' }).fill(state);
  await page.getByRole('option', { name: state, exact: true }).locator('label').click();
  await page.keyboard.press('Escape'); // closes the popover only
}
const previewCount = (page: Page, n: number) => preview(page).locator('p.text-3xl').filter({ hasText: new RegExp(`^${n}$`) });
const samples = (page: Page) => preview(page).getByRole('list', { name: 'Sample matches' }).locator('li');

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

test.describe('US2 watchlists', () => {
  test.setTimeout(180_000);

  test('setup: reset mock-gem, org + Owner/Bid Manager/Analyst/Viewer, ONE real sync -> 36 tenders', async ({ page }) => {
    await mockGem(page.request, '/__admin/reset');
    await mockGem(page.request, '/__admin/fail', { mode: 'off' });
    const { u, req: own } = await signupOrg('owner');
    S.owner = { email: u.email, password: u.password };
    S.manager = await invite(own, 'bid_manager');
    S.analyst = await invite(own, 'analyst');
    S.viewer = await invite(own, 'viewer');
    S.mgrReq = await pwRequest.newContext({ baseURL: BASE });
    expect((await S.mgrReq.post('/api/auth/login', { data: S.manager })).status()).toBe(200);
    const run = await syncNow(S.mgrReq);
    expect(run).toMatchObject({ status: 'success', tendersSeen: 36, tendersCreated: 36 });
    expect(count('tenders')).toBe(36);
    expect(count('watchlists')).toBe(0);
    await own.dispose();
  });

  test('S1: no watchlists -> "No watchlists yet", Build a watchlist button, Quick start grid of 6 templates', async ({ page }) => {
    await login(page, S.analyst!);
    await page.goto('/watchlists');
    await expect(page.getByText('No watchlists yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Build a watchlist' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Quick start' })).toBeVisible();
    const names = ['IT hardware', 'CCTV & security systems', 'Manpower & facility services', 'Medical equipment', 'Solar & electrical', 'Office furniture'];
    const tpl = page.locator('section[aria-labelledby="tpl-h"]');
    await expect(tpl.getByRole('button')).toHaveCount(6);
    for (const n of names) await expect(tpl.getByRole('button', { name: new RegExp(`^${n.replace(/[&]/g, '\\&')}`) })).toBeVisible();
    await shot(page, 'S1-empty-state-templates');
    // T043: WCAG 2.1 A/AA (serious/critical) on /watchlists in light and dark.
    for (const scheme of ['light', 'dark'] as const) {
      await page.evaluate((s) => { try { localStorage.setItem('tp-theme', s); } catch { /* ignore */ } }, scheme);
      await page.emulateMedia({ colorScheme: scheme });
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Quick start' })).toBeVisible();
      await expect(page.locator('html')).toHaveClass(scheme === 'dark' ? /dark/ : /^(?!.*dark)/);
      await checkA11y(page);
    }
  });

  test('S2: empty builder shows the prompt; keyword laptop + state Maharashtra -> 2 bids, 2 sample cards with reason badges', async ({ page }) => {
    await login(page, S.analyst!);
    await page.goto('/watchlists');
    await openBuilder(page);
    await expect(preview(page).getByText('Add a keyword, state or buyer to see matching open bids.')).toBeVisible();
    await shot(page, 'S2a-builder-empty-preview-prompt');

    await addChip(page, /laptop, CCTV/, 'laptop');
    await expect(preview(page).locator('p.text-3xl')).toBeVisible();
    const t0 = Date.now();
    await pickState(page, 'Maharashtra');
    await expect(previewCount(page, 2)).toBeVisible({ timeout: 5000 });
    const elapsed = Date.now() - t0;
    test.info().annotations.push({ type: 'preview-latency-ms', description: String(elapsed) });
    expect(elapsed, `preview took ${elapsed} ms after selecting the state (spec: ~1 s)`).toBeLessThan(2500);
    await expect(preview(page).getByText('open GeM bids match right now')).toBeVisible();
    await expect(samples(page)).toHaveCount(2);
    const texts = await samples(page).allInnerTexts();
    for (const bn of ['GEM/2026/B/6421001', 'GEM/2026/B/6421010']) expect(texts.join('\n')).toContain(bn);
    for (const t of texts) {
      expect(t).toMatch(/GEM\/2026\/B\/\d+/);           // bid number
      expect(t).toMatch(/\d+\s*(d|h|m)\b|\bdays?\b|\bhours?\b|closes|ends/i); // countdown
      expect(t).toContain('Maharashtra');                // buyer · state
      expect(t).toContain('Keyword “laptop”');
      expect(t).toContain('State: Maharashtra');
    }
    await shot(page, 'S2b-preview-2-bids-reason-badges');
    // API contract: {count, sample[<=5]}
    const api = await page.request.post('/api/watchlists/preview', { data: { criteria: { keywords: ['laptop'], states: ['Maharashtra'] } } });
    expect(api.status()).toBe(200);
    const body = await api.json();
    expect(body.count).toBe(2);
    expect(body.sample.length).toBeLessThanOrEqual(5);
  });

  test('S3: keyword submarine -> 0 and the "Nothing open right now" note', async ({ page }) => {
    await login(page, S.analyst!);
    await page.goto('/watchlists');
    await openBuilder(page);
    await addChip(page, /laptop, CCTV/, 'submarine');
    await expect(previewCount(page, 0)).toBeVisible({ timeout: 5000 });
    await expect(preview(page).getByText('Nothing open right now — that’s fine. You’ll be alerted the moment GeM publishes a matching bid.')).toBeVisible();
    await shot(page, 'S3-zero-match-note');
  });

  test('S4: Create -> 201 {matchCount 2, openCount 2, active}, toast, sheet closes, NO notifications for back-fill', async ({ page }) => {
    await login(page, S.analyst!);
    await page.goto('/watchlists');
    await openBuilder(page);
    await sheet(page).getByLabel(/^Name/).fill(NAME);
    await addChip(page, /laptop, CCTV/, 'laptop');
    await pickState(page, 'Maharashtra');
    await expect(previewCount(page, 2)).toBeVisible({ timeout: 5000 });
    expect(count('notifications')).toBe(0);
    const [resp] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/watchlists' && r.request().method() === 'POST'),
      sheet(page).getByRole('button', { name: 'Create watchlist' }).click(),
    ]);
    expect(resp.status()).toBe(201);
    const wl = await resp.json();
    expect(wl).toMatchObject({ name: NAME, matchCount: 2, openCount: 2, active: true });
    S.wlId = wl.id;
    await expect(page.getByText('“Laptops — Maharashtra” is live')).toBeVisible();
    await expect(page.getByText('2 open bids already match — see them in your feed.')).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
    S.orgA = sql(`select org_id from watchlists where id='${wl.id}'`);
    expect(count('notifications', `org_id='${S.orgA}'`), 'back-fill must not notify').toBe(0);
    expect(count('notifications')).toBe(0);
    expect(count('tender_matches', `watchlist_id='${wl.id}'`)).toBe(2);
    expect(await bidNumbersOf(page.request, wl.id)).toEqual(['GEM/2026/B/6421001', 'GEM/2026/B/6421010']);
    // The card shows 2 open bids.
    const card = page.getByRole('list', { name: 'Watchlists' }).locator('li').filter({ hasText: NAME });
    await expect(card.getByText('Open bids')).toBeVisible();
    await expect(card.locator('p.tabular').first()).toHaveText('2');
    await shot(page, 'S4-created-toast-and-card');
    // Feed "My matches" lists exactly the two bids.
    await page.goto(`/tenders?watchlistId=${wl.id}&matched=1`);
    await expect(page.getByText('GEM/2026/B/6421001').first()).toBeVisible();
    await expect(page.getByText('GEM/2026/B/6421010').first()).toBeVisible();
    await expect(page.getByText(/2\s+tenders/).first()).toBeVisible();
    await shot(page, 'S4-feed-my-matches-2-bids');
  });

  test('S5: empty name / no criterion -> inline errors; API with empty criteria -> 400 validation_error', async ({ page }) => {
    await login(page, S.analyst!);
    await page.goto('/watchlists');
    await openBuilder(page);
    await sheet(page).getByRole('button', { name: 'Create watchlist' }).click();
    await expect(sheet(page).getByText('Give the watchlist a name, e.g. “Laptops — Maharashtra”')).toBeVisible();
    await expect(sheet(page).getByText('Add at least one keyword, state, buyer, category, HSN code or value limit')).toBeVisible();
    await shot(page, 'S5a-inline-errors');
    const before = count('watchlists');
    const api = await page.request.post('/api/watchlists', { data: { name: 'Empty criteria', criteria: {} } });
    expect(api.status()).toBe(400);
    const body = await api.json();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.message).toBe('Add at least one keyword, category, HSN code, state, buyer, value limit or bid type');
    expect(count('watchlists')).toBe(before);
    test.info().annotations.push({ type: 'api', description: `POST /api/watchlists {criteria:{}} -> ${api.status()} ${JSON.stringify(body.error)}` });
  });

  test('S6: min 100 L > max 10 L -> "Maximum must be at least the minimum" (API 400 criteria.maxValue); HSN 84A1 rejected', async ({ page }) => {
    await login(page, S.analyst!);
    await page.goto('/watchlists');
    await openBuilder(page);
    await sheet(page).getByLabel(/^Name/).fill('Range test');
    await addChip(page, /laptop, CCTV/, 'laptop');
    await sheet(page).getByLabel('Minimum value in lakh').fill('100');
    await sheet(page).getByLabel('Maximum value in lakh').fill('10');
    await sheet(page).getByRole('button', { name: 'Create watchlist' }).click();
    await expect(sheet(page).getByText('Maximum must be at least the minimum')).toBeVisible();
    await addChip(page, /e\.g\. 8471/, '84A1');
    await expect(sheet(page).getByText('HSN codes are 2–8 digits')).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: 'Remove 84A1' })).toHaveCount(0);
    await addChip(page, /e\.g\. 8471/, '8471');
    await expect(sheet(page).getByRole('button', { name: 'Remove 8471' })).toHaveCount(1);
    await shot(page, 'S6-range-error-and-hsn-rejected');
    const api = await page.request.post('/api/watchlists', { data: { name: 'Range test', criteria: { keywords: ['laptop'], minValue: 10_000_000, maxValue: 1_000_000 } } });
    expect(api.status()).toBe(400);
    const body = await api.json();
    expect(body.error.code).toBe('validation_error');
    expect(Object.keys(body.error.details.fields)).toContain('criteria.maxValue');
    test.info().annotations.push({ type: 'api', description: `min>max -> ${api.status()} ${JSON.stringify(body.error.details.fields)}` });
    const hsnApi = await page.request.post('/api/watchlists/preview', { data: { criteria: { hsnCodes: ['84A1'] } } });
    expect(hsnApi.status()).toBe(400);
    expect(await hsnApi.text()).toContain('HSN codes are 2–8 digits');
    expect(count('watchlists', "name='Range test'")).toBe(0);
  });

  test('S7: matcher - exclude keyword, plural, word boundary, HSN prefix (UI preview + API)', async ({ page }) => {
    // Arrange extra open tenders (state Goa so the 36 fixtures never interfere).
    sql("delete from tenders where bid_number like 'QA/US2/%'");
    const ins = (bn: string, title: string, o: { hsn?: string[]; value?: number | null; days?: number } = {}) =>
      sql(`insert into tenders (bid_number, title, items, state, estimated_value, hsn_codes, end_at, status, source_url, content_hash, bid_type)
           values ('${bn}', '${title}', '[]', 'Goa', ${o.value === undefined ? 'null' : o.value}, '${JSON.stringify(o.hsn ?? [])}'::jsonb,
                   now() + interval '${o.days ?? 20} days', 'open', 'http://example.invalid/${bn}', 'qa-${bn}', 'bid')`);
    ins('QA/US2/REFURB', 'Refurbished Laptop');
    ins('QA/US2/PLURAL', 'Laptops for district offices');
    ins('QA/US2/BAG', 'Laptopbag procurement');
    ins('QA/US2/HSN', 'Desktop computers', { hsn: ['84713010'] });
    await login(page, S.analyst!);
    await page.goto('/watchlists');
    await openBuilder(page);
    await addChip(page, /laptop, CCTV/, 'laptop');
    await pickState(page, 'Goa');
    // keyword laptop in Goa: Refurbished Laptop + Laptops (plural) match; Laptopbag does not (word boundary)
    await expect(previewCount(page, 2)).toBeVisible({ timeout: 5000 });
    let all = (await samples(page).allInnerTexts()).join('\n');
    expect(all).toContain('QA/US2/REFURB');
    expect(all).toContain('QA/US2/PLURAL');
    expect(all).not.toContain('QA/US2/BAG');
    await shot(page, 'S7a-plural-matches-laptopbag-does-not');
    // exclude refurbished -> Refurbished Laptop drops out
    await addChip(page, 'Words to ignore', 'refurbished');
    await expect(previewCount(page, 1)).toBeVisible({ timeout: 5000 });
    all = (await samples(page).allInnerTexts()).join('\n');
    expect(all).toContain('QA/US2/PLURAL');
    expect(all).not.toContain('QA/US2/REFURB');
    await shot(page, 'S7b-exclude-keyword-refurbished');
    // HSN 8471 (4-digit heading) matches HSN 84713010 with reason "HSN 8471"
    const res = await page.request.post('/api/watchlists/preview', { data: { criteria: { hsnCodes: ['8471'], states: ['Goa'] } } });
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.sample[0].bidNumber).toBe('QA/US2/HSN');
    expect(body.sample[0].previewReasons).toContain('HSN 8471');
    // …and the same through the UI
    await sheet(page).getByRole('button', { name: 'Remove laptop' }).click();
    await sheet(page).getByRole('button', { name: 'Remove refurbished' }).click();
    await addChip(page, /e\.g\. 8471/, '8471');
    await expect(previewCount(page, 1)).toBeVisible({ timeout: 5000 });
    await expect(samples(page).first()).toContainText('HSN 8471');
    await expect(samples(page).first()).toContainText('QA/US2/HSN');
    await shot(page, 'S7c-hsn-8471-matches-84713010');
    // API: exact reasons for the plural / word-boundary / exclusion cases
    const lap = await (await page.request.post('/api/watchlists/preview', { data: { criteria: { keywords: ['laptop'], excludeKeywords: ['refurbished'], states: ['Goa'] } } })).json();
    expect(lap.sample.map((s: { bidNumber: string }) => s.bidNumber)).toEqual(['QA/US2/PLURAL']);
    expect(lap.sample[0].previewReasons).toContain('Keyword “laptop”');
  });

  test('S8: min value 10 L still matches a bid without a published value ("Value not published"); "at least a week left" drops bids closing sooner', async ({ page }) => {
    const ins = (bn: string, title: string, value: number | null, days: number) =>
      sql(`insert into tenders (bid_number, title, items, state, estimated_value, hsn_codes, end_at, status, source_url, content_hash, bid_type)
           values ('${bn}', '${title}', '[]', 'Goa', ${value ?? 'null'}, '[]'::jsonb, now() + interval '${days} days', 'open', 'http://example.invalid/${bn}', 'qa-${bn}', 'bid')`);
    ins('QA/US2/NOVAL', 'Printer cartridges', null, 20);
    ins('QA/US2/SOON', 'Printer toner urgent', 2_000_000, 3);
    ins('QA/US2/LATER', 'Printer paper reams', 2_000_000, 20);
    ins('QA/US2/CHEAP', 'Printer ribbons', 500_000, 20);
    await login(page, S.analyst!);
    await page.goto('/watchlists');
    await openBuilder(page);
    await addChip(page, /laptop, CCTV/, 'printer');
    await pickState(page, 'Goa');
    await sheet(page).getByLabel('Minimum value in lakh').fill('10');
    // NOVAL (no value) and SOON/LATER (20 L) match; CHEAP (5 L) does not
    await expect(previewCount(page, 3)).toBeVisible({ timeout: 5000 });
    const noval = samples(page).filter({ hasText: 'QA/US2/NOVAL' });
    await expect(noval).toHaveCount(1);
    await expect(noval).toContainText('Value not published');
    await expect(samples(page).filter({ hasText: 'QA/US2/CHEAP' })).toHaveCount(0);
    await shot(page, 'S8a-value-not-published-still-matches');
    // Time to prepare: at least a week left -> SOON (3 days) is dropped
    await sheet(page).getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'At least a week left' }).click();
    await expect(previewCount(page, 2)).toBeVisible({ timeout: 5000 });
    const txt = (await samples(page).allInnerTexts()).join('\n');
    expect(txt).not.toContain('QA/US2/SOON');
    expect(txt).toContain('QA/US2/LATER');
    await shot(page, 'S8b-at-least-a-week-left');
    const api = await (await page.request.post('/api/watchlists/preview', { data: { criteria: { keywords: ['printer'], states: ['Goa'], minValue: 1_000_000, minDaysToClose: 7 } } })).json();
    expect(api.sample.map((s: { bidNumber: string }) => s.bidNumber).sort()).toEqual(['QA/US2/LATER', 'QA/US2/NOVAL']);
  });

  test('FR-020 / FR-022: API limits on criteria; categories + ministries matching; closed and past-deadline bids never match', async ({ page }) => {
    await login(page, S.analyst!);
    const bad = async (data: unknown, label: string) => {
      const r = await page.request.post('/api/watchlists', { data });
      expect(r.status(), `${label}: ${await r.text()}`).toBe(400);
      expect((await r.json()).error.code).toBe('validation_error');
    };
    const base = { keywords: ['laptop'] };
    const before = count('watchlists');
    await bad({ name: 'x'.repeat(81), criteria: base }, 'name 81 chars');
    await bad({ name: '', criteria: base }, 'empty name');
    await bad({ name: 'Too many', criteria: { keywords: Array.from({ length: 51 }, (_, i) => `kw${i}`) } }, '51 keywords');
    await bad({ name: 'Long value', criteria: { keywords: ['y'.repeat(121)] } }, '121-char keyword');
    await bad({ name: 'HSN 9', criteria: { hsnCodes: ['123456789'] } }, '9-digit HSN');
    await bad({ name: 'HSN 1', criteria: { hsnCodes: ['8'] } }, '1-digit HSN');
    await bad({ name: 'Days', criteria: { ...base, minDaysToClose: 366 } }, 'minDaysToClose 366');
    await bad({ name: 'Neg', criteria: { ...base, minValue: -1 } }, 'negative minValue');
    await bad({ name: 'Type', criteria: { ...base, bidTypes: ['auction'] } }, 'bad bid type');
    expect(count('watchlists'), 'no rejected request created a watchlist').toBe(before);
    // boundary values are accepted (preview does not save anything)
    const okp = await page.request.post('/api/watchlists/preview', { data: { criteria: { keywords: ['laptop', 'Laptop', 'laptop'], hsnCodes: ['84', '12345678'], minDaysToClose: 365, bidTypes: ['bid', 'ra', 'bunch', 'service'] } } });
    expect(okp.status()).toBe(200);
    expect(count('watchlists')).toBe(before);
    // categories / ministries / closed / past-deadline (arranged SQL tenders in Goa)
    sql("delete from tenders where bid_number in ('QA/US2/CAT','QA/US2/CLOSED','QA/US2/PAST')");
    sql(`insert into tenders (bid_number, title, items, category, ministry, state, hsn_codes, end_at, status, source_url, content_hash, bid_type) values
      ('QA/US2/CAT', 'Misc stores', '[]', 'Zzcat Widgets', 'Ministry of Zzland', 'Goa', '[]', now() + interval '20 days', 'open', 'http://example.invalid/cat', 'qa-cat', 'bid'),
      ('QA/US2/CLOSED', 'Printer closed lot', '[]', null, null, 'Goa', '[]', now() + interval '20 days', 'closed', 'http://example.invalid/closed', 'qa-closed', 'bid'),
      ('QA/US2/PAST', 'Printer past deadline lot', '[]', null, null, 'Goa', '[]', now() - interval '1 day', 'open', 'http://example.invalid/past', 'qa-past', 'bid')`);
    const pv = async (criteria: unknown) => (await (await page.request.post('/api/watchlists/preview', { data: { criteria } })).json());
    const cat = await pv({ categories: ['zzcat'], states: ['Goa'] });
    expect(cat.sample.map((x: { bidNumber: string }) => x.bidNumber)).toEqual(['QA/US2/CAT']);
    expect(cat.sample[0].previewReasons).toContain('Category: zzcat');
    const min = await pv({ ministries: ['zzland'], states: ['Goa'] });
    expect(min.sample.map((x: { bidNumber: string }) => x.bidNumber)).toEqual(['QA/US2/CAT']);
    expect(min.sample[0].previewReasons).toContain('Buyer: zzland');
    const pr = await pv({ keywords: ['printer'], states: ['Goa'] });
    const nums = pr.sample.map((x: { bidNumber: string }) => x.bidNumber);
    expect(nums).not.toContain('QA/US2/CLOSED');
    expect(nums).not.toContain('QA/US2/PAST');
    expect(pr.count).toBe(4); // NOVAL, SOON, LATER, CHEAP from S8 only
    // AND across dimensions: right category text, wrong state -> no match
    expect((await pv({ keywords: ['zzcat'], states: ['Kerala'] })).count).toBe(0);
  });

  test('S9: pause -> PATCH 200, "Paused" badge, toast, no matches for new ingestions; resume -> toast, silent back-fill', async ({ page }) => {
    await login(page, S.analyst!);
    await page.goto('/watchlists');
    const card = page.getByRole('list', { name: 'Watchlists' }).locator('li').filter({ hasText: NAME });
    const [off] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/watchlists/${S.wlId}`) && r.request().method() === 'PATCH'),
      card.getByRole('switch', { name: `Pause ${NAME}` }).click(),
    ]);
    expect(off.status()).toBe(200);
    expect((await off.json()).active).toBe(false);
    expect(off.request().postDataJSON()).toEqual({ active: false });
    await expect(card.getByText('Paused', { exact: true })).toBeVisible();
    await expect(page.getByText('“Laptops — Maharashtra” paused')).toBeVisible();
    await expect(page.getByText('No alerts until you resume it.')).toBeVisible();
    await shot(page, 'S9a-paused-badge-and-toast');

    // A new matching bid (6421101, Laptop - Notebook, Maharashtra) is ingested while paused
    await mockGem(page.request, '/__admin/publish', { count: 1 });
    const run = await syncNow(S.mgrReq!);
    expect(run).toMatchObject({ status: 'success', tendersCreated: 1 });
    expect(count('tenders', "bid_number='GEM/2026/B/6421101'")).toBe(1);
    expect(count('tender_matches', `watchlist_id='${S.wlId}'`), 'paused watchlist must not match new ingestions').toBe(2);
    expect(count('notifications')).toBe(0);

    await page.reload();
    const [on] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/watchlists/${S.wlId}`) && r.request().method() === 'PATCH'),
      card.getByRole('switch', { name: `Resume ${NAME}` }).click(),
    ]);
    expect(on.status()).toBe(200);
    expect((await on.json()).active).toBe(true);
    await expect(page.getByText('“Laptops — Maharashtra” resumed')).toBeVisible();
    await expect(card.getByText('Paused', { exact: true })).toHaveCount(0);
    // silent back-fill: the bid published while paused is now matched, no notification created
    await expect.poll(() => count('tender_matches', `watchlist_id='${S.wlId}'`)).toBe(3);
    expect(count('notifications'), 'resume back-fills silently').toBe(0);
    // FR-023: one row per (org, tender, watchlist), human-readable reasons, relevance in 0.05-1.00
    expect(count('tender_matches', `watchlist_id='${S.wlId}'`)).toBe(Number(sql(`select count(distinct (org_id, tender_id, watchlist_id)) from tender_matches where watchlist_id='${S.wlId}'`)));
    expect(count('tender_matches', `watchlist_id='${S.wlId}' and (jsonb_array_length(reasons) = 0 or relevance < 0.05 or relevance > 1)`)).toBe(0);
    expect(sql(`select reasons::text from tender_matches m join tenders t on t.id=m.tender_id where m.watchlist_id='${S.wlId}' and t.bid_number='GEM/2026/B/6421101'`)).toContain('State: Maharashtra');
    expect(await bidNumbersOf(page.request, S.wlId!)).toEqual(['GEM/2026/B/6421001', 'GEM/2026/B/6421010', 'GEM/2026/B/6421101']);
    await shot(page, 'S9b-resumed-toast-silent-backfill');
  });

  test('S10: edit criteria so a matched bid no longer matches -> "Watchlist updated", bid leaves ?watchlistId=', async ({ page }) => {
    await login(page, S.analyst!);
    expect(await bidNumbersOf(page.request, S.wlId!)).toContain('GEM/2026/B/6421010');
    await page.goto('/watchlists');
    const card = page.getByRole('list', { name: 'Watchlists' }).locator('li').filter({ hasText: NAME });
    await card.getByRole('button', { name: `Actions for ${NAME}` }).click();
    await page.getByRole('menuitem', { name: 'Edit criteria' }).click();
    await expect(sheet(page).getByText('Edit watchlist')).toBeVisible();
    await expect(sheet(page).getByLabel(/^Name/)).toHaveValue(NAME);
    // 6421010's category is "Laptop - Notebook (Q2), Laptop Bag (Q4)" -> exclude "bag"
    await addChip(page, 'Words to ignore', 'bag');
    await shot(page, 'S10a-edit-sheet-exclude-bag');
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/watchlists/${S.wlId}`) && r.request().method() === 'PATCH'),
      sheet(page).getByRole('button', { name: 'Save changes' }).click(),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.getByText('Watchlist updated')).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
    const after = await bidNumbersOf(page.request, S.wlId!);
    expect(after).not.toContain('GEM/2026/B/6421010');
    expect(after).toContain('GEM/2026/B/6421001');
    await page.goto(`/tenders?watchlistId=${S.wlId}&matched=1`);
    await expect(page.getByText('GEM/2026/B/6421001').first()).toBeVisible();
    await expect(page.getByText('GEM/2026/B/6421010')).toHaveCount(0);
    await shot(page, 'S10b-feed-after-edit-6421010-gone');
  });

  test('S12: Viewer - New watchlist + templates hidden, pause switch disabled, POST 403; other-org id -> 404', async ({ page }) => {
    // Org B (empty): owner + viewer
    const { u, req: ownB } = await signupOrg('ownerb');
    S.ownerB = { email: u.email, password: u.password };
    S.viewerB = await invite(ownB, 'viewer');
    await login(page, S.viewerB);
    await page.goto('/watchlists');
    await expect(page.getByText('No watchlists yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New watchlist' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Build a watchlist' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Quick start' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /IT hardware/ })).toHaveCount(0);
    await shot(page, 'S12a-viewer-no-button-no-templates');
    const post = await page.request.post('/api/watchlists', { data: { name: 'Nope', criteria: { keywords: ['laptop'] } } });
    expect(post.status()).toBe(403);
    expect((await post.json()).error.message).toBe('You need to be at least an Analyst to do that');
    expect(count('watchlists', "name='Nope'")).toBe(0);
    // Owner B creates one -> viewer sees a disabled pause switch
    const created = await ownB.post('/api/watchlists', { data: { name: 'Org B laptops', criteria: { keywords: ['laptop'] } } });
    expect(created.status()).toBe(201);
    S.wlB = (await created.json()).id;
    await page.reload();
    const card = page.getByRole('list', { name: 'Watchlists' }).locator('li').filter({ hasText: 'Org B laptops' });
    await expect(card.getByRole('switch')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'New watchlist' })).toHaveCount(0);
    const vPatch = await page.request.patch(`/api/watchlists/${S.wlB}`, { data: { active: false } });
    expect(vPatch.status()).toBe(403);
    expect((await ownB.get('/api/watchlists')).ok()).toBe(true);
    expect((await list(ownB))[0].active).toBe(true);
    await shot(page, 'S12b-viewer-switch-disabled');
    // Org B owner touches org A's watchlist -> 404 "Watchlist not found"
    const p = await ownB.patch(`/api/watchlists/${S.wlId}`, { data: { active: false } });
    expect(p.status()).toBe(404);
    expect((await p.json()).error.message).toBe('Watchlist not found');
    const d = await ownB.delete(`/api/watchlists/${S.wlId}`);
    expect(d.status()).toBe(404);
    expect((await d.json()).error.message).toBe('Watchlist not found');
    expect(count('watchlists', `id='${S.wlId}'`)).toBe(1);
    expect((await list(ownB)).map((w) => w.id)).not.toContain(S.wlId);
    // Org A viewer: same 403
    await login(page, S.viewer!);
    const vA = await page.request.post('/api/watchlists', { data: { name: 'Nope', criteria: { keywords: ['laptop'] } } });
    expect(vA.status()).toBe(403);
    // Analyst / Bid Manager / Owner are allowed
    for (const c of [S.analyst!, S.manager!, S.owner!]) {
      await login(page, c);
      const ok = await page.request.post('/api/watchlists/preview', { data: { criteria: { keywords: ['laptop'] } } });
      expect(ok.status()).toBe(200);
    }
    await ownB.dispose();
  });

  test('S13: 3 stat tiles + links; cards show criteria chips, Open bids / This week / All time, View matches link', async ({ page }) => {
    await login(page, S.analyst!);
    // a second, paused watchlist so "Active" reads 1 / 2
    const res = await page.request.post('/api/watchlists', { data: { name: 'Solar — paused', active: false, criteria: { keywords: ['solar'] } } });
    expect(res.status()).toBe(201);
    S.pausedId = (await res.json()).id;
    const items = await list(page.request);
    expect(items).toHaveLength(2);
    const week = items.reduce((s, w) => s + w.newThisWeek, 0);
    const open = items.reduce((s, w) => s + w.openCount, 0);
    await page.goto('/watchlists');
    await expect(page.getByText('Active watchlists', { exact: true })).toBeVisible();
    await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
    await expect(page.getByText('New matches this week', { exact: true })).toBeVisible();
    await expect(page.getByText('Open matched bids', { exact: true })).toBeVisible();
    const weekLink = page.locator('a[href="/tenders?matched=1&unseen=1"]');
    const openLink = page.locator('a[href="/tenders?matched=1"]');
    await expect(weekLink).toContainText('New matches this week');
    await expect(weekLink).toContainText(String(week));
    await expect(openLink).toContainText('Open matched bids');
    await expect(openLink).toContainText(String(open));
    const card = page.getByRole('list', { name: 'Watchlists' }).locator('li').filter({ hasText: NAME });
    const w = items.find((x) => x.id === S.wlId)!;
    await expect(card.getByText('laptop', { exact: true })).toBeVisible();           // keyword chip
    await expect(card.getByText('Maharashtra', { exact: true })).toBeVisible();      // state chip
    await expect(card.getByText('not “bag”')).toBeVisible();                          // exclude chip
    const nums = card.locator('p.tabular');
    await expect(nums.nth(0)).toHaveText(String(w.openCount));
    await expect(nums.nth(1)).toHaveText(String(w.newThisWeek));
    await expect(nums.nth(2)).toHaveText(String(w.matchCount));
    await expect(card.getByText('Open bids', { exact: true })).toBeVisible();
    await expect(card.getByText('This week', { exact: true })).toBeVisible();
    await expect(card.getByText('All time', { exact: true })).toBeVisible();
    await shot(page, 'S13a-stat-tiles-and-cards');
    // View matches action
    await card.getByRole('button', { name: `Actions for ${NAME}` }).click();
    const vm = page.getByRole('menuitem', { name: 'View matches' });
    await expect(vm).toBeVisible();
    await expect(vm).toHaveAttribute('href', `/tenders?watchlistId=${S.wlId}&matched=1`);
    await shot(page, 'S13b-view-matches-menu');
    await vm.click();
    await expect(page).toHaveURL(new RegExp(`/tenders\\?watchlistId=${S.wlId}&matched=1`));
    await expect(page.getByText('GEM/2026/B/6421001').first()).toBeVisible();
    await shot(page, 'S13c-view-matches-feed');
  });

  test('S11: Delete -> confirm dialog copy, 200 {ok:true}, "Watchlist deleted", card removed', async ({ page }) => {
    await login(page, S.analyst!);
    await page.goto('/watchlists');
    const card = page.getByRole('list', { name: 'Watchlists' }).locator('li').filter({ hasText: 'Solar — paused' });
    await card.getByRole('button', { name: 'Actions for Solar — paused' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dlg = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(dlg.getByText('Delete “Solar — paused”?')).toBeVisible();
    await expect(dlg.getByText('Its matches disappear from the feed and no more alerts are sent. Tenders you’ve already analysed or started a bid for are kept.')).toBeVisible();
    await shot(page, 'S11a-delete-confirm-dialog');
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/watchlists/${S.pausedId}`) && r.request().method() === 'DELETE'),
      dlg.getByRole('button', { name: 'Delete watchlist' }).click(),
    ]);
    expect(resp.status()).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    await expect(page.getByText('Watchlist deleted')).toBeVisible();
    await expect(card).toHaveCount(0);
    expect(count('watchlists', `id='${S.pausedId}'`)).toBe(0);
    // tenders the watchlist matched are kept
    expect(count('tenders')).toBeGreaterThanOrEqual(37);
    await shot(page, 'S11b-deleted-card-removed');
  });

  test('S4b (FR-025 intent): a matching bid ingested AFTER the watchlist exists raises an alert; back-filled ones never did', async ({ page }) => {
    await login(page, S.analyst!);
    const res = await page.request.post('/api/watchlists', { data: { name: 'CCTV alerts', criteria: { keywords: ['cctv'] } } });
    expect(res.status()).toBe(201);
    const wl = await res.json();
    expect(count('notifications'), 'creation back-fill is silent').toBe(0);
    await mockGem(page.request, '/__admin/publish', { count: 1 }); // 6421102 CCTV Camera (V2)
    const run = await syncNow(S.mgrReq!);
    expect(run).toMatchObject({ status: 'success', tendersCreated: 1 });
    expect(count('tender_matches', `watchlist_id='${wl.id}' and tender_id in (select id from tenders where bid_number='GEM/2026/B/6421102')`)).toBe(1);
    expect(count('notifications', `org_id='${S.orgA}' and kind='tender_match'`)).toBeGreaterThan(0);
    await page.goto('/watchlists');
    await expect(page.getByText('CCTV alerts').first()).toBeVisible();
    await shot(page, 'S4b-alert-for-later-ingested-bid');
  });

  test('S14 / FR-027: org with 50 watchlists (paused count) -> 409 watchlist_limit, inline message in the sheet', async ({ page }) => {
    test.setTimeout(240_000);
    const ownB = await pwRequest.newContext({ baseURL: BASE });
    expect((await ownB.post('/api/auth/login', { data: S.ownerB })).status()).toBe(200);
    const have = (await list(ownB)).length; // 1
    for (let i = have; i < 50; i++) {
      const r = await ownB.post('/api/watchlists', { data: { name: `Bulk ${i}`, active: i % 2 === 0, criteria: { keywords: [`bulkword${i}`] } } });
      expect(r.status(), await r.text()).toBe(201);
    }
    const all = await list(ownB);
    expect(all).toHaveLength(50);
    expect(all.filter((w) => !w.active).length).toBeGreaterThan(10); // paused ones count toward the limit
    const over = await ownB.post('/api/watchlists', { data: { name: 'Number 51', criteria: { keywords: ['laptop'] } } });
    expect(over.status()).toBe(409);
    const body = await over.json();
    expect(body.error.code).toBe('watchlist_limit');
    expect(body.error.message).toBe('You can have up to 50 watchlists — delete one first.');
    expect(count('watchlists', `name='Number 51'`)).toBe(0);
    // UI
    await login(page, S.ownerB!);
    await page.goto('/watchlists');
    await expect(page.getByText('Active watchlists', { exact: true })).toBeVisible();
    await openBuilder(page);
    await sheet(page).getByLabel(/^Name/).fill('Number 51');
    await addChip(page, /laptop, CCTV/, 'laptop');
    await sheet(page).getByRole('button', { name: 'Create watchlist' }).click();
    await expect(sheet(page).getByRole('alert').filter({ hasText: 'You can have up to 50 watchlists — delete one first.' })).toBeVisible();
    await expect(sheet(page)).toBeVisible(); // stays open
    await shot(page, 'S14-limit-50-inline-error');
    // deleting one frees a slot
    const del = await ownB.delete(`/api/watchlists/${all[all.length - 1].id}`);
    expect(del.status()).toBe(200);
    const again = await ownB.post('/api/watchlists', { data: { name: 'Number 51', criteria: { keywords: ['laptop'] } } });
    expect(again.status()).toBe(201);
    await ownB.dispose();
  });

  test('S15 / FR-028: >5,000 open tenders match -> preview count and back-fill find every one (no silent cap)', async ({ page }) => {
    test.setTimeout(240_000);
    const { u, req } = await signupOrg('ownerc');
    sql("delete from tenders where bid_number like 'QA/BULK/%'");
    sql(`insert into tenders (bid_number, title, items, state, hsn_codes, end_at, status, source_url, content_hash, bid_type)
         select 'QA/BULK/' || g, 'Zzbulk widget lot ' || g, '[]', 'Goa', '[]'::jsonb, now() + interval '15 days', 'open',
                'http://example.invalid/bulk/' || g, 'qa-bulk-' || g, 'bid' from generate_series(1, 5200) g`);
    expect(count('tenders', "bid_number like 'QA/BULK/%'")).toBe(5200);
    const pv = await req.post('/api/watchlists/preview', { data: { criteria: { keywords: ['zzbulk'], states: ['Goa'] } } });
    expect(pv.status()).toBe(200);
    const pb = await pv.json();
    expect(pb.count).toBe(5200);
    expect(pb.sample.length).toBe(5);
    const cr = await req.post('/api/watchlists', { data: { name: 'Bulk widgets', criteria: { keywords: ['zzbulk'], states: ['Goa'] } } });
    expect(cr.status(), await cr.text()).toBe(201);
    const wl = await cr.json();
    expect(wl).toMatchObject({ matchCount: 5200, openCount: 5200 });
    expect(count('tender_matches', `watchlist_id='${wl.id}'`)).toBe(5200);
    await login(page, { email: u.email, password: u.password });
    await page.goto('/watchlists');
    await openBuilder(page);
    await addChip(page, /laptop, CCTV/, 'zzbulk');
    await pickState(page, 'Goa');
    await expect(preview(page).locator('p.text-3xl')).toHaveText(/^5,200$/, { timeout: 8000 });
    await shot(page, 'S15-preview-5200-no-cap');
    await req.delete(`/api/watchlists/${wl.id}`);
    sql("delete from tenders where bid_number like 'QA/BULK/%'");
    await req.dispose();
  });
});

test('S-mobile: watchlist builder at 375 px @mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const u = uniqueUser('mobwl');
  expect((await page.request.post('/api/auth/signup', { data: u })).status()).toBe(201);
  await page.goto('/watchlists');
  await expect(page.getByText('No watchlists yet')).toBeVisible();
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noOverflow()).toBe(true);
  await shot(page, 'M1-empty-state-375px');
  await page.getByRole('button', { name: 'Build a watchlist' }).click();
  const dlg = sheet(page);
  await expect(dlg.getByText('New watchlist').first()).toBeVisible();
  const box = await dlg.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375.5);
  expect(await noOverflow()).toBe(true);
  await dlg.getByLabel(/^Name/).fill(NAME);
  await addChip(page, /laptop, CCTV/, 'laptop');
  await pickState(page, 'Maharashtra');
  await expect(preview(page).getByText('open GeM bids match right now')).toBeVisible({ timeout: 8000 });
  await expect(preview(page).locator('p.text-3xl')).toBeVisible();
  const create = dlg.getByRole('button', { name: 'Create watchlist' });
  await expect(create).toBeVisible();
  const cb = await create.boundingBox();
  expect(cb!.x + cb!.width).toBeLessThanOrEqual(375.5);
  await shot(page, 'M2-builder-sheet-375px');
  await preview(page).scrollIntoViewIfNeeded();
  await shot(page, 'M3-builder-preview-375px');
  expect(await noOverflow()).toBe(true);
});
