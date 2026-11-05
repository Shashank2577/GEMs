import { execFileSync } from 'node:child_process';
import { request as playwrightRequest, type Locator, type Page } from '@playwright/test';
import { test, expect, uniqueUser, signupViaApi as rawSignupViaApi, inviteAs, evidence, collectRunArtifacts, a11y, atPhone, noHorizontalOverflow } from '../support/fixtures';

/**
 * 002 / US7 (#9): app shell, navigation, command palette, theme and design system (T098).
 * One test per acceptance scenario (1-12); scenario numbers are in the titles, evidence screenshots are sc<N>-*.png.
 * Tests tagged @mobile run in both the desktop and the Pixel 7 projects and force a 375 px viewport.
 * Scenario 10 "activity": the Activity log palette entry is gated `ready:false` until US6/T085, so that single
 * assertion is skipped as "unverifiable - depends on US6 T085" (the other three queries are asserted).
 */
const SPEC = '002';
const STORY = 'US7';
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, name);

function skipOnboarding(email: string) {
  execFileSync('psql', [E2E_DB, '-qtAX', '-c', `update organizations set onboarding_state='{"basics":true}' where id in (select m.org_id from memberships m join users u on u.id=m.user_id where u.email='${email}')`]);
}
async function signup(page: Page) {
  const u = await rawSignupViaApi(page, uniqueUser('shell'));
  skipOnboarding(u.email);
  return u;
}
/** Load an app route and wait until the shell and the page body are rendered. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('main#main')).toBeVisible();
  await page.waitForLoadState('networkidle');
}
/** Settle: no skeletons and no running finite CSS animations/transitions (Radix menus, dialogs and palette fade in) so axe never measures blended colours. */
async function settle(page: Page) {
  await expect(page.locator('[data-skeleton], .animate-pulse')).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
}
const desktopOnly = (title: string) => test.info().project.name === 'desktop' || test.skip(true, title);

const palette = (page: Page) => page.getByRole('dialog').filter({ has: page.getByPlaceholder(/Search pages, actions/) });
const mod = 'Control';
async function openPalette(page: Page) {
  await page.keyboard.press(`${mod}+k`);
  await expect(palette(page)).toBeVisible();
  return palette(page);
}
const groupHeadings = (p: Locator) => p.locator('[cmdk-group-heading]');
const cssFlag = (page: Page) => page.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), stored: (() => { try { return localStorage.getItem('tp-theme'); } catch { return 'blocked'; } })() }));

async function newOrgOwner(baseURL: string) {
  const api = await playwrightRequest.newContext({ baseURL });
  const user = uniqueUser('orgb');
  const res = await api.post('/api/auth/signup', { data: user });
  expect(res.status(), await res.text()).toBe(201);
  skipOnboarding(user.email);
  const me = await (await api.get('/api/auth/me')).json();
  return { api, user, me };
}

/* ───────────────────────────── 1. Desktop shell ───────────────────────────── */

test('sc1 desktop shell: 248px sidebar with logo, org switcher, search, nav groups, co-pilot card, active highlight + indicator', async ({ page }) => {
  const u = await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/dashboard');
  const side = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(side).toBeVisible();
  expect((await side.boundingBox())!.width).toBe(248);
  await expect(side.getByRole('link', { name: 'TenderPilot home' })).toBeVisible();
  const switcher = side.getByRole('button', { name: /Switch organization/ });
  await expect(switcher).toContainText(u.orgName);
  await expect(switcher).toContainText(/plan · Owner/i);
  const search = side.getByRole('button', { name: /Search…/ });
  await expect(search).toContainText('Ctrl');
  await expect(search).toContainText('K');
  const main = side.getByRole('navigation', { name: 'Main' });
  for (const l of ['Dashboard', 'Tenders', 'Watchlists', 'Pipeline', 'Document vault']) await expect(main.getByRole('link', { name: l, exact: true })).toBeVisible();
  await expect(side.getByText('Organization', { exact: true })).toBeVisible();
  for (const l of ['Company profile', 'Notifications', 'Settings']) await expect(main.getByRole('link', { name: l, exact: true })).toBeVisible();
  await expect(side.getByText('Co-pilot mode')).toBeVisible();
  const active = main.getByRole('link', { name: 'Dashboard', exact: true });
  await expect(active).toHaveAttribute('aria-current', 'page');
  await expect(active).toHaveClass(/bg-card/);
  await expect(active.locator('.bg-sidebar-active')).toHaveCount(1);
  await expect(main.getByRole('link', { name: 'Tenders', exact: true })).not.toHaveClass(/bg-card/);
  await ev(page, 'sc1-desktop-shell-248');
});

