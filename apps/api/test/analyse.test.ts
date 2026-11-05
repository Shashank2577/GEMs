/**
 * Analyse flow (T047, US2): upload → analyse → verdict, override, weights, GeM fetch, isolation.
 * Run: TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test_analyse pnpm exec vitest run test/analyse.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { activityLog, analyses, companyProfiles, pastContracts, tenderDocuments, tenders, vaultDocuments } from '@tp/db';
import { generateBidPdf, getSampleBidSpec } from '@tp/core/analyse/sample-bid';
import { createApp } from '../src/app';
import type { LlmClient } from '../src/deps';
import { createTestContext, request, seedOrgWithRoles, signup, type TestContext } from './helpers';

let ctx: TestContext;
let roles: Awaited<ReturnType<typeof seedOrgWithRoles>>;
const pdfs: Record<string, Uint8Array> = {};
const gemCalls: string[] = [];

/** Fake GeM: /showbidDocument/:id serves the matching sample bid PDF. */
const gemFetch: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  gemCalls.push(url);
  const m = url.match(/\/showbidDocument\/(.+)$/);
  if (m?.[1] === 'oversize') {
    // Advertises 26 MB; the client must refuse it without buffering the body (FR-008).
    return new Response(new TextEncoder().encode('%PDF-1.7 big') as BodyInit, { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(26 * 1024 * 1024) } });
  }
  if (m && pdfs[m[1]]) return new Response(pdfs[m[1]] as BodyInit, { status: 200, headers: { 'content-type': 'application/pdf' } });
  return new Response('not found', { status: 404 });
};

async function insertTender(key: string, over: Partial<typeof tenders.$inferInsert> = {}) {
  const spec = getSampleBidSpec(key)!;
  const [t] = await ctx.db.insert(tenders).values({
    bidNumber: spec.bidNumber, title: spec.itemCategory, category: spec.itemCategory, ministry: spec.ministry,
    department: spec.department, organisation: spec.organisation, buyerOffice: spec.office, state: spec.consignee.state,
    endAt: new Date('2026-11-28T09:30:00Z'), emdAmount: spec.emd?.amount ?? null, estimatedValue: spec.estimatedValue ?? null,
    quantity: spec.totalQuantity, sourceUrl: `https://bidplus.gem.gov.in/all-bids#${spec.bidNumber}`, contentHash: key, ...over,
  }).returning();
  return t;
}

const pdfFile = (key: string, name = `${key}.pdf`) => new File([pdfs[key] as BlobPart], name, { type: 'application/pdf' });

async function seedCompany(orgId: string) {
  await ctx.db.insert(companyProfiles).values({
    orgId, legalName: 'Sharma Infotech Pvt Ltd', mseCategory: 'small', udyamNumber: 'UDYAM-DL-08-0012345', miiClass: 'class_1',
    localContentPct: 62, incorporationDate: '2022-04-01', certifications: ['ISO 9001:2015'], maxEmdCapacity: 500_000,
    operatingStates: ['Delhi', 'Uttar Pradesh', 'Madhya Pradesh', 'Haryana'],
    financials: [{ fy: '2023-24', turnover: 16_000_000 }, { fy: '2024-25', turnover: 20_000_000 }, { fy: '2025-26', turnover: 24_000_000 }],
  });
  await ctx.db.insert(pastContracts).values([
    { orgId, buyer: 'DGFT', title: 'IT helpdesk', value: 2_500_000, startDate: '2022-06-01', endDate: '2023-05-31' },
    { orgId, buyer: 'NDMC', title: 'AMC of desktops', value: 1_200_000, startDate: '2024-01-15' },
  ]);
  const doc = (type: typeof vaultDocuments.$inferInsert['type'], title: string, expiryDate: string | null = null) =>
    ({ orgId, type, title, expiryDate, blobKey: `org/${orgId}/vault/${type}.pdf`, fileName: `${type}.pdf`, mimeType: 'application/pdf', sizeBytes: 100 });
  await ctx.db.insert(vaultDocuments).values([
    doc('gst', 'GST certificate'), doc('pan', 'PAN card'), doc('udyam', 'Udyam registration'), doc('balance_sheet', 'Balance sheet FY 2025-26'),
    doc('ca_turnover_certificate', 'CA certificate'), doc('crac', 'CRAC DGFT'), doc('iso', 'ISO 9001:2015', '2027-08-31'),
  ]);
}

