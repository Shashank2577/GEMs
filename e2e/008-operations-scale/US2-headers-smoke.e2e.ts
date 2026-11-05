/**
 * 008 / US2 (#357) — QA task T042 (#397). Ordered, audited releases + security headers.
 *
 * What a browser/local stack can prove here (scenarios 2, 4 [local part], 6, 8 [repo part]):
 *   - security headers + CSP on `/` and `/api/health` (and the SPA fallback, a hashed asset, a 404, a PDF stream);
 *   - `scripts/smoke.sh` passes against the local stack and FAILS on every kind of mismatch (FR-008);
 *   - no CSP violation (securitypolicyviolation events + console) while loading `/`, `/login`, `/dashboard`,
 *     `/vault` including the PDF preview iframe, and the annexure template editor Preview (blob: PDF iframe,
 *     apps/web/src/features/workspace/AnnexuresStep.tsx), on desktop and @mobile;
 *   - a negative control proving the violation detector really fires, so "0 violations" means something.
 * Staging/production criteria (deploy run log, real-domain curl, Neon pooler/retention, restore drill, secret
 * scanning) need Cloudflare/Neon/GitHub-admin access and are judged in qa/evidence/008/US2/VERDICT.md.
 *
 * Shared helpers evidence008/saveTranscript do not exist on this branch (they arrive with US1), so this file uses
 * evidence() and plain fs writes.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, evidence, collectRunArtifacts, signupViaApi } from '../support/fixtures';
import { createWorkspace, newApi, seedApplyFixture, signInAs } from '../support/seed-apply';
import { apiUploadOk, makePdf } from '../005-profile-vault/support';

const SPEC = '008', STORY = 'US2';
const DIR = join('qa', 'evidence', SPEC, STORY);
const PORT = Number(process.env.E2E_PORT || 8788);
const BASE = `http://localhost:${PORT}`;

const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
function transcript(name: string, text: string) {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, `${name}-${test.info().project.name}.txt`);
  writeFileSync(file, text);
  return file;
}

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

/* ───────────────────────── CSP violation monitor ───────────────────────── */

interface Monitor { violations: string[] }
/** Records every `securitypolicyviolation` event (all frames, across navigations) and every CSP console message. */
async function monitorCsp(page: Page): Promise<Monitor> {
  const m: Monitor = { violations: [] };
  await page.exposeFunction('__reportCsp', (msg: string) => { m.violations.push(msg); });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __reportCsp: (s: string) => void }).__reportCsp(
        `event ${e.violatedDirective} blocked=${e.blockedURI} source=${e.sourceFile || '-'}:${e.lineNumber}`);
    });
  });
  page.on('console', (msg) => {
    if (/content security policy|refused to (load|frame|execute|apply|connect|create)/i.test(msg.text())) m.violations.push(`console.${msg.type()} ${msg.text()}`);
  });
  page.on('pageerror', (err) => { if (/content security policy/i.test(err.message)) m.violations.push(`pageerror ${err.message}`); });
  return m;
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(800); // a late securitypolicyviolation event / console line
}

/* ───────────────────────── scenario 4 (local part): headers ───────────────────────── */

const STATIC = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const CSP_DIRECTIVES = [
  "default-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:", "connect-src 'self'", "frame-src 'self' blob:", "frame-ancestors 'self'", "base-uri 'self'",
  "form-action 'self'", "object-src 'none'",
];

