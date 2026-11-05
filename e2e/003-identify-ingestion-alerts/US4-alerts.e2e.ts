/**
 * 003 / US4 (#65) — Get alerted in-app, by email and on WhatsApp, instantly or as a daily digest. QA task T055.
 * Covers spec scenarios 1-13 and FR-040..FR-044 (+ FR-047 retries, FR-048 unsubscribe, FR-049 ?kind validation).
 *
 * One org ("X") with eight members, prefs arranged BEFORE the one publish so a single sync exercises every channel mix:
 *   owner / manager / analyst / viewer  default prefs (the "4 members with default preferences" of scenario 1)
 *   wa   instant, email + WhatsApp (phone set)        dig  Daily digest, email + WhatsApp (phone set)
 *   nip  in-app OFF, email on (scenario 10)           nop  WhatsApp on but the phone was removed afterwards
 * Real manual syncs against mock-gem: #1 ingests the 36 recorded bids (no watchlist yet -> no alerts), then the watchlist
 * "Laptops — Maharashtra" is created and 6421101 is published -> sync #2 (tendersCreated:1, matchesCreated:1) sends
 * the alerts and runs the dispatcher. Sync #3 (second sync) proves no duplicates / no second digest.
 * The log mailer is the only mailer in E2E (no RESEND_API_KEY) so emails are CAPTURED via GET /api/__test/mail
 * (E2E_TEST_HOOKS=1) and their delivery row ends `skipped` — "sent", "failed" and retry/back-off need a provider that
 * can answer or fail and are therefore asserted by the API integration tests (apps/api/test/ingest.test.ts), see VERDICT.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { test, expect, evidence, collectRunArtifacts, checkA11y, mockGem, uniqueUser } from '../support/fixtures';

const SPEC = '003', STORY = 'US4';
const BASE = `http://localhost:${process.env.E2E_PORT || 8788}`;
const DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
const WL = 'Laptops — Maharashtra';
const BID = 'GEM/2026/B/6421101';

const sql = (q: string) => execFileSync('psql', [DB, '-qtAX', '-c', q], { encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const note = (type: string, description: string) => test.info().annotations.push({ type, description });

type Creds = { email: string; password: string; id: string; name: string };
type Who = 'owner' | 'manager' | 'analyst' | 'viewer' | 'wa' | 'dig' | 'nip' | 'nop';
const DEFAULTS: Who[] = ['owner', 'manager', 'analyst', 'viewer'];
const ALL: Who[] = ['owner', 'manager', 'analyst', 'viewer', 'wa', 'dig', 'nip', 'nop'];
type Saved = {
  users: Record<Who, Creds>; orgName: string; orgId: string; tenderId: string; yUser: Creds; yNotificationId: string;
  run: Record<string, unknown>; istHourAtDispatch: number; mailCountAfterPublish: number;
};
let S: Saved | undefined;
const STATE_FILE = `qa/.runs/${process.env.E2E_PORT || 8788}/us4-state.json`;
const reqs = new Map<string, APIRequestContext>();

async function apiAs(c: Creds): Promise<APIRequestContext> {
  const hit = reqs.get(c.email);
  if (hit) return hit;
  const r = await pwRequest.newContext({ baseURL: BASE });
  const res = await r.post('/api/auth/login', { data: { email: c.email, password: c.password } });
  expect(res.status(), await res.text()).toBe(200);
  reqs.set(c.email, r);
  return r;
}
async function login(page: Page, c: Creds) {
  await page.context().clearCookies();
  const res = await page.request.post('/api/auth/login', { data: { email: c.email, password: c.password } });
  expect(res.status(), await res.text()).toBe(200);
}
const setTheme = async (page: Page, scheme: 'light' | 'dark') => {
  await page.evaluate((s) => { try { localStorage.setItem('tp-theme', s); } catch { /* ignore */ } }, scheme);
  await page.emulateMedia({ colorScheme: scheme });
  await page.reload();
  await expect(page.locator('html')).toHaveClass(scheme === 'dark' ? /dark/ : /^(?!.*dark)/);
};

/** POST /api/ingestion/run; ages earlier runs by 10 min first (like US3) so the FR-013 2-min cooldown does not block. */
async function syncNow(req: APIRequestContext) {
  sql("update ingestion_runs set started_at = started_at - interval '10 minutes', finished_at = finished_at - interval '10 minutes' where finished_at is not null");
  for (let i = 0; i < 3; i++) {
    const res = await req.post('/api/ingestion/run', { data: { pages: 5 } });
    if (res.status() !== 429) { expect(res.status(), await res.text()).toBe(200); return res.json() as Promise<Record<string, unknown>>; }
    const retryAt = Date.parse((await res.json()).error.details.retryAt);
    await sleep(Math.max(0, retryAt - Date.now()) + 1500);
  }
  throw new Error('cooldown never cleared');
}

type Mail = { to: string | string[]; subject: string; html: string; text?: string; headers?: Record<string, string> };
const toList = (m: Mail) => (Array.isArray(m.to) ? m.to : [m.to]);
async function capturedMail(): Promise<Mail[]> {
  const r = await pwRequest.newContext({ baseURL: BASE });
  const res = await r.get('/api/__test/mail');
  expect(res.status(), 'E2E_TEST_HOOKS mail capture must be mounted').toBe(200);
  const sent = ((await res.json()).sent ?? []) as Mail[];
  await r.dispose();
  return sent;
}
const mailTo = (all: Mail[], email: string) => all.filter((m) => toList(m).includes(email));

type Delivery = { channel: 'email' | 'whatsapp'; status: string; error: string | null; sentAt: string | null };
type NDto = { id: string; kind: string; title: string; body: string; link: string | null; read: boolean; createdAt: string; deliveries: Delivery[] };
const inbox = async (req: APIRequestContext, qs = ''): Promise<{ items: NDto[]; unreadCount: number; total: number }> => {
  const r = await req.get(`/api/notifications?pageSize=100${qs}`);
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
};
const rowsOf = (u: Creds, channel: string, kind = 'tender_match') =>
  sql(`select status||'|'||coalesce(error,'') from notifications where user_id='${u.id}' and channel='${channel}' and kind='${kind}'`).split('\n').filter(Boolean);
const count = (where: string) => Number(sql(`select count(*) from notifications where ${where}`));

const bell = (page: Page) => page.getByRole('button', { name: /^Notifications(, \d+ unread)?$/ });

