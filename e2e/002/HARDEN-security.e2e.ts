import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { APIResponse, Page } from '@playwright/test';
import { test, expect, uniqueUser, evidence, collectRunArtifacts, loginViaUi } from '../support/fixtures';
import { createOrgWithRoles } from '../support/platform';

/**
 * 002 / HARDEN (PR #511, epic #2): cross-cutting QA of T015, T099 / FR-050 and #482 items 1 and 17 as far as they are
 * observable end-to-end. (T100/T101 and the other API checks run as the API suite.) Evidence: qa/evidence/002/HARDEN/qa-*.png.
 */
const SPEC = '002';
const STORY = 'HARDEN';
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, `qa-${name}`);

function skipOnboarding(email: string) {
  execFileSync('psql', [E2E_DB, '-qtAX', '-c', `update organizations set onboarding_state='{"basics":true}' where id in (select m.org_id from memberships m join users u on u.id=m.user_id where u.email='${email}')`]);
}
const isMobileProject = () => test.info().project.name === 'mobile';
const tag = () => (isMobileProject() ? '375' : '1440');

/** Collect CSP-related console errors and other console/page errors. */
function watchConsole(page: Page) {
  const csp: string[] = [];
  const other: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    (/content security policy|refused to (load|apply|execute|connect|frame)|violates the following/i.test(m.text()) ? csp : other).push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => other.push(`pageerror: ${e.message}`));
  return { csp, other };
}
async function installViolationListener(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}
const violations = (page: Page) => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

test.describe('T099 / FR-050 security headers', () => {
  test('API responses carry nosniff, X-Frame-Options DENY, Referrer-Policy no-referrer (200, 401, 404, POST error)', async ({ request, page }) => {
    const cases: Array<[string, () => Promise<APIResponse>, number]> = [
      ['GET /api/health', () => request.get('/api/health'), 200],
      ['GET /api/auth/me (anonymous)', () => request.get('/api/auth/me'), 401],
      ['GET /api/no-such-route', () => request.get('/api/no-such-route'), 404],
      ['POST /api/auth/login (bad credentials)', () => request.post('/api/auth/login', { data: { email: 'nobody@example.in', password: 'wrong-pass-1' } }), 401],
    ];
    const lines: string[] = [];
    for (const [label, call, status] of cases) {
      const res = await call();
      const h = res.headers();
      lines.push(`${label} -> ${res.status()}: nosniff=${h['x-content-type-options']} xfo=${h['x-frame-options']} rp=${h['referrer-policy']} csp=${h['content-security-policy'] ? 'present' : 'absent'} hsts=${h['strict-transport-security'] ?? 'absent'}`);
      expect(res.status(), label).toBe(status);
      expect(h['x-content-type-options'], label).toBe('nosniff');
      expect(h['x-frame-options'], label).toBe('DENY');
      expect(h['referrer-policy'], label).toBe('no-referrer');
      expect(h['content-security-policy'], `${label}: CSP is for the SPA document only`).toBeUndefined();
      expect(h['strict-transport-security'], `${label}: no HSTS over http`).toBeUndefined();
    }
    await page.setContent(`<pre style="font:14px monospace;padding:16px;white-space:pre-wrap">${esc(lines.join('\n'))}</pre>`);
    await ev(page, 'headers-api');
  });

  test('SPA documents (/, /login, deep link fallback) carry CSP with the theme-script hash; assets carry nosniff', async ({ request, page }) => {
    const lines: string[] = [];
    for (const path of ['/', '/login', '/settings/notifications', '/tenders/some-deep-id/analysis']) {
      const res = await request.get(path, { headers: { accept: 'text/html' } });
      const h = res.headers();
      const html = await res.text();
      lines.push(`GET ${path} -> ${res.status()} ${h['content-type']}`);
      expect(res.status(), path).toBe(200);
      expect(h['content-type'], path).toMatch(/text\/html/);
      expect(h['x-content-type-options'], path).toBe('nosniff');
      expect(h['x-frame-options'], path).toBe('DENY');
      expect(h['referrer-policy'], path).toBe('no-referrer');
      const csp = h['content-security-policy'];
      expect(csp, `${path}: CSP`).toBeTruthy();
      expect(csp).toContain("default-src 'self'");
      const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
      expect(inline.length, `${path}: inline theme script present`).toBeGreaterThan(0);
      for (const body of inline) {
        const hash = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
        expect(csp, `${path}: CSP script-src has the computed hash ${hash}`).toContain(hash);
      }
      const scriptSrc = /script-src([^;]*)/.exec(csp!)?.[1] ?? '';
      expect(scriptSrc).not.toContain('unsafe-inline');
      expect(scriptSrc).not.toContain('unsafe-eval');
      expect(csp).toMatch(/frame-ancestors 'none'/);
      expect(csp).toMatch(/img-src[^;]*'self'[^;]*data:[^;]*blob:/);
      lines.push(`  CSP: ${csp}`);
      lines.push(`  inline script hash verified against computed sha256 of ${inline.length} inline script(s)`);
    }
    const index = await (await request.get('/')).text();
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(index)?.[1];
    expect(asset, 'built asset referenced').toBeTruthy();
    const a = await request.get(asset!);
    expect(a.status()).toBe(200);
    expect(a.headers()['x-content-type-options']).toBe('nosniff');
    lines.push(`GET ${asset} -> 200 nosniff=${a.headers()['x-content-type-options']}`);
    await page.setContent(`<pre style="font:13px monospace;padding:16px;white-space:pre-wrap;word-break:break-all">${esc(lines.join('\n'))}</pre>`);
    await ev(page, 'headers-spa');
  });

  test('@mobile login, dashboard and settings render with no CSP violations or console errors', async ({ page }) => {
    if (isMobileProject()) await page.setViewportSize({ width: 375, height: 812 });
    await installViolationListener(page);
    const w = watchConsole(page);

    await page.goto('/login');
    await expect(page.getByRole('button', { name: /sign in|log in/i })).toBeVisible();
    await ev(page, `csp-login-${tag()}`);
    expect(await violations(page), 'login violations').toEqual([]);

    const u = uniqueUser('csp');
    expect((await page.request.post('/api/auth/signup', { data: u })).status()).toBe(201);
    skipOnboarding(u.email);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await ev(page, `csp-dashboard-${tag()}`);
    expect(await violations(page), 'dashboard violations').toEqual([]);

    await page.goto('/settings/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications' }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await ev(page, `csp-settings-${tag()}`);
    expect(await violations(page), 'settings violations').toEqual([]);

    await page.goto('/settings/account');
    await expect(page.getByLabel('Full name')).toBeVisible();
    expect(await violations(page), 'deep-link violations').toEqual([]);

    test.info().annotations.push({ type: 'non-CSP console output', description: w.other.join(' | ') || 'none' });
    expect(w.csp, 'CSP console errors').toEqual([]);
    expect(w.other.filter((l) => !/Failed to load resource/.test(l)), 'other console/page errors').toEqual([]);
  });
});