test('S4 security headers + CSP on / and /api/health, SPA fallback, asset, 404 and a PDF stream (local stack) @mobile', async ({ page, request }) => {
  const rows: { path: string; status: number; headers: Record<string, string> }[] = [];
  const get = async (path: string) => {
    const r = await request.get(path, { failOnStatusCode: false });
    rows.push({ path, status: r.status(), headers: r.headers() });
    return r;
  };
  const root = await get('/');
  const health = await get('/api/health');
  const deep = await get('/dashboard');
  const nope = await get('/api/nope');

  for (const r of [root, health, deep, nope]) for (const [k, v] of Object.entries(STATIC)) expect(r.headers()[k], `${r.url()} ${k}`).toBe(v);

  // HTML: full CSP, script-src is 'self' + exactly one sha256 hash, never unsafe-inline/eval
  expect(root.status()).toBe(200);
  expect(root.headers()['content-type']).toMatch(/^text\/html/);
  expect(await root.text()).toContain('<div id="root">');
  const csp = root.headers()['content-security-policy'] ?? '';
  for (const d of CSP_DIRECTIVES) expect(csp, `CSP has ${d}`).toContain(d);
  const scriptSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'))!;
  expect(scriptSrc).toMatch(/^script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'$/);
  expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(deep.headers()['content-security-policy'], 'SPA fallback carries the same CSP').toBe(csp);

  // /api/health: JSON, 200, version, db
  expect(health.status()).toBe(200);
  const hj = await health.json();
  expect(hj.db).toBe(true);
  expect(typeof hj.version).toBe('string');
  expect(health.headers()['cache-control']).toBe('no-store');

  // /api/nope → JSON 404 not_found
  expect(nope.status()).toBe(404);
  expect((await nope.json()).error.code).toBe('not_found');

  // HSTS: sent only over https. The local stack is http, so it must be ABSENT here (staging/prod: see VERDICT).
  for (const r of rows) expect(r.headers['strict-transport-security'], `HSTS must not be sent over plain http (${r.path})`).toBeUndefined();

  // hashed asset is immutable + nosniff; _headers config is not served
  const asset = /\/assets\/[^"']+\.js/.exec(await (await request.get('/')).text())?.[0];
  expect(asset, 'index.html references a hashed /assets/*.js').toBeTruthy();
  const a = await get(asset!);
  expect(a.status()).toBe(200);
  expect(a.headers()['cache-control']).toMatch(/immutable/);
  expect(a.headers()['x-content-type-options']).toBe('nosniff');
  const hf = await get('/_headers');
  expect(hf.status()).toBe(404);

  // PDF stream: same-origin framing only
  await signupViaApi(page);
  const doc = await apiUploadOk(page.request, { name: 'GST_REG06_2023.pdf', bytes: await makePdf(1, 'US2 headers'), fields: { type: 'gst', title: 'GST registration' } });
  const pdf = await page.request.get(`/api/vault/${doc.id}/download?inline=1`);
  rows.push({ path: `/api/vault/<id>/download?inline=1`, status: pdf.status(), headers: pdf.headers() });
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toMatch(/application\/pdf/);
  expect(pdf.headers()['content-security-policy']).toBe("frame-ancestors 'self'");
  expect(pdf.headers()['x-content-type-options']).toBe('nosniff');

  // Evidence: render the captured raw headers as a page and screenshot it.
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const names = ['strict-transport-security', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'content-security-policy', 'cache-control', 'content-type'];
  const body = rows.map((r) => `<h3>GET ${esc(r.path)} → ${r.status}</h3><pre>${names.map((n) => `${n}: ${esc(r.headers[n] ?? '(absent)')}`).join('\n')}</pre>`).join('');
  await page.setContent(`<body style="font:13px ui-monospace,monospace;padding:16px;max-width:1300px"><h2>Local stack ${BASE} — response headers (captured by Playwright)</h2>${body}</body>`);
  if (test.info().project.name === 'desktop') await shot(page, 'S4-headers-local'); // text rendering: identical on mobile, so one image
  transcript('S4-headers-local', rows.map((r) => `GET ${r.path} -> ${r.status}\n${names.map((n) => `  ${n}: ${r.headers[n] ?? '(absent)'}`).join('\n')}`).join('\n\n') + '\n');
});

/* ───────────────────────── scenario 2: smoke.sh ───────────────────────── */

interface Fake { hdr?: boolean; version?: string; rootDiv?: boolean; nopeStatus?: number; nopeJson?: boolean; csp?: boolean }
function fakeServer(o: Fake = {}): Promise<{ server: Server; url: string }> {
  const h: Record<string, string> = o.hdr === false ? {} : { ...STATIC };
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/health') return json(200, { ok: true, db: true, version: o.version ?? 'abc1234' });
    if (req.url === '/api/nope') {
      if (o.nopeJson === false) { res.writeHead(o.nopeStatus ?? 200, { 'content-type': 'text/html', ...h }); return void res.end('<html></html>'); }
      return json(o.nopeStatus ?? 404, { error: { code: 'not_found' } });
    }
    const csp = o.csp === false ? {} : { 'content-security-policy': "default-src 'self'; script-src 'self' 'sha256-x'; frame-ancestors 'self'; object-src 'none'" };
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...h, ...csp });
    res.end(o.rootDiv === false ? '<html><body>hi</body></html>' : '<html><body><div id="root"></div></body></html>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}
const execFileP = promisify(execFile);
/** Async on purpose: the in-process fake servers must keep answering while the script runs. */
async function smoke(url: string, version: string) {
  try {
    const { stdout } = await execFileP('bash', ['scripts/smoke.sh', url, version], { env: { ...process.env, SMOKE_RETRIES: '1', SMOKE_RETRY_DELAY: '0' } });
    return { code: 0, out: stdout };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, out: err.stdout + err.stderr };
  }
}

test('S2 smoke.sh passes on the local stack and fails on every mismatch @mobile', async ({ page, request }) => {
  const version = (await (await request.get('/api/health')).json()).version as string;
  const good = await smoke(BASE, version);
  expect(good.code, good.out).toBe(0);
  for (const line of ['health status = 200', `health version = ${version}`, '/ status = 200', '/ contains <div id="root">', '/api/nope status = 404', '/api/nope error.code = not_found'])
    expect(good.out).toContain(line);
  expect(good.out).toContain('SKIP  health strict-transport-security (http base URL');
  expect(good.out).toContain(`smoke: OK for ${BASE}`);

  const log: string[] = [`### local stack ${BASE}, expected version ${version}: exit ${good.code}`, good.out];

  const wrongVersion = await smoke(BASE, 'deadbee');
  expect(wrongVersion.code).toBe(1);
  expect(wrongVersion.out).toMatch(/FAIL  health version: expected 'deadbee', got/);
  log.push(`### same stack, wrong version 'deadbee': exit ${wrongVersion.code}`, wrongVersion.out);

  const cases: [string, Fake, RegExp][] = [
    ['baseline fake server (all correct)', {}, /^$/],
    ['version mismatch', { version: 'zzzzzzz' }, /FAIL  health version/],
    ['SPA shell without <div id="root">', { rootDiv: false }, /FAIL  \/ body does not contain <div id="root">/],
    ['/api/nope returns 200 HTML (SPA fallback swallowing the API 404)', { nopeJson: false }, /FAIL  \/api\/nope status: expected '404', got '200'/],
    ['/api/nope returns 404 but not JSON not_found', { nopeStatus: 404, nopeJson: false }, /FAIL  \/api\/nope error.code/],
    ['security headers missing', { hdr: false }, /FAIL  health x-content-type-options/],
    ['HTML without a Content-Security-Policy', { csp: false }, /FAIL  \/ content-security-policy missing/],
  ];
  for (const [name, fake, re] of cases) {
    const { server, url } = await fakeServer(fake);
    try {
      const r = await smoke(url, 'abc1234');
      if (name.startsWith('baseline')) expect(r.code, r.out).toBe(0);
      else { expect(r.code, `${name}\n${r.out}`).toBe(1); expect(r.out).toMatch(re); }
      log.push(`### ${name}: exit ${r.code}`, r.out);
    } finally { server.close(); }
  }
  expect((await smoke(BASE, 'x')).code).toBe(1);
  let usage = 0; try { execFileSync('bash', ['scripts/smoke.sh'], { stdio: 'ignore' }); } catch (e) { usage = (e as { status: number }).status; }
  expect(usage, 'no args → usage exit 2').toBe(2);
  log.push(`### no arguments: exit ${usage}`);

  const file = transcript('S2-smoke-local', log.join('\n') + '\n');
  await page.setContent(`<body style="font:12px ui-monospace,monospace;padding:16px;white-space:pre-wrap">${readFileSync(file, 'utf8').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</body>`);
  if (test.info().project.name === 'desktop') await shot(page, 'S2-smoke-local'); // text rendering: identical on mobile, so one image
});

/* ───────────────────────── FR-013: no CSP violations in the real UI ───────────────────────── */

test('control: the violation detector fires (inline script + foreign frame are blocked) @mobile', async ({ page }) => {
  const m = await monitorCsp(page);
  await page.goto('/login');
  await settle(page);
  expect(m.violations, 'a clean page starts with zero violations').toEqual([]);
  await page.evaluate(() => {
    const s = document.createElement('script'); s.textContent = 'window.__pwned = 1'; document.body.appendChild(s);
    const f = document.createElement('iframe'); f.src = 'https://example.com/'; document.body.appendChild(f);
  });
  await settle(page);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), 'inline script did not run').toBeUndefined();
  const text = m.violations.join('\n');
  expect(text).toMatch(/script-src/);
  expect(text).toMatch(/frame-src/);
  transcript('control-detector', text + '\n');
  await shot(page, 'control-detector-fires');
});

