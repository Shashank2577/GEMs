import { execFileSync } from 'node:child_process';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { request as pwRequest } from '@playwright/test';
import { test, expect, uniqueUser, evidence, collectRunArtifacts } from '../support/fixtures';

/**
 * 002 / US3 (#5): roles are enforced and organizations are isolated. One test (or small group) per acceptance
 * scenario 1-11; scenario numbers are in the test titles and evidence screenshots are named sc<N>-*.png.
 * The subject of each walkthrough is signed in on the `page` fixture (so its video is the evidence video);
 * the Owner and other members live in separate browser contexts (own cookie jars).
 */
const SPEC = '002';
const STORY = 'US3';
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, name);

function sql(q: string): string {
  return execFileSync('psql', [E2E_DB, '-qtAX', '-c', q], { encoding: 'utf8' }).trim();
}
/** Test-fixture SQL only: skip the onboarding wizard for the org(s) of `email`. */
function skipOnboarding(email: string) {
  sql(`update organizations set onboarding_state='{"basics":true}' where id in (select m.org_id from memberships m join users u on u.id=m.user_id where u.email='${email}')`);
}

const opened: BrowserContext[] = [];
test.afterEach(async () => { while (opened.length) await opened.pop()!.close().catch(() => {}); });

async function newCtx(browser: Browser, baseURL: string) {
  const u = test.info().project.use;
  const ctx = await browser.newContext({
    baseURL, locale: 'en-IN', timezoneId: 'Asia/Kolkata',
    viewport: u.viewport ?? undefined, userAgent: u.userAgent, isMobile: u.isMobile, hasTouch: u.hasTouch, deviceScaleFactor: u.deviceScaleFactor,
  });
  opened.push(ctx);
  return ctx;
}

type Role = 'owner' | 'bid_manager' | 'analyst' | 'viewer';
const tokenOf = (url: string) => url.split('/invite/')[1];

interface Org { ctx: BrowserContext; api: APIRequestContext; user: ReturnType<typeof uniqueUser>; me: any }

/** A brand-new org + Owner in its own context. */
async function newOrg(browser: Browser, baseURL: string, prefix = 'own'): Promise<Org> {
  const ctx = await newCtx(browser, baseURL);
  const user = uniqueUser(prefix);
  const res = await ctx.request.post('/api/auth/signup', { data: user });
  expect(res.status(), await res.text()).toBe(201);
  skipOnboarding(user.email);
  const me = await (await ctx.request.get('/api/auth/me')).json();
  return { ctx, api: ctx.request, user, me };
}

