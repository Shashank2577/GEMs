/**
 * 008/US7 scenarios 1–2 (FR-072, T102): the shared LLM extraction cache on `tender_documents`.
 *  - Two orgs analyse the same GeM-fetched (public, org_id null) document → the fake LLM is called ONCE; org B's
 *    analysis lists the same LLM requirements with provenance; the row records `extracted_method = 'LLM'`.
 *  - A stale `extractor_version` (= CURRENT_EXTRACTOR_VERSION bumped) re-extracts once and updates the row.
 *  - Tenant isolation: an org's OWN upload is never cached and never reused — nothing derived from org A's document can
 *    reach org B, even if cache columns were somehow set on an org-owned row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { tenderDocuments, tenders } from '@tp/db';
import { CURRENT_EXTRACTOR_VERSION } from '@tp/core/analyse/llm';
import { generateBidPdf, getSampleBidSpec } from '@tp/core/analyse/sample-bid';
import { createApp } from '../src/app';
import { cachedExtraction } from '../src/services/analyse';
import type { LlmClient } from '../src/deps';
import { createTestContext, request, seedOrgWithRoles, type TestContext } from './helpers';

let ctx: TestContext;
let A: Awaited<ReturnType<typeof seedOrgWithRoles>>;
let B: Awaited<ReturnType<typeof seedOrgWithRoles>>;
const pdfs: Record<string, Uint8Array> = {};
const gemCalls: string[] = [];
/** Every LLM prompt, so a test can see which documents were sent. */
const llmPrompts: string[] = [];

const gemFetch: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  gemCalls.push(url);
  const m = url.match(/\/showbidDocument\/(.+)$/);
  if (m && pdfs[m[1]]) return new Response(pdfs[m[1]] as BodyInit, { status: 200, headers: { 'content-type': 'application/pdf' } });
  return new Response('not found', { status: 404 });
};

/** Fake LLM: adds one requirement whose label names the call number, so reuse is visible. */
const fakeLlm: LlmClient = {
  model: 'fake',
  complete: async () => ({ text: '', model: 'fake', stopReason: null, usage: { inputTokens: 0, outputTokens: 0 } }),
  completeJson: async <T>(req: { prompt: string }) => {
    llmPrompts.push(req.prompt);
    return { requirements: [{ key: 'certificate', label: `Cache test licence (call ${llmPrompts.length})`, value: `Cache test licence ${llmPrompts.length}`, page: 2, quote: 'cache test licence', confidence: 0.8 }] } as T;
  },
};

async function gemTender(key: string, bidNumber: string) {
  const spec = getSampleBidSpec(key)!;
  const [t] = await ctx.db.insert(tenders).values({
    bidNumber, title: spec.itemCategory, category: spec.itemCategory, ministry: spec.ministry, state: spec.consignee.state,
    endAt: new Date(Date.now() + 10 * 86_400_000), estimatedValue: spec.estimatedValue ?? null, gemBidId: key,
    sourceUrl: `https://bidplus.gem.gov.in/all-bids#${bidNumber}`, contentHash: `cache-${bidNumber}`,
  }).returning();
  return t;
}

const analyse = (cookie: string, tenderId: string) => request(createApp({ ...ctx.deps, llm: fakeLlm }), 'POST', `/tenders/${tenderId}/analyse`, { cookie });
const llmReqs = (body: { requirements: { method: string; label: string; source: { documentId?: string } }[] }) => body.requirements.filter((r) => r.method === 'LLM');

beforeAll(async () => {
  ctx = await createTestContext({ gemBaseUrl: 'https://bidplus.gem.gov.in', fetch: gemFetch });
  for (const k of ['go-it-services', 'review-hardware-oem']) pdfs[k] = await generateBidPdf(getSampleBidSpec(k)!);
  A = await seedOrgWithRoles(ctx.app, 'Cache Org A');
  B = await seedOrgWithRoles(ctx.app, 'Cache Org B');
});
afterAll(() => ctx?.close());