test('S4 no CSP violations loading / and /login @mobile', async ({ page }) => {
  const m = await monitorCsp(page);
  await page.goto('/');
  await expect(page.locator('#root')).not.toBeEmpty();
  await settle(page);
  await shot(page, 'S4-csp-landing');
  await page.goto('/login');
  await expect(page.getByRole('button', { name: /sign in|log in/i })).toBeVisible();
  await settle(page);
  await shot(page, 'S4-csp-login');
  // the inline theme bootstrap actually ran under the hash (data-theme / class set before paint)
  const themed = await page.evaluate(() => document.documentElement.className + ' ' + (document.documentElement.getAttribute('data-theme') ?? ''));
  test.info().annotations.push({ type: 'theme-bootstrap', description: themed.trim() || '(none)' });
  expect(m.violations, m.violations.join('\n')).toEqual([]);
  transcript('S4-csp-public-pages', 'violations: 0\n');
});

test('S4 no CSP violations on /dashboard and /vault incl. the PDF preview iframe @mobile', async ({ page }) => {
  const m = await monitorCsp(page);
  await signupViaApi(page);
  const doc = await apiUploadOk(page.request, { name: 'GST_REG06_2023.pdf', bytes: await makePdf(2, 'US2 vault preview'), fields: { type: 'gst', title: 'GST registration' } });

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/dashboard|onboarding/);
  await settle(page);
  await shot(page, 'S4-csp-dashboard');

  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Document vault' })).toBeVisible();
  await settle(page);
  await shot(page, 'S4-csp-vault-list');

  const pdfResponses: string[] = [];
  page.on('response', (r) => { if (r.url().includes(`/api/vault/${doc.id}/download`)) pdfResponses.push(`${r.status()} ${r.headers()['content-type']} csp=${r.headers()['content-security-policy']}`); });
  await page.goto(`/vault?doc=${doc.id}`);
  const frame = page.locator(`iframe[title="Preview of ${doc.title}"]`);
  await expect(frame).toBeAttached();
  await expect(frame).toHaveAttribute('src', new RegExp(`/api/vault/${doc.id}/download\\?inline=1`));
  await settle(page);
  await page.waitForTimeout(1500);
  await shot(page, 'S4-csp-vault-pdf-preview');
  expect(pdfResponses.length, 'the PDF iframe requested the file').toBeGreaterThan(0);
  expect(pdfResponses[0]).toMatch(/^200 application\/pdf csp=frame-ancestors 'self'$/);
  expect(m.violations, m.violations.join('\n')).toEqual([]);
  transcript('S4-csp-vault', `final url: ${page.url()}\niframe file response: ${pdfResponses[0]}\nviolations: 0\n`);
});

