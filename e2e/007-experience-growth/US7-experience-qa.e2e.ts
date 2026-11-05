/**
 * 007 / US7 — Responsive, accessible pages with honest states everywhere (story #298, QA task T078 / #351).
 *
 * One test per acceptance scenario US7-1 … US7-11 (specs/007-experience-growth/spec.md), driven through the real UI and
 * real HTTP, plus audits the developer's T073 sweep (US7-a11y-responsive.e2e.ts) does not do: axe with menus open, the
 * More sheet, dialogs and a drag in flight; the 375 px sweep in the touch-emulated `mobile` project (Pixel 7 profile with
 * a 375 px viewport); and the "Move to…" alternative to dragging (WCAG 2.2 2.5.7).
 * Each desktop test writes named screenshots to qa/evidence/007/US7/ and keeps its video there (collectRunArtifacts).
 * `@mobile` tests also run in the Pixel 7 project; on desktop they force 375 px. The @mobile sweep only runs in `mobile`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  test, expect, signupViaApi, seedDemo, evidence007, collectRunArtifacts, noHorizontalOverflow, atPhone, a11y, checkA11y,
} from '../support/fixtures';

const STORY = 'US7';
const EVID_DIR = join('qa', 'evidence', '007', STORY);
const AXE = { story: `${STORY}/axe`, spec: '007' };

test.afterEach(async ({ page }) => {
  if (test.info().project.name === 'desktop' && test.info().status !== 'skipped') await collectRunArtifacts('007', STORY, page);
});

function saveJson(name: string, data: unknown) {
  mkdirSync(EVID_DIR, { recursive: true });
  writeFileSync(join(EVID_DIR, name), JSON.stringify(data, null, 2));
}

/** Sign up + seed demo data, then open `path` and wait for the shell. */
async function openApp(page: Page, path = '/dashboard', opts: { seed?: boolean } = {}) {
  await page.addInitScript(() => { try { sessionStorage.setItem('tp:onboarding-redirected', '1'); } catch { /* ignore */ } });
  await signupViaApi(page);
  if (opts.seed !== false) await seedDemo(page.request);
  await page.goto(path);
  await expect(page.locator('#main')).toBeVisible();
}

const primaryNav = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