async function invite(owner: APIRequestContext, email: string, role: Role) {
  const res = await owner.post('/api/org/invitations', { data: { email, role } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; inviteUrl: string };
}

/** Invite a new user into the org of `owner` and accept the invite in `into` (its cookies are then the member's session). */
async function join(owner: APIRequestContext, into: BrowserContext, role: Role, name?: string) {
  const u = uniqueUser(role.replace('_', ''));
  if (name) u.name = name;
  const inv = await invite(owner, u.email, role);
  const res = await into.request.post('/api/auth/accept-invite', { data: { token: tokenOf(inv.inviteUrl), name: u.name, password: u.password } });
  expect(res.status(), await res.text()).toBe(200);
  skipOnboarding(u.email);
  const me = await (await into.request.get('/api/auth/me')).json();
  return { ...u, me, userId: me.user.id as string };
}

async function errOf(res: { status(): number; json(): Promise<any> }) {
  const j = await res.json().catch(() => ({}));
  return { status: res.status(), code: j?.error?.code as string | undefined, message: j?.error?.message as string | undefined };
}

/** Request with only a bearer token (no cookie jar). */
async function bearerFetch(baseURL: string, token: string, method: string, url: string) {
  const c = await pwRequest.newContext({ baseURL });
  try { return await c.fetch(url, { method, headers: { authorization: `Bearer ${token}` } }); } finally { await c.dispose(); }
}

const NEED_ANALYST = 'You need to be at least an Analyst to do that';
const NEED_BM = 'You need to be at least a Bid Manager to do that';
const OWNER_ONLY = 'Only an Owner can do that';

// ───────────────────────── Scenario 1 ─────────────────────────
test.describe('sc1 viewer', () => {
  test('sc1 Viewer: POST /api/watchlists, POST /api/vault, PUT /api/profile -> 403 forbidden "You need to be at least an Analyst to do that"', async ({ page, browser, baseURL }) => {
    const owner = await newOrg(browser, baseURL!);
    const v = await join(owner.api, page.context(), 'viewer');
    const reqs: [string, string, any][] = [
      ['POST', '/api/watchlists', { name: 'x', criteria: { keywords: ['laptop'] } }],
      ['PUT', '/api/profile', { legalName: 'Viewer Tampering Pvt Ltd' }],
      ['POST', '/api/vault', { type: 'gst', title: 'x' }],
    ];
    const seen: string[] = [];
    for (const [method, url, data] of reqs) {
      const res = await page.request.fetch(url, { method, data });
      const e = await errOf(res);
      seen.push(`${method} ${url} -> ${e.status} ${e.code} "${e.message}"`);
      expect(e, `${method} ${url}`).toEqual({ status: 403, code: 'forbidden', message: NEED_ANALYST });
    }
    // a read is still fine for the same session
    expect((await page.request.get('/api/watchlists')).status()).toBe(200);
    await page.goto('/watchlists');
    await expect(page.getByRole('heading', { name: 'Watchlists' }).first()).toBeVisible();
    await ev(page, 'sc1-viewer-api-403-context');
    test.info().annotations.push({ type: 'observed', description: seen.join(' | ') });
    void v;
  });
});

// ───────────────────────── Scenario 2 ─────────────────────────
test.describe('sc2 analyst', () => {
  test('sc2 Analyst: Bid Manager+ endpoints -> 403 "You need to be at least a Bid Manager to do that"; Analyst+ endpoint allowed', async ({ page, browser, baseURL }) => {
    const owner = await newOrg(browser, baseURL!);
    await join(owner.api, page.context(), 'analyst');
    const reqs: [string, string, any][] = [
      ['PATCH', '/api/org', { name: 'Hijacked' }],
      ['POST', '/api/org/invitations', { email: uniqueUser('z').email, role: 'viewer' }],
      ['PUT', '/api/scoring-weights', {}],
      ['POST', '/api/ingestion/run', {}],
      ['POST', '/api/demo/seed', {}],
      ['POST', '/api/analyses/00000000-0000-4000-8000-000000000000/override', { factorKey: 'turnover', status: 'pass', reason: 'analyst trying an override' }],
    ];
    for (const [method, url, data] of reqs) {
      const e = await errOf(await page.request.fetch(url, { method, data }));
      expect(e, `${method} ${url}`).toEqual({ status: 403, code: 'forbidden', message: NEED_BM });
    }
    // control: an Analyst+ endpoint succeeds
    const wl = await page.request.post('/api/watchlists', { data: { name: 'Analyst laptops', criteria: { keywords: ['laptop'] } } });
    expect(wl.status(), await wl.text()).toBe(201);
    await page.goto('/settings/organization');
    await expect(page.getByText('Only Bid Managers and Owners can rename the organization.')).toBeVisible();
    await ev(page, 'sc2-analyst-org-readonly');
  });
});

// ───────────────────────── Scenario 3 ─────────────────────────
test.describe('sc3 bid manager', () => {
  test('sc3 Bid Manager: PATCH/DELETE /api/org/members/:userId -> 403 "Only an Owner can do that"; Bid Manager endpoints allowed', async ({ page, browser, baseURL }) => {
    const owner = await newOrg(browser, baseURL!);
    const asha = await join(owner.api, await newCtx(browser, baseURL!), 'analyst', 'Asha Sharma');
    await join(owner.api, page.context(), 'bid_manager');
    const patch = await errOf(await page.request.patch(`/api/org/members/${asha.userId}`, { data: { role: 'viewer' } }));
    expect(patch).toEqual({ status: 403, code: 'forbidden', message: OWNER_ONLY });
    const del = await errOf(await page.request.delete(`/api/org/members/${asha.userId}`));
    expect(del).toEqual({ status: 403, code: 'forbidden', message: OWNER_ONLY });
    // Asha untouched
    const members = await (await owner.api.get('/api/org/members')).json();
    expect(members.items.find((m: any) => m.userId === asha.userId).role).toBe('analyst');
    // controls: Bid Manager+ endpoints work
    expect((await page.request.patch('/api/org', { data: { name: 'Renamed by BM' } })).status()).toBe(200);
    expect((await page.request.post('/api/org/invitations', { data: { email: uniqueUser('z').email, role: 'viewer' } })).status()).toBe(201);
    await page.goto('/settings/team');
    await expect(page.getByRole('button', { name: 'Invite teammate' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /^Role for / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    await ev(page, 'sc3-bid-manager-team-no-owner-actions');
  });
});

// ───────────────────────── Scenario 4 ─────────────────────────
test.describe('sc4 last owner', () => {
  test('sc4 Sole Owner demoted/removed (self) -> 409 last_owner with the exact messages; unchanged', async ({ page, browser, baseURL }) => {
    const owner = await newOrg(browser, baseURL!);
    await page.context().addCookies(await owner.ctx.cookies());
    const ownerId = owner.me.user.id as string;
    const demote = await errOf(await page.request.patch(`/api/org/members/${ownerId}`, { data: { role: 'bid_manager' } }));
    expect(demote).toEqual({ status: 409, code: 'last_owner', message: 'An organization needs at least one Owner. Make someone else an Owner first.' });
    const remove = await errOf(await page.request.delete(`/api/org/members/${ownerId}`));
    expect(remove).toEqual({ status: 409, code: 'last_owner', message: 'You cannot remove the last Owner of the organization.' });
    const members = await (await page.request.get('/api/org/members')).json();
    expect(members.items).toHaveLength(1);
    expect(members.items[0].role).toBe('owner');
    await page.goto('/settings/team');
    await expect(page.getByText('(you)').first()).toBeVisible();
    await ev(page, 'sc4-sole-owner-intact');

    // With a second Owner the first can be demoted ("by themselves or another owner request" only blocked when last)
    const second = await join(page.request, await newCtx(browser, baseURL!), 'owner', 'Second Owner');
    expect((await page.request.patch(`/api/org/members/${ownerId}`, { data: { role: 'bid_manager' } })).status()).toBe(200);
    // now `second` is the last owner: demoting them (by themselves) is 409 again
    const secondCtx = await newCtx(browser, baseURL!);
    const login = await secondCtx.request.post('/api/auth/login', { data: { email: second.email, password: second.password } });
    expect(login.status(), await login.text()).toBe(200);
    const again = await errOf(await secondCtx.request.patch(`/api/org/members/${second.userId}`, { data: { role: 'analyst' } }));
    expect(again).toMatchObject({ status: 409, code: 'last_owner' });
    // and another owner request (the demoted first owner is BM now, so use a restored owner) - covered by API tests in api-tests.txt
  });
});

// ───────────────────────── Scenario 5 + 9 ─────────────────────────
test.describe('sc5 role change live', () => {
  test('sc5 Owner changes Asha Analyst -> Bid Manager in the row select: PATCH returns member, toast, Asha\'s next request uses new role (no re-login)', async ({ page, browser, baseURL }) => {
    const owner = await newOrg(browser, baseURL!);
    await page.context().addCookies(await owner.ctx.cookies());
    const ashaCtx = await newCtx(browser, baseURL!);
    const asha = await join(owner.api, ashaCtx, 'analyst', 'Asha Sharma');
    // Asha is an Analyst: a Bid Manager call is refused
    expect(await errOf(await ashaCtx.request.post('/api/ingestion/run', { data: {} }))).toMatchObject({ status: 403, message: NEED_BM });

    await page.goto('/settings/team');
    const select = page.getByRole('combobox', { name: 'Role for Asha Sharma' });
    await expect(select).toContainText('Analyst');
    await ev(page, 'sc5-before-role-change');
    await select.click();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/org/members/${asha.userId}`) && r.request().method() === 'PATCH'),
      page.getByRole('option', { name: 'Bid manager' }).click(),
    ]);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ userId: asha.userId, role: 'bid_manager', name: 'Asha Sharma', email: asha.email });
    // spec copy is "Asha is now Bid Manager"; the product label is "Bid manager" (ROLE_LABEL) - assert case-insensitively and record the casing
    const toast = page.getByText(/Asha Sharma is now Bid manager/i);
    await expect(toast).toBeVisible();
    test.info().annotations.push({ type: 'observed-toast', description: (await toast.first().innerText()).trim() });
    await expect(select).toContainText('Bid manager');
    await ev(page, 'sc5-after-role-change-toast');
    // Asha's very next request, same cookie jar, new role
    const now = await (await ashaCtx.request.get('/api/auth/me')).json();
    expect(now.role).toBe('bid_manager');
    const sync = await ashaCtx.request.post('/api/ingestion/run', { data: {} });
    expect(sync.status(), 'BM call now evaluated with the new role').not.toBe(403);
    const act = await (await owner.api.get('/api/activity?pageSize=50')).json();
    expect(JSON.stringify(act)).toContain('member.role_changed');
  });

  test('sc9 (gap) role lowered while the page is open: mutation 403 -> toast with server message + /api/auth/me refetch hides the action', async ({ page, browser, baseURL }) => {
    const owner = await newOrg(browser, baseURL!);
    const bm = await join(owner.api, page.context(), 'bid_manager', 'Bina Manager');
    // 008/FR-026: "Sync now" is disabled during the platform-wide 10-minute manual-sync cooldown, and the earlier
    // sc5 test in this file runs a manual sync. Age every finished run so this test does not depend on test order.
    sql("update ingestion_runs set started_at = started_at - interval '10 minutes', finished_at = finished_at - interval '10 minutes' where finished_at is not null");
    await page.goto('/settings/sync');
    const syncNow = page.getByRole('button', { name: 'Sync now' });
    await expect(syncNow).toBeVisible();
    await ev(page, 'sc9-bid-manager-sees-sync-now');
    // Owner lowers the role behind her back
    const lower = await owner.api.patch(`/api/org/members/${bm.userId}`, { data: { role: 'viewer' } });
    expect(lower.status(), await lower.text()).toBe(200);
    // her page still shows the button (stale); clicking sends the mutation, which is refused
    await expect(syncNow).toBeVisible();
    const meCalls: string[] = [];
    page.on('request', (r) => { if (r.url().endsWith('/api/auth/me')) meCalls.push(r.method()); });
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/ingestion/run') && r.request().method() === 'POST'),
      syncNow.click(),
    ]);
    expect(await errOf(res)).toEqual({ status: 403, code: 'forbidden', message: NEED_BM });
    // toast shows the server message (once), UI refetched /auth/me and hides the action
    const toasts = page.locator('[data-sonner-toast]').filter({ hasText: NEED_BM });
    await expect(toasts).toHaveCount(1);
    await expect(toasts.first()).toBeVisible();
    await page.waitForTimeout(600); // let the toast finish its enter animation for the screenshot
    await expect(toasts).toHaveCount(1);
    await ev(page, 'sc9-forbidden-toast');
    await expect(page.getByRole('button', { name: 'Sync now' })).toHaveCount(0);
    expect(meCalls.length, 'GET /api/auth/me refetched after the 403').toBeGreaterThan(0);
    await expect(page.getByText('View-only access')).toBeVisible();
    await ev(page, 'sc9-action-hidden-after-refetch');
  });
});

// ───────────────────────── Scenario 6 ─────────────────────────
test.describe('sc6 remove member', () => {
  test('sc6 Owner removes Asha via trash icon + "Remove member": toast, membership+tokens deleted, Asha 403 no_organization, activity kept', async ({ page, browser, baseURL }) => {
    const owner = await newOrg(browser, baseURL!);
    await page.context().addCookies(await owner.ctx.cookies());
    const ashaCtx = await newCtx(browser, baseURL!);
    const asha = await join(owner.api, ashaCtx, 'analyst', 'Asha Sharma');
    // Asha creates a token and does something that lands in the activity log
    const tok = await ashaCtx.request.post('/api/me/api-tokens', { data: { name: 'Asha extension' } });
    expect(tok.status(), await tok.text()).toBe(201);
    const bearer = (await tok.json()).token as string;
    expect((await ashaCtx.request.post('/api/watchlists', { data: { name: 'Asha list', criteria: { keywords: ['ups'] } } })).status()).toBe(201);
    expect((await bearerFetch(baseURL!, bearer, 'GET', '/api/watchlists')).status()).toBe(200);
    expect(Number(sql(`select count(*) from api_tokens where user_id='${asha.userId}'`))).toBe(1);

    await page.goto('/settings/team');
    await page.getByRole('button', { name: 'Remove Asha Sharma' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Remove Asha Sharma?' })).toBeVisible();
    await ev(page, 'sc6-remove-dialog');
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/org/members/${asha.userId}`) && r.request().method() === 'DELETE'),
      page.getByRole('button', { name: 'Remove member' }).click(),
    ]);
    expect(res.status()).toBe(200);
    await expect(page.getByText('Asha Sharma was removed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove Asha Sharma' })).toHaveCount(0);
    await ev(page, 'sc6-removed-toast');
    expect(Number(sql(`select count(*) from memberships where user_id='${asha.userId}'`))).toBe(0);
    expect(Number(sql(`select count(*) from api_tokens where user_id='${asha.userId}'`))).toBe(0);
    // Asha's next request: 403 no_organization (she has no other org); her old token is dead too
    expect(await errOf(await ashaCtx.request.get('/api/watchlists'))).toMatchObject({ status: 403, code: 'no_organization' });
    const viaToken = await bearerFetch(baseURL!, bearer, 'GET', '/api/watchlists');
    expect([401, 403]).toContain(viaToken.status());
    // history stays
    const act = await (await owner.api.get('/api/activity?pageSize=50')).json();
    const actions = (act.items as any[]).map((a) => `${a.action}:${a.userId ?? a.user?.id ?? ''}`);
    expect(actions.some((a) => a.startsWith('watchlist.created') && a.endsWith(asha.userId)), JSON.stringify(actions)).toBe(true);
    expect(actions.some((a) => a.startsWith('member.removed'))).toBe(true);
  });

  test('sc6b removed user with another org falls back to it', async ({ page, browser, baseURL }) => {
    const ownerA = await newOrg(browser, baseURL!, 'orga');
    const ownerB = await newOrg(browser, baseURL!, 'orgb');
    // Asha: own org B owner? no - make her an Analyst in A and a Viewer in B by accepting both invites with one session
    const ashaCtx = page.context();
    const asha = await join(ownerA.api, ashaCtx, 'analyst', 'Asha Sharma');
    const inv = await invite(ownerB.api, asha.email, 'viewer');
    const acc = await ashaCtx.request.post('/api/auth/accept-invite', { data: { token: tokenOf(inv.inviteUrl) } });
    expect(acc.status(), await acc.text()).toBe(200);
    // active org is now B (or A); switch to A and remove her from A
    const me = await (await ashaCtx.request.get('/api/auth/me')).json();
    expect(me.orgs).toHaveLength(2);
    const del = await ownerA.api.delete(`/api/org/members/${asha.userId}`);
    expect(del.status()).toBe(200);
    const after = await ashaCtx.request.get('/api/auth/me');
    expect(after.status()).toBe(200);
    const m2 = await after.json();
    expect(m2.orgs.map((o: any) => o.id)).toEqual([ownerB.me.org.id]);
    expect(m2.org.id).toBe(ownerB.me.org.id);
    await page.goto('/dashboard');
    await expect(page.getByText('View-only access')).toBeVisible();
    await ev(page, 'sc6b-fell-back-to-next-org');
  });
});

