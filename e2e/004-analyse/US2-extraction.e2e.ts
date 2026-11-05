/**
 * QA acceptance for spec 004 / US2 (#168): extract requirements from bid documents with rules only
 * (no LLM key configured). One test per acceptance criterion; screenshots in qa/evidence/004/US2/.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import type { AnalysisDto, Requirement } from '../../packages/core/src/contracts/analyse';
import { GEM_URL } from '../support/fixtures';
import { SPEC, collectRunArtifacts, evidence, expect, mockGem, signupViaApi, test, uploadFixtureViaApi } from './support';

const STORY = 'US2';
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

test.afterEach(async ({ page }) => {
  await collectRunArtifacts(SPEC, STORY, page);
  await page.context().request.post(`${GEM_URL}/__admin/document-mode`, { data: { mode: 'normal' } }).catch(() => undefined);
});

// ---------- helpers ----------
const reqs = (a: AnalysisDto, key: string) => a.requirements.filter((r) => r.key === key);
const req = (a: AnalysisDto, key: string, value?: unknown): Requirement => {
  const r = reqs(a, key).find((x) => value === undefined || x.value === value);
  expect(r, `requirement ${key}${value === undefined ? '' : `=${String(value)}`} in [${a.requirements.map((x) => `${x.key}=${String(x.value)}`).join(', ')}]`).toBeTruthy();
  return r!;
};

async function analyseRaw(r: APIRequestContext, tenderId: string) {
  return r.post(`/api/tenders/${tenderId}/analyse`);
}
async function analyseOk(r: APIRequestContext, tenderId: string): Promise<AnalysisDto> {
  const res = await analyseRaw(r, tenderId);
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

/** Insert an open GeM-style tender without gem_bid_id / document_url straight into the e2e database. */
function insertTender(extra: { estimatedValue?: number; emdAmount?: number } = {}): { id: string; bidNumber: string } {
  const bid = `GEM/2026/B/${9_000_000 + Math.floor(Math.random() * 999_999)}`;
  const cols = ['source', 'bid_number', 'title', 'source_url', 'content_hash', 'status', 'end_at'];
  const vals = [`'gem'`, `'${bid}'`, `'QA tender without GeM link'`, `'https://example.invalid/${bid}'`, `'qa-${Date.now()}-${Math.random()}'`, `'open'`, `now() + interval '20 days'`];
  if (extra.estimatedValue != null) { cols.push('estimated_value'); vals.push(String(extra.estimatedValue)); }
  if (extra.emdAmount != null) { cols.push('emd_amount'); vals.push(String(extra.emdAmount)); }
  const sql = `insert into tenders (${cols.join(',')}) values (${vals.join(',')}) returning id;`;
  const id = execFileSync('psql', [E2E_DB, '-tAqc', sql], { encoding: 'utf8' }).trim().split('\n')[0];
  return { id, bidNumber: bid };
}

