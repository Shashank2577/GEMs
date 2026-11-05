/**
 * 008 / US7 — Costs, query time and stored data stay proportional as usage grows (story #362, T113 #470).
 *
 * One test per acceptance scenario of specs/008-operations-scale/spec.md US7 (scenarios 1–8); scenario 3 also runs at
 * 375 px (@mobile). Evidence goes to qa/evidence/008/US7/: a full-page PNG per criterion, one .webm per test, and a
 * .txt transcript for every API/DB/benchmark check. Scenarios whose subject is not a UI (benchmarks, housekeeping on a
 * fixed clock, Resend call counts) run the story's own API/core tests from here and render their output on a page, so
 * the screenshot and video show the actual run.
 *
 * Server environment this spec needs (set by the runner, not by product code):
 *   ANTHROPIC_API_KEY=qa-fake LLM_BASE_URL=http://127.0.0.1:${E2E_LLM_PORT:-4119}   (this file serves a counting fake Anthropic API)
 * Also used: E2E_DATABASE_URL (psql for state the API cannot create: a stale extractor version, search fixtures),
 * QA_TEST_DATABASE_URL (API vitest runs) and QA_500K_DATABASE_URL (scenario 3 at 500,000 tenders; skipped if unset).
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, uniqueUser, evidence, atPhone, noHorizontalOverflow } from '../support/fixtures';
import { openTargetTender } from '../004-analyse/support';

const SPEC = '008';
const STORY = 'US7';
const DIR = join('qa', 'evidence', SPEC, STORY);
const DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
const TEST_DB = process.env.QA_TEST_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_test';
const DB_500K = process.env.QA_500K_DATABASE_URL || '';
const LLM_PORT = Number(process.env.E2E_LLM_PORT || 4119);
const PROJECT = () => test.info().project.name;
const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${PROJECT()}`);

// One .webm per test (same contract as fixtures.collectRunArtifacts), waiting for the recorder (`video.saveAs`).
test.afterEach(async ({ page }) => {
  const info = test.info();
  if (info.status === 'skipped') return;
  mkdirSync(DIR, { recursive: true });
  const slug = info.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
  const video = page.video();
  await page.close();
  if (video) await video.saveAs(join(DIR, `${slug}-${info.project.name}.webm`)).catch(() => undefined);
});

// ───────────── helpers ─────────────

function psql(sql: string, url = DB): string {
  return execFileSync('psql', [url, '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Run a package's vitest from the repo root; returns the cleaned output (throws on a failing run). */
function vitest(pkg: '@tp/api' | '@tp/core', args: string[], env: Record<string, string> = {}): string {
  const out = execFileSync('pnpm', ['--filter', pkg, 'exec', 'vitest', 'run', '--reporter=verbose', ...args], {
    encoding: 'utf8', env: { ...process.env, ...env, FORCE_COLOR: '0' }, timeout: 300_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return stripAnsi(out);
}

class Transcript {
  private lines: string[] = [];
  constructor(private name: string) { this.add(`# ${name} — project ${PROJECT()} — ${new Date().toISOString()}`); }
  add(line = '') { this.lines.push(line); }
  async http(label: string, res: Awaited<ReturnType<APIRequestContext['get']>>, reqNote: string, max = 700) {
    this.add(`### ${label}`);
    this.add(`> ${reqNote}`);
    this.add(`< ${res.status()}`);
    this.add((await res.text()).slice(0, max));
    this.add();
  }
  text() { return this.lines.join('\n') + '\n'; }
  save() {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${this.name}-${PROJECT()}.txt`), this.text());
  }
}

/** Show a transcript on the page (for the screenshot and the video of a non-UI criterion). */
async function showTranscript(page: Page, title: string, body: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>body{font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;margin:24px;background:#fff;color:#0f172a}
    h1{font:600 18px system-ui,sans-serif;margin:0 0 12px}pre{white-space:pre-wrap;word-break:break-word;border:1px solid #e2e8f0;border-radius:8px;padding:16px;background:#f8fafc}
    mark{background:#dcfce7}</style></head><body><h1>${esc(title)}</h1><pre>${esc(body)}</pre></body></html>`);
  await page.waitForTimeout(400); // let the recorder capture the frame
}

/** Keep only the interesting lines of a vitest run (results, stdout JSON lines, totals). */
function vitestSummary(out: string, keep: RegExp = /✓|✗|×|Test Files|Tests |\{"|FAIL|passed|failed/): string {
  return out.split('\n').filter((l) => keep.test(l)).map((l) => l.replace(/\s+$/, '')).join('\n');
}

async function newOrg(page: Page, prefix: string) {
  const user = uniqueUser(prefix);
  const res = await page.request.post('/api/auth/signup', { data: user });
  expect(res.status(), await res.text()).toBe(201);
  const me = await (await page.request.get('/api/auth/me')).json();
  return { user, orgId: me.org.id as string };
}

// ───────────── fake Anthropic API (scenarios 1, 2) ─────────────
const LLM_LABEL = 'QA cached licence: extracted once for every org';
const llmCalls: { at: number; promptChars: number }[] = [];
let llmServer: Server | undefined;
async function startFakeLlm() {
  if (llmServer) return;
  llmServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      llmCalls.push({ at: Date.now(), promptChars: body.length });
      const requirements = [{ key: 'certificate', label: LLM_LABEL, value: 'QA cached licence', page: 1, quote: 'QA cached licence', confidence: 0.8 }];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'msg_qa', type: 'message', role: 'assistant', model: 'qa-fake', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ requirements }) }], usage: { input_tokens: 1200, output_tokens: 90 },
      }));
    });
  });
  await new Promise<void>((ok, bad) => { llmServer!.once('error', bad); llmServer!.listen(LLM_PORT, '127.0.0.1', () => ok()); });
}
test.beforeAll(async () => { await startFakeLlm(); });
test.afterAll(async () => { await new Promise<void>((ok) => (llmServer ? llmServer.close(() => ok()) : ok())); llmServer = undefined; });