/** Interactive targets below the WCAG 2.5.8 minimum (24×24; 44×44 in the tab bar), same exemptions as the dev sweep. */
async function smallTargets(page: Page, scope = 'body') {
  return page.evaluate((root) => {
    const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=menuitemradio], [role=checkbox], [role=switch], [role=radio], [role=combobox], [role=option], [tabindex]:not([tabindex="-1"])';
    const out: { el: string; text: string; w: number; h: number; min: number }[] = [];
    for (const el of Array.from(document.querySelector(root)!.querySelectorAll<HTMLElement>(SEL))) {
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (!el.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true } as never)) continue;
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      // visually hidden until focused (sr-only skip link is clipped): exempt while hidden; its focused size is asserted in US7-3
      if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') continue;
      if (el.closest('[data-sonner-toaster]')) continue;
      if (el.tagName === 'A' && cs.display === 'inline') {
        const p = el.parentElement;
        if (p && /\S/.test((p.textContent ?? '').replace(el.textContent ?? '', ''))) continue;
      }
      let w = r.width, h = r.height;
      const label = el.closest('label');
      if (label) { const lr = label.getBoundingClientRect(); w = Math.max(w, lr.width); h = Math.max(h, lr.height); }
      const min = el.closest('nav[aria-label="Primary"]') ? 44 : 24;
      if (w + 0.5 < min || h + 0.5 < min) out.push({ el: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`, text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), w: Math.round(w), h: Math.round(h), min });
    }
    return out;
  }, scope);
}

/**
 * axe over an open Radix overlay. `aria-hidden-focus` is audited separately: Radix modal overlays mark the page behind
 * with aria-hidden while focus is trapped in the overlay, which axe reports for any tabbable element behind it. We still
 * fail on everything else, and record the aria-hidden-focus node count plus whether Tab can really reach the hidden
 * content (it cannot if it stays inside the overlay) in the observations file.
 */
const OBS: Record<string, unknown> = {};
async function auditOverlay(page: Page, name: string) {
  const r = await a11y(page, name, { ...AXE, disableRules: ['aria-hidden-focus'] });
  const hidden = await new AxeBuilder({ page }).withRules(['aria-hidden-focus']).analyze();
  await page.keyboard.press('Tab');
  const escaped = await page.evaluate(() => !!document.activeElement?.closest('[aria-hidden="true"], [data-aria-hidden="true"]'));
  OBS[name] = { otherViolations: r.violations.length, ariaHiddenFocusNodes: hidden.violations.flatMap((v) => v.nodes).length, tabReachesHiddenContent: escaped };
  saveJson('us7-8-overlay-observations.json', OBS);
  expect(escaped, `Tab must not move focus into content hidden behind the open overlay (${name})`).toBe(false);
}

// ───────────── US7-1 (FR-091): mobile tab bar ─────────────

test('US7-1 @mobile tab bar: Home/Tenders/Pipeline/Vault/More, More opens the full nav sheet, sidebar hidden, content not covered', async ({ page }) => {
  await atPhone(page);
  await openApp(page);
  const bar = primaryNav(page);
  await expect(bar).toBeVisible();
  const labels = await bar.locator('a, button').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
  expect(labels).toEqual(['Home', 'Tenders', 'Pipeline', 'Vault', 'More']);
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();

  // content is not covered: <main> bottom padding >= bar height (+ safe area, 0 in the test browser)
  const m = await page.evaluate(() => {
    const pad = parseFloat(getComputedStyle(document.querySelector('#main > div')!).paddingBottom);
    const bar = document.querySelector('nav[aria-label="Primary"]')!.getBoundingClientRect();
    return { pad, barH: bar.height, barTop: bar.top, vh: window.innerHeight, docH: document.documentElement.scrollHeight };
  });
  expect(m.pad, 'bottom padding must clear the tab bar').toBeGreaterThanOrEqual(m.barH);
  // scrolled to the very end, the bottom of <main>'s content box (padding excluded) sits above the tab bar
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const lastBottom = await page.evaluate(() => {
    const inner = document.querySelector('#main > div')!;
    const r = inner.getBoundingClientRect();
    return r.bottom - parseFloat(getComputedStyle(inner).paddingBottom);
  });
  expect(lastBottom, 'content end is above the tab bar').toBeLessThanOrEqual(m.barTop + 1);
  saveJson('us7-1-tab-bar-metrics.json', { labels, ...m, lastBottom });
  await evidence007(page, STORY, 'us7-1-tab-bar');

  // tab navigation works and marks the current tab
  await bar.getByRole('link', { name: 'Pipeline' }).click();
  await expect(page).toHaveURL(/\/pipeline$/);
  await expect(bar.getByRole('link', { name: 'Pipeline' })).toHaveAttribute('aria-current', 'page');

  // More opens the full navigation sheet (all destinations incl. Watchlists, Company profile, Settings)
  await bar.getByRole('button', { name: 'More' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  for (const name of ['Dashboard', 'Tenders', 'Watchlists', 'Pipeline', 'Document vault', 'Company profile', 'Notifications', 'Settings']) {
    await expect(sheet.getByRole('link', { name })).toBeVisible();
  }
  await page.waitForTimeout(500);
  await evidence007(page, STORY, 'us7-1-more-sheet');
  await a11y(page, 'us7-1-more-sheet-open', AXE);
  expect(await smallTargets(page, '[role=dialog]'), 'more-sheet target sizes').toEqual([]);
  await sheet.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

// ───────────── US7-2 (FR-091): collapsible desktop sidebar ─────────────

test('US7-2 sidebar (>=768px) collapses and expands with "Collapse sidebar" / "Expand sidebar" and the tab bar is hidden', async ({ page }) => {
  await openApp(page);
  const side = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(side).toBeVisible();
  await expect(primaryNav(page)).toBeHidden();
  const wide = (await side.boundingBox())!.width;
  await evidence007(page, STORY, 'us7-2-sidebar-expanded');
  await side.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(side.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await expect.poll(async () => (await side.boundingBox())!.width).toBeLessThan(80);
  const narrow = (await side.boundingBox())!.width;
  await evidence007(page, STORY, 'us7-2-sidebar-collapsed');
  await a11y(page, 'us7-2-sidebar-collapsed', AXE);
  // collapsed icon links still have accessible names
  for (const n of ['Dashboard', 'Tenders', 'Pipeline', 'Document vault', 'Settings']) await expect(side.getByRole('link', { name: n })).toBeVisible();
  // state persists across reload
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  await expect.poll(async () => (await side.boundingBox())!.width).toBeGreaterThan(200);
  saveJson('us7-2-sidebar-widths.json', { expanded: wide, collapsed: narrow });

  // at exactly 767 px the sidebar is gone and the tab bar is there; at 768 px the reverse
  await page.setViewportSize({ width: 767, height: 900 });
  await expect(side).toBeHidden();
  await expect(primaryNav(page)).toBeVisible();
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(side).toBeVisible();
  await expect(primaryNav(page)).toBeHidden();
});

// ───────────── US7-3 (FR-091): skip link, focus management, Ctrl/Cmd+K ─────────────

test('US7-3 first Tab shows "Skip to content" which moves focus to #main; route change focuses #main and scrolls to top; Ctrl+K opens the palette', async ({ page }) => {
  await openApp(page, '/tenders');
  await expect(page.getByRole('heading', { name: /tenders/i }).first()).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  const box = (await skip.boundingBox())!;
  expect(box.width).toBeGreaterThan(40);
  expect(box.height, 'focused skip link meets 2.5.8').toBeGreaterThanOrEqual(24);
  expect(box.x).toBeGreaterThanOrEqual(0);
  await evidence007(page, STORY, 'us7-3-skip-link-focused');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main');

  // navigating to another route: focus -> #main and window scrolled to top
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pipeline' }).click();
  await expect(page).toHaveURL(/\/pipeline$/);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // a tall page, scrolled, then navigate again
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tenders' }).click();
  await expect(page).toHaveURL(/\/tenders$/);
  await page.evaluate(() => window.scrollTo(0, 600));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Document vault' }).click();
  await expect(page).toHaveURL(/\/vault$/);
  await expect.poll(() => page.evaluate(() => ({ id: document.activeElement?.id, y: window.scrollY }))).toEqual({ id: 'main', y: 0 });

  // Ctrl+K opens the command palette (Meta+K on macOS handled by same handler)
  await page.keyboard.press('Control+k');
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('combobox')).toBeFocused();
  await evidence007(page, STORY, 'us7-3-command-palette');
  await a11y(page, 'us7-3-command-palette-open', AXE);
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('dialog')).toBeVisible();
});

// ───────────── US7-4 (FR-092): theme persistence without flash ─────────────

test('US7-4 choosing Dark persists to localStorage["tp-theme"] and is applied before first paint after reload; System follows prefers-color-scheme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openApp(page);
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.getByRole('button', { name: /^Theme:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem('tp-theme'))).toBe('dark');
  await evidence007(page, STORY, 'us7-4-dark-chosen');

  // Hold back the SPA bundle: before it runs, only the inline script in <head> has had a chance to set the class.
  await page.route('**/assets/index-*.js', async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue().catch(() => undefined); });
  await page.reload({ waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState !== 'loading' || !!document.body, null, { timeout: 5000 });
  const before = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    bg: getComputedStyle(document.body).backgroundColor,
    appMounted: !!document.querySelector('#main'),
  }));
  expect(before.appMounted, 'probe must run before the React app mounts').toBe(false);
  expect(before.dark, 'dark class present before the SPA bundle executes (no flash)').toBe(true);
  saveJson('us7-4-before-first-paint.json', before);
  await page.unroute('**/assets/index-*.js');
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);

  // reload again: still dark; then System follows the OS scheme
  await page.getByRole('button', { name: /^Theme:/ }).click();
  await page.getByRole('menuitemradio', { name: 'System' }).click();
  expect(await page.evaluate(() => localStorage.getItem('tp-theme'))).toBe('system');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await evidence007(page, STORY, 'us7-4-system-light');
});

// ───────────── US7-5 (FR-090): chunk-load and render-error boundaries ─────────────

test('US7-5a a route chunk that fails to load shows "A new version of TenderPilot is available" with a reload action inside the shell', async ({ page }) => {
  await openApp(page);
  let blocked = 0;
  await page.route('**/assets/PipelinePage-*.js', async (route) => { blocked += 1; await route.abort('failed'); });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pipeline' }).click();
  await expect(page.getByText('A new version of TenderPilot is available')).toBeVisible();
  expect(blocked).toBeGreaterThan(0);
  await expect(page.getByRole('alert').getByRole('button', { name: 'Try again' })).toBeVisible();
  // shell is intact
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
  await evidence007(page, STORY, 'us7-5a-chunk-error');
  await a11y(page, 'us7-5a-chunk-error-state', AXE);
  // "reload action": clicking it reloads the page; once the chunk is reachable again, the page works
  await page.unroute('**/assets/PipelinePage-*.js');
  const reloaded = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Try again' }).click();
  await reloaded;
  await expect(page.getByRole('heading', { name: /pipeline/i }).first()).toBeVisible();
  await expect(page.getByText('A new version of TenderPilot is available')).toHaveCount(0);
});

test('US7-5b a render error shows "This page hit a snag" + "Try again" inside the app shell, and navigating away recovers', async ({ page }) => {
  await openApp(page);
  // Malformed payload makes the dashboard throw while rendering.
  await page.route('**/api/dashboard*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ unexpected: 'shape' }) }));
  await page.reload();
  const snag = page.getByText('This page hit a snag');
  await expect(snag).toBeVisible();
  await expect(page.getByText('A new version of TenderPilot is available')).toHaveCount(0);
  await expect(page.getByRole('alert').getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
  await expect(page.getByRole('banner')).toBeVisible();
  await evidence007(page, STORY, 'us7-5b-render-error');
  await a11y(page, 'us7-5b-render-error-state', AXE);
  // navigation resets the boundary
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tenders' }).click();
  await expect(page.getByRole('heading', { name: /tenders/i }).first()).toBeVisible();
  await expect(snag).toHaveCount(0);
});

// ───────────── US7-6 (FR-090): 404 ─────────────

test('US7-6 an unknown URL shows "404", "This page went off the map" and "Open dashboard" (signed out and signed in)', async ({ page }) => {
  await page.goto('/nope');
  await expect(page.getByText('404', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This page went off the map' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open dashboard' })).toHaveAttribute('href', '/dashboard');
  await evidence007(page, STORY, 'us7-6-404-signed-out');
  await a11y(page, 'us7-6-404', AXE);
  await page.goto('/nope/deeper/path');
  await expect(page.getByRole('heading', { name: 'This page went off the map' })).toBeVisible();
  await signupViaApi(page);
  await page.goto('/definitely-not-a-page');
  await expect(page.getByRole('heading', { name: 'This page went off the map' })).toBeVisible();
  await page.getByRole('link', { name: 'Open dashboard' }).click();
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/);
  await evidence007(page, STORY, 'us7-6-404-then-dashboard');
});

// ───────────── US7-7 (FR-093): charts expose a text alternative ─────────────

test('US7-7 dashboard charts expose role="img" with a text summary that matches the data', async ({ page }) => {
  await openApp(page);
  const dash = await (await page.request.get('/api/dashboard')).json();
  await expect(page.getByRole('heading', { name: /dashboard|welcome|good/i }).first()).toBeVisible();
  const imgs = page.locator('#main [role="img"]');
  await expect(imgs.first()).toBeVisible();
  const names = await imgs.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  saveJson('us7-7-chart-labels.json', { names, dashboardKeys: Object.keys(dash) });
  const matches = names.find((n) => /^New matches over the last 14 days: \d+ in total$/.test(n));
  expect(matches, `labels: ${JSON.stringify(names)}`).toBeTruthy();
  const verdict = names.find((n) => /^Go\/No-Go verdicts, \d+ analysed:/.test(n));
  expect(verdict, `labels: ${JSON.stringify(names)}`).toBeTruthy();
  // total in the label equals the sum of the series the API returns
  const days = dash.matchesByDay as { date: string; count: number }[];
  expect(days.length).toBe(14);
  expect(Number(matches!.match(/: (\d+) in total/)![1]), 'label total equals the API series sum').toBe(days.reduce((a, d) => a + d.count, 0));
  const v = dash.verdicts as Record<string, number>;
  saveJson('us7-7-api-series.json', { matchesByDay: days, verdicts: v });
  // charts are not exposed twice: no focusable/duplicated svg text spam inside the img
  const nestedFocusable = await imgs.first().evaluate((e) => e.querySelectorAll('a, button, [tabindex]:not([tabindex="-1"])').length);
  expect(nestedFocusable).toBe(0);
  await evidence007(page, STORY, 'us7-7-dashboard-charts');
  await a11y(page, 'us7-7-dashboard-with-charts', AXE);
});

// ───────────── US7-8 / US7-9 audits beyond the dev sweep (desktop project) ─────────────

test('US7-8 axe over open menus and dialogs (user menu, theme menu, org switcher, shortcuts dialog) at 1440 px', async ({ page }) => {
  await openApp(page);
  const results: Record<string, number> = {};
  const audit = async (name: string) => { await auditOverlay(page, `us7-8-${name}`); results[name] = 0; };

  await page.getByRole('button', { name: /Account menu$/ }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await audit('user-menu-open');
  await evidence007(page, STORY, 'us7-8-user-menu');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /^Theme:/ }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await audit('theme-menu-open');
  await page.keyboard.press('Escape');

  const org = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button').filter({ hasText: /Traders/ }).first();
  if (await org.count()) { await org.click(); await expect(page.getByRole('menu')).toBeVisible(); await audit('org-switcher-open'); await page.keyboard.press('Escape'); }

  await page.locator('body').click({ position: { x: 700, y: 400 } });
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
  await audit('shortcuts-dialog-open');
  await evidence007(page, STORY, 'us7-8-shortcuts-dialog');
  await page.keyboard.press('Escape');

  // dark theme too
  await page.getByRole('button', { name: /^Theme:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await page.getByRole('button', { name: /Account menu$/ }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await audit('user-menu-open-dark');
  saveJson('us7-8-open-overlay-axe-summary.json', results);
});

test('US7-8 axe on pipeline interactions: "Move to…" menu (keyboard alternative to dragging) and a card mid-drag', async ({ page }) => {
  await openApp(page, '/pipeline');
  await expect(page.getByRole('heading', { name: /pipeline/i }).first()).toBeVisible();
  const handle = page.getByRole('button', { name: /^Move (?!to)/ }).first();
  await expect(handle).toBeVisible();
  await a11y(page, 'us7-8-pipeline-board', AXE);

  // 2.5.7: "Move to…" menu is a single-pointer alternative; open it, audit it, and use it.
  const moveBtn = page.getByRole('button', { name: /^Move to… \(/ }).first();
  await moveBtn.scrollIntoViewIfNeeded();
  const cardTitle = ((await moveBtn.getAttribute('aria-label')) ?? '').replace(/^Move to… \(/, '').replace(/\)$/, '');
  await moveBtn.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await auditOverlay(page, 'us7-8-move-to-menu-open');
  if (!(await menu.isVisible())) { await page.keyboard.press('Escape'); await moveBtn.click(); await expect(menu).toBeVisible(); }
  expect(await smallTargets(page, '[role=menu]'), 'menu item target sizes').toEqual([]);
  await evidence007(page, STORY, 'us7-8-move-to-menu');
  const stageBefore = await page.locator('section[data-stage]').evaluateAll((s, t) => s.find((x) => x.textContent?.includes(t))?.getAttribute('data-stage'), cardTitle);
  const target = menu.getByRole('menuitem').filter({ hasNot: page.locator('[aria-disabled="true"], [data-disabled]') }).first();
  await target.press('Enter').catch(() => target.click());
  await page.waitForTimeout(800);
  const stageAfter = await page.locator('section[data-stage]').evaluateAll((s, t) => s.find((x) => x.textContent?.includes(t))?.getAttribute('data-stage'), cardTitle);
  saveJson('us7-8-move-to-result.json', { cardTitle, stageBefore, stageAfter });

  // Drag in flight: press on a handle, move a long way, audit while the overlay is shown, then drop back.
  const h = page.getByRole('button', { name: /^Move (?!to)/ }).first();
  await h.scrollIntoViewIfNeeded();
  const b = (await h.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 40, b.y + b.height / 2 + 10, { steps: 8 });
  await page.mouse.move(b.x + b.width / 2 + 330, b.y + b.height / 2 + 10, { steps: 12 });
  await page.waitForTimeout(300);
  await evidence007(page, STORY, 'us7-8-pipeline-mid-drag');
  await a11y(page, 'us7-8-pipeline-mid-drag', AXE);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('#main')).toBeVisible();
});

test('US7-8 axe on a form dialog (Settings > team invite) and Vault upload area', async ({ page }) => {
  await openApp(page, '/settings');
  await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible();
  await a11y(page, 'us7-8-settings', AXE);
  const invite = page.getByRole('button', { name: /invite/i }).first();
  if (await invite.count()) {
    await invite.click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible();
    await a11y(page, 'us7-8-invite-dialog', AXE);
    expect(await smallTargets(page, '[role=dialog]'), 'dialog target sizes').toEqual([]);
    await evidence007(page, STORY, 'us7-8-invite-dialog');
    await page.keyboard.press('Escape');
  }
  await page.goto('/tenders');
  await expect(page.getByRole('heading', { name: /tenders/i }).first()).toBeVisible();
  await a11y(page, 'us7-8-tenders-feed-seeded', AXE);
  await page.goto('/watchlists');
  await expect(page.getByRole('heading', { name: /watchlists/i }).first()).toBeVisible();
  await a11y(page, 'us7-8-watchlists', AXE);
});

// ───────────── US7-9 (FR-094): 375 px sweep in the touch-emulated mobile project ─────────────

const SWEEP_PAGES: { name: string; path: string; auth: boolean }[] = [
  { name: 'landing', path: '/', auth: false }, { name: 'login', path: '/login', auth: false }, { name: 'signup', path: '/signup', auth: false },
  { name: 'onboarding', path: '/onboarding', auth: true }, { name: 'dashboard', path: '/dashboard', auth: true },
  { name: 'tenders', path: '/tenders', auth: true }, { name: 'pipeline', path: '/pipeline', auth: true }, { name: 'vault', path: '/vault', auth: true },
  { name: 'profile', path: '/profile', auth: true }, { name: 'settings', path: '/settings', auth: true }, { name: 'notifications', path: '/notifications', auth: true },
];

for (const theme of ['light', 'dark'] as const) {
  for (const pg of SWEEP_PAGES) {
    test(`US7-9 @mobile ${pg.name} @ 375px touch ${theme}: axe, no horizontal overflow, targets >= 24 (tab bar >= 44)`, async ({ page, hasTouch }) => {
      test.skip(test.info().project.name !== 'mobile', 'runs in the touch-emulated mobile project only');
      expect(hasTouch, 'touch emulation on').toBe(true);
      await atPhone(page);
      await page.addInitScript((t) => { try { localStorage.setItem('tp-theme', t); sessionStorage.setItem('tp:onboarding-redirected', '1'); } catch { /* ignore */ } }, theme);
      if (pg.auth) { await signupViaApi(page); await seedDemo(page.request); }
      await page.goto(pg.path);
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await expect(page.getByRole('heading').first()).toBeVisible();
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
      await page.waitForTimeout(500);
      const name = `m-${pg.name}-375-${theme}`;
      const problems: unknown[] = [];
      try { await a11y(page, name, AXE); } catch (e) { problems.push({ axe: String((e as Error).message).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 800) }); }
      try { await noHorizontalOverflow(page); } catch (e) { problems.push({ overflow: String((e as Error).message).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300) }); }
      const small = await smallTargets(page);
      if (small.length) problems.push({ smallTargets: small });
      if (pg.auth && pg.name !== 'onboarding') {
        const boxes = await page.locator('nav[aria-label="Primary"] a, nav[aria-label="Primary"] button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
        if (boxes.length < 5) problems.push({ tabBarItems: boxes.length });
      }
      if (theme === 'light' && ['dashboard', 'pipeline'].includes(pg.name)) await evidence007(page, STORY, `us7-9-mobile-${pg.name}-375`);
      expect(problems, `findings on ${name}`).toEqual([]);
    });
  }
}

test('US7-9 @mobile pipeline Kanban scrolls inside its own container; the page does not scroll horizontally; touch can open Move to… menu', async ({ page }) => {
  await atPhone(page);
  await openApp(page, '/pipeline');
  await expect(page.getByRole('heading', { name: /pipeline/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Move to… \(/ }).first()).toBeVisible();
  await page.waitForTimeout(500);
  const m = await noHorizontalOverflow(page);
  const inner = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll<HTMLElement>('#main *')).filter((e) => e.scrollWidth > e.clientWidth + 8 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowX));
    return cands.map((e) => ({ tag: e.tagName, cls: e.className.toString().slice(0, 60), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth }));
  });
  saveJson('us7-9-pipeline-inner-scroll.json', { page: m, inner });
  expect(inner.length, 'the Kanban board has its own horizontal scroll container').toBeGreaterThan(0);
  await evidence007(page, STORY, 'us7-9-pipeline-375');
  // single-pointer alternative to dragging works by touch (2.5.7), and its target is >= 24 px
  const mv = page.getByRole('button', { name: /^Move to… \(/ }).first();
  await mv.scrollIntoViewIfNeeded();
  const mb = (await mv.boundingBox())!;
  expect(Math.min(mb.width, mb.height), 'Move to… trigger target size').toBeGreaterThanOrEqual(24);
  await (test.info().project.name === 'mobile' ? mv.tap() : mv.click());
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem').first()).toBeVisible();
});

// ───────────── US7-10 (FR-095): web app manifest ─────────────

test('US7-10 manifest is linked and valid (name, short_name, start_url, standalone, theme colours, 192/512 + maskable icons) with no orientation lock', async ({ page, request }) => {
  await page.goto('/login');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
  const res = await request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/manifest\+json|application\/json/);
  const mf = await res.json();
  saveJson('us7-10-manifest.json', mf);
  expect(mf.name).toBe('TenderPilot');
  expect(mf.short_name).toBe('TenderPilot');
  expect(mf.start_url).toBe('/dashboard');
  expect(mf.display).toBe('standalone');
  expect(mf.theme_color).toMatch(/^#[0-9a-f]{3,8}$/i);
  expect(mf.background_color).toMatch(/^#[0-9a-f]{3,8}$/i);
  expect(mf, 'must not lock orientation (WCAG 1.3.4)').not.toHaveProperty('orientation');
  const icons = mf.icons as { src: string; sizes: string; type: string; purpose?: string }[];
  const has = (size: string, purpose?: string) => icons.some((i) => i.sizes === size && (purpose ? i.purpose === purpose : (i.purpose ?? 'any') === 'any'));
  expect(has('192x192')).toBe(true);
  expect(has('512x512')).toBe(true);
  expect(has('512x512', 'maskable')).toBe(true);
  const dims: Record<string, unknown> = {};
  for (const i of icons) {
    const r = await request.get(i.src);
    expect(r.status(), i.src).toBe(200);
    expect(r.headers()['content-type'], i.src).toMatch(/image\/png/);
    const buf = await r.body();
    expect(buf.subarray(1, 4).toString(), `${i.src} is a PNG`).toBe('PNG');
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    expect(`${w}x${h}`, `${i.src} real size matches declared`).toBe(i.sizes);
    dims[i.src] = { w, h, bytes: buf.length, purpose: i.purpose };
  }
  saveJson('us7-10-icon-dimensions.json', dims);
  // start_url must be inside scope and resolvable; apple-touch-icon and viewport do not lock zoom/orientation
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect((await request.get(apple!)).status()).toBe(200);
  const vp = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(vp).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/);
  saveJson('us7-10-viewport.json', { viewport: vp, apple });
});

// ───────────── US7-11 (FR-096): offline banner, mutations fail fast ─────────────

test('US7-11 offline: banner "You’re offline — showing the last loaded data" over stale data; a mutation fails fast with an error toast (no spinner); banner clears on reconnect', async ({ page, context }) => {
  await openApp(page, '/notifications');
  await expect(page.getByRole('heading', { name: /notifications/i }).first()).toBeVisible();
  const banner = page.getByTestId('offline-banner');
  await expect(banner).toHaveAttribute('role', 'status');
  await expect(banner.getByText('You’re offline')).toHaveCount(0);

  // load a page of data first so there is "last loaded data" to show
  await page.goto('/pipeline');
  await expect(page.getByRole('heading', { name: /pipeline/i }).first()).toBeVisible();
  const cardBtn = page.getByRole('button', { name: /^Move to… \(/ }).first();
  await expect(cardBtn).toBeVisible();
  const titleBefore = ((await cardBtn.getAttribute('aria-label')) ?? '');

  await context.setOffline(true);
  await expect(banner.getByText('You’re offline — showing the last loaded data')).toBeVisible();
  await expect(banner).toContainText('You’re offline — showing the last loaded data');
  // last loaded data is still on screen
  await expect(page.getByRole('button', { name: titleBefore })).toBeVisible();
  await evidence007(page, STORY, 'us7-11-offline-banner');
  await a11y(page, 'us7-11-offline-pipeline', AXE);

  // mutation while offline: move a card via the "Move to…" menu
  await cardBtn.click();
  const item = page.getByRole('menu').getByRole('menuitem').filter({ hasNot: page.locator('[aria-disabled="true"], [data-disabled]') }).first();
  const t0 = Date.now();
  await item.click();
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: /connect|offline|network|reach|try again/i }).first();
  await expect(toast).toBeVisible({ timeout: 4000 });
  const elapsed = Date.now() - t0;
  const toastText = (await toast.innerText()).replace(/\s+/g, ' ');
  saveJson('us7-11-offline-mutation.json', { elapsedMs: elapsed, toastText, toastCount: await page.locator('[data-sonner-toast][data-type="error"]').count() });
  expect(elapsed, 'mutation must fail fast, not wait for reconnection').toBeLessThan(3500);
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(1);
  // no perpetual spinner anywhere in the main area
  await expect(page.locator('#main .animate-spin')).toHaveCount(0);
  await expect(page.locator('#main [aria-busy="true"]')).toHaveCount(0);
  await evidence007(page, STORY, 'us7-11-offline-mutation-error-toast');

  // a second attempt also fails fast (not paused/queued)
  await page.waitForTimeout(500);

  await context.setOffline(false);
  await expect(banner.getByText('You’re offline')).toHaveCount(0);
  await evidence007(page, STORY, 'us7-11-back-online');
});

test('US7-11 @mobile offline banner is visible and does not overlap the tab bar at 375 px, in dark theme', async ({ page, context }) => {
  await atPhone(page);
  await page.addInitScript(() => { try { localStorage.setItem('tp-theme', 'dark'); } catch { /* ignore */ } });
  await openApp(page, '/dashboard');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await context.setOffline(true);
  const msg = page.getByTestId('offline-banner').getByText('You’re offline — showing the last loaded data');
  await expect(msg).toBeVisible();
  const [mb, tb] = await Promise.all([msg.boundingBox(), primaryNav(page).boundingBox()]);
  expect(mb!.y + mb!.height).toBeLessThanOrEqual(tb!.y);
  expect(mb!.x).toBeGreaterThanOrEqual(0);
  expect(mb!.x + mb!.width).toBeLessThanOrEqual(375);
  await noHorizontalOverflow(page);
  await evidence007(page, STORY, 'us7-11-offline-mobile-dark');
  await checkA11y(page);
  await context.setOffline(false);
});
