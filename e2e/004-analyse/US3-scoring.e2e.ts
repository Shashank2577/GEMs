/**
 * QA acceptance for spec 004 / US3 (#169): explainable Go/No-Go score with exemptions and blockers.
 * One test per acceptance criterion (numbering = the issue's criteria); rules-only (no LLM key configured).
 * Screenshots/videos land in qa/evidence/004/US3/.
 *
 * Determinism: tenders are inserted with SQL (no GeM link, own `source`, the bid number printed in the PDF) so
 * the shared GeM-document store cannot change counts and no "Check documents" prefix appears in the summary.
 * Clock-dependent cases (closed / 20 h / 2 days) set `end_at` relative to now() in SQL.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import type { AnalysisDto, ScoreFactor } from '../../packages/core/src/contracts/analyse';
import { inviteAs } from '../support/fixtures';
import { istDay, makePdf, apiUploadOk } from '../005-profile-vault/support';
import { SPEC, collectRunArtifacts, evidence, expect, setProfile, signupViaApi, test, uploadFixtureViaApi, type BidFixture } from './support';

const STORY = 'US3';
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

// ---------- helpers ----------
const BID_NO: Record<string, string> = {
  'go-it-services': 'GEM/2026/B/6120451', 'review-hardware-oem': 'GEM/2026/B/6133872', 'nogo-experience': 'GEM/2026/B/6140019',
};
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const psql = (sql: string) => execFileSync('psql', [E2E_DB, '-tAqc', sql], { encoding: 'utf8' }).trim().split('\n')[0] ?? '';

interface TenderOpts { fixture?: string; bidNumber?: string; state?: string | null; endExpr?: string; status?: 'open' | 'closed'; title?: string; category?: string | null }
/** An open GeM-style tender without gem_bid_id / document_url; `endExpr` is a SQL expression (default now() + 20 days). */
function insertTender(o: TenderOpts = {}): { id: string; bidNumber: string } {
  const bid = o.bidNumber ?? BID_NO[o.fixture ?? ''] ?? `GEM/2026/B/${9_000_000 + Math.floor(Math.random() * 999_999)}`;
  const src = `qa-us3-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const state = o.state === undefined ? 'Maharashtra' : o.state;
  const sql = `insert into tenders (source,bid_number,title,category,state,source_url,content_hash,status,end_at) values (${sqlStr(src)},${sqlStr(bid)},${sqlStr(o.title ?? 'IT Helpdesk Support Services')},${o.category == null ? 'null' : sqlStr(o.category)},${state == null ? 'null' : sqlStr(state)},${sqlStr(`https://example.invalid/${src}`)},${sqlStr(`${src}-h`)},${sqlStr(o.status ?? 'open')},${o.endExpr ?? `now() + interval '20 days'`}) returning id;`;
  return { id: psql(sql), bidNumber: bid };
}

async function demoOrg(page: Page) {
  const user = await signupViaApi(page);
  const seeded = await page.request.post('/api/demo/seed');
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  return user;
}
async function analyseOk(r: APIRequestContext, tenderId: string): Promise<AnalysisDto> {
  const res = await r.post(`/api/tenders/${tenderId}/analyse`);
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}
const factor = (a: AnalysisDto, key: string): ScoreFactor => {
  const f = a.factors.find((x) => x.key === key);
  expect(f, `factor ${key} in [${a.factors.map((x) => x.key).join(', ')}]`).toBeTruthy();
  return f!;
};
/** A tender + its fixture PDF + a completed API analysis in the current (demo) org. */
async function analysedDemoTender(page: Page, fixture: BidFixture, opts: TenderOpts = {}) {
  const t = insertTender({ fixture, ...opts });
  await uploadFixtureViaApi(page.request, t.id, fixture);
  const a = await analyseOk(page.request, t.id);
  return { t, a };
}
const openTender = async (page: Page, id: string, tab = '') => {
  await page.goto(`/tenders/${id}${tab}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
};

