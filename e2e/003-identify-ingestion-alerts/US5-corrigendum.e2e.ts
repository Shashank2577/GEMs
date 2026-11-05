/**
 * 003 / US5 (#66) — Corrigendum & change tracking with clear change summaries. QA task T065.
 * Covers spec scenarios 1-9 and FR-050..FR-054.
 *
 * One org with six members (default prefs for owner/analyst/viewer, `em` instant email, `wa` instant email + WhatsApp,
 * `nip` in-app OFF + email) and an unrelated org Y that tracks nothing. Real manual syncs against mock-gem. The state
 * moves forward through the file in order (each mutation is its own test, the UI tests run in between):
 *   setup  sync #1 (36 recorded bids) -> watchlist (laptop, Maharashtra) -> analysis of 6421001 -> gemCorrigendum 6421001 +7d
 *          -> sync #2 (the corrigendum sync: tendersUpdated:1, tendersCreated:0)
 *   S1..S4, S7, S8   assertions + UI on that single sync
 *   S4b    sync #3 with no change -> no duplicate alerts (dedupe on content hash)
 *   S7b    gemCorrigendum 6421010 (+3d, quantity 90, EMD ₹3 L) -> sync #4 -> multi-field human summary in app/email
 *   S5     listing loses EMD / re-cased title only -> sync #5 -> no corrigendum, no alert, value kept
 *   S6     end date passes on an untracked bid -> status closed; POST /__admin/cancel/<bid> -> sync #6 -> `cancelled` event,
 *          "Cancelled on GeM" banner, alert on every channel
 * Syncs age earlier runs by 10 minutes first (like US3/US4) so the 2-minute manual-sync cooldown does not block.
 * E2E has only the log mailer (no RESEND_API_KEY), so emails are CAPTURED via GET /api/__test/mail (E2E_TEST_HOOKS=1)
 * and their delivery row ends `skipped`; "sent"/"failed"/retry need a real provider and are covered by apps/api/test.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { test, expect, evidence, collectRunArtifacts, checkA11y, mockGem, uniqueUser, noHorizontalOverflow } from '../support/fixtures';

const SPEC = '003', STORY = 'US5';
const BASE = `http://localhost:${process.env.E2E_PORT || 8788}`;
const DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
const WL = 'Laptops — Maharashtra';
const BID = 'GEM/2026/B/6421001';
const BID2 = 'GEM/2026/B/6421010';
const ENC = encodeURIComponent;

const sql = (q: string) => execFileSync('psql', [DB, '-qtAX', '-c', q], { encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const note = (type: string, description: string) => test.info().annotations.push({ type, description });
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Creds = { email: string; password: string; id: string; name: string };
type Who = 'owner' | 'analyst' | 'viewer' | 'em' | 'wa' | 'nip';
const WHO: Who[] = ['owner', 'analyst', 'viewer', 'em', 'wa', 'nip'];
type Saved = {
  users: Record<Who, Creds>; orgId: string; tenderId: string; tender2Id: string; closedBid: string; closedTenderId: string; yUser: Creds;
  oldEnd: string; newEnd: string; score: number | null; verdict: string | null; title: string;
  run2: Record<string, unknown>; title2: string; stage: string;
};
let S: Saved | undefined;
const STATE_FILE = `qa/.runs/${process.env.E2E_PORT || 8788}/us5-state.json`;
const save = () => writeFileSync(STATE_FILE, JSON.stringify(S));
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

/** POST /api/ingestion/run; ages earlier runs by 10 min first so the FR-013 2-min cooldown does not block. */
async function syncNow(req: APIRequestContext): Promise<Record<string, unknown>> {
  sql("update ingestion_runs set started_at = started_at - interval '10 minutes', finished_at = finished_at - interval '10 minutes' where finished_at is not null");
  for (let i = 0; i < 3; i++) {
    const res = await req.post('/api/ingestion/run', { data: { pages: 5 } });
    if (res.status() !== 429) { expect(res.status(), await res.text()).toBe(200); return res.json(); }
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

type Delivery = { channel: 'email' | 'whatsapp'; status: string; error: string | null };
type NDto = { id: string; kind: string; title: string; body: string; link: string | null; read: boolean; deliveries: Delivery[] };
const inbox = async (req: APIRequestContext, qs = ''): Promise<{ items: NDto[]; unreadCount: number; total: number }> => {
  const r = await req.get(`/api/notifications?pageSize=100${qs}`);
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
};
const count = (where: string) => Number(sql(`select count(*) from notifications where ${where}`));
const cnt = (kind: string, ch: string, who: Creds, tenderId?: string) =>
  count(`kind='${kind}' and channel='${ch}' and user_id='${who.id}'${tenderId ? ` and link='/tenders/${tenderId}'` : ''}`);
const events = (tenderId: string, kind?: string) =>
  sql(`select kind||'|'||changes::text from tender_events where tender_id='${tenderId}'${kind ? ` and kind='${kind}'` : ''} order by created_at`).split('\n').filter(Boolean);

/** Same IST formatting as the web app (apps/web/src/lib/format.ts formatDateIST with time). */
function ist(d: string | Date, withTime = true) {
  const date = new Date(d);
  const datePart = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  if (!withTime) return datePart;
  const timePart = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(date).toLowerCase();
  return `${datePart}, ${timePart} IST`;
}
/** Server-side "now closes <date>" uses day + short month (fmtIstDate); match loosely on the day and month. */
const closesRe = (d: string | Date) => {
  const t = new Date(new Date(d).getTime() + 330 * 60_000);
  return new RegExp(`now closes .*${t.getUTCDate()}.*${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()]}`);
};

const bell = (page: Page) => page.getByRole('button', { name: /^Notifications(, \d+ unread)?$/ });
const cards = (page: Page) => page.getByRole('list', { name: 'Tenders' }).locator('> li');

test.beforeEach(async () => {
  test.skip(/@mobile/.test(test.info().title) && test.info().project.name === 'desktop', 'covered by the mobile project');
  if (S || test.info().title.startsWith('setup')) return;
  S = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Saved;
});
test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

test.describe('US5 corrigendum', () => {
  test.setTimeout(240_000);

  test('setup: org + analysis of 6421001, gemCorrigendum +7d, ONE corrigendum sync -> tendersUpdated:1', async ({ page }) => {
    S = undefined; reqs.clear();
    await mockGem(page.request, '/__admin/reset');
    await mockGem(page.request, '/__admin/fail', { mode: 'off' });

    const ownerU = uniqueUser('owner');
    const own = await pwRequest.newContext({ baseURL: BASE });
    expect((await own.post('/api/auth/signup', { data: ownerU })).status()).toBe(201);
    const me = async (r: APIRequestContext) => (await (await r.get('/api/auth/me')).json()) as { user: { id: string } };
    const ownerMe = await me(own);
    const users = { owner: { email: ownerU.email, password: ownerU.password, id: ownerMe.user.id, name: ownerU.name } } as Record<Who, Creds>;
    const orgId = sql(`select org_id from memberships where user_id='${ownerMe.user.id}'`);

    const invite = async (who: Who, role: 'bid_manager' | 'analyst' | 'viewer') => {
      const u = uniqueUser(who);
      const inv = await own.post('/api/org/invitations', { data: { email: u.email, role } });
      expect(inv.status(), await inv.text()).toBe(201);
      const token = (await inv.json()).inviteUrl.split('/invite/')[1];
      const anon = await pwRequest.newContext({ baseURL: BASE });
      const acc = await anon.post('/api/auth/accept-invite', { data: { token, name: u.name, password: u.password } });
      expect(acc.status(), await acc.text()).toBe(200);
      users[who] = { email: u.email, password: u.password, id: (await me(anon)).user.id, name: u.name };
      return anon;
    };
    const ana = await invite('analyst', 'analyst');
    await (await invite('viewer', 'viewer')).dispose();
    const em = await invite('em', 'analyst');
    const wa = await invite('wa', 'analyst');
    const nip = await invite('nip', 'viewer');
    const prefs = (r: APIRequestContext, data: Record<string, unknown>) =>
      r.put('/api/me/notification-prefs', { data }).then(async (res) => { expect(res.status(), await res.text()).toBe(200); });
    await prefs(em, { inApp: true, email: true, whatsapp: false, frequency: 'instant', expiryReminders: true });
    expect((await wa.patch('/api/me', { data: { phone: '+919822012350' } })).status()).toBe(200);
    await prefs(wa, { inApp: true, email: true, whatsapp: true, frequency: 'instant', expiryReminders: true });
    await prefs(nip, { inApp: false, email: true, whatsapp: false, frequency: 'instant', expiryReminders: true });

    const yU = uniqueUser('orgy');
    const yReq = await pwRequest.newContext({ baseURL: BASE });
    expect((await yReq.post('/api/auth/signup', { data: yU })).status()).toBe(201);
    const yUser: Creds = { email: yU.email, password: yU.password, id: (await me(yReq)).user.id, name: yU.name };

    mkdirSync(STATE_FILE.replace(/\/[^/]+$/, ''), { recursive: true });

    // sync #1: the recorded bids, no watchlist yet -> no alerts
    const run1 = await syncNow(own);
    expect(run1).toMatchObject({ status: 'success', tendersCreated: 36 });
    expect(count('true')).toBe(0);
    const wlRes = await ana.post('/api/watchlists', { data: { name: WL, criteria: { keywords: ['laptop'], states: ['Maharashtra'] } } });
    expect(wlRes.status(), await wlRes.text()).toBe(201);
    expect(count('true'), 'a new watchlist back-fills silently').toBe(0);

    const tenderId = sql(`select id from tenders where bid_number='${BID}'`);
    const tender2Id = sql(`select id from tenders where bid_number='${BID2}'`);
    expect(sql(`select count(*) from tender_matches where tender_id='${tenderId}' and org_id='${orgId}'`), 'the bid is matched').toBe('1');
    // An open, untracked bid for the "end date passes -> closed" check (scenario 6)
    const closedBid = sql(`select bid_number from tenders t where status='open' and bid_number not in ('${BID}','${BID2}') and not exists (select 1 from tender_matches m where m.tender_id=t.id) order by bid_number limit 1`);
    const closedTenderId = sql(`select id from tenders where bid_number='${closedBid}'`);

    // The org's existing analysis of the bid
    const an = await ana.post(`/api/tenders/${tenderId}/analyse`);
    expect(an.status(), await an.text()).toBe(201);
    const analysis = await an.json();
    note('analysis', JSON.stringify({ score: analysis.score, verdict: analysis.verdict, status: analysis.status, stale: analysis.stale }));
    expect(analysis.stale, 'fresh analysis is not stale').toBe(false);
    const { endAt: oldEnd } = (await (await ana.get(`/api/tenders/${tenderId}`)).json()) as { endAt: string };

    // Corrigendum on mock-gem + the sync
    const mg = await mockGem(page.request, `/__admin/corrigendum/${ENC(BID)}`, { days: 7 });
    expect(mg.ok).toBe(true);
    const run2 = await syncNow(own);
    const t = (await (await ana.get(`/api/tenders/${tenderId}`)).json()) as { endAt: string; title: string };
    const title2 = sql(`select title from tenders where id='${tender2Id}'`);
    S = {
      users, orgId, tenderId, tender2Id, closedBid, closedTenderId, yUser, oldEnd, newEnd: t.endAt, score: analysis.score ?? null,
      verdict: analysis.verdict ?? null, title: t.title, run2, title2, stage: 'corrigendum-synced',
    };
    save();
    note('run', JSON.stringify(run2));
    expect(run2).toMatchObject({ status: 'success', tendersCreated: 0, tendersUpdated: 1 });
    for (const r of [own, ana, em, wa, nip, yReq]) await r.dispose();
  });

  // ───────────────────────── scenario 1 ─────────────────────────
  test('S1: gemCorrigendum +7d + sync -> tendersUpdated:1, tendersCreated:0; endAt exactly +7 days; ONE corrigendum event with changes={endAt:{from,to}}; match not duplicated', async () => {
    const s = S!;
    expect(s.run2).toMatchObject({ tendersCreated: 0, tendersUpdated: 1 });
    expect(Date.parse(s.newEnd) - Date.parse(s.oldEnd)).toBe(7 * 86_400_000);
    const ev = events(s.tenderId, 'corrigendum');
    expect(ev, 'exactly one corrigendum event').toHaveLength(1);
    const changes = JSON.parse(ev[0].split('|').slice(1).join('|')) as Record<string, { from: string; to: string }>;
    expect(Object.keys(changes)).toEqual(['endAt']);
    expect(Date.parse(changes.endAt.from)).toBe(Date.parse(s.oldEnd));
    expect(Date.parse(changes.endAt.to)).toBe(Date.parse(s.newEnd));
    expect(sql(`select count(*) from tender_matches where tender_id='${s.tenderId}'`), 'match not duplicated').toBe('1');
    expect(sql('select count(*) from tenders')).toBe('36');
    note('changes', JSON.stringify(changes));
  });

  // ───────────────────────── scenario 2 ─────────────────────────
  test('S2: the existing analysis is stale:true; feed card shows the score ring + "Re-check" and "Corrigendum" badges with their tooltips', async ({ page }) => {
    const s = S!;
    const api = await apiAs(s.users.analyst);
    const a = await (await api.get(`/api/tenders/${s.tenderId}/analysis`)).json();
    note('analysis', JSON.stringify({ score: a.score, verdict: a.verdict, stale: a.stale, staleReason: a.staleReason }));
    expect(a.stale).toBe(true);
    expect(sql(`select stale||'|'||coalesce(stale_reason,'') from analyses where tender_id='${s.tenderId}' and org_id='${s.orgId}' and status='done'`)).toBe('true|corrigendum');
    await login(page, s.users.analyst);
    await page.goto(`/tenders?q=${ENC(BID)}`);
    const card = cards(page).filter({ hasText: BID });
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('link', { name: /Eligibility score \d+ of 100/ })).toBeVisible();
    const recheck = card.getByText('Re-check', { exact: true });
    const corr = card.getByText('Corrigendum', { exact: true });
    await expect(recheck).toBeVisible();
    await expect(corr).toBeVisible();
    await recheck.hover();
    await expect(page.getByRole('tooltip').filter({ hasText: 'A corrigendum changed this bid after it was scored — re-run the analysis.' }).first()).toBeVisible();
    await shot(page, 'S2a-recheck-tooltip');
    // API: the feed item flag
    const feed = await (await api.get(`/api/tenders?q=${ENC(BID)}`)).json();
    expect(feed.items.find((i: { bidNumber: string }) => i.bidNumber === BID)).toMatchObject({ hasCorrigendum: true, analysis: { stale: true } });
  });

  test('S2b: hovering the "Corrigendum" badge on the feed card shows the tooltip "GeM published a corrigendum this week — dates or terms changed."', async ({ page }) => {
    const s = S!;
    await login(page, s.users.analyst);
    await page.goto(`/tenders?q=${ENC(BID)}`);
    const card = cards(page).filter({ hasText: BID });
    const corr = card.getByText('Corrigendum', { exact: true });
    await expect(corr).toBeVisible();
    // a real mouse move onto the badge (no actionability retry): the card's stretched title link must not swallow it
    const bb = (await corr.boundingBox())!;
    const top = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}.${(e.getAttribute('class') ?? '').slice(0, 60)}` : null; }, { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 });
    note('element-at-badge-centre', String(top));
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    const tip = page.getByRole('tooltip').filter({ hasText: 'GeM published a corrigendum this week — dates or terms changed.' }).first();
    await tip.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
    await shot(page, 'S2b-corrigendum-badge-hover');
    await expect(tip, `tooltip on the Corrigendum badge; topmost element at the badge centre is ${top}`).toBeVisible();
  });

  // ───────────────────────── scenario 3 ─────────────────────────
  test('S3: History tab - newest entry "Corrigendum issued" in a highlighted box with a "Re-check eligibility" badge and the old -> new end date in IST', async ({ page }) => {
    const s = S!;
    await login(page, s.users.analyst);
    await page.goto(`/tenders/${s.tenderId}`);
    await page.getByRole('tab', { name: /History/ }).click();
    const items = page.getByRole('list').locator('li').filter({ has: page.locator('span.font-semibold') });
    const newest = page.locator('ol.relative > li').first();
    await expect(newest.getByText('Corrigendum issued')).toBeVisible();
    await expect(newest.getByText('Re-check eligibility')).toBeVisible();
    await expect(newest.locator('div.border-warning\\/30')).toHaveCount(1); // the highlighted box
    await expect(newest.getByText('Closing date')).toBeVisible();
    await expect(newest.getByText(ist(s.oldEnd))).toBeVisible();
    await expect(newest.getByText(ist(s.newEnd))).toBeVisible();
    note('dates', `${ist(s.oldEnd)} -> ${ist(s.newEnd)}; items=${await items.count()}`);
    await shot(page, 'S3-history-corrigendum');
  });

  // ───────────────────────── scenario 4 + 8 ─────────────────────────
  test('S4: every member of the tracking org with in-app on gets ONE "Corrigendum: <title>" (kind corrigendum, link /tenders/<id>) with the "now closes … IST. Re-check the analysis before you bid." body; none without in-app, none for the other org', async ({ page }) => {
    const s = S!;
    for (const w of ['owner', 'analyst', 'viewer', 'em', 'wa'] as Who[]) {
      expect(cnt('corrigendum', 'in_app', s.users[w], s.tenderId), `${w} in-app`).toBe(1);
      const api = await apiAs(s.users[w]);
      const items = (await inbox(api, '&kind=corrigendum')).items.filter((i) => i.link === `/tenders/${s.tenderId}`);
      expect(items).toHaveLength(1);
      const n = items[0];
      expect(n.title).toBe(`Corrigendum: ${s.title}`.slice(0, 200));
      expect(n.body).toContain(`${BID} was amended on GeM`);
      expect(n.body).toMatch(closesRe(s.newEnd));
      expect(n.body).toContain('IST.');
      expect(n.body).toContain('Re-check the analysis before you bid.');
      expect(n.kind).toBe('corrigendum');
    }
    expect(cnt('corrigendum', 'in_app', s.users.nip, s.tenderId), 'in-app OFF member gets no in-app row').toBe(0);
    expect(count(`kind='corrigendum' and user_id='${s.yUser.id}'`), 'org Y does not track the bid').toBe(0);
    expect(count(`kind='deadline' and link='/tenders/${s.tenderId}'`), 'not the old `deadline` kind').toBe(0);
    note('body', (await inbox(await apiAs(s.users.owner), '&kind=corrigendum')).items[0].body);

    await login(page, s.users.analyst);
    await page.goto('/dashboard');
    const b = bell(page);
    await expect(b).toBeVisible();
    await expect(b).toBeVisible();
    await b.click();
    const pop = page.getByRole('dialog');
    const item = pop.getByRole('list', { name: 'Latest notifications' }).getByRole('listitem').filter({ hasText: 'Corrigendum:' }).first();
    await expect(item).toBeVisible();
    await expect(item.getByText(/was amended on GeM — now closes/)).toBeVisible();
    await expect(item).toContainText(`${BID} was amended on GeM`);
    await shot(page, 'S4-bell-corrigendum');
    await item.getByRole('button').click();
    await expect(page).toHaveURL(new RegExp(`/tenders/${s.tenderId}$`));
  });

  test('S8: kind is `corrigendum`: "Corrigendum" label + warning icon in the bell and /notifications; ?kind=corrigendum filters; ?kind=bogus -> 400', async ({ page }) => {
    const s = S!;
    const api = await apiAs(s.users.analyst);
    const only = await inbox(api, '&kind=corrigendum');
    expect(only.items.length).toBeGreaterThan(0);
    for (const i of only.items) expect(i.kind).toBe('corrigendum');
    expect((await api.get('/api/notifications?kind=bogus')).status()).toBe(400);
    await login(page, s.users.analyst);
    await page.goto('/notifications');
    const row = page.getByRole('button').filter({ hasText: 'Corrigendum:' }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText('Corrigendum', { exact: true })).toBeVisible(); // kind label
    await expect(row.locator('svg.lucide-triangle-alert, svg.lucide-alert-triangle').first()).toBeVisible(); // warning icon
    await shot(page, 'S8-notifications-corrigendum-label');
    await page.goto('/dashboard');
    await bell(page).click();
    await expect(page.getByRole('dialog').locator('svg.lucide-triangle-alert, svg.lucide-alert-triangle').first()).toBeVisible();
  });

  // ───────────────────────── scenario 7 ─────────────────────────
  test('S7: email/WhatsApp per prefs - instant email "A tracked GeM bid was amended" with the Changed section + List-Unsubscribe headers; WhatsApp queued/skipped per phone; nobody emailed twice', async ({ page }) => {
    const s = S!;
    const all = await capturedMail();
    const corrMail = (w: Who) => all.filter((m) => toList(m).includes(s.users[w].email) && m.subject.startsWith('Corrigendum:') && m.subject.includes(s.title.slice(0, 40)));
    for (const w of ['owner', 'analyst', 'viewer', 'em', 'wa', 'nip'] as Who[]) {
      const ms = corrMail(w);
      expect(ms, `${w} gets exactly one corrigendum email`).toHaveLength(1);
      expect(cnt('corrigendum', 'email', s.users[w], s.tenderId)).toBe(1);
      expect(ms[0].html).toContain('A tracked GeM bid was amended');
      expect(ms[0].html).toContain('Changed:');
      expect(ms[0].html).toContain('Bid end date');
      expect(ms[0].html).toContain('IST');
      expect(ms[0].html).toContain('Re-check this bid');
      expect(ms[0].headers?.['List-Unsubscribe']).toMatch(/^<.*\/api\/notifications\/unsubscribe\?token=[\w-]+\.[\w-]+>$/);
      expect(ms[0].headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    }
    // delivery rows: the log mailer cannot answer, so `skipped` - never left pending
    expect(count(`kind='corrigendum' and channel='email' and status in ('pending','failed') and link='/tenders/${s.tenderId}'`)).toBe(0);
    expect(count(`kind='corrigendum' and channel='email' and link='/tenders/${s.tenderId}' and status='skipped' and error='Email is not configured (RESEND_API_KEY)'`)).toBe(6);
    // WhatsApp only for the member who turned it on (with a phone)
    expect(cnt('corrigendum', 'whatsapp', s.users.wa, s.tenderId)).toBe(1);
    expect(count(`kind='corrigendum' and channel='whatsapp' and link='/tenders/${s.tenderId}'`)).toBe(1);
    expect(sql(`select status from notifications where kind='corrigendum' and channel='whatsapp' and user_id='${s.users.wa.id}'`)).toMatch(/skipped|sent/);
    expect(count(`kind='corrigendum' and channel='email' and user_id='${s.yUser.id}'`)).toBe(0);
    const ms = corrMail('owner')[0];
    note('email-subject', ms.subject);
    // render the captured email for the screenshot
    await page.setContent(ms.html);
    await shot(page, 'S7-corrigendum-email-rendered');
    // the in-app item shows the delivery chips
    await login(page, s.users.wa);
    await page.goto('/notifications');
    const row = page.getByRole('button').filter({ hasText: 'Corrigendum:' }).first();
    await expect(row.getByLabel(/^Email /)).toBeVisible();
    await expect(row.getByLabel(/^WhatsApp /)).toBeVisible();
    await shot(page, 'S7-delivery-chips');
  });

  // ───────────────────────── dedupe ─────────────────────────
  test('S4b: a second identical sync creates no duplicate (dedupe on content hash) - events, in-app, email and WhatsApp rows unchanged', async () => {
    const s = S!;
    const before = { n: count('true'), e: sql('select count(*) from tender_events'), mail: (await capturedMail()).length };
    const run = await syncNow(await apiAs(s.users.owner));
    note('run', JSON.stringify(run));
    expect(run).toMatchObject({ status: 'success', tendersCreated: 0, tendersUpdated: 0 });
    expect(count('true')).toBe(before.n);
    expect(sql('select count(*) from tender_events')).toBe(before.e);
    expect((await capturedMail()).length).toBe(before.mail);
    expect(events(s.tenderId, 'corrigendum')).toHaveLength(1);
    expect(count(`kind='corrigendum' and link='/tenders/${s.tenderId}'`)).toBe(5 + 6 + 1);
  });

  test('S7b: multi-field corrigendum (end +3d, quantity 90, EMD ₹3 L) -> in-app and email bodies list every changed field with IST dates and ₹', async ({ page }) => {
    const s = S!;
    const prev = sql(`select quantity||'|'||coalesce(emd_amount::text,'') from tenders where id='${s.tender2Id}'`);
    await mockGem(page.request, `/__admin/corrigendum/${ENC(BID2)}`, { days: 3, quantity: 90, emd: 300000 });
    const run = await syncNow(await apiAs(s.users.owner));
    note('run', JSON.stringify(run));
    expect(run).toMatchObject({ status: 'success', tendersCreated: 0, tendersUpdated: 1 });
    const ev = events(s.tender2Id, 'corrigendum');
    expect(ev).toHaveLength(1);
    const ch = JSON.parse(ev[0].split('|').slice(1).join('|')) as Record<string, { from: unknown; to: unknown }>;
    note('changes', `${JSON.stringify(ch)} (prev quantity|emd ${prev})`);
    expect(Object.keys(ch).sort()).toEqual(['emdAmount', 'endAt', 'quantity']);
    expect(ch.quantity.to).toBe(90);
    expect(ch.emdAmount.to).toBe(300000);
    const api = await apiAs(s.users.analyst);
    const n = (await inbox(api, '&kind=corrigendum')).items.find((i) => i.link === `/tenders/${s.tender2Id}`)!;
    expect(n, 'in-app alert for the second bid').toBeTruthy();
    expect(n.body).toMatch(/Changed: Bid end date: \d{1,2} \w{3}, \d{1,2}:\d{2} (am|pm) → \d{1,2} \w{3}, \d{1,2}:\d{2} (am|pm) IST · Quantity: [\d,]+ → 90 · EMD: .* → ₹3 L\./);
    note('body', n.body);
    const mail = (await capturedMail()).find((m) => toList(m).includes(s.users.em.email) && m.subject.includes(s.title2.slice(0, 40)) && m.subject.startsWith('Corrigendum:'))!;
    expect(mail.html).toContain('Changed:');
    expect(mail.html).toContain('Quantity: ');
    expect(mail.html).toContain('₹3 L');
    await login(page, s.users.analyst);
    await page.goto(`/tenders/${s.tender2Id}`);
    await page.getByRole('tab', { name: /History/ }).click();
    const newest = page.locator('ol.relative > li').first();
    await expect(newest.getByText('Corrigendum issued')).toBeVisible();
    await expect(newest.getByText('Quantity')).toBeVisible();
    await expect(newest.getByText('EMD')).toBeVisible();
    await shot(page, 'S7b-history-multi-field');
    await page.setContent(mail.html);
    await shot(page, 'S7b-email-changed-section');
  });

  // ───────────────────────── scenario 5 ─────────────────────────
  test('S5: a value that disappears from the listing (stored ePBG, listing has none) and a re-cased title create NO corrigendum and NO alert; the stored value is kept', async ({ page }) => {
    const s = S!;
    // The recorded listing of 6421001 carries no ePBG. Arrange the stored copy as if GeM once published 5 %, upper-case
    // the stored title (listing = same text, different case) and invalidate the content hash so the next sync diffs it.
    expect(sql(`select coalesce(epbg_percent::text,'') from tenders where id='${s.tenderId}'`)).toBe('');
    sql(`update tenders set epbg_percent = 5, title = upper(title), content_hash = 'qa-forced-rediff' where id='${s.tenderId}'`);
    const corrBefore = sql("select count(*) from tender_events where kind='corrigendum'");
    const nBefore = count('true');
    const mailBefore = (await capturedMail()).length;
    const run = await syncNow(await apiAs(s.users.owner));
    note('run', JSON.stringify(run));
    expect(run).toMatchObject({ status: 'success', tendersCreated: 0 });
    note('hash-after', sql(`select (content_hash <> 'qa-forced-rediff')::text from tenders where id='${s.tenderId}'`));
    expect(sql(`select (content_hash <> 'qa-forced-rediff')::text from tenders where id='${s.tenderId}'`), 'the sync re-diffed this bid').toBe('true');
    expect(sql(`select coalesce(epbg_percent::text,'') from tenders where id='${s.tenderId}'`), 'stored ePBG kept').toBe('5');
    expect(sql("select count(*) from tender_events where kind='corrigendum'"), 'no new corrigendum event').toBe(corrBefore);
    expect(count('true'), 'no new notification').toBe(nBefore);
    expect((await capturedMail()).length, 'no new email').toBe(mailBefore);
    note('events-of-bid', events(s.tenderId).join(' || '));
    note('title-after', sql(`select title from tenders where id='${s.tenderId}'`));
    await login(page, s.users.analyst);
    await page.goto(`/tenders/${s.tenderId}`);
    await page.getByRole('tab', { name: /History/ }).click();
    await expect(page.locator('ol.relative > li').filter({ hasText: 'Corrigendum issued' })).toHaveCount(1);
    await shot(page, 'S5-no-new-corrigendum');
  });

  // ───────────────────────── scenario 6 ─────────────────────────
  test('S6a: an open bid whose end date passes is set status:"closed" by the next sync', async ({ page }) => {
    const s = S!;
    expect(sql(`select status from tenders where id='${s.closedTenderId}'`)).toBe('open');
    // time passes: GeM's end date and the stored one are both in the past (GeM stops listing it as open)
    const past = new Date(Date.now() - 2 * 86_400_000);
    await mockGem(page.request, `/__admin/corrigendum/${ENC(s.closedBid)}`, { endAt: past.toISOString() });
    sql(`update tenders set end_at = '${past.toISOString()}' where id='${s.closedTenderId}'`);
    const run = await syncNow(await apiAs(s.users.owner));
    note('run', JSON.stringify(run));
    expect(sql(`select status from tenders where id='${s.closedTenderId}'`)).toBe('closed');
    const api = await apiAs(s.users.analyst);
    expect((await (await api.get(`/api/tenders/${s.closedTenderId}`)).json()).status).toBe('closed');
    await login(page, s.users.analyst);
    await page.goto(`/tenders/${s.closedTenderId}`);
    await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible();
    await shot(page, 'S6a-closed-tender');
  });

  test('S6b/S9: cancelled on GeM (POST /__admin/cancel) -> `cancelled` event, "Bid cancelled" in History, "Cancelled on GeM" banner, "Cancelled on GeM: <title>" alert on every chosen channel', async ({ page }) => {
    const s = S!;
    const cancelledBefore = events(s.tenderId, 'cancelled').length;
    expect(cancelledBefore).toBe(0);
    const r = await mockGem(page.request, `/__admin/cancel/${ENC(BID)}`);
    expect(r.cancelled).toBe(true);
    const run = await syncNow(await apiAs(s.users.owner));
    note('run', JSON.stringify(run));
    expect(run).toMatchObject({ status: 'success', tendersCreated: 0 });
    expect(sql(`select status from tenders where id='${s.tenderId}'`)).toBe('cancelled');
    expect(events(s.tenderId, 'cancelled'), 'one cancelled event').toHaveLength(1);

    const title = `Cancelled on GeM: ${s.title}`.slice(0, 200);
    for (const w of ['owner', 'analyst', 'viewer', 'em', 'wa'] as Who[]) {
      const api = await apiAs(s.users[w]);
      const hit = (await inbox(api)).items.filter((i) => i.title === title);
      expect(hit, `${w} in-app`).toHaveLength(1);
      expect(hit[0].link).toBe(`/tenders/${s.tenderId}`);
    }
    expect(count(`title='${title.replace(/'/g, "''")}' and channel='in_app' and user_id='${s.users.nip.id}'`)).toBe(0);
    expect(count(`title='${title.replace(/'/g, "''")}' and channel='email'`), 'one email per member').toBe(6);
    expect(count(`title='${title.replace(/'/g, "''")}' and channel='whatsapp'`)).toBe(1);
    expect(count(`title like 'Cancelled on GeM:%' and user_id='${s.yUser.id}'`)).toBe(0);
    const mails = (await capturedMail()).filter((m) => m.subject === title);
    expect(mails.length, 'cancellation emails sent').toBe(6);
    // idempotent: a repeat sync does not re-alert
    const nBefore = count("title like 'Cancelled on GeM:%'");
    await syncNow(await apiAs(s.users.owner));
    expect(count("title like 'Cancelled on GeM:%'")).toBe(nBefore);
    expect(events(s.tenderId, 'cancelled')).toHaveLength(1);

    await login(page, s.users.analyst);
    await page.goto(`/tenders/${s.tenderId}`);
    const banner = page.getByTestId('cancelled-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Cancelled on GeM');
    // round 2: the cancelled hero (location row beside the buyer) shows no closing countdown
    await expect(page.getByRole('heading', { level: 1 }).locator('xpath=ancestor::div[contains(@class,"min-w-0")][1]').getByText(/Closes in/)).toHaveCount(0);
    await shot(page, 'S6b-cancelled-banner');
    await page.getByRole('tab', { name: /History/ }).click();
    await expect(page.locator('ol.relative > li').first().getByText('Bid cancelled')).toBeVisible();
    await shot(page, 'S6b-history-bid-cancelled');
    await bell(page).click();
    await expect(page.getByRole('dialog').getByText(`Cancelled on GeM: ${s.title.slice(0, 30)}`).first()).toBeVisible();
    await shot(page, 'S9-bell-cancelled-alert');
    // the card/feed
    await page.keyboard.press('Escape');
    S!.stage = 'cancelled'; save();
  });

  // ───────────────────────── mobile ─────────────────────────
  test('S3 @mobile: History at 375 px - corrigendum + cancelled entries readable, no horizontal overflow; banner fits', async ({ page }) => {
    const s = S!;
    await login(page, s.users.analyst);
    await page.goto(`/tenders/${s.tenderId}`);
    await expect(page.getByTestId('cancelled-banner')).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, 'S3-mobile-cancelled-banner');
    await page.getByRole('tab', { name: /History/ }).click();
    const corrEntry = page.locator('ol.relative > li').filter({ hasText: 'Corrigendum issued' }).first();
    await expect(corrEntry).toBeVisible();
    await expect(corrEntry.getByText('Re-check eligibility')).toBeVisible();
    await expect(corrEntry.getByText(ist(s.newEnd))).toBeVisible();
    await expect(page.locator('ol.relative > li').first().getByText('Bid cancelled')).toBeVisible();
    const vp = page.viewportSize()!;
    expect(vp.width).toBeLessThanOrEqual(412);
    const box = await corrEntry.boundingBox();
    expect(box!.x + box!.width, 'entry inside the viewport').toBeLessThanOrEqual(vp.width + 1);
    await noHorizontalOverflow(page);
    await shot(page, 'S3-mobile-history-375');
  });

  test('S4 @mobile: bell popover with the "Corrigendum:" item fits at 375 px', async ({ page }) => {
    const s = S!;
    await login(page, s.users.analyst);
    await page.goto('/dashboard');
    await expect(bell(page)).toBeVisible();
    await bell(page).click();
    const pop = page.getByRole('dialog');
    await expect(pop.getByText(/Corrigendum:/).first()).toBeVisible();
    const box = (await pop.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    await noHorizontalOverflow(page);
    await shot(page, 'S4-mobile-bell-375');
  });

  // ───────────────────────── a11y ─────────────────────────
  for (const scheme of ['light', 'dark'] as const) {
    test(`A11y ${scheme}: tender detail with the Cancelled banner passes axe`, async ({ page }) => {
      const s = S!;
      await login(page, s.users.analyst);
      await page.goto(`/tenders/${s.tenderId}`);
      await expect(page.getByTestId('cancelled-banner')).toBeVisible();
      await setTheme(page, scheme);
      await expect(page.getByTestId('cancelled-banner')).toBeVisible();
      await shot(page, `A11y-${scheme}-cancelled-banner`);
      await checkA11y(page);
    });
    test(`A11y ${scheme}: tender History tab passes axe`, async ({ page }) => {
      const s = S!;
      await login(page, s.users.analyst);
      await page.goto(`/tenders/${s.tenderId}`);
      await setTheme(page, scheme);
      await page.getByRole('tab', { name: /History/ }).click();
      await expect(page.locator('ol.relative > li').filter({ hasText: 'Corrigendum issued' }).first()).toBeVisible();
      await shot(page, `A11y-${scheme}-history`);
      await checkA11y(page);
    });
  }
});
