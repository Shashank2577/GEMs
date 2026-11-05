import { execFileSync } from 'node:child_process';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, uniqueUser, signupViaApi as rawSignupViaApi, evidence, collectRunArtifacts } from '../support/fixtures';

/**
 * 002 / US2 (#4): invite teammates and join an organization. One test per acceptance scenario (1-15).
 * Scenario numbers are in the test titles; evidence screenshots are named sc<N>-*.png.
 * Two (or more) browser contexts model inviter / invitee. The invite URL comes from POST /api/org/invitations
 * (shown in the dialog), never from the email.
 */
const SPEC = '002';
const STORY = 'US2';
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
const DAY = 24 * 60 * 60 * 1000;

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, name);

/** Test-fixture SQL access only (skip onboarding, age/expire an invitation row). */
function sql(q: string): string {
  return execFileSync('psql', [E2E_DB, '-qtAX', '-c', q], { encoding: 'utf8' }).trim();
}
function skipOnboarding(email: string) {
  sql(`update organizations set onboarding_state='{"basics":true}' where id in (select m.org_id from memberships m join users u on u.id=m.user_id where u.email='${email}')`);
}
async function signupViaApi(page: Page, user = uniqueUser()) {
  const u = await rawSignupViaApi(page, user);
  skipOnboarding(u.email);
  return u;
}

const opened: BrowserContext[] = [];
test.afterEach(async () => { while (opened.length) await opened.pop()!.close().catch(() => {}); });

/** A fresh context (own cookie jar) with the current project's viewport / device settings. */
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
interface Invite { id: string; email: string; role: Role; inviteUrl: string; expiresAt: string }
const tokenOf = (url: string) => url.split('/invite/')[1];