/* ───────────────────────────── 2. Collapse persistence ───────────────────────────── */

test('sc2 collapse sidebar: 64px icons-only with tooltips, content shifts left, persists across reload (tp-sidebar-collapsed)', async ({ page }) => {
  await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/dashboard');
  const side = page.getByRole('complementary', { name: 'Sidebar' });
  const mainEl = page.locator('main#main');
  const x0 = (await mainEl.boundingBox())!.x;
  expect(x0).toBe(248);
  await side.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect.poll(async () => (await side.boundingBox())!.width).toBe(64);
  await expect.poll(async () => (await mainEl.boundingBox())!.x).toBe(64);
  expect(await page.evaluate(() => localStorage.getItem('tp-sidebar-collapsed'))).toBe('true');
  await expect(side.getByText('Co-pilot mode')).toHaveCount(0);
  await expect(side.getByRole('button', { name: /Search…/ })).toHaveCount(0);
  // labels are icon-only but still accessible; tooltip shows on hover
  const tenders = side.getByRole('link', { name: 'Tenders' });
  await tenders.hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'Tenders' })).toBeVisible();
  await ev(page, 'sc2-collapsed-64-tooltip');
  // persists across reload
  await page.reload();
  await expect(page.locator('main#main')).toBeVisible();
  await expect.poll(async () => (await side.boundingBox())!.width).toBe(64);
  expect((await mainEl.boundingBox())!.x).toBe(64);
  await ev(page, 'sc2-collapsed-after-reload');
  // expand again and persist
  await side.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect.poll(async () => (await side.boundingBox())!.width).toBe(248);
  expect(await page.evaluate(() => localStorage.getItem('tp-sidebar-collapsed'))).toBe('false');
  await page.reload();
  await expect.poll(async () => (await side.boundingBox())!.width).toBe(248);
  await ev(page, 'sc2-expanded-after-reload');
});

/* ───────────────────────────── 3. Phone shell ───────────────────────────── */