// ───────────────────────── Scenario 7 ─────────────────────────
test.describe('sc7 isolation', () => {
  test('sc7 Org B member requests org A\'s resources by id -> 404 not_found; nothing in A modified; lists never include A rows', async ({ browser, baseURL }) => {
    const A = await newOrg(browser, baseURL!, 'orga');
    const B = await newOrg(browser, baseURL!, 'orgb');
    const asha = await join(A.api, await newCtx(browser, baseURL!), 'analyst', 'Asha A');
    const pending = await invite(A.api, uniqueUser('p').email, 'viewer');
    const wl = await A.api.post('/api/watchlists', { data: { name: 'A laptops', criteria: { keywords: ['laptop'] } } });
    expect(wl.status(), await wl.text()).toBe(201);
    const wlId = (await wl.json()).id as string;
    const tok = await A.api.post('/api/me/api-tokens', { data: { name: 'A token' } });
    const tokId = (await tok.json()).id as string;
    const seed = await A.api.post('/api/demo/seed');
    expect(seed.ok(), await seed.text()).toBeTruthy();
    const ws = (await (await A.api.get('/api/workspaces')).json()).items as any[];
    expect(ws.length).toBeGreaterThan(0);
    const wsId = ws[0].id as string;
    const tenderId = ws[0].tender.id as string;
    const vaultItems = (await (await A.api.get('/api/vault')).json()).items as any[];
    const vaultId = vaultItems[0]?.id as string | undefined;

    const attempts: [string, string, string, any?][] = [
      ['member role', 'PATCH', `/api/org/members/${asha.userId}`, { role: 'viewer' }],
      ['member remove', 'DELETE', `/api/org/members/${asha.userId}`],
      ['invitation revoke', 'DELETE', `/api/org/invitations/${pending.id}`],
      ['invitation resend', 'POST', `/api/org/invitations/${pending.id}/resend`],
      ['watchlist update', 'PATCH', `/api/watchlists/${wlId}`, { name: 'B renamed' }],
      ['watchlist delete', 'DELETE', `/api/watchlists/${wlId}`],
      ['api token revoke', 'DELETE', `/api/me/api-tokens/${tokId}`],
      ['workspace read', 'GET', `/api/workspaces/${wsId}`],
      ['workspace update', 'PATCH', `/api/workspaces/${wsId}`, { stage: 'dropped' }],
      ['workspace comments', 'GET', `/api/workspaces/${wsId}/comments`],
      ['workspace packets', 'GET', `/api/workspaces/${wsId}/packets`],
      ['tender analysis', 'GET', `/api/tenders/${tenderId}/analysis`],
      ['assist payload', 'GET', `/api/assist/${wsId}`],
      ...(vaultId ? [['vault read', 'GET', `/api/vault/${vaultId}`], ['vault download', 'GET', `/api/vault/${vaultId}/download`], ['vault delete', 'DELETE', `/api/vault/${vaultId}`]] as [string, string, string][] : []),
    ];
    const rows: string[] = [];
    for (const [label, method, url, data] of attempts) {
      const res = await B.api.fetch(url, { method, data });
      const e = await errOf(res);
      rows.push(`${label}: ${method} ${url} -> ${e.status} ${e.code}`);
      expect(e, `${label} ${method} ${url}`).toMatchObject({ status: 404, code: 'not_found' });
    }
    // B's collection views contain nothing of A
    const bMembers = await (await B.api.get('/api/org/members')).json();
    expect(JSON.stringify(bMembers)).not.toContain(asha.email);
    expect(JSON.stringify(bMembers)).not.toContain(pending.id);
    expect((await (await B.api.get('/api/watchlists')).json()).items).toEqual([]);
    expect((await (await B.api.get('/api/workspaces')).json()).items).toEqual([]);
    expect((await (await B.api.get('/api/me/api-tokens')).json()).items).toEqual([]);
    expect(JSON.stringify(await (await B.api.get('/api/activity?pageSize=100')).json())).not.toContain(asha.userId);
    expect(JSON.stringify(await (await B.api.get('/api/notifications')).json())).not.toContain(wsId);
    // A unchanged
    const aMembers = await (await A.api.get('/api/org/members')).json();
    expect(aMembers.items.find((m: any) => m.userId === asha.userId).role).toBe('analyst');
    expect(aMembers.invitations.map((i: any) => i.id)).toContain(pending.id);
    const aWl = (await (await A.api.get('/api/watchlists')).json()).items as any[];
    expect(aWl.find((w) => w.id === wlId)?.name).toBe('A laptops');
    expect((await (await A.api.get('/api/me/api-tokens')).json()).items.map((t: any) => t.id)).toContain(tokId);
    expect((await (await A.api.get(`/api/workspaces/${wsId}`)).json()).stage).not.toBe('dropped');
    // a UI view of the same: B opening A's workspace route shows not found, not data
    const bPage = await B.ctx.newPage();
    await bPage.goto(`/workspaces/${wsId}`);
    await expect(bPage.getByText(/not found|couldn.t find|doesn.t exist/i).first()).toBeVisible();
    await ev(bPage, 'sc7-org-b-opens-org-a-workspace');
    await test.info().attach('sc7-cross-org-matrix.txt', { body: rows.join('\n'), contentType: 'text/plain' });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync('qa/evidence/002/US3', { recursive: true });
    writeFileSync('qa/evidence/002/US3/sc7-cross-org-matrix.txt', rows.join('\n') + '\n');
  });
});