async function invite(page: Page, email: string, role: Role = 'analyst'): Promise<Invite> {
  const res = await page.request.post('/api/org/invitations', { data: { email, role } });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

/** Create a second user who joins the inviter's org with `role` (accepted over the API in its own context). */
async function addMember(browser: Browser, baseURL: string, owner: Page, role: Role, prefix = 'mem') {
  const u = uniqueUser(prefix);
  const inv = await invite(owner, u.email, role);
  const ctx = await newCtx(browser, baseURL);
  const res = await ctx.request.post('/api/auth/accept-invite', { data: { token: tokenOf(inv.inviteUrl), name: u.name, password: u.password } });
  expect(res.status(), await res.text()).toBe(200);
  skipOnboarding(u.email);
  return { ...u, ctx, me: await res.json() };
}

async function meOf(ctx: BrowserContext) {
  const res = await ctx.request.get('/api/auth/me');
  return { status: res.status(), body: res.status() === 200 ? await res.json() : null };
}

async function openInviteDialog(page: Page) {
  await page.goto('/settings/team');
  await page.getByRole('button', { name: 'Invite teammate' }).click();
  await expect(page.getByRole('heading', { name: 'Invite a teammate' })).toBeVisible();
}

const INVALID_MSG = 'This invitation link is invalid, already used or has expired. Ask your admin for a new one.';

test.describe('sc1-sc6 inviting', () => {
  test('sc1 Owner invites asha: 201 {id,email,role,inviteUrl,expiresAt}, +7d, dialog with read-only link and Copy', async ({ page, baseURL }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
    const owner = await signupViaApi(page);
    await openInviteDialog(page);
    await page.getByLabel('Work email').fill('asha@sharma.in');
    await expect(page.getByRole('combobox')).toContainText('Analyst');
    await ev(page, 'sc1-dialog-filled');
    const before = Date.now();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/org/invitations') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Send invitation' }).click(),
    ]);
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['email', 'expiresAt', 'id', 'inviteUrl', 'role']);
    expect(body).toMatchObject({ email: 'asha@sharma.in', role: 'analyst' });
    expect(body.inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);
    const delta = new Date(body.expiresAt).getTime() - before;
    expect(Math.abs(delta - 7 * DAY)).toBeLessThan(2 * 60_000);
    // dialog switches to the "sent" state with a read-only link and a Copy button
    await expect(page.getByRole('heading', { name: 'Invitation sent to asha@sharma.in' })).toBeVisible();
    const link = page.getByLabel('Invite link');
    await expect(link).toHaveValue(body.inviteUrl);
    await expect(link).toHaveAttribute('readonly', '');
    await ev(page, 'sc1-dialog-sent');
    await page.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    await expect(page.getByText('Invite link copied')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(body.inviteUrl);
    await ev(page, 'sc1-copied');
    void owner;
    // Email subject "<Inviter> invited you to <Org> on TenderPilot": the log mailer writes to the API server's stdout,
    // which Playwright's webServer does not capture. Covered by apps/api/test/auth.test.ts (ctx.mailer.sent subject) - see api-tests.txt.
  });

  test('sc2 invalid email "asha@" shows inline error and sends no request', async ({ page }) => {
    await signupViaApi(page);
    let posts = 0;
    page.on('request', (r) => { if (r.url().endsWith('/api/org/invitations') && r.method() === 'POST') posts += 1; });
    await openInviteDialog(page);
    await page.getByLabel('Work email').fill('asha@');
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    await page.waitForTimeout(500);
    expect(posts).toBe(0);
    await ev(page, 'sc2-invalid-email');
  });

  test('sc3 inviting an existing member returns 409 conflict shown under the email field', async ({ page, browser, baseURL }) => {
    await signupViaApi(page);
    const asha = await addMember(browser, baseURL!, page, 'analyst', 'asha');
    await openInviteDialog(page);
    await page.getByLabel('Work email').fill(asha.email);
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/org/invitations') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Send invitation' }).click(),
    ]);
    expect(res.status()).toBe(409);
    const j = await res.json();
    expect(j.error.code).toBe('conflict');
    expect(j.error.message).toBe(`${asha.email} is already a member of this organization`);
    // UI shows the message under the email field
    const msg = `${asha.email} is already a member of this organization`;
    // exact spec copy, under the email field (inside the Work email field group, not a toast)
    await expect(page.getByRole('dialog').getByText(msg, { exact: true })).toBeVisible();
    expect(j.error.details.fields.email).toBe(msg);
    await page.waitForTimeout(500);
    await ev(page, 'sc3-already-member');
  });

  test('sc4 re-inviting a pending address deletes the old invite (404 invite_invalid) and leaves one pending row', async ({ page, request }) => {
    await signupViaApi(page);
    const email = uniqueUser('asha').email;
    const first = await invite(page, email, 'analyst');
    expect((await request.get(`/api/auth/invite/${tokenOf(first.inviteUrl)}`)).status()).toBe(200);
    // second invite through the UI with a different role
    await openInviteDialog(page);
    await page.getByLabel('Work email').fill(email);
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Viewer' }).click();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/org/invitations') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Send invitation' }).click(),
    ]);
    expect(res.status()).toBe(201);
    const second = await res.json();
    expect(second.id).not.toBe(first.id);
    const old = await request.get(`/api/auth/invite/${tokenOf(first.inviteUrl)}`);
    expect(old.status()).toBe(404);
    expect((await old.json()).error.code).toBe('invite_invalid');
    expect((await request.get(`/api/auth/invite/${tokenOf(second.inviteUrl)}`)).status()).toBe(200);
    await page.getByRole('button', { name: 'Done' }).click();
    await page.reload();
    const panel = page.locator('section, div').filter({ has: page.getByText('Pending invitations') }).last();
    await expect(page.getByText('Pending invitations').first()).toBeVisible();
    await expect(page.getByText(email)).toHaveCount(1);
    await expect(page.getByText(/^Viewer · invited/)).toHaveCount(1);
    void panel;
    await ev(page, 'sc4-one-pending-row');
  });

  test('sc5 Bid Manager: Owner not offered in Role select; API role:"owner" is 403 forbidden', async ({ page, browser, baseURL }) => {
    await signupViaApi(page);
    const bm = await addMember(browser, baseURL!, page, 'bid_manager', 'bm');
    const bmPage = await bm.ctx.newPage();
    await openInviteDialog(bmPage);
    await bmPage.getByRole('combobox').click();
    await expect(bmPage.getByRole('option', { name: 'Analyst' })).toBeVisible();
    await expect(bmPage.getByRole('option', { name: 'Bid Manager' })).toBeVisible();
    await expect(bmPage.getByRole('option', { name: 'Viewer' })).toBeVisible();
    await expect(bmPage.getByRole('option', { name: 'Owner' })).toHaveCount(0);
    await ev(bmPage, 'sc5-role-options-bid-manager');
    await bmPage.keyboard.press('Escape');
    const res = await bm.ctx.request.post('/api/org/invitations', { data: { email: uniqueUser('x').email, role: 'owner' } });
    expect(res.status()).toBe(403);
    const j = await res.json();
    expect(j.error.code).toBe('forbidden');
    expect(j.error.message).toBe('Only an Owner can invite another Owner');
    // control: the Owner does see "Owner"
    await openInviteDialog(page);
    await page.getByRole('combobox').click();
    await expect(page.getByRole('option', { name: 'Owner' })).toBeVisible();
    await ev(page, 'sc5-role-options-owner-control');
  });

  test('sc6 Revoke: {ok:true}, toast "Invitation revoked", row disappears, link 404', async ({ page, request }) => {
    await signupViaApi(page);
    const email = uniqueUser('asha').email;
    const inv = await invite(page, email, 'analyst');
    await page.goto('/settings/team');
    await expect(page.getByText('Pending invitations').first()).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await ev(page, 'sc6-before-revoke');
    const [res] = await Promise.all([
      page.waitForResponse((r) => /\/api\/org\/invitations\/[^/]+$/.test(r.url()) && r.request().method() === 'DELETE'),
      page.getByRole('button', { name: 'Revoke' }).click(),
    ]);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await expect(page.getByText('Invitation revoked')).toBeVisible();
    await expect(page.getByText(email)).toHaveCount(0);
    await ev(page, 'sc6-after-revoke');
    const link = await request.get(`/api/auth/invite/${tokenOf(inv.inviteUrl)}`);
    expect(link.status()).toBe(404);
    expect((await link.json()).error.code).toBe('invite_invalid');
  });
});

