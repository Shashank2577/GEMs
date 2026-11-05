import { test as base, expect, request as playwrightRequest, type Page, type APIRequestContext, type Browser, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
 * Evaluate / award a bid on mock-gem (`POST /__admin/award/<bidNumber>`, spec 003 US6): the bid closes now if still
 * open and shows under `bidrastatus` listings. `status` defaults to `awarded` (result view serves the recorded awarded
 * page); `tech_evaluated` / `fin_evaluated` leave the result "not yet published".
 */
export async function gemAward(request: APIRequestContext, bidNumber: string, status: 'awarded' | 'tech_evaluated' | 'fin_evaluated' = 'awarded') {
  return mockGem(request, `/__admin/award/${encodeURIComponent(bidNumber)}`, { status });
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

/** Spec 008 shorthand for `evidence(page, '008', story, name)`. */
export function evidence008(page: Page, story: string, name: string) {
  return evidence(page, '008', story, name);
}

/**
 * API-only evidence (curl transcripts, EXPLAIN output, CI log excerpts) for spec 008:
 * a string is written as qa/evidence/008/<story>/<name>.txt, anything else as pretty-printed <name>.json.
 */
export function saveTranscript(story: string, name: string, content: unknown) {
  const dir = join('qa', 'evidence', '008', story);
  mkdirSync(dir, { recursive: true });
  const isText = typeof content === 'string';
  const file = join(dir, `${name.replace(/\.(txt|json)$/i, '')}.${isText ? 'txt' : 'json'}`);
  writeFileSync(file, isText ? content : `${JSON.stringify(content, null, 2)}\n`);
  try {
    base.info().attach(name, { path: file, contentType: isText ? 'text/plain' : 'application/json' }).catch(() => {});
  } catch { /* called outside a running test: file only */ }
  return file;
}

// ───────────── 003 Identify, Ingestion & Alerts helpers (T004) ─────────────

/** Restore the mock GeM to its recorded fixtures and switch any simulated outage off. */
export async function resetGem(request: APIRequestContext) {
  await mockGem(request, '/__admin/reset');
  await mockGem(request, '/__admin/fail', { mode: 'off' });
}

/**
 * Make a 003 spec file start from a clean ingestion state so the whole directory can run in one invocation on one DB
 * (each spec expects an empty `tenders` table and no earlier manual syncs): truncates `tenders`, `ingestion_runs`, `notifications` and `watchlists` (specs count them globally and earlier specs' watchlists would match new tenders; cascades to events and matches; TRUNCATE rather than DELETE so
 * the heap is as fresh as a new database and tie-ordered sorts are reproducible) via psql, then restores the mock GeM. Refuses a database whose name does not
 * contain "e2e". Call it from `test.beforeAll` (desktop project only, so the mobile project keeps the desktop state).
 */
export async function resetIngestionData(request: APIRequestContext) {
  const url = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
  if (!/e2e/i.test(new URL(url).pathname)) throw new Error(`resetIngestionData refuses to touch ${url} (database name must contain "e2e")`);
  execFileSync('psql', [url, '-qtAX', '-v', 'ON_ERROR_STOP=1', '-c', 'truncate tenders, ingestion_runs, notifications, watchlists cascade'], { encoding: 'utf8' });
  await resetGem(request);
}

/** Publish `count` new bids on the mock GeM (simulates fresh tenders); resolves to the mock's reply. */
export async function publishOnGem(request: APIRequestContext, count = 1) {
  return mockGem(request, '/__admin/publish', { count });
}

/** Issue a corrigendum on one mock bid, e.g. `gemCorrigendum(req, 'GEM/2026/B/6421101', { days: 7 })`. */
export async function gemCorrigendum(request: APIRequestContext, bidNumber: string, body: { days?: number; endAt?: string; quantity?: number; emd?: number } = {}) {
  return mockGem(request, `/__admin/corrigendum/${encodeURIComponent(bidNumber)}`, body);
}

/** Cancel one mock bid on GeM (`b_is_cancelled`), e.g. `gemCancel(req, 'GEM/2026/B/6421101')`. */
export async function gemCancel(request: APIRequestContext, bidNumber: string) {
  return mockGem(request, `/__admin/cancel/${encodeURIComponent(bidNumber)}`, {});
}

/** Simulate a GeM outage: 'down' (5xx), 'html' (format drift) or 'off' (healthy). */
export async function gemFail(request: APIRequestContext, mode: 'down' | 'html' | 'off') {
  return mockGem(request, '/__admin/fail', { mode });
}

/**
 * Run a sync now (`POST /api/ingestion/run`, Bid Manager+). The 008/FR-026 manual cooldown (429 `sync_cooldown`)
 * is waited out via `error.details.retryAt` and retried (at most 2 waits); it fails fast when the wait would exceed
 * 60 s (the default cooldown is 10 minutes: age earlier runs in SQL first, as the 003 US3-US5 specs do). Any other status is returned as is.
 */
export async function syncNow(request: APIRequestContext, data: { pages?: number; search?: string } = { pages: 5 }) {
  for (let i = 0; i < 3; i++) {
    const res = await request.post('/api/ingestion/run', { data });
    if (res.status() !== 429) return res;
    const body = await res.json().catch(() => ({}));
    const retryAt = Date.parse(body?.error?.details?.retryAt ?? '');
    if (body?.error?.code !== 'sync_cooldown' || Number.isNaN(retryAt)) return res;
    const waitMs = Math.max(0, retryAt - Date.now()) + 1500;
    if (waitMs > 60_000) throw new Error(`manual sync cooldown is ${Math.round(waitMs / 1000)}s: age earlier ingestion_runs in SQL before syncNow()`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error('manual sync cooldown never cleared');
}

/** Evidence screenshot for spec 003: writes `qa/evidence/003/<story>/<name>.png` (story = 'US1' … 'US6'). */
export function evidence003(page: Page, story: string, name: string) {
  return evidence(page, '003', story, name);
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

/**
 * Wait (max 3 s) until finite CSS/Web animations have finished, so axe does not measure colour contrast on an overlay
 * that is still fading in (Radix menus/dialogs animate opacity; a slow CI runner audits mid-animation otherwise).
 */
export async function settleAnimations(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), null, { timeout: 3_000 }).catch(() => { /* audit anyway */ });
}

export const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type A11yOpts = { spec?: string; story?: string; include?: string[]; exclude?: string[]; disableRules?: string[] };

/**
 * Accessibility audit with axe (WCAG 2.1 A/AA). Saves the full result as JSON next to the evidence and fails on any
 * serious or critical violation. Two call forms:
 * - `a11y(page, spec, story, name)` (002/T014) → `qa/evidence/<spec>/<story>/axe-<name>.json`;
 * - `a11y(page, name, opts?)` → `qa/evidence/<spec>/<story>/<name>-<project>.axe.json`, with `story` defaulting to the
 *   `US<n>` in the test file name (e.g. US1-dashboard.e2e.ts → 'US1') and `spec` to the `e2e/<nnn>-…` folder.
 */
export async function a11y(page: Page, spec: string, story: string, name: string): Promise<AxeResults>;
export async function a11y(page: Page, name: string, opts?: A11yOpts): Promise<AxeResults>;
export async function a11y(page: Page, nameOrSpec: string, optsOrStory: A11yOpts | string = {}, explicitName?: string): Promise<AxeResults> {
  const info = base.info();
  const positional = typeof optsOrStory === 'string';
  const opts: A11yOpts = positional ? { spec: nameOrSpec, story: optsOrStory } : optsOrStory;
  const name = positional ? String(explicitName) : nameOrSpec;
  // Spec from the test file path: e2e/<nnn>-<slug>/… → '<nnn>' (falls back to the folder name).
  const folder = basename(dirname(info.file));
  const spec = opts.spec ?? folder.match(/^(\d{3})-/)?.[1] ?? folder;
  const story = opts.story ?? basename(info.file).match(/US\d+/)?.[0] ?? 'misc';
  await settleAnimations(page);
  let builder = new AxeBuilder({ page }).withTags(A11Y_TAGS);
  for (const sel of opts.include ?? []) builder = builder.include(sel);
  for (const sel of opts.exclude ?? []) builder = builder.exclude(sel);
  if (opts.disableRules?.length) builder = builder.disableRules(opts.disableRules);
  const results = await builder.analyze();
  const dir = join('qa', 'evidence', spec, story);
  mkdirSync(dir, { recursive: true });
  const fileName = positional ? `axe-${name}.json` : `${name}-${info.project.name}.axe.json`;
  const file = join(dir, fileName);
  writeFileSync(file, JSON.stringify({ url: results.url, timestamp: results.timestamp, violations: results.violations, incomplete: results.incomplete, passes: results.passes.length }, null, 2));
  await info.attach(fileName, { path: file, contentType: 'application/json' });
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) })), `axe serious/critical violations on ${name}`).toEqual([]);
  return results;
}