test('sc3 @mobile 375px: no horizontal scroll, top bar (menu, logo, search, bell, avatar), tab bar Home/Tenders/Pipeline/Vault/More, drawer closes on navigation', async ({ page }) => {
  await signup(page);
  await atPhone(page);
  await open(page, '/dashboard');
  await noHorizontalOverflow(page);
  const header = page.locator('header');
  await expect(header.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'TenderPilot home' })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: /^Notifications/ })).toBeVisible();
  await expect(header.getByRole('button', { name: /Account menu/ })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();
  const tabs = page.getByRole('navigation', { name: 'Primary' });
  await expect(tabs).toBeVisible();
  const items = await tabs.locator('li').allInnerTexts();
  expect(items.map((s) => s.trim())).toEqual(['Home', 'Tenders', 'Pipeline', 'Vault', 'More']);
  // touch targets >= 40px (NFR-005)
  for (const el of await tabs.locator('a, button').all()) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await ev(page, 'sc3-mobile-shell-375');
  // tab navigation
  await tabs.getByRole('link', { name: 'Tenders' }).click();
  await expect(page).toHaveURL(/\/tenders$/);
  await noHorizontalOverflow(page);
  // "More" opens the full navigation drawer, which closes on navigation
  await tabs.getByRole('button', { name: 'More' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toBeVisible();
  for (const l of ['Dashboard', 'Tenders', 'Watchlists', 'Pipeline', 'Document vault', 'Company profile', 'Notifications', 'Settings']) await expect(drawer.getByRole('link', { name: l, exact: true })).toBeVisible();
  await ev(page, 'sc3-drawer-via-more');
  await drawer.getByRole('link', { name: 'Watchlists', exact: true }).click();
  await expect(page).toHaveURL(/\/watchlists$/);
  await expect(drawer).toBeHidden();
  // menu button opens it too
  await header.getByRole('button', { name: 'Open navigation' }).click();
  await expect(drawer).toBeVisible();
  await ev(page, 'sc3-drawer-via-menu-button');
  await drawer.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(drawer).toBeHidden();
  await noHorizontalOverflow(page);
});

/* ───────────────────────────── 4. Command palette ───────────────────────────── */

test('sc4 palette: Ctrl+K and "/" open, groups, filter, tender search (>=2 chars) opens /tenders?q=, Esc closes, Owner quick actions + preferences', async ({ page }) => {
  await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/dashboard');
  const p = await openPalette(page);
  await expect(groupHeadings(p)).toContainText(['Go to', 'Settings', 'Quick actions', 'Preferences']);
  for (const l of ['Dashboard', 'Tenders', 'Watchlists', 'Pipeline', 'Document vault', 'Company profile']) await expect(p.getByRole('option', { name: new RegExp(l) }).first()).toBeVisible();
  for (const l of ['Create a watchlist', 'Upload to document vault', 'Invite a teammate', 'Light theme', 'Dark theme', 'System theme', 'Sign out']) await expect(p.getByRole('option', { name: l })).toBeVisible();
  await ev(page, 'sc4-palette-open-ctrl-k');
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await page.keyboard.press('/');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  // header search buttons
  await page.locator('header').getByRole('button', { name: /Search tenders, pages, actions/ }).click();
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /Search…/ }).click();
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
  // filtering
  await openPalette(page);
  await page.getByPlaceholder(/Search pages, actions/).fill('vault');
  await expect(p.getByRole('option', { name: /Document vault/ }).first()).toBeVisible();
  await expect(p.getByRole('option', { name: /Pipeline/ })).toHaveCount(0);
  await ev(page, 'sc4-palette-filter-vault');
  // one character: no tender search; two or more: search option
  await page.getByPlaceholder(/Search pages, actions/).fill('x');
  await expect(p.getByText(/Search tenders for/)).toHaveCount(0);
  await page.getByPlaceholder(/Search pages, actions/).fill('road');
  const searchOpt = p.getByRole('option', { name: /Search tenders for/ }).filter({ hasText: 'road' });
  await expect(searchOpt).toBeVisible();
  await ev(page, 'sc4-palette-tender-search-option');
  await searchOpt.click();
  await expect(page).toHaveURL(/\/tenders\?q=road$/);
  await expect(palette(page)).toBeHidden();
  // Owner quick actions navigate
  await openPalette(page);
  await p.getByRole('option', { name: 'Invite a teammate' }).click();
  await expect(page).toHaveURL(/\/settings\/team$/);
  await openPalette(page);
  await p.getByRole('option', { name: 'Create a watchlist' }).click();
  await expect(page).toHaveURL(/\/watchlists\?new=1$/);
  await expect(page.getByRole('dialog', { name: 'New watchlist' })).toBeVisible(); // the action opens the creation dialog
  await ev(page, 'sc4-quick-action-create-watchlist');
  await open(page, '/dashboard');
  await openPalette(page);
  await p.getByRole('option', { name: 'Upload to document vault' }).click();
  await expect(page).toHaveURL(/\/vault\?upload=1$/);
  await ev(page, 'sc4-quick-action-upload-vault');
  await open(page, '/dashboard');
  // preferences: dark theme from the palette, then sign out
  await openPalette(page);
  await p.getByRole('option', { name: 'Dark theme' }).click();
  expect(await cssFlag(page)).toEqual({ dark: true, stored: 'dark' });
  await openPalette(page);
  await p.getByRole('option', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await ev(page, 'sc4-signed-out-from-palette');
});

test('sc4 palette quick actions are role-filtered: Bid Manager / Analyst / Viewer', async ({ page, browser }) => {
  await signup(page);
  const labels = { watch: 'Create a watchlist', vault: 'Upload to document vault', invite: 'Invite a teammate' };
  const expected = { bid_manager: [true, true, true], analyst: [true, true, false], viewer: [false, false, false] } as const;
  for (const role of ['bid_manager', 'analyst', 'viewer'] as const) {
    const member = await inviteAs(page.request, role);
    const mp = await member.newPage(browser);
    await mp.setViewportSize({ width: 1440, height: 900 });
    await open(mp, '/dashboard');
    const p = await openPalette(mp);
    const [w, v, i] = expected[role];
    await expect(p.getByRole('option', { name: labels.watch })).toHaveCount(w ? 1 : 0);
    await expect(p.getByRole('option', { name: labels.vault })).toHaveCount(v ? 1 : 0);
    await expect(p.getByRole('option', { name: labels.invite })).toHaveCount(i ? 1 : 0);
    // preferences stay available to every role
    for (const l of ['Light theme', 'Dark theme', 'System theme', 'Sign out']) await expect(p.getByRole('option', { name: l })).toBeVisible();
    await ev(mp, `sc4-palette-quick-actions-${role}`);
    await mp.close();
  }
  await ev(page, 'sc4-roles-done');
});