test.describe('T015 createOrgWithRoles', () => {
  test('helper creates one org with owner + bid_manager/analyst/viewer whose storage states are logged in', async ({ page, browser, playwright }) => {
    const org = await createOrgWithRoles(playwright.request);
    const ctxs = [];
    try {
      expect(Object.keys(org.members).sort()).toEqual(['analyst', 'bid_manager', 'owner', 'viewer']);
      expect(new Set(Object.values(org.members).map((m) => m.email)).size, 'distinct users').toBe(4);
      skipOnboarding(org.owner.email);

      // Owner drives the main `page` (video); the others get their own contexts from their storage states.
      await page.context().addCookies(org.owner.storageState.cookies);
      const pages: Record<string, Page> = { owner: page };
      for (const role of ['bid_manager', 'analyst', 'viewer'] as const) {
        const ctx = await browser.newContext({ storageState: org.members[role].storageState, viewport: page.viewportSize() ?? undefined, locale: 'en-IN' });
        ctxs.push(ctx);
        pages[role] = await ctx.newPage();
      }
      const seen: string[] = [];
      for (const role of ['owner', 'bid_manager', 'analyst', 'viewer'] as const) {
        const p = pages[role];
        const me = await (await p.request.get('/api/auth/me')).json();
        expect(me.user.email, role).toBe(org.members[role].email);
        expect(me.org.id, `${role} is in the same org`).toBe(org.orgId);
        expect(me.role, role).toBe(role);
        seen.push(`${role}: ${me.user.email} role=${me.role} org=${me.org.id}`);
        await p.goto('/settings/account');
        await expect(p.getByLabel('Full name')).toHaveValue(org.members[role].name);
      }
      // The roles really differ: viewer cannot do a bid_manager action, bid_manager can.
      expect((await pages.viewer.request.post('/api/demo/seed')).status(), 'viewer blocked from demo seed').toBe(403);
      const bmSeed = await pages.bid_manager.request.post('/api/demo/seed');
      expect(bmSeed.ok(), await bmSeed.text()).toBeTruthy();
      await ev(pages.viewer, 'roles-viewer-account');
      await ev(pages.analyst, 'roles-analyst-account');
      await ev(pages.bid_manager, 'roles-bid-manager-account');
      await ev(page, 'roles-owner-account');
      test.info().annotations.push({ type: 'members', description: seen.join(' | ') });
    } finally {
      for (const c of ctxs) await c.close().catch(() => undefined);
      await org.dispose();
    }
  });
});