/** A factor row of the breakdown card (desktop `li` list, same list on mobile). */
const rowOf = (page: Page, label: string) => page.locator('ul.divide-y > li').filter({ hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}`) }).first();
async function expectRow(page: Page, label: string, status: string, detail: string | RegExp, extra: { badge?: string } = {}) {
  const row = rowOf(page, label);
  await expect(row, `row ${label}`).toBeVisible();
  await expect(row.getByText(status, { exact: true }).first(), `${label} status`).toBeVisible();
  if (typeof detail === 'string') await expect(row.locator('p').filter({ hasText: detail }).first(), `${label} detail`).toHaveText(detail);
  else await expect(row, `${label} detail`).toContainText(detail);
  if (extra.badge) await expect(row.getByText(extra.badge, { exact: true })).toBeVisible();
}
const toast = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
const ring = (page: Page, name: string) => page.getByRole('img', { name, exact: true });
const clickAnalyse = (page: Page) => page.getByRole('button', { name: 'Analyse eligibility' }).first().click();

/** A one-page text PDF built with pdf-lib (lines drawn top-down). */
async function textPdf(lines: string[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = createRequire(join(process.cwd(), 'packages/core/package.json'))('pdf-lib') as typeof import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  lines.forEach((l, i) => page.drawText(l, { x: 40, y: 790 - i * 18, size: 10, font }));
  return Buffer.from(await doc.save());
}

// ---------- criteria ----------

test('1 demo company + go-it-services.pdf: 4-step "Analysing this tender…" ≥ 2.4 s, toast "Go · 100/100" / "Rules-only analysis complete", ring "Score 100 of 100, Go" @mobile', async ({ page }) => {
  await demoOrg(page);
  const t = insertTender({ fixture: 'go-it-services' });
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  await openTender(page, t.id);
  await expect(page.getByRole('heading', { name: 'Should you bid on this tender?' })).toBeVisible();

  const t0 = Date.now();
  await clickAnalyse(page);
  const card = page.getByRole('heading', { name: 'Analysing this tender…' });
  await expect(card).toBeVisible();
  for (const step of ['Reading bid document', 'Extracting eligibility', 'Comparing with your profile', 'Scoring']) await expect(page.getByText(new RegExp(`^${step}…?$`))).toBeVisible(); // the active step carries a trailing …
  await ev(page, '01a-analysing-four-steps');
  await expect(card).toBeHidden({ timeout: 15_000 });
  const elapsed = Date.now() - t0;
  expect(elapsed, `"Analysing this tender…" was on screen ${elapsed} ms`).toBeGreaterThanOrEqual(2400);

  await expect(toast(page, 'Go · 100/100')).toContainText('Rules-only analysis complete');
  await expect(ring(page, 'Score 100 of 100, Go')).toBeVisible();
  await ev(page, '01b-toast-and-ring');
  test.info().annotations.push({ type: 'analysing-card-ms', description: String(elapsed) });
});

test('2 factor sentences are exact for the demo company on go-it-services.pdf; "Not applicable to this bid (1)" holds OEM @mobile', async ({ page }) => {
  await demoOrg(page);
  const { t, a } = await analysedDemoTender(page, 'go-it-services');
  expect(a.score).toBe(100);
  await openTender(page, t.id);
  await expect(ring(page, 'Score 100 of 100, Go')).toBeVisible();

  await expectRow(page, 'Average annual turnover', 'Pass', 'Your average turnover of ₹2.49 Cr (last 3 years) meets the required ₹50 L.', { badge: 'Hard criterion' });
  await expectRow(page, 'Years of experience', 'Pass', 'You have 3 years of experience; the bid needs 3 years.');
  await expectRow(page, 'Similar work value', 'Pass', 'Your largest past contract (₹96.4 L, CCTV surveillance for 42 ward offices (supply, installation, 3-year AMC)) meets the required ₹19.2 L.');
  await expectRow(page, 'EMD (earnest money)', 'Exempt', 'Exempt (MSE): EMD of ₹96,000 is waived with your valid Udyam certificate.');
  await expectRow(page, 'Make in India', 'Pass', 'You are a Class-I local supplier with 62% local content and get purchase preference.');
  await expectRow(page, 'Certificates', 'Pass', 'You hold all requested certificates: ISO 9001.');
  await expectRow(page, 'Documents in vault', 'Pass', 'All 7 required documents are in your vault and valid. Also check 1 bid-specific document listed in the ATC.');
  await expectRow(page, 'Delivery feasibility', 'Pass', 'Delivery period of 30 days to Maharashtra looks feasible.');

  const na = page.getByRole('button', { name: 'Not applicable to this bid (1)' });
  await expect(na).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('No OEM authorisation is required.')).toBeHidden();
  await na.click();
  await expect(na).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('OEM authorisation', { exact: true })).toBeVisible();
  await expect(page.getByText('— No OEM authorisation is required.')).toBeVisible();
  await rowOf(page, 'Average annual turnover').scrollIntoViewIfNeeded();
  await ev(page, '02-factor-sentences');
});

test('3 score card: "Rules only" badge + tooltip, exact summary, confidence 100%, 8 pass / 1 exempt, "Analysed just now" @mobile', async ({ page }) => {
  await demoOrg(page);
  const { t, a } = await analysedDemoTender(page, 'go-it-services');
  const summary = 'Go — 100/100 with 100% confidence. Average annual turnover, years of experience and similar work value are in your favour. EMD (earnest money) is exempt for you.';
  expect(a.summary).toBe(summary);
  expect(a.confidence).toBe(1);
  await openTender(page, t.id);

  const badge = page.getByText('Rules only', { exact: true });
  await expect(badge).toBeVisible();
  await expect(page.getByText(summary, { exact: true })).toBeVisible();
  await expect(page.getByText('100%', { exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Confidence 100%' })).toBeVisible();
  await expect(page.getByText('8 pass', { exact: true })).toBeVisible();
  await expect(page.getByText('1 exempt', { exact: true })).toBeVisible();
  await expect(page.getByText('Analysed just now')).toBeVisible();
  if (test.info().project.name === 'desktop') {
    await badge.hover();
    await expect(page.getByRole('tooltip').filter({ hasText: 'Deterministic rules only — every value is traceable to a page of the bid document.' })).toBeVisible();
  }
  await ev(page, '03-score-card');
});

test('4 Show evidence on "Similar work value": quote, p. 4 chip, file name, "· Rule · 85% confidence"; aria-expanded toggles @mobile', async ({ page }) => {
  await demoOrg(page);
  const { t, a } = await analysedDemoTender(page, 'go-it-services');
  const sw = a.requirements.find((r) => r.key === 'similar_work')!;
  expect(sw.source.page).toBe(4);
  await openTender(page, t.id);

  const row = rowOf(page, 'Similar work value');
  const toggle = row.getByRole('button', { name: 'Show evidence' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const open = row.getByRole('button', { name: 'Hide evidence' });
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  const quote = row.locator('blockquote');
  await expect(quote).toBeVisible();
  await expect(quote).toContainText(sw.source.quote!.slice(0, 60));
  await expect(quote.getByRole('link', { name: /^p\. 4/ })).toBeVisible();
  await expect(quote.getByText('go-it-services.pdf', { exact: true })).toBeVisible();
  await expect(quote).toContainText('· Rule · 85% confidence');
  await row.scrollIntoViewIfNeeded();
  await ev(page, '04-evidence-open');
  await open.click();
  await expect(row.getByRole('button', { name: 'Show evidence' })).toHaveAttribute('aria-expanded', 'false');
  await expect(quote).toBeHidden();
});

test('5 weak profile + nogo-experience.pdf: No-Go 58/100, confidence 86%, blocker callout, blocker row first @mobile', async ({ page }) => {
  await signupViaApi(page);
  const inc = istDay(0).replace(/^(\d{4})/, (y) => String(Number(y) - 3));
  await setProfile(page.request, { legalName: 'Weak Profile Traders', incorporationDate: inc, financials: [{ fy: '2024-25', turnover: 9_000_000 }], maxEmdCapacity: 100_000 });
  const t = insertTender({ fixture: 'nogo-experience' });
  await uploadFixtureViaApi(page.request, t.id, 'nogo-experience');
  await openTender(page, t.id);
  await clickAnalyse(page);
  await expect(toast(page, 'No-Go · 58/100')).toBeVisible({ timeout: 15_000 });
  await expect(ring(page, 'Score 58 of 100, No-Go')).toBeVisible();
  await expect(page.getByText('86%', { exact: true })).toBeVisible();
  await expect(page.getByText('Hard blocker: Years of experience — a failed blocker means No-Go regardless of score.')).toBeVisible();

  const first = page.locator('ul.divide-y > li').first();
  await expect(first).toContainText('Years of experience');
  await expect(first.getByText('Blocker', { exact: true })).toBeVisible();
  await expect(first).toContainText('You have 3 years of experience (based on your incorporation date — add past contracts as proof); the bid needs 5 years.');
  await expectRow(page, 'Similar work value', 'Needs review', 'Bid needs one similar work of ₹20 L; add your past contracts to check.');
  await expectRow(page, 'EMD (earnest money)', 'Pass', 'EMD of ₹50,000 is within your capacity of ₹1 L.');
  await ev(page, '05-nogo-blocker');
});

test('6 demo company + review-hardware-oem.pdf: Go 82/100, Certificates fail BIS, Documents 7 of 8, EMD exempt ₹2.16 L, summary ends "Fix: certificates and documents in vault."', async ({ page }) => {
  await demoOrg(page);
  // The 82 needs the OEM factor to stay a generic Pass, i.e. a tender whose title/category carry no significant product word
  // (FR-030). A product-named tender (criterion 16, real mock-gem tenders) gives OEM "Needs review" and a lower score; see VERDICT finding 1.
  const { t, a } = await analysedDemoTender(page, 'review-hardware-oem', { title: 'QA tender', category: 'IT Services' });
  expect({ verdict: a.verdict, score: a.score }).toEqual({ verdict: 'go', score: 82 });
  expect(a.summary).toMatch(/Fix: certificates and documents in vault\.$/);
  await openTender(page, t.id);
  await expect(ring(page, 'Score 82 of 100, Go')).toBeVisible();
  await expectRow(page, 'Certificates', 'Fail', 'Missing 1 certificate: BIS.');
  await expectRow(page, 'Documents in vault', 'Fail', '7 of 8 required documents are ready. Missing: Past performance proof (supply orders for similar quantity). Also check 2 bid-specific documents listed in the ATC.');
  await expectRow(page, 'EMD (earnest money)', 'Exempt', 'Exempt (MSE): EMD of ₹2.16 L is waived with your valid Udyam certificate.');
  await expect(page.getByText(/Fix: certificates and documents in vault\.$/)).toBeVisible();
  await ev(page, '06-go-82');
});

test('7 expired Udyam: turnover fail with renewal hint and no EMD exemption; after a valid Udyam, "Exempt (MSE)"', async ({ page }) => {
  await signupViaApi(page);
  await setProfile(page.request, {
    legalName: 'Small Co', mseCategory: 'small', udyamNumber: 'UDYAM-MH-26-0099999', incorporationDate: '2010-01-01',
    financials: [{ fy: '2024-25', turnover: 2_000_000 }], maxEmdCapacity: 50_000,
  });
  await apiUploadOk(page.request, { name: 'udyam-old.pdf', bytes: await makePdf(1, 'Udyam old'), fields: { type: 'udyam', title: 'Udyam Registration (expired)', issueDate: istDay(-400), expiryDate: istDay(-1) } });
  const t = insertTender({ fixture: 'go-it-services' });
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  const before = await analyseOk(page.request, t.id);
  expect(factor(before, 'turnover')).toMatchObject({ status: 'fail' });
  expect(factor(before, 'turnover').detail).toContain('Your Udyam certificate has expired — renew it to claim the MSE exemption.');
  expect(factor(before, 'emd').status).not.toBe('exempt');
  expect(factor(before, 'emd').detail).not.toContain('Exempt (MSE)');
  await openTender(page, t.id);
  await expectRow(page, 'Average annual turnover', 'Fail', /Your average turnover of ₹20 L is below the required ₹50 L\. Your Udyam certificate has expired — renew it to claim the MSE exemption\./);
  await expect(rowOf(page, 'EMD (earnest money)').getByText('Exempt', { exact: true })).toHaveCount(0);
  await ev(page, '07a-expired-udyam');

  await apiUploadOk(page.request, { name: 'udyam-new.pdf', bytes: await makePdf(1, 'Udyam new'), fields: { type: 'udyam', title: 'Udyam Registration (renewed)', issueDate: istDay(-1), expiryDate: istDay(365) } });
  const after = await analyseOk(page.request, t.id);
  expect(factor(after, 'turnover').status).toBe('exempt');
  await openTender(page, t.id);
  await expectRow(page, 'Average annual turnover', 'Exempt', /Exempt \(MSE\): the bid waives the ₹50 L turnover criterion for MSEs/);
  await expectRow(page, 'EMD (earnest money)', 'Exempt', 'Exempt (MSE): EMD of ₹96,000 is waived with your valid Udyam certificate.');
  await ev(page, '07b-valid-udyam');
});

test('8 no profile + go-it-services.pdf: Review 46/100, 44% confidence, five Needs review factors with actionable sentences @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender({ fixture: 'go-it-services' });
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  await openTender(page, t.id);
  await clickAnalyse(page);
  await expect(toast(page, 'Review · 46/100')).toBeVisible({ timeout: 15_000 });
  await expect(ring(page, 'Score 46 of 100, Review')).toBeVisible();
  await expect(page.getByText('44%', { exact: true })).toBeVisible();
  await expectRow(page, 'Average annual turnover', 'Needs review', 'Bid needs ₹50 L average turnover, but your profile has no financial years yet. Add turnover to your company profile.');
  await expectRow(page, 'Years of experience', 'Needs review', 'Bid needs 3 years of experience; add past contracts or your incorporation date to your profile.');
  await expectRow(page, 'Similar work value', 'Needs review', 'Bid needs one similar work of ₹19.2 L; add your past contracts to check.');
  await expectRow(page, 'EMD (earnest money)', 'Needs review', 'EMD of ₹96,000 is required; set your maximum EMD capacity in the company profile.');
  await expectRow(page, 'Make in India', 'Needs review', 'The bid requires MII compliance; set your local-content class in the company profile.');
  await expect(page.getByText('5 needs review', { exact: true })).toBeVisible();
  await expect(page.getByText(/Needs review: average annual turnover, years of experience, similar work value, EMD \(earnest money\) and make in India\.$/)).toBeVisible();
  await ev(page, '08-no-profile-review-46');
});

test('9 closed tender: timeToClose is a failed blocker "This bid has already closed." → No-Go; hero Analyse disabled if never analysed', async ({ page }) => {
  await demoOrg(page);
  const past = `now() - interval '2 days'`;
  const analysed = insertTender({ fixture: 'go-it-services', endExpr: past, status: 'closed' });
  await uploadFixtureViaApi(page.request, analysed.id, 'go-it-services');
  const a = await analyseOk(page.request, analysed.id);
  expect(factor(a, 'timeToClose')).toMatchObject({ status: 'fail', blocking: true, detail: 'This bid has already closed.' });
  expect(a.verdict).toBe('no_go');
  await openTender(page, analysed.id);
  await expect(page.getByText('Hard blocker: Time to bid closing — a failed blocker means No-Go regardless of score.')).toBeVisible();
  await expectRow(page, 'Time to bid closing', 'Fail', 'This bid has already closed.', { badge: 'Blocker' });
  await expect(page.locator('ul.divide-y > li').first()).toContainText('Time to bid closing');
  await ev(page, '09a-closed-nogo');

  const never = insertTender({ fixture: 'go-it-services', bidNumber: `GEM/2026/B/${9_100_000 + Math.floor(Math.random() * 99_999)}`, endExpr: past, status: 'closed' });
  await openTender(page, never.id);
  await expect(page.getByRole('button', { name: 'Analyse eligibility' }).first()).toBeDisabled();
  await ev(page, '09b-closed-never-analysed-disabled');
});

test('10 time to close: 20 hours → Fail (not a blocker); 2 days → Needs review', async ({ page }) => {
  await demoOrg(page);
  const h = await analysedDemoTender(page, 'go-it-services', { endExpr: `now() + interval '20 hours 10 minutes'` });
  expect(factor(h.a, 'timeToClose')).toMatchObject({ status: 'fail', blocking: false, detail: 'Closes in 20 hours — too little time to prepare a complete bid.' });
  expect(h.a.verdict).not.toBe('no_go'); // not a blocker
  await openTender(page, h.t.id);
  await expectRow(page, 'Time to bid closing', 'Fail', 'Closes in 20 hours — too little time to prepare a complete bid.');
  await expect(rowOf(page, 'Time to bid closing').getByText('Blocker', { exact: true })).toHaveCount(0);
  await ev(page, '10a-closes-in-20-hours');

  const d = insertTender({ fixture: 'go-it-services', bidNumber: `GEM/2026/B/${9_200_000 + Math.floor(Math.random() * 99_999)}`, endExpr: `now() + interval '2 days 1 hour'` });
  await uploadFixtureViaApi(page.request, d.id, 'go-it-services');
  const two = await analyseOk(page.request, d.id);
  expect(factor(two, 'timeToClose')).toMatchObject({ status: 'unknown', detail: 'Closes in 2 days — tight; start now.' });
  await openTender(page, d.id);
  await expectRow(page, 'Time to bid closing', 'Needs review', 'Closes in 2 days — tight; start now.');
  await ev(page, '10b-closes-in-2-days');
});

test('11 delivery: 5 days → Fail "Only 5 days to deliver — very tight."; state outside operating states → Needs review', async ({ page }) => {
  await demoOrg(page);
  const t = insertTender({ bidNumber: 'GEM/2026/B/6199005' });
  const pdf = await textPdf([
    'Bid Number: GEM/2026/B/6199005', 'Dated: 28-11-2026', 'Bid Details',
    'Bid End Date/Time 28-11-2026 15:00:00', 'Total Quantity 10', 'Item Category Office Chairs',
    'Delivery Days 5',
  ]);
  const up = await page.request.post(`/api/tenders/${t.id}/documents`, { multipart: { kind: 'bid', file: { name: 'five-day-delivery.pdf', mimeType: 'application/pdf', buffer: pdf } } });
  expect(up.status(), await up.text()).toBe(201);
  const five = await analyseOk(page.request, t.id);
  expect(factor(five, 'deliveryFeasibility')).toMatchObject({ status: 'fail', detail: 'Only 5 days to deliver — very tight.' });
  await openTender(page, t.id);
  await expectRow(page, 'Delivery feasibility', 'Fail', 'Only 5 days to deliver — very tight.');
  await ev(page, '11a-five-days-fail');

  const kerala = await analysedDemoTender(page, 'go-it-services', { state: 'Kerala' });
  expect(factor(kerala.a, 'deliveryFeasibility')).toMatchObject({ status: 'unknown', detail: 'Delivery in 30 days to Kerala, outside your operating states — check logistics.' });
  await openTender(page, kerala.t.id);
  await expectRow(page, 'Delivery feasibility', 'Needs review', 'Delivery in 30 days to Kerala, outside your operating states — check logistics.');
  await ev(page, '11b-outside-operating-states');
});

test('12 viewer sees the result without Re-analyse / Override; empty-state sentence for viewers; POST analyse as viewer is 403 @mobile', async ({ page, browser }) => {
  await demoOrg(page);
  const { t } = await analysedDemoTender(page, 'go-it-services');
  const fresh = insertTender({ fixture: 'go-it-services', bidNumber: `GEM/2026/B/${9_300_000 + Math.floor(Math.random() * 99_999)}` });
  const viewer = await inviteAs(page.request, 'viewer');
  const vp = await viewer.newPage(browser);
  try {
    await vp.goto(`/tenders/${t.id}`);
    await expect(vp.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(ring(vp, 'Score 100 of 100, Go')).toBeVisible();
    await expect(rowOf(vp, 'Average annual turnover')).toBeVisible();
    await expect(vp.getByRole('button', { name: /Re-analyse/ })).toHaveCount(0);
    await expect(vp.getByRole('button', { name: /Override/ })).toHaveCount(0);
    await expect(vp.getByRole('button', { name: /Analyse eligibility/ })).toHaveCount(0);
    await evidence(vp, SPEC, STORY, `12a-viewer-sees-result-${test.info().project.name}`);

    await vp.goto(`/tenders/${fresh.id}`);
    await expect(vp.getByText('Ask an analyst or bid manager on your team to run the analysis.')).toBeVisible();
    await expect(vp.getByRole('button', { name: /Analyse eligibility/ })).toHaveCount(0);
    await evidence(vp, SPEC, STORY, `12b-viewer-empty-state-${test.info().project.name}`);

    const res = await viewer.api.post(`/api/tenders/${t.id}/analyse`);
    expect(res.status(), await res.text()).toBe(403);
    const read = await viewer.api.get(`/api/tenders/${t.id}/analysis`);
    expect(read.status()).toBe(200);
  } finally { await vp.context().close(); }
});

test('13 another org GET /api/tenders/:id/analysis → 404 not_found', async ({ page, browser }) => {
  await demoOrg(page);
  const { t } = await analysedDemoTender(page, 'go-it-services');
  const own = await page.request.get(`/api/tenders/${t.id}/analysis`);
  expect(own.status()).toBe(200);
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const op = await other.newPage();
    await signupViaApi(op);
    const res = await op.request.get(`/api/tenders/${t.id}/analysis`);
    const text = await res.text();
    expect(res.status(), text).toBe(404);
    expect(JSON.parse(text).error.code).toBe('not_found');
    await op.goto(`/tenders/${t.id}`);
    await expect(op.getByRole('heading', { name: 'Should you bid on this tender?' })).toBeVisible();
    await expect(op.getByRole('img', { name: /Score \d+ of 100/ })).toHaveCount(0);
    await evidence(op, SPEC, STORY, `13-other-org-no-analysis-${test.info().project.name}`);
  } finally { await other.close(); }
});

test('14 concurrent analyse → 409 analysis_running; UI keeps one "Analysing…" state and the running state shows "Analysis in progress…"', async ({ page }) => {
  test.setTimeout(150_000);
  await demoOrg(page);
  // (a) two real concurrent POSTs against the live API.
  let statuses: number[] = [];
  let loser: { status: number; body: string } | null = null;
  for (let attempt = 0; attempt < 5 && !loser; attempt++) {
    const t = insertTender({ fixture: 'go-it-services', bidNumber: `GEM/2026/B/${9_400_000 + attempt * 1000 + Math.floor(Math.random() * 999)}` });
    await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
    const rs = await Promise.all([1, 2, 3, 4].map(() => page.request.post(`/api/tenders/${t.id}/analyse`)));
    statuses = rs.map((r) => r.status());
    const l = rs.find((r) => r.status() === 409);
    if (l) loser = { status: 409, body: await l.text() };
  }
  test.info().annotations.push({ type: 'concurrent-POST-statuses', description: statuses.join(',') });
  expect(loser, `no concurrent POST answered 409 (statuses ${statuses.join(',')})`).toBeTruthy();
  expect(JSON.parse(loser!.body).error).toMatchObject({ code: 'analysis_running', message: 'An analysis is already running for this tender' });
  expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);

  // (b) a double click issues exactly one POST and one "Analysing…" card.
  const t2 = insertTender({ fixture: 'go-it-services', bidNumber: `GEM/2026/B/${9_450_000 + Math.floor(Math.random() * 999)}` });
  await uploadFixtureViaApi(page.request, t2.id, 'go-it-services');
  let posts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith(`/api/tenders/${t2.id}/analyse`)) posts++; });
  await openTender(page, t2.id);
  await page.getByRole('button', { name: 'Analyse eligibility' }).first().dblclick();
  await expect(page.getByRole('heading', { name: 'Analysing this tender…' })).toHaveCount(1);
  await ev(page, '14a-single-analysing-state');
  await expect(page.getByRole('heading', { name: 'Analysing this tender…' })).toBeHidden({ timeout: 15_000 });
  expect(posts, 'POST /analyse requests after a double click').toBe(1);

  // (c) another member's run in flight (running row younger than 2 min): POST → 409, the page shows the banner and the previous result.
  const orgId = psql(`select org_id from analyses where tender_id='${t2.id}' limit 1`);
  psql(`insert into analyses (org_id,tender_id,status,method) values ('${orgId}','${t2.id}','running','rules') returning id`);
  const res = await page.request.post(`/api/tenders/${t2.id}/analyse`);
  expect(res.status(), await res.text()).toBe(409);
  expect((await res.json()).error.code).toBe('analysis_running');
  await openTender(page, t2.id);
  await expect(page.getByText('Analysis in progress…')).toBeVisible();
  await expect(page.getByRole('button', { name: /Re-analyse/ }).first()).toBeDisabled();
  await ev(page, '14b-analysis-in-progress');
});

test('15 failed re-analysis keeps the previous result and its overrides under a warning with "Try again" @mobile', async ({ page }) => {
  test.setTimeout(150_000);
  await demoOrg(page);
  const { t, a } = await analysedDemoTender(page, 'go-it-services');
  // The owner overrides a factor so the carried-over override can be seen afterwards.
  const ov = await page.request.post(`/api/analyses/${a.id}/override`, { data: { factorKey: 'documents', status: 'fail', reason: 'Vault copies are being re-scanned' } });
  expect(ov.status(), await ov.text()).toBe(200);
  const prev = await (await page.request.get(`/api/tenders/${t.id}/analysis`)).json() as AnalysisDto;
  expect(prev.score).toBeLessThan(100);

  // A real failure through the real code path: a malformed profile makes the scoring stage throw (500, failed row).
  const orgId = psql(`select org_id from analyses where tender_id='${t.id}' limit 1`);
  const good = psql(`select financials::text from company_profiles where org_id='${orgId}'`);
  psql(`update company_profiles set financials='"broken"'::jsonb where org_id='${orgId}' returning 1`);
  let status = 0;
  try {
    const res = await page.request.post(`/api/tenders/${t.id}/analyse`);
    status = res.status();
  } finally {
    psql(`update company_profiles set financials=${sqlStr(good)}::jsonb where org_id='${orgId}' returning 1`);
  }
  test.info().annotations.push({ type: 'failing-POST-status', description: String(status) });
  expect(status, 'the re-analysis was expected to fail').toBeGreaterThanOrEqual(500);

  const after = await (await page.request.get(`/api/tenders/${t.id}/analysis`)).json() as AnalysisDto;
  expect(after.status).toBe('done');
  expect(after.score).toBe(prev.score);
  expect(after.lastAttempt?.status).toBe('failed');
  expect(factor(after, 'documents').overridden).toMatchObject({ status: 'fail' });

  await openTender(page, t.id);
  const warning = page.getByRole('status').filter({ hasText: 'The last re-analysis failed' });
  await expect(warning).toContainText(/The last re-analysis failed: .+\. Showing the previous result from .+\./);
  await expect(warning.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(ring(page, `Score ${prev.score} of 100, ${prev.verdict === 'go' ? 'Go' : 'Review'}`)).toBeVisible();
  await expect(rowOf(page, 'Documents in vault').getByText('Overridden', { exact: true })).toBeVisible();
  await ev(page, '15a-failed-reanalysis-warning');

  // Try again (profile restored) succeeds and clears the warning.
  await warning.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The last re-analysis failed' })).toHaveCount(0, { timeout: 20_000 });
  await ev(page, '15b-try-again-recovers');
});

test('16 OEM "Needs review" when no valid authorisation mentions Desktop Computers', async ({ page }) => {
  await demoOrg(page);
  const { t, a } = await analysedDemoTender(page, 'review-hardware-oem', { title: 'Desktop Computers (Q2)', category: 'Desktop Computers' });
  const detail = 'None of your valid OEM authorisations (CP PLUS, D-Link India) mention Desktop Computers — confirm one covers this product.';
  expect(factor(a, 'oem')).toMatchObject({ status: 'unknown', detail });
  expect(a.verdict).not.toBe('no_go');
  await openTender(page, t.id);
  await expectRow(page, 'OEM authorisation', 'Needs review', detail);
  await ev(page, '16-oem-needs-review');
  test.info().annotations.push({ type: 'score-with-desktop-tender', description: `${a.verdict} ${a.score}` });
});