type Req = { method: string; label: string; source?: { documentId?: string; page?: number } };
const llmReqs = (body: { requirements: Req[] }) => body.requirements.filter((r) => r.method === 'LLM');

/** Tender shared by scenarios 1 and 2 (a GeM tender mock-gem serves a PDF for). */
let shared: { id: string; bidNumber: string } | undefined;

// ═════════════ scenario 1 — one LLM extraction for every org ═════════════

test('sc1 org B analysing a GeM document already extracted for org A makes 0 new LLM calls and shows the same requirements', async ({ page, browser }) => {
  const t = new Transcript('sc1-two-org-cache');
  const A = await newOrg(page, 'cacheA');
  const target = await openTargetTender(page, { tab: 'requirements' });
  shared = { id: target.id, bidNumber: target.bidNumber };
  t.add(`tender ${target.bidNumber} (${target.id}), gemBidId ${target.gemBidId}`);

  const before = llmCalls.length;
  const a = await page.request.post(`/api/tenders/${target.id}/analyse`);
  await t.http('org A analyses', a, `POST /api/tenders/${target.id}/analyse (org A ${A.orgId}, owner)`, 400);
  expect(a.status()).toBe(201);
  const aBody = await a.json();
  const callsA = llmCalls.length - before;
  t.add(`fake LLM calls during org A's analysis: ${callsA}`);
  expect(callsA).toBeGreaterThanOrEqual(1);
  expect(aBody.method).toBe('rules+llm');
  expect(llmReqs(aBody).map((r) => r.label)).toContain(LLM_LABEL);

  const docs = psql(`select id || '|' || coalesce(org_id::text,'null') || '|' || coalesce(extracted_method,'null') || '|' || coalesce(extractor_version,'null') from tender_documents where tender_id='${target.id}'`).split('\n').filter(Boolean);
  t.add('tender_documents (id | org_id | extracted_method | extractor_version):');
  docs.forEach((d) => t.add(`  ${d}`));
  expect(docs.length).toBeGreaterThanOrEqual(1);
  for (const d of docs) {
    const [, org, method] = d.split('|');
    expect(org, 'GeM-fetched document is public (org_id null)').toBe('null');
    expect(method).toBe('LLM');
  }

  // Org B: a separate org in its own browser context.
  const ctxB = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  const pageB = await ctxB.newPage();
  const B = await newOrg(pageB, 'cacheB');
  const beforeB = llmCalls.length;
  const b = await pageB.request.post(`/api/tenders/${target.id}/analyse`);
  await t.http('org B analyses the same tender', b, `POST /api/tenders/${target.id}/analyse (org B ${B.orgId}, owner)`, 400);
  expect(b.status()).toBe(201);
  const bBody = await b.json();
  const callsB = llmCalls.length - beforeB;
  t.add(`fake LLM calls during org B's analysis: ${callsB}`);
  expect(callsB, 'org B makes 0 new LLM extraction calls').toBe(0);
  expect(bBody.method).toBe('rules+llm');
  const strip = (rs: Req[]) => rs.map((r) => ({ label: r.label, documentId: r.source?.documentId, page: r.source?.page }));
  expect(strip(llmReqs(bBody))).toEqual(strip(llmReqs(aBody)));
  t.add(`org A LLM requirements: ${JSON.stringify(strip(llmReqs(aBody)))}`);
  t.add(`org B LLM requirements: ${JSON.stringify(strip(llmReqs(bBody)))}`);
  t.add(`same requirements with provenance (documentId/page): ${JSON.stringify(strip(llmReqs(bBody))) === JSON.stringify(strip(llmReqs(aBody)))}`);
  t.add(`total fake LLM calls for the tender across both orgs: ${callsA + callsB}`);
  t.save();

  await pageB.goto(`/tenders/${target.id}?tab=requirements`);
  await expect(pageB.getByText(LLM_LABEL).first()).toBeVisible();
  await evidence(pageB, SPEC, STORY, `sc1-org-b-requirements-${PROJECT()}`);
  await page.goto(`/tenders/${target.id}?tab=requirements`);
  await expect(page.getByText(LLM_LABEL).first()).toBeVisible();
  await shot(page, 'sc1-org-a-requirements');
  await showTranscript(page, 'US7 scenario 1 — two orgs, one LLM extraction', t.text());
  await shot(page, 'sc1-transcript');
  await ctxB.close();
});