/** A small text PDF (one page) built with pdf-lib; `lines` are drawn top-down. */
async function textPdf(lines: string[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = createRequire(join(process.cwd(), 'packages/core/package.json'))('pdf-lib') as typeof import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  lines.forEach((l, i) => page.drawText(l, { x: 40, y: 790 - i * 18, size: 10, font }));
  return Buffer.from(await doc.save());
}

async function uploadBuffer(r: APIRequestContext, tenderId: string, name: string, buffer: Buffer, kind: string) {
  const res = await r.post(`/api/tenders/${tenderId}/documents`, { multipart: { kind, file: { name, mimeType: 'application/pdf', buffer } } });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

const openRequirements = async (page: Page, id: string) => {
  await page.goto(`/tenders/${id}?tab=requirements`);
  await expect(page.getByText(/requirements extracted/)).toBeVisible();
};
/** A requirement row: table row on desktop, card (li) on mobile. */
const rowOf = (page: Page, text: string | RegExp) => page.locator('tr:visible, li:visible:not([data-sonner-toast])').filter({ hasText: text }).first();
const toastText = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();

/** Same grouping as REQ_GROUPS in apps/web/src/features/tender/labels.ts */
const ELIG = ['turnover_min', 'oem_turnover', 'experience_years', 'similar_work', 'past_performance', 'oem_auth', 'certificate', 'mii', 'undertaking'];
const MONEY = ['emd', 'epbg', 'epbg_duration', 'mse_exemption', 'startup_exemption', 'mse_purchase_preference', 'estimated_value'];
const groupCounts = (a: AnalysisDto) => {
  const e = a.requirements.filter((r) => ELIG.includes(r.key)).length;
  const m = a.requirements.filter((r) => MONEY.includes(r.key)).length;
  const d = a.requirements.filter((r) => r.key === 'document').length;
  return { e, m, d, b: a.requirements.length - e - m - d };
};

/** An open GeM-linked tender (served by mock-gem) closing in 3+ days that has no shared GeM-fetched document yet. */
async function freshGemTender(r: APIRequestContext): Promise<{ id: string; bidNumber: string }> {
  const minEnd = Date.now() + 3 * 86_400_000;
  const list = async () => {
    const state = (await (await r.get(`${GEM_URL}/__admin/state`)).json()) as { bids: { id: string | number }[] };
    const known = new Set(state.bids.map((b) => String(b.id)));
    const res = await r.get('/api/tenders', { params: { status: 'open', sort: 'endAt', pageSize: 100 } });
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()) as { items: { id: string; bidNumber: string; source: string; gemBidId: string | null; endAt: string | null }[] }).items
      .filter((t) => t.source === 'gem' && !!t.gemBidId && known.has(String(t.gemBidId)) && !!t.endAt && Date.parse(t.endAt) >= minEnd);
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const t of await list()) {
      const docs = (await (await r.get(`/api/tenders/${t.id}/documents`)).json()) as { items: unknown[] };
      if (docs.items.length === 0) return t;
    }
    await mockGem(r, '/__admin/publish', { count: 6 });
    const run = await r.post('/api/ingestion/run', { data: { pages: 5 } });
    expect([200, 409], await run.text()).toContain(run.status());
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error('no fresh GeM tender available');
}

// ---------- criteria ----------

test('1 rules-only analysis of go-it-services.pdf: 201, method rules, 32 requirements with the expected values @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender();
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  const res = await analyseRaw(page.request, t.id);
  expect(res.status(), await res.text()).toBe(201);
  const a: AnalysisDto = await res.json();
  expect(a.method).toBe('rules');
  expect(a.requirements, a.requirements.map((r) => `${r.key}=${String(r.value)} [${r.source.quote === 'GeM BidPlus listing data' ? 'listing' : r.source.fileName}]`).join('; ')).toHaveLength(32);

  expect(req(a, 'turnover_min')).toMatchObject({ numeric: 5_000_000, source: expect.objectContaining({ page: 1 }) });
  expect(req(a, 'experience_years')).toMatchObject({ numeric: 3, source: expect.objectContaining({ page: 1 }) });
  expect(req(a, 'mse_exemption').value).toBe(true);
  expect(req(a, 'startup_exemption').value).toBe(true);
  expect(req(a, 'estimated_value').numeric).toBe(4_800_000);
  expect(req(a, 'emd').numeric).toBe(96_000);
  expect(String(req(a, 'epbg').value)).toContain('3');
  expect(req(a, 'epbg').numeric).toBe(3);
  expect(req(a, 'epbg_duration').numeric).toBe(14);
  expect(req(a, 'mii')).toMatchObject({ value: true, source: expect.objectContaining({ page: 2 }) });
  expect(req(a, 'delivery_days')).toMatchObject({ numeric: 30, source: expect.objectContaining({ page: 3 }) });
  expect(req(a, 'similar_work')).toMatchObject({ numeric: 1_920_000, confidence: 0.85, source: expect.objectContaining({ page: 4 }) });
  expect(req(a, 'certificate', 'ISO 9001').source.page).toBe(4);
  expect(req(a, 'undertaking', 'non_blacklisting').source.page).toBe(4);
  expect(reqs(a, 'document')).toHaveLength(4);
  expect(req(a, 'bid_published_at').source.page).toBe(1);
  expect(req(a, 'consignee_state')).toMatchObject({ value: 'Delhi', source: expect.objectContaining({ page: 3 }) });
  expect(a.requirements.every((r) => r.method === 'RULE')).toBe(true);

  await openRequirements(page, t.id);
  await expect(page.getByText('32 requirements extracted · 32 by rules')).toBeVisible();
  await ev(page, '01-rules-only-analysis');
});