/* ───────────────────────────── 5. G-shortcuts ───────────────────────────── */

test('sc5 "G then key" navigates (D/T/W/P/V/C/S/N), not inside text fields, and not after 1.2 s', async ({ page }) => {
  await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/dashboard');
  const targets: [string, RegExp][] = [
    ['t', /\/tenders$/], ['w', /\/watchlists$/], ['p', /\/pipeline$/], ['v', /\/vault$/], ['c', /\/profile$/],
    ['s', /\/settings(\/organization)?$/], ['n', /\/notifications$/], ['d', /\/dashboard$/],
  ];
  for (const [k, url] of targets) {
    await page.keyboard.press('g');
    await page.keyboard.press(k);
    await expect(page, `g then ${k}`).toHaveURL(url);
    await expect(page.locator('main#main')).toBeVisible();
  }
  await ev(page, 'sc5-g-then-d-dashboard');
  // too slow: second key after > 1.2 s does nothing
  await page.keyboard.press('g');
  await page.waitForTimeout(1400);
  await page.keyboard.press('t');
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/dashboard$/);
  // typing in a text field never triggers shortcuts (and "?" does not open help)
  await openPalette(page);
  const input = page.getByPlaceholder(/Search pages, actions/);
  await input.pressSequentially('gt?');
  await expect(input).toHaveValue('gt?');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);
  await ev(page, 'sc5-no-shortcuts-while-typing');
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  // Also from another page via the same keys
  await page.keyboard.press('g');
  await page.keyboard.press('v');
  await expect(page).toHaveURL(/\/vault$/);
});

/* ───────────────────────────── 6. Theme ───────────────────────────── */

