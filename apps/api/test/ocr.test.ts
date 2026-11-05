/**
 * US7 OCR for scanned PDFs (004 T091, FR-052): `POST /tenders/:id/documents/:docId/ocr` and analyse's automatic OCR,
 * with a fake OCR-tier client (no network).
 * Run: TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test pnpm exec vitest run test/ocr.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { PDFDocument, rgb } from 'pdf-lib';
import { activityLog, analyses, llmUsage, organizations, tenderDocuments, tenders } from '@tp/db';
import { generateBidPdf, getSampleBidSpec } from '@tp/core/analyse/sample-bid';
import { extractPdf, joinPages, splitPages } from '@tp/core/analyse/pdf-text';
import { OCR_MAX_CONFIDENCE } from '@tp/core/analyse/ocr';
import { createApp } from '../src/app';
import { LlmError } from '../src/adapters/llm';
import type { AppDeps, LlmClient, LlmRequest } from '../src/deps';
import { createMemoryRateLimiter } from '../src/lib/rate-limiter';
import { SCANNED_DOCUMENT_MESSAGE } from '../src/services/analyse';
import { createTestContext, request, seedOrgWithRoles, signup, type TestContext } from './helpers';

let ctx: TestContext;
let roles: Awaited<ReturnType<typeof seedOrgWithRoles>>;
let bidPages: string[];
let n = 0;

/** A PDF of `pages` pages with no text layer (a "scan": only a grey box per page). */
async function scanPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawRectangle({ x: 40, y: 40, width: 500, height: 700, color: rgb(0.9, 0.9, 0.9) });
  return doc.save();
}

/**
 * Fake OCR tier: answers like the structured-output reply `{pages:[{page,text}]}`. `text(page)` gets the 1-based page
 * number inside the attached part; by default it returns the sample bid's page text (so rules find requirements).
 */
function fakeOcr(opts: { fail?: Error; text?: (part: number, page: number) => string; seen?: LlmRequest[] } = {}): LlmClient {
  const seen = opts.seen ?? [];
  return {
    model: 'claude-opus-5-5',
    complete: async () => { throw new Error('not used'); },
    completeJson: async <T>(req: LlmRequest, o?: { onUsage?: (r: { model: string; usage: { inputTokens: number; outputTokens: number } }) => void }) => {
      seen.push(req);
      o?.onUsage?.({ model: 'claude-opus-5-5', usage: { inputTokens: 1500, outputTokens: 400 } });
      if (opts.fail) throw opts.fail;
      const pdf = await PDFDocument.load(Buffer.from(req.documents![0]!.source.data, 'base64'));
      const count = pdf.getPageCount();
      const text = opts.text ?? ((_part: number, page: number) => bidPages[page - 1] ?? '');
      return { pages: Array.from({ length: count }, (_, i) => ({ page: i + 1, text: text(seen.length, i + 1) })) } as T;
    },
  };
}

const appWith = (over: Partial<AppDeps> & { ocr?: LlmClient | null } = {}) => {
  const { ocr = null, ...rest } = over;
  return createApp({ ...ctx.deps, llm: null, ...rest, llmFor: (p) => (p === 'ocr' ? ocr : p === 'enrichment' ? (rest.llm ?? null) : null) });
};

async function newTender() {
  n++;
  const [t] = await ctx.db.insert(tenders).values({
    bidNumber: `GEM/2026/B/97${String(n).padStart(5, '0')}`, title: 'OCR tender', category: 'IT services', sourceUrl: `https://bidplus.gem.gov.in/all-bids#ocr${n}`,
    contentHash: `ocr-${n}`, endAt: new Date('2026-11-28T09:30:00Z'),
  }).returning();
  return t!;
}

