/**
 * US7 enrichment tiers (004 T087 chunking FR-051, T088 escalation FR-050). Fake LLM clients only.
 * Run: TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test pnpm exec vitest run test/analyse-llm-tiers.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { analyses, llmUsage, organizations, tenderDocuments, tenders } from '@tp/db';
import { generateBidPdf, getSampleBidSpec } from '@tp/core/analyse/sample-bid';
import { PAGE_SEPARATOR } from '@tp/core/analyse/pdf-text';
import { analyseTender } from '../src/services/analyse';
import type { LlmClient } from '../src/deps';
import { createApp } from '../src/app';
import { createTestContext, request, seedOrgWithRoles, type TestContext } from './helpers';

let ctx: TestContext;
let roles: Awaited<ReturnType<typeof seedOrgWithRoles>>;
let n = 0;

beforeAll(async () => {
  ctx = await createTestContext({ now: '2026-11-04T04:30:00Z' });
  roles = await seedOrgWithRoles(ctx.app, 'Tier Co');
  await ctx.db.update(organizations).set({ plan: 'pro' }).where(eq(organizations.id, roles.orgId));
});
afterAll(() => ctx?.close());

type Req = { system?: string; prompt: string; maxTokens?: number; jsonSchema?: Record<string, unknown> };
function fake(model: string, reply: (req: Req, i: number) => unknown, seen: Req[] = []): LlmClient {
  return {
    model,
    complete: async () => ({ text: '', model, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }),
    completeJson: async <T>(req: Req, o?: { onUsage?: (r: { model: string; usage: { inputTokens: number; outputTokens: number } }) => void }) => {
      seen.push(req);
      o?.onUsage?.({ model, usage: { inputTokens: 100, outputTokens: 20 } });
      return reply(req, seen.length - 1) as T;
    },
  };
}

async function tenderWithText(pages: string[], fileName = 'long.pdf') {
  n++;
  const [t] = await ctx.db.insert(tenders).values({
    bidNumber: `GEM/2026/B/95${String(n).padStart(5, '0')}`, title: 'Tiers', sourceUrl: `https://bidplus.gem.gov.in/all-bids#t${n}`,
    contentHash: `tiers-${n}`, endAt: new Date('2026-11-28T09:30:00Z'),
  }).returning();
  await ctx.db.insert(tenderDocuments).values({
    tenderId: t!.id, orgId: roles.orgId, kind: 'bid', fileName, blobKey: `org/${roles.orgId}/tender/${n}.pdf`, sizeBytes: 100,
    pageCount: pages.length, totalPages: pages.length, text: pages.join(PAGE_SEPARATOR),
  });
  return t!;
}
const run = (tenderId: string, llm: LlmClient, llmEscalation: LlmClient | null = null, opts = {}) =>
  analyseTender({ ...ctx.deps, llm, llmFor: (p) => (p === 'escalation' ? llmEscalation : p === 'enrichment' ? llm : null) },
    { orgId: roles.orgId, userId: roles.analyst.me.user.id, tenderId, viewer: {} }, opts);

describe('chunked enrichment (T087, FR-051)', () => {
  const longPages = (count: number) => Array.from({ length: count }, (_, i) => `Page text ${i + 1} ` + 'terms and conditions of the bid '.repeat(800));

  it('a ~100k-character document is read in page-aligned chunks of ≤ 60k, with real page numbers, and the results are merged', async () => {
    const t = await tenderWithText(longPages(4)); // 4 pages × ~25.6k chars
    const seen: Req[] = [];
    const llm = fake('s', (_r, i) => ({ requirements: [{ key: 'certificate', label: `Cert ${i}`, value: `CERT-${i}`, page: 1, quote: 'q', confidence: 0.8 }] }), seen);
    const { analysis } = await run(t.id, llm);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.prompt).toContain('=== Page 1 ===');
    expect(seen[1]!.prompt).toContain('=== Page 3 ===');
    expect(seen[1]!.prompt).not.toContain('=== Page 2 ===');
    for (const r of seen) expect(r.prompt.length).toBeLessThan(62_000);
    expect(analysis.requirements.filter((r) => r.key === 'certificate').map((r) => r.value)).toEqual(['CERT-0', 'CERT-1']);
    expect(analysis).toMatchObject({ method: 'rules+llm', warnings: [], notes: [] });
  });

  it('reads at most 4 chunks per document and records the rest in notes', async () => {
    const t = await tenderWithText(longPages(12), 'X.pdf'); // 12 × 25.6k → 4 chunks of 2 pages, pages 9–12 unread
    const seen: Req[] = [];
    const { analysis } = await run(t.id, fake('s', () => ({ requirements: [] }), seen));
    expect(seen).toHaveLength(4);
    expect(analysis.notes).toEqual(['Pages 9–12 of X.pdf were not read by AI']);
    expect(analysis.warnings).toEqual([]);
  });

  it('never makes more than 8 calls per analysis; chunks skipped for budget are noted and warned about', async () => {
    const t = await tenderWithText(longPages(12), 'Y.pdf');
    const seen: Req[] = [];
    const { analysis } = await run(t.id, fake('s', () => ({ requirements: [] }), seen), null, { llmBudget: { maxCalls: 2 } });
    expect(seen).toHaveLength(2);
    expect(analysis.notes).toEqual(['Pages 5–12 of Y.pdf were not read by AI']);
    expect(analysis.warnings).toEqual([{ code: 'llm_budget_exhausted', covered: 0, total: 1 }]);
  });

  it('a failed chunk falls back to the rules for those pages only (noted); the other chunk still counts', async () => {
    const t = await tenderWithText(longPages(4), 'Z.pdf');
    const llm = fake('s', (_r, i) => { if (i === 1) throw new Error('overloaded'); return { requirements: [{ key: 'certificate', label: 'ISO', value: 'ISO 9001', confidence: 0.8 }] }; });
    const { analysis } = await run(t.id, llm);
    expect(analysis.method).toBe('rules+llm');
    expect(analysis.notes).toEqual(['Pages 3–4 of Z.pdf were not read by AI']);
    expect(analysis.warnings).toEqual([{ code: 'llm_budget_exhausted', covered: 0, total: 1 }]);
  });
});

describe('chunked enrichment × shared extraction cache (FR-051 × 008/FR-072)', () => {
  const longPages = (count: number) => Array.from({ length: count }, (_, i) => `Page text ${i + 1} ` + 'terms and conditions of the bid '.repeat(800));
  let other: Awaited<ReturnType<typeof seedOrgWithRoles>>;
  beforeAll(async () => {
    other = await seedOrgWithRoles(ctx.app, 'Tier Co B');
    await ctx.db.update(organizations).set({ plan: 'pro' }).where(eq(organizations.id, other.orgId));
  });
  /** A GeM-fetched (public, org_id null) document every org sees. */
  async function gemTenderWithText(pages: string[], fileName: string) {
    n++;
    const [t] = await ctx.db.insert(tenders).values({
      bidNumber: `GEM/2026/B/96${String(n).padStart(5, '0')}`, title: 'Tiers cache', sourceUrl: `https://bidplus.gem.gov.in/all-bids#c${n}`,
      contentHash: `tiers-cache-${n}`, endAt: new Date('2026-11-28T09:30:00Z'),
    }).returning();
    await ctx.db.insert(tenderDocuments).values({
      tenderId: t!.id, orgId: null, kind: 'bid', fileName, blobKey: `gem/tender/${n}.pdf`, sizeBytes: 100,
      pageCount: pages.length, totalPages: pages.length, text: pages.join(PAGE_SEPARATOR),
    });
    return t!;
  }
  const runAs = (org: typeof roles, tenderId: string, llm: LlmClient) =>
    analyseTender({ ...ctx.deps, llm, llmFor: (p) => (p === 'enrichment' ? llm : null) },
      { orgId: org.orgId, userId: org.analyst.me.user.id, tenderId, viewer: {} });
  const certPerCall = (_r: Req, i: number) => ({ requirements: [{ key: 'certificate', label: `Cert ${i}`, value: `CERT-${i}`, page: 1, quote: 'q', confidence: 0.8 }] });

  it('a fully read chunked document is stored (union of the chunks) and another org reuses it with zero LLM calls', async () => {
    const t = await gemTenderWithText(longPages(4), 'gem-long.pdf'); // 2 chunks
    const seenA: Req[] = [];
    const a = await runAs(roles, t.id, fake('s', certPerCall, seenA));
    expect(seenA).toHaveLength(2);
    const [doc] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.tenderId, t.id));
    expect(doc!.extractedMethod).toBe('LLM');
    expect((doc!.requirements ?? []).map((r) => r.value)).toEqual(['CERT-0', 'CERT-1']);

    const seenB: Req[] = [];
    const b = await runAs(other, t.id, fake('s', certPerCall, seenB));
    expect(seenB).toHaveLength(0);
    expect(b.analysis).toMatchObject({ method: 'rules+llm', warnings: [], notes: [] });
    const llmOf = (x: typeof a) => x.analysis.requirements.filter((r) => r.method === 'LLM');
    expect(llmOf(b)).toEqual(llmOf(a));
    expect(await ctx.db.select().from(llmUsage).where(eq(llmUsage.analysisRef, b.analysis.id))).toHaveLength(0);
  });

  it('a document with unread pages (beyond 4 chunks) is NOT stored; the next org calls the LLM again', async () => {
    const t = await gemTenderWithText(longPages(12), 'gem-huge.pdf'); // pages 9–12 unread
    const seen: Req[] = [];
    const a = await runAs(roles, t.id, fake('s', certPerCall, seen));
    expect(seen).toHaveLength(4);
    expect(a.analysis.notes).toEqual(['Pages 9–12 of gem-huge.pdf were not read by AI']);
    const [doc] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.tenderId, t.id));
    expect(doc).toMatchObject({ requirements: null, extractorVersion: null, extractedMethod: null });
    await runAs(other, t.id, fake('s', certPerCall, seen));
    expect(seen).toHaveLength(8);
  });

  it('review S5: a later chunk whose valid reply has no requirements does not block sharing', async () => {
    const t = await gemTenderWithText(longPages(4), 'gem-quiet.pdf'); // 2 chunks; the 2nd has nothing to report
    const seen: Req[] = [];
    await runAs(roles, t.id, fake('s', (r, i) => (i === 0 ? certPerCall(r, i) : { requirements: [] }), seen));
    expect(seen).toHaveLength(2);
    const [doc] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.tenderId, t.id));
    expect(doc!.extractedMethod).toBe('LLM');
    expect((doc!.requirements ?? []).map((r) => r.value)).toEqual(['CERT-0']);
  });

  it('review S5: a malformed reply on a later chunk, or an empty first chunk, still blocks sharing', async () => {
    const garbled = await gemTenderWithText(longPages(4), 'gem-garbled.pdf');
    await runAs(roles, garbled.id, fake('s', (r, i) => (i === 0 ? certPerCall(r, i) : { nope: true })));
    const emptyFirst = await gemTenderWithText(longPages(4), 'gem-empty-first.pdf');
    await runAs(roles, emptyFirst.id, fake('s', (r, i) => (i === 0 ? { requirements: [] } : certPerCall(r, i))));
    for (const t of [garbled, emptyFirst]) {
      const [doc] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.tenderId, t.id));
      expect(doc).toMatchObject({ requirements: null, extractorVersion: null, extractedMethod: null });
    }
  });

  it('review S5: a single page longer than the chunk limit is not a whole read — not stored, noted as partly read', async () => {
    const t = await gemTenderWithText(['Huge page ' + 'terms and conditions of the bid '.repeat(2_300)], 'gem-one-page.pdf'); // ~73k chars
    const seen: Req[] = [];
    const a = await runAs(roles, t.id, fake('s', certPerCall, seen));
    expect(seen).toHaveLength(1);
    expect(a.analysis.notes).toEqual(['Page 1 of gem-one-page.pdf was only partly read by AI']);
    const [doc] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.tenderId, t.id));
    expect(doc).toMatchObject({ requirements: null, extractedMethod: null });
  });

  it('a failed chunk or an OCR-derived document is NOT stored', async () => {
    const failed = await gemTenderWithText(longPages(4), 'gem-fail.pdf');
    await runAs(roles, failed.id, fake('s', (r, i) => { if (i === 1) throw new Error('overloaded'); return certPerCall(r, i); }));
    const ocr = await gemTenderWithText(longPages(2), 'gem-ocr.pdf');
    await ctx.db.update(tenderDocuments).set({ textSource: 'ocr' }).where(eq(tenderDocuments.tenderId, ocr.id));
    const seen: Req[] = [];
    await runAs(roles, ocr.id, fake('s', certPerCall, seen));
    expect(seen).toHaveLength(1);
    for (const t of [failed, ocr]) {
      const [doc] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.tenderId, t.id));
      expect(doc).toMatchObject({ requirements: null, extractorVersion: null, extractedMethod: null });
    }
  });
});