describe('shared extraction cache for GeM documents (US7 scenario 1)', () => {
  it('org A analyses → 1 LLM call; org B analyses the same tender → 0 new calls, same requirements with provenance', async () => {
    const t = await gemTender('go-it-services', 'GEM/2026/B/8800001');
    llmPrompts.length = 0;
    const a = await analyse(A.analyst.cookie, t.id);
    expect(a.status, a.text).toBe(201);
    expect(llmPrompts).toHaveLength(1);
    expect(a.body.method).toBe('rules+llm');
    const [doc] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.tenderId, t.id));
    expect(doc.orgId).toBeNull();
    expect(doc).toMatchObject({ extractedMethod: 'LLM', extractorVersion: CURRENT_EXTRACTOR_VERSION });
    expect(doc.extractedAt).toBeInstanceOf(Date);
    expect(doc.requirements).toEqual([expect.objectContaining({ key: 'certificate', label: 'Cache test licence (call 1)', method: 'LLM' })]);

    const b = await analyse(B.analyst.cookie, t.id);
    expect(b.status, b.text).toBe(201);
    expect(llmPrompts).toHaveLength(1); // 0 new extraction calls for D
    expect(b.body.method).toBe('rules+llm');
    expect(b.body.warnings).toEqual([]);
    expect(llmReqs(b.body)).toEqual(llmReqs(a.body));
    expect(llmReqs(b.body)[0]).toMatchObject({ label: 'Cache test licence (call 1)', source: { documentId: doc.id, fileName: doc.fileName, page: 2 } });
    // Rules are recomputed per analysis; the whole requirement list is the same for both orgs.
    expect(b.body.requirements).toEqual(a.body.requirements);
    // The document was downloaded from GeM once, too.
    expect(gemCalls.filter((u) => u.endsWith('/showbidDocument/go-it-services'))).toHaveLength(1);
    // Org A analysing again also reuses it.
    expect((await analyse(A.analyst.cookie, t.id)).status).toBe(201);
    expect(llmPrompts).toHaveLength(1);
  });

  it('bumping the extractor version re-extracts the document once and updates the cache row (US7 scenario 2)', async () => {
    const t = await gemTender('review-hardware-oem', 'GEM/2026/B/8800002');
    llmPrompts.length = 0;
    expect((await analyse(A.analyst.cookie, t.id)).status).toBe(201);
    expect(llmPrompts).toHaveLength(1);
    // Simulate a deploy with a new CURRENT_EXTRACTOR_VERSION: the stored row now carries an older version.
    await ctx.db.update(tenderDocuments).set({ extractorVersion: 'llm-extract-older' }).where(eq(tenderDocuments.tenderId, t.id));
    const again = await analyse(B.analyst.cookie, t.id);
    expect(again.status).toBe(201);
    expect(llmPrompts).toHaveLength(2); // re-extracted once
    const [doc] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.tenderId, t.id));
    expect(doc).toMatchObject({ extractorVersion: CURRENT_EXTRACTOR_VERSION, extractedMethod: 'LLM' });
    expect(doc.requirements).toEqual([expect.objectContaining({ label: 'Cache test licence (call 2)' })]);
    expect(llmReqs(again.body)[0].label).toBe('Cache test licence (call 2)');
    // …and then it is reused again.
    expect((await analyse(A.analyst.cookie, t.id)).status).toBe(201);
    expect(llmPrompts).toHaveLength(2);
  });

  it('a rules-only deployment (no LLM) neither writes nor needs the cache', async () => {
    const t = await gemTender('go-it-services', 'GEM/2026/B/8800003');
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: A.analyst.cookie });
    expect(r.status).toBe(201);
    expect(r.body.method).toBe('rules');
    const [doc] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.tenderId, t.id));
    expect(doc).toMatchObject({ requirements: null, extractorVersion: null, extractedMethod: null, extractedAt: null });
  });
});

describe('tenant isolation of the extraction cache (FR-072, 008/FR-016)', () => {
  it("an org's own upload is never cached: each org's analysis of its own document calls the LLM, and B never sees A's requirements", async () => {
    const [t] = await ctx.db.insert(tenders).values({
      bidNumber: 'GEM/2026/B/8800010', title: 'Private upload tender', sourceUrl: 'https://bidplus.gem.gov.in/all-bids#x', contentHash: 'cache-private',
      endAt: new Date(Date.now() + 10 * 86_400_000),
    }).returning();
    const file = new File([pdfs['go-it-services'] as BlobPart], 'a-private.pdf', { type: 'application/pdf' });
    const up = await request(ctx.app, 'POST', `/tenders/${t.id}/documents`, { cookie: A.analyst.cookie, form: { file, kind: 'bid' } });
    expect(up.status).toBe(201);
    llmPrompts.length = 0;
    const a1 = await analyse(A.analyst.cookie, t.id);
    expect(a1.status).toBe(201);
    expect(llmPrompts).toHaveLength(1);
    const [own] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, up.body.id));
    expect(own.orgId).toBe(A.orgId);
    expect(own).toMatchObject({ requirements: null, extractorVersion: null, extractedMethod: null, extractedAt: null });
    // Org A again: still an LLM call (no cache for org-owned documents).
    expect((await analyse(A.analyst.cookie, t.id)).status).toBe(201);
    expect(llmPrompts).toHaveLength(2);

    // Even a row forced into the cache shape is ignored because it belongs to an org…
    await ctx.db.update(tenderDocuments).set({
      requirements: [{ key: 'certificate', label: 'A-SECRET', value: 'A-SECRET', mandatory: true, method: 'LLM', confidence: 0.8, source: { documentId: own.id } }],
      extractorVersion: CURRENT_EXTRACTOR_VERSION, extractedMethod: 'LLM', extractedAt: new Date(),
    }).where(eq(tenderDocuments.id, own.id));
    const a3 = await analyse(A.analyst.cookie, t.id);
    expect(llmPrompts).toHaveLength(3);
    expect(JSON.stringify(a3.body.requirements)).not.toContain('A-SECRET');
    // …and org B cannot see the document at all: no documents → 422, never A's requirements.
    const b = await analyse(B.analyst.cookie, t.id);
    expect(b.status).toBe(422);
    expect(b.body.error.code).toBe('no_documents');
    expect(b.text).not.toContain('A-SECRET');
    expect(llmPrompts).toHaveLength(3);
  });

  it('cachedExtraction() serves only org-null rows at the current version with method LLM', () => {
    const reqs = [{ key: 'x', label: 'x', mandatory: true, method: 'LLM' as const, confidence: 0.8, source: {} }];
    const base = { orgId: null, requirements: reqs, extractorVersion: CURRENT_EXTRACTOR_VERSION, extractedMethod: 'LLM' as const };
    expect(cachedExtraction(base)).toBe(reqs);
    expect(cachedExtraction({ ...base, orgId: '00000000-0000-0000-0000-000000000001' })).toBeNull();
    expect(cachedExtraction({ ...base, extractorVersion: 'older' })).toBeNull();
    expect(cachedExtraction({ ...base, extractedMethod: null })).toBeNull();
    expect(cachedExtraction({ ...base, requirements: null })).toBeNull();
  });
});