async function upload(tenderId: string, bytes: Uint8Array, name: string, cookie = roles.analyst.cookie) {
  const file = new File([bytes as BlobPart], name, { type: 'application/pdf' });
  const r = await request(ctx.app, 'POST', `/tenders/${tenderId}/documents`, { cookie, form: { file, kind: 'bid' } });
  expect(r.status, r.text).toBe(201);
  return r.body as { id: string; hasText: boolean; pageCount: number; totalPages: number };
}

beforeAll(async () => {
  ctx = await createTestContext({ now: '2026-11-04T04:30:00Z' });
  roles = await seedOrgWithRoles(ctx.app, 'Scan Co');
  await ctx.db.update(organizations).set({ plan: 'pro' }).where(eq(organizations.id, roles.orgId));
  bidPages = (await extractPdf(await generateBidPdf(getSampleBidSpec('go-it-services')!), { maxPages: 150 })).pages;
});
afterAll(() => ctx?.close());

describe('POST /tenders/:id/documents/:docId/ocr', () => {
  it('transcribes a scanned upload: text stored with text_source ocr, page count unchanged, activity, metered usage', async () => {
    const t = await newTender();
    const doc = await upload(t.id, await scanPdf(3), 'scan.pdf');
    expect(doc).toMatchObject({ hasText: false, pageCount: 3 });
    const seen: LlmRequest[] = [];
    const r = await request(appWith({ ocr: fakeOcr({ seen }) }), 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ id: doc.id, hasText: true, textSource: 'ocr', pageCount: 3, totalPages: 3 });

    // One call: the PDF as a document block + the fixed instruction, structured output, bounded output.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.documents).toHaveLength(1);
    expect(seen[0]!.documents![0]!.source.media_type).toBe('application/pdf');
    expect(seen[0]!.jsonSchema).toBeTruthy();
    expect(seen[0]!.maxTokens).toBeLessThanOrEqual(16_000);
    expect(seen[0]!.prompt).toMatch(/Transcribe every page/);

    const [row] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, doc.id));
    expect(row!.textSource).toBe('ocr');
    expect(splitPages(row!.text)).toEqual(bidPages.slice(0, 3).map((p) => p.trim()));
    const acts = await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, t.id), eq(activityLog.action, 'tender.document_ocr')));
    expect(acts).toHaveLength(1);
    expect(acts[0]!.meta).toMatchObject({ documentId: doc.id, fileName: 'scan.pdf', pages: 3, calls: 1, trigger: 'manual' });
    expect(JSON.stringify(acts[0]!.meta)).not.toContain(bidPages[0]!.slice(0, 40));
    const usage = await ctx.db.select().from(llmUsage).where(and(eq(llmUsage.orgId, roles.orgId), eq(llmUsage.inputTokens, 1500)));
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect(usage.every((u) => u.kind === 'extract' && u.analysisRef === null)).toBe(true);

    // Requirements read from it are marked as OCR and capped at 0.8.
    const a = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(a.status, a.text).toBe(201);
    const fromDoc = (a.body.requirements as { source: { documentId?: string; ocr?: boolean }; confidence: number }[]).filter((q) => q.source.documentId === doc.id);
    expect(fromDoc.length).toBeGreaterThan(0);
    for (const q of fromDoc) {
      expect(q.source.ocr).toBe(true);
      expect(q.confidence).toBeLessThanOrEqual(OCR_MAX_CONFIDENCE);
    }
    expect(a.body.notes).toEqual([]);

    // Already transcribed → 409.
    const again = await request(appWith({ ocr: fakeOcr() }), 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('conflict');
  });

  it('splits a long scan into parts of 10 pages and stitches them at their real page numbers', async () => {
    const t = await newTender();
    const doc = await upload(t.id, await scanPdf(12), 'long-scan.pdf');
    const seen: LlmRequest[] = [];
    const ocr = fakeOcr({ seen, text: (part, page) => `Part ${part} page ${page}` });
    const r = await request(appWith({ ocr }), 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(r.status, r.text).toBe(200);
    expect(seen).toHaveLength(2);
    const [row] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, doc.id));
    const pages = splitPages(row!.text);
    expect(pages).toHaveLength(12);
    expect([pages[0], pages[9], pages[10], pages[11]]).toEqual(['Part 1 page 1', 'Part 1 page 10', 'Part 2 page 1', 'Part 2 page 2']);
    expect(r.body.pageCount).toBe(12);
  });

  it('409 conflict for a document that already has text', async () => {
    const t = await newTender();
    const doc = await upload(t.id, await generateBidPdf(getSampleBidSpec('go-it-services')!), 'bid.pdf');
    const r = await request(appWith({ ocr: fakeOcr() }), 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('conflict');
  });

  it('503 ocr_unavailable without an OCR model; nothing changes', async () => {
    const t = await newTender();
    const doc = await upload(t.id, await scanPdf(1), 'scan.pdf');
    const r = await request(appWith({ ocr: null }), 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('ocr_unavailable');
    const [row] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, doc.id));
    expect(row!.textSource).toBe('pdf');
  });

  it.each([
    ['the model refuses / errors', fakeOcr({ fail: new LlmError('The model declined to answer (stop_reason: refusal)') })],
    ['the reply has no text', fakeOcr({ text: () => '' })],
  ])('502 ocr_failed when %s; the document is unchanged and nothing is logged as done', async (_name, ocr) => {
    const t = await newTender();
    const doc = await upload(t.id, await scanPdf(2), 'scan.pdf');
    const r = await request(appWith({ ocr }), 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('ocr_failed');
    const [row] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, doc.id));
    expect(row!.textSource).toBe('pdf');
    expect(await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, t.id), eq(activityLog.action, 'tender.document_ocr')))).toEqual([]);
  });

  it('viewer → 403; another org → 404 (its upload is invisible), and the document is untouched', async () => {
    const t = await newTender();
    const doc = await upload(t.id, await scanPdf(1), 'scan.pdf');
    const app = appWith({ ocr: fakeOcr() });
    const v = await request(app, 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.viewer.cookie });
    expect(v.status).toBe(403);
    const other = await signup(ctx.app, { orgName: 'Other Scan Co' });
    const x = await request(app, 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: other.cookie });
    expect(x.status).toBe(404);
    const [row] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, doc.id));
    expect(row!.textSource).toBe('pdf');
  });

  it('is rate limited per org (ocr.org, 20 an hour)', async () => {
    const t = await newTender();
    const app = appWith({ ocr: fakeOcr(), rateLimiter: createMemoryRateLimiter() });
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await request(app, 'POST', `/tenders/${t.id}/documents/${crypto.randomUUID()}/ocr`, { cookie: i % 2 ? roles.analyst.cookie : roles.owner.cookie })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('marks the org’s analyses of the tender stale (document_added), in the same write', async () => {
    const t = await newTender();
    await upload(t.id, await generateBidPdf(getSampleBidSpec('go-it-services')!), 'bid.pdf');
    const scan = await upload(t.id, await scanPdf(2), 'annexure-scan.pdf');
    const a = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(a.status).toBe(201);
    expect(a.body.stale).toBe(false);
    ctx.clock.advance(1000);
    const r = await request(appWith({ ocr: fakeOcr() }), 'POST', `/tenders/${t.id}/documents/${scan.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(200);
    const [row] = await ctx.db.select().from(analyses).where(eq(analyses.id, a.body.id));
    expect(row).toMatchObject({ stale: true, staleReason: 'document_added' });
  });

  it('a shared GeM copy: every org’s analyses of the tender are marked stale', async () => {
    const t = await newTender();
    const blobKey = `tenders/${t.id}/gem/scan.pdf`;
    const bytes = await scanPdf(1);
    await ctx.deps.blobs.put(blobKey, bytes, { contentType: 'application/pdf' });
    const [gem] = await ctx.db.insert(tenderDocuments).values({
      tenderId: t.id, orgId: null, kind: 'bid', fileName: 'gem.pdf', blobKey, sizeBytes: bytes.length, pageCount: 1, totalPages: 1, text: joinPages(['']),
    }).returning();
    const other = await signup(ctx.app, { orgName: 'Other GeM Co' });
    const [theirs] = await ctx.db.insert(analyses).values({ orgId: other.me.org.id, tenderId: t.id, status: 'done', method: 'rules', createdBy: other.me.user.id }).returning();
    const r = await request(appWith({ ocr: fakeOcr() }), 'POST', `/tenders/${t.id}/documents/${gem!.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ source: 'gem', textSource: 'ocr', hasText: true });
    const [after] = await ctx.db.select().from(analyses).where(eq(analyses.id, theirs!.id));
    expect(after).toMatchObject({ stale: true, staleReason: 'document_added' });
  });
});