beforeAll(async () => {
  for (const k of ['go-it-services', 'nogo-experience', 'emd-exempt-mse', 'review-hardware-oem']) pdfs[k] = await generateBidPdf(getSampleBidSpec(k)!);
  ctx = await createTestContext({ now: '2026-11-04T04:30:00Z', fetch: gemFetch });
  roles = await seedOrgWithRoles(ctx.app, 'Sharma Infotech');
  await seedCompany(roles.orgId);
});
afterAll(() => ctx?.close());

describe('upload → analyse → verdict', () => {
  let tenderId: string;
  let analysisId: string;

  it('uploads a bid PDF and extracts its text (analyst)', async () => {
    tenderId = (await insertTender('go-it-services')).id;
    const r = await request(ctx.app, 'POST', `/tenders/${tenderId}/documents`, { cookie: roles.analyst.cookie, form: { file: pdfFile('go-it-services', 'Bid Document.pdf'), kind: 'bid' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ tenderId, orgId: roles.orgId, kind: 'bid', fileName: 'Bid Document.pdf', pageCount: 4, hasText: true, source: 'upload' });
    const list = await request(ctx.app, 'GET', `/tenders/${tenderId}/documents`, { cookie: roles.viewer.cookie });
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
  });

  it('rejects non-PDF uploads, missing files and viewers', async () => {
    const txt = await request(ctx.app, 'POST', `/tenders/${tenderId}/documents`, { cookie: roles.analyst.cookie, form: { file: new File(['hello'], 'a.txt', { type: 'text/plain' }) } });
    expect(txt.status).toBe(415);
    expect(txt.body.error.code).toBe('unsupported_media_type');
    const none = await request(ctx.app, 'POST', `/tenders/${tenderId}/documents`, { cookie: roles.analyst.cookie, form: { kind: 'bid' } });
    expect(none.status).toBe(400);
    const badKind = await request(ctx.app, 'POST', `/tenders/${tenderId}/documents`, { cookie: roles.analyst.cookie, form: { file: pdfFile('go-it-services'), kind: 'zip' } });
    expect(badKind.status).toBe(400);
    const viewer = await request(ctx.app, 'POST', `/tenders/${tenderId}/documents`, { cookie: roles.viewer.cookie, form: { file: pdfFile('go-it-services') } });
    expect(viewer.status).toBe(403);
    const missing = await request(ctx.app, 'POST', `/tenders/00000000-0000-4000-8000-000000000000/documents`, { cookie: roles.analyst.cookie, form: { file: pdfFile('go-it-services') } });
    expect(missing.status).toBe(404);
  });

  it('analyses with rules only → Go, turnover passes citing the bid page (US2 #1, #4)', async () => {
    const r = await request(ctx.app, 'POST', `/tenders/${tenderId}/analyse`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(201);
    const a = r.body;
    analysisId = a.id;
    expect(a).toMatchObject({ status: 'done', method: 'rules', verdict: 'go', stale: false, tenderId });
    expect(a.score).toBeGreaterThanOrEqual(90);
    expect(a.confidence).toBe(1);
    const turnover = a.factors.find((f: any) => f.key === 'turnover');
    expect(turnover.status).toBe('pass');
    expect(turnover.detail).toContain('₹50 L');
    const req = a.requirements.find((x: any) => x.key === 'turnover_min');
    expect(req).toMatchObject({ numeric: 5_000_000, method: 'RULE', source: { page: 1, fileName: 'Bid Document.pdf' } });
    expect(req.source.quote).toContain('50 Lakh');
    expect(a.checklist.map((i: any) => i.id)).toEqual(expect.arrayContaining(['gst', 'pan', 'udyam', 'emd_exemption', 'mii_self_cert']));
    expect(a.documents).toHaveLength(1);
    const log = await ctx.db.select().from(activityLog).where(and(eq(activityLog.orgId, roles.orgId), eq(activityLog.action, 'tender.analysed')));
    expect(log).toHaveLength(1);
  });

  it('GET /tenders/:id/analysis returns the latest analysis; viewers can read', async () => {
    const r = await request(ctx.app, 'GET', `/tenders/${tenderId}/analysis`, { cookie: roles.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(analysisId);
    const viewerAnalyse = await request(ctx.app, 'POST', `/tenders/${tenderId}/analyse`, { cookie: roles.viewer.cookie });
    expect(viewerAnalyse.status).toBe(403);
  });

  it('downloads the uploaded document', async () => {
    const docs = await request(ctx.app, 'GET', `/tenders/${tenderId}/documents`, { cookie: roles.viewer.cookie });
    const id = docs.body.items[0].id;
    const r = await request(ctx.app, 'GET', `/tenders/${tenderId}/documents/${id}/download?inline=1`, { cookie: roles.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toMatch(/^inline; filename="Bid Document.pdf"/);
    const bytes = new Uint8Array(await r.res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('another organization cannot see the analysis or download the upload (Constitution IV)', async () => {
    const other = await signup(ctx.app, { orgName: 'Other Co' });
    expect((await request(ctx.app, 'GET', `/tenders/${tenderId}/analysis`, { cookie: other.cookie })).status).toBe(404);
    const list = await request(ctx.app, 'GET', `/tenders/${tenderId}/documents`, { cookie: other.cookie });
    expect(list.body.total).toBe(0);
    const docs = await request(ctx.app, 'GET', `/tenders/${tenderId}/documents`, { cookie: roles.viewer.cookie });
    const dl = await request(ctx.app, 'GET', `/tenders/${tenderId}/documents/${docs.body.items[0].id}/download`, { cookie: other.cookie });
    expect(dl.status).toBe(404);
    const ov = await request(ctx.app, 'POST', `/analyses/${analysisId}/override`, { cookie: other.cookie, json: { factorKey: 'emd', status: 'fail', reason: 'nope' } });
    expect(ov.status).toBe(404);
  });
});

describe('verdict scenarios', () => {
  it('3+ years required but the company has fewer → No-Go with a blocking factor (US2 #3)', async () => {
    const t = await insertTender('nogo-experience');
    await request(ctx.app, 'POST', `/tenders/${t.id}/documents`, { cookie: roles.analyst.cookie, form: { file: pdfFile('nogo-experience') } });
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(201);
    expect(r.body.verdict).toBe('no_go');
    const exp = r.body.factors.find((f: any) => f.key === 'experience');
    expect(exp).toMatchObject({ status: 'fail', blocking: true });
  });

  it('MSE with a valid Udyam → EMD "Exempt (MSE)" and the checklist asks for the Udyam certificate (US2 #2)', async () => {
    const t = await insertTender('emd-exempt-mse');
    await request(ctx.app, 'POST', `/tenders/${t.id}/documents`, { cookie: roles.analyst.cookie, form: { file: pdfFile('emd-exempt-mse') } });
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    const emd = r.body.factors.find((f: any) => f.key === 'emd');
    expect(emd.status).toBe('exempt');
    expect(emd.detail).toMatch(/^Exempt \(MSE\)/);
    expect(r.body.checklist.find((i: any) => i.id === 'udyam')).toMatchObject({ docType: 'udyam', mandatory: true });
  });

  it('no documents and no GeM link → 422 with a helpful message', async () => {
    const t = await insertTender('review-hardware-oem', { bidNumber: 'GEM/2026/B/0000001', contentHash: 'x' });
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('no_documents');
    const f = await request(ctx.app, 'POST', `/tenders/${t.id}/fetch-documents`, { cookie: roles.analyst.cookie });
    expect(f.status).toBe(422);
  });
});

describe('GeM document fetch', () => {
  it('fetches /showbidDocument/:gemBidId once and reuses it (public document, org_id null)', async () => {
    const t = await insertTender('review-hardware-oem', { gemBidId: 'review-hardware-oem' });
    gemCalls.length = 0;
    const first = await request(ctx.app, 'POST', `/tenders/${t.id}/fetch-documents`, { cookie: roles.analyst.cookie });
    expect(first.status).toBe(201);
    expect(first.body.fetched).toBe(1);
    expect(first.body.items[0]).toMatchObject({ source: 'gem', orgId: null, pageCount: 4, kind: 'bid' });
    expect(gemCalls).toEqual(['http://127.0.0.1:4010/showbidDocument/review-hardware-oem']);
    const again = await request(ctx.app, 'POST', `/tenders/${t.id}/fetch-documents`, { cookie: roles.bidManager.cookie });
    expect(again.status).toBe(200);
    expect(again.body.fetched).toBe(0);
    expect(gemCalls).toHaveLength(1);
    const [row] = await ctx.db.select().from(tenders).where(eq(tenders.id, t.id));
    expect(row.documentUrl).toBe('http://127.0.0.1:4010/showbidDocument/review-hardware-oem');
  });

  it('analyse auto-fetches the GeM document when none is attached', async () => {
    const t = await insertTender('go-it-services', { bidNumber: 'GEM/2026/B/7000001', contentHash: 'y', gemBidId: 'go-it-services' });
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(201);
    expect(r.body.verdict).toBe('go');
    expect(r.body.documents[0].kind).toBe('bid');
  });

  it('GeM failure → 502 gem_unavailable', async () => {
    const t = await insertTender('go-it-services', { bidNumber: 'GEM/2026/B/7000002', contentHash: 'z', gemBidId: 'missing-id' });
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/fetch-documents`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('gem_unavailable');
  });
});

describe('override (FR-016)', () => {
  let tenderId: string;
  let analysisId: string;
  beforeAll(async () => {
    tenderId = (await insertTender('nogo-experience', { bidNumber: 'GEM/2026/B/8000001', contentHash: 'o' })).id;
    await request(ctx.app, 'POST', `/tenders/${tenderId}/documents`, { cookie: roles.analyst.cookie, form: { file: pdfFile('nogo-experience') } });
    analysisId = (await request(ctx.app, 'POST', `/tenders/${tenderId}/analyse`, { cookie: roles.analyst.cookie })).body.id;
  });

  it('requires bid manager and a reason', async () => {
    const analyst = await request(ctx.app, 'POST', `/analyses/${analysisId}/override`, { cookie: roles.analyst.cookie, json: { factorKey: 'experience', status: 'pass', reason: 'JV partner' } });
    expect(analyst.status).toBe(403);
    const noReason = await request(ctx.app, 'POST', `/analyses/${analysisId}/override`, { cookie: roles.bidManager.cookie, json: { factorKey: 'experience', status: 'pass', reason: '' } });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details.fields.reason).toBeTruthy();
    const badKey = await request(ctx.app, 'POST', `/analyses/${analysisId}/override`, { cookie: roles.bidManager.cookie, json: { factorKey: 'vibes', status: 'pass', reason: 'xyz' } });
    expect(badKey.status).toBe(400);
  });

  it('re-scores, records who/why, is audited and survives re-analysis', async () => {
    const r = await request(ctx.app, 'POST', `/analyses/${analysisId}/override`, { cookie: roles.bidManager.cookie, json: { factorKey: 'experience', status: 'pass', reason: 'Consortium partner brings 10 years' } });
    expect(r.status).toBe(200);
    expect(r.body.verdict).toBe('go');
    const f = r.body.factors.find((x: any) => x.key === 'experience');
    expect(f.status).toBe('fail');
    expect(f.overridden).toMatchObject({ status: 'pass', reason: 'Consortium partner brings 10 years', by: 'Test bid manager' });
    const audit = await ctx.db.select().from(activityLog).where(eq(activityLog.action, 'analysis.factor_overridden'));
    expect(audit[0].meta).toMatchObject({ factorKey: 'experience', from: 'fail', to: 'pass' });

    const again = await request(ctx.app, 'POST', `/tenders/${tenderId}/analyse`, { cookie: roles.analyst.cookie });
    expect(again.body.id).not.toBe(analysisId);
    expect(again.body.factors.find((x: any) => x.key === 'experience').overridden.status).toBe('pass');
    expect(again.body.verdict).toBe('go');

    // Setting the computed status again clears the override.
    const clear = await request(ctx.app, 'POST', `/analyses/${again.body.id}/override`, { cookie: roles.owner.cookie, json: { factorKey: 'experience', status: 'fail', reason: 'Partner withdrew' } });
    expect(clear.body.factors.find((x: any) => x.key === 'experience').overridden).toBeUndefined();
    expect(clear.body.verdict).toBe('no_go');
  });
});

describe('scoring weights', () => {
  it('GET returns defaults; PUT requires bid manager, validates and persists', async () => {
    const g = await request(ctx.app, 'GET', '/scoring-weights', { cookie: roles.viewer.cookie });
    expect(g.status).toBe(200);
    expect(g.body.custom).toBe(false);
    expect(g.body.weights.turnover).toBe(20);
    expect((await request(ctx.app, 'PUT', '/scoring-weights', { cookie: roles.analyst.cookie, json: { turnover: 30 } })).status).toBe(403);
    expect((await request(ctx.app, 'PUT', '/scoring-weights', { cookie: roles.bidManager.cookie, json: { vibes: 3 } })).status).toBe(400);
    expect((await request(ctx.app, 'PUT', '/scoring-weights', { cookie: roles.bidManager.cookie, json: { turnover: 300 } })).status).toBe(400);
    const p = await request(ctx.app, 'PUT', '/scoring-weights', { cookie: roles.bidManager.cookie, json: { certificates: 50 } });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ custom: true, weights: { certificates: 50, turnover: 20 } });
    const g2 = await request(ctx.app, 'GET', '/scoring-weights', { cookie: roles.viewer.cookie });
    expect(g2.body.weights.certificates).toBe(50);
    // New analyses use the org weights.
    const t = await insertTender('emd-exempt-mse', { bidNumber: 'GEM/2026/B/9000001', contentHash: 'w' });
    await request(ctx.app, 'POST', `/tenders/${t.id}/documents`, { cookie: roles.analyst.cookie, form: { file: pdfFile('emd-exempt-mse') } });
    const a = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(a.body.factors.find((f: any) => f.key === 'certificates').weight).toBe(50);
    const reset = await request(ctx.app, 'PUT', '/scoring-weights', { cookie: roles.owner.cookie, json: {} });
    expect(reset.body.custom).toBe(false);
  });
});

describe('LLM enrichment (fake client)', () => {
  it('adds ATC items with method LLM and labels the analysis "rules+llm"; failures fall back to rules', async () => {
    const fake: LlmClient = {
      model: 'fake',
      complete: async () => ({ text: '', model: 'fake', stopReason: null, usage: { inputTokens: 0, outputTokens: 0 } }),
      completeJson: async <T>() => ({
        requirements: [
          { key: 'certificate', label: 'EPF registration', value: 'EPF registration', page: 4, quote: 'EPF/ESI regulations', confidence: 0.8 },
          { key: 'turnover_min', label: 'Turnover', value: '5 Crore', numeric: 50_000_000, confidence: 0.99 },
        ],
      }) as T,
    };
    const app = createApp({ ...ctx.deps, llm: fake });
    const t = await insertTender('go-it-services', { bidNumber: 'GEM/2026/B/9100001', contentHash: 'l' });
    await request(app, 'POST', `/tenders/${t.id}/documents`, { cookie: roles.analyst.cookie, form: { file: pdfFile('go-it-services') } });
    const r = await request(app, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(201);
    expect(r.body.method).toBe('rules+llm');
    expect(r.body.requirements.find((x: any) => x.key === 'turnover_min')).toMatchObject({ method: 'RULE', numeric: 5_000_000 });
    expect(r.body.requirements.find((x: any) => x.value === 'EPF registration')).toMatchObject({ method: 'LLM' });

    const broken = createApp({ ...ctx.deps, llm: { ...fake, completeJson: async () => { throw new Error('overloaded'); } } });
    const r2 = await request(broken, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(r2.status).toBe(201);
    expect(r2.body.method).toBe('rules');
    const rows = await ctx.db.select().from(analyses).where(eq(analyses.tenderId, t.id));
    expect(rows.every((x) => x.status === 'done')).toBe(true);
  });
});

describe('US1 documents: messages, bid-number check, removal, staleness (FR-002, FR-005, FR-008..FR-010, FR-044)', () => {
  const upload = (tenderId: string, file: File, cookie = roles.analyst.cookie, kind = 'bid') =>
    request(ctx.app, 'POST', `/tenders/${tenderId}/documents`, { cookie, form: { file, kind } });

  it('upload response carries no warnings and bidNumberFound null when the PDF matches the tender (US1 #2)', async () => {
    const t = await insertTender('go-it-services', { contentHash: 'us1-match', source: 'us1-match' });
    const r = await upload(t.id, pdfFile('go-it-services'));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'bid', pageCount: 4, hasText: true, source: 'upload', orgId: roles.orgId, textSource: 'pdf', bidNumberFound: null, warnings: [] });
    const list = await request(ctx.app, 'GET', `/tenders/${t.id}/documents`, { cookie: roles.viewer.cookie });
    expect(list.body.items[0]).toMatchObject({ bidNumberFound: null, textSource: 'pdf' });
    expect(list.body.items[0]).not.toHaveProperty('text');
  });

  it('a PDF printed with another bid number is stored with a bid_number_mismatch warning (US1 #16)', async () => {
    const t = await insertTender('go-it-services', { contentHash: 'us1-mismatch', source: 'us1-mismatch' }); // GEM/2026/B/6120451
    const r = await upload(t.id, pdfFile('review-hardware-oem')); // printed GEM/2026/B/6133872
    expect(r.status).toBe(201);
    expect(r.body.warnings).toEqual([{ code: 'bid_number_mismatch', found: 'GEM/2026/B/6133872' }]);
    expect(r.body.bidNumberFound).toBe('GEM/2026/B/6133872');
    const list = await request(ctx.app, 'GET', `/tenders/${t.id}/documents`, { cookie: roles.viewer.cookie });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].bidNumberFound).toBe('GEM/2026/B/6133872');
  });

  it('answers the exact spec messages for empty, missing, non-PDF, oversize and unreadable uploads; nothing is stored (US1 #4–#7)', async () => {
    const t = await insertTender('go-it-services', { contentHash: 'us1-errors', source: 'us1-errors' });
    const empty = await upload(t.id, new File([], 'empty.pdf', { type: 'application/pdf' }));
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatchObject({ code: 'bad_request', message: 'The file is empty' });
    const missing = await request(ctx.app, 'POST', `/tenders/${t.id}/documents`, { cookie: roles.analyst.cookie, form: { kind: 'bid' } });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: 'validation_error', message: 'Choose a PDF file to upload', details: { fields: { file: 'Required' } } });
    const docx = await upload(t.id, new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], 'tender.pdf', { type: 'application/pdf' }));
    expect(docx.status).toBe(415);
    expect(docx.body.error).toMatchObject({ code: 'unsupported_media_type', message: 'Only PDF files can be analysed. Export the document to PDF and try again.' });
    const big = new Uint8Array(26 * 1024 * 1024);
    big.set(new TextEncoder().encode('%PDF-1.7'));
    const tooBig = await upload(t.id, new File([big], 'big.pdf', { type: 'application/pdf' }));
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error).toMatchObject({ code: 'payload_too_large', message: 'The file is larger than 25 MB' });
    const broken = await upload(t.id, new File(['%PDF-1.7\ninvalid fixture'], 'broken.pdf', { type: 'application/pdf' }));
    expect(broken.status).toBe(422);
    expect(broken.body.error).toMatchObject({ code: 'unreadable_pdf', message: 'We could not read this PDF. It may be password-protected or damaged.' });
    const list = await request(ctx.app, 'GET', `/tenders/${t.id}/documents`, { cookie: roles.analyst.cookie });
    expect(list.body.total).toBe(0);
  });

  it('GeM 404 and oversize documents → 502 gem_unavailable with specific copy (US1 #10, FR-008)', async () => {
    const gone = await insertTender('go-it-services', { bidNumber: 'GEM/2026/B/7000101', contentHash: 'us1-404', source: 'us1-404', gemBidId: 'gone' });
    const r404 = await request(ctx.app, 'POST', `/tenders/${gone.id}/fetch-documents`, { cookie: roles.analyst.cookie });
    expect(r404.status).toBe(502);
    expect(r404.body.error).toMatchObject({ code: 'gem_unavailable', message: 'GeM no longer serves this bid document. Upload the PDF instead.' });
    const big = await insertTender('go-it-services', { bidNumber: 'GEM/2026/B/7000102', contentHash: 'us1-big', source: 'us1-big', gemBidId: 'oversize' });
    gemCalls.length = 0;
    const rBig = await request(ctx.app, 'POST', `/tenders/${big.id}/fetch-documents`, { cookie: roles.analyst.cookie });
    expect(rBig.status).toBe(502);
    expect(rBig.body.error).toMatchObject({ code: 'gem_unavailable', message: 'The GeM document is larger than 25 MB — download it from GeM and upload it here.' });
    expect(gemCalls).toHaveLength(1); // not retried
    const rows = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.tenderId, big.id));
    expect(rows).toHaveLength(0);
  });

  it('uploading marks the org\'s analysis stale with reason document_added (FR-044)', async () => {
    const t = await insertTender('go-it-services', { contentHash: 'us1-added', source: 'us1-added' });
    await upload(t.id, pdfFile('go-it-services'));
    const a = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(a.body).toMatchObject({ stale: false, staleReason: null, staleAt: null, notes: [] });
    await upload(t.id, pdfFile('go-it-services', 'ATC.pdf'), roles.analyst.cookie, 'atc');
    const after = await request(ctx.app, 'GET', `/tenders/${t.id}/analysis`, { cookie: roles.viewer.cookie });
    expect(after.body).toMatchObject({ id: a.body.id, stale: true, staleReason: 'document_added', staleAt: ctx.clock.now().toISOString() });
  });

  it('DELETE removes the org\'s own upload (204, blob gone, audited) and marks the analysis stale (US1 #17, FR-009)', async () => {
    const t = await insertTender('go-it-services', { contentHash: 'us1-remove', source: 'us1-remove', gemBidId: 'go-it-services' });
    const bid = await upload(t.id, pdfFile('go-it-services'));
    const atc = await upload(t.id, pdfFile('go-it-services', 'ATC.pdf'), roles.analyst.cookie, 'atc');
    const a = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(a.status).toBe(201);
    const [row] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, atc.body.id));
    expect(await ctx.deps.blobs.get(row.blobKey)).not.toBeNull();

    expect((await request(ctx.app, 'DELETE', `/tenders/${t.id}/documents/${atc.body.id}`, { cookie: roles.viewer.cookie })).status).toBe(403);
    const other = await signup(ctx.app, { orgName: 'Remove Other Co' });
    const foreign = await request(ctx.app, 'DELETE', `/tenders/${t.id}/documents/${atc.body.id}`, { cookie: other.cookie });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('not_found');

    const del = await request(ctx.app, 'DELETE', `/tenders/${t.id}/documents/${atc.body.id}`, { cookie: roles.analyst.cookie });
    expect(del.status).toBe(204);
    expect(del.text).toBe('');
    expect(await ctx.deps.blobs.get(row.blobKey)).toBeNull();
    const list = await request(ctx.app, 'GET', `/tenders/${t.id}/documents`, { cookie: roles.analyst.cookie });
    expect(list.body.items.map((d: any) => d.id)).toEqual([bid.body.id]);
    const log = await ctx.db.select().from(activityLog).where(and(eq(activityLog.orgId, roles.orgId), eq(activityLog.action, 'tender.document_removed')));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entityType: 'tender', entityId: t.id, meta: { documentId: atc.body.id, fileName: 'ATC.pdf', kind: 'atc' } });
    const after = await request(ctx.app, 'GET', `/tenders/${t.id}/analysis`, { cookie: roles.viewer.cookie });
    expect(after.body).toMatchObject({ id: a.body.id, stale: true, staleReason: 'document_removed' });
    expect((await request(ctx.app, 'DELETE', `/tenders/${t.id}/documents/${atc.body.id}`, { cookie: roles.analyst.cookie })).status).toBe(404);
    expect((await request(ctx.app, 'DELETE', `/tenders/${t.id}/documents/not-a-uuid`, { cookie: roles.analyst.cookie })).status).toBe(404);
  });

  it('DELETE with a docId belonging to a different tender → 404 and nothing is removed (FR-009)', async () => {
    const a = await insertTender('go-it-services', { contentHash: 'us1-xdel-a', source: 'us1-xdel-a' });
    const b = await insertTender('go-it-services', { contentHash: 'us1-xdel-b', source: 'us1-xdel-b' });
    const doc = await upload(a.id, pdfFile('go-it-services'));
    expect(doc.status).toBe(201);
    const r = await request(ctx.app, 'DELETE', `/tenders/${b.id}/documents/${doc.body.id}`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
    expect((await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, doc.body.id)))).toHaveLength(1);
  });

  it('concurrent DELETEs of the same document: exactly one 204 and one audit entry (FR-009)', async () => {
    const t = await insertTender('go-it-services', { contentHash: 'us1-racedel', source: 'us1-racedel' });
    const doc = await upload(t.id, pdfFile('go-it-services', 'Race.pdf'));
    const url = `/tenders/${t.id}/documents/${doc.body.id}`;
    const res = await Promise.all([1, 2, 3].map(() => request(ctx.app, 'DELETE', url, { cookie: roles.analyst.cookie })));
    expect(res.map((r) => r.status).sort()).toEqual([204, 404, 404]);
    const log = await ctx.db.select().from(activityLog).where(and(eq(activityLog.orgId, roles.orgId), eq(activityLog.entityId, t.id), eq(activityLog.action, 'tender.document_removed')));
    expect(log).toHaveLength(1);
  });

  it('GeM-fetched documents cannot be removed (403 forbidden)', async () => {
    const t = await insertTender('go-it-services', { bidNumber: 'GEM/2026/B/7000103', contentHash: 'us1-gemdel', source: 'us1-gemdel', gemBidId: 'go-it-services' });
    const f = await request(ctx.app, 'POST', `/tenders/${t.id}/fetch-documents`, { cookie: roles.analyst.cookie });
    expect(f.status).toBe(201);
    const r = await request(ctx.app, 'DELETE', `/tenders/${t.id}/documents/${f.body.items[0].id}`, { cookie: roles.owner.cookie });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'forbidden', message: 'Documents fetched from GeM are shared and cannot be removed' });
    expect((await request(ctx.app, 'GET', `/tenders/${t.id}/documents`, { cookie: roles.analyst.cookie })).body.total).toBe(1);
  });
});

describe('US2 extraction: new keys and document check (FR-010, FR-019, T036)', () => {
  const analyse = (id: string) => request(ctx.app, 'POST', `/tenders/${id}/analyse`, { cookie: roles.analyst.cookie });
  const put = (id: string, file: File) => request(ctx.app, 'POST', `/tenders/${id}/documents`, { cookie: roles.analyst.cookie, form: { file, kind: 'bid' } });

  it('go-it-services.pdf rules-only: 32 requirements incl. bid_published_at and consignee_state; no document check prefix', async () => {
    const t = await insertTender('go-it-services', { contentHash: 'us2-keys', source: 'us2-keys', state: null });
    expect((await put(t.id, pdfFile('go-it-services'))).status).toBe(201);
    const r = await analyse(t.id);
    expect(r.status).toBe(201);
    expect(r.body.method).toBe('rules');
    expect(r.body.requirements).toHaveLength(32);
    expect(r.body.requirements.every((x: any) => x.method === 'RULE')).toBe(true);
    const by = (k: string) => r.body.requirements.find((x: any) => x.key === k);
    expect(by('bid_published_at')).toMatchObject({ value: '2026-11-28T00:00:00+05:30', source: { page: 1, fileName: 'go-it-services.pdf' } });
    expect(by('consignee_state')).toMatchObject({ value: 'Delhi', confidence: 0.8, source: { page: 3 } });
    expect(by('contract_period')).toBeUndefined();
    expect(r.body.summary).not.toMatch(/^Check documents/);
    // No listing state → delivery uses the consignee state from the PDF (Delhi is an operating state).
    expect(r.body.factors.find((f: any) => f.key === 'deliveryFeasibility').detail).toBe('Delivery period of 30 days to Delhi looks feasible.');
  });

  it('a document printed with another bid number: analysis runs, summary starts "Check documents: …" and survives overrides (US2 #13)', async () => {
    const t = await insertTender('review-hardware-oem', { contentHash: 'us2-mismatch', source: 'us2-mismatch' }); // GEM/2026/B/6133872
    expect((await put(t.id, pdfFile('go-it-services'))).status).toBe(201); // printed GEM/2026/B/6120451
    const r = await analyse(t.id);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('done');
    expect(r.body.summary).toMatch(/^Check documents: go-it-services\.pdf is for GEM\/2026\/B\/6120451\. (Go|Review|No-Go) — \d+\/100/);
    const got = await request(ctx.app, 'GET', `/tenders/${t.id}/analysis`, { cookie: roles.viewer.cookie });
    expect(got.body.summary.startsWith('Check documents: go-it-services.pdf is for GEM/2026/B/6120451. ')).toBe(true);
    const ov = await request(ctx.app, 'POST', `/analyses/${r.body.id}/override`, { cookie: roles.bidManager.cookie, json: { factorKey: 'timeToClose', status: 'fail', reason: 'Too little time' } });
    expect(ov.status).toBe(200);
    expect(ov.body.summary.startsWith('Check documents: go-it-services.pdf is for GEM/2026/B/6120451. ')).toBe(true);
    expect(ov.body.summary.match(/Check documents/g)).toHaveLength(1);
  });

  it('several mismatching documents are listed together; matching documents are not', async () => {
    const t = await insertTender('nogo-experience', { contentHash: 'us2-mismatch2', source: 'us2-mismatch2' }); // GEM/2026/B/6140019
    await put(t.id, pdfFile('nogo-experience'));
    await put(t.id, pdfFile('go-it-services', 'old.pdf'));
    await put(t.id, pdfFile('emd-exempt-mse', 'other.pdf'));
    const r = await analyse(t.id);
    expect(r.body.summary).toMatch(/^Check documents: old\.pdf is for GEM\/2026\/B\/6120451; other\.pdf is for GEM\/2026\/B\/6151234\. /);
  });
});
