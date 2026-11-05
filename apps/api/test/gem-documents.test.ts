/**
 * Fetch from GeM against the in-process mock BidPlus with each `/__admin/document-mode` (T024, T018;
 * FR-003, FR-005, FR-008; spec 004 US1 #8–#10, #15).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { activityLog, tenders } from '@tp/db';
import { createMockGem } from '../../../tools/mock-gem/src/app';
import { renderScannedPdf } from '../../../tools/mock-gem/src/pdf';
import { createTestContext, request, seedOrgWithRoles, type TestContext } from './helpers';

const GEM = 'http://mock-gem.test';
let ctx: TestContext;
let mock: ReturnType<typeof createMockGem>;
let team: Awaited<ReturnType<typeof seedOrgWithRoles>>;
let seq = 0;

const admin = (path: string, body: unknown = {}) => mock.app.request(`${GEM}${path}`, { method: 'POST', body: JSON.stringify(body) });
const docRequests = () => mock.state.requests.documents;

/** A tender pointing at the i-th mock bid (unique source so the same bid can be used per test). */
async function gemTender(i = 0) {
  const d = mock.state.docs[i];
  const [t] = await ctx.db.insert(tenders).values({
    source: `mockdoc-${++seq}`, bidNumber: String(d.b_bid_number[0]), gemBidId: String(d.b_id[0]), title: 'Mock bid',
    sourceUrl: `${GEM}/all-bids#${d.b_id[0]}`, contentHash: `mockdoc-${seq}`, endAt: new Date(Date.now() + 10 * 86_400_000),
  }).returning();
  return t;
}
const fetchDocs = (tenderId: string) => request(ctx.app, 'POST', `/tenders/${tenderId}/fetch-documents`, { cookie: team.analyst.cookie });

beforeAll(async () => {
  mock = createMockGem({ token: 'c'.repeat(32) });
  ctx = await createTestContext({ gemBaseUrl: GEM, fetch: async (input, init) => mock.app.fetch(new Request(input as string, init)) });
  team = await seedOrgWithRoles(ctx.app, 'Mock Docs Co');
});
afterAll(() => ctx?.close());
beforeEach(async () => { await admin('/__admin/reset'); });

describe('mock-gem /__admin/document-mode', () => {
  it('validates the mode, reports it in /__admin/state and resets to normal', async () => {
    expect((await admin('/__admin/document-mode', { mode: 'bogus' })).status).toBe(400);
    const ok = await admin('/__admin/document-mode', { mode: 'scanned' });
    expect(await ok.json()).toEqual({ ok: true, documentMode: 'scanned' });
    expect(((await (await mock.app.request(`${GEM}/__admin/state`)).json()) as { documentMode: string }).documentMode).toBe('scanned');
    await admin('/__admin/reset');
    expect(mock.state.documentMode).toBe('normal');
  });

  it('normal: 201 {fetched:1,total:1} once, named <bid-number>.pdf; a second fetch is 200 {fetched:0} without contacting GeM (US1 #8, #9)', async () => {
    const t = await gemTender(0);
    const before = docRequests();
    const r = await fetchDocs(t.id);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ fetched: 1, total: 1 });
    expect(r.body.items[0]).toMatchObject({ kind: 'bid', source: 'gem', orgId: null, hasText: true, fileName: `${t.bidNumber.replace(/\//g, '-')}.pdf` });
    expect(r.body.items[0].fileName).toMatch(/^GEM-\d{4}-B-\d+\.pdf$/);
    expect(docRequests()).toBe(before + 1);
    const again = await request(ctx.app, 'POST', `/tenders/${t.id}/fetch-documents`, { cookie: team.bidManager.cookie });
    expect(again.status).toBe(200);
    expect(again.body.fetched).toBe(0);
    expect(docRequests()).toBe(before + 1);
  });

  it('404: 502 gem_unavailable "GeM no longer serves this bid document…" (US1 #10)', async () => {
    await admin('/__admin/document-mode', { mode: '404' });
    const r = await fetchDocs((await gemTender(1)).id);
    expect(r.status).toBe(502);
    expect(r.body.error).toEqual({ code: 'gem_unavailable', message: 'GeM no longer serves this bid document. Upload the PDF instead.' });
  });

  it('html (login page instead of a PDF) and down: 502 with the generic message (US1 #10)', async () => {
    const generic = 'Could not download the bid document from GeM right now. Try again in a few minutes or upload the PDF.';
    await admin('/__admin/document-mode', { mode: 'html' });
    const html = await fetchDocs((await gemTender(2)).id);
    expect(html.status).toBe(502);
    expect(html.body.error).toEqual({ code: 'gem_unavailable', message: generic });
    await admin('/__admin/reset');
    await admin('/__admin/fail', { mode: 'down' });
    const down = await fetchDocs((await gemTender(2)).id);
    expect(down.status).toBe(502);
    expect(down.body.error).toEqual({ code: 'gem_unavailable', message: generic });
  });

  it('scanned: stored with hasText:false and the activity flags it as scanned (US1 #15)', async () => {
    await admin('/__admin/document-mode', { mode: 'scanned' });
    const t = await gemTender(3);
    const r = await fetchDocs(t.id);
    expect(r.status).toBe(201);
    expect(r.body.items[0]).toMatchObject({ hasText: false, pageCount: 3, bidNumberFound: null });
    const [log] = await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, t.id), eq(activityLog.action, 'tender.document_fetched')));
    expect(log).toBeTruthy();
  });

  it('a scanned PDF uploaded by an analyst is accepted with hasText:false and activity scanned:true (US1 #15)', async () => {
    const t = await gemTender(4);
    const file = new File([await renderScannedPdf(2) as BlobPart], 'scan.pdf', { type: 'application/pdf' });
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/documents`, { cookie: team.analyst.cookie, form: { file } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ hasText: false, pageCount: 2, warnings: [] });
    const [log] = await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, t.id), eq(activityLog.action, 'tender.document_uploaded')));
    expect(log.meta).toMatchObject({ scanned: true, pages: 2 });
  });

  it('oversize: the > 25 MB stream is cut off → 502 with the size-specific message, one request, nothing stored (FR-008)', async () => {
    await admin('/__admin/document-mode', { mode: 'oversize' });
    const t = await gemTender(5);
    const before = docRequests();
    const r = await fetchDocs(t.id);
    expect(r.status).toBe(502);
    expect(r.body.error).toEqual({ code: 'gem_unavailable', message: 'The GeM document is larger than 25 MB — download it from GeM and upload it here.' });
    expect(docRequests()).toBe(before + 1);
    expect((await request(ctx.app, 'GET', `/tenders/${t.id}/documents`, { cookie: team.analyst.cookie })).body.total).toBe(0);
  });
});