test.describe('#482 item 17 notifications status line', () => {
  test('@mobile status line is sr-only while empty, shows the test-alert result, and is cleared again on save', async ({ page }) => {
    if (isMobileProject()) await page.setViewportSize({ width: 375, height: 812 });
    const u = uniqueUser('notif');
    expect((await page.request.post('/api/auth/signup', { data: u })).status()).toBe(201);
    skipOnboarding(u.email);
    await page.goto('/settings/notifications');
    await expect(page.locator('#n-inapp')).toBeVisible();
    const line = page.locator('p[role="status"]').first();
    await expect(line).toBeAttached();
    await expect(line).toHaveText('');
    const geom = () => line.evaluate((el) => {
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), position: cs.position };
    });
    const empty = await geom();
    expect(empty.w, `empty line takes no layout space: ${JSON.stringify(empty)}`).toBeLessThanOrEqual(1);
    expect(empty.h).toBeLessThanOrEqual(1);
    expect(empty.position).toBe('absolute');
    await ev(page, `notif-status-empty-${tag()}`);

    await page.getByRole('button', { name: 'Send a test alert' }).click();
    await expect(line).toContainText('Test alert:');
    const shown = await geom();
    expect(shown.h, `status visible when filled: ${JSON.stringify(shown)}`).toBeGreaterThan(8);
    expect(shown.position).not.toBe('absolute');
    await ev(page, `notif-status-filled-${tag()}`);

    await page.locator('#n-exp').click();
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Notification preferences saved' })).toBeVisible();
    await expect(line).toHaveText('');
    const cleared = await geom();
    expect(cleared.w).toBeLessThanOrEqual(1);
    expect(cleared.position).toBe('absolute');
    await ev(page, `notif-status-cleared-${tag()}`);
  });
});

test.describe('#482 item 1 rate limiting', () => {
  test('repeated bad logins give 429 rate_limited with Retry-After; even the right password is refused; UI shows the wait', async ({ page, playwright, baseURL }) => {
    const owner = uniqueUser('rl');
    const signup = await playwright.request.newContext({ baseURL });
    expect((await signup.post('/api/auth/signup', { data: owner })).status()).toBe(201);
    await signup.dispose();

    const api = await playwright.request.newContext({ baseURL });
    const statuses: number[] = [];
    let limited: APIResponse | undefined;
    for (let i = 1; i <= 12 && !limited; i++) {
      const r = await api.post('/api/auth/login', { data: { email: owner.email, password: `Wrong!pass${i}xx` } });
      statuses.push(r.status());
      if (r.status() === 429) limited = r;
    }
    expect(limited, `a 429 within 12 bad attempts; statuses ${statuses}`).toBeTruthy();
    expect(statuses.slice(0, -1).every((s) => s === 401), `earlier attempts are 401: ${statuses}`).toBeTruthy();
    expect(statuses.length, 'limit is 10 attempts per email per 15 min -> 11th refused').toBe(11);
    const body = await limited!.json();
    const retry = Number(limited!.headers()['retry-after']);
    expect(JSON.stringify(body)).toContain('rate_limited');
    expect(Number.isInteger(retry) && retry > 0 && retry <= 900, `Retry-After ${limited!.headers()['retry-after']}`).toBeTruthy();
    expect(limited!.headers()['x-content-type-options']).toBe('nosniff');

    const good = await api.post('/api/auth/login', { data: { email: owner.email, password: owner.password } });
    expect(good.status(), 'correct password is also refused while limited').toBe(429);
    await api.dispose();

    await loginViaUi(page, owner.email, owner.password);
    await expect(page.getByText(/too many attempts/i)).toBeVisible();
    await expect(page.getByText(/try again in \d+ minutes?/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    await ev(page, 'rate-limited-login');
    test.info().annotations.push({ type: 'rate-limit', description: `statuses=${statuses.join(',')} retry-after=${retry} body=${JSON.stringify(body)}` });
  });
});