// ═════════════ scenario 2 — a version bump re-extracts once ═════════════

test('sc2 a stale extractor_version re-extracts the document once and updates the cache row', async ({ page }) => {
  test.skip(!shared, 'needs the tender analysed in sc1');
  const t = new Transcript('sc2-version-bump');
  const tid = shared!.id;
  const current = psql(`select distinct extractor_version from tender_documents where tender_id='${tid}'`);
  t.add(`current extractor_version on the cache row(s): ${current}`);
  // The constant cannot change in a running server: making the row's version older is the same state the next analysis
  // sees after CURRENT_EXTRACTOR_VERSION is bumped (row version != current). The API test below bumps the constant itself.
  psql(`update tender_documents set extractor_version = 'qa-older-version', extracted_at = now() - interval '30 days' where tender_id='${tid}'`);
  t.add(`$ update tender_documents set extractor_version='qa-older-version' where tender_id='${tid}'`);

  await newOrg(page, 'cacheC');
  const before = llmCalls.length;
  const r1 = await page.request.post(`/api/tenders/${tid}/analyse`);
  await t.http('org C analyses (stale cache)', r1, `POST /api/tenders/${tid}/analyse`, 300);
  expect(r1.status()).toBe(201);
  const calls1 = llmCalls.length - before;
  const docCount = Number(psql(`select count(*) from tender_documents where tender_id='${tid}'`));
  t.add(`fake LLM calls: ${calls1} (documents on the tender: ${docCount})`);
  expect(calls1, 're-extracted once per document').toBe(docCount);
  const after = psql(`select string_agg(distinct extractor_version || '|' || extracted_method || '|' || (extracted_at > now() - interval '5 minutes')::text, ',') from tender_documents where tender_id='${tid}'`);
  t.add(`cache row after: version|method|fresh = ${after}`);
  expect(after).toBe(`${current}|LLM|true`);

  const before2 = llmCalls.length;
  const r2 = await page.request.post(`/api/tenders/${tid}/analyse`);
  expect(r2.status()).toBe(201);
  t.add(`second analysis after the re-extraction: fake LLM calls ${llmCalls.length - before2} (served from the updated cache)`);
  expect(llmCalls.length - before2).toBe(0);

  const api = vitest('@tp/api', ['test/extraction-cache.test.ts'], { TEST_DATABASE_URL: TEST_DB });
  t.add();
  t.add('$ TEST_DATABASE_URL=… pnpm --filter @tp/api exec vitest run test/extraction-cache.test.ts   # bumps CURRENT_EXTRACTOR_VERSION in-process');
  t.add(vitestSummary(api));
  expect(api).toMatch(/bumping the extractor version re-extracts the document once/);
  expect(api).toMatch(/Tests\s+\d+ passed/);
  t.save();
  await showTranscript(page, 'US7 scenario 2 — version bump re-extracts once', t.text());
  await shot(page, 'sc2-transcript');
});

