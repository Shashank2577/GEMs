/**
 * E2E helpers for spec 004 Analyse (T005; NFR-010, SC-007). Re-uses e2e/support/fixtures.ts for
 * sign-up, mock-gem admin calls and evidence (`evidence()` / `collectRunArtifacts()`).
 *
 *   const user = await signupViaApi(page);                      // owner of a fresh org
 *   const t = await openTargetTender(page, { tab: 'documents' });
 *   const doc = await uploadFixture(page, t.id, 'go-it-services');
 *   await setProfile(page.request, { mseCategory: 'small' });
 *   const a = await analyse(page.request, t.id);
 *   await setDocumentMode(page.request, 'scanned');             // mock-gem /__admin/document-mode
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import type { AnalysisDto, TenderDocKind, UploadTenderDocumentResponse } from '../../packages/core/src/contracts/analyse';
import { expect, GEM_URL, mockGem } from '../support/fixtures';

export { collectRunArtifacts, evidence, expect, mockGem, signupViaApi, test, uniqueUser } from '../support/fixtures';

export const SPEC = '004';

/** Option labels of the "Document type" select (mirrors TENDER_DOC_KIND_LABELS). */
export const DOC_KIND_LABELS: Record<TenderDocKind, string> = { bid: 'Bid document', atc: 'ATC', corrigendum: 'Corrigendum', boq: 'BOQ', other: 'Other' };

/** GeM-style sample bids in packages/core/test/fixtures/bids (plus `synthetic-tender`). */
export type BidFixture = 'go-it-services' | 'review-hardware-oem' | 'nogo-experience' | 'emd-exempt-mse' | 'synthetic-tender';

export const fixturePath = (fixture: BidFixture | string) =>
  join(process.cwd(), 'packages/core/test/fixtures/bids', fixture.endsWith('.pdf') ? fixture : `${fixture}.pdf`);

export interface TargetTender { id: string; bidNumber: string; gemBidId: string | null; endAt: string | null; title: string }

/**
 * The first open tender ingested from mock-gem (`source: 'gem'`, has a GeM bid id) that closes at least
 * `minDaysOut` days from now (default 3). Runs a GeM sync first when none is in the database yet
 * (needs bid_manager+, e.g. the owner from `signupViaApi`). Navigates to `/tenders/<id>` (optional `?tab=`).
 */
export async function openTargetTender(page: Page, opts: { tab?: 'analysis' | 'requirements' | 'documents' | 'history'; minDaysOut?: number } = {}): Promise<TargetTender> {
  const minEnd = Date.now() + (opts.minDaysOut ?? 3) * 86_400_000;
  // Only bids mock-gem actually serves: the demo seed (e.g. from the smoke spec) also creates source 'gem'
  // tenders whose GeM bid ids mock-gem does not know, so fetching their documents would 404.
  const known = async () => {
    const res = await page.request.get(`${GEM_URL}/__admin/state`);
    expect(res.ok(), await res.text()).toBeTruthy();
    const { bids } = (await res.json()) as { bids: { id: string | number }[] };
    return new Set(bids.map((b) => String(b.id)));
  };
  const find = async (): Promise<TargetTender | undefined> => {
    const ids = await known();
    const res = await page.request.get('/api/tenders', { params: { status: 'open', sort: 'endAt', pageSize: 100 } });
    expect(res.ok(), await res.text()).toBeTruthy();
    const { items } = (await res.json()) as { items: (TargetTender & { source: string })[] };
    return items.find((t) => t.source === 'gem' && !!t.gemBidId && ids.has(String(t.gemBidId)) && !!t.endAt && Date.parse(t.endAt) >= minEnd);
  };
  let target = await find();
  if (!target) {
    const run = await page.request.post('/api/ingestion/run', { data: { pages: 3 } });
    // 409 = a sync is already running (another test); its results land shortly.
    expect([200, 409], await run.text()).toContain(run.status());
    await expect.poll(async () => !!(await find()), { timeout: 30_000 }).toBe(true);
    target = (await find())!;
  }
  await page.goto(`/tenders/${target.id}${opts.tab && opts.tab !== 'analysis' ? `?tab=${opts.tab}` : ''}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return target;
}

/**
 * Upload a fixture PDF through the Documents tab UI (type select + dropzone) and return the API's
 * 201 body. Opens `/tenders/<id>?tab=documents` unless already there.
 */
export async function uploadFixture(page: Page, tenderId: string, fixture: BidFixture | string, kind: TenderDocKind = 'bid'): Promise<UploadTenderDocumentResponse> {
  if (!page.url().includes(`/tenders/${tenderId}`) || !page.url().includes('tab=documents')) await page.goto(`/tenders/${tenderId}?tab=documents`);
  if (kind !== 'bid') {
    await page.getByRole('combobox', { name: 'Document type' }).click();
    await page.getByRole('option', { name: DOC_KIND_LABELS[kind], exact: true }).click();
  }
  const uploaded = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/tenders/${tenderId}/documents`));
  await page.locator('input[type="file"]').setInputFiles(fixturePath(fixture));
  const res = await uploaded;
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

/** Upload a fixture straight through the API (no UI), e.g. for setup. */
export async function uploadFixtureViaApi(request: APIRequestContext, tenderId: string, fixture: BidFixture | string, kind: TenderDocKind = 'bid') {
  const name = fixture.endsWith('.pdf') ? fixture : `${fixture}.pdf`;
  const res = await request.post(`/api/tenders/${tenderId}/documents`, {
    multipart: { kind, file: { name, mimeType: 'application/pdf', buffer: readFileSync(fixturePath(fixture)) } },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as UploadTenderDocumentResponse;
}

/** PUT /api/profile with a partial company profile (analyst+). Returns the profile response. */
export async function setProfile(request: APIRequestContext, partial: Record<string, unknown>) {
  const res = await request.put('/api/profile', { data: partial });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

/** POST /api/tenders/:id/analyse (analyst+) and return the 201 Analysis. */
export async function analyse(request: APIRequestContext, tenderId: string): Promise<AnalysisDto> {
  const res = await request.post(`/api/tenders/${tenderId}/analyse`);
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

/** mock-gem: how /showbidDocument answers (FR-005, FR-008). Reset with `mockGem(request, '/__admin/reset')`. */
export async function setDocumentMode(request: APIRequestContext, mode: 'normal' | '404' | 'html' | 'scanned' | 'oversize') {
  return mockGem(request, '/__admin/document-mode', { mode });
}