test('sc6 theme: System + dark OS renders dark with no light frame; Light/Dark persist in tp-theme from toggle, account menu and palette', async ({ page }) => {
  await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  // sample the <html> class on every frame from the very first one
  await page.addInitScript(() => {
    const w = window as unknown as { __frames: number; __lightFrames: number; __firstDark: boolean | null };
    w.__frames = 0; w.__lightFrames = 0; w.__firstDark = null;
    const tick = () => {
      const root = document.documentElement;
      if (root) {
        const dark = root.classList.contains('dark');
        if (w.__firstDark === null) w.__firstDark = dark;
        w.__frames += 1; if (!dark) w.__lightFrames += 1;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto('/dashboard');
  await expect(page.locator('main#main')).toBeVisible();
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => { const w = window as any; return { frames: w.__frames, light: w.__lightFrames, firstDark: w.__firstDark, stored: localStorage.getItem('tp-theme'), bg: getComputedStyle(document.body).backgroundColor }; });
  expect(s.stored, 'no preference stored yet = System').toBeNull();
  expect(s.frames).toBeGreaterThan(5);
  expect(s.firstDark, 'first frame already dark').toBe(true);
  expect(s.light, 'light frames before/after load').toBe(0);
  await ev(page, 'sc6-system-dark-no-flash');

  // top-bar toggle -> Light
  const toggle = page.locator('header').getByRole('button', { name: /^Theme:/ });
  await toggle.click();
  await page.getByRole('menuitemradio', { name: 'Light' }).click();
  expect(await cssFlag(page)).toEqual({ dark: false, stored: 'light' });
  await page.reload();
  await expect(page.locator('main#main')).toBeVisible();
  expect(await cssFlag(page)).toEqual({ dark: false, stored: 'light' }); // explicit Light beats dark OS
  await ev(page, 'sc6-light-persisted-over-dark-os');

  // account menu -> Theme -> Dark
  await page.locator('header').getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: /^Theme/ }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  expect(await cssFlag(page)).toEqual({ dark: true, stored: 'dark' });
  await page.reload();
  await expect(page.locator('main#main')).toBeVisible();
  expect(await cssFlag(page)).toEqual({ dark: true, stored: 'dark' });
  await ev(page, 'sc6-dark-persisted-account-menu');

  // palette -> Light theme, then System follows the OS live
  await openPalette(page);
  await palette(page).getByRole('option', { name: 'Light theme' }).click();
  expect(await cssFlag(page)).toEqual({ dark: false, stored: 'light' });
  await openPalette(page);
  await palette(page).getByRole('option', { name: 'System theme' }).click();
  expect(await cssFlag(page)).toEqual({ dark: true, stored: 'system' }); // OS is dark
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(async () => (await cssFlag(page)).dark).toBe(false);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(async () => (await cssFlag(page)).dark).toBe(true);
  await ev(page, 'sc6-system-follows-os');
});

/* ───────────────────────────── 7. Skip link + focus ───────────────────────────── */

test('sc7 keyboard: first Tab stop is "Skip to content", focus rings on every stop, focus moves to <main id="main"> after route change', async ({ page }) => {
  await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/dashboard');
  await page.keyboard.press('Tab');
  const first = page.locator(':focus');
  await expect(first).toHaveText('Skip to content');
  await expect(first).toBeInViewport();
  await ev(page, 'sc7-skip-link-first-tab-stop');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');

  // focus ring visible on every tab stop in the shell
  await page.reload();
  await expect(page.locator('main#main')).toBeVisible();
  const missing: string[] = [];
  // Stop 1 is the skip link, which is hidden until focused and then shown as a solid pill with a focus ring; style recorded below.
  await page.keyboard.press('Tab');
  const skipStyle = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement as HTMLElement); return { text: document.activeElement?.textContent, boxShadow: cs.boxShadow, outlineStyle: cs.outlineStyle, background: cs.backgroundColor }; });
  test.info().annotations.push({ type: 'skip-link focus style', description: JSON.stringify(skipStyle) });
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const cs = getComputedStyle(el);
      const ring = (cs.boxShadow && cs.boxShadow !== 'none') || (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0);
      return { ring: !!ring, label: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}"` };
    });
    if (!info.ring) missing.push(info.label);
    if (i === 3) await ev(page, 'sc7-focus-ring-visible');
  }
  expect(missing, 'tab stops without a visible focus ring').toEqual([]);

  // focus moves to <main> after each route change (click and keyboard shortcut)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tenders', exact: true }).click();
  await expect(page).toHaveURL(/\/tenders$/);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main');
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press('g'); await page.keyboard.press('p');
  await expect(page).toHaveURL(/\/pipeline$/);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main');
  await ev(page, 'sc7-focus-on-main-after-route-change');
});

/* ───────────────────────────── 8. Error boundary + 404 ───────────────────────────── */

test('sc8 unknown URL shows "This page went off the map" with "Open dashboard"', async ({ page }) => {
  await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/definitely-not-a-page');
  await expect(page.getByRole('heading', { name: 'This page went off the map' })).toBeVisible();
  await ev(page, 'sc8-404-page');
  await page.getByRole('link', { name: 'Open dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('main#main')).toBeVisible();
});

test('sc8 failed lazy chunk -> "A new version of TenderPilot is available"; other render error -> "This page hit a snag"', async ({ page }) => {
  await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/dashboard');
  const chunkNav = (path: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: path, exact: true }).click();

  // 1) chunk fetch fails (as after a deploy): block the Watchlists page chunk
  await page.route(/\/assets\/.*[Ww]atchlist.*\.js/, (r) => r.abort());
  await chunkNav('Watchlists');
  await expect(page.getByText('A new version of TenderPilot is available')).toBeVisible();
  await expect(page.getByText('Reload to get the latest version.')).toBeVisible();
  await ev(page, 'sc8-chunk-load-failed-new-version');
  await page.unroute(/\/assets\/.*[Ww]atchlist.*\.js/);

  // 2) a page module that throws while evaluating -> generic error
  await chunkNav('Dashboard');
  await expect(page.locator('main#main')).toBeVisible();
  await page.route(/\/assets\/.*[Pp]ipeline.*\.js/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'throw new Error("render boom");' }));
  await chunkNav('Pipeline');
  await expect(page.getByText('This page hit a snag')).toBeVisible();
  await ev(page, 'sc8-render-error-snag');
  // the shell survives and navigating away recovers
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
  await page.unroute(/\/assets\/.*[Pp]ipeline.*\.js/);
  await chunkNav('Dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('This page hit a snag')).toHaveCount(0);
});