describe('escalation (T088, FR-050, FR-048)', () => {
  const spec = getSampleBidSpec('go-it-services')!;
  async function sampleText() {
    const { extractPdf } = await import('@tp/core/analyse/pdf-text');
    return (await extractPdf(await generateBidPdf(spec))).pages;
  }
  const EMD = spec.emd!.amount;
  const conflicting = { requirements: [{ key: 'emd', label: 'EMD amount', value: String(EMD + 1), numeric: EMD + 1, mandatory: true, page: 1, quote: 'EMD other', confidence: 0.8 }] };
  const adjudicated = { requirements: [{ key: 'emd', label: 'EMD amount', value: String(EMD + 5), numeric: EMD + 5, mandatory: true, page: 1, quote: `EMD Amount ${EMD + 5}`, confidence: 0.85 }] };

  it('rule/LLM conflict on a blocking key + an escalation model whose quote is not on the page → the confident rule item stays, marked needsReview (review S9)', async () => {
    const t = await tenderWithText(await sampleText(), 'bid.pdf');
    const esc: Req[] = [];
    const { analysis } = await run(t.id, fake('sonnet', () => conflicting), fake('fable', () => adjudicated, esc));
    expect(esc).toHaveLength(1);
    expect(esc[0]!.prompt).toContain('emd');
    expect(esc[0]!.prompt).toContain(String(EMD + 1));
    const emd = analysis.requirements.find((r) => r.key === 'emd')!;
    expect(emd).toMatchObject({ method: 'RULE', numeric: EMD });
    expect(emd.needsReview).toContain(`EMD Amount ${EMD + 5}`);
    // Metered under the same analysis with the escalation model's tokens; still one AI analysis.
    const usage = await ctx.db.select().from(llmUsage).where(eq(llmUsage.analysisRef, analysis.id));
    expect(usage.map((u) => u.model).sort()).toEqual(['fable', 'sonnet']);
  });

  it('an adjudicator that confirms the rule leaves the rule item in place', async () => {
    const t = await tenderWithText(await sampleText(), 'bid.pdf');
    const confirm = { requirements: [{ ...adjudicated.requirements[0], value: String(EMD), numeric: EMD }] };
    const { analysis } = await run(t.id, fake('sonnet', () => conflicting), fake('fable', () => confirm));
    expect(analysis.requirements.find((r) => r.key === 'emd')).toMatchObject({ method: 'RULE', numeric: EMD });
  });

  it('without an escalation model the rule value is kept (rules beat a conflicting lower-confidence LLM item)', async () => {
    const t = await tenderWithText(await sampleText(), 'bid.pdf');
    const { analysis } = await run(t.id, fake('sonnet', () => conflicting), null);
    expect(analysis.requirements.find((r) => r.key === 'emd')).toMatchObject({ method: 'RULE', numeric: EMD });
  });

  it('no conflict and confident rules → the escalation model is never called; a failing escalation keeps the earlier result', async () => {
    const t = await tenderWithText(await sampleText(), 'bid.pdf');
    const esc: Req[] = [];
    await run(t.id, fake('sonnet', () => ({ requirements: [] })), fake('fable', () => adjudicated, esc));
    expect(esc).toHaveLength(0);
    const boom = fake('fable', () => { throw new Error('down'); });
    const { analysis } = await run(t.id, fake('sonnet', () => conflicting), boom);
    expect(analysis.status).toBe('done');
    expect(analysis.requirements.find((r) => r.key === 'emd')).toMatchObject({ method: 'RULE', numeric: EMD });
    expect((await ctx.db.select().from(analyses).where(eq(analyses.id, analysis.id)))[0]!.status).toBe('done');
  });
});