/** Lightweight axe check (WCAG 2.1 A/AA): fails the test on any serious or critical violation; no evidence file. */
export async function checkA11y(page: Page, opts: { include?: string[]; exclude?: string[]; disableRules?: string[] } = {}) {
  await settleAnimations(page);
  let builder = new AxeBuilder({ page }).withTags(A11Y_TAGS);
  for (const sel of opts.include ?? []) builder = builder.include(sel);
  for (const sel of opts.exclude ?? []) builder = builder.exclude(sel);
  if (opts.disableRules?.length) builder = builder.disableRules(opts.disableRules);
  const results = await builder.analyze();
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) })), `axe serious/critical violations on ${page.url()}`).toEqual([]);
  return results;
}

// ───────────── 005 Profile & Vault helpers (T002) ─────────────
// makePdf / makePng / uploadVaultDoc are the implementations in e2e/005-profile-vault/support.ts (re-exported,
// not duplicated; that module resolves pdf-lib from apps/api). `inviteAs` above covers the analyst/viewer contexts.

/** `makePdf(pages)` — a real multi-page PDF; `makePng()` — a genuine decodable PNG. */
export { makePdf, makePng } from '../005-profile-vault/support';
/** `uploadVaultDoc(request, {name, bytes, fields})` — multipart POST /api/vault, expects 201, returns the document DTO. */
export { apiUploadOk as uploadVaultDoc } from '../005-profile-vault/support';

/** PUT /api/profile with `body`; expects 200 and returns `{profile, completeness, issues, averageTurnover}`. */
export async function putProfile(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.put('/api/profile', { data: body });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** POST /api/past-contracts (buyerType defaults to 'central'); expects 201 and returns the contract DTO. */
export async function addPastContract(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post('/api/past-contracts', { data: { buyerType: 'central', ...body } });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

/** Evidence screenshot for spec 005: writes `qa/evidence/005/<story>/<name>.png` (story = 'US1' … 'US6', 'HARDEN'). */
export function evidence005(page: Page, story: string, name: string) {
  return evidence(page, '005', story, name);
}

/** `test` with an auto fixture that disposes every context opened by inviteAs(), even when the test fails. */
export const test = base.extend<{ _disposeInvited: void }>({
  _disposeInvited: [async ({}, use) => {
    await use();
    await disposeOpenedContexts();
  }, { auto: true }],
});
export { expect };
