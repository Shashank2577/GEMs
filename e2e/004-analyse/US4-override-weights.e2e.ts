/**
 * QA acceptance for spec 004 / US4 (#170): factor override with an audited reason, scoring weights, re-score.
 * One test per acceptance criterion (numbering = the issue's criteria). Rules-only (no LLM key configured).
 * Screenshots/videos land in qa/evidence/004/US4/.
 *
 * Determinism: tenders are inserted with SQL (no GeM link, own `source`, the bid number printed in the PDF) so the
 * shared GeM-document store cannot change counts and no "Check documents" prefix appears (same pattern as US3).
 * The "weak profile + nogo-experience.pdf" analysis is the US3 #5 No-Go 58 case.
 */
import { execFileSync } from 'node:child_process';
import type { APIRequestContext, Page } from '@playwright/test';
import type { AnalysisDto, ScoreFactor } from '../../packages/core/src/contracts/analyse';
import { inviteAs } from '../support/fixtures';
import { istDay } from '../005-profile-vault/support';
import { SPEC, collectRunArtifacts, evidence, expect, setProfile, signupViaApi, test, uploadFixtureViaApi, type BidFixture } from './support';

const STORY = 'US4';
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

// ---------- helpers ----------
const BID_NO: Record<string, string> = {
  'go-it-services': 'GEM/2026/B/6120451', 'review-hardware-oem': 'GEM/2026/B/6133872', 'nogo-experience': 'GEM/2026/B/6140019',
};
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const psql = (sql: string) => execFileSync('psql', [E2E_DB, '-tAqc', sql], { encoding: 'utf8' }).trim().split('\n')[0] ?? '';

interface TenderOpts { fixture?: string; endExpr?: string; status?: 'open' | 'closed' }
/** An open GeM-style tender without gem_bid_id / document_url; `endExpr` is a SQL expression (default now() + 20 days). */
function insertTender(o: TenderOpts = {}): { id: string } {
  const bid = BID_NO[o.fixture ?? ''] ?? `GEM/2026/B/${9_000_000 + Math.floor(Math.random() * 999_999)}`;
  const src = `qa-us4-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const sql = `insert into tenders (source,bid_number,title,category,state,source_url,content_hash,status,end_at) values (${sqlStr(src)},${sqlStr(bid)},'IT Helpdesk Support Services',null,'Maharashtra',${sqlStr(`https://example.invalid/${src}`)},${sqlStr(`${src}-h`)},${sqlStr(o.status ?? 'open')},${o.endExpr ?? `now() + interval '20 days'`}) returning id;`;
  return { id: psql(sql) };
}

async function analyseOk(r: APIRequestContext, tenderId: string): Promise<AnalysisDto> {
  const res = await r.post(`/api/tenders/${tenderId}/analyse`);
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}
const getAnalysis = async (r: APIRequestContext, tenderId: string): Promise<AnalysisDto> => {
  const res = await r.get(`/api/tenders/${tenderId}/analysis`);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};
const factor = (a: AnalysisDto, key: string): ScoreFactor => {
  const f = a.factors.find((x) => x.key === key);
  expect(f, `factor ${key}`).toBeTruthy();
  return f!;
};
const errOf = async (res: { text(): Promise<string>; status(): number }) => { const text = await res.text(); return { status: res.status(), ...(JSON.parse(text).error as { code: string; message: string }) }; };

/** US3 #5: weak profile + nogo-experience.pdf → No-Go 58. Returns the owner, the tender and the analysis. */
async function weakAnalysis(page: Page) {
  const user = await signupViaApi(page);
  const inc = istDay(0).replace(/^(\d{4})/, (y) => String(Number(y) - 3));
  await setProfile(page.request, { legalName: 'Weak Profile Traders', incorporationDate: inc, financials: [{ fy: '2024-25', turnover: 9_000_000 }], maxEmdCapacity: 100_000 });
  const t = insertTender({ fixture: 'nogo-experience' });
  await uploadFixtureViaApi(page.request, t.id, 'nogo-experience');
  const a = await analyseOk(page.request, t.id);
  return { user, t, a };
}
async function demoAnalysis(page: Page, fixture: BidFixture = 'go-it-services', opts: TenderOpts = {}) {
  const t = insertTender({ fixture, ...opts });
  await uploadFixtureViaApi(page.request, t.id, fixture);
  const a = await analyseOk(page.request, t.id);
  return { t, a };
}
const demoOrg = async (page: Page) => {
  const user = await signupViaApi(page);
  const seeded = await page.request.post('/api/demo/seed');
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  return user;
};
const openTender = async (page: Page, id: string, tab = '') => {
  await page.goto(`/tenders/${id}${tab}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
};

