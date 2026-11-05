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
import { SCANNED_DOCUMENT_MESSAGE, analyseTender } from '../src/services/analyse';
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
function fakeOcr(opts: {
  fail?: Error; text?: (part: number, page: number) => string; seen?: LlmRequest[];
  /** No usage reported: the call never reached the model (e.g. connection refused). */
  unreached?: boolean;
  /** Pages (part-relative) left out of the reply. */
  omit?: number[];
  inputTokens?: number;
  /** Runs inside the call, before the reply. */
  during?: () => Promise<void>;
} = {}): LlmClient {
  const seen = opts.seen ?? [];
  return {
    model: 'claude-opus-5-5',
    complete: async () => { throw new Error('not used'); },
    completeJson: async <T>(req: LlmRequest, o?: { onUsage?: (r: { model: string; usage: { inputTokens: number; outputTokens: number } }) => void }) => {
      seen.push(req);
      const part = seen.length;
      await opts.during?.();
      if (!opts.unreached) o?.onUsage?.({ model: 'claude-opus-5-5', usage: { inputTokens: opts.inputTokens ?? 1500, outputTokens: 400 } });
      if (opts.fail) throw opts.fail;
      const pdf = await PDFDocument.load(Buffer.from(req.documents![0]!.source.data, 'base64'));
      const count = pdf.getPageCount();
      const text = opts.text ?? ((_part: number, page: number) => bidPages[page - 1] ?? '');
      return { pages: Array.from({ length: count }, (_, i) => ({ page: i + 1, text: text(part, i + 1) })).filter((p) => !opts.omit?.includes(p.page)) } as T;
    },
  };
}