test('2 Requirements tab: header, four groups with counts, mandatory dots, Rule badges, confidence bars @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender();
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  const a = await analyseOk(page.request, t.id);
  const c = groupCounts(a);
  await openRequirements(page, t.id);
  await expect(page.getByText('32 requirements extracted · 32 by rules')).toBeVisible();
  for (const [label, n] of [['Eligibility criteria', c.e], ['EMD, ePBG & exemptions', c.m], ['Documents required from seller', c.d], ['Bid details', c.b]] as const) {
    await expect(page.getByRole('heading', { level: 3, name: new RegExp(`^${label}\\s*\\(${n}\\)$`, 'i') }), `${label} (${n})`).toBeVisible();
  }
  expect(c.e + c.m + c.d + c.b).toBe(32);
  // The table (desktop) and the card list (mobile) are both in the DOM; only count what is visible.
  const vis = (loc: string, text?: RegExp) => page.locator(`${loc}:visible`, text ? { hasText: text } : undefined);
  await expect(vis('[aria-label="mandatory"]').first()).toBeVisible();
  expect(await vis('[aria-label="mandatory"]').count()).toBeGreaterThan(3);
  await expect(vis('span', /^\s*Rule\s*$/).first()).toBeVisible();
  expect(await vis('span', /^\s*Rule\s*$/).count()).toBe(32);
  await expect(vis('span', /^\s*AI\s*$/)).toHaveCount(0);
  await expect(vis('[aria-label$=" confidence"]').first()).toBeVisible();
  expect(await vis('[aria-label$=" confidence"]').count()).toBe(32);
  await ev(page, '02-requirements-header');
});

test('3 "p. 4" chip opens the PDF inline at page 4 and carries an accessible label', async ({ page, context }) => {
  await signupViaApi(page);
  const t = insertTender();
  const doc = await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  await analyseOk(page.request, t.id);
  await openRequirements(page, t.id);
  const chip = page.locator('tr:visible, li:visible:not([data-sonner-toast])').filter({ hasText: /similar/i })
    .filter({ has: page.getByRole('link', { name: 'Open go-it-services.pdf at page 4' }) }).first().getByRole('link', { name: 'Open go-it-services.pdf at page 4' });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(/p\. 4/);
  const href = (await chip.getAttribute('href'))!;
  expect(href).toMatch(new RegExp(`/api/tenders/${t.id}/documents/${doc.id}/download\\?inline=1#page=4$`));
  await ev(page, '03-page-chip');
  await expect(chip).toHaveAttribute('target', '_blank');
  // Click opens a new tab that requests the inline download URL (the #page=4 fragment is client-side only; headless
  // Chromium has no PDF viewer so the tab ends up as a download and its url() stays empty).
  const reqP = context.waitForEvent('request', (r) => r.url().includes(`/documents/${doc.id}/download?inline=1`));
  const popupP = context.waitForEvent('page');
  await chip.click();
  await reqP;
  const popup = await popupP;
  const head = await page.request.get(href.split('#')[0]);
  expect(head.status()).toBe(200);
  expect(head.headers()['content-disposition'] ?? '').toMatch(/^inline/);
  expect(head.headers()['content-type'] ?? '').toContain('application/pdf');
  await popup.close();
});

