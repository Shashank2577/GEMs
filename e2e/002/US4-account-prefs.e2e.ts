import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, uniqueUser, signupViaApi as rawSignupViaApi, evidence, collectRunArtifacts } from '../support/fixtures';

/**
 * 002 / US4 (#6): personal account and notification preferences. One test per acceptance scenario (1-8).
 * Scenario numbers are in the test titles; evidence screenshots are named sc<N>-*.png.
 * Scenario 7 (digest scheduling / expiry reminders) is server behaviour with no UI: covered by the API suite.
 */
const SPEC = '002';
const STORY = 'US4';
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
const DEFAULTS = { inApp: true, email: true, whatsapp: false, frequency: 'instant', expiryReminders: true };

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, name);

function skipOnboarding(email: string) {
  execFileSync('psql', [E2E_DB, '-qtAX', '-c', `update organizations set onboarding_state='{"basics":true}' where id in (select m.org_id from memberships m join users u on u.id=m.user_id where u.email='${email}')`]);
}
async function signup(page: Page) {
  const u = await rawSignupViaApi(page, uniqueUser());
  skipOnboarding(u.email);
  return u;
}
const getPrefs = async (page: Page) => (await page.request.get('/api/me/notification-prefs')).json();
const getMe = async (page: Page) => (await page.request.get('/api/auth/me')).json();

/** Toast text region (sonner). */
const toastOf = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text });

async function noHorizontalScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, 'horizontal overflow px').toBeLessThanOrEqual(1);
}