/** Distinct AI slots (`analysis_ref`s) the org used this month — what `llmAnalysesPerMonth` counts. */
const aiSlots = async (_orgId: string, cookie: string) => {
  const r = await request(ctx.app, 'GET', '/org/usage', { cookie });
  expect(r.status, r.text).toBe(200);
  return r.body.usage.llmAnalysesThisMonth as number;
};

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
    // Review B1: the run is metered under its own analysis_ref (one AI slot), with no analysis.
    const usage = await ctx.db.select().from(llmUsage).where(and(eq(llmUsage.orgId, roles.orgId), eq(llmUsage.inputTokens, 1500)));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: 'extract', analysisId: null, reserved: false, model: 'claude-opus-5-5' });
    expect(usage[0]!.analysisRef).toEqual(expect.any(String));

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

  it('splits a long scan into parts of 5 pages and stitches them at their real page numbers', async () => {
    const t = await newTender();
    const doc = await upload(t.id, await scanPdf(12), 'long-scan.pdf');
    const seen: LlmRequest[] = [];
    const ocr = fakeOcr({ seen, text: (part, page) => `Part ${part} page ${page}` });
    const r = await request(appWith({ ocr }), 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(r.status, r.text).toBe(200);
    expect(seen).toHaveLength(3);
    for (const q of seen) expect(q.maxTokens).toBeLessThanOrEqual(7_500);
    const [row] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, doc.id));
    const pages = splitPages(row!.text);
    expect(pages).toHaveLength(12);
    expect([pages[0], pages[4], pages[5], pages[10], pages[11]]).toEqual(['Part 1 page 1', 'Part 1 page 5', 'Part 2 page 1', 'Part 3 page 1', 'Part 3 page 2']);
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

describe('manual OCR: quota, partial replies, races, force (review B1, S3)', () => {
  it('each run takes one monthly AI slot; a run that reached the model keeps it even when it fails; 402 once the slots are used up', async () => {
    const org = await seedOrgWithRoles(ctx.app, 'Quota Scan Co'); // trial: 10 AI slots
    // 8 slots already used this month by earlier AI analyses.
    for (let i = 0; i < 8; i++) {
      await ctx.db.insert(llmUsage).values({ orgId: org.orgId, analysisRef: crypto.randomUUID(), kind: 'extract', model: 'm', inputTokens: 1, outputTokens: 1, createdAt: ctx.clock.now() });
    }
    const t = await newTender();
    const a = await upload(t.id, await scanPdf(2), 'a.pdf', org.analyst.cookie);
    const b = await upload(t.id, await scanPdf(2), 'b.pdf', org.analyst.cookie);
    const c = await upload(t.id, await scanPdf(2), 'c.pdf', org.analyst.cookie);
    expect(await aiSlots(org.orgId, org.owner.cookie)).toBe(8);

    // A call that never reached the model (no usage reported) costs nothing: the reservation is given back.
    const down = await request(appWith({ ocr: fakeOcr({ fail: new LlmError('connect ECONNREFUSED'), unreached: true }) }), 'POST', `/tenders/${t.id}/documents/${a.id}/ocr`, { cookie: org.analyst.cookie });
    expect(down.status).toBe(502);
    expect(await aiSlots(org.orgId, org.owner.cookie)).toBe(8);

    const ok = await request(appWith({ ocr: fakeOcr() }), 'POST', `/tenders/${t.id}/documents/${a.id}/ocr`, { cookie: org.analyst.cookie });
    expect(ok.status, ok.text).toBe(200);
    expect(await aiSlots(org.orgId, org.owner.cookie)).toBe(9);

    // The model answered but the transcription is unusable → 502, and the slot is still used (no free retries).
    const bad = await request(appWith({ ocr: fakeOcr({ text: () => '' }) }), 'POST', `/tenders/${t.id}/documents/${b.id}/ocr`, { cookie: org.analyst.cookie });
    expect(bad.status).toBe(502);
    expect(await aiSlots(org.orgId, org.owner.cookie)).toBe(10);

    const seen: LlmRequest[] = [];
    for (const d of [b, c]) {
      const r = await request(appWith({ ocr: fakeOcr({ seen }) }), 'POST', `/tenders/${t.id}/documents/${d.id}/ocr`, { cookie: org.analyst.cookie });
      expect(r.status).toBe(402);
      expect(r.body.error).toMatchObject({ code: 'plan_limit_reached', details: { limit: 'llmAnalysesPerMonth', used: 10, max: 10 } });
    }
    expect(seen).toHaveLength(0);
    const [row] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, b.id));
    expect(row!.textSource).toBe('pdf');
    expect(await aiSlots(org.orgId, org.owner.cookie)).toBe(10);
  });

  it('a reply that leaves out a page → 502 ocr_failed and nothing is stored; an explicitly blank page is fine', async () => {
    const t = await newTender();
    const doc = await upload(t.id, await scanPdf(3), 'partial.pdf');
    const r = await request(appWith({ ocr: fakeOcr({ omit: [2] }) }), 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('ocr_failed');
    const [row] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, doc.id));
    expect(row).toMatchObject({ textSource: 'pdf' });

    const blank = await request(appWith({ ocr: fakeOcr({ text: (_part, page) => (page === 2 ? '' : `Page ${page} text`) }) }), 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(blank.status, blank.text).toBe(200);
    const [after] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, doc.id));
    expect(splitPages(after!.text)).toEqual(['Page 1 text', '', 'Page 3 text']);
  });

  it('two concurrent runs on one document: one stores its text (200), the other answers 409 and stores nothing', async () => {
    const t = await newTender();
    const doc = await upload(t.id, await scanPdf(1), 'race.pdf');
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const during = async () => { if (++arrived === 2) release(); await gate; };
    const app = appWith({ ocr: fakeOcr({ during, text: () => 'raced text' }) });
    const [x, y] = await Promise.all([1, 2].map(() => request(app, 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.analyst.cookie })));
    expect([x!.status, y!.status].sort()).toEqual([200, 409]);
    expect([x!, y!].find((r) => r.status === 409)!.body.error.code).toBe('conflict');
    const acts = await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, t.id), eq(activityLog.action, 'tender.document_ocr')));
    expect(acts).toHaveLength(1);
  });

  it('a document removed while it is being read → 404', async () => {
    const t = await newTender();
    const doc = await upload(t.id, await scanPdf(1), 'gone.pdf');
    const during = async () => { await ctx.db.delete(tenderDocuments).where(eq(tenderDocuments.id, doc.id)); };
    const r = await request(appWith({ ocr: fakeOcr({ during }) }), 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });

  it('?force=1 (bid_manager+) re-reads a document whose text came from OCR and replaces it; analysts get 403, text PDFs 409', async () => {
    const t = await newTender();
    const doc = await upload(t.id, await scanPdf(2), 'reocr.pdf');
    const first = await request(appWith({ ocr: fakeOcr({ text: (_p, page) => `old ${page}` }) }), 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(first.status).toBe(200);
    const a = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(a.status, a.text).toBe(201);
    ctx.clock.advance(1000);

    const app = appWith({ ocr: fakeOcr({ text: (_p, page) => `new ${page}` }) });
    expect((await request(app, 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: roles.bidManager.cookie })).status).toBe(409);
    const analyst = await request(app, 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr?force=1`, { cookie: roles.analyst.cookie });
    expect(analyst.status).toBe(403);
    const forced = await request(app, 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr?force=1`, { cookie: roles.bidManager.cookie });
    expect(forced.status, forced.text).toBe(200);
    expect(forced.body).toMatchObject({ textSource: 'ocr', needsOcr: false, hasText: true });
    const [row] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, doc.id));
    expect(splitPages(row!.text)).toEqual(['new 1', 'new 2']);
    const acts = await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, t.id), eq(activityLog.action, 'tender.document_ocr')));
    expect(acts.map((x) => (x.meta as { force?: boolean }).force ?? false).sort()).toEqual([false, true]);
    const [stale] = await ctx.db.select().from(analyses).where(eq(analyses.id, a.body.id));
    expect(stale).toMatchObject({ stale: true, staleReason: 'document_added' });

    const text = await upload(t.id, await generateBidPdf(getSampleBidSpec('go-it-services')!), 'text.pdf');
    expect((await request(app, 'POST', `/tenders/${t.id}/documents/${text.id}/ocr?force=1`, { cookie: roles.owner.cookie })).status).toBe(409);
  });
});