test('4 filter "emd" narrows rows; "zzz" shows "Nothing matches" @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender();
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  const a = await analyseOk(page.request, t.id);
  await openRequirements(page, t.id);
  const filter = page.getByRole('textbox', { name: 'Filter requirements' });
  const total = (await page.getByRole('heading', { level: 3 }).allTextContents()).map((h) => Number(/\((\d+)\)/.exec(h)?.[1] ?? 0)).reduce((x, y) => x + y, 0);
  expect(total).toBe(32);
  await filter.fill('emd');
  const narrowed = (await page.getByRole('heading', { level: 3 }).allTextContents()).map((h) => Number(/\((\d+)\)/.exec(h)?.[1] ?? 0)).reduce((x, y) => x + y, 0);
  expect(narrowed).toBeGreaterThan(0);
  expect(narrowed).toBeLessThan(total);
  expect(narrowed).toBeLessThanOrEqual(a.requirements.filter((r) => /emd/i.test(`${r.label} ${r.key} ${String(r.value)} ${r.source.quote ?? ''}`)).length);
  await expect(page.getByText(/EMD/).first()).toBeVisible();
  await expect(page.getByText('32 requirements extracted · 32 by rules')).toBeVisible();
  await ev(page, '04-filter-emd');
  await filter.fill('zzz');
  await expect(page.getByText('Nothing matches')).toBeVisible();
  await expect(page.getByText('No requirement mentions “zzz”.')).toBeVisible();
  await ev(page, '04-filter-zzz');
});

test('5 bilingual / wrapped GeM labels parse bid_end (ISO +05:30) @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender();
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  const a1 = await analyseOk(page.request, t.id);
  expect(req(a1, 'bid_end').value).toBe('2026-11-28T15:00:00+05:30');
  // Hindi-first bilingual labels (Devanagari font) with interleaved wrapped labels / cell layout.
  const t2 = insertTender();
  await uploadFixtureViaApi(page.request, t2.id, 'real-ra-bid');
  const a2 = await analyseOk(page.request, t2.id);
  expect(req(a2, 'bid_end').value).toBe('2026-11-18T11:00:00+05:30');
  expect(req(a2, 'bid_opening').value).toBe('2026-11-18T11:30:00+05:30');
  const t3 = insertTender();
  await uploadFixtureViaApi(page.request, t3.id, 'real-goods-bid');
  const a3 = await analyseOk(page.request, t3.id);
  expect(req(a3, 'bid_end').value).toBe('2026-11-14T13:00:00+05:30');
  // Devanagari never leaks into extracted quotes.
  for (const r of [...a2.requirements, ...a3.requirements]) expect(r.source.quote ?? '').not.toMatch(/[ऀ-ॿ]/);
  await openRequirements(page, t.id);
  await expect(rowOf(page, /^Bid end date/)).toContainText(/28 Nov 2026/);
  await ev(page, '05-bid-end-parsed');
});

test('6 an uploaded corrigendum supersedes bid_end; multi-valued items from both documents are kept', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender();
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  const before = await analyseOk(page.request, t.id);
  expect(req(before, 'bid_end').value).toBe('2026-11-28T15:00:00+05:30');
  const docsBefore = reqs(before, 'document').map((r) => r.value as string);
  expect(docsBefore).toHaveLength(4);
  const corr = await textPdf(['Corrigendum', 'Bid End Date/Time 12-12-2026 18:00:00', 'Document required from seller OEM Authorization Certificate']);
  await uploadBuffer(page.request, t.id, 'corrigendum-1.pdf', corr, 'corrigendum');
  const after = await analyseOk(page.request, t.id);
  expect(req(after, 'bid_end').value).toBe('2026-12-12T18:00:00+05:30');
  expect(reqs(after, 'bid_end')).toHaveLength(1);
  const docsAfter = reqs(after, 'document').map((r) => r.value as string);
  for (const d of docsBefore) expect(docsAfter).toContain(d);
  expect(docsAfter).toContain('OEM Authorization Certificate');
  expect(docsAfter).toHaveLength(5);
  expect(req(after, 'emd').numeric).toBe(96_000); // untouched single-valued key from the bid
  await openRequirements(page, t.id);
  await expect(rowOf(page, /^Bid end date/)).toContainText(/12 Dec 2026/);
  await expect(rowOf(page, 'OEM Authorization Certificate')).toBeVisible();
  await ev(page, '06-corrigendum-supersedes');
});