test.describe('sc1-sc5 notification preferences', () => {
  test('sc1 defaults: In-app on, Email on (to their email), WhatsApp off, Instant, Expiry on; Save disabled', async ({ page }) => {
    const u = await signup(page);
    await page.goto('/settings/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications' }).first()).toBeVisible();
    await expect(page.locator('#n-inapp')).toBeChecked();
    await expect(page.locator('#n-email')).toBeChecked();
    await expect(page.locator('#n-wa')).not.toBeChecked();
    await expect(page.locator('#n-exp')).toBeChecked();
    await expect(page.getByText(`To ${u.email}.`)).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Instant' })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Save preferences' })).toBeDisabled();
    await expect(page.getByLabel('WhatsApp number')).toHaveCount(0);
    expect(await getPrefs(page)).toEqual(DEFAULTS);
    await ev(page, 'sc1-defaults');
    // Save becomes enabled once something changes
    await page.locator('#n-exp').click();
    await expect(page.getByRole('button', { name: 'Save preferences' })).toBeEnabled();
    await ev(page, 'sc1-save-enabled-after-change');
  });

  test('sc2 WhatsApp on without a mobile: no request sent, field shows the required-number error', async ({ page }) => {
    await signup(page);
    await page.goto('/settings/notifications');
    await expect(page.locator('#n-wa')).toBeVisible();
    const writes: string[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/me')) writes.push(`${r.method()} ${r.url()}`); });
    await page.locator('#n-wa').click();
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByText('Add a valid 10-digit mobile number to get WhatsApp alerts')).toBeVisible();
    await page.waitForTimeout(600);
    expect(writes).toEqual([]);
    expect((await getMe(page)).user.phone).toBeNull();
    expect((await getPrefs(page)).whatsapp).toBe(false);
    await ev(page, 'sc2-whatsapp-needs-number');
  });

  test('sc3 WhatsApp + 98220 12345 + Daily: PATCH /api/me stores +919822012345, PUT stores prefs, toast, hint; persists after reload', async ({ page }) => {
    await signup(page);
    await page.goto('/settings/notifications');
    await page.locator('#n-wa').click();
    await page.getByLabel('WhatsApp number').fill('98220 12345');
    await expect(page.getByText('We’ll message +919822012345')).toBeVisible();
    await page.getByRole('radio', { name: 'Daily' }).click();
    await ev(page, 'sc3-filled');
    const patch = page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH');
    const put = page.waitForResponse((r) => r.url().endsWith('/api/me/notification-prefs') && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save preferences' }).click();
    const [pr, ur] = await Promise.all([patch, put]);
    expect(pr.request().postDataJSON()).toEqual({ phone: '+919822012345' });
    expect(pr.status()).toBe(200);
    expect(ur.status()).toBe(200);
    expect(ur.request().postDataJSON()).toEqual({ inApp: true, email: true, whatsapp: true, frequency: 'daily', expiryReminders: true });
    await expect(toastOf(page, 'Notification preferences saved')).toBeVisible();
    await expect(page.getByText('We’ll message +919822012345')).toBeVisible();
    await ev(page, 'sc3-saved');
    // Independent test: reload and verify via UI and API
    expect(await getPrefs(page)).toEqual({ inApp: true, email: true, whatsapp: true, frequency: 'daily', expiryReminders: true });
    expect((await getMe(page)).user.phone).toBe('+919822012345');
    await page.reload();
    await expect(page.locator('#n-wa')).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Daily' })).toBeChecked();
    await expect(page.getByLabel('WhatsApp number')).toHaveValue('98220 12345');
    await expect(page.getByText('We’ll message +919822012345')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save preferences' })).toBeDisabled();
    await ev(page, 'sc3-after-reload');
  });

  test('sc4 PUT whatsapp:true for a user with no phone -> 400 details.fields.whatsapp = "Phone number required"', async ({ page }) => {
    await signup(page);
    const res = await page.request.put('/api/me/notification-prefs', { data: { ...DEFAULTS, whatsapp: true } });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error.details.fields.whatsapp).toBe('Phone number required');
    expect(await getPrefs(page)).toEqual(DEFAULTS); // nothing stored
    // Show the API result on screen for the evidence
    await page.goto('/settings/notifications');
    await page.evaluate((b) => { const pre = document.createElement('pre'); pre.id = 'api-evidence'; pre.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;background:#111;color:#0f0;padding:12px;font-size:12px;max-width:520px;white-space:pre-wrap'; pre.textContent = 'PUT /api/me/notification-prefs {whatsapp:true}\n-> 400\n' + JSON.stringify(b, null, 2); document.body.appendChild(pre); }, body);
    await ev(page, 'sc4-api-400');
  });

  test('sc5 user in two orgs: Daily in org A leaves org B unchanged', async ({ page, browser, baseURL }) => {
    const b = await signup(page); // own org B
    const meB = await getMe(page);
    const owner = uniqueUser('ownerA');
    const octx = await browser.newContext({ baseURL: baseURL! });
    try {
      expect((await octx.request.post('/api/auth/signup', { data: owner })).status()).toBe(201);
      skipOnboarding(owner.email);
      const inv = await (await octx.request.post('/api/org/invitations', { data: { email: b.email, role: 'analyst' } })).json();
      const token = String(inv.inviteUrl).split('/invite/')[1];
      const acc = await page.request.post('/api/auth/accept-invite', { data: { token } });
      expect(acc.status(), await acc.text()).toBe(200);
      const meA = await getMe(page);
      expect(meA.org.name).toBe(owner.orgName);
      expect(meA.orgs).toHaveLength(2);
      await page.goto('/settings/notifications');
      await page.getByRole('radio', { name: 'Daily' }).click();
      await page.getByRole('button', { name: 'Save preferences' }).click();
      await expect(toastOf(page, 'Notification preferences saved')).toBeVisible();
      expect((await getPrefs(page)).frequency).toBe('daily');
      await ev(page, 'sc5-org-a-daily');
      const sw = await page.request.post('/api/auth/switch-org', { data: { orgId: meB.org.id } });
      expect(sw.status()).toBe(200);
      expect((await getPrefs(page)).frequency).toBe('instant');
      await page.goto('/settings/notifications');
      await expect(page.getByRole('radio', { name: 'Instant' })).toBeChecked();
      await ev(page, 'sc5-org-b-still-instant');
      expect((await page.request.post('/api/auth/switch-org', { data: { orgId: meA.org.id } })).status()).toBe(200);
      expect((await getPrefs(page)).frequency).toBe('daily');
    } finally { await octx.close(); }
  });
});

test.describe('sc6 profile', () => {
  test('sc6 name "Priya S." + mobile 9822012345 -> 200 Me, toast, initials/user menu update; invalid 12345 error; Email read-only', async ({ page }) => {
    const u = await signup(page);
    await page.goto('/settings/account');
    const email = page.getByLabel('Email');
    await expect(email).toHaveValue(u.email);
    await expect(email).toHaveAttribute('readonly', '');
    await expect(page.getByText('Contact your org owner to change it.')).toBeVisible();
    await ev(page, 'sc6-account-initial');

    // invalid mobile first
    const patches: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().endsWith('/api/me')) patches.push(r.url()); });
    await page.getByLabel('Mobile (WhatsApp)').fill('12345');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Enter a 10-digit Indian mobile number starting with 6–9')).toBeVisible();
    await page.waitForTimeout(500);
    expect(patches).toEqual([]);
    await ev(page, 'sc6-invalid-mobile');

    // valid edit
    await page.getByLabel('Full name').fill('Priya S.');
    await page.getByLabel('Mobile (WhatsApp)').fill('9822012345');
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ name: 'Priya S.', phone: '+919822012345' });
    const me = await res.json();
    expect(me.user).toMatchObject({ name: 'Priya S.', phone: '+919822012345', email: u.email });
    expect(me.org).toBeTruthy();
    await expect(toastOf(page, 'Profile saved')).toBeVisible();
    // no reload: avatar initials + user menu updated
    const trigger = page.getByRole('button', { name: 'Account menu' }).first();
    await expect(trigger).toContainText('PS');
    await trigger.click();
    await expect(page.getByRole('menu').getByText('Priya S.', { exact: true })).toBeVisible();
    await ev(page, 'sc6-saved-menu-updated');
    await page.keyboard.press('Escape');
    // persisted
    expect((await getMe(page)).user).toMatchObject({ name: 'Priya S.', phone: '+919822012345' });
    await page.reload();
    await expect(page.getByLabel('Full name')).toHaveValue('Priya S.');
    await expect(page.getByLabel('Mobile (WhatsApp)')).toHaveValue('98220 12345');
  });
});

