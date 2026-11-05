import { test as base, expect, request as playwrightRequest, type Page, type APIRequestContext, type Browser, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const GEM_URL = `http://127.0.0.1:${process.env.E2E_GEM_PORT || 4011}`;

let counter = 0;
/** Unique, readable test identity per call. */
export function uniqueUser(prefix = 'qa') {
  counter += 1;
  const id = `${Date.now().toString(36)}${counter}`;
  return { name: `QA ${prefix} ${id}`, email: `${prefix}.${id}@example.in`, password: 'Qa!pass12345', orgName: `${prefix} Traders ${id}` };
}

/** Sign up through the API (fast path) and return the authenticated request context's cookies on the page. */
export async function signupViaApi(page: Page, user = uniqueUser()) {
  const res = await page.request.post('/api/auth/signup', { data: user });
  expect(res.status(), await res.text()).toBe(201);
  return user;
}

export async function loginViaUi(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/^password/i).fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
}

/** Seed demo data into the current org (bid_manager+). */
export async function seedDemo(request: APIRequestContext) {
  const res = await request.post('/api/demo/seed');
  expect(res.ok(), await res.text()).toBeTruthy();
}

export async function mockGem(request: APIRequestContext, path: string, data?: unknown) {
  const res = await request.post(`${GEM_URL}${path}`, { data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json().catch(() => ({}));
}

/**
 * Evidence: a named full-page screenshot attached to the test report AND copied to
 * qa/evidence/<spec>/<story>/<name>.png so the QA verdict can link to it.
 */
export async function evidence(page: Page, spec: string, story: string, name: string) {
  const dir = join('qa', 'evidence', spec, story);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await base.info().attach(name, { path: file, contentType: 'image/png' });
  return file;
}

/** Copy this test's video + trace into the story's evidence folder (call in afterEach). */
export async function collectRunArtifacts(spec: string, story: string, page: Page) {
  const info = base.info();
  const dir = join('qa', 'evidence', spec, story);
  mkdirSync(dir, { recursive: true });
  const slug = info.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
  const video = page.video();
  await page.close();
  if (video) { try { copyFileSync(await video.path(), join(dir, `${slug}-${info.project.name}.webm`)); } catch { /* no video */ } }
}

// ───────────── 007 Experience & Growth helpers (T002, T003) ─────────────

/** Evidence screenshot for spec 007: writes `qa/evidence/007/<story>/<name>.png` (story = 'US1' … 'US7'). */
export function evidence007(page: Page, story: string, name: string) {
  return evidence(page, '007', story, name);
}

export type InvitedRole = 'bid_manager' | 'analyst' | 'viewer';

export interface InvitedUser {
  user: ReturnType<typeof uniqueUser>;
  role: InvitedRole;
  /** Logged-in API context for the invited user (dispose() it when done). */
  api: APIRequestContext;
  /** Cookies of the logged-in session, usable with `browser.newContext({ storageState })`. */
  storageState: Awaited<ReturnType<APIRequestContext['storageState']>>;
  /** A browser context logged in as this user, with the project's base URL, timezone and locale. */
  newContext(browser: Browser): Promise<BrowserContext>;
  /** Shortcut: a fresh page in `newContext(browser)`. */
  newPage(browser: Browser): Promise<Page>;
}

/**
 * Invite a new member with `role` into the org of `request` (must be an Owner/Bid Manager session), accept the
 * invitation and return a logged-in context for them. Usage:
 *   const analyst = await inviteAs(page.request, 'analyst');
 *   const p = await analyst.newPage(browser); await p.goto('/dashboard');
 */
/** Contexts opened by inviteAs(); closed by the auto fixture on `test` after every test, pass or fail. */
const openedContexts = new Set<{ dispose(): Promise<void> }>();
async function disposeOpenedContexts() {
  const all = [...openedContexts];
  openedContexts.clear();
  await Promise.all(all.map((c) => c.dispose().catch(() => { /* already closed */ })));
}

export async function inviteAs(request: APIRequestContext, role: InvitedRole): Promise<InvitedUser> {
  const info = base.info();
  const use = info.project.use;
  const baseURL = use.baseURL;
  const user = uniqueUser(role.replace('_', ''));
  const inv = await request.post('/api/org/invitations', { data: { email: user.email, role } });
  expect(inv.status(), await inv.text()).toBe(201);
  const token = String((await inv.json()).inviteUrl).split('/invite/')[1];
  expect(token, 'invite token').toBeTruthy();
  const api = await playwrightRequest.newContext({ baseURL });
  openedContexts.add(api);
  const acc = await api.post('/api/auth/accept-invite', { data: { token, name: user.name, password: user.password } });
  expect(acc.status(), await acc.text()).toBe(200);
  const storageState = await api.storageState();
  const newContext = async (browser: Browser) => {
    // Only device/locale fields from the project — not test-runner options like trace/screenshot/video modes.
    const ctx = await browser.newContext({
      viewport: use.viewport, userAgent: use.userAgent, deviceScaleFactor: use.deviceScaleFactor, isMobile: use.isMobile, hasTouch: use.hasTouch,
      locale: use.locale, timezoneId: use.timezoneId, baseURL, storageState,
      recordVideo: { dir: info.outputPath('videos'), size: use.viewport ?? undefined },
    });
    openedContexts.add({ dispose: () => ctx.close() });
    return ctx;
  };
  return {
    user, role, api, storageState, newContext,
    async newPage(browser) { return (await newContext(browser)).newPage(); },
  };
}

/** Phone viewport used by the 007 mobile checks (375 × 812). */
export async function atPhone(page: Page) {
  await page.setViewportSize({ width: 375, height: 812 });
}

/** Assert the page does not scroll horizontally (`scrollWidth ≤ innerWidth`). */
export async function noHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(m.scrollWidth, `horizontal overflow: scrollWidth ${m.scrollWidth} > innerWidth ${m.innerWidth}`).toBeLessThanOrEqual(m.innerWidth);
  return m;
}

/** Seed the demo dataset into the current org and return the seed response plus the org's workspace cards. */
export async function seedDemoAndGetWorkspaces(request: APIRequestContext) {
  const seeded = await request.post('/api/demo/seed');
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  const list = await request.get('/api/workspaces');
  expect(list.ok(), await list.text()).toBeTruthy();
  const body = await list.json();
  return { seed: await seeded.json(), workspaces: body.items as { id: string; stage: string; tender: { id: string; title: string } & Record<string, unknown> }[], list: body };
}

export const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Accessibility audit with axe (WCAG 2.1 A/AA). Saves the full result as JSON next to the evidence
 * (`qa/evidence/<spec>/<story>/<name>-<project>.axe.json`) and fails on any serious or critical violation.
 * `story` defaults to the `US<n>` in the test file name (e.g. US1-dashboard.e2e.ts → 'US1').
 */
export async function a11y(page: Page, name: string, opts: { spec?: string; story?: string; include?: string[]; exclude?: string[]; disableRules?: string[] } = {}) {
  const info = base.info();
  // Spec from the test file path: e2e/<nnn>-<slug>/… → '<nnn>' (falls back to the folder name).
  const folder = basename(dirname(info.file));
  const spec = opts.spec ?? folder.match(/^(\d{3})-/)?.[1] ?? folder;
  const story = opts.story ?? basename(info.file).match(/US\d+/)?.[0] ?? 'misc';
  let builder = new AxeBuilder({ page }).withTags(A11Y_TAGS);
  for (const sel of opts.include ?? []) builder = builder.include(sel);
  for (const sel of opts.exclude ?? []) builder = builder.exclude(sel);
  if (opts.disableRules?.length) builder = builder.disableRules(opts.disableRules);
  const results = await builder.analyze();
  const dir = join('qa', 'evidence', spec, story);
  mkdirSync(dir, { recursive: true });
  const fileName = `${name}-${info.project.name}.axe.json`;
  const file = join(dir, fileName);
  writeFileSync(file, JSON.stringify({ url: results.url, timestamp: results.timestamp, violations: results.violations, incomplete: results.incomplete, passes: results.passes.length }, null, 2));
  await info.attach(fileName, { path: file, contentType: 'application/json' });
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) })), `axe serious/critical violations on ${name}`).toEqual([]);
  return results;
}

/** Lightweight axe check (WCAG 2.1 A/AA): fails the test on any serious or critical violation; no evidence file. */
export async function checkA11y(page: Page, opts: { include?: string[]; exclude?: string[]; disableRules?: string[] } = {}) {
  let builder = new AxeBuilder({ page }).withTags(A11Y_TAGS);
  for (const sel of opts.include ?? []) builder = builder.include(sel);
  for (const sel of opts.exclude ?? []) builder = builder.exclude(sel);
  if (opts.disableRules?.length) builder = builder.disableRules(opts.disableRules);
  const results = await builder.analyze();
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) })), `axe serious/critical violations on ${page.url()}`).toEqual([]);
  return results;
}

/** `test` with an auto fixture that disposes every context opened by inviteAs(), even when the test fails. */
export const test = base.extend<{ _disposeInvited: void }>({
  _disposeInvited: [async ({}, use) => {
    await use();
    await disposeOpenedContexts();
  }, { auto: true }],
});
export { expect };