test('7 missing EMD / estimated value come from the listing: "GeM BidPlus listing data", Listing source, 70% @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender({ estimatedValue: 2_500_000, emdAmount: 50_000 });
  const pdf = await textPdf(['Bid Details', 'Bid End Date/Time 21-11-2026 18:00:00', 'Document required from seller Experience Criteria']);
  await uploadBuffer(page.request, t.id, 'no-money.pdf', pdf, 'bid');
  const a = await analyseOk(page.request, t.id);
  for (const [key, n] of [['emd', 50_000], ['estimated_value', 2_500_000]] as const) {
    const r = req(a, key);
    expect(r.numeric).toBe(n);
    expect(r.confidence).toBeCloseTo(0.7, 2);
    expect(r.source.quote).toContain('GeM BidPlus listing data');
    expect(r.source.page ?? null).toBeNull();
    expect(r.method).toBe('RULE');
  }
  await openRequirements(page, t.id);
  const emdRow = rowOf(page, /EMD/);
  await expect(emdRow).toContainText('GeM BidPlus listing data');
  await expect(emdRow).toContainText('Listing');
  await expect(emdRow).toContainText('70%');
  await expect(rowOf(page, /Estimated/)).toContainText('Listing');
  await ev(page, '07-listing-fallback');
});

test('8 review-hardware-oem.pdf: turnover, OEM turnover, past performance, OEM auth, BIS, BoQ compliance document', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender();
  await uploadFixtureViaApi(page.request, t.id, 'review-hardware-oem');
  const a = await analyseOk(page.request, t.id);
  expect(req(a, 'turnover_min').numeric).toBe(15_000_000);
  expect(req(a, 'oem_turnover').numeric).toBe(2_000_000_000);
  expect(req(a, 'past_performance')).toMatchObject({ numeric: 20 });
  expect(String(req(a, 'past_performance').value)).toBe('20%');
  expect(req(a, 'oem_auth').confidence).toBeCloseTo(0.95, 2);
  expect(reqs(a, 'certificate').map((r) => r.value)).toContain('BIS');
  expect(reqs(a, 'document').map((r) => String(r.value)).join('|')).toMatch(/BoQ/i);
  await openRequirements(page, t.id);
  await expect(rowOf(page, /OEM.*turnover/i)).toContainText(/200\s*Cr|2,00,00,00,000/);
  await expect(rowOf(page, /Past performance/i)).toContainText('20%');
  await expect(rowOf(page, /BoQ/i)).toBeVisible();
  await ev(page, '08-hardware-oem');
});

test('9 no documents and no GeM link: 422 no_documents; UI toast "Add the bid document first" with Upload PDF, Documents tab @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender();
  const res = await analyseRaw(page.request, t.id);
  expect(res.status()).toBe(422);
  expect((await res.json()).error.code).toBe('no_documents');
  await page.goto(`/tenders/${t.id}`);
  await page.getByRole('button', { name: /Analyse eligibility/ }).click();
  const toast = toastText(page, 'Add the bid document first');
  await expect(toast).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Upload PDF' })).toBeVisible();
  await expect(page).toHaveURL(/tab=documents/);
  await expect(page.getByText('Tender documents')).toBeVisible();
  await ev(page, '09-no-documents-toast');
});