describe('GET /analysis/capabilities (T089, FR-053)', () => {
  const caps = (deps: Partial<typeof ctx.deps>, cookie = roles.viewer.cookie) => request(createApp({ ...ctx.deps, ...deps }), 'GET', '/analysis/capabilities', { cookie });

  it('requires a session', async () => {
    expect((await request(ctx.app, 'GET', '/analysis/capabilities')).status).toBe(401);
  });

  it('no LLM key → nothing is on', async () => {
    const r = await caps({ llm: null, llmFor: () => null });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ai: false, ocr: false, models: {} });
  });

  it('reports configured tiers with model ids only (any member, no secrets)', async () => {
    const llm = fake('claude-sonnet-5-5', () => ({}));
    const ocr = fake('claude-opus-5-5', () => ({}));
    const r = await caps({ llm, llmFor: (p) => (p === 'enrichment' ? llm : p === 'ocr' ? ocr : null) });
    expect(r.body).toEqual({ ai: true, ocr: true, models: { enrichment: 'claude-sonnet-5-5', ocr: 'claude-opus-5-5' } });
    const all = await caps({ llm, llmFor: () => fake('claude-fable-5-1', () => ({})) }, roles.analyst.cookie);
    expect(all.body.models).toEqual({ enrichment: 'claude-sonnet-5-5', ocr: 'claude-fable-5-1', escalation: 'claude-fable-5-1' });
    expect(JSON.stringify(all.body)).not.toMatch(/key|secret|sk-/i);
  });
});