test.describe('sc7 digest and expiry reminders', () => {
  test('sc7 Daily/expiry preference choices are stored for the server-side digest (behaviour asserted in API suite)', async ({ page }) => {
    await signup(page);
    await page.goto('/settings/notifications');
    await page.getByRole('radio', { name: 'Daily' }).click();
    await page.locator('#n-exp').click();
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(toastOf(page, 'Notification preferences saved')).toBeVisible();
    expect(await getPrefs(page)).toEqual({ ...DEFAULTS, frequency: 'daily', expiryReminders: false });
    await ev(page, 'sc7-daily-expiry-off-stored');
    // Held email/WhatsApp + one digest per org per IST day from 08:00 IST, and no vault expiry reminders when off, are
    // server behaviour (alerts.ts / vault scheduler) with no UI: ingest.test.ts "daily digest..." and vault.test.ts
    // expiryReminders:false cases in api-tests.txt.
  });
});

test.describe('sc8 test alert', () => {
  test('sc8 "Send a test alert": in-app notification created; short toast; per-channel outcome in the inline status line', async ({ page }) => {
    await signup(page);
    await page.goto('/settings/notifications');
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/me/notifications/test') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Send a test alert' }).click(),
    ]);
    expect(res.status()).toBe(200);
    const r = await res.json();
    expect(r.inApp).toBe('sent');
    expect(r.whatsapp).toBe('off');
    expect(['sent', 'skipped', 'failed']).toContain(r.email);
    const expectedEmail = r.email === 'sent' ? 'Email sent' : r.email === 'failed' ? 'Email failed to send' : 'Email not configured on this server';
    const status = page.getByRole('status').filter({ hasText: 'Test alert:' });
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toContainText('In-app sent');
    await expect(status).toContainText(expectedEmail);
    await expect(status).toContainText('WhatsApp is off');
    // the toast is a short one-liner (no per-channel detail)
    const t = toastOf(page, /Test alert sent/);
    await expect(t).toBeVisible();
    expect((await t.innerText()).replace(/\s+/g, ' ').trim().length).toBeLessThan(45);
    await expect(t).not.toContainText('In-app sent');
    await expect(t).not.toContainText('WhatsApp');
    if (r.email === 'sent') await expect(t).toContainText(/^Test alert sent$/m); else await expect(t).toContainText('Test alert sent with warnings');
    // the toast does not cover the footer buttons
    const tb = (await t.boundingBox())!;
    for (const name of ['Send a test alert', 'Save preferences']) {
      const bb = (await page.getByRole('button', { name }).boundingBox())!;
      const overlap = tb.x < bb.x + bb.width && tb.x + tb.width > bb.x && tb.y < bb.y + bb.height && tb.y + tb.height > bb.y;
      expect(overlap, `toast overlaps "${name}" button`).toBe(false);
    }
    await ev(page, 'sc8-test-alert-status-line');
    await page.screenshot({ path: 'qa/evidence/002/US4/sc8-toast-vs-footer-desktop.png' });
    // the in-app notification exists with the exact title
    const list = await (await page.request.get('/api/notifications')).json();
    expect(JSON.stringify(list)).toContain('Test alert from TenderPilot');
    await page.goto('/notifications');
    await expect(page.getByText('Test alert from TenderPilot').first()).toBeVisible();
    await ev(page, 'sc8-notification-listed');
  });

  test('sc8c in-app preference OFF: the test alert still creates the in-app notification', async ({ page }) => {
    await signup(page);
    await page.goto('/settings/notifications');
    await page.locator('#n-inapp').click();
    await expect(page.locator('#n-inapp')).not.toBeChecked();
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(toastOf(page, 'Notification preferences saved')).toBeVisible();
    expect((await getPrefs(page)).inApp).toBe(false);
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/me/notifications/test') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Send a test alert' }).click(),
    ]);
    expect(res.status()).toBe(200);
    expect((await res.json()).inApp).toBe('sent');
    await expect(page.getByRole('status').filter({ hasText: 'Test alert:' })).toContainText('In-app sent');
    expect((await getPrefs(page)).inApp).toBe(false);
    const list = await (await page.request.get('/api/notifications')).json();
    expect(JSON.stringify(list)).toContain('Test alert from TenderPilot');
    await page.goto('/notifications');
    await expect(page.getByText('Test alert from TenderPilot').first()).toBeVisible();
    await ev(page, 'sc8c-in-app-off-still-created');
  });

  test('sc8b second test alert within a minute -> 429 with friendly message in toast and inline status line', async ({ page }) => {
    await signup(page);
    await page.goto('/settings/notifications');
    await page.getByRole('button', { name: 'Send a test alert' }).click();
    await expect(toastOf(page, /Test alert sent/)).toBeVisible();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/me/notifications/test')),
      page.getByRole('button', { name: 'Send a test alert' }).click(),
    ]);
    expect(res.status()).toBe(429);
    await expect(toastOf(page, /one test alert a minute/)).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Test alert:' })).toContainText(/one test alert a minute/);
    await ev(page, 'sc8b-rate-limited');
  });
});