// ───────────────────────── Scenario 8 ─────────────────────────
test.describe('sc8 viewer UI', () => {
  test('sc8 Viewer browses: "View-only access" card, write actions not rendered, read-only forms explain why', async ({ page, browser, baseURL }) => {
    const owner = await newOrg(browser, baseURL!);
    expect((await owner.api.post('/api/demo/seed')).ok()).toBeTruthy();
    await join(owner.api, page.context(), 'viewer', 'Vik Viewer');
    await page.goto('/dashboard');
    await expect(page.getByText('View-only access')).toBeVisible();
    await ev(page, 'sc8-dashboard-view-only-card');

    await page.goto('/watchlists');
    await expect(page.getByRole('heading', { name: 'Watchlists' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /New watchlist|Build a watchlist|Create watchlist/ })).toHaveCount(0);
    await ev(page, 'sc8-watchlists-no-create');

    await page.goto('/vault');
    await expect(page.getByRole('heading', { name: 'Document vault' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload document' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More vault actions' })).toHaveCount(0);
    await ev(page, 'sc8-vault-no-upload');

    await page.goto('/settings/team');
    await expect(page.getByRole('heading', { name: 'Team & roles' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite teammate' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /^Role for / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Revoke|Resend)$/ })).toHaveCount(0);
    await ev(page, 'sc8-team-no-invite-selects-trash');

    await page.goto('/settings/scoring');
    await expect(page.getByText('Only Bid Managers and Owners can change scoring weights.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save weights' })).toHaveCount(0);
    await ev(page, 'sc8-scoring-explained');

    await page.goto('/settings/sync');
    await expect(page.getByRole('heading', { name: 'Ingestion runs' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sync now/ })).toHaveCount(0);
    await ev(page, 'sc8-sync-no-sync-now');

    await page.goto('/settings/organization');
    await expect(page.getByText('Only Bid Managers and Owners can rename the organization.')).toBeVisible();
    await expect(page.getByLabel('Organization name')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await ev(page, 'sc8-org-rename-explained');

    await page.goto('/profile');
    await expect(page.getByText('You have view-only access. Ask an owner or bid manager to make changes.')).toBeVisible();
    await ev(page, 'sc8-profile-view-only');
  });

  test('sc8b Analyst and Bid Manager walkthroughs: action visibility differs by role', async ({ page, browser, baseURL }) => {
    const owner = await newOrg(browser, baseURL!);
    // Analyst on `page`
    await join(owner.api, page.context(), 'analyst', 'Ana Analyst');
    await page.goto('/watchlists');
    await expect(page.getByRole('button', { name: /New watchlist|Build a watchlist/ }).first()).toBeVisible();
    await ev(page, 'sc8b-analyst-watchlists-can-create');
    await page.goto('/vault');
    await expect(page.getByRole('button', { name: 'Upload document' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'More vault actions' })).toHaveCount(0);
    await ev(page, 'sc8b-analyst-vault-upload-no-reminders');
    await page.goto('/settings/team');
    await expect(page.getByRole('button', { name: 'Invite teammate' })).toHaveCount(0);
    await page.goto('/settings/sync');
    await expect(page.getByRole('button', { name: /Sync now/ })).toHaveCount(0);
    await expect(page.getByText('View-only access')).toHaveCount(0);

    // Bid Manager
    const bmCtx = await newCtx(browser, baseURL!);
    await join(owner.api, bmCtx, 'bid_manager', 'Bina Manager');
    const bm = await bmCtx.newPage();
    await bm.goto('/settings/sync');
    await expect(bm.getByRole('button', { name: /Sync now/ })).toBeVisible();
    await bm.goto('/settings/scoring');
    await expect(bm.getByRole('button', { name: 'Save weights' })).toBeVisible();
    await bm.goto('/settings/team');
    await expect(bm.getByRole('button', { name: 'Invite teammate' })).toBeVisible();
    await ev(bm, 'sc8b-bid-manager-team-invite-yes-roles-no');

    // Owner
    const op = await owner.ctx.newPage();
    await op.goto('/settings/team');
    await expect(op.getByRole('button', { name: 'Invite teammate' })).toBeVisible();
    await expect(op.getByRole('combobox', { name: 'Role for Ana Analyst' })).toBeVisible();
    await expect(op.getByRole('button', { name: 'Remove Ana Analyst' })).toBeVisible();
    await ev(op, 'sc8b-owner-team-all-actions');
  });
});

// ───────────────────────── Scenario 10 ─────────────────────────
test.describe('sc10 leave organization', () => {
  test('sc10a non-last Owner leaves with another org: DELETE /api/org/members/me, tokens deleted, switched to next org', async ({ page, browser, baseURL }) => {
    const A = await newOrg(browser, baseURL!, 'orga');
    const B = await newOrg(browser, baseURL!, 'orgb');
    // Priya: Owner of A (second owner) and Analyst of B
    const priya = await join(A.api, page.context(), 'owner', 'Priya Owner');
    const inv = await invite(B.api, priya.email, 'analyst');
    expect((await page.request.post('/api/auth/accept-invite', { data: { token: tokenOf(inv.inviteUrl) } })).status()).toBe(200);
    const sw = await page.request.post('/api/auth/switch-org', { data: { orgId: A.me.org.id } });
    expect(sw.status(), await sw.text()).toBe(200);
    expect((await page.request.post('/api/me/api-tokens', { data: { name: 'Priya A token' } })).status()).toBe(201);
    expect(Number(sql(`select count(*) from api_tokens where user_id='${priya.userId}' and org_id='${A.me.org.id}'`))).toBe(1);

    await page.goto('/settings/team');
    await expect(page.getByRole('heading', { name: 'Leave organization' })).toBeVisible();
    await ev(page, 'sc10a-leave-panel');
    await page.getByRole('button', { name: 'Leave organization' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: `Leave ${A.me.org.name}?` })).toBeVisible();
    await ev(page, 'sc10a-leave-dialog');
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/org/members/me') && r.request().method() === 'DELETE'),
      page.getByRole('dialog').getByRole('button', { name: 'Leave organization' }).click(),
    ]);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, nextOrgId: B.me.org.id });
    await expect(page.getByText(`You left ${A.me.org.name}.`)).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard$/);
    await ev(page, 'sc10a-switched-to-next-org');
    const me = await (await page.request.get('/api/auth/me')).json();
    expect(me.org.id).toBe(B.me.org.id);
    expect(me.role).toBe('analyst');
    expect(Number(sql(`select count(*) from memberships where user_id='${priya.userId}' and org_id='${A.me.org.id}'`))).toBe(0);
    expect(Number(sql(`select count(*) from api_tokens where user_id='${priya.userId}' and org_id='${A.me.org.id}'`))).toBe(0);
    const members = await (await A.api.get('/api/org/members')).json();
    expect(members.items.map((m: any) => m.userId)).not.toContain(priya.userId);
    const act = await (await A.api.get('/api/activity?pageSize=50')).json();
    expect(JSON.stringify(act)).toContain('member.left');
  });

  test('sc10b only-org member leaves: signed out to /login with "You left <Org>."', async ({ page, browser, baseURL }) => {
    const A = await newOrg(browser, baseURL!, 'orga');
    await join(A.api, page.context(), 'analyst', 'Asha Sharma');
    await page.goto('/settings/team');
    await page.getByRole('button', { name: 'Leave organization' }).click();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/org/members/me') && r.request().method() === 'DELETE'),
      page.getByRole('dialog').getByRole('button', { name: 'Leave organization' }).click(),
    ]);
    expect(res.status()).toBe(200);
    expect((await res.json()).nextOrgId).toBeNull();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(`You left ${A.me.org.name}.`)).toBeVisible();
    await ev(page, 'sc10b-left-signed-out');
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  });

  test('sc10c last Owner: DELETE /api/org/members/me -> 409 last_owner; UI warns and refuses', async ({ page, browser, baseURL }) => {
    const A = await newOrg(browser, baseURL!, 'orga');
    await page.context().addCookies(await A.ctx.cookies());
    await page.goto('/settings/team');
    await expect(page.getByText(`You are the only Owner of ${A.me.org.name}. Make someone else an Owner before you leave.`)).toBeVisible();
    await ev(page, 'sc10c-sole-owner-warning');
    await page.getByRole('button', { name: 'Leave organization' }).click();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/org/members/me') && r.request().method() === 'DELETE'),
      page.getByRole('dialog').getByRole('button', { name: 'Leave organization' }).click(),
    ]);
    expect(await errOf(res)).toMatchObject({ status: 409, code: 'last_owner' });
    await expect(page.getByText('You are the last Owner of this organization. Make someone else an Owner before you leave.').first()).toBeVisible();
    await ev(page, 'sc10c-last-owner-409-toast');
    expect(Number(sql(`select count(*) from memberships where user_id='${A.me.user.id}'`))).toBe(1);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

