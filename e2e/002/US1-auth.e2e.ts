import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, uniqueUser, signupViaApi as rawSignupViaApi, evidence, collectRunArtifacts } from '../support/fixtures';

/**
 * 002 / US1 (#3): sign up, sign in, sign out and stay signed in. One test per acceptance scenario (1-17).
 * Scenario numbers are in the test titles; evidence screenshots are named sc<N>-*.png.
 */
const SPEC = '002';
const STORY = 'US1';
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, name);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Run SQL against the e2e database (test fixture access only: aging sessions, reading rows). */
function sql(q: string): string {
  return execFileSync('psql', [E2E_DB, '-qtAX', '-c', q], { encoding: 'utf8' }).trim();
}

/** Sign up via API and mark the org's onboarding as started so /dashboard is not auto-redirected to /onboarding (separate story). */
async function signupViaApi(page: Page, user = uniqueUser()) {
  const u = await rawSignupViaApi(page, user);
  skipOnboarding(u.email);
  return u;
}
function skipOnboarding(email: string) {
  sql(`update organizations set onboarding_state='{"basics":true}' where id in (select m.org_id from memberships m join users u on u.id=m.user_id where u.email='${email}')`);
}

async function sessionCookie(ctx: BrowserContext) {
  const c = (await ctx.cookies()).find((x) => x.name === 'tp_session');
  expect(c, 'tp_session cookie present').toBeTruthy();
  return c!;
}

const UA = {
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  lin: 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
};

/** A fresh browser context (own cookie jar) signed in as `user` via the API. */
async function deviceContext(browser: Browser, baseURL: string, user: { email: string; password: string }, userAgent: string) {
  const ctx = await browser.newContext({ baseURL, userAgent, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
  const res = await ctx.request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(res.status(), await res.text()).toBe(200);
  return ctx;
}

async function uiLogin(page: Page, email: string, password: string) {
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
}

async function openAccountMenuAndSignOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
}

test.describe('sc1 signup', () => {
  test('sc1 signup creates account + org, sets cookie, toast, lands on /onboarding @mobile', async ({ page, playwright, baseURL }) => {
    const u = uniqueUser('priya');
    await page.goto('/signup');
    await page.getByLabel('Your name').fill('Priya Sharma');
    await page.getByLabel('Company name').fill('Sharma Infotech Pvt Ltd');
    await page.getByLabel('Work email').fill(u.email);
    await page.getByLabel('Password', { exact: true }).fill('Bid@2026!');
    await ev(page, `sc1-form-${test.info().project.name}`);
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/auth/signup') && r.request().method() === 'POST'),
      page.getByRole('button', { name: /Create account/ }).click(),
    ]);
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.user.email).toBe(u.email);
    expect(body.user.name).toBe('Priya Sharma');
    expect(body.org.name).toBe('Sharma Infotech Pvt Ltd');
    expect(body.role).toBe('owner');
    expect(body.orgs).toHaveLength(1);

    // raw Set-Cookie header (browser responses hide it) via a separate API signup
    const rawApi = await playwright.request.newContext({ baseURL });
    const raw = await rawApi.post('/api/auth/signup', { data: uniqueUser('rawck') });
    const setCookie = raw.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value).join('\n');
    expect(setCookie).toMatch(/tp_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Expires=/i);
    const c = await sessionCookie(page.context());
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
    expect(c.path).toBe('/');
    const days = (c.expires * 1000 - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    await expect(page.getByText('Welcome to TenderPilot, Priya!').first()).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding$/);
    await ev(page, `sc1-onboarding-${test.info().project.name}`);
  });
});

test('sc2 signup validation: no request sent, four inline errors @mobile', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/auth/signup')) calls.push(r.url()); });
  await page.goto('/signup');
  await page.getByLabel('Work email').fill('priya@');
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByLabel('Company name').fill('S');
  await page.getByRole('button', { name: /Create account/ }).click();
  await expect(page.getByText('Tell us your name')).toBeVisible();
  await expect(page.getByText('Enter a valid work email')).toBeVisible();
  await expect(page.getByText('Use at least 8 characters')).toBeVisible();
  await expect(page.getByText('Enter your company name')).toBeVisible();
  await ev(page, `sc2-inline-errors-${test.info().project.name}`);
  await page.waitForTimeout(500);
  expect(calls, 'no signup request sent').toHaveLength(0);
  await expect(page).toHaveURL(/\/signup/);
});

