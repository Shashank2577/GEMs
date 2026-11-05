/**
 * 008 / US4 — The service stays fast and inside platform limits as tenders, orgs and documents grow (story #359, QA task T077 #429).
 *
 * One test per acceptance scenario that is observable end-to-end (specs/008-operations-scale/spec.md, scenarios 1–10).
 * Screenshots go to qa/evidence/008/US4/, one video per test (collectRunArtifacts), API/DB transcripts as .txt.
 *
 * Not driven from Playwright (their evidence is the committed transcripts + the API suite, see VERDICT.md):
 *  - sc1 (≥ 1 s between GeM requests across 20 orgs): `K=20 scripts/load/gem-fetch.sh` needs the cluster-wide lease on, while this E2E server runs
 *    with GEM_MIN_INTERVAL_MS=0 (e2e/support/start-api.sh). Transcript: load-gem-fetch.txt.
 *  - sc4/sc5 (p95 and EXPLAIN on 500k tenders / 1M notifications): too large for a per-run fixture. Transcripts: load-feed*.txt, explain-500k*.txt.
 *  - the cron half of sc2 (log line "ingestion skipped: already running"): apps/api/test/gem-lease.test.ts.
 *
 * Server environment this spec needs (set by the runner, not by product code):
 *   PACKET_MAX_INPUT_BYTES=41943040           (the Worker's cap; the Node default is 60 MB)
 *   ANTHROPIC_API_KEY=qa-fake LLM_BASE_URL=http://127.0.0.1:${E2E_LLM_PORT:-4114}   (sc7: this file serves a counting fake Anthropic API)
 * Direct DB access (psql) is used only to create states the public API cannot produce: a tender row without a GeM link, a running ingestion row,
 * a manual sync that "finished 4 minutes ago", stored vault sizes.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, uniqueUser, evidence, GEM_URL, atPhone } from '../support/fixtures';
import { apiAs, createWorkspace, newApi, seedApplyFixture, signInAs, E2E_PORT, type ApplyFixture } from '../support/seed-apply';

const SPEC = '008';
const STORY = 'US4';
const DIR = join('qa', 'evidence', SPEC, STORY);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
const LLM_PORT = Number(process.env.E2E_LLM_PORT || 4114);
const MB = 1024 * 1024;
const PROJECT = () => test.info().project.name;
const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${PROJECT()}`);
const toastWith = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
const BIDS = join(process.cwd(), 'packages/core/test/fixtures/bids');

const { PDFDocument, StandardFonts } = createRequire(join(process.cwd(), 'packages/core/package.json'))('pdf-lib') as typeof import('pdf-lib');

// Same contract as fixtures.collectRunArtifacts (one .webm per test in qa/evidence/008/US4/), but it waits for the recorder to finish
// (`video.saveAs`) — collectRunArtifacts copies `video.path()` right after close(), which truncates videos of tests shorter than ~6 s.
test.afterEach(async ({ page }) => {
  const info = test.info();
  if (info.status === 'skipped') return; // a skipped variant must not overwrite the video of its twin (same title prefix)
  mkdirSync(DIR, { recursive: true });
  const slug = info.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
  const video = page.video();
  await page.close();
  if (video) await video.saveAs(join(DIR, `${slug}-${info.project.name}.webm`)).catch(() => undefined);
});

// ───────────── helpers ─────────────

function psql(sql: string): string {
  return execFileSync('psql', [E2E_DB, '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
}

class Transcript {
  private lines: string[] = [];
  constructor(private name: string) { this.add(`# ${name} — project ${PROJECT()} — ${new Date().toISOString()}`); }
  add(line = '') { this.lines.push(line); }
  async http(label: string, res: Awaited<ReturnType<APIRequestContext['get']>>, reqNote: string, ms?: number) {
    const body = (await res.text()).slice(0, 700);
    this.add(`### ${label}`);
    this.add(`> ${reqNote}`);
    this.add(`< ${res.status()}${ms != null ? `  (${ms} ms)` : ''}`);
    this.add(body);
    this.add();
  }
  render() { return this.lines.join('\n'); }
  save() {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${this.name}-${PROJECT()}.txt`), this.lines.join('\n') + '\n');
  }
}

async function errorOf(res: Awaited<ReturnType<APIRequestContext['get']>>) {
  const j = await res.json().catch(() => ({}));
  return { status: res.status(), code: j?.error?.code as string | undefined, message: j?.error?.message as string | undefined, details: j?.error?.details };
}

/** A fresh org owner signed in on `page` (API signup puts the session cookie on the page's context). */
async function signedUp(page: Page, prefix = 'cap') {
  const user = uniqueUser(prefix);
  const res = await page.request.post('/api/auth/signup', { data: user });
  expect(res.status(), await res.text()).toBe(201);
  return user;
}