/* ───────────────────────────── 9. Reduced motion ───────────────────────────── */

test('sc9 prefers-reduced-motion: route changes are not animated (opacity/transform never leave rest state)', async ({ page }) => {
  await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const sample = async () => page.evaluate(() => new Promise<{ minOpacity: number; moved: boolean; frames: number }>((resolve) => {
    const find = () => document.querySelector('main#main > div > div') as HTMLElement | null;
    let minOpacity = 1; let moved = false; let frames = 0; const t0 = performance.now();
    const tick = () => {
      const el = find();
      if (el) { const cs = getComputedStyle(el); minOpacity = Math.min(minOpacity, parseFloat(cs.opacity)); if (cs.transform !== 'none' && cs.transform !== 'matrix(1, 0, 0, 1, 0, 0)') moved = true; }
      frames += 1;
      if (performance.now() - t0 < 700) requestAnimationFrame(tick); else resolve({ minOpacity, moved, frames });
    };
    requestAnimationFrame(tick);
  }));
  const navTo = (name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // Lazy chunks are fetched on first visit (the skeleton shows, no transition); warm them up so the transition runs.
  const warm = async () => { for (const n of ['Tenders', 'Pipeline', 'Document vault', 'Dashboard']) { await navTo(n); await page.waitForLoadState('networkidle'); await page.waitForTimeout(400); } };

  // control: with motion allowed, the route wrapper animates
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open(page, '/dashboard');
  await warm();
  const pending = sample(); await navTo('Tenders'); const normal = await pending;
  expect(normal.minOpacity < 1 || normal.moved, `control animates: ${JSON.stringify(normal)}`).toBe(true);

  // reduced motion
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/dashboard');
  await warm();
  const results: unknown[] = [];
  for (const name of ['Tenders', 'Pipeline', 'Document vault']) {
    const p = sample(); await navTo(name); const r = await p; results.push(r);
    expect(r.frames).toBeGreaterThan(10);
    expect(r.minOpacity, `${name} opacity`).toBe(1);
    expect(r.moved, `${name} transform`).toBe(false);
  }
  test.info().annotations.push({ type: 'reduced-motion samples', description: JSON.stringify({ normal, reduced: results }) });
  await ev(page, 'sc9-reduced-motion-route-change');
});

/* ───────────────────────────── 10. Palette: Settings sub-pages (gap) ───────────────────────────── */

test('sc10 palette lists Settings sub-pages for "team", "api token", "notification settings" and opens the right sub-route', async ({ page }) => {
  await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/dashboard');
  const cases: [string, string, RegExp][] = [
    ['team', 'Team & roles', /\/settings\/team$/],
    ['api token', 'API tokens & extension', /\/settings\/api-tokens$/],
    ['notification settings', 'Notifications', /\/settings\/notifications$/],
  ];
  for (const [q, label, url] of cases) {
    const p = await openPalette(page);
    await page.getByPlaceholder(/Search pages, actions/).fill(q);
    const settings = p.locator('[cmdk-group]').filter({ has: page.locator('[cmdk-group-heading]', { hasText: 'Settings' }) });
    await expect(settings, `"${q}" shows a Settings group`).toBeVisible();
    const hit = settings.getByRole('option', { name: new RegExp(label.replace(/[&]/g, '\\&')) });
    await expect(hit, `"${q}" -> ${label}`).toBeVisible();
    await ev(page, `sc10-palette-${q.replace(/\s+/g, '-')}`);
    await hit.click();
    await expect(page).toHaveURL(url);
    await expect(page.locator('main#main')).toBeVisible();
  }
});

test('sc10 palette query "activity" shows Activity log under Settings (unverifiable - depends on US6 T085)', async ({ page }) => {
  await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/dashboard');
  const p = await openPalette(page);
  await page.getByPlaceholder(/Search pages, actions/).fill('activity');
  await page.waitForTimeout(300);
  const hit = p.getByRole('option', { name: /Activity log/ });
  await ev(page, 'sc10-palette-activity-query');
  if ((await hit.count()) === 0) test.skip(true, 'unverifiable - depends on US6 T085 (Activity log palette entry is gated ready:false until /settings/activity ships)');
  await hit.click();
  await expect(page).toHaveURL(/\/settings\/activity$/);
});

/* ───────────────────────────── 11. "?" shortcuts dialog (gap) ───────────────────────────── */

test('sc11 "?" opens the Keyboard shortcuts dialog listing Ctrl K, /, G+letter shortcuts and Esc; also from the user menu and palette', async ({ page }) => {
  await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/tenders');
  await page.keyboard.press('?');
  const dlg = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Open the command palette');
  await expect(dlg.getByText('Ctrl', { exact: true })).toBeVisible();
  await expect(dlg.getByText('K', { exact: true }).first()).toBeVisible();
  await expect(dlg.getByText('/', { exact: true })).toBeVisible();
  await expect(dlg.getByText('Esc', { exact: true }).first()).toBeVisible();
  for (const [k, label] of [['D', 'Dashboard'], ['T', 'Tenders'], ['W', 'Watchlists'], ['P', 'Pipeline'], ['V', 'Document vault'], ['C', 'Company profile'], ['S', 'Settings'], ['N', 'Notifications']]) {
    const row = dlg.getByRole('listitem').filter({ hasText: label }).first();
    await expect(row, label).toContainText('G');
    await expect(row, label).toContainText(k);
  }
  await ev(page, 'sc11-shortcuts-dialog-via-question-mark');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  // from the user menu
  await page.locator('header').getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: /Keyboard shortcuts/ }).click();
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  // from the palette
  await openPalette(page);
  await palette(page).getByRole('option', { name: /Keyboard shortcuts/ }).click();
  await expect(dlg).toBeVisible();
  await settle(page);
  await a11y(page, 'shortcuts-dialog');
});

