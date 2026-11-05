/**
 * Data protection (004 T093, FR-054, NFR-003): LLM requests carry only tender-document text and rule-extracted
 * requirements. Distinctive canary strings are seeded in the company profile, financials, past contracts and vault
 * (rows, file names, tags and file contents); every request that leaves the API during an analysis is captured at the
 * HTTP boundary (real adapter, fake fetch) and must contain none of them.
 *
 * Adding a request path: build its client with `capturingClient('<tier>', …, sink)`, drive it, then call
 * `expectNoLeaks(sink)`; add a `describe` below next to 'analyse' and 'OCR' (T091: the OCR request is pinned to exactly
 * the PDF bytes + the fixed system prompt and instruction).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { companyProfiles, organizations, pastContracts, tenders, vaultDocuments } from '@tp/db';
import { PDFDocument, rgb } from 'pdf-lib';
import { generateBidPdf, getSampleBidSpec } from '@tp/core/analyse/sample-bid';
import { OCR_PROMPT, OCR_SYSTEM } from '@tp/core/analyse/ocr';
import { createApp } from '../src/app';
import type { LlmClient } from '../src/deps';
import { capturingClient, leaks, type CapturedRequest } from './llm-capture';
import { createTestContext, request, seedOrgWithRoles, type TestContext } from './helpers';

const CANARY = {
  legalName: 'Zyxwq Canary Industries Pvt Ltd',
  tradeName: 'Zyxwq-Trade-Canary',
  gstin: '29ZYXWQ9999Z1Z5',
  pan: 'ZYXWQ9999Z',
  udyam: 'UDYAM-ZZ-99-7654321',
  address: '77 Canary Lane Zyxwq Nagar',
  contactEmail: 'canary.contact@zyxwq-example.test',
  contactPhone: '+919000031337',
  signatory: 'Zyxwq Signatory Canary',
  cert: 'CANARY-CERT-4417',
  oem: 'Zyxwq OEM Canary Corp',
  turnover: 31_415_926,
  buyer: 'Zyxwq Ministry of Canaries',
  contractTitle: 'Zyxwq Canary Helpdesk Contract',
  contractValue: 27_182_818,
  contractNo: 'GEMC-ZYXWQ-5150',
  vaultTitle: 'Zyxwq Vault Canary Certificate',
  vaultFile: 'zyxwq-vault-canary.pdf',
  vaultTag: 'zyxwq-vault-tag-canary',
  vaultNumber: 'ZYXWQ-VAULT-NO-8899',
  vaultBody: 'ZYXWQ-VAULT-FILE-CONTENT-CANARY',
};
const CANARIES = Object.values(CANARY).map(String);

let ctx: TestContext;
let roles: Awaited<ReturnType<typeof seedOrgWithRoles>>;

async function seedCanaries(orgId: string) {
  await ctx.db.insert(companyProfiles).values({
    orgId, legalName: CANARY.legalName, tradeName: CANARY.tradeName, gstin: CANARY.gstin, pan: CANARY.pan, udyamNumber: CANARY.udyam,
    mseCategory: 'small', address: CANARY.address, contactEmail: CANARY.contactEmail, contactPhone: CANARY.contactPhone,
    signatoryName: CANARY.signatory, certifications: [CANARY.cert], oemAuthorizations: [{ oem: CANARY.oem, products: 'Zyxwq products' }],
    financials: [{ fy: '2023-24', turnover: CANARY.turnover }, { fy: '2024-25', turnover: CANARY.turnover }, { fy: '2025-26', turnover: CANARY.turnover }],
    incorporationDate: '2015-04-01', state: 'Delhi', operatingStates: ['Delhi'], maxEmdCapacity: 700_000,
  });
  await ctx.db.insert(pastContracts).values({
    orgId, buyer: CANARY.buyer, title: CANARY.contractTitle, value: CANARY.contractValue, gemContractNo: CANARY.contractNo,
    startDate: '2022-06-01', endDate: '2023-05-31',
  });
  const blobKey = `org/${orgId}/vault/canary.pdf`;
  await ctx.deps.blobs.put(blobKey, CANARY.vaultBody, { contentType: 'application/pdf' });
  await ctx.db.insert(vaultDocuments).values({
    orgId, type: 'iso', title: CANARY.vaultTitle, number: CANARY.vaultNumber, tags: [CANARY.vaultTag], blobKey, fileName: CANARY.vaultFile,
    mimeType: 'application/pdf', sizeBytes: CANARY.vaultBody.length,
  });
}

const expectNoLeaks = (sink: CapturedRequest[]) => expect(leaks(sink, CANARIES)).toEqual([]);

beforeAll(async () => {
  ctx = await createTestContext({ now: '2026-11-04T04:30:00Z' });
  roles = await seedOrgWithRoles(ctx.app, 'Privacy Co');
  await ctx.db.update(organizations).set({ plan: 'pro' }).where(eq(organizations.id, roles.orgId));
  await seedCanaries(roles.orgId);
});
afterAll(() => ctx?.close());

describe('the canary detector', () => {
  it('finds a canary as written, in another case, and with separators removed', () => {
    const sink: CapturedRequest[] = [{ tier: 'x', model: 'm', body: JSON.stringify({ p: `Turnover 3,14,15,926 and ${CANARY.legalName.toUpperCase()}` }) }];
    expect(leaks(sink, [String(CANARY.turnover), CANARY.legalName, CANARY.gstin])).toEqual([
      { tier: 'x', canary: String(CANARY.turnover) }, { tier: 'x', canary: CANARY.legalName },
    ]);
  });
});

describe('analyse sends no company data to any LLM tier (FR-054, NFR-003)', () => {
  it('enrichment + escalation requests contain tender text and rule results only', async () => {
    const spec = getSampleBidSpec('go-it-services')!;
    const sink: CapturedRequest[] = [];
    // The enrichment model contradicts the EMD rule so the escalation tier is called too.
    const enrichment: LlmClient = capturingClient('enrichment', 'claude-sonnet-5-5', sink, () => ({
      requirements: [{ key: 'emd', label: 'EMD amount', value: '1', numeric: 1, mandatory: true, page: 1, quote: 'EMD', confidence: 0.8 }],
    }));
    const escalation: LlmClient = capturingClient('escalation', 'claude-fable-5-1', sink, () => ({ requirements: [] }));
    const app = createApp({ ...ctx.deps, llm: enrichment, llmFor: (p) => (p === 'enrichment' ? enrichment : p === 'escalation' ? escalation : null) });

    const [tender] = await ctx.db.insert(tenders).values({
      bidNumber: spec.bidNumber, title: spec.itemCategory, category: spec.itemCategory, sourceUrl: 'https://bidplus.gem.gov.in/all-bids#privacy',
      contentHash: 'privacy', endAt: new Date('2026-11-28T09:30:00Z'),
    }).returning();
    const file = new File([await generateBidPdf(spec) as BlobPart], 'bid.pdf', { type: 'application/pdf' });
    expect((await request(app, 'POST', `/tenders/${tender!.id}/documents`, { cookie: roles.analyst.cookie, form: { file, kind: 'bid' } })).status).toBe(201);

    const r = await request(app, 'POST', `/tenders/${tender!.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(r.status).toBe(201);
    expect(r.body.method).toBe('rules+llm');

    // Control: both tiers really were called and carried tender content, so an empty leak list means something.
    expect(new Set(sink.map((s) => s.tier))).toEqual(new Set(['enrichment', 'escalation']));
    expect(sink[0]!.body).toContain('=== Page 1 ===');
    expect(sink[0]!.body).toContain('Already extracted by deterministic rules');
    // Control: the company data really is in the database and was used for scoring.
    expect(JSON.stringify(r.body.factors)).toMatch(/turnover/i);

    expectNoLeaks(sink);
    // Nor the API key, which only travels in a header.
    for (const s of sink) expect(s.body).not.toContain('sk-test');
  });
});

describe('OCR sends only the document bytes and the fixed prompt (FR-052, FR-054)', () => {
  async function scan(pages: number): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawRectangle({ x: 40, y: 40, width: 500, height: 700, color: rgb(0.85, 0.85, 0.85) });
    return doc.save();
  }
  const ocrReply = (_call: number, body: Record<string, unknown>) => {
    const content = (body.messages as { content: { type: string }[] }[])[0]!.content;
    expect(content[0]!.type).toBe('document');
    return { pages: [{ page: 1, text: 'Bid Number: GEM/2026/B/1 EMD Amount 50000' }, { page: 2, text: 'Scope of work' }] };
  };

  /** The whole request: model, output budget, the fixed system prompt, one user message = [the PDF, the fixed prompt], the schema. */
  function expectOnlyDocumentAndPrompt(body: string, pdf: Uint8Array) {
    const b = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(b).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
    expect(b.system).toBe(OCR_SYSTEM);
    const messages = b.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(pdf).toString('base64') } },
      { type: 'text', text: OCR_PROMPT },
    ]);
  }

  it('on demand and inside analyse', async () => {
    const sink: CapturedRequest[] = [];
    const ocr = capturingClient('ocr', 'claude-opus-5-5', sink, ocrReply);
    const enrichment = capturingClient('enrichment', 'claude-sonnet-5-5', sink);
    const app = createApp({ ...ctx.deps, llm: enrichment, llmFor: (p) => (p === 'ocr' ? ocr : p === 'enrichment' ? enrichment : null) });
    const pdf = await scan(2);
    const newTender = async (i: number) => (await ctx.db.insert(tenders).values({
      bidNumber: `GEM/2026/B/88${i}`, title: 'Scanned', sourceUrl: `https://bidplus.gem.gov.in/all-bids#privacy-ocr-${i}`, contentHash: `privacy-ocr-${i}`,
      endAt: new Date('2026-11-28T09:30:00Z'),
    }).returning())[0]!;
    const uploadScan = async (tenderId: string) => {
      const r = await request(app, 'POST', `/tenders/${tenderId}/documents`, { cookie: roles.analyst.cookie, form: { file: new File([pdf as BlobPart], 'scan.pdf', { type: 'application/pdf' }), kind: 'bid' } });
      expect(r.status).toBe(201);
      return r.body.id as string;
    };

    const t1 = await newTender(1);
    const docId = await uploadScan(t1.id);
    const r1 = await request(app, 'POST', `/tenders/${t1.id}/documents/${docId}/ocr`, { cookie: roles.analyst.cookie });
    expect(r1.status, r1.text).toBe(200);

    const t2 = await newTender(2);
    await uploadScan(t2.id);
    const r2 = await request(app, 'POST', `/tenders/${t2.id}/analyse`, { cookie: roles.analyst.cookie });
    expect(r2.status, r2.text).toBe(201);

    const ocrRequests = sink.filter((s) => s.tier === 'ocr');
    expect(ocrRequests).toHaveLength(2);
    for (const s of ocrRequests) expectOnlyDocumentAndPrompt(s.body, pdf);
    expectNoLeaks(sink);
    for (const s of sink) expect(s.body).not.toContain('sk-test');
  });
});