/** A tender row without a GeM link (so nothing is fetched from mock-gem). */
function insertTender(): { id: string; bidNumber: string } {
  const bid = `GEM/2026/B/${9_100_000 + Math.floor(Math.random() * 899_999)}`;
  const id = psql(`insert into tenders (source, bid_number, title, source_url, content_hash, status, end_at)
    values ('gem', '${bid}', 'QA capacity tender ${bid}', 'https://example.invalid/${bid}', 'qa-cap-${Date.now()}-${Math.random()}', 'open', now() + interval '20 days') returning id;`).split('\n')[0];
  return { id, bidNumber: bid };
}
const docCount = (tenderId: string) => Number(psql(`select count(*) from tender_documents where tender_id='${tenderId}'`));

async function textPdf(pages: number, label = 'Bid'): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([595, 842]).drawText(`${label} page ${i} of ${pages}. Delivery within 30 days. EMD Rs 50,000.`, { x: 40, y: 780, size: 12, font });
  return Buffer.from(await doc.save());
}
async function scannedPdf(pages = 4): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]); // no text layer at all
  return Buffer.from(await doc.save());
}
const pdfFile = (name: string, buffer: Buffer) => ({ name, mimeType: 'application/pdf', buffer });
const uploadApi = (r: APIRequestContext, tenderId: string, file: ReturnType<typeof pdfFile>, kind = 'bid') =>
  r.post(`/api/tenders/${tenderId}/documents`, { multipart: { kind, file } });

/** Make the latest manual sync look like it finished `minutesAgo` minutes ago (insert one if none). Returns its finished_at ISO. */
function manualSyncFinishedAgo(minutesAgo: number): string {
  psql(`delete from ingestion_runs where status='running'`);
  const has = psql(`select count(*) from ingestion_runs where trigger='manual' and finished_at is not null`);
  if (has === '0') {
    psql(`insert into ingestion_runs (trigger, status, pages_fetched, tenders_seen, started_at, finished_at)
          values ('manual','success',3,36,now() - interval '${minutesAgo + 1} minutes', now() - interval '${minutesAgo} minutes')`);
  } else {
    psql(`update ingestion_runs set started_at = now() - interval '${minutesAgo + 1} minutes', finished_at = now() - interval '${minutesAgo} minutes'
          where id = (select id from ingestion_runs where trigger='manual' and finished_at is not null order by finished_at desc limit 1)`);
  }
  return psql(`select to_char(finished_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from ingestion_runs where trigger='manual' and finished_at is not null order by finished_at desc limit 1`);
}
const mockGemRequests = async (r: APIRequestContext) => ((await (await r.get(`${GEM_URL}/__admin/requests`)).json()) as { items: unknown[] }).items.length;


// ───────────── fake Anthropic API (sc7) ─────────────
interface LlmCall { at: number; chars: number }
const llmCalls: LlmCall[] = [];
let llmServer: Server | undefined;
let llmDelayMs = 0; // round-2 addendum: a slow fake LLM (sc7b)
async function startFakeLlm() {
  if (llmServer) return;
  llmServer = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let chars = 0;
      try {
        const j = JSON.parse(body) as { system?: string; messages?: { content: string }[] };
        chars = (j.system ?? '').length + (j.messages ?? []).reduce((n, m) => n + String(m.content).length, 0);
      } catch { /* not json */ }
      llmCalls.push({ at: Date.now(), chars });
      res.setHeader('content-type', 'application/json');
      setTimeout(() => res.end(JSON.stringify({ id: 'msg_qa', type: 'message', role: 'assistant', model: 'qa-fake', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"requirements":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } })), llmDelayMs);
    });
  });
  await new Promise<void>((ok, bad) => { llmServer!.once('error', bad); llmServer!.listen(LLM_PORT, '127.0.0.1', () => ok()); });
}
test.afterAll(async () => { await new Promise<void>((ok) => (llmServer ? llmServer.close(() => ok()) : ok())); llmServer = undefined; });

// ═════════════ scenario 2 — one running ingestion, atomically ═════════════