test('S4 no CSP violations in the annexure template editor Preview (blob: PDF iframe) @mobile', async ({ page, context }) => {
  const api = await newApi();
  const fx = await seedApplyFixture(api);
  await api.dispose();
  const ws = await createWorkspace(fx);
  await signInAs(context, fx, 'bid_manager');
  const m = await monitorCsp(page);

  await page.goto(`/workspaces/${ws.id}?step=annexures&annexure=non_blacklisting`);
  await expect(page.getByRole('list', { name: 'Annexures' })).toBeVisible();
  await settle(page);
  await shot(page, 'S4-csp-annexures-step');

  await page.getByRole('button', { name: /Edit template/ }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('textbox', { name: 'Title', exact: true })).not.toHaveValue('');
  await dlg.getByRole('textbox', { name: 'Body', exact: true }).fill('QA-DRAFT 1. Declaration by {{company.legalName}} for bid {{tender.bidNumber}}.');

  const [resp] = await Promise.all([
    page.waitForResponse((r) => /\/annexures\/non_blacklisting\/preview$/.test(r.url())),
    dlg.getByRole('button', { name: /^Preview$/ }).click(),
  ]);
  expect(resp.status()).toBe(200);
  expect(resp.headers()['content-type']).toMatch(/application\/pdf/);
  expect(resp.headers()['x-content-type-options']).toBe('nosniff');
  expect(resp.headers()['content-security-policy']).toBe("frame-ancestors 'self'");
  const iframe = dlg.locator('iframe[title="Draft preview"]');
  await expect(iframe).toBeAttached();
  const src = (await iframe.getAttribute('src')) ?? '';
  expect(src, 'the preview is a blob: URL').toMatch(/^blob:http/);
  await settle(page);
  await page.waitForTimeout(1500);
  // Headless Chromium has no PDF viewer, so the PDF paints blank. Positive control that `frame-src blob:` really
  // lets a blob: document load in this CSP: an HTML blob framed the same way must render and be readable.
  const blobHtml = await page.evaluate(async () => {
    const url = URL.createObjectURL(new Blob(['<!doctype html><p id="x">blob frame loaded</p>'], { type: 'text/html' }));
    const f = document.createElement('iframe'); f.title = 'control blob frame'; f.src = url; f.style.cssText = 'position:fixed;left:8px;bottom:8px;width:260px;height:60px;z-index:99999;background:#fff';
    document.body.appendChild(f);
    await new Promise((r) => { f.onload = r; setTimeout(r, 3000); });
    return f.contentDocument?.getElementById('x')?.textContent ?? null;
  });
  expect(blobHtml, 'a blob: frame loads under frame-src blob:').toBe('blob frame loaded');
  await settle(page);
  await shot(page, 'S4-csp-annexure-editor-preview');
  transcript('S4-csp-annexure-preview', `preview POST ${resp.status()} ${resp.headers()['content-type']} csp=${resp.headers()['content-security-policy']}\niframe src scheme: ${src.split('/')[0]}//…\nblob: HTML control frame text: ${blobHtml}\nviolations: ${m.violations.length}\n${m.violations.join('\n')}\n`);
  expect(m.violations, m.violations.join('\n')).toEqual([]);
});