test.describe('@mobile layout', () => {
  test('@mobile notifications section fits the phone viewport; WhatsApp field, switches and buttons usable', async ({ page }) => {
    await signup(page);
    await page.goto('/settings/notifications');
    await expect(page.locator('#n-wa')).toBeVisible();
    await page.locator('#n-wa').click();
    await expect(page.getByLabel('WhatsApp number')).toBeVisible();
    await noHorizontalScroll(page);
    for (const btn of ['Send a test alert', 'Save preferences']) {
      const box = await page.getByRole('button', { name: btn }).boundingBox();
      const vw = page.viewportSize()!.width;
      expect(box && box.x >= 0 && box.x + box.width <= vw, `${btn} inside viewport`).toBeTruthy();
    }
    await ev(page, 'mobile-notifications');
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByText('Add a valid 10-digit mobile number to get WhatsApp alerts')).toBeVisible();
    await noHorizontalScroll(page);
    await ev(page, 'mobile-notifications-error');
  });

  test('@mobile account section fits viewport; invalid mobile error and read-only Email visible', async ({ page }) => {
    await signup(page);
    await page.goto('/settings/account');
    await expect(page.getByLabel('Full name')).toBeVisible();
    await noHorizontalScroll(page);
    await page.getByLabel('Mobile (WhatsApp)').fill('12345');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Enter a 10-digit Indian mobile number starting with 6–9')).toBeVisible();
    await noHorizontalScroll(page);
    await ev(page, 'mobile-account-invalid');
    await page.getByLabel('Full name').fill('Priya S.');
    await page.getByLabel('Mobile (WhatsApp)').fill('9822012345');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toastOf(page, 'Profile saved')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account menu' }).first()).toContainText('PS');
    await ev(page, 'mobile-account-saved');
  });
  test('@mobile test alert: toast sits above the tab bar, status line shows per-channel result, buttons reachable', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, 'tab bar exists only on the phone viewport (mobile project)');
    await signup(page);
    await page.goto('/settings/notifications');
    await page.getByRole('button', { name: 'Send a test alert' }).click();
    const status = page.getByRole('status').filter({ hasText: 'Test alert:' });
    await expect(status).toContainText('In-app sent');
    const t = toastOf(page, /Test alert sent/);
    await expect(t).toBeVisible();
    await page.waitForTimeout(600); // let the toast finish its enter animation
    const tb = (await t.boundingBox())!;
    const bar = (await page.getByRole('navigation', { name: 'Primary' }).boundingBox())!;
    expect(tb.y + tb.height, `toast bottom ${tb.y + tb.height} must be above tab bar top ${bar.y}`).toBeLessThanOrEqual(bar.y + 1);
    await noHorizontalScroll(page);
    await page.screenshot({ path: 'qa/evidence/002/US4/mobile-toast-above-tab-bar.png' });
  });
});