test.describe('sc2 single running ingestion', () => {
  test('sc2a a running ingestion blocks a manual "Sync now" with 409 ingestion_running; a second running row is impossible (partial unique index)', async ({ page }) => {
    const t = new Transcript('sc2a-ingestion-single-flight');
    await signedUp(page, 'sc2a');
    psql(`delete from ingestion_runs`);
    psql(`insert into ingestion_runs (trigger, status, started_at) values ('cron','running', now())`);
    t.add(`running rows after cron tick start: ${psql(`select count(*) from ingestion_runs where status='running'`)}`);
    const before = await mockGemRequests(page.request);

    const res = await page.request.post('/api/ingestion/run', { data: {} });
    await t.http('manual Sync now while a cron run is in progress', res, 'POST /api/ingestion/run {}');
    const err = await errorOf(res);
    expect(err).toMatchObject({ status: 409, code: 'ingestion_running', message: 'A GeM sync is already running — results will appear shortly.' });
    expect(await mockGemRequests(page.request), 'the refused call sends no GeM request').toBe(before);

    // The database itself refuses a second running row.
    let violation = '';
    try { psql(`insert into ingestion_runs (trigger, status) values ('manual','running')`); } catch (e) { violation = String((e as { stderr?: string }).stderr ?? e); }
    t.add(`second insert of a status='running' row → ${violation.trim().split('\n')[0]}`);
    expect(violation).toContain('ingestion_runs_one_running_uq');
    expect(psql(`select count(*) from ingestion_runs where status='running'`)).toBe('1');
    t.add(`running rows afterwards: 1`);

    // UI: the bid manager sees the same message when pressing Sync now during the run.
    await page.goto('/settings/sync');
    await expect(page.getByRole('button', { name: /sync now/i }).first()).toBeVisible();
    await page.getByRole('button', { name: /sync now/i }).first().click();
    await expect(toastWith(page, 'A GeM sync is already running')).toBeVisible();
    await shot(page, 'sc2a-409-already-running-toast');
    psql(`delete from ingestion_runs where status='running'`);
    t.save();
  });

  test('sc2b three concurrent manual syncs → exactly one runs (200); the others get 409/429; never two `running` rows', async ({ page }) => {
    const t = new Transcript('sc2b-concurrent-manual-syncs');
    await signedUp(page, 'sc2b');
    psql(`delete from ingestion_runs`);
    let maxRunning = 0;
    let polling = true;
    const poll = (async () => { while (polling) { maxRunning = Math.max(maxRunning, Number(psql(`select count(*) from ingestion_runs where status='running'`))); await new Promise((r) => setTimeout(r, 15)); } })();
    const calls = await Promise.all([1, 2, 3].map(async (i) => { const r = await page.request.post('/api/ingestion/run', { data: { pages: 5 } }); return { i, ...(await errorOf(r).then((e) => (r.ok() ? { status: r.status(), code: 'ok' } : e))) }; }));
    polling = false; await poll;
    for (const c of calls) t.add(`call ${c.i}: ${c.status} ${c.code ?? ''}`);
    t.add(`max concurrent status='running' rows observed (15 ms polling): ${maxRunning}`);
    t.add(`ingestion_runs: ${psql(`select string_agg(trigger||':'||status, ', ') from ingestion_runs`)}`);
    expect(calls.filter((c) => c.status === 200).length, JSON.stringify(calls)).toBe(1);
    expect(calls.filter((c) => c.status !== 200).every((c) => (c.status === 409 && c.code === 'ingestion_running') || (c.status === 429 && c.code === 'sync_cooldown')), JSON.stringify(calls)).toBeTruthy();
    expect(maxRunning).toBeLessThanOrEqual(1);
    expect(Number(psql(`select count(*) from ingestion_runs where trigger='manual' and status in ('success','partial')`))).toBe(1);
    await page.goto('/settings/sync');
    await expect(page.getByText('Ingestion runs')).toBeVisible();
    await shot(page, 'sc2b-one-run-recorded');
    t.save();
  });
});

// ═════════════ scenario 3 — manual sync cooldown ═════════════