/* ───────────────────────── scenarios 6 and 8 (repo-readable parts) ───────────────────────── */

test('S6/S8 wrangler.toml, runbook § Secrets and 001 plan.md (repo contents)', async () => {
  const wr = readFileSync('wrangler.toml', 'utf8');
  const runbook = readFileSync('docs/runbook.md', 'utf8');
  const plan = readFileSync('specs/001-gem-tender-copilot/plan.md', 'utf8');
  const lines: string[] = [];
  const check = (label: string, ok: boolean) => { lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}`); expect(ok, label).toBe(true); };

  check('wrangler.toml [limits] cpu_ms = 120000', /^\[limits\]\s*\ncpu_ms = 120000$/m.test(wr));
  check('[env.staging] name = "tenderpilot-staging"', /\[env\.staging\][^[]*name = "tenderpilot-staging"/.test(wr));
  check('[env.staging] R2 bucket tenderpilot-blobs-staging', /\[\[env\.staging\.r2_buckets\]\][^[]*bucket_name = "tenderpilot-blobs-staging"/.test(wr));
  check('[env.staging.vars] own APP_URL', /\[env\.staging\.vars\][^[]*APP_URL = "https:\/\/staging\.tenderpilot\.in"/.test(wr));
  const crons = [...wr.matchAll(/crons = \["([^"]+)"\]/g)].map((m) => m[1]);
  check(`cron identical in both envs (${crons.join(' | ')})`, crons.length === 2 && crons[0] === crons[1]);
  check('workers_dev = false (workers.dev disabled)', (wr.match(/^workers_dev = false$/gm) ?? []).length >= 2);
  check('production custom domain app.tenderpilot.in', /custom_domain = true/.test(wr) && /app\.tenderpilot\.in/.test(wr));
  check('runbook states Workers Paid is required', /Workers Paid/.test(runbook));

  const secrets = ['DATABASE_URL', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'SENTRY_DSN', 'ADMIN_TOKEN', 'CLOUDFLARE_API_TOKEN', 'NEON_API_KEY'];
  const section = runbook.slice(runbook.indexOf('## Secrets'), runbook.indexOf('### Verify `DATABASE_URL`'));
  for (const s of secrets) {
    const row = section.split('\n').find((l) => l.startsWith(`| \`${s}\``)) ?? '';
    check(`runbook § Secrets row for ${s} has location, user, rotation, blast radius`, row.split('|').filter((c) => c.trim()).length >= 5);
  }
  check('specs/001 plan.md no longer mentions SESSION_SECRET except to say it was removed', !/SESSION_SECRET/.test(plan));
  check('runbook § Restore drill has a drill log table', /### Drill log/.test(runbook));
  const pending = /_pending operator_/.test(runbook);
  lines.push(`INFO  restore-drill log row is ${pending ? 'still "_pending operator_" (T041 open): no dated drill recorded' : 'filled in'}`);
  transcript('S6-S8-repo-config', lines.join('\n') + '\n');
});