test('sc3 duplicate email (any case) -> 409 conflict + inline message', async ({ page, playwright, baseURL }) => {
  const u = uniqueUser('dup');
  const api = await playwright.request.newContext({ baseURL });
  const first = await api.post('/api/auth/signup', { data: u });
  expect(first.status()).toBe(201);

  // API contract
  const second = await api.post('/api/auth/signup', { data: { ...u, email: u.email.toUpperCase() } });
  expect(second.status()).toBe(409);
  const j = await second.json();
  expect(j.error.code).toBe('conflict');
  expect(j.error.details.fields.email).toBe('Already registered');

  // UI
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Priya Sharma');
  await page.getByLabel('Company name').fill('Sharma Infotech Pvt Ltd');
  await page.getByLabel('Work email').fill(u.email.replace(/^dup/, 'DUP').replace('@example.in', '@Example.IN'));
  await page.getByLabel('Password', { exact: true }).fill('Bid@2026!');
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/signup')),
    page.getByRole('button', { name: /Create account/ }).click(),
  ]);
  expect(res.status()).toBe(409);
  await expect(page.getByText('An account with this email already exists. Try signing in.')).toBeVisible();
  await ev(page, 'sc3-duplicate-email');
  await api.dispose();
});

test('sc4 password strength meter labels and show/hide toggle (signup + invite acceptance) @mobile', async ({ page, playwright, baseURL }) => {
  await page.goto('/signup');
  const pw = page.getByLabel('Password', { exact: true });
  const cases: [string, string][] = [
    ['abc', 'Too short'], ['abcdefgh', 'Weak'], ['Abcdefgh1', 'Fair'], ['Abcdefg1!', 'Good'], ['Abcdefghij1!', 'Strong'],
  ];
  for (const [value, label] of cases) {
    await pw.fill(value);
    await expect(page.getByText(label, { exact: true }), `${value} -> ${label}`).toBeVisible();
    if (label === 'Fair') await ev(page, `sc4-meter-fair-${test.info().project.name}`);
  }
  const eye = page.getByRole('button', { name: 'Show password' });
  await expect(eye).toHaveAttribute('aria-pressed', 'false');
  await expect(pw).toHaveAttribute('type', 'password');
  await eye.click();
  const hide = page.getByRole('button', { name: 'Hide password' });
  await expect(hide).toHaveAttribute('aria-pressed', 'true');
  await expect(pw).toHaveAttribute('type', 'text');
  await ev(page, `sc4-shown-${test.info().project.name}`);
  await hide.click();
  await expect(page.getByRole('button', { name: 'Show password' })).toHaveAttribute('aria-pressed', 'false');

  // invite acceptance page
  const owner = uniqueUser('own');
  const api = await playwright.request.newContext({ baseURL });
  expect((await api.post('/api/auth/signup', { data: owner })).status()).toBe(201);
  const inv = await api.post('/api/org/invitations', { data: { email: `invitee.${Date.now()}@example.in`, role: 'analyst' } });
  expect(inv.status(), await inv.text()).toBe(201);
  const { inviteUrl } = await inv.json();
  await page.goto(new URL(inviteUrl).pathname);
  const ipw = page.getByLabel('Choose a password');
  await ipw.fill('Abcdefg1!');
  await expect(page.getByText('Good', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
  await ev(page, `sc4-invite-page-${test.info().project.name}`);
  await api.dispose();
});

test('sc5 login: correct credentials -> 200 Me, toast, /dashboard, and ?next= relative path honoured @mobile', async ({ page }) => {
  const u = await signupViaApi(page, { ...uniqueUser('priya'), name: 'Priya Sharma' });
  await page.context().clearCookies();

  await page.goto('/login');
  await uiLogin(page, u.email, u.password);
  await expect(page.getByText('Welcome back, Priya').first()).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  await ev(page, `sc5-dashboard-${test.info().project.name}`);

  // API contract
  const api = page.context().request;
  await page.context().clearCookies();
  const res = await api.post('/api/auth/login', { data: { email: u.email, password: u.password } });
  expect(res.status()).toBe(200);
  const me = await res.json();
  expect(me.user.email).toBe(u.email);
  expect(me.role).toBe('owner');

  // ?next= relative path
  await page.context().clearCookies();
  await page.goto('/login?next=%2Ftenders');
  await uiLogin(page, u.email, u.password);
  await expect(page).toHaveURL(/\/tenders$/);
});

for (const evil of ['https://evil.example', '//evil.example']) {
  test(`sc6 open-redirect protection for next=${evil}`, async ({ page }) => {
    const u = await signupViaApi(page);
    await page.context().clearCookies();
    await page.goto(`/login?next=${encodeURIComponent(evil)}`);
    await uiLogin(page, u.email, u.password);
    await expect(page).toHaveURL(/localhost:\d+\/dashboard$/);
    await ev(page, `sc6-${evil.startsWith('//') ? 'protocol-relative' : 'absolute'}`);
  });
}

test('sc7 wrong password / unknown email -> 401 invalid_credentials, same message, same timing band', async ({ page, playwright, baseURL }) => {
  const u = await signupViaApi(page);
  const api = await playwright.request.newContext({ baseURL });
  const time = async (email: string) => {
    const t0 = Date.now();
    const r = await api.post('/api/auth/login', { data: { email, password: 'Wrong!pass999' } });
    const dt = Date.now() - t0;
    expect(r.status()).toBe(401);
    const j = await r.json();
    expect(j.error.code).toBe('invalid_credentials');
    expect(j.error.message).toBe('Incorrect email or password');
    return dt;
  };
  const known: number[] = []; const unknown: number[] = [];
  for (let i = 0; i < 3; i++) {
    known.push(await time(u.email));
    unknown.push(await time(`ghost.${Date.now()}${i}@example.in`));
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  test.info().annotations.push({ type: 'timing-ms', description: `wrong-password=${known.join(',')} unknown-email=${unknown.join(',')}` });
  console.log(`sc7 timing ms: wrong-password=[${known}] unknown-email=[${unknown}]`);
  expect(Math.abs(med(known) - med(unknown)), 'same response-time band (median diff < 100ms)').toBeLessThan(100);

  // UI alert
  await page.context().clearCookies();
  await page.goto('/login');
  await uiLogin(page, u.email, 'Wrong!pass999');
  const alert = page.getByRole('alert').filter({ hasText: 'That email and password don’t match. Please try again.' });
  await expect(alert).toBeVisible();
  await ev(page, 'sc7-wrong-password-alert');
  await page.getByLabel('Work email').fill(`ghost.${Date.now()}@example.in`);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await expect(alert).toBeVisible();
  await ev(page, 'sc7-unknown-email-alert');
  await api.dispose();
});

test('sc8 sign out via account menu: logout ok, session row deleted, cookie cleared, toast, /login, Back shows no app data @mobile', async ({ page }) => {
  const u = await signupViaApi(page);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goto('/tenders'); // a second history entry so Back has an app page to return to
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const token = (await sessionCookie(page.context())).value;
  expect(sql(`select count(*) from sessions where token_hash='${sha(token)}'`)).toBe('1');
  await ev(page, `sc8-before-${test.info().project.name}`);

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/logout')),
    openAccountMenuAndSignOut(page),
  ]);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  await expect(page.getByText('Signed out', { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  await ev(page, `sc8-after-${test.info().project.name}`);
  expect(sql(`select count(*) from sessions where token_hash='${sha(token)}'`), 'session row deleted').toBe('0');
  expect((await page.context().cookies()).find((c) => c.name === 'tp_session'), 'cookie cleared').toBeUndefined();
  const me = await page.request.get('/api/auth/me');
  expect(me.status()).toBe(401);

  await page.goBack();
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
  await expect(page.getByRole('button', { name: 'Account menu' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await ev(page, `sc8-back-${test.info().project.name}`);
  void u;
});

test('sc9 signed-out /pipeline?stage=prepare -> /login?next=... and back after sign in @mobile', async ({ page }) => {
  const u = uniqueUser('p9');
  const reg = await page.request.post('/api/auth/signup', { data: u });
  expect(reg.status()).toBe(201);
  skipOnboarding(u.email);
  await page.context().clearCookies();
  await page.goto('/pipeline?stage=prepare');
  await expect(page).toHaveURL(/\/login\?next=%2Fpipeline%3Fstage%3Dprepare$/);
  await ev(page, `sc9-redirected-${test.info().project.name}`);
  await uiLogin(page, u.email, u.password);
  await expect(page).toHaveURL(/\/pipeline\?stage=prepare$/);
  await ev(page, `sc9-landed-${test.info().project.name}`);
});

test('sc10 signed-in visitors on /, /login, /signup are redirected to /dashboard', async ({ page }) => {
  await signupViaApi(page);
  for (const path of ['/', '/login', '/signup']) {
    await page.goto(path);
    await expect(page, `from ${path}`).toHaveURL(/\/dashboard$/);
  }
  await ev(page, 'sc10-redirected-to-dashboard');
});

test('sc11 sliding expiry: 16-day-old session is extended to now+30d and cookie re-issued; 30-day-unused session -> 401', async ({ page }) => {
  const u = await signupViaApi(page);
  const token = (await sessionCookie(page.context())).value;
  const h = sha(token);
  // created 16 days ago => 14 days of its 30 remain
  sql(`update sessions set created_at=now()-interval '16 days', expires_at=now()+interval '14 days', last_seen_at=now()-interval '16 days' where token_hash='${h}'`);
  const before = Number(sql(`select extract(epoch from expires_at) from sessions where token_hash='${h}'`));
  const res = await page.request.get('/api/auth/me');
  expect(res.status()).toBe(200);
  const after = Number(sql(`select extract(epoch from expires_at) from sessions where token_hash='${h}'`));
  const remainingDays = (after - Date.now() / 1000) / 86_400;
  test.info().annotations.push({ type: 'expiry', description: `before=${((before - Date.now() / 1000) / 86400).toFixed(2)}d after=${remainingDays.toFixed(2)}d` });
  expect(remainingDays).toBeGreaterThan(29.9);
  expect(remainingDays).toBeLessThan(30.1);
  const setCookie = res.headersArray().filter((x) => x.name.toLowerCase() === 'set-cookie').map((x) => x.value).join('\n');
  expect(setCookie, 'cookie re-issued').toMatch(/tp_session=/);
  const exp = /expires=([^;]+)/i.exec(setCookie);
  expect(exp, 'cookie carries Expires').toBeTruthy();
  const cookieDays = (new Date(exp![1]).getTime() - Date.now()) / 86_400_000;
  expect(cookieDays).toBeGreaterThan(29.9);
  expect(cookieDays).toBeLessThan(30.1);
  const c = await sessionCookie(page.context());
  expect((c.expires * 1000 - Date.now()) / 86_400_000).toBeGreaterThan(29.9);
  console.log(`sc11 remaining before=${((before - Date.now() / 1000) / 86400).toFixed(2)}d after=${remainingDays.toFixed(2)}d cookie=${cookieDays.toFixed(2)}d`);

  // unused for 30 days => expired
  sql(`update sessions set expires_at=now()-interval '1 minute' where token_hash='${h}'`);
  const dead = await page.request.get('/api/auth/me');
  expect(dead.status()).toBe(401);
  const j = await dead.json();
  expect(j.error.code).toBe('unauthorized');
  expect(j.error.message).toBe('Please sign in to continue');
  const res2 = await page.request.get('/api/auth/me');
  expect(res2.status()).toBe(401);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login\?next=/);
  await ev(page, 'sc11-expired-session-redirect');
  void u;
});

test('sc12 password change in A: 200 {ok:true}, toast, B gets 401, A stays signed in', async ({ page, browser, baseURL }) => {
  const u = await signupViaApi(page);
  const ctxB = await deviceContext(browser, baseURL!, u, UA.lin);
  expect((await ctxB.request.get('/api/auth/me')).status()).toBe(200);

  await page.goto('/settings/account');
  await page.getByLabel('Current password').fill(u.password);
  await page.getByLabel('New password').fill('Brand!new2026');
  await ev(page, 'sc12-form');
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/me/password')),
    page.getByRole('button', { name: 'Change password' }).click(),
  ]);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  await expect(page.getByText('Password changed').first()).toBeVisible();
  await expect(page.getByText('Other devices have been signed out.').first()).toBeVisible();
  await ev(page, 'sc12-toast');

  const b = await ctxB.request.get('/api/auth/me');
  expect(b.status(), 'B signed out').toBe(401);
  expect((await page.request.get('/api/auth/me')).status(), 'A still signed in').toBe(200);
  await page.reload();
  await expect(page).toHaveURL(/\/settings\/account/);
  // new password works, old does not
  const api = ctxB.request;
  expect((await api.post('/api/auth/login', { data: { email: u.email, password: u.password } })).status()).toBe(401);
  expect((await api.post('/api/auth/login', { data: { email: u.email, password: 'Brand!new2026' } })).status()).toBe(200);
  await ctxB.close();
});

test('sc13 change password with wrong current -> 400 invalid_credentials + field error', async ({ page }) => {
  const u = await signupViaApi(page);
  await page.goto('/settings/account');
  await page.getByLabel('Current password').fill('Not!my-password1');
  await page.getByLabel('New password').fill('Brand!new2026');
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/me\/password/.test(r.url())),
    page.getByRole('button', { name: 'Change password' }).click(),
  ]);
  expect(res.status()).toBe(400);
  const j = await res.json();
  expect(j.error.code).toBe('invalid_credentials');
  expect(j.error.details.fields.currentPassword).toBe('Incorrect password');
  await expect(page.getByText('Incorrect password', { exact: true })).toBeVisible();
  await ev(page, 'sc13-wrong-current-password');
  void u;
});

test('sc14 rate limit: 10 failed logins then 11th (right password) -> 429 + Retry-After + form message', async ({ page, playwright, baseURL }) => {
  const u = uniqueUser('rl');
  const api = await playwright.request.newContext({ baseURL });
  expect((await api.post('/api/auth/signup', { data: u })).status()).toBe(201);
  for (let i = 1; i <= 10; i++) {
    const r = await api.post('/api/auth/login', { data: { email: u.email, password: `Wrong!pass${i}` } });
    expect(r.status(), `attempt ${i}`).toBe(401);
  }
  const r11 = await api.post('/api/auth/login', { data: { email: u.email, password: u.password } });
  expect(r11.status()).toBe(429);
  const retry = r11.headers()['retry-after'];
  expect(retry, 'Retry-After header').toBeTruthy();
  expect(Number(retry)).toBeGreaterThan(0);
  expect(Number(retry)).toBeLessThanOrEqual(900);
  const j = await r11.json();
  expect(j.error.code).toBe('rate_limited');
  expect(j.error.message).toMatch(/^Too many attempts\. Try again in \d+ minutes?\.$/);
  test.info().annotations.push({ type: 'rate-limit', description: `Retry-After=${retry} message="${j.error.message}"` });
  console.log(`sc14 Retry-After=${retry} message="${j.error.message}"`);

  await page.goto('/login');
  await uiLogin(page, u.email, u.password);
  await expect(page.getByRole('alert').filter({ hasText: /Too many attempts\. Try again in \d+ minutes?\./ })).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  await ev(page, 'sc14-form-rate-limited');
  await api.dispose();
});

test.describe('sc15 password reset', () => {
  test('sc15a forgot-password page shows neutral copy for known and unknown email (no enumeration)', async ({ page }) => {
    const u = uniqueUser('fp');
    await page.request.post('/api/auth/signup', { data: u });
    await page.context().clearCookies();
    const msg = 'If an account exists for that email, we’ve sent a reset link. It expires in 1 hour.';
    await page.goto('/login');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.getByLabel('Work email').fill(u.email);
    await page.getByRole('button', { name: /Send reset link/ }).click();
    await expect(page.getByText(msg)).toBeVisible();
    await ev(page, 'sc15-neutral-confirmation-known-email');

    await page.goto('/forgot-password');
    await page.getByLabel('Work email').fill(`nobody.${Date.now()}@example.in`);
    await page.getByRole('button', { name: /Send reset link/ }).click();
    await expect(page.getByText(msg)).toBeVisible();
    await ev(page, 'sc15-neutral-confirmation-unknown-email');

    const a = await page.request.post('/api/auth/forgot-password', { data: { email: u.email } });
    const b = await page.request.post('/api/auth/forgot-password', { data: { email: `nobody2.${Date.now()}@example.in` } });
    expect(a.status()).toBe(200); expect(b.status()).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    // a reset-request row exists only for the real user
    expect(Number(sql(`select count(*) from password_resets pr join users x on x.id=pr.user_id where x.email='${u.email}'`))).toBeGreaterThanOrEqual(1);
  });

  test('sc15b reset link sets a new password once, signs out all sessions and signs in', async ({ page, browser, baseURL }) => {
    // The emailed token is only ever in the email body (the log mailer logs to/subject only), so the
    // end-to-end "email arrives with this link" step is NOT exercised here. The reset row is inserted with a
    // token we know (sha256-hashed exactly like the API does) to exercise the real /reset-password page + API.
    const u = await signupViaApi(page, uniqueUser('rs'));
    const other = await deviceContext(browser, baseURL!, u, UA.ios);
    expect((await other.request.get('/api/auth/me')).status()).toBe(200);
    await page.context().clearCookies();

    const token = randomBytes(24).toString('base64url');
    sql(`insert into password_resets (user_id, token_hash, expires_at) select id, '${sha(token)}', now()+interval '60 minutes' from users where email='${u.email}'`);

    await page.goto(`/reset-password/${token}`);
    await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible();
    await page.getByLabel('New password').fill('Reset!2026pass');
    await ev(page, 'sc15-reset-form');
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/auth/reset-password')),
      page.getByRole('button', { name: /Save and sign in/ }).click(),
    ]);
    expect(res.status()).toBe(200);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText('Password updated').first()).toBeVisible();
    await ev(page, 'sc15-reset-signed-in');
    expect((await page.request.get('/api/auth/me')).status(), 'signed in after reset').toBe(200);
    expect((await other.request.get('/api/auth/me')).status(), 'other session signed out').toBe(401);

    // single use
    const again = await page.request.post('/api/auth/reset-password', { data: { token, newPassword: 'Another!2026pw' } });
    expect([400, 404, 410]).toContain(again.status());
    expect((await again.json()).error.code).toBe('reset_invalid');
    await page.context().clearCookies();
    await page.goto(`/reset-password/${token}`);
    await page.getByLabel('New password').fill('Another!2026pw');
    await page.getByRole('button', { name: /Save and sign in/ }).click();
    await expect(page.getByText('This password reset link is invalid, already used or has expired.')).toBeVisible();
    await ev(page, 'sc15-reused-link');

    // new password works, old does not
    const login = (p: string) => page.request.post('/api/auth/login', { data: { email: u.email, password: p } });
    expect((await login(u.password)).status()).toBe(401);
    expect((await login('Reset!2026pass')).status()).toBe(200);
    await other.close();
  });

  test('sc15c invalid and expired reset links show the expired state', async ({ page }) => {
    const bad = await page.request.post('/api/auth/reset-password', { data: { token: 'definitely-not-a-token', newPassword: 'Whatever!2026' } });
    expect(bad.status()).toBeGreaterThanOrEqual(400);
    expect((await bad.json()).error.code).toBe('reset_invalid');

    await page.goto('/reset-password/definitely-not-a-token');
    await page.getByLabel('New password').fill('Whatever!2026');
    await page.getByRole('button', { name: /Save and sign in/ }).click();
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Request a new link/ })).toBeVisible();
    await ev(page, 'sc15-invalid-link');

    const u = uniqueUser('ex');
    await page.request.post('/api/auth/signup', { data: u });
    await page.context().clearCookies();
    const token = randomBytes(24).toString('base64url');
    sql(`insert into password_resets (user_id, token_hash, expires_at) select id, '${sha(token)}', now()-interval '1 minute' from users where email='${u.email}'`);
    await page.goto(`/reset-password/${token}`);
    await page.getByLabel('New password').fill('Whatever!2026');
    await page.getByRole('button', { name: /Save and sign in/ }).click();
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    await ev(page, 'sc15-expired-link');
  });
});

