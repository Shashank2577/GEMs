/**
 * QA acceptance for spec 004 / US7 (#174, PR #560): AI enrichment and OCR for scanned documents (FR-047..FR-054, T094).
 * One test per acceptance criterion of the issue (numbering = the issue's criteria) plus extra rows for behaviour added in
 * review (manual OCR quota, partial OCR replies, roles, ?force=1). Screenshots/videos land in qa/evidence/004/US7/
 * (the dev-*.png files there are the developer's and stay).
 *
 * Server environment (set by the runner, not by product code), see playwright.config.ts / e2e/support/start-api.sh:
 *   keyed run : ANTHROPIC_API_KEY=qa-fake LLM_BASE_URL=http://127.0.0.1:${E2E_LLM_PORT:-4119} PACKET_MAX_INPUT_BYTES=41943040
 *   no-key run: the same API but with ANTHROPIC_API_KEY unset (criteria 4 and 8). The config cannot switch the key per test,
 *               so the file runs twice; each test reads GET /api/analysis/capabilities and skips itself when the server is
 *               the other kind.
 *   E2E_API_LOG (optional): the file the API's stdout goes to, so log lines (criteria 3 and 9) can be asserted.
 * This file serves a recording fake Anthropic API (llm-stub.ts) on E2E_LLM_PORT. Rules-only baselines come from an org whose
 * monthly AI slots are used up (SQL-seeded llm_usage), which the API answers with method 'rules' and no LLM call.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { APIRequestContext, Page, Playwright } from '@playwright/test';
import type { AnalysisDto, TenderDocumentDto } from '../../packages/core/src/contracts/analyse';
import { GEM_URL, checkA11y, inviteAs } from '../support/fixtures';
import { SPEC, analyse, collectRunArtifacts, evidence, expect, mockGem, signupViaApi, test, uniqueUser, uploadFixtureViaApi } from './support';
import { ESI_ITEM, startLlmStub, type LlmCall, type LlmStub, type StubItem } from './llm-stub';

const STORY = 'US7';
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
const API_LOG = process.env.E2E_API_LOG;

let stub: LlmStub;
test.beforeAll(async () => { stub = await startLlmStub(); });
test.afterAll(async () => { await stub.close(); });
test.beforeEach(() => { stub.reset(); });
test.afterEach(async ({ page }) => {
  if (test.info().status === 'skipped') return; // the other server kind's tests: never overwrite their artifacts
  // The scanned GeM copy is shared by every org: take it off the tender again so later specs can analyse it.
  for (const id of scannedTenders) { try { psql(`delete from tender_documents where tender_id = '${id}' and org_id is null`); } catch { /* still referenced */ } }
  scannedTenders.clear();
  await page.context().request.post(`${GEM_URL}/__admin/document-mode`, { data: { mode: 'normal' } }).catch(() => undefined);
  await collectRunArtifacts(SPEC, STORY, page);
});

// ───────────── helpers ─────────────
const psql = (sql: string) => execFileSync('psql', [E2E_DB, '-tAqc', sql], { encoding: 'utf8' }).trim().split('\n')[0] ?? '';
const toast = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
const pdfLib = () => createRequire(join(process.cwd(), 'packages/core/package.json'))('pdf-lib') as typeof import('pdf-lib');

interface Capabilities { ai: boolean; ocr: boolean; models: { enrichment?: string; ocr?: string; escalation?: string } }
async function capabilities(r: APIRequestContext): Promise<Capabilities> {
  const res = await r.get('/api/analysis/capabilities');
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
/** Signed-up page of a server that has an AI key (skips the test on the no-key server). */
async function keyedOrg(page: Page) {
  const user = await signupViaApi(page);
  const caps = await capabilities(page.request);
  test.skip(!caps.ai, 'needs the API started with ANTHROPIC_API_KEY (keyed run)');
  return { user, caps };
}
async function keylessOrg(page: Page) {
  const user = await signupViaApi(page);
  const caps = await capabilities(page.request);
  test.skip(caps.ai, 'needs the API started WITHOUT ANTHROPIC_API_KEY (no-key run)');
  return { user, caps };
}

// A fresh open GeM-linked tender (no GeM document stored yet, not used by another test of this run).
const usedTenders = new Set<string>();
async function freshGemTender(r: APIRequestContext): Promise<{ id: string; bidNumber: string }> {
  const minEnd = Date.now() + 3 * 86_400_000;
  const list = async () => {
    const state = (await (await r.get(`${GEM_URL}/__admin/state`)).json()) as { bids: { id: string | number }[] };
    const known = new Set(state.bids.map((b) => String(b.id)));
    const res = await r.get('/api/tenders', { params: { status: 'open', sort: 'endAt', pageSize: 100 } });
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()) as { items: { id: string; bidNumber: string; source: string; gemBidId: string | null; endAt: string | null }[] }).items
      .filter((t) => t.source === 'gem' && !!t.gemBidId && known.has(String(t.gemBidId)) && !!t.endAt && Date.parse(t.endAt) >= minEnd && !usedTenders.has(t.id));
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const t of (await list()).reverse()) { // latest-closing first: keep clear of the tenders other specs pick (earliest)
      const docs = (await (await r.get(`/api/tenders/${t.id}/documents`)).json()) as { items: { source: string }[] };
      if (docs.items.some((d) => d.source === 'gem')) continue;
      usedTenders.add(t.id);
      return { id: t.id, bidNumber: t.bidNumber };
    }
    await mockGem(r, '/__admin/publish', { count: 6 });
    const run = await r.post('/api/ingestion/run', { data: { pages: 5 } });
    expect([200, 409], await run.text()).toContain(run.status());
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error('no fresh GeM tender available');
}

/** mock-gem serves a scanned PDF for this fetch only; the tender then holds a (shared) GeM document with no text layer. */
const scannedTenders = new Set<string>();
async function fetchScannedGemDoc(r: APIRequestContext, tenderId: string): Promise<TenderDocumentDto> {
  await mockGem(r, '/__admin/document-mode', { mode: 'scanned' });
  scannedTenders.add(tenderId);
  try {
    const res = await r.post(`/api/tenders/${tenderId}/fetch-documents`);
    expect(res.status(), await res.text()).toBe(201);
    const { items } = (await res.json()) as { items: TenderDocumentDto[] };
    expect(items).toHaveLength(1);
    return items[0]!;
  } finally {
    await mockGem(r, '/__admin/document-mode', { mode: 'normal' });
  }
}

const getAnalysis = async (r: APIRequestContext, tenderId: string): Promise<AnalysisDto> => {
  const res = await r.get(`/api/tenders/${tenderId}/analysis`);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};
const listDocs = async (r: APIRequestContext, tenderId: string): Promise<TenderDocumentDto[]> => ((await (await r.get(`/api/tenders/${tenderId}/documents`)).json()) as { items: TenderDocumentDto[] }).items;
const myOrgId = async (r: APIRequestContext) => ((await (await r.get('/api/auth/me')).json()) as { org: { id: string } }).org.id;

/** Use up an org's monthly AI slots (trial = 10) the way earlier AI analyses would: distinct analysis_ref rows. */
function useUpAiSlots(orgId: string, slots = 10) {
  for (let i = 0; i < slots; i++) {
    psql(`insert into llm_usage (org_id, analysis_ref, kind, model, input_tokens, output_tokens) values ('${orgId}', gen_random_uuid(), 'extract', 'qa-seed', 1, 1)`);
  }
}

