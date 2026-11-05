/**
 * QA acceptance for spec 004 / US6 (#172): staleness (corrigendum, profile/vault changes) and re-analysis (FR-041..046).
 * One test per acceptance criterion (numbering = the issue's criteria). Rules-only (no LLM key).
 * Screenshots/videos land in qa/evidence/004/US6/ (the dev-*.png files there are the developer's and stay).
 *
 * Mock-gem tenders (openTargetTender) are used for the corrigendum flow: analyse -> POST /__admin/corrigendum -> sync
 * (POST /api/ingestion/run, the endpoint behind "Sync now"; its 15-minute manual cooldown is aged in SQL between runs).
 * Company-side changes use SQL-inserted open tenders so they do not depend on the shared GeM state.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import type { AnalysisDto } from '../../packages/core/src/contracts/analyse';
import { GEM_URL, inviteAs } from '../support/fixtures';
import { SPEC, collectRunArtifacts, evidence, expect, fixturePath, mockGem, openTargetTender, signupViaApi, test, uploadFixtureViaApi, type TargetTender } from './support';

const STORY = 'US6';
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

// ---------- helpers ----------
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const psql = (sql: string) => execFileSync('psql', [E2E_DB, '-tAqc', sql], { encoding: 'utf8' }).trim().split('\n')[0] ?? '';

/** An open tender without a GeM link (end = now + 20 days) carrying the go-it-services PDF's bid number. */
function insertTender(status: 'open' | 'closed' = 'open'): { id: string; bidNumber: string } {
  const bid = 'GEM/2026/B/6120451';
  const src = `qa-us6-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const sql = `insert into tenders (source,bid_number,title,category,state,source_url,content_hash,status,end_at) values (${sqlStr(src)},${sqlStr(bid)},'IT Helpdesk Support Services',null,'Maharashtra',${sqlStr(`https://example.invalid/${src}`)},${sqlStr(`${src}-h`)},${sqlStr(status)},now() + interval '20 days') returning id;`;
  return { id: psql(sql), bidNumber: bid };
}
async function analyseOk(r: APIRequestContext, tenderId: string): Promise<AnalysisDto> {
  const res = await r.post(`/api/tenders/${tenderId}/analyse`);
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}
async function getAnalysis(r: APIRequestContext, tenderId: string): Promise<AnalysisDto> {
  const res = await r.get(`/api/tenders/${tenderId}/analysis`);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
/** Manual sync via the API behind "Sync now"; ages earlier manual runs so the cooldown never blocks QA. */
async function syncNow(r: APIRequestContext) {
  for (let i = 0; i < 20; i++) {
    psql(`update ingestion_runs set finished_at = finished_at - interval '2 hours' where trigger = 'manual'`);
    const res = await r.post('/api/ingestion/run', { data: { pages: 3 } });
    if (res.status() === 409) { await new Promise((ok) => setTimeout(ok, 1000)); continue; }
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  }
  throw new Error('sync kept answering 409');
}
const corrigendum = (r: APIRequestContext, bidNumber: string, days = 7) => mockGem(r, `/__admin/corrigendum/${encodeURIComponent(bidNumber)}`, { days });
async function staleViaCorrigendum(page: Page) {
  const t = await openTargetTender(page);
  const before = await analyseOk(page.request, t.id);
  await corrigendum(page.request, t.bidNumber);
  await syncNow(page.request);
  return { t, before };
}
const banner = (page: Page) => page.getByRole('status').filter({ hasText: 'Re-analysis needed' });
const openTenderPage = async (page: Page, id: string, tab?: string) => {
  await page.goto(`/tenders/${id}${tab ? `?tab=${tab}` : ''}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
};
const closesIn = (a: AnalysisDto) => Number(/Closes in (\d+) days?/.exec(a.factors.find((f) => f.key === 'timeToClose')?.detail ?? '')?.[1] ?? NaN);
const CORRIGENDUM_COPY = 'A corrigendum changed this bid after it was analysed. The score below may be outdated.';
async function newOrgContext(browser: Browser) {
  const use = test.info().project.use;
  const ctx = await browser.newContext({ baseURL: use.baseURL, viewport: use.viewport ?? { width: 1440, height: 900 }, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  const page = await ctx.newPage();
  await signupViaApi(page);
  return { ctx, page };
}

// ---------- criteria ----------

test('1 corrigendum +7 days and sync: analysis stale:true, corrigendum event, banner role=status "Re-analysis needed" with corrigendum copy and Re-analyse now @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = await openTargetTender(page);
  const before = await analyseOk(page.request, t.id);
  expect(before.stale).toBe(false);
  const fresh = await getAnalysis(page.request, t.id);
  expect(fresh.stale).toBe(false);
  await corrigendum(page.request, t.bidNumber);
  await syncNow(page.request);
  const a = await getAnalysis(page.request, t.id);
  expect(a).toMatchObject({ stale: true, staleReason: 'corrigendum' });
  const tender = await (await page.request.get(`/api/tenders/${t.id}`)).json();
  const ev1 = (tender.events as { kind: string; changes: Record<string, { from: string; to: string }> }[]).filter((e) => e.kind === 'corrigendum');
  expect(ev1.length).toBeGreaterThan(0);
  test.info().annotations.push({ type: 'corrigendum-event', description: JSON.stringify(ev1[0]) });
  await openTenderPage(page, t.id);
  const b = banner(page);
  await expect(b).toBeVisible();
  await expect(b).toContainText(CORRIGENDUM_COPY);
  await expect(b.getByRole('button', { name: 'Re-analyse now' })).toBeVisible();
  await ev(page, '01-corrigendum-stale-banner');
});

test('2 stale analysis: "Outdated" badge, feed "Re-check" + tooltip, History "Corrigendum issued" + "Re-check eligibility" + old→new end date, History tab dot @mobile', async ({ page }) => {
  await signupViaApi(page);
  const { t } = await staleViaCorrigendum(page);
  // Isolation: the mock tender is shared with other tests (each adds a corrigendum event); keep only the event this
  // test just caused, so the History assertions below are not ambiguous.
  psql(`delete from tender_events where tender_id = ${sqlStr(t.id)} and kind = 'corrigendum' and id <> (select id from tender_events where tender_id = ${sqlStr(t.id)} and kind = 'corrigendum' order by created_at desc limit 1)`);
  await openTenderPage(page, t.id);
  await expect(page.getByText('Outdated', { exact: true })).toBeVisible();
  await ev(page, '02a-outdated-badge');
  // feed card
  await page.goto(`/tenders?q=${encodeURIComponent(t.bidNumber)}`);
  const card = page.locator('article').filter({ hasText: t.bidNumber }).first();
  await expect(card).toBeVisible();
  const recheck = card.getByText('Re-check', { exact: true });
  await expect(recheck).toBeVisible();
  await recheck.hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'A corrigendum changed this bid after it was scored — re-run the analysis.' })).toBeVisible();
  await ev(page, '02b-feed-recheck-tooltip');
  // history tab
  await openTenderPage(page, t.id);
  await expect(page.getByRole('tab', { name: /History/ }).locator('[aria-label="corrigendum"]')).toBeVisible();
  await page.getByRole('tab', { name: /History/ }).click();
  await expect(page.getByText('Corrigendum issued')).toBeVisible();
  await expect(page.getByText('Re-check eligibility')).toBeVisible();
  const dt = page.locator('dt').filter({ hasText: /^(Bid end date|Closing date):$/ }).first();
  await expect(dt).toBeVisible();
  const row = dt.locator('xpath=..');
  const label = (await dt.textContent())!.trim();
  const old = (await row.locator('span.line-through').textContent())!.trim();
  const neu = (await row.locator('span.font-medium').textContent())!.trim();
  expect(old).not.toBe(neu);
  test.info().annotations.push({ type: 'end-date-row', description: `${label} ${old} → ${neu}` });
  await ev(page, '02c-history-corrigendum');
});