// ═════════════ scenario 3 — full-text search ═════════════

const SEARCH_ROWS = [
  { bid: 'GEM/2026/B/7731001', title: 'Solar street light 9 m pole with LED luminaire', state: 'Rajasthan' },
  { bid: 'GEM/2026/B/7731002', title: 'IS-2062 structural steel plates, Grade E250', state: 'Odisha' },
  { bid: 'GEM/2026/B/7731003', title: 'Street furniture: benches and bins', state: 'Kerala' },
];
function seedSearchRows() {
  for (const r of SEARCH_ROWS) {
    psql(`insert into tenders (bid_number, title, state, end_at, status, source, source_url, content_hash, ministry)
      values ('${r.bid}', '${r.title}', '${r.state}', now() + interval '20 days', 'open', 'gem', 'https://bidplus.gem.gov.in/all-bids#${r.bid}', 'qa-us7-${r.bid}', 'Ministry of New and Renewable Energy')
      on conflict do nothing`);
  }
}

async function search(page: Page, q: string) {
  const box = page.getByRole('textbox', { name: 'Search tenders' });
  await box.fill(q);
  await page.waitForTimeout(600); // debounce
}

test('sc3 feed search finds "solar street light", "IS 2062" → IS-2062 and bid-number prefixes; 500k p95 and EXPLAIN evidence', async ({ page }) => {
  const t = new Transcript('sc3-search');
  seedSearchRows();
  await newOrg(page, 'search');
  for (const [q, want, not] of [
    ['solar street light', [SEARCH_ROWS[0]!.bid], [SEARCH_ROWS[2]!.bid]],
    ['IS 2062', [SEARCH_ROWS[1]!.bid], []],
    ['GEM/2026/B/77310', [SEARCH_ROWS[0]!.bid, SEARCH_ROWS[1]!.bid, SEARCH_ROWS[2]!.bid], []],
  ] as [string, string[], string[]][]) {
    const res = await page.request.get('/api/tenders', { params: { q, pageSize: 50 } });
    const body = await res.json();
    const bids = (body.items as { bidNumber: string }[]).map((i) => i.bidNumber);
    t.add(`GET /api/tenders?q=${q} → ${res.status()}, total ${body.total}: ${bids.join(', ')}`);
    expect(res.status()).toBe(200);
    for (const w of want) expect(bids, q).toContain(w);
    for (const n of not) expect(bids, q).not.toContain(n);
  }

  await page.goto('/tenders');
  await search(page, 'solar street light');
  await expect(page.getByText(SEARCH_ROWS[0]!.title).first()).toBeVisible();
  await expect(page.getByText(SEARCH_ROWS[2]!.title)).toHaveCount(0);
  await shot(page, 'sc3-search-solar-street-light');
  await search(page, 'IS 2062');
  await expect(page.getByText(SEARCH_ROWS[1]!.title).first()).toBeVisible();
  await shot(page, 'sc3-search-is-2062');
  await search(page, 'GEM/2026/B/77310');
  for (const r of SEARCH_ROWS) await expect(page.getByText(r.title).first()).toBeVisible();
  await shot(page, 'sc3-search-bid-prefix');

  // 500,000 tenders: 200 × GET /api/tenders?q=solar street light, p95 and EXPLAIN (opt-in perf test of the story).
  if (DB_500K) {
    t.add();
    t.add(`$ select count(*) from tenders  (500k DB) → ${psql('select count(*) from tenders', DB_500K)}`);
    t.add('$ PERF=1 TEST_DATABASE_URL=…/tenderpilot_test_us7_500k pnpm --filter @tp/api exec vitest run -c vitest.perf.config.ts test/perf/search.perf.ts');
    const perf = vitest('@tp/api', ['-c', 'vitest.perf.config.ts', 'test/perf/search.perf.ts'], { PERF: '1', TEST_DATABASE_URL: DB_500K });
    t.add(vitestSummary(perf));
    const m = perf.match(/"p95_ms":([\d.]+)/);
    expect(m, 'p95 reported').not.toBeNull();
    expect(Number(m![1])).toBeLessThan(300);
    expect(perf).toMatch(/"indexes":\[[^\]]*"tenders_search_gin"/);
    expect(perf).toMatch(/"query":"status=all&q=GEM\/2026\/B\/12","total":\d+,"indexes":\["tenders_bid_number_prefix_idx"/);
    expect(perf).toMatch(/Tests\s+4 passed/);
    t.add();
    t.add('$ EXPLAIN (ANALYZE) feed page query, q=solar street light (500k DB):');
    const plan = psql(`explain (analyze, costs off) select id from tenders where status = 'open' and (search @@ regexp_replace(websearch_to_tsquery('simple', 'solar street light')::text, '''(?=\\s|\\)|$)', ''':*', 'g')::tsquery) order by created_at desc limit 20`, DB_500K);
    t.add(plan);
    expect(plan).toContain('tenders_search_gin');
  } else {
    t.add('QA_500K_DATABASE_URL not set: 500k measurement not run in this pass');
  }
  t.save();
  await showTranscript(page, 'US7 scenario 3 — search results, 500k p95 and EXPLAIN', t.text());
  await shot(page, 'sc3-transcript');
});

test('sc3 feed search at 375 px: "solar street light" and a bid-number prefix, no horizontal scroll @mobile', async ({ page }) => {
  seedSearchRows();
  await atPhone(page);
  await newOrg(page, 'searchm');
  await page.goto('/tenders');
  await search(page, 'solar street light');
  await expect(page.getByText(SEARCH_ROWS[0]!.title).first()).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, 'sc3-search-solar-street-light-375');
  await search(page, 'GEM/2026/B/7731002');
  await expect(page.getByText(SEARCH_ROWS[1]!.title).first()).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, 'sc3-search-bid-prefix-375');
});