/** A requirement as the contract compares them (ids/timestamps left out). */
const shape = (a: AnalysisDto) => a.requirements.map((r) => ({ key: r.key, label: r.label, value: r.value, numeric: r.numeric, method: r.method, confidence: r.confidence, page: r.source.page ?? null }));

async function newApiOrg(playwright: Playwright, baseURL: string | undefined) {
  const api = await playwright.request.newContext({ baseURL });
  const res = await api.post('/api/auth/signup', { data: uniqueUser('us7b') });
  expect(res.status(), await res.text()).toBe(201);
  return api;
}

// ───────────── API log capture (criteria 3 and 9) ─────────────
interface LogLine { ts?: string; level: string; msg: string; [k: string]: unknown }
const logMark = () => { try { return API_LOG ? statSync(API_LOG).size : 0; } catch { return 0; } };
function logSince(mark: number): LogLine[] {
  if (!API_LOG) return [];
  try {
    const size = statSync(API_LOG).size;
    const buf = Buffer.alloc(Math.max(0, size - mark));
    const fd = openSync(API_LOG, 'r');
    try { readSync(fd, buf, 0, buf.length, mark); } finally { closeSync(fd); }
    return buf.toString('utf8').split('\n').filter((l) => l.startsWith('{')).flatMap((l) => { try { return [JSON.parse(l) as LogLine]; } catch { return []; } });
  } catch { return []; }
}
async function waitForLog(mark: number, pred: (l: LogLine) => boolean, what: string) {
  let found: LogLine[] = [];
  await expect.poll(() => { found = logSince(mark).filter(pred); return found.length; }, { message: `API log: ${what}`, timeout: 10_000 }).toBeGreaterThan(0);
  return found;
}
/** Render API log lines on a page so the screenshot (and the video) show them. */
async function showLog(page: Page, title: string, lines: LogLine[]) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>body{font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:24px;background:#fff;color:#0f172a}h1{font:600 18px system-ui,sans-serif;margin:0 0 12px}
    pre{white-space:pre-wrap;word-break:break-word;border:1px solid #e2e8f0;border-radius:8px;padding:16px;background:#f8fafc}</style></head>
    <body><h1>${esc(title)}</h1><pre>${esc(lines.map((l) => JSON.stringify(l)).join('\n') || '(no log lines captured)')}</pre></body></html>`);
  await page.waitForTimeout(400);
}
const CALL_BRIEF = (c: LlmCall) => `#${c.n} ${c.kind} model=${c.model} mode=${c.mode} promptChars=${c.promptChars} pageTextChars=${c.pageTextChars} pages=${c.pages.length ? `${c.pages[0]}..${c.pages[c.pages.length - 1]}` : '-'}${c.ocrPages ? ` ocrPages=${c.ocrPages}` : ''} outcome=${c.outcome}${c.heldMs ? ` after=${c.heldMs}ms` : ''}`;
/** Render the calls the stub received (requests the API made) for a screenshot. */
async function showCalls(page: Page, title: string, calls: LlmCall[], extra: string[] = []) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>body{font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:24px;background:#fff;color:#0f172a}h1{font:600 18px system-ui,sans-serif;margin:0 0 12px}
    pre{white-space:pre-wrap;word-break:break-word;border:1px solid #e2e8f0;border-radius:8px;padding:16px;background:#f8fafc}</style></head>
    <body><h1>${esc(title)}</h1><pre>${esc([...calls.map(CALL_BRIEF), ...extra].join('\n') || '(the stub LLM received no requests)')}</pre></body></html>`);
  await page.waitForTimeout(400);
}

/** The bid every enrichment test analyses: uploaded (org-private) on a fresh GeM tender. */
async function orgWithBid(page: Page) {
  const t = await freshGemTender(page.request);
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  return t;
}
const analyseButton = (page: Page) => page.getByRole('button', { name: 'Analyse eligibility' }).first();
const headerText = (page: Page) => page.getByText(/\d+ requirements extracted/);

// ═════════════ 1 ESI registration item: rules+llm, LLM item capped at 0.9, header, toast ═════════════
test('1 fake LLM returns an ESI registration item: rules+llm, item LLM capped 0.9, "N by AI" header, toast "Rules + AI analysis complete" @mobile', async ({ page }) => {
  await keyedOrg(page);
  const t = await orgWithBid(page);
  stub.enrich = 'atc-item';
  await page.goto(`/tenders/${t.id}`);
  const caps = page.waitForResponse((r) => r.url().endsWith('/api/analysis/capabilities'));
  await analyseButton(page).click();
  await expect(toast(page, 'Rules + AI analysis complete')).toBeVisible({ timeout: 30_000 });
  await caps;
  await ev(page, '01a-toast-rules-plus-ai');

  const a = await getAnalysis(page.request, t.id);
  expect(a.method).toBe('rules+llm');
  const esi = a.requirements.filter((r) => r.method === 'LLM');
  expect(esi).toHaveLength(1);
  expect(esi[0]).toMatchObject({ key: 'certificate', label: 'ESI registration', method: 'LLM', confidence: 0.9 });
  expect(esi[0]!.source.page).toBe(4);
  // The model said 0.95; the API capped it.
  expect(ESI_ITEM.confidence).toBe(0.95);
  const enrich = stub.of('enrich');
  expect(enrich).toHaveLength(1);
  expect(enrich[0]).toMatchObject({ model: 'claude-sonnet-5-5', hasSchema: true });

  await page.goto(`/tenders/${t.id}?tab=requirements`);
  const total = a.requirements.length;
  const byRules = a.requirements.filter((r) => r.method === 'RULE').length;
  const header = `${total} requirements extracted · ${byRules} by rules · 1 by AI`;
  await expect(headerText(page)).toHaveText(header);
  test.info().annotations.push({ type: 'actual-header', description: header });
  await page.getByRole('textbox', { name: 'Filter requirements' }).fill('ESI');
  const row = page.locator('tr, li').filter({ hasText: 'ESI registration' }).first();
  await expect(row).toContainText('AI');
  await expect(row).toContainText('90%');
  await ev(page, '01b-requirements-header-esi-row');
});

// ═════════════ 2 rule value kept; new keys added; fuzzy duplicates not added twice ═════════════
test('2 rule value kept over a lower-confidence LLM value; new key added; fuzzy duplicate documents not added twice', async ({ page }) => {
  await keyedOrg(page);
  const t = await orgWithBid(page);
  // Baseline: the model finds nothing, so the result is exactly what the rules extracted.
  stub.enrich = 'empty';
  const base = await analyse(page.request, t.id);
  expect(base.method).toBe('rules+llm');
  const turnover = base.requirements.find((r) => r.key === 'turnover_min')!;
  expect(turnover, 'rules extract turnover_min from go-it-services').toBeTruthy();
  expect(turnover.method).toBe('RULE');
  expect(turnover.confidence).toBeGreaterThanOrEqual(0.95);
  const keys = new Set(base.requirements.map((r) => r.key));
  const newKey = ['past_performance', 'oem_turnover', 'oem_auth', 'similar_work'].find((k) => !keys.has(k));
  expect(newKey, 'a single-valued key the rules did not find').toBeTruthy();
  const multi = base.requirements.find((r) => ['document', 'certificate'].includes(r.key) && typeof r.value === 'string')!;
  expect(multi, 'the rules extracted at least one document/certificate').toBeTruthy();

  const items: StubItem[] = [
    { key: 'turnover_min', label: 'Minimum average annual turnover', value: '99 Lakh', numeric: (turnover.numeric ?? 5_000_000) * 2, mandatory: true, page: 1, quote: 'Minimum Average Annual Turnover of the bidder (For 3 Years) 99 Lakh (s)', confidence: 0.9 },
    { key: newKey!, label: `QA new ${newKey}`, value: 'QA new value', numeric: null, mandatory: true, page: 4, quote: 'Copies of work orders and completion certificates (CRAC) must be uploaded.', confidence: 0.85 },
    { key: multi.key, label: multi.label, value: `${multi.value} (self-attested copy)`, numeric: null, mandatory: true, page: 1, quote: 'duplicate of a rule item', confidence: 0.8 },
    ESI_ITEM,
    { ...ESI_ITEM, label: 'ESI registration certificate', value: 'ESI registration certificate' },
  ];
  stub.enrich = 'items'; stub.items = items;
  const a = await analyse(page.request, t.id);
  expect(a.method).toBe('rules+llm');

  // Rule value kept (same item, still RULE at its confidence) although the LLM sent a different value at 0.9.
  const kept = a.requirements.find((r) => r.key === 'turnover_min')!;
  expect(kept).toMatchObject({ method: 'RULE', value: turnover.value, numeric: turnover.numeric, confidence: turnover.confidence });
  expect(a.requirements.filter((r) => r.key === 'turnover_min')).toHaveLength(1);
  // New key added.
  expect(a.requirements.find((r) => r.key === newKey)).toMatchObject({ method: 'LLM', label: `QA new ${newKey}` });
  // Fuzzy duplicates are not added: the rule's own document, and ESI twice (once plus a longer label).
  expect(a.requirements.filter((r) => r.method === 'LLM' && String(r.value).includes('(self-attested copy)'))).toHaveLength(0);
  expect(a.requirements.filter((r) => /ESI registration/.test(String(r.label)))).toHaveLength(1);
  const llm = a.requirements.filter((r) => r.method === 'LLM');
  expect(llm.map((r) => r.label).sort()).toEqual([`QA new ${newKey}`, 'ESI registration'].sort());
  expect(a.requirements.length).toBe(base.requirements.length + 2);
  test.info().annotations.push({ type: 'merge', description: `baseline ${base.requirements.length} requirements; LLM sent 5 items; result ${a.requirements.length} (+2: ${llm.map((r) => r.label).join(', ')}); turnover_min stayed RULE ${turnover.confidence}` });

  await page.goto(`/tenders/${t.id}?tab=requirements`);
  await expect(headerText(page)).toContainText('by AI');
  await ev(page, '02a-requirements-merged');
  await page.getByRole('textbox', { name: 'Filter requirements' }).fill('turnover');
  await expect(page.locator('tr, li').filter({ hasText: /turnover/i }).first()).toContainText('Rule');
  await ev(page, '02b-turnover-stays-rule');
});

// ═════════════ 3 LLM throw / non-JSON / timeout → rules, identical factors, warning log ═════════════
interface Baseline { tenderId: string; analysis: AnalysisDto }
let rulesBaseline: Baseline | undefined;
/** Rules-only reference: another org, same tender and document, AI slots used up → method 'rules', no LLM call. */
async function baselineRules(playwright: Playwright, baseURL: string | undefined, tenderId?: string): Promise<Baseline> {
  if (rulesBaseline) return rulesBaseline;
  const api = await newApiOrg(playwright, baseURL);
  const id = tenderId!;
  await uploadFixtureViaApi(api, id, 'go-it-services');
  useUpAiSlots(await myOrgId(api));
  const before = stub.calls.length;
  const analysis = await analyse(api, id);
  expect(stub.calls.length, 'no LLM request for an org with no AI slots left').toBe(before);
  expect(analysis.method).toBe('rules');
  expect(analysis.warnings).toEqual([{ code: 'llm_quota_reached' }]);
  rulesBaseline = { tenderId: id, analysis };
  return rulesBaseline;
}
let tender3: { id: string; bidNumber: string } | undefined;

async function failureCase(page: Page, playwright: Playwright, baseURL: string | undefined, mode: 'http-error' | 'non-json', shot: string) {
  await keyedOrg(page);
  tender3 ??= await freshGemTender(page.request);
  const base = await baselineRules(playwright, baseURL, tender3.id);
  await uploadFixtureViaApi(page.request, tender3.id, 'go-it-services');
  stub.enrich = mode;
  const mark = logMark();
  await page.goto(`/tenders/${tender3.id}`);
  await analyseButton(page).click();
  await expect(toast(page, 'Rules-only analysis complete')).toBeVisible({ timeout: 30_000 });
  await ev(page, `${shot}a-rules-only-toast`);
  const a = await getAnalysis(page.request, tender3.id);
  expect(a.method).toBe('rules');
  expect(stub.of('enrich').length, 'the LLM was asked (and failed)').toBeGreaterThanOrEqual(1);
  expect(a.factors).toEqual(base.analysis.factors);
  expect({ score: a.score, verdict: a.verdict }).toEqual({ score: base.analysis.score, verdict: base.analysis.verdict });
  expect(shape(a)).toEqual(shape(base.analysis));
  await expect(page.getByText('Rules only').first()).toBeVisible();
  const lines = API_LOG ? await waitForLog(mark, (l) => l.msg === 'analyse: LLM enrichment failed; using rules only', 'analyse: LLM enrichment failed; using rules only') : [];
  if (API_LOG) expect(lines[0]).toMatchObject({ level: 'warn', msg: 'analyse: LLM enrichment failed; using rules only', tenderId: tender3.id });
  else test.info().annotations.push({ type: 'log', description: 'E2E_API_LOG not set: warning log asserted by apps/api/test/analyse.test.ts only' });
  test.info().annotations.push({ type: 'identical', description: `factors (${a.factors.length}), score ${a.score}, verdict ${a.verdict}, ${a.requirements.length} requirements identical to the rules-only baseline` });
  await showLog(page, `3 (${mode}) — API warning log + identical result: score ${a.score}/${a.verdict}, ${a.factors.length} factors, ${a.requirements.length} requirements = baseline`, lines);
  await ev(page, `${shot}b-warning-log`);
}

test('3a LLM call throws (HTTP 500): method rules, factors identical to rules-only, warning logged', async ({ page, playwright, baseURL }) => {
  await failureCase(page, playwright, baseURL, 'http-error', '03a');
});

test('3b LLM replies with non-JSON: method rules, factors identical to rules-only, warning logged', async ({ page, playwright, baseURL }) => {
  await failureCase(page, playwright, baseURL, 'non-json', '03b');
});

test('3c LLM never answers (timeout): analysis still completes with method rules, identical factors, warning logged', async ({ page, playwright, baseURL }) => {
  test.setTimeout(240_000);
  await keyedOrg(page);
  tender3 ??= await freshGemTender(page.request);
  const base = await baselineRules(playwright, baseURL, tender3.id);
  await uploadFixtureViaApi(page.request, tender3.id, 'go-it-services');
  stub.enrich = 'timeout'; // the stub holds the connection for 100 s; the API must give up first
  const mark = logMark();
  const t0 = Date.now();
  const a = await analyse(page.request, tender3.id);
  const wall = Date.now() - t0;
  expect(a.method).toBe('rules');
  expect(a.factors).toEqual(base.analysis.factors);
  expect({ score: a.score, verdict: a.verdict }).toEqual({ score: base.analysis.score, verdict: base.analysis.verdict });
  const call = stub.of('enrich')[0]!;
  expect(call.outcome, 'the API aborted the held call itself').toBe('aborted-by-client');
  expect(call.heldMs!).toBeLessThan(95_000);
  expect(wall).toBeLessThan(120_000);
  const lines = API_LOG ? await waitForLog(mark, (l) => l.msg === 'analyse: LLM enrichment failed; using rules only', 'timeout warning') : [];
  test.info().annotations.push({ type: 'timeout', description: `API gave up after ${call.heldMs} ms (analysis wall clock ${wall} ms); spec says 90 s` });
  await page.goto(`/tenders/${tender3.id}`);
  await expect(page.getByText('Rules only').first()).toBeVisible();
  await ev(page, '03c-timeout-rules-only');
  await showLog(page, `3c timeout — LLM call aborted by the API after ${call.heldMs} ms; analysis wall ${wall} ms`, lines);
  await ev(page, '03c-timeout-warning-log');
});

// ═════════════ 4 no key: zero LLM requests, "Works without AI keys", rules-only Analysing copy ═════════════
test('4 no API key: zero LLM requests, "Works without AI keys · AI adds ATC extras when enabled", rules-only Analysing copy @mobile', async ({ page }) => {
  const { caps } = await keylessOrg(page);
  expect(caps).toEqual({ ai: false, ocr: false, models: {} });
  const t = await orgWithBid(page);
  await page.route('**/api/tenders/*/analyse', async (route) => { await new Promise((ok) => setTimeout(ok, 4000)); await route.continue(); });
  await page.goto(`/tenders/${t.id}`);
  await expect(page.getByText('Works without AI keys')).toBeVisible();
  await expect(page.getByText('AI adds ATC extras when enabled')).toBeVisible();
  await ev(page, '04a-works-without-ai-keys');
  await analyseButton(page).click();
  await expect(page.getByText('Deterministic rules read the standard GeM fields — no AI key needed.')).toBeVisible();
  await expect(page.getByText(/Deterministic rules first, then AI/)).toHaveCount(0);
  await ev(page, '04b-analysing-rules-only-copy');
  await expect(toast(page, 'Rules-only analysis complete')).toBeVisible({ timeout: 30_000 });
  const a = await getAnalysis(page.request, t.id);
  expect(a.method).toBe('rules');
  await expect(page.getByText('Rules only').first()).toBeVisible();
  await ev(page, '04c-rules-only-result');
  expect(stub.calls, 'zero outbound LLM requests (the API is pointed at this stub via LLM_BASE_URL)').toHaveLength(0);
  await showCalls(page, '4 — requests received by the stub Anthropic API after a full analysis without ANTHROPIC_API_KEY', stub.calls, [`GET /api/analysis/capabilities -> ${JSON.stringify(caps)}`, `LLM requests received: ${stub.calls.length}`]);
  await ev(page, '04d-zero-llm-requests');
});

// ═════════════ 5 "AI-assisted" badge tooltip ═════════════
test('5 AI-assisted badge tooltip says AI never decides the verdict', async ({ page }) => {
  await keyedOrg(page);
  const t = await orgWithBid(page);
  stub.enrich = 'atc-item';
  const a = await analyse(page.request, t.id);
  expect(a.method).toBe('rules+llm');
  await page.goto(`/tenders/${t.id}`);
  const badge = page.getByText('AI-assisted').first();
  await expect(badge).toBeVisible();
  await badge.hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toHaveText('Rules extracted the standard GeM fields; AI added ATC-specific requirements. AI never decides the verdict.');
  await ev(page, '05-ai-assisted-tooltip');
});

// ═════════════ 6 (gap) capabilities → "Deterministic rules first, then AI reads the ATC…" ═════════════
test('6 (gap) AI enabled: GET /analysis/capabilities ai:true and the Analysing copy "Deterministic rules first, then AI reads the ATC…"', async ({ page }) => {
  const { caps } = await keyedOrg(page);
  expect(caps).toEqual({ ai: true, ocr: true, models: { enrichment: 'claude-sonnet-5-5', ocr: 'claude-opus-5-5' } });
  const t = await orgWithBid(page);
  stub.enrich = 'atc-item'; stub.enrichDelayMs = 7000;
  const capsReq = page.waitForResponse((r) => r.url().endsWith('/api/analysis/capabilities'));
  await page.goto(`/tenders/${t.id}`);
  expect(await (await capsReq).json()).toMatchObject({ ai: true });
  await analyseButton(page).click();
  await expect(page.getByText('Deterministic rules first, then AI reads the ATC for anything the rules missed.')).toBeVisible();
  await expect(page.getByText(/no AI key needed/)).toHaveCount(0);
  await ev(page, '06-analysing-ai-copy');
  await expect(toast(page, 'Rules + AI analysis complete')).toBeVisible({ timeout: 30_000 });
});

// ═════════════ 7 (gap) scanned document: Read with AI (OCR) → Text via OCR, confidence ≤ 0.8, tooltip ═════════════
test('7 (gap) scanned GeM document: "Read with AI (OCR)" → "Text via OCR", pageCount unchanged, requirements ≤ 0.8 with OCR tooltip @mobile', async ({ page }) => {
  await keyedOrg(page);
  const t = await freshGemTender(page.request);
  const scanned = await fetchScannedGemDoc(page.request, t.id);
  expect(scanned).toMatchObject({ hasText: false, needsOcr: true, textSource: 'pdf' });
  await page.goto(`/tenders/${t.id}?tab=documents`);
  const row = page.locator('li.rounded-xl').filter({ hasText: scanned.fileName });
  await expect(row).toContainText('No text — scanned?');
  await expect(page.getByTestId('unreadable-notice')).toContainText(`We couldn't read text from ${scanned.fileName}.`);
  const button = row.getByRole('button', { name: /Read with AI \(OCR\)/ });
  await expect(button).toBeVisible();
  await ev(page, '07a-scanned-row-ocr-action');

  await button.click();
  await expect(toast(page, `${scanned.fileName} read with AI`)).toBeVisible({ timeout: 30_000 });
  await expect(toast(page, 'Text via OCR')).toBeVisible();
  await expect(row.getByTestId('ocr-badge')).toHaveText('Text via OCR');
  await expect(row).not.toContainText('No text — scanned?');
  await expect(page.getByTestId('unreadable-notice')).toHaveCount(0);
  await ev(page, '07b-text-via-ocr-badge');

  const after = (await listDocs(page.request, t.id)).find((d) => d.id === scanned.id)!;
  expect(after).toMatchObject({ textSource: 'ocr', hasText: true, needsOcr: false, pageCount: scanned.pageCount, totalPages: scanned.totalPages });
  const ocrCalls = stub.of('ocr');
  expect(ocrCalls).toHaveLength(1);
  expect(ocrCalls[0]).toMatchObject({ model: 'claude-opus-5-5', ocrPages: scanned.pageCount, hasSchema: true });

  stub.enrich = 'empty';
  const a = await analyse(page.request, t.id);
  const fromScan = a.requirements.filter((r) => r.source.documentId === scanned.id);
  expect(fromScan.length).toBeGreaterThan(0);
  for (const r of fromScan) {
    expect(r.source.ocr, `${r.key} is marked as read by OCR`).toBe(true);
    expect(r.confidence, `${r.key} confidence`).toBeLessThanOrEqual(0.8);
  }
  expect(fromScan.some((r) => r.source.page != null)).toBe(true);
  test.info().annotations.push({ type: 'ocr-requirements', description: `${fromScan.length} requirements from the scan; max confidence ${Math.max(...fromScan.map((r) => r.confidence))}; pages ${[...new Set(fromScan.map((r) => r.source.page))].join(',')}` });

  await page.goto(`/tenders/${t.id}?tab=requirements`);
  const marker = page.locator('[data-testid=ocr-requirement]:visible').first();
  await expect(marker).toBeVisible();
  await marker.hover();
  const actualTip = 'Read by AI from a scanned page — check against the original';
  await expect(page.getByRole('tooltip')).toHaveText(actualTip);
  test.info().annotations.push({ type: 'deviation', description: `OCR tooltip reads "${actualTip}"; the criterion says "Read from a scanned page by AI OCR — check against the PDF"` });
  await ev(page, '07c-requirements-ocr-tooltip');
});

test('7b (gap) running an analysis reads a scanned-only tender with the OCR model first (no click needed)', async ({ page }) => {
  await keyedOrg(page);
  const t = await freshGemTender(page.request);
  const scanned = await fetchScannedGemDoc(page.request, t.id);
  stub.enrich = 'empty';
  const a = await analyse(page.request, t.id);
  expect(stub.of('ocr')).toHaveLength(1);
  const after = (await listDocs(page.request, t.id)).find((d) => d.id === scanned.id)!;
  expect(after).toMatchObject({ textSource: 'ocr', hasText: true, pageCount: scanned.pageCount });
  const fromScan = a.requirements.filter((r) => r.source.documentId === scanned.id);
  expect(fromScan.length).toBeGreaterThan(0);
  expect(fromScan.every((r) => r.source.ocr === true && r.confidence <= 0.8)).toBe(true);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await expect(page.getByTestId('ocr-badge')).toHaveText('Text via OCR');
  await ev(page, '07d-analyse-ran-ocr-text-via-ocr');
});

// ═════════════ 8 (gap) no OCR model: notice + POST …/ocr 503 ocr_unavailable ═════════════
test('8 (gap) no OCR model: notice "We couldn\'t read text from <file>. Upload a text PDF or ask your admin to enable AI OCR.", no OCR action, POST …/ocr 503 ocr_unavailable @mobile', async ({ page }) => {
  const { caps } = await keylessOrg(page);
  expect(caps.ocr).toBe(false);
  const t = await freshGemTender(page.request);
  const scanned = await fetchScannedGemDoc(page.request, t.id);
  expect(scanned).toMatchObject({ hasText: false, textSource: 'pdf', needsOcr: true });

  const ocr = await page.request.post(`/api/tenders/${t.id}/documents/${scanned.id}/ocr`);
  expect(ocr.status()).toBe(503);
  const body = (await ocr.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('ocr_unavailable');

  await page.goto(`/tenders/${t.id}?tab=documents`);
  const notice = `We couldn't read text from ${scanned.fileName}. Upload a text PDF or ask your admin to enable AI OCR.`;
  await expect(page.getByTestId('unreadable-notice')).toContainText(notice);
  await expect(page.getByRole('button', { name: /with AI \(OCR\)/ })).toHaveCount(0);
  await ev(page, '08a-documents-notice-no-ocr');
  expect(stub.calls, 'no LLM request without a key').toHaveLength(0);
  await showCalls(page, `8 — POST …/documents/<docId>/ocr -> 503 ocr_unavailable ("${body.error.message}"); LLM requests received: ${stub.calls.length}`, stub.calls, [`capabilities: ${JSON.stringify(caps)}`, `POST /api/tenders/${t.id}/documents/${scanned.id}/ocr -> 503 ${JSON.stringify(body)}`]);
  await ev(page, '08b-ocr-503-no-llm-request');
});

test('8b (gap, spec scenario 8 as amended) no OCR model, scan is the only document: 422 scanned_document, notice with link on the Analysis tab and the Documents tab', async ({ page }) => {
  await keylessOrg(page);
  const t = await freshGemTender(page.request);
  const scanned = await fetchScannedGemDoc(page.request, t.id);
  const notice = `We couldn't read text from ${scanned.fileName}. Upload a text PDF or ask your admin to enable AI OCR.`;
  const api = await page.request.post(`/api/tenders/${t.id}/analyse`);
  expect(api.status()).toBe(422);
  expect(await api.json()).toMatchObject({ error: { code: 'scanned_document', details: { documents: [scanned.fileName] } } });
  await page.goto(`/tenders/${t.id}`);
  await analyseButton(page).click();
  const box = page.getByTestId('scanned-analysis-notice');
  await expect(box).toContainText(notice);
  await expect(box.getByRole('button', { name: 'Open Documents' })).toBeVisible();
  await ev(page, '08c-analysis-tab-scanned-notice');
  await box.getByRole('button', { name: 'Open Documents' }).click();
  await expect(page.getByTestId('unreadable-notice')).toContainText(notice);
  await ev(page, '08d-documents-tab-notice-after-link');
  expect(stub.calls).toHaveLength(0);
});

// ═════════════ 9 (gap) refusal / max_tokens = failure; model + usage logged ═════════════
async function stopReasonCase(page: Page, mode: 'refusal' | 'max-tokens', reason: string, shot: string) {
  test.skip(!API_LOG, 'needs E2E_API_LOG (the API stdout file) to read the log lines');
  await keyedOrg(page);
  const t = await orgWithBid(page);
  stub.enrich = mode;
  const mark = logMark();
  const a = await analyse(page.request, t.id);
  expect(a.method, 'a refusal / truncated reply is an LLM failure -> rules').toBe('rules');
  const fail = await waitForLog(mark, (l) => l.msg === 'analyse: LLM enrichment failed; using rules only', 'enrichment failure warning');
  expect(String(fail[0]!.error)).toContain(`stop_reason: ${reason}`);
  const call = await waitForLog(mark, (l) => l.msg === 'llm: call', 'llm: call line');
  expect(call[0]).toMatchObject({ model: 'claude-sonnet-5-5', stopReason: reason });
  await showLog(page, `9 (${reason}) — API log lines`, logSince(mark).filter((l) => /^(llm: call|analyse: LLM enrichment failed)/.test(l.msg)));
  await ev(page, `${shot}-log-stop-reason`);
  await page.goto(`/tenders/${t.id}`);
  await expect(page.getByText('Rules only').first()).toBeVisible();
  await ev(page, `${shot}-rules-only-result`);
}
test('9a (gap) stop_reason "refusal": treated as LLM failure (rules fallback) and logged with the stop reason', async ({ page }) => { await stopReasonCase(page, 'refusal', 'refusal', '09a'); });
test('9b (gap) stop_reason "max_tokens": treated as LLM failure (rules fallback) and logged with the stop reason', async ({ page }) => { await stopReasonCase(page, 'max-tokens', 'max_tokens', '09b'); });

test('9c (gap) token usage (input/output) and model id are logged for every answered call', async ({ page }) => {
  test.skip(!API_LOG, 'needs E2E_API_LOG (the API stdout file) to read the log lines');
  await keyedOrg(page);
  const t = await orgWithBid(page);
  stub.enrich = 'atc-item'; // the stub reports usage {input_tokens: 1200, output_tokens: 90}
  const mark = logMark();
  await analyse(page.request, t.id);
  const calls = await waitForLog(mark, (l) => l.msg === 'llm: call', 'llm: call line');
  await showLog(page, '9c — "llm: call" log line of one answered enrichment call (stub usage: input 1200, output 90)', calls);
  await ev(page, '09c-llm-call-log-usage');
  expect(calls[0]).toMatchObject({ model: 'claude-sonnet-5-5', stopReason: 'end_turn' });
  expect(calls[0]!.usageIn, 'input tokens logged').toBe(1200);
  expect(calls[0]!.usageOut, 'output tokens logged').toBe(90);
});

// ═════════════ 10 (gap) text > 60,000 chars is chunked (≤ 4 per document), not truncated ═════════════
/** A PDF of `pages` text pages of ≈ 11,000 characters each (unique, rule-neutral words, page/line markers). */
async function longPdf(pages: number): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = pdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const words = ['supplier', 'shall', 'maintain', 'records', 'warehouse', 'consignment', 'packaging', 'inspection', 'schedule', 'annexure', 'paragraph', 'delivery', 'hereby', 'goods', 'notified'];
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([595, 842]);
    for (let l = 0; l < 100; l++) {
      const body = Array.from({ length: 12 }, (_, i) => words[(p * 7 + l * 3 + i * 5) % words.length]).join(' ');
      page.drawText(`PG${String(p).padStart(2, '0')}LN${String(l).padStart(3, '0')} ${body}`, { x: 24, y: 830 - l * 8.1, size: 6.5, font });
    }
  }
  return Buffer.from(await doc.save());
}
const CHUNK_WORDS = ['alpha', 'bravo', 'charlie', 'delta'];
test('10 (gap) a ~150k-character document is sent in page-aligned chunks of ≤ 60,000 characters (not truncated)', async ({ page }) => {
  await keyedOrg(page);
  test.setTimeout(180_000);
  const t = await freshGemTender(page.request);
  const pages = 14;
  const name = 'long-annexure-14p.pdf';
  const up = await page.request.post(`/api/tenders/${t.id}/documents`, { multipart: { kind: 'bid', file: { name, mimeType: 'application/pdf', buffer: await longPdf(pages) } } });
  expect(up.status(), await up.text()).toBe(201);
  const doc = (await up.json()) as TenderDocumentDto;
  expect(doc.pageCount).toBe(pages);
  stub.enrich = 'items';
  // One distinct item per chunk call (labelled by the chunk's first page) to prove the items of every chunk are merged.
  stub.itemsFor = (c) => [{ key: 'certificate', label: `Chunk ${CHUNK_WORDS[c.n - 1]} licence`, value: `Chunk ${CHUNK_WORDS[c.n - 1]} licence`, numeric: null, mandatory: true, page: c.pages[0]!, quote: `PG${String(c.pages[0]).padStart(2, '0')}LN000`, confidence: 0.8 }];
  const a = await analyse(page.request, t.id);
  const calls = stub.of('enrich');
  const covered = calls.flatMap((c) => c.pages);
  const totalChars = calls.reduce((n, c) => n + c.pageTextChars, 0);
  test.info().annotations.push({ type: 'chunks', description: `${calls.length} calls; page text chars per call [${calls.map((c) => c.pageTextChars).join(', ')}]; pages covered ${Math.min(...covered)}..${Math.max(...covered)}` });
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(calls.length).toBeLessThanOrEqual(4);
  for (const c of calls) expect(c.pageTextChars, `chunk #${c.n}`).toBeLessThanOrEqual(60_000);
  expect(totalChars, 'more than one 60,000-character prompt of text was sent in total').toBeGreaterThan(60_000);
  // Nothing truncated: every page of the document reached the model exactly once, in order, with real page numbers.
  expect([...covered].sort((x, y) => x - y)).toEqual(Array.from({ length: pages }, (_, i) => i + 1));
  expect(a.notes.filter((n) => /not read by AI/.test(n))).toEqual([]);
  expect(a.method).toBe('rules+llm');
  const chunkItems = a.requirements.filter((r) => r.method === 'LLM').map((r) => r.label).sort();
  expect(chunkItems, 'items from every chunk are merged').toEqual(calls.map((c) => `Chunk ${CHUNK_WORDS[c.n - 1]} licence`).sort());
  await showCalls(page, `10 — ${name}: ${pages} pages, ${totalChars} characters of page text, sent in ${calls.length} chunk calls`, calls, [`analysis.notes: ${JSON.stringify(a.notes)}`]);
  await ev(page, '10a-chunk-calls');
  await page.goto(`/tenders/${t.id}`);
  await expect(page.getByText('AI-assisted').first()).toBeVisible();
  await ev(page, '10b-analysis-ai-assisted');
});

test('10b (gap) at most 4 chunks per document: pages beyond are reported in the analysis notes, not silently dropped', async ({ page }) => {
  await keyedOrg(page);
  test.setTimeout(180_000);
  const t = await freshGemTender(page.request);
  const pages = 30; // ≈ 330,000 characters: 4 chunks of ≤ 60,000 are read, the rest is reported
  const name = 'very-long-annexure-30p.pdf';
  const up = await page.request.post(`/api/tenders/${t.id}/documents`, { multipart: { kind: 'bid', file: { name, mimeType: 'application/pdf', buffer: await longPdf(pages) } } });
  expect(up.status(), await up.text()).toBe(201);
  stub.enrich = 'empty';
  const a = await analyse(page.request, t.id);
  const calls = stub.of('enrich');
  expect(calls).toHaveLength(4);
  for (const c of calls) expect(c.pageTextChars).toBeLessThanOrEqual(60_000);
  const lastRead = Math.max(...calls.flatMap((c) => c.pages));
  expect(lastRead).toBeLessThan(pages);
  const note = a.notes.find((n) => /not read by AI/.test(n));
  expect(note, `analysis.notes ${JSON.stringify(a.notes)}`).toBe(`Pages ${lastRead + 1}–${pages} of ${name} were not read by AI`);
  await showCalls(page, `10b — ${name}: ${pages} pages; ${calls.length} chunk calls (max 4); pages ${lastRead + 1}–${pages} reported`, calls, [`analysis.notes: ${JSON.stringify(a.notes)}`]);
  await ev(page, '10c-four-chunks-and-note');
});

// ═════════════ 11 (gap) payload never contains profile, financials, past contracts or vault data ═════════════
test('11 (gap) LLM payloads (enrichment and OCR) contain no profile, financials, past-contract or vault data', async ({ page }) => {
  await keyedOrg(page);
  const CANARY = {
    legalName: 'Zyxwq Canary Industries Pvt Ltd', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F', turnover: 31_415_926,
    buyer: 'Zyxwq Ministry of Canaries', contract: 'Zyxwq Canary Helpdesk Contract', contractValue: 27_182_818,
    vaultTitle: 'Zyxwq Vault Canary Certificate', vaultFile: 'zyxwq-vault-canary.pdf', vaultBody: 'ZYXWQ-VAULT-FILE-CONTENT-CANARY',
  };
  const prof = await page.request.put('/api/profile', { data: { legalName: CANARY.legalName, gstin: CANARY.gstin, pan: CANARY.pan, mseCategory: 'small', financials: [{ fy: '2024-25', turnover: CANARY.turnover }, { fy: '2023-24', turnover: CANARY.turnover }, { fy: '2022-23', turnover: CANARY.turnover }] } });
  expect(prof.status(), await prof.text()).toBe(200);
  const pc = await page.request.post('/api/past-contracts', { data: { buyerType: 'central', buyer: CANARY.buyer, title: CANARY.contract, value: CANARY.contractValue } });
  expect(pc.status(), await pc.text()).toBe(201);
  const { PDFDocument, StandardFonts } = pdfLib();
  const vdoc = await PDFDocument.create();
  vdoc.addPage([300, 200]).drawText(CANARY.vaultBody, { x: 20, y: 100, size: 10, font: await vdoc.embedFont(StandardFonts.Helvetica) });
  const vault = await page.request.post('/api/vault', { multipart: { file: { name: CANARY.vaultFile, mimeType: 'application/pdf', buffer: Buffer.from(await vdoc.save()) }, title: CANARY.vaultTitle } });
  expect(vault.status(), await vault.text()).toBe(201);
  // The data really is in the org (so its absence from the payload means something).
  expect(JSON.stringify(await (await page.request.get('/api/profile')).json())).toContain(CANARY.legalName);

  const t = await freshGemTender(page.request);
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  stub.enrich = 'atc-item';
  await analyse(page.request, t.id);
  // And the OCR path on a scanned document of another tender.
  const t2 = await freshGemTender(page.request);
  await fetchScannedGemDoc(page.request, t2.id);
  await analyse(page.request, t2.id);

  const enrich = stub.of('enrich');
  const ocr = stub.of('ocr');
  expect(enrich.length).toBeGreaterThanOrEqual(1);
  expect(ocr.length).toBeGreaterThanOrEqual(1);
  const needles = [CANARY.legalName, CANARY.gstin, CANARY.pan, String(CANARY.turnover), CANARY.buyer, CANARY.contract, String(CANARY.contractValue), CANARY.vaultTitle, CANARY.vaultFile, CANARY.vaultBody, 'Zyxwq'];
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const leaks = stub.calls.flatMap((c) => needles.filter((n) => squash(c.body).includes(squash(n))).map((n) => `${CALL_BRIEF(c)} leaks ${n}`));
  expect(leaks).toEqual([]);
  // Positive control: the enrichment prompt does carry the tender text and the rule-extracted requirements.
  expect(enrich[0]!.body).toContain('Facility Management Services');
  expect(enrich[0]!.body).toContain('Already extracted by deterministic rules');
  expect(enrich[0]!.body).toMatch(/turnover_min/);
  // OCR requests: one PDF document block + the fixed instruction, nothing else.
  const ocrBody = JSON.parse(ocr[0]!.body) as { messages: { content: { type: string }[] }[] };
  expect(ocrBody.messages).toHaveLength(1);
  expect(ocrBody.messages[0]!.content.map((b) => b.type)).toEqual(['document', 'text']);
  await showCalls(page, `11 — ${stub.calls.length} requests captured (${enrich.length} enrichment, ${ocr.length} OCR); canary profile/financials/contract/vault values found: ${leaks.length}`, stub.calls,
    [`canaries searched (case/separator-insensitive): ${needles.join(' | ')}`, `leaks: ${JSON.stringify(leaks)}`, 'control: enrichment body contains "Facility Management Services", "Already extracted by deterministic rules", "turnover_min"']);
  await ev(page, '11-no-company-data-in-llm-requests');
});

// ═════════════ extra rows (behaviour added in review) ═════════════
test('x1 manual OCR takes a monthly AI slot: the run that uses the last slot works, the next OCR is 402 plan_limit_reached', async ({ page }) => {
  await keyedOrg(page);
  const t = await freshGemTender(page.request);
  const orgId = await myOrgId(page.request);
  useUpAiSlots(orgId, 9);
  const blank = async (n: number) => { const d = await pdfLib().PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage([595, 842]); return Buffer.from(await d.save()); };
  const up = async (name: string) => {
    const r = await page.request.post(`/api/tenders/${t.id}/documents`, { multipart: { kind: 'bid', file: { name, mimeType: 'application/pdf', buffer: await blank(2) } } });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()) as TenderDocumentDto;
  };
  const a = await up('scan-a.pdf');
  const b = await up('scan-b.pdf');
  const usage = async () => ((await (await page.request.get('/api/org/usage')).json()) as { usage: { llmAnalysesThisMonth: number } }).usage.llmAnalysesThisMonth;
  expect(await usage()).toBe(9);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  const rowA = page.locator('li.rounded-xl').filter({ hasText: 'scan-a.pdf' });
  await rowA.getByRole('button', { name: /with AI \(OCR\)/ }).click();
  await expect(rowA.getByTestId('ocr-badge')).toHaveText('Text via OCR');
  expect(await usage(), 'the manual OCR took one AI slot').toBe(10);
  const rowB = page.locator('li.rounded-xl').filter({ hasText: 'scan-b.pdf' });
  await rowB.getByRole('button', { name: /with AI \(OCR\)/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Plan limit reached' });
  await expect(dialog).toContainText("Your Free trial includes 10 AI analyses a month. You've used 10.");
  await expect(dialog).toContainText('10 / 10 AI analyses this month');
  await ev(page, 'x1-ocr-402-plan-limit-dialog');
  const again = await page.request.post(`/api/tenders/${t.id}/documents/${b.id}/ocr`);
  expect(again.status()).toBe(402);
  expect(((await again.json()) as { error: { code: string; details: { limit: string; used: number; max: number } } }).error).toMatchObject({ code: 'plan_limit_reached', details: { limit: 'llmAnalysesPerMonth', used: 10, max: 10 } });
  expect(stub.of('ocr'), 'the refused OCR never reached the model').toHaveLength(1);
  expect((await listDocs(page.request, t.id)).find((d) => d.id === b.id)).toMatchObject({ textSource: 'pdf', needsOcr: true });
  void a;
});

test('x2 an OCR reply that leaves out a page → 502 ocr_failed and nothing stored', async ({ page }) => {
  await keyedOrg(page);
  const t = await freshGemTender(page.request);
  const d = await pdfLib().PDFDocument.create(); for (let i = 0; i < 3; i++) d.addPage([595, 842]);
  const up = await page.request.post(`/api/tenders/${t.id}/documents`, { multipart: { kind: 'bid', file: { name: 'scan-partial.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await d.save()) } } });
  expect(up.status(), await up.text()).toBe(201);
  const doc = (await up.json()) as TenderDocumentDto;
  stub.ocr = 'omit-page';
  await page.goto(`/tenders/${t.id}?tab=documents`);
  const row = page.locator('li.rounded-xl').filter({ hasText: 'scan-partial.pdf' });
  await row.getByRole('button', { name: /with AI \(OCR\)/ }).click();
  await expect(toast(page, /OCR|read|failed|page/i)).toBeVisible({ timeout: 30_000 });
  await ev(page, 'x2-partial-ocr-error');
  const api = await page.request.post(`/api/tenders/${t.id}/documents/${doc.id}/ocr`);
  expect(api.status()).toBe(502);
  expect(((await api.json()) as { error: { code: string } }).error.code).toBe('ocr_failed');
  expect((await listDocs(page.request, t.id)).find((x) => x.id === doc.id)).toMatchObject({ textSource: 'pdf', hasText: false, needsOcr: true });
  await expect(row).not.toContainText('Text via OCR');
});

test('x3 …/ocr roles: viewer 403, another org 404, text PDF 409; ?force=1 once OCR text exists needs bid_manager+, never on a GeM copy', async ({ page, playwright, baseURL }) => {
  await keyedOrg(page);
  const t = await freshGemTender(page.request);
  const sc = await pdfLib().PDFDocument.create(); sc.addPage([595, 842]);
  const up = await page.request.post(`/api/tenders/${t.id}/documents`, { multipart: { kind: 'bid', file: { name: 'scan-roles.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await sc.save()) } } });
  const doc = (await up.json()) as TenderDocumentDto;
  const text = await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  const url = (id: string, q = '') => `/api/tenders/${t.id}/documents/${id}/ocr${q}`;
  const code = async (r: Awaited<ReturnType<APIRequestContext['post']>>) => ({ status: r.status(), code: ((await r.json().catch(() => ({}))) as { error?: { code: string } }).error?.code });

  const viewer = await inviteAs(page.request, 'viewer');
  const analyst = await inviteAs(page.request, 'analyst');
  const other = await newApiOrg(playwright, baseURL);
  const results: Record<string, { status: number; code?: string }> = {};
  results['viewer POST ocr'] = await code(await viewer.api.post(url(doc.id)));
  results['other org POST ocr'] = await code(await other.post(url(doc.id)));
  results['analyst POST ocr (text PDF)'] = await code(await analyst.api.post(url(text.id)));
  expect(results['viewer POST ocr']!.status).toBe(403);
  expect(results['other org POST ocr']!.status).toBe(404);
  expect(results['analyst POST ocr (text PDF)']!.status).toBe(409);
  expect(stub.of('ocr'), 'no refused request reached the model').toHaveLength(0);

  // Round-2 behaviour (commit 7b22770): the bid_manager+ check of ?force=1 applies once the document already has OCR text.
  results['analyst POST ocr (scan, no OCR text yet)'] = await code(await analyst.api.post(url(doc.id)));
  expect(results['analyst POST ocr (scan, no OCR text yet)']!.status).toBe(200);
  results['analyst POST ocr again, no force'] = await code(await analyst.api.post(url(doc.id)));
  expect(results['analyst POST ocr again, no force']!.status).toBe(409);
  results['analyst POST ocr?force=1 (OCR text exists)'] = await code(await analyst.api.post(url(doc.id, '?force=1')));
  expect(results['analyst POST ocr?force=1 (OCR text exists)']!.status).toBe(403);
  results['owner (bid_manager+) POST ocr?force=1'] = await code(await page.request.post(url(doc.id, '?force=1')));
  expect(results['owner (bid_manager+) POST ocr?force=1']!.status).toBe(200);
  expect(stub.of('ocr')).toHaveLength(2);

  // A shared GeM copy is never re-read with force (403), even by the owner.
  const t2 = await freshGemTender(page.request);
  const gem = await fetchScannedGemDoc(page.request, t2.id);
  const gemOcr = await page.request.post(`/api/tenders/${t2.id}/documents/${gem.id}/ocr`);
  results['owner POST ocr (shared GeM scan)'] = await code(gemOcr);
  expect(gemOcr.status()).toBe(200);
  results['owner POST ocr?force=1 (shared GeM copy)'] = await code(await page.request.post(`/api/tenders/${t2.id}/documents/${gem.id}/ocr?force=1`));
  expect(results['owner POST ocr?force=1 (shared GeM copy)']!.status).toBe(403);
  await other.dispose();

  await showCalls(page, 'x3 — POST …/documents/<docId>/ocr by role', [], Object.entries(results).map(([k, v]) => `${k.padEnd(46)} -> ${v.status}${v.code ? ` ${v.code}` : ''}`));
  await ev(page, 'x3-ocr-roles-matrix');
});

test('x4 a11y (axe, serious/critical): Documents tab with the OCR action, Requirements tab with the OCR marker @mobile', async ({ page }) => {
  await keyedOrg(page);
  const t = await freshGemTender(page.request);
  const scanned = await fetchScannedGemDoc(page.request, t.id);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await expect(page.getByRole('button', { name: /with AI \(OCR\)/ })).toBeVisible();
  await checkA11y(page, { include: ['main'] });
  await ev(page, 'x4a-a11y-documents-ocr-action');
  await page.getByRole('button', { name: /with AI \(OCR\)/ }).click();
  await expect(page.getByTestId('ocr-badge')).toBeVisible({ timeout: 30_000 });
  stub.enrich = 'empty';
  await analyse(page.request, t.id);
  await page.goto(`/tenders/${t.id}?tab=requirements`);
  await expect(page.locator('[data-testid=ocr-requirement]:visible').first()).toBeVisible();
  await checkA11y(page, { include: ['main'] });
  void scanned;
});

test('x5 a second manual OCR of a document that is already being read -> 409 conflict; the first run completes; one model call', async ({ page }) => {
  await keyedOrg(page);
  const t = await freshGemTender(page.request);
  const d = await pdfLib().PDFDocument.create(); for (let i = 0; i < 2; i++) d.addPage([595, 842]);
  const up = await page.request.post(`/api/tenders/${t.id}/documents`, { multipart: { kind: 'bid', file: { name: 'scan-claim.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await d.save()) } } });
  const doc = (await up.json()) as TenderDocumentDto;
  stub.ocrDelayMs = 4000;
  const url = `/api/tenders/${t.id}/documents/${doc.id}/ocr`;
  const first = page.request.post(url);
  await expect.poll(() => stub.of('ocr').length, { timeout: 10_000 }).toBe(1); // the first run is inside its model call
  const second = await page.request.post(url);
  const body = await second.json();
  expect(second.status()).toBe(409);
  expect(body.error.code).toBe('conflict');
  const ok = await first;
  expect(ok.status()).toBe(200);
  expect(stub.of('ocr'), 'the refused run made no model call').toHaveLength(1);
  expect((await listDocs(page.request, t.id)).find((x) => x.id === doc.id)).toMatchObject({ textSource: 'ocr', needsOcr: false });
  const usage = ((await (await page.request.get('/api/org/usage')).json()) as { usage: { llmAnalysesThisMonth: number } }).usage.llmAnalysesThisMonth;
  expect(usage, 'the stored OCR text cost exactly one AI slot').toBe(1);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await showCalls(page, `x5 — concurrent manual OCR: first -> 200, second -> 409 ${JSON.stringify(body.error)}; model calls ${stub.of('ocr').length}; AI slots used ${usage}`, stub.calls);
  await ev(page, 'x5-ocr-already-being-read-409');
});