for (const phone of [false, true]) {
  test(`sc3 manual sync finished 4 minutes ago: API 429 sync_cooldown with retryAt = finish + 10 min and 0 GeM requests; Sync now disabled with tooltip "Next manual sync at HH:MM IST"${phone ? ' @mobile' : ''}`, async ({ page }) => {
    test.skip(phone && PROJECT() !== 'mobile', 'phone variant runs in the mobile project');
    test.skip(!phone && PROJECT() === 'mobile', 'desktop variant');
    const t = new Transcript('sc3-sync-cooldown');
    if (phone) await atPhone(page);
    await signedUp(page, 'sc3');
    const finishedAt = manualSyncFinishedAgo(4);
    const expectedRetry = new Date(Date.parse(finishedAt) + 10 * 60_000).toISOString();
    t.add(`latest manual sync finished_at (set to now-4min): ${finishedAt} → expected retryAt ${expectedRetry}`);

    const gemBefore = await mockGemRequests(page.request);
    const res = await page.request.post('/api/ingestion/run', { data: {} });
    await t.http('Sync now 4 minutes after a finished manual sync', res, 'POST /api/ingestion/run {}');
    const err = await errorOf(res);
    expect(err.status).toBe(429);
    expect(err.code).toBe('sync_cooldown');
    expect(err.details?.retryAt).toBe(expectedRetry);
    expect(await mockGemRequests(page.request), 'mock-gem receives 0 requests').toBe(gemBefore);
    t.add(`mock-gem requests during the refused call: ${(await mockGemRequests(page.request)) - gemBefore}`);
    const runs = await (await page.request.get('/api/ingestion/runs')).json();
    t.add(`GET /api/ingestion/runs → nextManualSyncAt=${runs.nextManualSyncAt} manualSyncCooldownMin=${runs.manualSyncCooldownMin}`);
    expect(runs.manualSyncCooldownMin).toBe(10);
    expect(runs.nextManualSyncAt).toBe(expectedRetry);

    const clock = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(expectedRetry)).toLowerCase();
    const expectText = `Next manual sync at ${clock} IST`;
    t.add(`expected tooltip: "${expectText}"`);

    // Feed header pill → popover
    await page.goto('/tenders');
    await page.getByRole('button', { name: /GeM sync status/i }).click();
    const sync = page.getByRole('button', { name: 'Sync now' });
    await expect(sync).toBeDisabled();
    const tip = await sync.locator('xpath=..').getAttribute('title');
    t.add(`feed popover: Sync now disabled; tooltip (title) = "${tip}"`);
    expect(tip).toBe(expectText);
    await expect(page.locator('#sync-cooldown-hint')).toContainText('manual syncs are kept 10 minutes apart');
    await shot(page, 'sc3-feed-popover-sync-disabled');

    // Settings → Sync
    await page.goto('/settings/sync');
    const settingsBtn = page.getByRole('button', { name: /sync now/i }).first();
    await expect(settingsBtn).toBeDisabled();
    const settingsTip = await settingsBtn.locator('xpath=..').getAttribute('title');
    t.add(`settings: Sync now disabled; tooltip = "${settingsTip}"`);
    expect(settingsTip).toBe(expectText);
    await expect(page.locator('#settings-sync-cooldown-hint')).toContainText(/Next manual sync at/);
    await shot(page, 'sc3-settings-sync-disabled');
    if (phone) {
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(m.sw, `horizontal overflow ${m.sw} > ${m.iw}`).toBeLessThanOrEqual(m.iw);
    }
    t.save();
  });
}

// ═════════════ scenario 6 — list queries stay lean ═════════════