/* ───────────────────────────── 12. Accessibility (axe) ───────────────────────────── */

const APP_PAGES = ['/dashboard', '/tenders', '/watchlists', '/pipeline', '/vault', '/profile', '/notifications'];
const SETTINGS_PAGES = ['/settings/organization', '/settings/account', '/settings/team', '/settings/notifications', '/settings/scoring', '/settings/api-tokens', '/settings/sync'];

async function axeSweep(page: Page, theme: 'light' | 'dark', width: number, height: number) {
  await signup(page);
  await page.setViewportSize({ width, height });
  await page.addInitScript((t) => { try { localStorage.setItem('tp-theme', t); } catch { /* blocked */ } }, theme);
  const failures: string[] = [];
  for (const path of [...APP_PAGES, ...SETTINGS_PAGES]) {
    await open(page, path);
    expect((await cssFlag(page)).dark).toBe(theme === 'dark');
    if (width === 375) await noHorizontalOverflow(page);
    else expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const name = `shell-${theme}-${width}-${path.slice(1).replace(/\//g, '-')}`;
    if (path === '/dashboard') await ev(page, `sc12-${theme}-${width}-dashboard`);
    if (path === '/settings/team') await ev(page, `sc12-${theme}-${width}-settings-team`);
    try { await a11y(page, name); } catch (e) { failures.push(`${path}: ${(e as Error).message.split('\n').slice(0, 12).join(' | ')}`); }
  }
  expect(failures, 'axe serious/critical violations').toEqual([]);
}

test('sc12 axe light 1440: every shell and settings screen has 0 serious/critical violations', async ({ page }) => {
  desktopOnly('1440px scan runs in the desktop project');
  await axeSweep(page, 'light', 1440, 900);
});
test('sc12 axe dark 1440: every shell and settings screen has 0 serious/critical violations', async ({ page }) => {
  desktopOnly('1440px scan runs in the desktop project');
  await axeSweep(page, 'dark', 1440, 900);
});
test('sc12 @mobile axe light 375: every shell and settings screen has 0 serious/critical violations', async ({ page }) => {
  await axeSweep(page, 'light', 375, 812);
});
test('sc12 @mobile axe dark 375: every shell and settings screen has 0 serious/critical violations', async ({ page }) => {
  await axeSweep(page, 'dark', 375, 812);
});