// ═════════════ scenario 4 — matching benchmark + batched inserts ═════════════

test('sc4 1,000 watchlists × 500 tenders match in < 5 s; inserts ≤ 500 rows per statement', async ({ page }) => {
  test.setTimeout(240_000);
  const t = new Transcript('sc4-matching-benchmark');
  t.add('$ pnpm --filter @tp/core exec vitest run test/match/matcher.test.ts -t "benchmark"');
  const core = vitest('@tp/core', ['test/match/matcher.test.ts', '-t', 'benchmark']);
  t.add(vitestSummary(core, /benchmark|\{"|Tests |ms/));
  expect(core).toMatch(/1,000 watchlists × 500 tenders, compiled once per run, finish in < 5 s/);
  expect(core).toMatch(/Tests\s+1 passed/);
  t.add();
  t.add('$ TEST_DATABASE_URL=… pnpm --filter @tp/api exec vitest run test/match-batch.test.ts');
  const api = vitest('@tp/api', ['test/match-batch.test.ts'], { TEST_DATABASE_URL: TEST_DB });
  t.add(vitestSummary(api));
  expect(api).toMatch(/1,000 watchlists × 500 tenders: < 5 s, 10,000 matches, every INSERT carries ≤ 500 rows/);
  expect(api).toMatch(/splits 1,201 rows into 500 \+ 500 \+ 201/);
  expect(api).not.toMatch(/^\s+× |FAIL/m);
  t.save();
  await showTranscript(page, 'US7 scenario 4 — matching benchmark and batched inserts', t.text());
  await shot(page, 'sc4-transcript');
});

// ═════════════ scenario 5 — housekeeping on a fixed clock ═════════════

test('sc5 fixed-clock housekeeping deletes exactly the expired rows and R2 objects; a second run deletes 0', async ({ page }) => {
  test.setTimeout(180_000);
  const t = new Transcript('sc5-housekeeping');
  t.add('$ TEST_DATABASE_URL=… pnpm --filter @tp/api exec vitest run test/housekeeping.test.ts');
  const out = vitest('@tp/api', ['test/housekeeping.test.ts'], { TEST_DATABASE_URL: TEST_DB });
  t.add(vitestSummary(out, /✓|×|Test Files|Tests |"job":"housekeeping"|housekeeping finished|deleted/));
  expect(out).toMatch(/the scheduled step deletes exactly the expired rows and R2 objects and logs the JSON summary/);
  expect(out).toMatch(/runs once per IST day: a later tick the same day skips; a forced second run deletes 0/);
  expect(out).toMatch(/Tests\s+\d+ passed/);
  expect(out).not.toMatch(/^\s+× |FAIL/m);
  t.add();
  t.add('The test pins (housekeeping.test.ts): sessions expired > 7 d, read/sent/skipped notifications > 180 d, tender_events > 365 d of closed');
  t.add('tenders, tenders.raw nulled > 90 d after close, packets beyond the newest 5 per workspace (row + blob), rate_limits; exact counts per table');
  t.add('and the remaining rows are asserted, the summary log line {job:"housekeeping", deleted:{…}} is checked, and a second run returns 0 for every table.');
  t.save();
  await showTranscript(page, 'US7 scenario 5 — housekeeping on a fixed clock', t.text());
  await shot(page, 'sc5-transcript');
});

// ═════════════ scenario 6 — Resend batch ═════════════

test('sc6 120 queued emails → exactly 2 Resend /emails/batch calls', async ({ page }) => {
  test.setTimeout(180_000);
  const t = new Transcript('sc6-email-batch');
  t.add('$ TEST_DATABASE_URL=… pnpm --filter @tp/api exec vitest run test/email-batch.test.ts');
  const out = vitest('@tp/api', ['test/email-batch.test.ts'], { TEST_DATABASE_URL: TEST_DB });
  t.add(vitestSummary(out));
  expect(out).toMatch(/120 queued emails → exactly 2 calls to \/emails\/batch \(100 \+ 20\); every row sent/);
  expect(out).toMatch(/Tests\s+\d+ passed/);
  expect(out).not.toMatch(/^\s+× |FAIL/m);
  // The assertion inside that test, quoted from the source so the transcript shows what "exactly 2" means.
  const src = readFileSync('apps/api/test/email-batch.test.ts', 'utf8');
  const block = src.slice(src.indexOf("it('120 queued emails"), src.indexOf("it('a failed batch call"));
  t.add();
  t.add('--- apps/api/test/email-batch.test.ts (the 120-email test) ---');
  t.add(block.trim());
  expect(block).toContain("expect(calls.map((c) => c.url)).toEqual(['https://api.resend.com/emails/batch', 'https://api.resend.com/emails/batch']);");
  expect(block).toContain('toEqual([100, 20])');
  t.save();
  await showTranscript(page, 'US7 scenario 6 — 120 emails, 2 batch calls', t.text());
  await shot(page, 'sc6-transcript');
});

// ═════════════ scenario 7 — Hyperdrive (code part; staging load is T111) ═════════════

test('sc7 single pg driver: @neondatabase/serverless and createNeonDb are gone; Hyperdrive staging load is not verifiable here', async ({ page }) => {
  const t = new Transcript('sc7-hyperdrive');
  const pkgs = ['package.json', 'packages/db/package.json', 'apps/api/package.json'];
  for (const p of pkgs) {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const deps = { ...j.dependencies, ...j.devDependencies };
    t.add(`${p}: @neondatabase/serverless ${deps['@neondatabase/serverless'] ? 'PRESENT' : 'absent'}; pg ${deps.pg ?? '-'}`);
    expect(deps['@neondatabase/serverless']).toBeUndefined();
  }
  const grep = (() => {
    try { return execFileSync('git', ['grep', '-n', '-e', 'createNeonDb', '-e', '@neondatabase/serverless', '--', 'apps', 'packages'], { encoding: 'utf8' }); } catch { return ''; }
  })();
  t.add(`$ git grep -n -e createNeonDb -e @neondatabase/serverless -- apps packages → ${grep.trim() ? grep : '(no matches)'}`);
  expect(grep.trim()).toBe('');
  // pnpm-lock.yaml: no workspace importer declares it; it only appears as drizzle-orm's optional peer, which pnpm
  // auto-installs (autoInstallPeers: true). It is never imported, so it is not in the Worker bundle (checked below).
  const lock = readFileSync('pnpm-lock.yaml', 'utf8');
  const importers = lock.slice(lock.indexOf('\nimporters:'), lock.indexOf('\npackages:'));
  const directDecl = /^ {6}'@neondatabase\/serverless':/m.test(importers);
  t.add(`pnpm-lock.yaml importers declaring @neondatabase/serverless directly: ${directDecl ? 'YES' : 'none'}; autoInstallPeers: ${/autoInstallPeers: true/.test(lock)}`);
  expect(directDecl).toBe(false);
  const bundleDir = process.env.QA_WRANGLER_OUT || '';
  if (bundleDir && existsSync(bundleDir)) {
    const bundle = execFileSync('bash', ['-c', `cat ${JSON.stringify(bundleDir)}/*.js | grep -c -e '@neondatabase/serverless' -e 'drizzle-orm/neon' -e 'neonConfig' -e 'node_modules/@neondatabase' || true`], { encoding: 'utf8' }).trim();
    t.add(`wrangler deploy --dry-run bundle (${bundleDir}): occurrences of @neondatabase/serverless, drizzle-orm/neon*, neonConfig, node_modules/@neondatabase = ${bundle}`);
    expect(bundle).toBe('0');
  }
  const worker = readFileSync('apps/api/src/worker.ts', 'utf8');
  t.add(`apps/api/src/worker.ts uses createNodeDb with HYPERDRIVE: ${/HYPERDRIVE/.test(worker) && /createNodeDb/.test(worker)}`);
  expect(worker).toMatch(/createNodeDb/);
  const toml = readFileSync('wrangler.toml', 'utf8');
  const hd = toml.split('\n').filter((l) => /hyperdrive/i.test(l));
  t.add('wrangler.toml hyperdrive lines:');
  hd.forEach((l) => t.add(`  ${l}`));
  t.add();
  t.add('UNVERIFIABLE here: "50 concurrent feed requests on staging → 0 connection errors" needs a real Hyperdrive config id and the');
  t.add('staging Worker (operator task T111 #468, runbook § Hyperdrive "Enable Hyperdrive"). The [[hyperdrive]] binding ships commented out.');
  test.info().annotations.push({ type: 'unverifiable', description: 'Scenario 7 staging load (T111 #468) needs real Hyperdrive + staging' });
  t.save();
  await showTranscript(page, 'US7 scenario 7 — single pg driver (staging load: T111)', t.text());
  await shot(page, 'sc7-transcript');
});

// ═════════════ scenario 8 — LATER triggers ═════════════

test('sc8 every LATER item states its trigger in the runbook and links to its ADR section', async ({ page }) => {
  const t = new Transcript('sc8-later-triggers');
  const runbook = readFileSync('docs/runbook.md', 'utf8');
  const start = runbook.indexOf('## LATER triggers');
  expect(start).toBeGreaterThan(-1);
  const section = runbook.slice(start, runbook.indexOf('\n## ', start + 5) > 0 ? runbook.indexOf('\n## ', start + 5) : undefined);
  t.add(section.trim());
  t.add();
  const items: [string, RegExp][] = [
    ['Queues', /Cloudflare Queues/], ['RLS', /row-level security/i], ['Razorpay', /Razorpay/], ['Analytics Engine', /Analytics Engine/], ['weekly pg_dump', /pg_dump/],
  ];
  /** How each ADR names the item (ADR-0004 says "RLS"). */
  const inAdr: Record<string, RegExp> = { Queues: /Queues/, RLS: /\bRLS\b|row-level security/i, Razorpay: /Razorpay/, 'Analytics Engine': /Analytics Engine/, 'weekly pg_dump': /pg_dump/ };
  const rows = section.split('\n').filter((l) => l.startsWith('| ') && !/^\| (Item|---)/.test(l));
  for (const [name, re] of items) {
    const row = rows.find((r) => re.test(r));
    expect(row, `${name} row`).toBeTruthy();
    const cells = row!.split('|').map((c) => c.trim());
    const trigger = cells[2] ?? '';
    const link = /\]\(([^)#]+)(#[^)]*)?\)/.exec(cells[3] ?? '');
    expect(trigger.length, `${name} trigger`).toBeGreaterThan(10);
    expect(link, `${name} ADR link`).not.toBeNull();
    const file = join('docs', link![1]!);
    const exists = existsSync(file);
    t.add(`${name}: trigger "${trigger.slice(0, 90)}${trigger.length > 90 ? '…' : ''}" → ${link![1]}${link![2] ?? ''} (file exists: ${exists})`);
    expect(exists, file).toBe(true);
    const adr = readFileSync(file, 'utf8');
    expect(adr, `${file} mentions ${name}`).toMatch(inAdr[name]!);
  }
  const readme = readFileSync('docs/adr/README.md', 'utf8');
  t.add(`docs/adr/README.md lists LATER priorities: ${(readme.match(/LATER/g) ?? []).length} mentions`);
  expect(readme).toMatch(/LATER/);
  t.save();
  await showTranscript(page, 'US7 scenario 8 — LATER triggers in the runbook', t.text());
  await shot(page, 'sc8-transcript');
});