test('sc16 "Where you’re signed in": 3 sessions listed, badge, per-row sign out, sign out of all others', async ({ page, browser, baseURL }) => {
  const u = uniqueUser('sess');
  const reg = await page.request.post('/api/auth/signup', { data: u });
  expect(reg.status()).toBe(201);
  const b = await deviceContext(browser, baseURL!, u, UA.ios);
  const c = await deviceContext(browser, baseURL!, u, UA.lin);

  await page.goto('/settings/account');
  await expect(page.getByText('Where you’re signed in')).toBeVisible();
  const list = page.getByRole('list', { name: 'Signed-in devices' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByText('This device')).toHaveCount(1);
  await expect(list.getByText(/Last active/)).toHaveCount(2);
  await expect(list.getByRole('button', { name: /^Sign out/ })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Sign out of all other devices' })).toBeVisible();
  const text = await list.innerText();
  console.log('sc16 rows:\n' + text);
  expect(text).toMatch(/iOS|iPhone/);
  expect(text).toMatch(/Linux/);
  await ev(page, 'sc16-three-sessions');

  // revoke the iOS row
  await list.getByRole('listitem').filter({ hasText: /iOS|iPhone/ }).getByRole('button', { name: /Sign out/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await ev(page, 'sc16-after-revoke-one');
  expect((await b.request.get('/api/auth/me')).status(), 'revoked device gets 401').toBe(401);
  expect((await c.request.get('/api/auth/me')).status()).toBe(200);

  // revoke all others
  await page.getByRole('button', { name: 'Sign out of all other devices' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out others' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await ev(page, 'sc16-after-revoke-all-others');
  expect((await c.request.get('/api/auth/me')).status()).toBe(401);
  expect((await page.request.get('/api/auth/me')).status(), 'this device stays signed in').toBe(200);
  await b.close(); await c.close();
});

test('sc17 session revoked while a page is open: toast + redirect to /login?next=<current path>', async ({ page, browser, baseURL }) => {
  const u = uniqueUser('end');
  expect((await page.request.post('/api/auth/signup', { data: u })).status()).toBe(201);
  skipOnboarding(u.email);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const other = await deviceContext(browser, baseURL!, u, UA.win);
  const sessions = await (await other.request.get('/api/me/sessions')).json();
  const mine = sessions.items.find((s: { current: boolean }) => !s.current);
  expect(mine, 'A is listed from B').toBeTruthy();
  const del = await other.request.delete(`/api/me/sessions/${mine.id}`);
  expect(del.ok()).toBeTruthy();
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  await ev(page, 'sc17-before-trigger');

  // in-app navigation triggers a data fetch -> 401
  await page.locator('nav[aria-label="Main"] a[href="/pipeline"], nav[aria-label="Primary"] a[href="/pipeline"]').first().click();
  await expect(page.getByText('Your session ended. Please sign in again.').first()).toBeVisible();
  await expect(page).toHaveURL(/\/login\?next=%2Fpipeline/);
  await ev(page, 'sc17-toast-and-redirect');
  await other.close();
});
