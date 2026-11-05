/**
 * QA acceptance for spec 004 / US5 (#171): required-documents checklist + vault readiness chips (FR-038..040).
 * One test per acceptance criterion (numbering = the issue's criteria); rules-only (no LLM key configured).
 * Screenshots/videos land in qa/evidence/004/US5/ (the dev-*.png files there are the developer's and stay).
 *
 * Determinism: tenders are inserted with SQL (no GeM link, own `source`, the bid number printed in the PDF) so the
 * shared GeM-document store cannot change the checklist (same pattern as US3/US4). The demo company comes from
 * `POST /api/demo/seed`.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import type { AnalysisDto } from '../../packages/core/src/contracts/analyse';
import { SPEC, collectRunArtifacts, evidence, expect, setProfile, signupViaApi, test, uploadFixtureViaApi, type BidFixture } from './support';

const STORY = 'US5';
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

// ---------- helpers ----------
const BID_NO: Record<string, string> = {
  'go-it-services': 'GEM/2026/B/6120451', 'review-hardware-oem': 'GEM/2026/B/6133872', 'nogo-experience': 'GEM/2026/B/6140019',
};
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const psql = (sql: string) => execFileSync('psql', [E2E_DB, '-tAqc', sql], { encoding: 'utf8' }).trim().split('\n')[0] ?? '';

/** An open GeM-style tender without gem_bid_id / document_url (end = now + 20 days). */
function insertTender(o: { fixture?: string; bidNumber?: string } = {}): { id: string; bidNumber: string } {
  const bid = o.bidNumber ?? BID_NO[o.fixture ?? ''] ?? `GEM/2026/B/${9_000_000 + Math.floor(Math.random() * 999_999)}`;
  const src = `qa-us5-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const sql = `insert into tenders (source,bid_number,title,category,state,source_url,content_hash,status,end_at) values (${sqlStr(src)},${sqlStr(bid)},'IT Helpdesk Support Services',null,'Maharashtra',${sqlStr(`https://example.invalid/${src}`)},${sqlStr(`${src}-h`)},'open',now() + interval '20 days') returning id;`;
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
async function analysedTender(page: Page, fixture: BidFixture) {
  const t = insertTender({ fixture });
  await uploadFixtureViaApi(page.request, t.id, fixture);
  const a = await analyseOk(page.request, t.id);
  return { t, a };
}
const openTender = async (page: Page, id: string) => {
  await page.goto(`/tenders/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
};
async function textPdf(lines: string[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = createRequire(join(process.cwd(), 'packages/core/package.json'))('pdf-lib') as typeof import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  lines.forEach((l, i) => page.drawText(l, { x: 40, y: 790 - i * 18, size: 10, font }));
  return Buffer.from(await doc.save());
}

/** The "Required documents" card. */
const cardRoot = (page: Page) => page.getByRole('heading', { name: 'Required documents' }).locator('xpath=ancestor::*[contains(@class,"rounded")][1]');
const mandatoryRows = (page: Page) => cardRoot(page).locator('ul').first().locator('> li');
const rowLabels = async (rows: Locator) => (await rows.locator('span.text-sm.font-medium').allTextContents()).map((s) => s.trim());
const rowOf = (page: Page, label: string) => cardRoot(page).locator('li').filter({ has: page.locator('span.text-sm.font-medium', { hasText: label }) }).first();
const optionalToggle = (page: Page) => cardRoot(page).getByRole('button', { name: /Optional & informational/ });

const DEMO_ORDER = [
  'GST registration certificate', 'PAN card of the firm', 'Audited balance sheets — last 3 financial years', 'CA certificate of average annual turnover',
  'Work orders with completion certificates (CRAC) as proof of experience', 'Additional Doc 1 — as specified in the ATC',
  'Work order + CRAC for one similar work of at least ₹19.2 L', 'ISO 9001 certificate', 'Udyam registration certificate (MSE)',
  'EMD exemption declaration', 'MSE exemption declaration', 'Make in India self-certificate (local content %)', 'Non-blacklisting / non-debarment undertaking',
];

// ---------- criteria ----------

test('1 demo + go-it-services.pdf: badge 13, "13 to submit · 4 we generate for you…", the 13 items in the documented order @mobile', async ({ page }) => {
  await demoOrg(page);
  const { t, a } = await analysedTender(page, 'go-it-services');
  expect(a.checklist.filter((i) => i.mandatory)).toHaveLength(13);
  expect(a.checklist.filter((i) => i.generated)).toHaveLength(4);
  await openTender(page, t.id);
  const root = cardRoot(page);
  await expect(root.getByRole('heading', { name: 'Required documents' })).toBeVisible();
  await expect(root.getByText('13', { exact: true }).first()).toBeVisible();
  await expect(root).toContainText('13 to submit · 4 we generate for you. Start a bid to auto-match them with your vault.');
  const labels = await rowLabels(mandatoryRows(page));
  expect(labels).toEqual(DEMO_ORDER);
  expect(await mandatoryRows(page).count()).toBe(13);
  const generatedLabels = await mandatoryRows(page).filter({ hasText: 'Generated' }).locator('span.text-sm.font-medium').allTextContents();
  expect(generatedLabels).toEqual(DEMO_ORDER.slice(9));
  await root.scrollIntoViewIfNeeded();
  await ev(page, '01-demo-checklist-13-items');
  test.info().annotations.push({ type: 'api-order', description: a.checklist.filter((i) => i.mandatory).map((i) => i.id).join(',') });
});

test('2 every item shows a ≤ 2-line reason (with page ref) and a Generated / vault-type / "Action on GeM" badge; Generated tooltip', async ({ page }) => {
  await demoOrg(page);
  const { t, a } = await analysedTender(page, 'go-it-services');
  await openTender(page, t.id);
  const rows = mandatoryRows(page);
  await expect(rows).toHaveCount(13);
  const info = await rows.evaluateAll((els) => els.map((li) => {
    const p = li.querySelector('p') as HTMLElement;
    const lh = parseFloat(getComputedStyle(p).lineHeight);
    const badge = li.querySelector('div.mt-1\\.5') as HTMLElement;
    return { label: li.querySelector('span.text-sm')?.textContent?.trim(), reason: p.textContent?.trim(), lines: Math.round(p.getBoundingClientRect().height / lh), badges: Array.from(badge.children).map((b) => b.textContent?.trim()) };
  }));
  for (const r of info) {
    expect(r.reason, `${r.label} reason`).toBeTruthy();
    expect(r.lines, `${r.label}: ${r.reason}`).toBeLessThanOrEqual(2);
    expect(r.badges.length, `${r.label} badges`).toBeGreaterThan(0);
  }
  const badgeOf: Record<string, string> = Object.fromEntries(info.map((r) => [r.label, r.badges[0] ?? '']));
  test.info().annotations.push({ type: 'rows', description: JSON.stringify(info) });
  // Deviation vs criterion text: the vault-type badge reads "GST" (DOC_TYPE_LABEL), not "GST certificate".
  expect(badgeOf['GST registration certificate']).toBe('GST');
  expect(badgeOf['ISO 9001 certificate']).toBe('ISO');
  expect(badgeOf['Additional Doc 1 — as specified in the ATC']).toBe('Other');
  for (const l of DEMO_ORDER.slice(9)) expect(badgeOf[l]).toContain('Generated');
  expect(Object.values(badgeOf).filter((b) => b.includes('Generated'))).toHaveLength(4);
  const turnover = a.checklist.find((i) => i.id === 'ca_turnover_certificate');
  expect(turnover?.reason).toBe('Minimum average turnover of ₹50 L required (bid document, page 1)');
  await expect(rowOf(page, 'CA certificate of average annual turnover').locator('p')).toHaveText('Minimum average turnover of ₹50 L required (bid document, page 1)');
  await rowOf(page, 'EMD exemption declaration').getByText('Generated').hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'TenderPilot fills this annexure from your company profile — review and sign it.' })).toBeVisible();
  await ev(page, '02-reasons-and-badges-tooltip');
});