test('sc6 feed, watchlist preview and dashboard responses carry list columns only (no raw payload, no document text)', async ({ page }) => {
  const t = new Transcript('sc6-lean-list-queries');
  await signedUp(page, 'sc6');
  expect((await page.request.post('/api/demo/seed')).ok()).toBeTruthy();
  const forbidden = ['raw', 'text', 'contentHash', 'content_hash'];
  const check = (label: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    t.add(`${label}: ${keys.length} keys → ${keys.join(', ')}`);
    for (const f of forbidden) expect(keys, `${label} must not expose ${f}`).not.toContain(f);
  };
  const feed = await (await page.request.get('/api/tenders?pageSize=5')).json();
  check('GET /api/tenders item', feed.items[0]);
  const prev = await page.request.post('/api/watchlists/preview', { data: { criteria: { keywords: ['laptop'] } } });
  expect(prev.status()).toBe(200);
  const pj = await prev.json();
  const pRows = (pj.items ?? pj.tenders ?? []) as Record<string, unknown>[];
  if (pRows[0]) check('POST /api/watchlists/preview item', pRows[0]);
  const dash = await page.request.get('/api/dashboard');
  expect(dash.status()).toBe(200);
  const dj = await dash.json();
  t.add(`GET /api/dashboard keys: ${Object.keys(dj).join(', ')}`);
  expect(JSON.stringify(dj)).not.toMatch(/"raw"|"contentHash"/);
  t.add('SQL-level check (query shape, `tenders.raw` / `tender_documents.text` never selected): apps/api/test/perf-indexes.test.ts "list queries read tenderListColumns only" — see VERDICT.md for its run.');
  await page.goto('/tenders');
  await expect(page.getByRole('heading', { name: /tenders/i }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await shot(page, 'sc6-feed-renders-from-list-columns');
  t.save();
});

// ═════════════ scenario 7 — LLM budget per analysis ═════════════

for (const phone of [false, true]) {
  // Caps amended by 004/FR-051 (8 calls, 480,000 chars; 008/FR-031 note): 10 one-chunk documents overflow the 8 calls.
  test(`sc7 tender with 10 documents + LLM: ≤ 8 LLM calls, ≤ 480,000 chars, < 120 s, warning "AI review covered 8 of 10 documents; the rest were checked by rules only."${phone ? ' @mobile' : ''}`, async ({ page }) => {
    test.skip(phone && PROJECT() !== 'mobile', 'phone variant runs in the mobile project');
    test.skip(!phone && PROJECT() === 'mobile', 'desktop variant');
    test.setTimeout(150_000);
    await startFakeLlm();
    const t = new Transcript('sc7-llm-budget');
    if (phone) await atPhone(page);
    await signedUp(page, 'sc7');
    const tender = insertTender();
    const files: [string, string, string][] = [
      ['go-it-services.pdf', 'bid', 'Bid document'], ['review-hardware-oem.pdf', 'atc', 'ATC'], ['emd-exempt-mse.pdf', 'corrigendum', 'Corrigendum'],
      ['nogo-experience.pdf', 'boq', 'BOQ'], ['synthetic-tender.pdf', 'other', 'Other'],
    ];
    const { readFileSync } = await import('node:fs');
    for (const copy of ['', '-copy']) {
      for (const [name, kind] of files) {
        const r = await uploadApi(page.request, tender.id, pdfFile(name.replace(/\.pdf$/, `${copy}.pdf`), readFileSync(join(BIDS, name))), kind);
        expect(r.status(), await r.text()).toBe(201);
      }
    }
    t.add(`tender ${tender.bidNumber} has ${docCount(tender.id)} documents (bid, ATC, corrigendum, BOQ, other; each twice)`);
    llmCalls.length = 0;
    await page.goto(`/tenders/${tender.id}`);
    const started = Date.now();
    await page.getByRole('button', { name: /Analyse eligibility/ }).first().click();
    const warn = page.getByTestId('analysis-warnings');
    await expect(warn).toContainText('AI review covered 8 of 10 documents; the rest were checked by rules only.', { timeout: 120_000 });
    const wall = Date.now() - started;
    const totalChars = llmCalls.reduce((n, c) => n + c.chars, 0);
    t.add(`LLM calls made by this analysis: ${llmCalls.length}; characters sent per call: [${llmCalls.map((c) => c.chars).join(', ')}]; total ${totalChars}`);
    t.add(`wall clock click → warning visible: ${wall} ms`);
    expect(llmCalls.length).toBeLessThanOrEqual(8);
    expect(llmCalls.length).toBeGreaterThan(0);
    expect(totalChars).toBeLessThanOrEqual(480_000);
    expect(wall).toBeLessThan(120_000);
    const a = await (await page.request.get(`/api/tenders/${tender.id}/analysis`)).json();
    t.add(`GET analysis → method=${a.method} warnings=${JSON.stringify(a.warnings)}`);
    expect(a.warnings).toEqual([{ code: 'llm_budget_exhausted', covered: 8, total: 10 }]);
    await shot(page, 'sc7-analysis-budget-warning');
    t.save();
  });
}

// ═════════════ scenario 8 — 301-page document ═════════════

test('sc8 a 301-page PDF is refused with 422 document_too_long (UI toast + API), no tender_documents row; 300 pages is accepted', async ({ page }) => {
  const t = new Transcript('sc8-document-too-long');
  await signedUp(page, 'sc8');
  const tender = insertTender();
  const MSG = 'This document has 301 pages. TenderPilot accepts documents of up to 300 pages and reads the first 150 — upload the bid document and ATC separately.';

  // Boundary first: exactly 300 pages is accepted.
  const ok = await uploadApi(page.request, tender.id, pdfFile('exactly-300-pages.pdf', await textPdf(300, 'Boundary')));
  await t.http('300-page upload (boundary)', ok, 'POST /api/tenders/:id/documents');
  expect(ok.status()).toBe(201);
  expect(docCount(tender.id)).toBe(1);

  const big = await textPdf(301, 'Too long');
  // API
  const res = await uploadApi(page.request, tender.id, pdfFile('301-pages.pdf', big));
  await t.http('301-page upload', res, 'POST /api/tenders/:id/documents (301 pages)');
  const err = await errorOf(res);
  expect(err).toMatchObject({ status: 422, code: 'document_too_long', message: MSG });
  expect(docCount(tender.id), 'no row written for the 301-page file').toBe(1);
  // UI
  await page.goto(`/tenders/${tender.id}?tab=documents`);
  await page.locator('input[type="file"]').setInputFiles(pdfFile('301-pages.pdf', big));
  await expect(toastWith(page, 'This document has 301 pages')).toBeVisible();
  await expect(toastWith(page, 'upload the bid document and ATC separately')).toBeVisible();
  expect(docCount(tender.id)).toBe(1);
  t.add(`documents stored for the tender after both attempts: ${docCount(tender.id)} (only the 300-page file)`);
  await shot(page, 'sc8-301-pages-422-toast');
  t.save();
});

// ═════════════ scenario 9 — scanned PDF ═════════════

test('sc9 a PDF with no text layer is accepted as a scan, then Analyse → 422 scanned_document with the upload-the-text-PDF message', async ({ page }) => {
  const t = new Transcript('sc9-scanned-document');
  await signedUp(page, 'sc9');
  const tender = insertTender();
  const up = await uploadApi(page.request, tender.id, pdfFile('scanned-bid.pdf', await scannedPdf(4)));
  await t.http('upload of a 4-page PDF without text', up, 'POST /api/tenders/:id/documents');
  expect(up.status()).toBe(201);
  expect(await up.json()).toMatchObject({ hasText: false, pageCount: 4 });

  const res = await page.request.post(`/api/tenders/${tender.id}/analyse`);
  await t.http('Analyse', res, 'POST /api/tenders/:id/analyse');
  const err = await errorOf(res);
  expect(err.status).toBe(422);
  expect(err.code).toBe('scanned_document');
  // Spec writes "OCR'd" (straight apostrophe); the product uses the typographic one (observation in VERDICT.md).
  expect(err.message?.replace(/’/g, "'")).toBe("This PDF is a scan without text. Upload the text PDF from GeM or an OCR'd copy.");
  expect(Number(psql(`select count(*) from analyses where tender_id='${tender.id}'`)), 'no analysis row for a scan').toBe(0);

  await page.goto(`/tenders/${tender.id}`);
  await page.getByRole('button', { name: /Analyse eligibility/ }).first().click();
  await expect(toastWith(page, 'This PDF is a scan without text')).toBeVisible();
  await expect(toastWith(page, 'Upload the text PDF from GeM')).toBeVisible();
  await shot(page, 'sc9-scanned-422-toast');
  t.save();
});

// ═════════════ scenario 10 — packet size / item caps ═════════════

const blobFiles = (): number => {
  const root = resolve('.data', `e2e-blobs-${E2E_PORT}`);
  const walk = (d: string): number => { try { return readdirSync(d).reduce((n, f) => { const p = join(d, f); return n + (statSync(p).isDirectory() ? walk(p) : 1); }, 0); } catch { return 0; } };
  return walk(root);
};

async function packetFixture(): Promise<{ fx: ApplyFixture; ws: string }> {
  const a = await newApi();
  const fx = await seedApplyFixture(a);
  await a.dispose();
  const ws = (await createWorkspace(fx)).id;
  return { fx, ws };
}
const packetCount = async (fx: ApplyFixture, ws: string) => {
  const api = await apiAs(fx, 'analyst');
  const n = (await (await api.get(`/api/workspaces/${ws}/packets`)).json()).total as number;
  await api.dispose();
  return n;
};

test('sc10a 41 items → 413 packet_too_large "This packet has 41 items (limit 40)…" before any packets row or stored file', async ({ page }) => {
  const t = new Transcript('sc10a-packet-41-items');
  const { fx, ws } = await packetFixture();
  const api = await apiAs(fx, 'analyst');
  const rowsBefore = await packetCount(fx, ws);
  const filesBefore = blobFiles();
  const items = Array.from({ length: 41 }, (_, i) => ({ kind: 'cover', title: `Item ${i + 1}` }));
  const res = await api.post(`/api/workspaces/${ws}/packets`, { data: { items } });
  await t.http('Build packet with 41 items', res, `POST /api/workspaces/${ws}/packets {items: 41 × cover}`);
  expect(await errorOf(res)).toMatchObject({ status: 413, code: 'packet_too_large', message: 'This packet has 41 items (limit 40). Deselect some items and try again.' });
  expect(await packetCount(fx, ws)).toBe(rowsBefore);
  expect(blobFiles()).toBe(filesBefore);
  t.add(`packets rows before/after: ${rowsBefore}/${await packetCount(fx, ws)}; stored files before/after: ${filesBefore}/${blobFiles()}`);
  const ok = await api.post(`/api/workspaces/${ws}/packets`, { data: { items: items.slice(0, 40) } });
  await t.http('Control: 40 items', ok, 'POST … {items: 40 × cover}');
  expect(ok.status(), 'exactly 40 items is allowed').toBe(201);
  await api.dispose();
  t.save();
  // Show the transcript on screen so the video/screenshot carry the evidence (there is no 41-item control in the UI).
  await page.setContent(`<body style="font:14px/1.5 ui-monospace,monospace;padding:24px;background:#fff;color:#111"><h2>sc10a — 41 items → 413 packet_too_large</h2><pre style="white-space:pre-wrap">${t.render().replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre></body>`);
  await shot(page, 'sc10a-41-items-413-transcript');
});

for (const phone of [false, true]) {
  test(`sc10b selected documents total 45 MB with the 40 MB Worker cap → 413 "…add up to 45.0 MB — remove or compress some before building (limit 40 MB)." toast, no packets row or file${phone ? ' @mobile' : ''}`, async ({ page, context }) => {
    test.skip(phone && PROJECT() !== 'mobile', 'phone variant runs in the mobile project');
    test.skip(!phone && PROJECT() === 'mobile', 'desktop variant');
    test.setTimeout(120_000);
    const t = new Transcript('sc10b-packet-45mb');
    if (phone) await atPhone(page);
    const { fx, ws } = await packetFixture();
    const api = await apiAs(fx, 'analyst');
    const setOem = (bytes: number) => psql(`update vault_documents set size_bytes=${Math.round(bytes)} where id='${fx.docs.oem}'`);

    // Probe: learn the sum of everything else in the default packet, then size the one document so the total is exactly 45 MB.
    setOem(41 * MB);
    const probe = await errorOf(await api.post(`/api/workspaces/${ws}/packets`, { data: {} }));
    expect(probe.code, JSON.stringify(probe)).toBe('packet_too_large');
    const others = (probe.details.totalBytes as number) - 41 * MB;
    setOem(45 * MB - others);
    t.add(`default packet: other items sum to ${others} bytes; Dell MAF stored size set to ${45 * MB - others} bytes → total ${45 * MB} bytes (45.0 MB); PACKET_MAX_INPUT_BYTES=41943040 (40 MB)`);

    const rowsBefore = await packetCount(fx, ws);
    const filesBefore = blobFiles();
    const res = await api.post(`/api/workspaces/${ws}/packets`, { data: {} });
    await t.http('Build packet at 45 MB', res, `POST /api/workspaces/${ws}/packets {}`);
    const err = await errorOf(res);
    expect(err).toMatchObject({ status: 413, code: 'packet_too_large', message: 'These documents add up to 45.0 MB — remove or compress some before building (limit 40 MB).' });
    expect(err.details).toMatchObject({ totalBytes: 45 * MB, limitBytes: 40 * MB });
    expect(await packetCount(fx, ws), 'no packets row').toBe(rowsBefore);
    expect(blobFiles(), 'no R2/blob object written').toBe(filesBefore);
    t.add(`packets rows before/after: ${rowsBefore}/${await packetCount(fx, ws)}; stored files before/after: ${filesBefore}/${blobFiles()}`);

    await signInAs(context, fx, 'analyst');
    await page.goto(`/workspaces/${ws}?step=packet`);
    await expect(page.getByRole('heading', { name: 'Packet contents' })).toBeVisible();
    await page.getByRole('button', { name: /(Re)?build packet/i }).click();
    const toast = toastWith(page, /add up to 45\.0 MB/);
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('remove or compress some before building (limit 40 MB)');
    expect(await packetCount(fx, ws)).toBe(rowsBefore);
    await shot(page, 'sc10b-413-toast-45mb');
    if (phone) {
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(m.sw, `horizontal overflow ${m.sw} > ${m.iw}`).toBeLessThanOrEqual(m.iw);
    }
    // Removing the heavy file makes the packet buildable again.
    setOem(1 * MB);
    const ok = await api.post(`/api/workspaces/${ws}/packets`, { data: {} });
    t.add(`control: Dell MAF back to 1 MB → build ${ok.status()}`);
    expect(ok.status()).toBe(201);
    await api.dispose();
    t.save();
  });
}

// ═════════════ round-2 addendum (PR #515 head after the 1c81196 review fixes) ═════════════

test('sc7b slow LLM (55 s per call): the analysis still finishes `done` inside 120 s, is never reported timed out, overflow documents are rules-only with the budget warning', async ({ page }) => {
  test.skip(PROJECT() === 'mobile', 'desktop only');
  test.setTimeout(170_000);
  await startFakeLlm();
  const t = new Transcript('sc7b-slow-llm-deadline');
  await signedUp(page, 'sc7b');
  const tender = insertTender();
  const { readFileSync } = await import('node:fs');
  for (const [name, kind] of [['go-it-services.pdf', 'bid'], ['review-hardware-oem.pdf', 'atc'], ['emd-exempt-mse.pdf', 'corrigendum'], ['nogo-experience.pdf', 'boq'], ['synthetic-tender.pdf', 'other']] as const) {
    expect((await uploadApi(page.request, tender.id, pdfFile(name, readFileSync(join(BIDS, name))), kind)).status()).toBe(201);
  }
  llmCalls.length = 0;
  llmDelayMs = 55_000;
  try {
    const started = Date.now();
    const res = await page.request.post(`/api/tenders/${tender.id}/analyse`, { timeout: 150_000 });
    const wall = Date.now() - started;
    await t.http('Analyse with a fake LLM that answers after 55 s', res, 'POST /api/tenders/:id/analyse', wall);
    expect(res.status()).toBeLessThan(300);
    t.add(`wall clock: ${wall} ms; LLM calls started: ${llmCalls.length} at +${llmCalls.map((c) => Math.round((c.at - started) / 1000)).join(' s, +')} s`);
    expect(wall).toBeLessThan(120_000);
    expect(llmCalls.length).toBeLessThanOrEqual(2);
    const a = await (await page.request.get(`/api/tenders/${tender.id}/analysis`)).json();
    t.add(`GET analysis → status=${a.status} method=${a.method} error=${a.error} lastAttempt=${JSON.stringify(a.lastAttempt ?? null)} warnings=${JSON.stringify(a.warnings)}`);
    expect(a.status).toBe('done');
    expect(a.error).toBeNull();
    expect(a.lastAttempt, 'never reported as running/failed/timed out').toBeUndefined();
    expect(a.warnings.map((w: { code: string }) => w.code)).toContain('llm_budget_exhausted');
    expect(psql(`select status from analyses where tender_id='${tender.id}' order by created_at desc limit 1`)).toBe('done');
    await page.goto(`/tenders/${tender.id}`);
    await expect(page.getByTestId('analysis-warnings')).toContainText('rules only');
    await expect(page.getByText(/timed out/i)).toHaveCount(0);
    await shot(page, 'sc7b-slow-llm-done');
  } finally { llmDelayMs = 0; }
  t.save();
});

test('sc8b a 200-page document is accepted and truncated: 201 with a pages_truncated warning on the upload, first 150 pages stored/read', async ({ page }) => {
  test.skip(PROJECT() === 'mobile', 'desktop only');
  const t = new Transcript('sc8b-200-pages-truncated');
  await signedUp(page, 'sc8b');
  const tender = insertTender();
  const up = await uploadApi(page.request, tender.id, pdfFile('200-pages.pdf', await textPdf(200, 'Long')));
  await t.http('200-page upload', up, 'POST /api/tenders/:id/documents');
  expect(up.status()).toBe(201);
  expect(await up.json()).toMatchObject({ pageCount: 150, totalPages: 200, warnings: expect.arrayContaining([{ code: 'pages_truncated', analysed: 150, total: 200 }]) });
  expect(docCount(tender.id)).toBe(1);
  const res = await page.request.post(`/api/tenders/${tender.id}/analyse`);
  await t.http('Analyse', res, 'POST /api/tenders/:id/analyse');
  expect(res.status()).toBeLessThan(300);
  const a = await (await page.request.get(`/api/tenders/${tender.id}/analysis`)).json();
  t.add(`GET analysis → status=${a.status} warnings=${JSON.stringify(a.warnings)} documents=${JSON.stringify(a.documents)}`);
  expect(a.status).toBe('done');
  expect(a.documents).toMatchObject([{ pageCount: 150, totalPages: 200 }]);
  await page.goto(`/tenders/${tender.id}?tab=documents`);
  await page.locator('input[type="file"]').setInputFiles(pdfFile('200-pages-again.pdf', await textPdf(200, 'Long')));
  await expect(toastWith(page, /150/)).toBeVisible();
  await shot(page, 'sc8b-200-pages-truncated-warning');
  t.save();
});