describe('needsOcr on the document DTO (review S7)', () => {
  it('a scan needs OCR until it is transcribed; a text PDF never does', async () => {
    const t = await newTender();
    const scan = await upload(t.id, await scanPdf(2), 'scan.pdf');
    const text = await upload(t.id, await generateBidPdf(getSampleBidSpec('go-it-services')!), 'bid.pdf');
    expect((scan as unknown as { needsOcr: boolean }).needsOcr).toBe(true);
    expect((text as unknown as { needsOcr: boolean }).needsOcr).toBe(false);
    const r = await request(appWith({ ocr: fakeOcr() }), 'POST', `/tenders/${t.id}/documents/${scan.id}/ocr`, { cookie: roles.analyst.cookie });
    expect(r.body.needsOcr).toBe(false);
    const list = await request(ctx.app, 'GET', `/tenders/${t.id}/documents`, { cookie: roles.viewer.cookie });
    expect(list.body.items.map((d: { needsOcr: boolean }) => d.needsOcr)).toEqual([false, false]);
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

  it('caps automatic OCR at 4 calls (20 pages): a 25-page scan is skipped with a note, the readable bid is analysed', async () => {
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

  it('review S2: a failed automatic OCR holds no AI slot, is recorded, and the next analyse does not OCR it again; manual OCR still can', async () => {
    const org = await seedOrgWithRoles(ctx.app, 'Orphan Scan Co');
    const t = await newTender();
    const doc = await upload(t.id, await scanPdf(2), 'flaky-scan.pdf', org.analyst.cookie);
    const seen: LlmRequest[] = [];
    const app = appWith({ ocr: fakeOcr({ seen, fail: new LlmError('The model reply was cut off (stop_reason: max_tokens)'), inputTokens: 4242 }) });
    const r = await request(app, 'POST', `/tenders/${t.id}/analyse`, { cookie: org.analyst.cookie });
    expect(r.status).toBe(422);
    expect(seen).toHaveLength(1);
    // The tokens are recorded, but no analysis exists, so they hold no AI slot.
    const rows = await ctx.db.select().from(llmUsage).where(and(eq(llmUsage.orgId, org.orgId), eq(llmUsage.inputTokens, 4242)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ analysisRef: null, analysisId: null });
    expect(await aiSlots(org.orgId, org.owner.cookie)).toBe(0);
    const failed = await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, t.id), eq(activityLog.action, 'tender.document_ocr_failed')));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.meta).toMatchObject({ documentId: doc.id, fileName: 'flaky-scan.pdf', reason: 'call' });

    ctx.clock.advance(1000);
    const again = await request(app, 'POST', `/tenders/${t.id}/analyse`, { cookie: org.analyst.cookie });
    expect(again.status).toBe(422);
    expect(again.body.error.details).toMatchObject({ ocrFailed: ['flaky-scan.pdf'] });
    expect(seen).toHaveLength(1);

    // An explicit "Read with AI (OCR)" ignores the marker.
    const manual = await request(appWith({ ocr: fakeOcr() }), 'POST', `/tenders/${t.id}/documents/${doc.id}/ocr`, { cookie: org.analyst.cookie });
    expect(manual.status, manual.text).toBe(200);
  });

  it('review S2: automatic OCR followed by a 409 (a run started meanwhile) leaves no orphan AI slot', async () => {
    const org = await seedOrgWithRoles(ctx.app, 'Race Scan Co');
    const t = await newTender();
    await upload(t.id, await scanPdf(1), 'race-scan.pdf', org.analyst.cookie);
    const during = async () => {
      await ctx.db.insert(analyses).values({ orgId: org.orgId, tenderId: t.id, status: 'running', method: 'rules', createdBy: org.analyst.me.user.id, createdAt: ctx.clock.now() });
    };
    const r = await request(appWith({ ocr: fakeOcr({ during, inputTokens: 4343 }) }), 'POST', `/tenders/${t.id}/analyse`, { cookie: org.analyst.cookie });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('analysis_running');
    const rows = await ctx.db.select().from(llmUsage).where(and(eq(llmUsage.orgId, org.orgId), eq(llmUsage.inputTokens, 4343)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.analysisRef).toBeNull();
    expect(await aiSlots(org.orgId, org.owner.cookie)).toBe(0);
  });

  it('review S4: automatic OCR calls count towards the analysis call cap', async () => {
    const t = await newTender();
    await upload(t.id, await generateBidPdf(getSampleBidSpec('go-it-services')!), 'bid.pdf');
    await upload(t.id, await scanPdf(10), 'ten-page-scan.pdf'); // 2 OCR calls
    const ocrSeen: LlmRequest[] = [];
    const llmSeen: LlmRequest[] = [];
    const llm: LlmClient = {
      model: 'sonnet', complete: async () => { throw new Error('not used'); },
      completeJson: async <T>(req: LlmRequest) => { llmSeen.push(req); return { requirements: [] } as T; },
    };
    const deps = { ...ctx.deps, llm, llmFor: (p: string) => (p === 'ocr' ? fakeOcr({ seen: ocrSeen }) : p === 'enrichment' ? llm : null) } as AppDeps;
    const { analysis } = await analyseTender(deps, { orgId: roles.orgId, userId: roles.analyst.me.user.id, tenderId: t.id, viewer: {} }, { llmBudget: { maxCalls: 3 } });
    expect(ocrSeen).toHaveLength(2);
    expect(llmSeen).toHaveLength(1); // 3 − 2 OCR calls
    expect(analysis.warnings).toEqual([{ code: 'llm_budget_exhausted', covered: 1, total: 2 }]);
    const usage = await ctx.db.select().from(llmUsage).where(eq(llmUsage.analysisRef, analysis.id));
    expect(usage).toHaveLength(3);
  });
});