test('10 GeM link and no documents: analyse auto-fetches the bid document, then 201', async ({ page }) => {
  await signupViaApi(page);
  const t = await freshGemTender(page.request);
  await page.goto(`/tenders/${t.id}?tab=documents`);
  const list0 = (await (await page.request.get(`/api/tenders/${t.id}/documents`)).json()) as { items: unknown[] };
  expect(list0.items).toHaveLength(0);
  const a = await analyseOk(page.request, t.id);
  expect(a.status).toBe('done');
  expect(a.method).toBe('rules');
  expect(a.requirements.length).toBeGreaterThan(0);
  const list = (await (await page.request.get(`/api/tenders/${t.id}/documents`)).json()) as { items: { source: string; kind: string }[] };
  expect(list.items).toHaveLength(1);
  expect(list.items[0]).toMatchObject({ source: 'gem', kind: 'bid' });
  await page.goto(`/tenders/${t.id}?tab=documents`);
  await expect(page.getByText('GeM', { exact: false }).first()).toBeVisible();
  await ev(page, '10-auto-fetch-documents');
  await openRequirements(page, t.id);
  await ev(page, '10-auto-fetch-requirements');
});

test('11 "MSE/Startup Relaxation … Yes | Complete / No | Complete" -> mse_exemption true, startup_exemption false', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender();
  await uploadFixtureViaApi(page.request, t.id, 'real-service-bid');
  const a = await analyseOk(page.request, t.id);
  expect(req(a, 'mse_exemption')).toMatchObject({ value: true, method: 'RULE' });
  expect(req(a, 'startup_exemption')).toMatchObject({ value: false, method: 'RULE' });
  expect(req(a, 'mse_exemption').source.quote).toMatch(/Relaxation/i);
  await openRequirements(page, t.id);
  await expect(rowOf(page, /MSE.*(exemption|relaxation)/i)).toContainText('Yes');
  await expect(rowOf(page, /Startup.*(exemption|relaxation)/i)).toContainText('No');
  await ev(page, '11-mse-startup-relaxation');
});

test('12 contract_period "2 years" (24 months) and bid_published_at from "Dated:" @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender();
  await uploadFixtureViaApi(page.request, t.id, 'real-service-bid');
  const a = await analyseOk(page.request, t.id);
  expect(req(a, 'contract_period')).toMatchObject({ value: '2 years', numeric: 24 });
  expect(req(a, 'bid_published_at').value).toBe('2026-11-01T00:00:00+05:30');
  expect(req(a, 'bid_published_at').source.page).toBe(1);
  await openRequirements(page, t.id);
  await expect(rowOf(page, /Contract period/i)).toContainText('2 years (24 months)');
  await expect(rowOf(page, /publish/i)).toContainText(/1 Nov 2026/);
  await ev(page, '12-contract-period-published');
});

test('13 mismatched document bid number: summary "Check documents: …" and a Requirements warning callout @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender();
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services'); // prints GEM/2026/B/6120451, not this tender's number
  expect(t.bidNumber).not.toBe('GEM/2026/B/6120451');
  const a = await analyseOk(page.request, t.id);
  expect(a.summary).toMatch(/^Check documents: go-it-services\.pdf is for GEM\/2026\/B\/6120451\./);
  await openRequirements(page, t.id);
  const alert = page.getByRole('alert').filter({ hasText: 'Check documents' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('go-it-services.pdf');
  await expect(alert).toContainText('GEM/2026/B/6120451');
  await ev(page, '13-check-documents-callout');
  // A matching document produces no callout / prefix.
  const t2 = insertTender();
  const matching = await textPdf([`Bid Number: ${t2.bidNumber}`, 'Bid End Date/Time 21-11-2026 18:00:00']);
  await uploadBuffer(page.request, t2.id, 'matching.pdf', matching, 'bid');
  const a2 = await analyseOk(page.request, t2.id);
  expect(a2.summary ?? '').not.toMatch(/^Check documents/);
  await openRequirements(page, t2.id);
  await expect(page.getByRole('alert').filter({ hasText: 'Check documents' })).toHaveCount(0);
});