describe('automatic OCR inside analyse', () => {
  beforeEach(() => ctx.clock.advance(1000));

  it('reads a scanned-only tender with the OCR model, then analyses it; OCR usage is linked to the analysis', async () => {
    const t = await newTender();
    const doc = await upload(t.id, await scanPdf(3), 'only-scan.pdf');
    const seen: LlmRequest[] = [];
    const r = await request(appWith({ ocr: fakeOcr({ seen }) }), 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(r.status, r.text).toBe(201);
    expect(seen).toHaveLength(1);
    expect(r.body.notes).toEqual([]);
    expect(r.body.documents.map((d: { id: string }) => d.id)).toEqual([doc.id]);
    const fromDoc = (r.body.requirements as { source: { documentId?: string; ocr?: boolean }; confidence: number }[]).filter((q) => q.source.documentId === doc.id);
    expect(fromDoc.length).toBeGreaterThan(0);
    expect(fromDoc.every((q) => q.source.ocr === true && q.confidence <= OCR_MAX_CONFIDENCE)).toBe(true);
    // The OCR call counts for this analysis (analysis_ref and, once the row exists, analysis_id).
    const usage = await ctx.db.select().from(llmUsage).where(eq(llmUsage.analysisRef, r.body.id));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ analysisId: r.body.id, kind: 'extract', model: 'claude-opus-5-5', reserved: false });
    const [act] = await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, t.id), eq(activityLog.action, 'tender.document_ocr')));
    expect(act!.meta).toMatchObject({ trigger: 'analysis', calls: 1 });
  });

  it('OCR failure keeps the scanned-document 422 with the existing message', async () => {
    const t = await newTender();
    await upload(t.id, await scanPdf(2), 'bad-scan.pdf');
    const r = await request(appWith({ ocr: fakeOcr({ fail: new LlmError('Anthropic API error 529', 529) }) }), 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'scanned_document', message: SCANNED_DOCUMENT_MESSAGE, details: { documents: ['bad-scan.pdf'], ocrFailed: ['bad-scan.pdf'] } });
  });

  it('caps automatic OCR at 2 calls: a 25-page scan is skipped with a note, the readable bid is analysed', async () => {
    const t = await newTender();
    await upload(t.id, await generateBidPdf(getSampleBidSpec('go-it-services')!), 'bid.pdf');
    await upload(t.id, await scanPdf(25), 'big-scan.pdf');
    const seen: LlmRequest[] = [];
    const r = await request(appWith({ ocr: fakeOcr({ seen }) }), 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(r.status, r.text).toBe(201);
    expect(seen).toHaveLength(0);
    expect(r.body.notes).toEqual([expect.stringMatching(/^big-scan\.pdf is a scan without text and too long to read with AI OCR/)]);
  });

  it('without an OCR model the scan is skipped as before', async () => {
    const t = await newTender();
    await upload(t.id, await scanPdf(1), 'scan.pdf');
    const r = await request(appWith({ ocr: null }), 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'scanned_document', message: SCANNED_DOCUMENT_MESSAGE, details: { documents: ['scan.pdf'] } });
    expect(r.body.error.details.ocrFailed).toBeUndefined();
  });
});