const rowOf = (page: Page, label: string) => page.locator('ul.divide-y > li').filter({ hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}`) }).first();
const overrideButton = (page: Page, label: string) => rowOf(page, label).getByRole('button', { name: /Override/ });
const toast = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
const ring = (page: Page, name: string) => page.getByRole('img', { name, exact: true });
const dialog = (page: Page) => page.getByRole('dialog');
const REASON = 'JV partner Acme Systems brings 6 years of CCTV AMC experience';
const BLOCKER = 'Hard blocker: Years of experience — a failed blocker means No-Go regardless of score.';

async function openDialog(page: Page, label = 'Years of experience') {
  await overrideButton(page, label).click();
  await expect(dialog(page).getByRole('heading', { name: `Override “${label}”` })).toBeVisible();
  return dialog(page);
}
/** Overrides experience to Pass through the dialog and waits for the 200. Returns the response body. */
async function overrideExperienceToPass(page: Page) {
  const dlg = await openDialog(page);
  await dlg.getByRole('textbox').fill(REASON);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/analyses\/[^/]+\/override$/.test(r.url())),
    dlg.getByRole('button', { name: 'Save override' }).click(),
  ]);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as AnalysisDto;
}

const WEIGHT_LABELS: [string, number][] = [
  ['Average annual turnover', 20], ['Years of experience', 18], ['Similar work value', 12], ['EMD (earnest money)', 10], ['Make in India', 6],
  ['OEM authorisation', 10], ['Certificates', 8], ['Documents in vault', 8], ['Delivery feasibility', 4], ['Time to bid closing', 4],
];
const slider = (page: Page, label: string) => page.getByRole('slider', { name: label, exact: true });
const saveBtn = (page: Page) => page.getByRole('button', { name: 'Save weights' });
const putWeights = (r: APIRequestContext, data: unknown) => r.put('/api/scoring-weights', { data: data as Record<string, unknown> });
const ALL_ZERO = Object.fromEntries(['turnover', 'experience', 'similarWork', 'emd', 'mii', 'oem', 'certificates', 'documents', 'deliveryFeasibility', 'timeToClose'].map((k) => [k, 0]));
const totalOf = (page: Page) => page.getByText('Total weight', { exact: true }).locator('xpath=following-sibling::span');

// ---------- criteria ----------

test('1 override dialog: title, computed status + detail, New status Pass preselected, required Reason (max 500) with audit hint @mobile', async ({ page }) => {
  const { t } = await weakAnalysis(page);
  await openTender(page, t.id);
  await expect(ring(page, 'Score 58 of 100, No-Go')).toBeVisible();
  const dlg = await openDialog(page);
  await expect(dlg).toContainText('Computed:');
  await expect(dlg).toContainText('Fail');
  await expect(dlg).toContainText('You have 3 years of experience (based on your incorporation date — add past contracts as proof); the bid needs 5 years.');
  const group = dlg.getByRole('radiogroup', { name: 'New status' });
  for (const s of ['Pass', 'Exempt', 'Unknown', 'Fail', 'N/A']) await expect(group.getByRole('radio', { name: s, exact: true })).toBeVisible();
  await expect(group.getByRole('radio', { name: 'Pass', exact: true })).toBeChecked();
  await expect(group.getByRole('radio', { name: 'Fail', exact: true })).not.toBeChecked();
  const reason = dlg.getByRole('textbox');
  await expect(dlg.getByText('Reason', { exact: false }).first()).toBeVisible();
  await expect(reason).toHaveAttribute('maxlength', '500');
  await expect(dlg.getByText('Visible to your team in the activity log.')).toBeVisible();
  await ev(page, '01-override-dialog');
});

test('2 reason < 3 chars: field error "Give a short reason — it is kept in the audit log." and no request; API 400 validation_error', async ({ page }) => {
  const { t, a } = await weakAnalysis(page);
  await openTender(page, t.id);
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/override')) posts.push(r.url()); });
  const dlg = await openDialog(page);
  await dlg.getByRole('button', { name: 'Save override' }).click();
  await expect(dlg.getByText('Give a short reason — it is kept in the audit log.')).toBeVisible();
  await dlg.getByRole('textbox').fill('ab');
  await dlg.getByRole('button', { name: 'Save override' }).click();
  await expect(dlg.getByText('Give a short reason — it is kept in the audit log.')).toBeVisible();
  await ev(page, '02-reason-too-short');
  expect(posts, 'no override request is sent for an empty / 2-character reason').toEqual([]);

  for (const reason of ['', 'ab', '  a  ']) {
    const res = await page.request.post(`/api/analyses/${a.id}/override`, { data: { factorKey: 'experience', status: 'pass', reason } });
    const e = await errOf(res);
    expect(e, `reason ${JSON.stringify(reason)}`).toMatchObject({ status: 400, code: 'validation_error' });
    expect(e.message).toContain('Give a short reason (at least 3 characters)');
  }
  const long = await page.request.post(`/api/analyses/${a.id}/override`, { data: { factorKey: 'experience', status: 'pass', reason: 'x'.repeat(501) } });
  expect((await errOf(long)).code).toBe('validation_error');
  expect((await getAnalysis(page.request, t.id)).score, 'rejected overrides change nothing').toBe(58);
});

test('3 experience → Pass on No-Go 58: 200, toast "Years of experience set to pass" / "New score 82/100 · Go", blocker gone, Overridden badge + who/when/why, "1 overridden" @mobile', async ({ page }) => {
  const { user, t } = await weakAnalysis(page);
  await openTender(page, t.id);
  await expect(ring(page, 'Score 58 of 100, No-Go')).toBeVisible();
  await expect(page.getByText(BLOCKER)).toBeVisible();
  const body = await overrideExperienceToPass(page);
  test.info().annotations.push({ type: 'override-response', description: `score=${body.score} verdict=${body.verdict} confidence=${body.confidence}` });

  await expect(toast(page, 'Years of experience set to pass')).toContainText('New score 82/100 · Go');
  await expect(page.getByText(BLOCKER)).toHaveCount(0);
  await expect(ring(page, 'Score 82 of 100, Go')).toBeVisible();
  const row = rowOf(page, 'Years of experience');
  await expect(row.getByText('Overridden', { exact: true })).toBeVisible();
  await expect(row).toContainText(`${user.name} set this to pass just now: “${REASON}”`);
  await expect(page.getByText('1 overridden')).toBeVisible();
  await row.getByText('Overridden', { exact: true }).hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'Originally fail' })).toContainText(`Originally fail — overridden by ${user.name}`);
  await ev(page, '03-override-applied-go-82');
});

test('4 History tab: "<name> overrode a factor" with "Years of experience: fail → pass — “reason”" (analysis.factor_overridden)', async ({ page }) => {
  const { user, t } = await weakAnalysis(page);
  await openTender(page, t.id);
  await overrideExperienceToPass(page);
  await expect(page.getByText('1 overridden')).toBeVisible();
  await page.getByRole('tab', { name: /History/ }).click();
  const entry = page.locator('li').filter({ hasText: `${user.name} overrode a factor` }).first();
  await expect(entry).toBeVisible();
  await expect(entry).toContainText(`Years of experience: fail → pass — “${REASON}”`);
  await ev(page, '04-history-factor-overridden');
});

test('5 choosing the computed status shows "Same as computed — this removes the override." and saving removes the override', async ({ page }) => {
  const { t } = await weakAnalysis(page);
  await openTender(page, t.id);
  await overrideExperienceToPass(page);
  await expect(ring(page, 'Score 82 of 100, Go')).toBeVisible();

  const dlg = await openDialog(page);
  const group = dlg.getByRole('radiogroup', { name: 'New status' });
  await group.getByRole('radio', { name: 'Pass', exact: true }).click();
  await expect(dlg.getByText('Same as computed — this removes the override.')).toHaveCount(0);
  await group.getByRole('radio', { name: 'Fail', exact: true }).click();
  await expect(dlg.getByText('Same as computed — this removes the override.')).toBeVisible();
  await dlg.getByRole('textbox').fill('Partner letter withdrawn');
  await ev(page, '05a-same-as-computed-note');
  await dlg.getByRole('button', { name: 'Save override' }).click();

  await expect(ring(page, 'Score 58 of 100, No-Go')).toBeVisible();
  await expect(rowOf(page, 'Years of experience').getByText('Overridden', { exact: true })).toHaveCount(0);
  await expect(page.getByText('1 overridden')).toHaveCount(0);
  await expect(page.getByText(BLOCKER)).toBeVisible();
  const a = await getAnalysis(page.request, t.id);
  expect(a.score).toBe(58);
  expect(factor(a, 'experience').overridden ?? null).toBeNull();
  await ev(page, '05b-override-removed-no-go-58');
});

test('6 override is re-applied after re-analysis while the computed status still differs', async ({ page }) => {
  const { t } = await weakAnalysis(page);
  await openTender(page, t.id);
  await overrideExperienceToPass(page);
  await expect(ring(page, 'Score 82 of 100, Go')).toBeVisible();

  const before = await getAnalysis(page.request, t.id);
  const re = await analyseOk(page.request, t.id);
  expect(re.id, 'a new analysis row').not.toBe(before.id);
  expect(factor(re, 'experience').status, 'computed status is still fail').toBe('fail');
  expect(factor(re, 'experience').overridden).toMatchObject({ status: 'pass', reason: REASON });
  expect(re.score).toBe(82);

  await page.reload();
  await expect(ring(page, 'Score 82 of 100, Go')).toBeVisible();
  await expect(rowOf(page, 'Years of experience').getByText('Overridden', { exact: true })).toBeVisible();
  await expect(page.getByText('1 overridden')).toBeVisible();
  await expect(page.getByText(BLOCKER)).toHaveCount(0);
  await ev(page, '06-override-survives-reanalysis');

  // ...but once the newly computed status equals the override (profile now shows 10 years), the override is dropped.
  const inc = istDay(0).replace(/^(\d{4})/, (y) => String(Number(y) - 10));
  await setProfile(page.request, { incorporationDate: inc });
  const third = await analyseOk(page.request, t.id);
  expect(factor(third, 'experience').status, 'computed status is now pass').toBe('pass');
  expect(factor(third, 'experience').overridden ?? null, 'override no longer differs, so it is not re-applied').toBeNull();
  await page.reload();
  await expect(rowOf(page, 'Years of experience').getByText('Overridden', { exact: true })).toHaveCount(0);
  await expect(page.getByText('1 overridden')).toHaveCount(0);
  await ev(page, '06b-override-dropped-when-computed-equals');
});

test('7 analyst: no Override buttons, API 403 forbidden; non-done analysis 409 conflict; unknown factor 400', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const { t, a } = await weakAnalysis(page);
  const analyst = await inviteAs(page.request, 'analyst');
  const ap = await analyst.newPage(browser);
  try {
    await ap.goto(`/tenders/${t.id}`);
    await expect(ring(ap, 'Score 58 of 100, No-Go')).toBeVisible();
    await expect(rowOf(ap, 'Years of experience')).toBeVisible();
    await expect(ap.getByRole('button', { name: /Override/ })).toHaveCount(0);
    await expect(ap.getByRole('button', { name: /Re-analyse/ }).first()).toBeVisible(); // the analyst can still re-analyse
    await evidence(ap, SPEC, STORY, `07a-analyst-no-override-buttons-${test.info().project.name}`);
    const res = await analyst.api.post(`/api/analyses/${a.id}/override`, { data: { factorKey: 'experience', status: 'pass', reason: REASON } });
    expect(await errOf(res)).toMatchObject({ status: 403, code: 'forbidden' });
  } finally { await ap.context().close(); }
  expect((await getAnalysis(page.request, t.id)).score, 'the 403 changed nothing').toBe(58);

  // unknown factor key → 400 validation_error
  const unknown = await page.request.post(`/api/analyses/${a.id}/override`, { data: { factorKey: 'nonsense', status: 'pass', reason: REASON } });
  expect(await errOf(unknown)).toMatchObject({ status: 400, code: 'validation_error' });
  const badStatus = await page.request.post(`/api/analyses/${a.id}/override`, { data: { factorKey: 'experience', status: 'maybe', reason: REASON } });
  expect((await errOf(badStatus)).status).toBe(400);

  // non-done analysis: a real failed run (malformed profile makes the scoring stage throw) leaves a `failed` row.
  const orgId = psql(`select org_id from analyses where id='${a.id}'`);
  const good = psql(`select financials::text from company_profiles where org_id='${orgId}'`);
  psql(`update company_profiles set financials='"broken"'::jsonb where org_id='${orgId}' returning 1`);
  let failStatus = 0;
  try { failStatus = (await page.request.post(`/api/tenders/${t.id}/analyse`)).status(); }
  finally { psql(`update company_profiles set financials=${sqlStr(good)}::jsonb where org_id='${orgId}' returning 1`); }
  expect(failStatus, 'the re-analysis was expected to fail').toBeGreaterThanOrEqual(500);
  const failedId = psql(`select id from analyses where tender_id='${t.id}' and status='failed' order by created_at desc limit 1`);
  expect(failedId, 'a failed analysis row exists').toBeTruthy();
  const conflict = await page.request.post(`/api/analyses/${failedId}/override`, { data: { factorKey: 'experience', status: 'pass', reason: REASON } });
  const e = await errOf(conflict);
  expect(e).toMatchObject({ status: 409, code: 'conflict' });
  expect(e.message).toBe('Only a completed analysis can be overridden');
  test.info().annotations.push({ type: '409-message', description: e.message });
  await openTender(page, t.id);
  await expect(overrideButton(page, 'Years of experience')).toBeVisible();
  await ev(page, '07b-owner-sees-override-after-failed-attempt');
});

test('8 Settings → Scoring weights: ten sliders with defaults 20/18/12/10/6/10/8/8/4/4, "Total weight 100", "N · P% of score", "Default weights" badge @mobile', async ({ page }) => {
  await signupViaApi(page);
  await page.goto('/settings/scoring');
  await expect(page.getByText('Total weight', { exact: true })).toBeVisible();
  await expect(page.getByText('Default weights', { exact: true })).toBeVisible();
  await expect(page.getByRole('slider')).toHaveCount(10);
  for (const [label, n] of WEIGHT_LABELS) {
    const s = slider(page, label);
    await expect(s, label).toHaveValue(String(n));
    await expect(s).toBeEnabled();
  }
  // shares: weights sum to 100, so each share equals the weight
  for (const n of new Set(WEIGHT_LABELS.map(([, v]) => v))) await expect(page.getByText(`${n} · ${n}% of score`, { exact: true }).first()).toBeVisible();
  await expect(totalOf(page)).toHaveText('100');
  await expect(page.getByText(/^Default \d+\.$/)).toHaveCount(0);
  await expect(page.getByText('Your average turnover vs the bid’s minimum')).toBeVisible(); // help text
  await expect(saveBtn(page)).toBeDisabled();
  const got = await (await page.request.get('/api/scoring-weights')).json();
  expect(got.custom).toBe(false);
  await ev(page, '08-weights-defaults');
});

test('9 EMD → 30 and Save: PUT 200 {custom:true}, toast "Scoring weights saved", badge "Custom weights", hint "Default 10."; next analysis EMD "Weight 30"', async ({ page }) => {
  await demoOrg(page);
  await page.goto('/settings/scoring');
  await expect(page.getByText('Default weights', { exact: true })).toBeVisible();
  await slider(page, 'EMD (earnest money)').fill('30');
  await expect(slider(page, 'EMD (earnest money)')).toHaveValue('30');
  await expect(totalOf(page)).toHaveText('120');
  await expect(page.getByText('30 · 25% of score', { exact: true })).toBeVisible();
  await expect(page.getByText('Default 10.', { exact: true })).toBeVisible();
  await ev(page, '09a-emd-30-before-save');
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/api/scoring-weights')),
    saveBtn(page).click(),
  ]);
  expect(res.status(), await res.text()).toBe(200);
  expect(res.request().postDataJSON()).toMatchObject({ emd: 30 });
  const body = await res.json();
  expect(body.custom).toBe(true);
  expect(body.weights.emd).toBe(30);
  await expect(toast(page, 'Scoring weights saved')).toContainText('New analyses use them; open a tender and Re-score to update an existing result.');
  await expect(page.getByText('Custom weights', { exact: true })).toBeVisible();
  await expect(page.getByText('Default weights', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Default 10.')).toBeVisible();
  await ev(page, '09b-saved-custom-weights');

  const { t, a } = await demoAnalysis(page);
  expect(factor(a, 'emd').weight).toBe(30);
  await openTender(page, t.id);
  await expect(rowOf(page, 'EMD (earnest money)').getByText('Weight 30', { exact: true })).toBeVisible();
  await rowOf(page, 'EMD (earnest money)').scrollIntoViewIfNeeded();
  await ev(page, '09c-next-analysis-emd-weight-30');
});

test('10 Reset to default then Save sends {} and returns {custom:false} with defaults', async ({ page }) => {
  await signupViaApi(page);
  expect((await putWeights(page.request, { emd: 30 })).status()).toBe(200);
  await page.goto('/settings/scoring');
  await expect(page.getByText('Custom weights', { exact: true })).toBeVisible();
  await expect(slider(page, 'EMD (earnest money)')).toHaveValue('30');
  await page.getByRole('button', { name: 'Reset to default' }).click();
  await expect(slider(page, 'EMD (earnest money)')).toHaveValue('10');
  await ev(page, '10a-reset-before-save');
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/api/scoring-weights')),
    saveBtn(page).click(),
  ]);
  expect(res.status(), await res.text()).toBe(200);
  expect(res.request().postDataJSON()).toEqual({});
  const body = await res.json();
  expect(body.custom).toBe(false);
  expect(body.weights).toEqual(body.defaults);
  await expect(page.getByText('Default weights', { exact: true })).toBeVisible();
  await expect(toast(page, 'Scoring weights saved')).toBeVisible();
  await ev(page, '10b-saved-defaults');
});

test('11 all sliders 0: "Total weight 0" in red, Save disabled; API 400 for all-zero ("At least one weight must be above 0"), unknown key and 101 @mobile', async ({ page }) => {
  await signupViaApi(page);
  await page.goto('/settings/scoring');
  await expect(page.getByRole('slider')).toHaveCount(10);
  for (const [label] of WEIGHT_LABELS) await slider(page, label).fill('0');
  const total = totalOf(page);
  await expect(total).toHaveText('0');
  await expect(total).toHaveClass(/text-danger/);
  const color = await total.evaluate((el) => getComputedStyle(el).color);
  test.info().annotations.push({ type: 'total-0-colour', description: color });
  await expect(saveBtn(page)).toBeDisabled();
  await ev(page, '11-all-zero-save-disabled');

  const zero = await errOf(await putWeights(page.request, ALL_ZERO));
  expect(zero).toMatchObject({ status: 400, code: 'validation_error' });
  expect(zero.message).toContain('At least one weight must be above 0');
  expect(await errOf(await putWeights(page.request, { bogus: 5 }))).toMatchObject({ status: 400, code: 'validation_error' });
  expect(await errOf(await putWeights(page.request, { emd: 101 }))).toMatchObject({ status: 400, code: 'validation_error' });
  expect(await errOf(await putWeights(page.request, { emd: -1 }))).toMatchObject({ status: 400, code: 'validation_error' });
  const still = await (await page.request.get('/api/scoring-weights')).json();
  expect(still.custom, 'rejected bodies saved nothing').toBe(false);
});

test('12 analyst and viewer: sliders disabled, footer "Only Bid Managers and Owners can change scoring weights."; PUT 403 @mobile', async ({ page, browser }) => {
  await signupViaApi(page);
  expect((await putWeights(page.request, { emd: 30 })).status()).toBe(200);
  for (const role of ['analyst', 'viewer'] as const) {
    const member = await inviteAs(page.request, role);
    const mp = await member.newPage(browser);
    try {
      await mp.goto('/settings/scoring');
      await expect(mp.getByRole('slider')).toHaveCount(10);
      for (const s of await mp.getByRole('slider').all()) await expect(s).toBeDisabled();
      await expect(mp.getByText('Only Bid Managers and Owners can change scoring weights.')).toBeVisible();
      await expect(mp.getByRole('button', { name: 'Save weights' })).toHaveCount(0);
      await expect(mp.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);
      await expect(mp.getByText('Custom weights', { exact: true })).toBeVisible(); // can read the org's weights
      await evidence(mp, SPEC, STORY, `12-${role}-weights-read-only-${test.info().project.name}`);
      const res = await member.api.put('/api/scoring-weights', { data: { emd: 5 } });
      expect(await errOf(res), role).toMatchObject({ status: 403, code: 'forbidden' });
      expect((await member.api.get('/api/scoring-weights')).status(), `${role} may read`).toBe(200);
    } finally { await mp.context().close(); }
  }
  expect((await (await page.request.get('/api/scoring-weights')).json()).weights.emd, 'weights unchanged').toBe(30);
});

test('13 weights change → stale banner "Scoring weights changed since this analysis…" + Re-score (POST /analyses/:id/rescore 200); document staleness → rescore 409 reanalysis_required; weights save leaves closed tenders alone @mobile', async ({ page }) => {
  test.setTimeout(150_000);
  await demoOrg(page);
  const open = await demoAnalysis(page);
  const withDoc = await demoAnalysis(page);
  const closed = await demoAnalysis(page, 'go-it-services', { endExpr: `now() + interval '2 days'` });
  psql(`update tenders set status='closed', end_at = now() - interval '1 day' where id='${closed.t.id}' returning 1`);

  // document staleness on one tender (needs a full re-analysis)
  await uploadFixtureViaApi(page.request, withDoc.t.id, 'go-it-services', 'corrigendum');
  const afterDoc = await getAnalysis(page.request, withDoc.t.id);
  expect(afterDoc.stale).toBe(true);
  expect(afterDoc.staleReason).toBe('document_added');

  // now change the weights (API; the UI save is criterion 9)
  expect((await putWeights(page.request, { emd: 30 })).status()).toBe(200);
  const a1 = await getAnalysis(page.request, open.t.id);
  expect(a1.stale).toBe(true);
  expect(a1.staleReason).toBe('weights_changed');
  expect((await getAnalysis(page.request, closed.t.id)).stale, 'closed tender untouched by a weights save').toBe(false);
  expect((await getAnalysis(page.request, withDoc.t.id)).staleReason, 'document staleness is not overwritten').toBe('document_added');

  await openTender(page, open.t.id);
  const banner = page.getByRole('status').filter({ hasText: 'Re-analysis needed' });
  await expect(banner).toContainText('Scoring weights changed since this analysis. Re-score to update the score.');
  await expect(page.getByText('Outdated', { exact: true })).toBeVisible();
  await ev(page, '13a-stale-weights-banner');
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/analyses/${open.a.id}/rescore`)),
    banner.getByRole('button', { name: 'Re-score' }).click(),
  ]);
  expect(res.status(), await res.text()).toBe(200);
  await expect(toast(page, /^Re-scored · \d+\/100/)).toContainText('Updated with your current profile, vault and weights.');
  await expect(page.getByRole('status').filter({ hasText: 'Re-analysis needed' })).toHaveCount(0);
  await expect(page.getByText('Outdated', { exact: true })).toHaveCount(0);
  const a2 = await getAnalysis(page.request, open.t.id);
  expect(a2.stale).toBe(false);
  expect(factor(a2, 'emd').weight).toBe(30);
  await ev(page, '13b-rescored');

  // document-stale tender: rescore refuses; the UI offers a full re-analysis instead
  const refused = await errOf(await page.request.post(`/api/analyses/${withDoc.a.id}/rescore`));
  expect(refused).toMatchObject({ status: 409, code: 'reanalysis_required' });
  test.info().annotations.push({ type: 'reanalysis_required-message', description: refused.message });
  await openTender(page, withDoc.t.id);
  const b2 = page.getByRole('status').filter({ hasText: 'Re-analysis needed' });
  await expect(b2).toContainText('A document was added since this analysis. Re-analyse to include it.');
  await expect(b2.getByRole('button', { name: 'Re-analyse now' })).toBeVisible();
  await expect(b2.getByRole('button', { name: 'Re-score' })).toHaveCount(0);
  await ev(page, '13c-document-stale-needs-reanalysis');
});

test('14 slider range 0–100 matches the API: a value set via API (80, 100, 0) is displayed and editable without clamping', async ({ page }) => {
  await signupViaApi(page);
  expect((await putWeights(page.request, { emd: 80, mii: 100, timeToClose: 0 })).status()).toBe(200);
  await page.goto('/settings/scoring');
  const emd = slider(page, 'EMD (earnest money)');
  await expect(emd).toHaveAttribute('min', '0');
  await expect(emd).toHaveAttribute('max', '100');
  await expect(emd).toHaveValue('80');
  await expect(slider(page, 'Make in India')).toHaveValue('100');
  await expect(slider(page, 'Time to bid closing')).toHaveValue('0');
  await emd.focus();
  await page.keyboard.press('ArrowRight');
  await expect(emd).toHaveValue('81');
  await emd.fill('100');
  await expect(emd).toHaveValue('100');
  await emd.fill('0');
  await expect(emd).toHaveValue('0');
  await emd.fill('80');
  await ev(page, '14-slider-80-100-0-unclamped');
  const got = await (await page.request.get('/api/scoring-weights')).json();
  expect(got.weights).toMatchObject({ emd: 80, mii: 100, timeToClose: 0 });
});