test('sc12 overlays: palette, account menu, notifications bell and sidebar org switcher are axe-clean at 1440 light and dark', async ({ page }) => {
  desktopOnly('desktop overlays');
  await signup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const failures: string[] = [];
  const openMenu = page.locator('[role="menu"][data-state="open"]');
  const scan = async (name: string) => { await settle(page); try { await a11y(page, name); } catch (e) { failures.push(`${name}: ${(e as Error).message.split('\n').slice(0, 12).join(' | ')}`); } };
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((t) => { try { localStorage.setItem('tp-theme', t); } catch { /* blocked */ } }, theme);
    await open(page, '/dashboard');
    await openPalette(page);
    await page.getByPlaceholder(/Search pages, actions/).fill('te');
    await scan(`overlay-palette-${theme}-1440`);
    await ev(page, `sc12-overlay-palette-${theme}-1440`);
    await page.keyboard.press('Escape');
    await page.locator('header').getByRole('button', { name: /Account menu/ }).click();
    await expect(openMenu).toBeVisible();
    await scan(`overlay-account-menu-${theme}-1440`);
    await ev(page, `sc12-overlay-account-menu-${theme}-1440`);
    await page.keyboard.press('Escape');
    await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /Switch organization/ }).click();
    await expect(openMenu).toBeVisible();
    await scan(`overlay-org-switcher-${theme}-1440`);
    await ev(page, `sc12-overlay-org-switcher-${theme}-1440`);
    await page.keyboard.press('Escape');
  }
  expect(failures, 'axe serious/critical violations').toEqual([]);
});

test('sc12 @mobile org switcher inside the 375px drawer: axe-clean open, picking an org switches it, Esc returns focus to the trigger', async ({ page, baseURL }) => {
  const A = await signup(page);
  const meA = await (await page.request.get('/api/auth/me')).json();
  const B = await newOrgOwner(baseURL!);
  const inv = await B.api.post('/api/org/invitations', { data: { email: A.email, role: 'viewer' } });
  expect(inv.status(), await inv.text()).toBe(201);
  const token = String((await inv.json()).inviteUrl).split('/invite/')[1];
  expect((await page.request.post('/api/auth/accept-invite', { data: { token } })).status()).toBe(200);
  expect((await page.request.post('/api/auth/switch-org', { data: { orgId: meA.org.id } })).status()).toBe(200);
  await atPhone(page);
  await page.addInitScript(() => { try { localStorage.setItem('tp-theme', 'light'); } catch { /* blocked */ } });
  await open(page, '/dashboard');
  const orgBName = B.me.org.name as string;

  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  const openSwitcher = async () => {
    const trigger = drawer.getByRole('button', { name: /Switch organization/ });
    await trigger.click();
    await expect(page.locator('[role="menu"][data-state="open"]')).toBeVisible();
    return trigger;
  };
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'More' }).click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: /Switch organization/ })).toContainText(A.orgName);

  // light: open -> axe
  let trigger = await openSwitcher();
  await expect(page.getByRole('menuitem', { name: new RegExp(orgBName) })).toBeVisible();
  await ev(page, 'sc12-mobile-drawer-org-switcher-open-light');
  await settle(page);
  await a11y(page, 'drawer-org-switcher-open-light-375');
  // Esc closes the menu and returns focus to the trigger
  await page.keyboard.press('Escape');
  await expect(page.locator('[role="menu"][data-state="open"]')).toBeHidden();
  await expect(trigger).toBeFocused();
  await ev(page, 'sc12-mobile-drawer-org-switcher-esc-focus-returned');

  // dark: open -> axe
  await page.evaluate(() => { localStorage.setItem('tp-theme', 'dark'); document.documentElement.classList.add('dark'); });
  trigger = await openSwitcher();
  await settle(page);
  await a11y(page, 'drawer-org-switcher-open-dark-375');
  await ev(page, 'sc12-mobile-drawer-org-switcher-open-dark');
  await page.keyboard.press('Escape');
  await expect(page.locator('[role="menu"][data-state="open"]')).toBeHidden();
  await expect(trigger).toBeFocused();

  // pick the other org
  await openSwitcher();
  await page.getByRole('menuitem', { name: new RegExp(orgBName) }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: `Switched to ${orgBName}` })).toBeVisible();
  const me = await (await page.request.get('/api/auth/me')).json();
  expect(me.org.id).toBe(B.me.org.id);
  await expect(page).toHaveURL(/\/dashboard$/);
  await ev(page, 'sc12-mobile-drawer-org-switched');
  await noHorizontalOverflow(page);
  await B.api.dispose();
});
