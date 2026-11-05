import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** Phone viewport (375×812, iPhone X class) for layout checks. */
export async function atPhone(page: Page) {
  await page.setViewportSize({ width: 375, height: 812 });
}

/** Asserts the current page does not scroll horizontally (no element wider than the viewport). */
export async function noHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `page scrolls horizontally: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth);
}

export const test = base;
export { expect };