// Not 'serial': a failing criterion must not skip the rest. The worker restarts after a failure, so the org/credentials
// from the setup test are persisted to a git-ignored file and restored before every other test.
test.beforeEach(async () => {
  test.skip(/@mobile/.test(test.info().title) && test.info().project.name === 'desktop', 'covered by the mobile project');
  if (S || test.info().title.startsWith('setup')) return;
  S = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Saved;
});
test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

test.describe('US4 alerts', () => {
  test.setTimeout(240_000);

  test('setup: 8-member org, ONE publish of 6421101 + sync -> tendersCreated:1, matchesCreated:1', async ({ page }) => {
    S = undefined; reqs.clear();
    await mockGem(page.request, '/__admin/reset');
    await mockGem(page.request, '/__admin/fail', { mode: 'off' });

    const ownerU = uniqueUser('owner');
    const own = await pwRequest.newContext({ baseURL: BASE });
    expect((await own.post('/api/auth/signup', { data: ownerU })).status()).toBe(201);
    const me = async (r: APIRequestContext) => (await (await r.get('/api/auth/me')).json()) as { user: { id: string; name: string }; org?: { id: string; name: string } };
    const ownerMe = await me(own);
    const users = { owner: { email: ownerU.email, password: ownerU.password, id: ownerMe.user.id, name: ownerU.name } } as Record<Who, Creds>;
    const ownerCtx = await (await own.get('/api/auth/me')).json();
    const orgName = ownerCtx.org?.name ?? ownerCtx.activeOrg?.name ?? ownerU.orgName;
    const orgId = String(sql(`select org_id from memberships where user_id='${ownerMe.user.id}'`));

    const invite = async (who: Who, role: 'bid_manager' | 'analyst' | 'viewer') => {
      const u = uniqueUser(who);
      const inv = await own.post('/api/org/invitations', { data: { email: u.email, role } });
      expect(inv.status(), await inv.text()).toBe(201);
      const token = (await inv.json()).inviteUrl.split('/invite/')[1];
      const anon = await pwRequest.newContext({ baseURL: BASE });
      const acc = await anon.post('/api/auth/accept-invite', { data: { token, name: u.name, password: u.password } });
      expect(acc.status(), await acc.text()).toBe(200);
      const id = (await me(anon)).user.id;
      users[who] = { email: u.email, password: u.password, id, name: u.name };
      return anon; // logged-in context of the new member
    };
    const mgr = await invite('manager', 'bid_manager');
    const ana = await invite('analyst', 'analyst');
    await (await invite('viewer', 'viewer')).dispose();
    const wa = await invite('wa', 'analyst');
    const dig = await invite('dig', 'analyst');
    const nip = await invite('nip', 'viewer');
    const nop = await invite('nop', 'viewer');

    const prefs = (r: APIRequestContext, data: Record<string, unknown>) =>
      r.put('/api/me/notification-prefs', { data }).then(async (res) => { expect(res.status(), await res.text()).toBe(200); });
    const phone = (r: APIRequestContext, p: string | null) =>
      r.patch('/api/me', { data: { phone: p } }).then(async (res) => { expect(res.status(), await res.text()).toBe(200); });
    await phone(wa, '+919822012340');
    await prefs(wa, { inApp: true, email: true, whatsapp: true, frequency: 'instant', expiryReminders: true });
    await phone(dig, '+919822012341');
    await prefs(dig, { inApp: true, email: true, whatsapp: true, frequency: 'daily', expiryReminders: true });
    await prefs(nip, { inApp: false, email: true, whatsapp: false, frequency: 'instant', expiryReminders: true });
    await phone(nop, '+919822012342');
    await prefs(nop, { inApp: true, email: true, whatsapp: true, frequency: 'instant', expiryReminders: true });
    await phone(nop, null); // phone removed AFTER enabling WhatsApp -> alert row is created `skipped` (scenario 5)

    // Org Y: a separate tenant with one user (cross-org isolation, scenario 9)
    const yU = uniqueUser('orgy');
    const yReq = await pwRequest.newContext({ baseURL: BASE });
    expect((await yReq.post('/api/auth/signup', { data: yU })).status()).toBe(201);
    const yUser: Creds = { email: yU.email, password: yU.password, id: (await me(yReq)).user.id, name: yU.name };

    mkdirSync(STATE_FILE.replace(/\/[^/]+$/, ''), { recursive: true });

    // sync #1: the 36 recorded bids, before any watchlist exists -> zero alerts
    const run1 = await syncNow(mgr);
    expect(run1).toMatchObject({ status: 'success', tendersCreated: 36 });
    expect(count('true')).toBe(0);
    const wlRes = await ana.post('/api/watchlists', { data: { name: WL, criteria: { keywords: ['laptop'], states: ['Maharashtra'] } } });
    expect(wlRes.status(), await wlRes.text()).toBe(201);
    expect(count('true'), 'creating a watchlist back-fills silently (FR-025)').toBe(0);

    // The ONE publish: 6421101 "Laptop - Notebook", Maharashtra
    const pub = await mockGem(page.request, '/__admin/publish', { count: 1 });
    expect(pub.published).toEqual([BID]);
    const mailBefore = (await capturedMail()).length;
    const istHour = Number(new Date(Date.now() + 330 * 60_000).toISOString().slice(11, 13));
    const run = await syncNow(mgr);
    const tenderId = sql(`select id from tenders where bid_number='${BID}'`);
    expect(tenderId).toMatch(/^[0-9a-f-]{36}$/);

    S = { users, orgName, orgId, tenderId, yUser, yNotificationId: '', run, istHourAtDispatch: istHour, mailCountAfterPublish: mailBefore };
    writeFileSync(STATE_FILE, JSON.stringify(S));
    note('run', JSON.stringify(run));
    note('ist-hour-at-dispatch', String(istHour));
    expect(run).toMatchObject({ status: 'success', tendersCreated: 1, tendersUpdated: 0, matchesCreated: 1 });
    for (const r of [own, mgr, ana, wa, dig, nip, nop, yReq]) await r.dispose();
  });

  // ───────────────────────── scenario 1 ─────────────────────────
  test('S1: sync reports tendersCreated:1, matchesCreated:1; every member gets ONE in-app alert "New match: Laptop - Notebook…" (sent) + body + link; one email row per member', async () => {
    const s = S!;
    expect(s.run).toMatchObject({ tendersCreated: 1, matchesCreated: 1 });
    expect(sql('select count(*) from tenders')).toBe('37');
    for (const w of ALL) {
      const u = s.users[w];
      const inApp = sql(`select status||'|'||title||'|'||body||'|'||link||'|'||dedupe_key from notifications where user_id='${u.id}' and channel='in_app' and kind='tender_match'`).split('\n').filter(Boolean);
      if (w === 'nip') { expect(inApp, 'nip turned in-app off').toHaveLength(0); continue; }
      expect(inApp, `${w}: exactly one in-app alert`).toHaveLength(1);
      const [status, title, body, link, dedupe] = inApp[0].split('|');
      expect(status).toBe('sent');
      expect(title).toMatch(/^New match: Laptop - Notebook/);
      expect(body).toMatch(new RegExp(`^${BID} · Higher and Technical Education Department, Maharashtra · closes \\d{1,2} \\w{3}, \\d{1,2}:\\d{2} (am|pm) IST · .*— matched “${WL}”$`));
      expect(link).toBe(`/tenders/${s.tenderId}`);
      expect(dedupe).toBe(`tender:${s.tenderId}:${s.orgId}`);
    }
    expect(count("channel='in_app' and kind='tender_match'")).toBe(7);
    // one email row per member (8 members, all have email on); the rows are dispatched inside the sync request, so they
    // are already final here (`pending` -> `skipped` for the log mailer; the `pending` instant is covered by the API tests)
    for (const w of ALL) expect(rowsOf(s.users[w], 'email'), `${w}: one email row`).toHaveLength(1);
    expect(count("channel='email' and kind='tender_match'")).toBe(8);
    // one watchlist -> one match row for the org
    expect(Number(sql(`select count(*) from tender_matches where org_id='${s.orgId}' and tender_id='${s.tenderId}'`))).toBe(1);
    note('observed', 'email rows are dispatched in the same request as the sync, so "pending" is not observable end-to-end');
  });

  test('S1b: UI - the new alert is shown with title, body and link to the tender', async ({ page }) => {
    const s = S!;
    await login(page, s.users.owner);
    await page.goto('/notifications');
    const item = page.getByRole('button', { name: /^Unread: New match: Laptop - Notebook/ });
    await expect(item).toBeVisible();
    await expect(item).toContainText(`${BID} · Higher and Technical Education Department, Maharashtra · closes`);
    await expect(item).toContainText(`— matched “${WL}”`);
    await shot(page, 'S1-inbox-item-title-body');
    await item.click();
    await expect(page).toHaveURL(new RegExp(`/tenders/${s.tenderId}$`));
    await shot(page, 'S1-item-opens-tender');
    // un-read again so later bell assertions on the owner stay valid
    sql(`update notifications set status='sent', read_at=null where user_id='${s.users.owner.id}' and channel='in_app'`);
  });

  // ───────────────────────── scenario 2 ─────────────────────────
  test('S2: bell shows red badge "1", aria-label "Notifications, 1 unread"; popover has "Notifications", "1 new", Mark all read, the item, View all, Alert settings', async ({ page }) => {
    const s = S!;
    await login(page, s.users.analyst);
    await page.goto('/dashboard');
    const b = page.getByRole('button', { name: 'Notifications, 1 unread' });
    await expect(b).toBeVisible();
    await expect(b.locator('span').filter({ hasText: /^1$/ })).toBeVisible();
    const badgeColor = await b.locator('span').filter({ hasText: /^1$/ }).evaluate((e) => getComputedStyle(e).backgroundColor);
    note('badge-bg', badgeColor);
    await shot(page, 'S2a-bell-badge-1');
    await b.click();
    const pop = page.getByRole('dialog');
    await expect(pop.getByText('Notifications', { exact: true })).toBeVisible();
    await expect(pop.getByText('1 new')).toBeVisible();
    await expect(pop.getByRole('button', { name: 'Mark all read' })).toBeVisible();
    await expect(pop.getByRole('list', { name: 'Latest notifications' }).getByRole('listitem')).toHaveCount(1);
    await expect(pop.getByText(/^New match: Laptop - Notebook/)).toBeVisible();
    await expect(pop.getByText(new RegExp(`${BID} · .*Maharashtra`))).toBeVisible();
    await expect(pop.getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/notifications');
    await expect(pop.getByRole('link', { name: 'Alert settings' })).toHaveAttribute('href', '/settings/notifications');
    await shot(page, 'S2b-bell-popover');
    await pop.getByRole('link', { name: 'View all' }).click();
    await expect(page).toHaveURL(/\/notifications$/);
    await page.getByRole('button', { name: 'Notifications, 1 unread' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Alert settings' }).click();
    await expect(page).toHaveURL(/\/settings\/notifications$/);
  });

  test('S2c: the bell refreshes without a reload (60 s poll) and Mark all read in the popover clears the badge', async ({ page }) => {
    const s = S!;
    await login(page, s.users.wa);
    await page.clock.install();
    await page.goto('/dashboard');
    await expect(page.getByRole('button', { name: 'Notifications, 1 unread' })).toBeVisible();
    // a second alert appears server-side while the page stays open
    sql(`insert into notifications (org_id, user_id, channel, kind, status, title, body, link, dedupe_key, sent_at) values ('${s.orgId}','${s.users.wa.id}','in_app','system','sent','QA poll check','Inserted while the page is open','/notifications','qa-poll:${Date.now()}', now())`);
    let polled = 0;
    page.on('request', (r) => { if (/\/api\/notifications\?/.test(r.url()) && r.method() === 'GET') polled++; });
    await page.clock.fastForward(61_000);
    await expect(page.getByRole('button', { name: 'Notifications, 2 unread' })).toBeVisible();
    expect(polled, 'a GET /api/notifications poll fired within 60 s without navigation').toBeGreaterThan(0);
    await shot(page, 'S2c-bell-refreshed-to-2');
    await page.getByRole('button', { name: 'Notifications, 2 unread' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Mark all read' }).click();
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
    await expect.poll(async () => (await inbox(await apiAs(s.users.wa))).unreadCount).toBe(0);
    await shot(page, 'S2c-after-mark-all-read');
    sql(`update notifications set status='sent', read_at=null where user_id='${s.users.wa.id}' and channel='in_app' and kind='tender_match'`);
    sql(`delete from notifications where user_id='${s.users.wa.id}' and dedupe_key like 'qa-poll:%'`);
  });

  // ───────────────────────── scenario 3 ─────────────────────────
  test('S3: each instant email is sent once: subject = title, bid number, buyer · state, Closes IST, EMD/Value/Qty, Matched “…”, "Review & score this bid →", footer', async ({ page }) => {
    const s = S!;
    const all = await capturedMail();
    const title = sql(`select title from notifications where user_id='${s.users.owner.id}' and channel='in_app'`);
    for (const w of ALL.filter((x) => x !== 'dig')) {
      const mine = mailTo(all, s.users[w].email).filter((m) => m.subject === title);
      expect(mine, `${w}: exactly one alert email`).toHaveLength(1);
    }
    expect(mailTo(all, s.users.dig.email).filter((m) => m.subject === title), 'daily member gets no instant email').toHaveLength(0);
    const m = mailTo(all, s.users.owner.email).find((x) => x.subject === title)!;
    expect(m.subject).toMatch(/^New match: Laptop - Notebook/);
    const text = m.html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    expect(text).toContain(BID);
    expect(text).toContain('Higher and Technical Education Department · Maharashtra');
    expect(text).toMatch(/Closes \d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} (am|pm) IST/i);
    expect(text).toMatch(/EMD/);
    expect(text).toMatch(/Value/);
    expect(text).toMatch(/Qty/);
    expect(text).toMatch(/\d+ days? left/); // "n days left" under the closing date
    expect(text).toContain(`Matched “${WL}”`);
    expect(m.text, 'plain-text part').toContain(BID);
    expect(m.text).toContain(`${BASE}/tenders/${s.tenderId}`);
    expect(m.text).toContain(`${BASE}/settings/notifications`);
    expect(m.html).toContain(`${BASE}/tenders?matched=1`); // link to the feed
    expect(m.html).toContain(`${BASE}/settings/notifications`);
    expect(text).toContain('Review & score this bid →');
    expect(text).toContain('Price entry, OTP / DSC and final submission on GeM are always done by you.');
    expect(m.html).toContain(`href="${BASE}/tenders/${s.tenderId}"`);
    // not within 3 days -> the Closes value is not the red urgent colour
    expect(m.html).not.toMatch(/font-weight:600;color:#e11d48">\d/);
    // the row ends settled with the dispatch time recorded as an attempt outcome
    expect(rowsOf(s.users.owner, 'email')).toEqual(['skipped|Email is not configured (RESEND_API_KEY)']);
    // render the captured HTML as the recipient would see it
    await page.setContent(m.html);
    await expect(page.getByText('Review & score this bid →')).toBeVisible();
    await shot(page, 'S3-alert-email-rendered');
    note('unverifiable-e2e', '"row becomes sent with sentAt / in-app item shows Email delivered" needs a live Resend: asserted by apps/api/test/ingest.test.ts acceptance #3');
  });

  test('S3b: List-Unsubscribe + List-Unsubscribe-Post headers on the alert email (RFC 8058)', async () => {
    const s = S!;
    const all = await capturedMail();
    for (const w of ['owner', 'wa', 'nip'] as Who[]) {
      const m = mailTo(all, s.users[w].email).find((x) => /^New match:/.test(x.subject))!;
      expect(m.headers?.['List-Unsubscribe'], `${w}`).toMatch(new RegExp(`^<${BASE.replace(/\./g, '\\.')}/api/notifications/unsubscribe\\?token=[\\w-]+\\.[\\w-]+>$`));
      expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    }
  });

  // ───────────────────────── scenario 4 ─────────────────────────
  test('S4: RESEND_API_KEY unset -> email row `skipped` "Email is not configured (RESEND_API_KEY)"; in-app item shows "Email not sent" with the reason in its tooltip', async ({ page }) => {
    const s = S!;
    expect(count("channel='email' and kind='tender_match' and status='skipped' and error='Email is not configured (RESEND_API_KEY)'")).toBe(8);
    expect(count("channel='email' and kind='tender_match' and status in ('pending','failed')")).toBe(0);
    const api = await apiAs(s.users.owner);
    const items = (await inbox(api)).items;
    expect(items[0].deliveries).toEqual([{ channel: 'email', status: 'skipped', error: 'Email is not configured (RESEND_API_KEY)', sentAt: null }]);
    await login(page, s.users.owner);
    await page.goto('/notifications');
    const chip = page.getByLabel('Email not sent');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('not sent');
    await chip.hover();
    await expect(page.getByRole('tooltip')).toContainText('Email not sent — Email is not configured (RESEND_API_KEY)');
    await shot(page, 'S4-email-not-sent-chip-tooltip');
    note('unverifiable-e2e', '"provider throws -> row failed with the provider error" cannot be produced with the log mailer: asserted by apps/api/test/ingest.test.ts (retry/failed tests)');
  });

  // ───────────────────────── scenario 5 ─────────────────────────
  test('S5: WhatsApp on without a mobile number -> inline "Add a valid 10-digit mobile number to get WhatsApp alerts" (API 400); "98220 12345" saves as +919822012345 with toast "Notification preferences saved"', async ({ page }) => {
    const s = S!;
    const api = await apiAs(s.users.viewer);
    const bad = await api.put('/api/me/notification-prefs', { data: { inApp: true, email: true, whatsapp: true, frequency: 'instant', expiryReminders: true } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.message).toBe('Add your mobile number in your profile to receive WhatsApp alerts');
    await login(page, s.users.viewer);
    await page.goto('/settings/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications' }).first()).toBeVisible();
    await page.getByRole('switch', { name: 'WhatsApp' }).click();
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByText('Add a valid 10-digit mobile number to get WhatsApp alerts')).toBeVisible();
    await shot(page, 'S5a-phone-validation-error');
    await page.getByLabel('WhatsApp number').fill('98220 12345');
    await expect(page.getByText('We’ll message +919822012345')).toBeVisible();
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByText('Notification preferences saved')).toBeVisible();
    await shot(page, 'S5b-saved-toast');
    const me = await (await api.get('/api/auth/me')).json();
    expect(me.user.phone).toBe('+919822012345');
    expect((await (await api.get('/api/me/notification-prefs')).json()).whatsapp).toBe(true);
    // and an invalid number is refused inline
    await page.getByLabel('WhatsApp number').fill('12345');
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByText('Add a valid 10-digit mobile number to get WhatsApp alerts')).toBeVisible();
    await page.getByRole('switch', { name: 'WhatsApp' }).click(); // WhatsApp off again: a malformed number is still refused on its own
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByText('Enter a 10-digit Indian mobile number starting with 6–9')).toBeVisible();
    await shot(page, 'S5c-malformed-number-refused');
  });

  test('S5b: on a match a WhatsApp row exists per opted-in member: configured phone -> `skipped` "WhatsApp is not configured (WHATSAPP_TOKEN)"; phone later removed -> `skipped` "Add a mobile number in your account…"', async ({ page }) => {
    const s = S!;
    expect(rowsOf(s.users.wa, 'whatsapp')).toEqual(['skipped|WhatsApp is not configured (WHATSAPP_TOKEN)']);
    expect(rowsOf(s.users.nop, 'whatsapp')).toEqual(['skipped|Add a mobile number in your account to receive WhatsApp alerts']);
    for (const w of ['owner', 'manager', 'analyst', 'viewer', 'nip'] as Who[]) expect(rowsOf(s.users[w], 'whatsapp'), `${w} has WhatsApp off`).toHaveLength(0);
    const wa = (await inbox(await apiAs(s.users.wa))).items[0];
    expect(wa.deliveries.map((d) => `${d.channel}:${d.status}`).sort()).toEqual(['email:skipped', 'whatsapp:skipped']);
    await login(page, s.users.nop);
    await page.goto('/notifications');
    const chip = page.getByLabel('WhatsApp not sent');
    await expect(chip).toBeVisible();
    await chip.hover();
    await expect(page.getByRole('tooltip')).toContainText('Add a mobile number in your account to receive WhatsApp alerts');
    await shot(page, 'S5c-whatsapp-not-sent-no-phone');
    await login(page, s.users.wa);
    await page.goto('/notifications');
    await page.getByLabel('WhatsApp not sent').hover();
    await expect(page.getByRole('tooltip')).toContainText('WhatsApp is not configured (WHATSAPP_TOKEN)');
    await shot(page, 'S5d-whatsapp-not-configured');
    note('unverifiable-e2e', 'WhatsApp template `tender_alert` params [title, bid number, closes IST, link] are not observable (no WhatsApp capture hook): asserted by apps/api/test/ingest.test.ts acceptance #3');
  });

  // ───────────────────────── scenario 6 ─────────────────────────
  test('S6: Daily member - in-app instant; email/WhatsApp rows held (pending) before 08:00 IST, else exactly ONE digest per channel "Daily digest: 1 new GeM tender matched today" -> /tenders?matched=1', async () => {
    const s = S!;
    const d = s.users.dig;
    expect(count(`user_id='${d.id}' and channel='in_app' and kind='tender_match' and status='sent'`), 'in-app stays instant').toBe(1);
    const emailRows = rowsOf(d, 'email');
    const waRows = rowsOf(d, 'whatsapp');
    expect(emailRows).toHaveLength(1);
    expect(waRows).toHaveLength(1);
    const digests = (ch: string) => sql(`select status||'|'||title||'|'||link||'|'||dedupe_key from notifications where user_id='${d.id}' and channel='${ch}' and kind='digest'`).split('\n').filter(Boolean);
    const mail = mailTo(await capturedMail(), d.email).filter((m) => /^(New match:|Daily digest:)/.test(m.subject)); // not the invitation mail
    note('ist-hour-at-dispatch', String(s.istHourAtDispatch));
    if (s.istHourAtDispatch < 8) {
      // before 08:00 IST: held, no digest, no email at all
      expect(emailRows).toEqual(['pending|']);
      expect(waRows).toEqual(['pending|']);
      expect(digests('email')).toHaveLength(0);
      expect(mail).toHaveLength(0);
      const api = await apiAs(d);
      expect((await inbox(api)).items[0].deliveries.map((x) => x.status)).toEqual(['pending', 'pending']);
    } else {
      // after 08:00 IST the first dispatch sends one digest per channel
      note('branch', `IST hour ${s.istHourAtDispatch} >= 8: digest branch observed; the "held before 08:00" branch is asserted by apps/api/test/ingest.test.ts (injected clock)`);
      const dg = digests('email');
      expect(dg).toHaveLength(1);
      expect(dg[0]).toMatch(/^skipped\|1 new GeM tender matched today\|\/tenders\?matched=1\|digest:/);
      expect(digests('whatsapp')).toHaveLength(1);
      expect(mail, 'exactly one email for the daily member: the digest').toHaveLength(1);
      expect(mail[0].subject).toBe('Daily digest: 1 new GeM tender matched today');
      expect(mail[0].html).toContain(`${BASE}/tenders?matched=1`);
      expect(mail[0].html).toContain(BID);
      expect(mail[0].headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      // the underlying rows are settled together with the digest, not sent individually
      expect(emailRows[0]).toMatch(/^skipped\|/);
    }
  });

  // ───────────────────────── scenario 7 ─────────────────────────
  test('S7: second sync + a second watchlist of the same org create no second notification for any (user, channel); no second digest the same IST day', async () => {
    const s = S!;
    const alertMail = async () => (await capturedMail()).filter((m) => /^(New match:|Daily digest:)/.test(m.subject)).length;
    const before = { all: count('true'), digests: count("kind='digest'"), mail: await alertMail() };
    const ana = await apiAs(s.users.analyst);
    // a second watchlist that also matches 6421101 (re-match by another watchlist of the same org)
    const w2 = await ana.post('/api/watchlists', { data: { name: 'Notebooks anywhere', criteria: { keywords: ['notebook'] } } });
    expect(w2.status(), await w2.text()).toBe(201);
    expect(count('true'), 'a new watchlist back-fills silently').toBe(before.all);
    const run = await syncNow(await apiAs(s.users.manager));
    expect(run).toMatchObject({ status: 'success', tendersCreated: 0, matchesCreated: 0 });
    expect(count('true'), 'no new notification rows after the second sync').toBe(before.all);
    expect(count("kind='digest'"), 'no second digest').toBe(before.digests);
    expect(await alertMail(), 'no new alert email captured').toBe(before.mail);
    expect(sql(`select count(*) from (select user_id, channel, dedupe_key from notifications where kind='tender_match' group by 1,2,3 having count(*)>1) x`)).toBe('0');
    expect(Number(sql(`select count(*) from tender_matches where org_id='${s.orgId}' and tender_id='${s.tenderId}'`)), 'matched by both watchlists').toBe(2);
    note('run2', JSON.stringify(run));
  });

  // ───────────────────────── scenario 8 ─────────────────────────
  const FILL = 'qa-fill';
  /** Manager's inbox arranged via SQL: the real match (today, unread) + 2 unread yesterday + 28 read, 5 days old. */
  function arrangeInbox(s: Saved) {
    const u = s.users.manager;
    sql(`delete from notifications where user_id='${u.id}' and dedupe_key like '${FILL}:%'`);
    sql(`update notifications set status='sent', read_at=null where user_id='${u.id}' and channel='in_app' and kind='tender_match'`);
    const ins = (n: number, ago: string, status: string, tag: string) => sql(`insert into notifications (org_id,user_id,channel,kind,status,title,body,link,dedupe_key,sent_at,created_at,read_at)
      select '${s.orgId}','${u.id}','in_app','deadline','${status}','QA ${tag} ' || g, 'Filler notification ' || g, '/tenders', '${FILL}:${tag}:' || g, now(), now() - interval '${ago}' - g * interval '1 minute', ${status === 'read' ? 'now()' : 'null'} from generate_series(1,${n}) g`);
    ins(2, '1 day', 'sent', 'yesterday');
    ins(28, '5 days', 'read', 'older');
  }

  test('S8a: /notifications groups by day (Today / Yesterday / date), All vs Unread (n) filter, Load older pages 25 at a time', async ({ page }) => {
    const s = S!;
    arrangeInbox(s);
    await login(page, s.users.manager);
    await page.goto('/notifications');
    const sections = page.locator('section[aria-labelledby^="day-"] h2');
    await expect(sections.nth(0)).toHaveText('Today');
    await expect(sections.nth(1)).toHaveText('Yesterday');
    await expect(sections.nth(2)).toHaveText(/^\d{1,2} \w{3}( \d{4})?$/);
    const items = page.locator('section[aria-labelledby^="day-"] ul > li');
    await expect(items).toHaveCount(25);
    await shot(page, 'S8a-grouped-by-day-first-25');
    const older = page.getByRole('button', { name: 'Load older' });
    await expect(older).toBeVisible();
    expect((await inbox(await apiAs(s.users.manager), '')).total).toBe(31);
    await older.click();
    await expect(items).toHaveCount(31);
    await expect(older).toHaveCount(0);
    await shot(page, 'S8a-load-older-all-31');
    // filter: Unread (3)
    const seg = page.getByRole('group', { name: 'Filter notifications' }).or(page.getByLabel('Filter notifications'));
    await expect(seg.getByText('Unread')).toBeVisible();
    await seg.getByText('Unread').click();
    await expect(items).toHaveCount(3);
    await expect(page).toHaveURL(/tab=unread/);
    await shot(page, 'S8a-unread-filter-3');
    await seg.getByText('All', { exact: true }).click();
    await expect(items).toHaveCount(31); // both already-loaded pages are kept in the cache
    // the API filter behind it: ?unread=1
    const un = await inbox(await apiAs(s.users.manager), '&unread=1');
    expect(un.items).toHaveLength(3);
    expect(un.items.every((n) => !n.read)).toBe(true);
    // spec wording: "(`?unread=1`)" - what the page does with that URL
    await page.goto('/notifications?unread=1');
    await expect(page.locator('section[aria-labelledby^="day-"]').first()).toBeVisible();
    const n = await page.locator('section[aria-labelledby^="day-"] ul > li').count();
    note('observed', `GET /notifications?unread=1 (page URL) renders ${n} items (the page filter's own param is ?tab=unread)`);
    await shot(page, 'S8a-page-url-unread-1');
  });

  test('S8b: clicking an item marks it read and navigates to its link; Mark all read -> POST read-all {ok:true, updated:n} + toast "Marked n notifications as read"; Unread empty state "You’re all caught up"', async ({ page }) => {
    const s = S!;
    arrangeInbox(s);
    await login(page, s.users.manager);
    await page.goto('/notifications');
    await expect(page.locator('section[aria-labelledby^="day-"] ul > li').first()).toBeVisible();
    // click -> read + navigate
    const match = page.getByRole('button', { name: /^Unread: New match: Laptop - Notebook/ });
    const [readRes] = await Promise.all([
      page.waitForResponse((r) => /\/api\/notifications\/[0-9a-f-]{36}\/read$/.test(r.url()) && r.request().method() === 'POST'),
      match.click(),
    ]);
    expect(readRes.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/tenders/${s.tenderId}$`));
    expect((await inbox(await apiAs(s.users.manager))).unreadCount).toBe(2);
    // Mark all read
    await page.goto('/notifications');
    await expect(page.getByRole('button', { name: 'Mark all read' })).toBeEnabled();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/notifications/read-all') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Mark all read' }).click(),
    ]);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 2 });
    await expect(page.getByText('Marked 2 notifications as read')).toBeVisible();
    await shot(page, 'S8b-mark-all-read-toast');
    expect((await inbox(await apiAs(s.users.manager))).unreadCount).toBe(0);
    await expect(page.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
    // Unread empty state
    await page.goto('/notifications?tab=unread');
    await expect(page.getByText('You’re all caught up')).toBeVisible();
    await expect(page.getByRole('button', { name: 'See all notifications' })).toBeVisible();
    await shot(page, 'S8b-unread-all-caught-up');
    const again = await (await apiAs(s.users.manager)).post('/api/notifications/read-all');
    expect(await again.json()).toEqual({ ok: true, updated: 0 });
    arrangeInbox(s);
  });

  test('S8c: empty state "No notifications yet" with Set up watchlists + Alert settings (in-app OFF member)', async ({ page }) => {
    const s = S!;
    await login(page, s.users.nip);
    await page.goto('/notifications');
    await expect(page.getByText('No notifications yet')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Set up watchlists' })).toHaveAttribute('href', '/watchlists');
    await expect(page.getByRole('link', { name: 'Alert settings' }).last()).toBeVisible();
    await shot(page, 'S8c-no-notifications-yet');
    await page.goto('/notifications?tab=unread');
    await expect(page.getByText('You’re all caught up')).toBeVisible();
  });

  // ───────────────────────── scenario 9 ─────────────────────────
  test('S9: GET /api/notifications never returns another user\'s or org\'s alerts; POST /<other id>/read -> 404 "Notification not found"', async () => {
    const s = S!;
    const owner = await apiAs(s.users.owner), viewer = await apiAs(s.users.viewer), y = await apiAs(s.yUser);
    const ownerItems = await inbox(owner);
    const viewerItems = await inbox(viewer);
    expect(ownerItems.items).toHaveLength(1);
    expect(viewerItems.items).toHaveLength(1);
    expect(ownerItems.items[0].id).not.toBe(viewerItems.items[0].id);
    const mine = sql(`select id from notifications where user_id='${s.users.owner.id}' and channel='in_app'`).split('\n');
    expect(ownerItems.items.map((n) => n.id)).toEqual(mine);
    const yItems = await inbox(y);
    expect(yItems.items).toHaveLength(0);
    expect(yItems.total).toBe(0);
    // cross-user (same org) and cross-org
    for (const [name, ctx] of [['viewer(same org)', viewer], ['org Y user', y]] as const) {
      const r = await ctx.post(`/api/notifications/${ownerItems.items[0].id}/read`);
      expect(r.status(), name).toBe(404);
      expect((await r.json()).error.message, name).toBe('Notification not found');
    }
    // the owner's alert is still unread
    expect((await inbox(owner)).items[0].read).toBe(false);
    // the e-mail / WhatsApp delivery rows are not addressable either
    const emailRow = sql(`select id from notifications where user_id='${s.users.owner.id}' and channel='email'`);
    const r2 = await owner.post(`/api/notifications/${emailRow}/read`);
    expect(r2.status()).toBe(404);
    expect((await owner.post('/api/notifications/not-a-uuid/read')).status()).toBe(404);
    // unauthenticated
    const anon = await pwRequest.newContext({ baseURL: BASE });
    expect((await anon.get('/api/notifications')).status()).toBe(401);
    await anon.dispose();
  });

  // ───────────────────────── scenario 10 ─────────────────────────
  test('S10: a member with in-app OFF has no in-app row (bell without badge) but still gets the email row/message', async ({ page }) => {
    const s = S!;
    const u = s.users.nip;
    expect(count(`user_id='${u.id}' and channel='in_app'`)).toBe(0);
    expect(rowsOf(u, 'email')).toEqual(['skipped|Email is not configured (RESEND_API_KEY)']);
    const mine = mailTo(await capturedMail(), u.email).filter((m) => /^New match:/.test(m.subject));
    expect(mine).toHaveLength(1);
    await login(page, u);
    await page.goto('/dashboard');
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /unread/ })).toHaveCount(0);
    await shot(page, 'S10-bell-no-badge');
    await page.goto('/settings/notifications');
    await expect(page.getByRole('switch', { name: 'In-app' })).not.toBeChecked();
    await expect(page.getByRole('switch', { name: 'Email' })).toBeChecked();
    await shot(page, 'S10-settings-inapp-off-email-on');
  });

  // ───────────────────────── scenarios 11-13 ─────────────────────────
  test('S11: transient provider failure retries (+5 / +25 min, failed after 3 attempts, attempt count stored) - observable via the stored attempt count', async () => {
    const s = S!;
    // End-to-end the log mailer never fails, so the attempt counter stays 0 for skipped rows; the retry/back-off path
    // itself needs a failing provider and is covered by the API integration tests (see VERDICT).
    expect(sql(`select count(*) from information_schema.columns where table_name='notifications' and column_name in ('attempts','next_attempt_at')`)).toBe('2');
    expect(count("channel in ('email','whatsapp') and attempts <> 0")).toBe(0);
    note('unverifiable-e2e', 'a failing provider cannot be injected into the E2E server (Resend / Graph URLs fixed); retry & back-off asserted by apps/api/test/ingest.test.ts "alert delivery retries (FR-047, SC-006)"');
    expect(s.orgId).toBeTruthy();
  });

  /** The unsubscribe URL from a captured alert email of `who`. */
  async function unsubUrl(who: Who) {
    const m = mailTo(await capturedMail(), S!.users[who].email).find((x) => /^New match:/.test(x.subject))!;
    return m.headers!['List-Unsubscribe'].replace(/^<|>$/g, '');
  }
  const emailPref = async (c: Creds) => (await (await (await apiAs(c)).get('/api/me/notification-prefs')).json()) as Record<string, unknown>;

  test('S12a: signed-in user - opening the link (GET) shows a confirmation page and changes nothing; its button POST unsubscribes and confirms "You are unsubscribed"', async ({ page }) => {
    const s = S!;
    const u = s.users.viewer;
    const url = await unsubUrl('viewer');
    const before = await emailPref(u);
    expect(before.email).toBe(true);
    await login(page, u);
    await page.goto(url);
    await expect(page.getByRole('heading', { name: `Stop TenderPilot emails from ${s.orgName}?` })).toBeVisible();
    await expect(page.getByText(u.email)).toBeVisible();
    await expect(page.getByText('all TenderPilot emails', { exact: false })).toBeVisible();
    await shot(page, 'S12a-confirmation-page-GET');
    expect(await emailPref(u), 'GET changed nothing').toEqual(before);
    await page.getByRole('button', { name: 'Unsubscribe from these emails' }).click();
    await expect(page.getByRole('heading', { name: 'You are unsubscribed' })).toBeVisible();
    await shot(page, 'S12a-you-are-unsubscribed');
    const after = await emailPref(u);
    expect(after).toEqual({ ...before, email: false });
    await page.goto('/settings/notifications');
    await expect(page.getByRole('switch', { name: 'Email' })).not.toBeChecked();
    await shot(page, 'S12a-settings-email-off');
  });

  test('S12b: signed-OUT user - GET is read-only, button POST unsubscribes (no session needed)', async ({ browser }) => {
    const s = S!;
    const u = s.users.analyst;
    const url = await unsubUrl('analyst');
    const ctx = await browser.newContext({ baseURL: BASE, timezoneId: 'Asia/Kolkata', locale: 'en-IN', recordVideo: { dir: test.info().outputPath('videos') } });
    const page = await ctx.newPage();
    await page.goto(url);
    await expect(page.getByRole('heading', { name: `Stop TenderPilot emails from ${s.orgName}?` })).toBeVisible();
    expect((await emailPref(u)).email, 'GET changed nothing').toBe(true);
    await shot(page, 'S12b-signed-out-confirmation');
    await page.getByRole('button', { name: 'Unsubscribe from these emails' }).click();
    await expect(page.getByRole('heading', { name: 'You are unsubscribed' })).toBeVisible();
    await shot(page, 'S12b-signed-out-unsubscribed');
    expect((await emailPref(u)).email).toBe(false);
    expect((await emailPref(u)).inApp, 'in-app untouched').toBe(true);
    const video = page.video();
    await ctx.close();
    if (video) { try { mkdirSync(`qa/evidence/${SPEC}/${STORY}`, { recursive: true }); await video.saveAs(`qa/evidence/${SPEC}/${STORY}/s12b-signed-out-unsubscribe-${test.info().project.name}.webm`); } catch { /* no video */ } }
  });

  test('S12c: RFC 8058 one-click POST (no session, no Origin) -> 200 {ok:true,email:false}; token for user A used from user B\'s session affects only A; idempotent', async () => {
    const s = S!;
    const url = await unsubUrl('nip');
    const anon = await pwRequest.newContext({ baseURL: BASE });
    const r = await anon.post(url, { form: { 'List-Unsubscribe': 'One-Click' } });
    expect(r.status()).toBe(200);
    expect(await r.json()).toEqual({ ok: true, email: false });
    expect((await emailPref(s.users.nip)).email).toBe(false);
    expect((await anon.post(url, { form: { 'List-Unsubscribe': 'One-Click' } })).status(), 'idempotent').toBe(200);
    await anon.dispose();
    // owner's token POSTed from the manager's authenticated session: only the owner changes
    const ownerUrl = await unsubUrl('owner');
    const mgr = await apiAs(s.users.manager);
    const before = await emailPref(s.users.manager);
    const x = await mgr.post(ownerUrl, { form: { 'List-Unsubscribe': 'One-Click' } });
    expect(x.status()).toBe(200);
    expect((await emailPref(s.users.owner)).email).toBe(false);
    expect(await emailPref(s.users.manager)).toEqual(before);
  });

  test('S12d: tampered / missing / foreign-signed token -> 400 invalid_token on GET and POST, and nothing changes', async () => {
    const s = S!;
    const good = await unsubUrl('wa');
    const token = new URL(good).searchParams.get('token')!;
    const [p, sig] = token.split('.');
    const flip = (str: string) => str.slice(0, -2) + (str.endsWith('AA') ? 'BB' : 'AA');
    const bads = {
      'tampered signature': `${p}.${flip(sig)}`,
      'tampered payload': `${flip(p)}.${sig}`,
      'payload swapped to another user': `${Buffer.from(`${s.users.owner.id}:${s.orgId}:email_matches`).toString('base64url')}.${sig}`,
      'garbage': 'not-a-token',
      'empty': '',
    };
    const anon = await pwRequest.newContext({ baseURL: BASE });
    const before = await emailPref(s.users.wa);
    for (const [name, t] of Object.entries(bads)) {
      const u = `/api/notifications/unsubscribe?token=${encodeURIComponent(t)}`;
      const g = await anon.get(u);
      expect(g.status(), `GET ${name}`).toBe(400);
      expect((await g.json()).error.code, `GET ${name}`).toBe('invalid_token');
      const po = await anon.post(u, { form: { 'List-Unsubscribe': 'One-Click' } });
      expect(po.status(), `POST ${name}`).toBe(400);
      expect((await po.json()).error.code).toBe('invalid_token');
    }
    expect((await anon.get('/api/notifications/unsubscribe')).status(), 'no token').toBe(400);
    expect((await anon.post('/api/notifications/unsubscribe')).status(), 'no token POST').toBe(400);
    await anon.dispose();
    expect(await emailPref(s.users.wa), 'nothing changed').toEqual(before);
  });

  test('S13: GET /api/notifications?kind=bogus -> 400 validation_error; real kinds filter', async () => {
    const s = S!;
    const owner = await apiAs(s.users.owner);
    const bad = await owner.get('/api/notifications?kind=bogus');
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.code).toBe('validation_error');
    const ok = await owner.get('/api/notifications?kind=tender_match');
    expect(ok.status()).toBe(200);
    expect((await ok.json()).items).toHaveLength(1);
    const none = await owner.get('/api/notifications?kind=digest');
    expect(none.status()).toBe(200);
    expect((await none.json()).items).toHaveLength(0);
  });

  // ───────────────────────── mobile ─────────────────────────
  test('S2 @mobile: bell popover at 375 px - badge, popover fits the viewport, links reachable, no horizontal overflow', async ({ page }) => {
    const s = S!;
    await login(page, s.users.analyst);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/dashboard');
    const b = page.getByRole('button', { name: 'Notifications, 1 unread' });
    await expect(b).toBeVisible();
    await b.click();
    const pop = page.getByRole('dialog');
    await expect(pop.getByText('1 new')).toBeVisible();
    await expect(pop.getByText(/^New match: Laptop - Notebook/)).toBeVisible();
    const box = (await pop.boundingBox())!;
    expect(box.x, 'popover left edge on screen').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'popover right edge on screen').toBeLessThanOrEqual(375);
    await expect(pop.getByRole('link', { name: 'View all' })).toBeInViewport();
    await expect(pop.getByRole('link', { name: 'Alert settings' })).toBeInViewport();
    const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
    expect(m.s, `horizontal overflow ${m.s} > ${m.w}`).toBeLessThanOrEqual(m.w);
    await shot(page, 'S2-mobile-bell-popover-375');
    await pop.getByRole('link', { name: 'View all' }).click();
    await expect(page).toHaveURL(/\/notifications$/);
    const m2 = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
    expect(m2.s).toBeLessThanOrEqual(m2.w);
    await shot(page, 'S2-mobile-notifications-375');
    await page.goto('/settings/notifications');
    await expect(page.getByRole('switch', { name: 'Email' })).toBeVisible();
    const m3 = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
    expect(m3.s).toBeLessThanOrEqual(m3.w);
    await shot(page, 'S2-mobile-settings-notifications-375');
  });

  // ───────────────────────── accessibility ─────────────────────────
  for (const scheme of ['light', 'dark'] as const) {
    test(`A11y ${scheme}: /notifications passes axe (WCAG 2.1 A/AA, serious/critical)`, async ({ page }) => {
      const s = S!;
      arrangeInbox(s);
      await login(page, s.users.manager);
      await page.goto('/notifications');
      await expect(page.locator('section[aria-labelledby^="day-"] ul > li').first()).toBeVisible();
      await setTheme(page, scheme);
      await expect(page.locator('section[aria-labelledby^="day-"] ul > li').first()).toBeVisible();
      await expect(page.getByLabel('Email not sent').first()).toBeVisible();
      await shot(page, `A11y-${scheme}-notifications`);
      await checkA11y(page);
    });
    test(`A11y ${scheme}: /settings/notifications passes axe (WCAG 2.1 A/AA, serious/critical)`, async ({ page }) => {
      const s = S!;
      await login(page, s.users.wa);
      await page.goto('/settings/notifications');
      await expect(page.getByRole('switch', { name: 'WhatsApp' })).toBeVisible();
      await setTheme(page, scheme);
      await expect(page.getByRole('switch', { name: 'WhatsApp' })).toBeVisible();
      await shot(page, `A11y-${scheme}-settings-notifications`);
      await checkA11y(page);
    });
  }
  for (const scheme of ['light', 'dark'] as const) {
    test(`A11y ${scheme}: bell popover open passes axe`, async ({ page }) => {
      const s = S!;
      await login(page, s.users.analyst);
      await page.goto('/dashboard');
      await setTheme(page, scheme);
      // analyst unsubscribed from email in S12b; the in-app item is still unread
      await page.getByRole('button', { name: /^Notifications/ }).click();
      await expect(page.getByRole('dialog').getByText('Notifications', { exact: true })).toBeVisible();
      await shot(page, `A11y-${scheme}-bell-popover`);
      await checkA11y(page);
    });
  }
});