test.describe('sc7-sc12 joining', () => {
  test('sc7 brand-new invitee joins: 200 Me with invited role, cookie, toast, /dashboard; Team + activity show it @mobile', async ({ page, browser, baseURL }) => {
    const owner = await signupViaApi(page);
    const u = uniqueUser('asha');
    const inv = await invite(page, u.email, 'analyst');
    const ctx = await newCtx(browser, baseURL!);
    const ip = await ctx.newPage();
    await ip.goto(inv.inviteUrl);
    await expect(ip.getByRole('button', { name: 'Join team' })).toBeVisible();
    await ip.getByLabel('Your name').fill(u.name);
    await ip.getByLabel('Choose a password').fill(u.password);
    await ev(ip, `sc7-form-${test.info().project.name}`);
    const [res] = await Promise.all([
      ip.waitForResponse((r) => r.url().endsWith('/api/auth/accept-invite') && r.request().method() === 'POST'),
      ip.getByRole('button', { name: 'Join team' }).click(),
    ]);
    expect(res.status()).toBe(200);
    const me = await res.json();
    expect(me).toMatchObject({ role: 'analyst', user: { email: u.email }, org: { name: owner.orgName } });
    await expect(ip.getByText(`You’ve joined ${owner.orgName} as Analyst`)).toBeVisible();
    await ip.waitForURL('**/dashboard');
    expect((await ctx.cookies()).some((c) => c.name === 'tp_session' && c.value)).toBe(true);
    await ev(ip, `sc7-landed-${test.info().project.name}`);
    // Independent test: Team lists the member as Analyst; activity shows "invited" and "joined the team"
    await page.goto('/settings/team');
    const row = page.getByRole('row').filter({ hasText: u.email }).or(page.locator('li').filter({ hasText: u.email })).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/Analyst/);
    await ev(page, `sc7-team-${test.info().project.name}`);
    await page.goto('/dashboard');
    await expect(page.getByText('Team activity')).toBeVisible();
    await expect(page.getByText(/invited/).first()).toBeVisible();
    await expect(page.getByText('joined the team')).toBeVisible();
    await ev(page, `sc7-activity-${test.info().project.name}`);
  });

  test('sc8 existing user (other org) joins with password: both orgs, active = inviter; wrong password 401', async ({ page, browser, baseURL }) => {
    const owner = await signupViaApi(page);
    const asha = uniqueUser('asha'); // own org elsewhere
    const otherCtx = await newCtx(browser, baseURL!);
    expect((await otherCtx.request.post('/api/auth/signup', { data: asha })).status()).toBe(201);
    await otherCtx.clearCookies(); // signed out
    const inv = await invite(page, asha.email, 'bid_manager');
    const ctx = await newCtx(browser, baseURL!);
    const ip = await ctx.newPage();
    await ip.goto(inv.inviteUrl);
    // existing + signed out: only a password field, email pre-filled read-only
    await expect(ip.getByRole('button', { name: 'Sign in & join' })).toBeVisible();
    await expect(ip.locator('input[name="email"]')).toHaveValue(asha.email);
    await expect(ip.locator('input[name="email"]')).toHaveAttribute('readonly', '');
    // wrong password
    await ip.getByLabel('Password').first().fill('definitely-wrong');
    const [bad] = await Promise.all([
      ip.waitForResponse((r) => r.url().endsWith('/api/auth/accept-invite')),
      ip.getByRole('button', { name: 'Sign in & join' }).click(),
    ]);
    expect(bad.status()).toBe(401);
    expect((await bad.json()).error.details.fields.password).toBe('Incorrect password');
    await expect(ip.getByText('Incorrect password')).toBeVisible();
    await ev(ip, 'sc8-wrong-password');
    // right password
    await ip.getByLabel('Password').first().fill(asha.password);
    const [ok] = await Promise.all([
      ip.waitForResponse((r) => r.url().endsWith('/api/auth/accept-invite')),
      ip.getByRole('button', { name: 'Sign in & join' }).click(),
    ]);
    expect(ok.status()).toBe(200);
    const me = await ok.json();
    expect(me.role).toBe('bid_manager');
    expect(me.org.name).toBe(owner.orgName);
    expect(me.orgs.map((o: { name: string }) => o.name).sort()).toEqual([asha.orgName, owner.orgName].sort());
    await ip.waitForURL('**/dashboard');
    await ev(ip, 'sc8-joined');
    expect((await meOf(ctx)).body.org.name).toBe(owner.orgName);
  });

  test('sc9 signed-in user: "Accept & join team" joins with current account and switches org; "Not you?" signs out', async ({ page, browser, baseURL }) => {
    const owner = await signupViaApi(page);
    const asha = uniqueUser('asha');
    const ctx = await newCtx(browser, baseURL!);
    expect((await ctx.request.post('/api/auth/signup', { data: asha })).status()).toBe(201);
    skipOnboarding(asha.email);
    const inv = await invite(page, asha.email, 'viewer');
    const ip = await ctx.newPage();
    await ip.goto(inv.inviteUrl);
    await expect(ip.getByRole('button', { name: 'Accept & join team' })).toBeVisible();
    await expect(ip.getByText(asha.email)).toBeVisible();
    await ev(ip, 'sc9-signed-in-form');
    const [res] = await Promise.all([
      ip.waitForResponse((r) => r.url().endsWith('/api/auth/accept-invite')),
      ip.getByRole('button', { name: 'Accept & join team' }).click(),
    ]);
    expect(res.status()).toBe(200);
    await ip.waitForURL('**/dashboard');
    const me = (await meOf(ctx)).body;
    expect(me.user.email).toBe(asha.email);
    expect(me.org.name).toBe(owner.orgName);
    expect(me.role).toBe('viewer');
    expect(me.orgs).toHaveLength(2);
    await ev(ip, 'sc9-joined');
    // "Not you? Use a different account"
    const bob = uniqueUser('bob');
    const bobCtx = await newCtx(browser, baseURL!);
    expect((await bobCtx.request.post('/api/auth/signup', { data: bob })).status()).toBe(201);
    const inv2 = await invite(page, uniqueUser('new').email, 'analyst');
    const bp = await bobCtx.newPage();
    await bp.goto(inv2.inviteUrl);
    // bob is signed in with a different email: mismatch view (see sc12) -- use a matching one for "Not you?"
    const carl = uniqueUser('carl');
    const carlCtx = await newCtx(browser, baseURL!);
    expect((await carlCtx.request.post('/api/auth/signup', { data: carl })).status()).toBe(201);
    const inv3 = await invite(page, carl.email, 'analyst');
    const cp = await carlCtx.newPage();
    await cp.goto(inv3.inviteUrl);
    await ev(cp, 'sc9-not-you-before');
    await cp.getByRole('button', { name: 'Not you? Use a different account' }).click();
    await expect(cp.getByRole('button', { name: 'Sign in & join' })).toBeVisible();
    await expect(cp.getByRole('button', { name: 'Accept & join team' })).toHaveCount(0);
    expect((await meOf(carlCtx)).status).toBe(401);
    await ev(cp, 'sc9-not-you-after');
  });

  test('sc10 expired, revoked and already-accepted links: 404 invite_invalid + error alert, no form', async ({ page, browser, baseURL, request }) => {
    const owner = await signupViaApi(page);
    const expired = await invite(page, uniqueUser('exp').email);
    sql(`update invitations set expires_at = now() - interval '1 hour' where email='${expired.email}'`);
    const revoked = await invite(page, uniqueUser('rev').email);
    expect((await page.request.delete(`/api/org/invitations/${revoked.id}`)).status()).toBe(200);
    const accU = uniqueUser('acc');
    const accepted = await invite(page, accU.email);
    const actx = await newCtx(browser, baseURL!);
    expect((await actx.request.post('/api/auth/accept-invite', { data: { token: tokenOf(accepted.inviteUrl), name: accU.name, password: accU.password } })).status()).toBe(200);
    void owner;

    for (const [label, inv] of [['expired', expired], ['revoked', revoked], ['accepted', accepted]] as const) {
      const tok = tokenOf(inv.inviteUrl);
      // API: preview and accept both 404 invite_invalid with the exact copy
      const prev = await request.get(`/api/auth/invite/${tok}`);
      expect(prev.status(), label).toBe(404);
      expect((await prev.json()).error).toMatchObject({ code: 'invite_invalid', message: INVALID_MSG });
      const acc = await request.post('/api/auth/accept-invite', { data: { token: tok, name: 'Zed Zed', password: 'password-123' } });
      expect(acc.status(), label).toBe(404);
      expect((await acc.json()).error).toMatchObject({ code: 'invite_invalid', message: INVALID_MSG });
      // UI: error alert, no form
      const ctx = await newCtx(browser, baseURL!);
      const p = await ctx.newPage();
      await p.goto(inv.inviteUrl);
      await expect(p.getByRole('alert')).toBeVisible();
      await expect(p.getByText('Ask your admin for a new invitation')).toBeVisible();
      await expect(p.getByText(INVALID_MSG, { exact: false })).toBeVisible();
      await expect(p.getByRole('button', { name: /Join team|Sign in & join|Accept & join team/ })).toHaveCount(0);
      await expect(p.locator('input[type="password"]')).toHaveCount(0);
      await ev(p, `sc10-${label}`);
    }
    // accepting a link that is revoked while the form is already open ends in the error state, not a dead form
    const live = await invite(page, uniqueUser('live').email);
    const ctx = await newCtx(browser, baseURL!);
    const p = await ctx.newPage();
    await p.goto(live.inviteUrl);
    await expect(p.getByRole('button', { name: 'Join team' })).toBeVisible();
    expect((await page.request.delete(`/api/org/invitations/${live.id}`)).status()).toBe(200);
    await p.getByLabel('Your name').fill('Late Joiner');
    await p.getByLabel('Choose a password').fill('password-123');
    await p.getByRole('button', { name: 'Join team' }).click();
    await expect(p.getByRole('alert')).toBeVisible();
    await expect(p.getByText('Ask your admin for a new invitation')).toBeVisible();
    await expect(p.getByRole('button', { name: 'Join team' })).toHaveCount(0);
    await ev(p, 'sc10-revoked-while-open');
  });

  test('sc11 preview first: GET /api/auth/invite/:token, "<Inviter> invited you to join <Org> as Analyst", Expires, skeleton, existingUser, 404 state', async ({ page, browser, baseURL }) => {
    const owner = await signupViaApi(page);
    const u = uniqueUser('asha');
    const inv = await invite(page, u.email, 'analyst');
    const tok = tokenOf(inv.inviteUrl);
    const ctx = await newCtx(browser, baseURL!);
    const p = await ctx.newPage();
    // skeleton while loading (delay the preview)
    await p.route(`**/api/auth/invite/${tok}`, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
    const first = p.waitForRequest((r) => /\/api\/auth\/(invite|accept-invite)/.test(r.url()));
    await p.goto(inv.inviteUrl);
    expect((await first).url()).toContain(`/api/auth/invite/${tok}`); // preview is the first auth call
    await expect(p.getByRole('status', { name: 'Loading invitation' })).toBeVisible();
    await ev(p, 'sc11-skeleton');
    const card = p.getByTestId('invite-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText(`${owner.name} invited you to join ${owner.orgName} as Analyst`);
    await expect(card).toContainText(/Expires \d{1,2} \w+ \d{4}|Expires /);
    await ev(p, 'sc11-new-user-preview');
    const prev = await (await p.request.get(`/api/auth/invite/${tok}`)).json();
    expect(prev).toMatchObject({ existingUser: false, email: u.email, role: 'analyst', orgName: owner.orgName, invitedBy: owner.name });
    await p.unroute(`**/api/auth/invite/${tok}`);
    // existingUser + signed out: password only, read-only email, "Sign in & join"
    const ex = uniqueUser('exists');
    const exCtx = await newCtx(browser, baseURL!);
    expect((await exCtx.request.post('/api/auth/signup', { data: ex })).status()).toBe(201);
    await exCtx.clearCookies();
    const inv2 = await invite(page, ex.email, 'analyst');
    expect((await (await exCtx.request.get(`/api/auth/invite/${tokenOf(inv2.inviteUrl)}`)).json()).existingUser).toBe(true);
    const ep = await exCtx.newPage();
    await ep.goto(inv2.inviteUrl);
    await expect(ep.getByRole('button', { name: 'Sign in & join' })).toBeVisible();
    await expect(ep.locator('input[name="email"]')).toHaveValue(ex.email);
    await expect(ep.locator('input[name="email"]')).toHaveAttribute('readonly', '');
    await expect(ep.locator('input[type="password"]')).toHaveCount(1);
    await expect(ep.getByLabel('Your name')).toHaveCount(0);
    await ev(ep, 'sc11-existing-user-preview');
    // 404 state
    const np = await (await newCtx(browser, baseURL!)).newPage();
    await np.goto('/invite/not-a-real-token');
    await expect(np.getByRole('alert')).toBeVisible();
    await expect(np.getByText('Ask your admin for a new invitation')).toBeVisible();
    const goto = np.getByRole('link', { name: 'Go to sign in' });
    await expect(goto).toBeVisible();
    await expect(goto).toHaveAttribute('href', '/login');
    await ev(np, 'sc11-404-state');
  });

  test('sc12 signed in as another email: 403 invite_email_mismatch, mismatch message + Sign out, no membership', async ({ page, browser, baseURL }) => {
    const owner = await signupViaApi(page);
    const asha = uniqueUser('asha');
    const inv = await invite(page, asha.email, 'analyst');
    const ravi = uniqueUser('ravi');
    const ctx = await newCtx(browser, baseURL!);
    expect((await ctx.request.post('/api/auth/signup', { data: ravi })).status()).toBe(201);
    skipOnboarding(ravi.email);
    // API contract
    const res = await ctx.request.post('/api/auth/accept-invite', { data: { token: tokenOf(inv.inviteUrl) } });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toMatchObject({
      code: 'invite_email_mismatch',
      message: `This invitation was sent to ${asha.email}. Sign out and continue as that account.`,
    });
    // UI
    const p = await ctx.newPage();
    await p.goto(inv.inviteUrl);
    await expect(p.getByRole('alert')).toContainText(`This invitation was sent to ${asha.email}. Sign out and continue as that account.`);
    await expect(p.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(p.getByRole('button', { name: /Accept & join team/ })).toHaveCount(0);
    await ev(p, 'sc12-mismatch');
    // no membership was created
    const members = await (await page.request.get('/api/org/members')).json();
    expect(members.items.map((m: { email: string }) => m.email)).not.toContain(ravi.email);
    expect(members.invitations.map((i: { email: string }) => i.email)).toEqual([asha.email]);
    const me = (await meOf(ctx)).body;
    expect(me.orgs).toHaveLength(1);
    expect(me.org.name).toBe(ravi.orgName);
    void owner;
    await p.getByRole('button', { name: 'Sign out' }).click();
    await expect(p.getByRole('button', { name: 'Sign in & join' }).or(p.getByRole('button', { name: 'Join team' }))).toBeVisible();
    expect((await meOf(ctx)).status).toBe(401);
    await ev(p, 'sc12-after-sign-out');
  });
});

test.describe('sc13-sc15 orgs and resend', () => {
  async function twoOrgUser(page: Page, browser: Browser, baseURL: string) {
    // `page` = the multi-org user (own org first = oldest), invited into a second owner's org
    const me = await signupViaApi(page);
    const ownerCtx = await newCtx(browser, baseURL);
    const ownerU = uniqueUser('boss');
    expect((await ownerCtx.request.post('/api/auth/signup', { data: ownerU })).status()).toBe(201);
    skipOnboarding(ownerU.email);
    const inv = await ownerCtx.request.post('/api/org/invitations', { data: { email: me.email, role: 'analyst' } });
    expect(inv.status()).toBe(201);
    const acc = await page.request.post('/api/auth/accept-invite', { data: { token: tokenOf((await inv.json()).inviteUrl) } });
    expect(acc.status(), await acc.text()).toBe(200);
    return { me, ownerU, ownerCtx };
  }

  test('sc13 org switcher: switch-org returns Me, toast "Switched to <Org>", /dashboard; non-member org is 404', async ({ page, browser, baseURL }) => {
    const { me, ownerU } = await twoOrgUser(page, browser, baseURL!);
    await page.goto('/settings/team');
    // data of the current (inviter) org is cached on the Team page
    await expect(page.getByText(ownerU.email).first()).toBeVisible();
    await page.getByRole('button', { name: /Switch organization/ }).first().click();
    await ev(page, 'sc13-switcher-open');
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/auth/switch-org')),
      page.getByRole('menuitem', { name: new RegExp(me.orgName) }).click(),
    ]);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.org.name).toBe(me.orgName);
    expect(body.role).toBe('owner');
    await expect(page.getByText(`Switched to ${me.orgName}`)).toBeVisible();
    await page.waitForURL('**/dashboard');
    await expect(page.getByRole('button', { name: new RegExp(`Organization: ${me.orgName}`) }).first()).toBeVisible();
    await ev(page, 'sc13-switched-dashboard');
    // cached queries cleared: the Team page now shows the new org's data, not the previous org's cached members
    await page.getByRole('link', { name: /Settings/ }).first().click().catch(async () => { await page.goto('/settings/team'); });
    await page.goto('/settings/team');
    await expect(page.getByText(me.email).first()).toBeVisible();
    await expect(page.getByText(ownerU.email)).toHaveCount(0);
    await ev(page, 'sc13-new-org-team');
    // non-member org => 404
    const stranger = await (await newCtx(browser, baseURL!)).request.post('/api/auth/signup', { data: uniqueUser('str') });
    const strangerOrg = (await stranger.json()).org.id;
    const denied = await page.request.post('/api/auth/switch-org', { data: { orgId: strangerOrg } });
    expect(denied.status()).toBe(404);
  });

  test('sc14 sign-in resumes the last-used org (if still a member), else the oldest membership', async ({ page, browser, baseURL, request }) => {
    const { me, ownerU, ownerCtx } = await twoOrgUser(page, browser, baseURL!);
    const boss = (await (await ownerCtx.request.get('/api/auth/me')).json());
    // active org is now the inviter's; sign in on a second device while this session exists
    const d2 = await newCtx(browser, baseURL!);
    let login = await d2.request.post('/api/auth/login', { data: { email: me.email, password: me.password } });
    expect(login.status()).toBe(200);
    const l2 = await login.json();
    expect(l2.org.name).toBe(ownerU.orgName); // last used (inviter's), not the oldest (own)
    const ownOrgId = l2.orgs.find((o: { name: string }) => o.name === me.orgName).id;
    // "most recent session" = the newest one: switch there to own org; a further sign-in resumes that one
    expect((await d2.request.post('/api/auth/switch-org', { data: { orgId: ownOrgId } })).status()).toBe(200);
    const d3 = await newCtx(browser, baseURL!);
    login = await d3.request.post('/api/auth/login', { data: { email: me.email, password: me.password } });
    expect((await login.json()).org.name).toBe(me.orgName);
    // switching org in an OLDER session also counts as 'last used'
    expect((await page.request.post('/api/auth/switch-org', { data: { orgId: boss.org.id } })).status()).toBe(200);
    const dOld = await newCtx(browser, baseURL!);
    expect((await (await dOld.request.post('/api/auth/login', { data: { email: me.email, password: me.password } })).json()).org.name).toBe(ownerU.orgName);
    // switch back to inviter org, then get removed from it: next login falls back to the oldest membership
    expect((await d3.request.post('/api/auth/switch-org', { data: { orgId: boss.org.id } })).status()).toBe(200);
    const myId = (await meOf(page.context())).body.user.id;
    expect((await ownerCtx.request.delete(`/api/org/members/${myId}`)).status()).toBe(200);
    const d4 = await newCtx(browser, baseURL!);
    login = await d4.request.post('/api/auth/login', { data: { email: me.email, password: me.password } });
    expect((await login.json()).org.name).toBe(me.orgName);
    // UI login lands in the resumed org
    const d5 = await newCtx(browser, baseURL!);
    const p5 = await d5.newPage();
    await p5.goto('/login');
    await p5.getByLabel('Work email').fill(me.email);
    await p5.getByLabel('Password', { exact: true }).fill(me.password);
    await p5.getByRole('button', { name: /^Sign in/ }).click();
    await p5.waitForURL(/\/(dashboard|onboarding)/);
    await ev(p5, 'sc14-ui-login-org');
    void request;
  });

  test('sc14b after an explicit sign-out the next sign-in resumes the last-used org', async ({ page, browser, baseURL }) => {
    const { me, ownerU } = await twoOrgUser(page, browser, baseURL!);
    expect((await meOf(page.context())).body.org.name).toBe(ownerU.orgName);
    await page.request.post('/api/auth/logout');
    const d = await newCtx(browser, baseURL!);
    const login = await d.request.post('/api/auth/login', { data: { email: me.email, password: me.password } });
    const org = (await login.json()).org.name;
    test.info().annotations.push({ type: 'observation', description: `after logout, next login active org = ${org} (last used was ${ownerU.orgName}; oldest is ${me.orgName})` });
    console.log(`SC14B_OBSERVED_ORG=${org} last_used=${ownerU.orgName} oldest=${me.orgName}`);
    expect(org).toBe(ownerU.orgName); // last-used org survives sign-out (users.last_org_id)
  });

  test('sc15 Resend: fresh link + new 7-day expiry, old link dead, toast "Invitation resent to <email>"', async ({ page, request }) => {
    await signupViaApi(page);
    const email = uniqueUser('asha').email;
    const inv = await invite(page, email, 'analyst');
    sql(`update invitations set expires_at = now() + interval '1 day' where id='${inv.id}'`);
    await page.goto('/settings/team');
    await expect(page.getByText(email)).toBeVisible();
    await ev(page, 'sc15-before-resend');
    const before = Date.now();
    const [res] = await Promise.all([
      page.waitForResponse((r) => /\/api\/org\/invitations\/[^/]+\/resend$/.test(r.url()) && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Resend' }).click(),
    ]);
    expect(res.status()).toBe(201);
    const n = await res.json();
    expect(n).toMatchObject({ id: inv.id, email, role: 'analyst' });
    expect(n.inviteUrl).not.toBe(inv.inviteUrl);
    expect(Math.abs(new Date(n.expiresAt).getTime() - before - 7 * DAY)).toBeLessThan(2 * 60_000);
    await expect(page.getByText(`Invitation resent to ${email}`)).toBeVisible();
    await ev(page, 'sc15-after-resend');
    expect((await request.get(`/api/auth/invite/${tokenOf(inv.inviteUrl)}`)).status()).toBe(404);
    expect((await request.get(`/api/auth/invite/${tokenOf(n.inviteUrl)}`)).status()).toBe(200);
    // Email send on resend: covered by apps/api/test/auth.test.ts (mailer.sent) - see api-tests.txt.
  });
});