test('3 Re-analyse now creates stale:false analysis; banner and badges gone; time-to-close uses the new end date @mobile', async ({ page }) => {
  await signupViaApi(page);
  const { t, before } = await staleViaCorrigendum(page);
  await openTenderPage(page, t.id);
  await expect(banner(page)).toBeVisible();
  await ev(page, '03a-before-reanalyse');
  const done = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/tenders/${t.id}/analyse`));
  await banner(page).getByRole('button', { name: 'Re-analyse now' }).click();
  expect((await done).status()).toBe(201);
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByText('Outdated', { exact: true })).toHaveCount(0);
  const a = await getAnalysis(page.request, t.id);
  expect(a.stale).toBe(false);
  expect(a.id).not.toBe(before.id);
  const dBefore = closesIn(before), dAfter = closesIn(a);
  test.info().annotations.push({ type: 'time-to-close', description: `before: "${before.factors.find((f) => f.key === 'timeToClose')?.detail}" after: "${a.factors.find((f) => f.key === 'timeToClose')?.detail}"` });
  expect(dAfter, `closes in ${dBefore} -> ${dAfter} days`).toBeGreaterThanOrEqual(dBefore + 6);
  await page.goto(`/tenders?q=${encodeURIComponent(t.bidNumber)}`);
  await expect(page.locator('article').filter({ hasText: t.bidNumber }).first()).toBeVisible();
  await expect(page.getByText('Re-check', { exact: true })).toHaveCount(0);
  await openTenderPage(page, t.id);
  await expect(page.getByText(`Closes in ${dAfter} days`).first()).toBeVisible();
  await ev(page, '03b-after-reanalyse');
});

test('4 a viewer on a stale analysis sees the banner without the button @mobile', async ({ page, browser }) => {
  await signupViaApi(page);
  const { t } = await staleViaCorrigendum(page);
  const viewer = await inviteAs(page.request, 'viewer');
  const vp = await viewer.newPage(browser);
  try {
    await openTenderPage(vp, t.id);
    await expect(banner(vp)).toBeVisible();
    await expect(banner(vp)).toContainText(CORRIGENDUM_COPY);
    await expect(vp.getByRole('button', { name: /Re-analyse now|Re-score/ })).toHaveCount(0);
    await ev(vp, '04-viewer-banner-no-button');
  } finally { await vp.context().close(); }
});

test('5 both orgs\' analyses become stale; re-analysis by org A leaves org B stale', async ({ page, browser }) => {
  await signupViaApi(page);
  const t = await openTargetTender(page);
  await analyseOk(page.request, t.id);
  const b = await newOrgContext(browser);
  try {
    await analyseOk(b.page.request, t.id);
    await corrigendum(page.request, t.bidNumber);
    await syncNow(page.request);
    expect((await getAnalysis(page.request, t.id)).stale).toBe(true);
    expect((await getAnalysis(b.page.request, t.id)).stale).toBe(true);
    await openTenderPage(page, t.id);
    await expect(banner(page)).toBeVisible();
    await ev(page, '05a-org-a-stale');
    await openTenderPage(b.page, t.id);
    await expect(banner(b.page)).toBeVisible();
    await ev(b.page, '05b-org-b-stale');
    // org A re-analyses
    await banner(page).getByRole('button', { name: 'Re-analyse now' }).click();
    await expect.poll(async () => (await getAnalysis(page.request, t.id)).stale).toBe(false);
    await expect(banner(page)).toHaveCount(0);
    expect((await getAnalysis(page.request, t.id)).stale).toBe(false);
    expect((await getAnalysis(b.page.request, t.id)).stale).toBe(true);
    await ev(page, '05c-org-a-fresh');
    await openTenderPage(b.page, t.id);
    await expect(banner(b.page)).toBeVisible();
    await expect(b.page.getByText('Outdated', { exact: true })).toBeVisible();
    await ev(b.page, '05d-org-b-still-stale');
  } finally { await b.ctx.close(); }
});

test('6 (gap) profile / past-contract / vault change marks the org\'s open-tender analyses stale with reason-specific copy; other orgs untouched @mobile', async ({ page, browser }) => {
  await signupViaApi(page);
  const t = insertTender();
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  await analyseOk(page.request, t.id);
  const other = await newOrgContext(browser);
  try {
    await uploadFixtureViaApi(other.page.request, t.id, 'go-it-services');
    await analyseOk(other.page.request, t.id);

    // profile
    const put = await page.request.put('/api/profile', { data: { legalName: 'Stale Traders Pvt Ltd' } });
    expect(put.ok(), await put.text()).toBeTruthy();
    expect(await getAnalysis(page.request, t.id)).toMatchObject({ stale: true, staleReason: 'profile_changed' });
    expect((await getAnalysis(other.page.request, t.id)).stale).toBe(false);
    await openTenderPage(page, t.id);
    await expect(banner(page)).toContainText('Your company profile changed since this analysis. Re-score to update the score.');
    await expect(banner(page).getByRole('button', { name: 'Re-score' })).toBeVisible();
    await expect(banner(page).getByRole('button', { name: 'Re-analyse now' })).toHaveCount(0);
    await ev(page, '06a-profile-changed');

    // re-score clears, then a past contract
    await banner(page).getByRole('button', { name: 'Re-score' }).click();
    await expect.poll(async () => (await getAnalysis(page.request, t.id)).stale).toBe(false);
    await expect(banner(page)).toHaveCount(0);
    expect((await getAnalysis(page.request, t.id)).stale).toBe(false);
    const pc = await page.request.post('/api/past-contracts', { data: { buyer: 'IOCL', title: 'Helpdesk support', value: 5_000_000 } });
    expect(pc.status(), await pc.text()).toBe(201);
    expect(await getAnalysis(page.request, t.id)).toMatchObject({ stale: true, staleReason: 'profile_changed' });
    await openTenderPage(page, t.id);
    await expect(banner(page)).toContainText('Your company profile changed since this analysis.');
    await ev(page, '06b-past-contract-added');

    // re-score, then a vault document
    await banner(page).getByRole('button', { name: 'Re-score' }).click();
    await expect.poll(async () => (await getAnalysis(page.request, t.id)).stale).toBe(false);
    await expect(banner(page)).toHaveCount(0);
    const up = await page.request.post('/api/vault', { multipart: { type: 'gst', title: 'GST certificate', file: { name: 'gst.pdf', mimeType: 'application/pdf', buffer: readFileSync(fixturePath('go-it-services')) } } });
    expect(up.status(), await up.text()).toBe(201);
    expect(await getAnalysis(page.request, t.id)).toMatchObject({ stale: true, staleReason: 'vault_changed' });
    expect((await getAnalysis(other.page.request, t.id)).stale).toBe(false);
    await openTenderPage(page, t.id);
    await expect(banner(page)).toContainText('Your document vault changed since this analysis. Re-score to update the score.');
    await expect(banner(page).getByRole('button', { name: 'Re-score' })).toBeVisible();
    await ev(page, '06c-vault-changed');
    await openTenderPage(other.page, t.id);
    await expect(banner(other.page)).toHaveCount(0);
    await ev(other.page, '06d-other-org-untouched');
  } finally { await other.ctx.close(); }
});

test('6b closed tenders are not made stale by profile / vault changes', async ({ page }) => {
  await signupViaApi(page);
  const open = insertTender();
  const closed = insertTender();
  for (const t of [open, closed]) { await uploadFixtureViaApi(page.request, t.id, 'go-it-services'); await analyseOk(page.request, t.id); }
  psql(`update tenders set status = 'closed', end_at = now() - interval '1 day' where id = ${sqlStr(closed.id)}`);
  expect((await page.request.put('/api/profile', { data: { legalName: 'Closed Check Traders' } })).ok()).toBeTruthy();
  const up = await page.request.post('/api/vault', { multipart: { type: 'pan', title: 'PAN', file: { name: 'pan.pdf', mimeType: 'application/pdf', buffer: readFileSync(fixturePath('go-it-services')) } } });
  expect(up.status(), await up.text()).toBe(201);
  expect(await getAnalysis(page.request, open.id)).toMatchObject({ stale: true });
  expect(await getAnalysis(page.request, closed.id)).toMatchObject({ stale: false, staleReason: null });
  await openTenderPage(page, closed.id);
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByText('Outdated', { exact: true })).toHaveCount(0);
  await ev(page, '06e-closed-tender-not-stale');
});

test('7 (gap) API exposes staleReason/staleAt; banner shows "since <time>" @mobile', async ({ page }) => {
  await signupViaApi(page);
  const t = insertTender();
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  await analyseOk(page.request, t.id);
  expect((await page.request.put('/api/profile', { data: { legalName: 'Since Traders' } })).ok()).toBeTruthy();
  const a = await getAnalysis(page.request, t.id);
  expect(a.staleReason).toBe('profile_changed');
  expect(Date.parse(a.staleAt!)).toBeGreaterThan(Date.now() - 120_000);
  await openTenderPage(page, t.id);
  await expect(banner(page)).toContainText(/Re-analysis needed\s*·\s*since (just now|\d+ (seconds?|minutes?) ago)/);
  await ev(page, '07a-since-just-now');
  psql(`update analyses set stale_at = now() - interval '2 hours' where tender_id = ${sqlStr(t.id)} and stale`);
  const aged = await getAnalysis(page.request, t.id);
  expect(Date.parse(aged.staleAt!)).toBeLessThan(Date.now() - 3_600_000);
  await openTenderPage(page, t.id);
  await expect(banner(page)).toContainText(/Re-analysis needed\s*·\s*since 2 hours ago/);
  await ev(page, '07b-since-2-hours-ago');
});

test('8 (gap) corrigendum with changed documentUrl: re-analyse fetches the new GeM document as Corrigendum and keeps the old', async ({ page }) => {
  await signupViaApi(page);
  const t = await openTargetTender(page);
  const first = await analyseOk(page.request, t.id);
  const gemDocs = async () => ((await (await page.request.get(`/api/tenders/${t.id}/documents`)).json()).items as { kind: string; source: string }[]).filter((d) => d.source === 'gem').map((d) => d.kind);
  expect(first.documents?.map((d) => d.kind)).toEqual(['bid']);
  expect(await gemDocs()).toEqual(['bid']);
  const state = await (await page.request.get(`${GEM_URL}/__admin/state`)).json() as { bids: { id: string | number }[] };
  const row = psql(`select gem_bid_id from tenders where id = ${sqlStr(t.id)}`);
  const other = state.bids.map((b) => String(b.id)).find((id) => id !== row)!;
  const newUrl = `${GEM_URL}/showbidDocument/${other}`;
  // mock-gem's /__admin/corrigendum only moves end date / quantity, so the documentUrl corrigendum is written like ingestion
  // writes it: the tender's document_url + a corrigendum tender_events row (same as the developer evidence).
  psql(`select pg_sleep(1.1)`);
  psql(`update tenders set document_url = ${sqlStr(newUrl)} where id = ${sqlStr(t.id)}`);
  psql(`insert into tender_events (tender_id, kind, changes) values (${sqlStr(t.id)}, 'corrigendum', ${sqlStr(JSON.stringify({ documentUrl: { from: null, to: newUrl } }))}::jsonb)`);
  psql(`update analyses set stale = true, stale_reason = 'corrigendum', stale_at = now() where tender_id = ${sqlStr(t.id)}`);
  await openTenderPage(page, t.id);
  await expect(banner(page)).toBeVisible();
  await page.getByRole('tab', { name: /Documents/ }).click();
  // Opening the tab may already trigger the GeM fetch (UI auto-fetch); record what the API holds at this point.
  await expect(page.getByText('From GeM').first()).toBeVisible();
  test.info().annotations.push({ type: 'gem-docs-on-tab-open', description: JSON.stringify(await gemDocs()) });
  await ev(page, '08a-documents-tab-after-corrigendum');
  await page.getByRole('tab', { name: 'Analysis' }).click();
  const done = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/tenders/${t.id}/analyse`));
  await banner(page).getByRole('button', { name: 'Re-analyse now' }).click();
  expect((await done).status()).toBe(201);
  await expect(banner(page)).toHaveCount(0);
  const a = await getAnalysis(page.request, t.id);
  expect(a.stale).toBe(false);
  expect(a.documents?.map((d) => d.kind)).toEqual(['bid', 'corrigendum']);
  expect(await gemDocs()).toEqual(['bid', 'corrigendum']);
  await page.getByRole('tab', { name: /Documents/ }).click();
  await expect(page.getByText('From GeM')).toHaveCount(2);
  const list = page.locator('li').filter({ hasText: 'From GeM' });
  await expect(list.filter({ hasText: 'Corrigendum' })).toHaveCount(1);
  await expect(list.filter({ hasText: 'Bid document' })).toHaveCount(1);
  await ev(page, '08b-two-gem-documents-corrigendum');
});

test('9 a change during a running analysis completes stale: API-test citation only (apps/api/test/staleness.test.ts + ingest.test.ts FR-045); UI shows a fresh analysis has no banner', async ({ page }) => {
  // Not reachable from the UI deterministically (the run takes well under a second); cited, see VERDICT.md.
  await signupViaApi(page);
  const t = insertTender();
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  const a = await analyseOk(page.request, t.id);
  expect(a.stale).toBe(false);
  await openTenderPage(page, t.id);
  await expect(banner(page)).toHaveCount(0);
  await ev(page, '09-fresh-analysis-no-banner');
});