// ───────────────────────── Scenario 11 ─────────────────────────
test.describe('sc11 origin check', () => {
  test('sc11 cookie-authenticated mutation with foreign Origin -> 403 bad_origin before any handler; same Origin / no Origin / GET / Bearer pass', async ({ page, browser, baseURL }) => {
    const owner = await newOrg(browser, baseURL!);
    await page.context().addCookies(await owner.ctx.cookies());
    const before = (await (await page.request.get('/api/org')).json()).name as string;

    const evil = await page.request.patch('/api/org', { data: { name: 'Hacked by evil' }, headers: { origin: 'https://evil.example' } });
    const e = await errOf(evil);
    expect(e).toMatchObject({ status: 403, code: 'bad_origin' });
    expect((await (await page.request.get('/api/org')).json()).name, 'handler never ran').toBe(before);
    // also before validation/auth-role handlers: invalid body + foreign origin is still bad_origin, not 400
    const evil2 = await errOf(await page.request.post('/api/org/invitations', { data: {}, headers: { origin: 'https://evil.example' } }));
    expect(evil2).toMatchObject({ status: 403, code: 'bad_origin' });
    // a lookalike origin
    const evil3 = await errOf(await page.request.patch('/api/org', { data: { name: 'x' }, headers: { origin: `${baseURL}.evil.example` } }));
    expect(evil3.code).toBe('bad_origin');

    // round 2: no Origin + Sec-Fetch-Site: cross-site (cookie) -> 403 bad_origin; handler never ran
    const xsite = await page.request.patch('/api/org', { data: { name: 'Hacked cross-site' }, headers: { 'sec-fetch-site': 'cross-site' } });
    const xs = await errOf(xsite);
    expect(xs).toMatchObject({ status: 403, code: 'bad_origin' });
    const xsitePost = await errOf(await page.request.post('/api/org/invitations', { data: {}, headers: { 'sec-fetch-site': 'cross-site' } }));
    expect(xsitePost).toMatchObject({ status: 403, code: 'bad_origin' });
    expect((await (await page.request.get('/api/org')).json()).name, 'handler never ran (cross-site)').toBe(before);
    // OPTIONS is no longer exempt but carries no cookie in browsers; with a cookie + foreign origin it is rejected too
    const opt = await page.request.fetch('/api/org', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(opt.status(), 'OPTIONS with cookie + foreign Origin is not exempt').toBe(403);
    // same-origin form-like POST (browser sends Origin on form POST; Sec-Fetch-Site same-origin) still works
    const form = await page.request.post('/api/me/api-tokens', {
      headers: { origin: baseURL!, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, data: 'name=form-token',
    });
    const formStatus = form.status();
    expect(formStatus, 'same-origin form-like POST is not blocked by the Origin check').not.toBe(403);
    // and same-origin with no Origin header at all (Sec-Fetch-Site: same-origin / same-site / none) passes
    const sfSame = await page.request.patch('/api/org', { data: { name: 'Sec-Fetch same-origin' }, headers: { 'sec-fetch-site': 'same-origin' } });
    expect(sfSame.status()).toBe(200);
    const sfNone = await page.request.patch('/api/org', { data: { name: 'Sec-Fetch none' }, headers: { 'sec-fetch-site': 'none' } });
    expect(sfNone.status()).toBe(200);
    // GET with cross-site is not a state change
    expect((await page.request.get('/api/org', { headers: { 'sec-fetch-site': 'cross-site' } })).status()).toBe(200);

    // controls
    const same = await page.request.patch('/api/org', { data: { name: 'Same origin rename' }, headers: { origin: baseURL! } });
    expect(same.status()).toBe(200);
    const none = await page.request.patch('/api/org', { data: { name: 'No origin rename' } });
    expect(none.status()).toBe(200);
    expect((await page.request.get('/api/org', { headers: { origin: 'https://evil.example' } })).status()).toBe(200);
    const tok = await page.request.post('/api/me/api-tokens', { data: { name: 'ext' } });
    const bearer = (await tok.json()).token as string;
    // Bearer + foreign Origin AND the session cookie both present (cookie jar of this context): bearer wins, so no origin check.
    const viaBearer = await page.request.patch('/api/org', { data: { name: 'Bearer rename' }, headers: { origin: 'https://evil.example', authorization: `Bearer ${bearer}` } });
    expect(viaBearer.status(), 'bearer requests are not subject to the origin check').toBe(200);

    // surface the result on screen for the evidence screenshot
    await page.goto('/settings/organization');
    const shown = await page.evaluate(async (origin) => {
      const r = await fetch('/api/org', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-test-origin': origin }, body: JSON.stringify({ name: 'same-site ok' }) });
      return r.status;
    }, baseURL!);
    expect(shown).toBe(200);
    await ev(page, 'sc11-origin-check-controls-pass');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync('qa/evidence/002/US3', { recursive: true });
    writeFileSync('qa/evidence/002/US3/sc11-origin-check.txt', [
      `PATCH /api/org  Origin: https://evil.example (cookie) -> ${e.status} ${e.code} "${e.message}"`,
      `POST  /api/org/invitations {} Origin: evil (cookie)   -> ${evil2.status} ${evil2.code}  (before validation)`,
      `PATCH /api/org  Origin: ${baseURL}.evil.example -> ${evil3.status} ${evil3.code}`,
      `PATCH /api/org  Origin: ${baseURL} (cookie)       -> ${same.status()}`,
      `PATCH /api/org  no Origin (cookie)                -> ${none.status()}`,
      `PATCH /api/org  no Origin, Sec-Fetch-Site: cross-site (cookie) -> ${xs.status} ${xs.code} "${xs.message}"`,
      `POST  /api/org/invitations {} no Origin, cross-site -> ${xsitePost.status} ${xsitePost.code}`,
      `OPTIONS /api/org Origin: evil (cookie)            -> ${opt.status()}`,
      `POST  /api/me/api-tokens form-urlencoded, Origin: ${baseURL}, Sec-Fetch-Site: same-origin -> ${formStatus}`,
      `PATCH /api/org  no Origin, Sec-Fetch-Site: same-origin -> ${sfSame.status()}; none -> ${sfNone.status()}`,
      `GET   /api/org  Origin: evil (cookie)             -> 200; GET cross-site -> 200`,
      `PATCH /api/org  Origin: evil + Bearer tp_...      -> ${viaBearer.status()}`,
    ].join('\n') + '\n');
  });
});

// ───────────────────────── @mobile: Team / leave panel layout (sc8, sc10) ─────────────────────────
const noHScroll = async (page: Page) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, 'no horizontal page scroll').toBeLessThanOrEqual(1);
};

test.describe('team and leave panel layout @mobile', () => {
  test('sc8 @mobile Viewer Team page: no write actions, Leave organization reachable, no horizontal scroll', async ({ page, browser, baseURL }) => {
    const proj = test.info().project.name;
    const owner = await newOrg(browser, baseURL!);
    await join(owner.api, page.context(), 'viewer', 'Vik Viewer');
    await page.goto('/settings/team');
    await expect(page.getByRole('heading', { name: 'Team & roles' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite teammate' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /^Role for / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    const leave = page.getByRole('button', { name: 'Leave organization' });
    await expect(leave).toBeVisible();
    await leave.scrollIntoViewIfNeeded();
    expect(await leave.boundingBox()).not.toBeNull();
    await noHScroll(page);
    await ev(page, `sc8-mobile-viewer-team-${proj}`);
    await page.goto('/dashboard');
    await expect(page.getByText('View-only access').first()).toBeAttached();
  });

  test('sc8 @mobile Owner Team page: role selects, remove icons and invite fit the viewport', async ({ page, browser, baseURL }) => {
    const proj = test.info().project.name;
    const owner = await newOrg(browser, baseURL!);
    await page.context().addCookies(await owner.ctx.cookies());
    const u = await join(owner.api, await newCtx(browser, baseURL!), 'analyst', 'Asha Sharma');
    await page.goto('/settings/team');
    await expect(page.getByRole('heading', { name: 'Team & roles' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /^Role for / }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Remove / }).first()).toBeVisible();
    await noHScroll(page);
    await ev(page, `sc8-mobile-owner-team-${proj}`);
    expect(u.userId).toBeTruthy();
  });

  test('sc10 @mobile non-last member leaves via the dialog and lands correctly; last Owner is refused', async ({ page, browser, baseURL }) => {
    const proj = test.info().project.name;
    const A = await newOrg(browser, baseURL!, 'orga');
    const B = await newOrg(browser, baseURL!, 'orgb');
    const priya = await join(A.api, page.context(), 'owner', 'Priya Owner');
    const inv = await invite(B.api, priya.email, 'analyst');
    expect((await page.request.post('/api/auth/accept-invite', { data: { token: tokenOf(inv.inviteUrl) } })).status()).toBe(200);
    expect((await page.request.post('/api/auth/switch-org', { data: { orgId: A.me.org.id } })).status()).toBe(200);
    await page.goto('/settings/team');
    await expect(page.getByRole('heading', { name: 'Leave organization' })).toBeVisible();
    await noHScroll(page);
    await ev(page, `sc10-mobile-leave-panel-${proj}`);
    await page.getByRole('button', { name: 'Leave organization' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByRole('heading', { name: `Leave ${A.me.org.name}?` })).toBeVisible();
    const vp = page.viewportSize()!;
    // the dialog animates in (zoom/slide); assert on the settled box
    await expect.poll(async () => { const b = await dlg.boundingBox(); return !!b && b.x >= 0 && b.x + b.width <= vp.width + 1; }, { timeout: 5000 }).toBe(true);
    await ev(page, `sc10-mobile-leave-dialog-${proj}`);
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/org/members/me') && r.request().method() === 'DELETE'),
      dlg.getByRole('button', { name: 'Leave organization' }).click(),
    ]);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, nextOrgId: B.me.org.id });
    await expect(page).toHaveURL(/\/dashboard$/);
    expect((await (await page.request.get('/api/auth/me')).json()).org.id).toBe(B.me.org.id);
    // users.last_org_id written in the same transaction (round-2 fix)
    expect(sql(`select last_org_id from users where id='${priya.userId}'`)).toBe(B.me.org.id);
    await ev(page, `sc10-mobile-switched-${proj}`);

    // last Owner refused (sole owner of org A2)
    const A2 = await newOrg(browser, baseURL!, 'orgc');
    await page.context().clearCookies();
    await page.context().addCookies(await A2.ctx.cookies());
    await page.goto('/settings/team');
    await page.getByRole('button', { name: 'Leave organization' }).click();
    const [r2] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/org/members/me') && r.request().method() === 'DELETE'),
      page.getByRole('dialog').getByRole('button', { name: 'Leave organization' }).click(),
    ]);
    expect(await errOf(r2)).toMatchObject({ status: 409, code: 'last_owner' });
    await expect(page.getByText('You are the last Owner of this organization. Make someone else an Owner before you leave.').first()).toBeVisible();
    await noHScroll(page);
    await ev(page, `sc10-mobile-last-owner-${proj}`);
    expect(Number(sql(`select count(*) from memberships where user_id='${A2.me.user.id}'`))).toBe(1);
  });
});