test('3 non-MSE company + nogo-experience.pdf: optional "EMD of ₹50,000 — pay online or submit bank guarantee on GeM" under "Optional & informational (1)"; "Certificates requested in the ATC" listed @mobile', async ({ page }) => {
  await signupViaApi(page);
  await setProfile(page.request, { legalName: 'Plain Traders Pvt Ltd' });
  const { t, a } = await analysedTender(page, 'nogo-experience');
  const emd = a.checklist.find((i) => i.id === 'emd_payment');
  expect(emd, JSON.stringify(a.checklist.map((i) => i.id))).toMatchObject({ mandatory: false, label: 'EMD of ₹50,000 — pay online or submit bank guarantee on GeM' });
  expect(a.checklist.filter((i) => !i.mandatory)).toHaveLength(1);
  await openTender(page, t.id);
  const toggle = optionalToggle(page);
  await expect(toggle).toHaveText(/Optional & informational \(1\)/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(cardRoot(page).getByText('EMD of ₹50,000')).toHaveCount(0);
  test.info().annotations.push({ type: 'mandatory', description: (await rowLabels(mandatoryRows(page))).join(' | ') });
  await ev(page, '03a-optional-collapsed');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(cardRoot(page).getByText('EMD of ₹50,000 — pay online or submit bank guarantee on GeM')).toBeVisible();
  await expect(rowOf(page, 'EMD of ₹50,000')).toContainText('Action on GeM');
  await expect(rowOf(page, 'EMD of ₹50,000')).toContainText('Optional');
  await ev(page, '03b-optional-expanded-emd');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const atc = a.checklist.find((i) => i.id === 'atc_certificates');
  expect(atc, JSON.stringify(a.checklist.map((i) => [i.id, i.label]))).toMatchObject({ mandatory: true, label: 'Certificates requested in the ATC' });
  await expect(rowOf(page, 'Certificates requested in the ATC')).toBeVisible();
  await rowOf(page, 'Certificates requested in the ATC').scrollIntoViewIfNeeded();
  await ev(page, '03c-certificates-requested-in-atc');
});

test('4 with a bid workspace the description ends "Map them to your vault in the bid workspace." @mobile', async ({ page }) => {
  await demoOrg(page);
  const { t } = await analysedTender(page, 'go-it-services');
  await openTender(page, t.id);
  await expect(cardRoot(page)).toContainText('Start a bid to auto-match them with your vault.');
  await ev(page, '04a-before-start-bid');
  const res = await page.request.post(`/api/tenders/${t.id}/workspace`);
  expect([200, 201], await res.text()).toContain(res.status());
  await openTender(page, t.id);
  const desc = cardRoot(page);
  await expect(desc).toContainText('13 to submit · 4 we generate for you. Map them to your vault in the bid workspace.');
  await expect(desc).not.toContainText('Start a bid');
  await ev(page, '04b-after-start-bid');
});

test('5 re-analysis after an ATC with CMMI Level 3 adds "CMMI Level 3 certificate" and keeps existing ids (API) @mobile', async ({ page }) => {
  await demoOrg(page);
  const { t, a: before } = await analysedTender(page, 'go-it-services');
  const idsBefore = before.checklist.map((i) => i.id);
  expect(idsBefore).toEqual(expect.arrayContaining(['gst', 'udyam', 'cert_iso_9001']));
  await openTender(page, t.id);
  await expect(cardRoot(page)).not.toContainText('CMMI Level 3 certificate');
  await ev(page, '05a-before-atc');
  const atc = await textPdf([
    `Bid Number: ${t.bidNumber}`, 'Additional Terms and Conditions (ATC)',
    'Bidders must hold a valid CMMI Level 3 certificate for software development processes.',
  ]);
  const up = await page.request.post(`/api/tenders/${t.id}/documents`, { multipart: { kind: 'atc', file: { name: 'atc-cmmi.pdf', mimeType: 'application/pdf', buffer: atc } } });
  expect(up.status(), await up.text()).toBe(201);
  const after = await analyseOk(page.request, t.id);
  const idsAfter = after.checklist.map((i) => i.id);
  test.info().annotations.push({ type: 'ids-before', description: idsBefore.join(',') });
  test.info().annotations.push({ type: 'ids-after', description: idsAfter.join(',') });
  const cmmi = after.checklist.find((i) => i.label === 'CMMI Level 3 certificate');
  expect(cmmi, JSON.stringify(after.checklist.map((i) => [i.id, i.label]))).toBeTruthy();
  for (const id of idsBefore) expect(idsAfter, `id ${id} kept`).toContain(id);
  expect(idsAfter.filter((id) => !idsBefore.includes(id))).toEqual([cmmi!.id]);
  await openTender(page, t.id);
  await expect(rowOf(page, 'CMMI Level 3 certificate')).toBeVisible();
  await rowOf(page, 'CMMI Level 3 certificate').scrollIntoViewIfNeeded();
  await ev(page, '05b-after-atc-cmmi-row');
});

test('6 an analysis with no checklist items shows "No documents identified" / "Re-analyse after uploading the ATC or corrigendum." (checklist emptied in SQL) @mobile', async ({ page }) => {
  await demoOrg(page);
  const { t } = await analysedTender(page, 'go-it-services');
  psql(`update analyses set checklist = '[]'::jsonb where tender_id = '${t.id}' returning id;`);
  await openTender(page, t.id);
  const root = cardRoot(page);
  await expect(root.getByText('No documents identified')).toBeVisible();
  await expect(root.getByText('Re-analyse after uploading the ATC or corrigendum.')).toBeVisible();
  await ev(page, '06-empty-checklist');
});

test('7 (gap) readiness chips without a workspace: In vault / Expires in 10 days (ISO 9001) / Missing; "other" items no chip; hidden with a workspace @mobile', async ({ page }) => {
  await demoOrg(page);
  const { t, a } = await analysedTender(page, 'go-it-services');
  const vaultRes = await page.request.get('/api/vault');
  test.info().annotations.push({ type: 'vault', description: (await vaultRes.text()).slice(0, 1800) });
  await openTender(page, t.id);
  const rows = mandatoryRows(page);
  await expect(rows).toHaveCount(13);
  await expect(rowOf(page, 'GST registration certificate')).toContainText('In vault');
  await expect(rowOf(page, 'ISO 9001 certificate')).toContainText('Expires in 10 days');
  const chips = await rows.evaluateAll((els) => els.map((li) => ({
    label: li.querySelector('span.text-sm')?.textContent?.trim(),
    badges: Array.from((li.querySelector('div.mt-1\\.5') as HTMLElement).children).map((b) => b.textContent?.trim()),
  })));
  test.info().annotations.push({ type: 'chips', description: JSON.stringify(chips) });
  // The demo vault holds a document for every typed item, so no "Missing" appears here (see 7b for Missing).
  expect(chips.filter((c) => c.badges.some((b) => b === 'Missing'))).toEqual([]);
  const otherLabels = a.checklist.filter((i) => i.docType === 'other').map((i) => i.label);
  for (const c of chips.filter((c) => otherLabels.includes(c.label ?? ''))) {
    expect(c.badges.filter((b) => /In vault|Expires|Expired|Missing/.test(b ?? '')), `${c.label} should have no chip`).toEqual([]);
  }
  await cardRoot(page).scrollIntoViewIfNeeded();
  await ev(page, '07a-readiness-chips');
  await page.request.post(`/api/tenders/${t.id}/workspace`);
  await openTender(page, t.id);
  await expect(cardRoot(page)).toContainText('Map them to your vault in the bid workspace.');
  await expect(cardRoot(page).getByText(/^(In vault|Missing|Expires in \d+ days?|Expired)$/)).toHaveCount(0);
  await ev(page, '07b-chips-hidden-with-workspace');
});

test('7b (gap) ISO 27001 is not satisfied by an ISO 9001 document: Missing, while ISO 9001 shows Expires in 10 days', async ({ page }) => {
  await demoOrg(page);
  const t = insertTender({ bidNumber: 'GEM/2026/B/6199077' });
  const pdf = await textPdf([
    'Bid Number: GEM/2026/B/6199077', 'Dated: 28-11-2026', 'Bid Details', 'Bid End Date/Time 28-11-2026 15:00:00', 'Total Quantity 10',
    'Item Category IT Services', 'Bidders must hold valid ISO 9001 and ISO 27001 certificates.',
  ]);
  const up = await page.request.post(`/api/tenders/${t.id}/documents`, { multipart: { kind: 'bid', file: { name: 'iso-both.pdf', mimeType: 'application/pdf', buffer: pdf } } });
  expect(up.status(), await up.text()).toBe(201);
  const a = await analyseOk(page.request, t.id);
  expect(a.checklist.map((i) => i.id)).toEqual(expect.arrayContaining(['cert_iso_9001', 'cert_iso_27001']));
  await openTender(page, t.id);
  await expect(rowOf(page, 'ISO 9001 certificate')).toContainText('Expires in 10 days');
  await expect(rowOf(page, 'ISO 27001 certificate')).toContainText('Missing');
  await expect(rowOf(page, 'ISO 27001 certificate')).not.toContainText('In vault');
  await rowOf(page, 'ISO 27001 certificate').scrollIntoViewIfNeeded();
  await ev(page, '07c-iso-27001-missing-iso-9001-expiring');
});
