/**
 * Workers budget (T052; NFR-005). A 25 MB / 300-page bid read all at once needs ~170 MB above the
 * Worker baseline in workerd (measured; see specs/004-analyse-scoring/plan.md "Workers budget"), so
 * uploads read at most MAX_EXTRACT_PAGES pages and warn about the rest. Kept small and fast: a
 * 160-page text PDF exercises the cap without 25 MB of bytes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { eq } from 'drizzle-orm';
import { activityLog, tenderDocuments, tenders } from '@tp/db';
import { MAX_EXTRACT_PAGES } from '@tp/core/contracts/analyse';
import { extractPdf } from '@tp/core/analyse/pdf-text';
import { createTestContext, request, seedOrgWithRoles, type TestContext } from './helpers';

const PAGES = MAX_EXTRACT_PAGES + 10;
let ctx: TestContext;
let roles: Awaited<ReturnType<typeof seedOrgWithRoles>>;
let bytes: Uint8Array;

async function longPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([595, 842]).drawText(`Page ${i}: eligibility and terms of the bid`, { x: 40, y: 780, size: 10, font });
  return doc.save();
}

beforeAll(async () => {
  bytes = await longPdf(PAGES);
  ctx = await createTestContext({ now: '2026-11-04T04:30:00Z' });
  roles = await seedOrgWithRoles(ctx.app, 'Large Doc Co');
});
afterAll(() => ctx?.close());

describe('page cap (NFR-005)', () => {
  it('extractPdf reads at most maxPages one page at a time and reports the real total', async () => {
    const r = await extractPdf(bytes, { maxPages: 5 });
    expect(r.pages).toHaveLength(5);
    expect(r.totalPages).toBe(PAGES);
    expect(r.pages[4]).toContain('Page 5:');
    expect((await extractPdf(bytes)).pages).toHaveLength(PAGES);
  });

  it('upload keeps the first MAX_EXTRACT_PAGES pages and warns about the rest', async () => {
    const [t] = await ctx.db.insert(tenders).values({ bidNumber: 'GEM/2026/B/9000001', title: 'Long bid', sourceUrl: 'https://bidplus.gem.gov.in/all-bids', contentHash: 'large' }).returning();
    const file = new File([bytes as BlobPart], 'long.pdf', { type: 'application/pdf' });
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/documents`, { cookie: roles.analyst.cookie, form: { file } });
    expect(r.status).toBe(201);
    expect(r.body.pageCount).toBe(MAX_EXTRACT_PAGES);
    expect(r.body.warnings).toEqual([{ code: 'pages_truncated', analysed: MAX_EXTRACT_PAGES, total: PAGES }]);
    const [row] = await ctx.db.select().from(tenderDocuments).where(eq(tenderDocuments.id, r.body.id));
    expect(row.text).toContain(`Page ${MAX_EXTRACT_PAGES}:`);
    expect(row.text).not.toContain(`Page ${MAX_EXTRACT_PAGES + 1}:`);
    const log = (await ctx.db.select().from(activityLog).where(eq(activityLog.entityId, t.id))).find((a) => a.action === 'tender.document_uploaded');
    expect(log?.meta).toMatchObject({ pages: MAX_EXTRACT_PAGES, totalPages: PAGES });
  });

  it('a document within the cap has no truncation warning', async () => {
    const [t] = await ctx.db.insert(tenders).values({ bidNumber: 'GEM/2026/B/9000002', title: 'Short bid', sourceUrl: 'https://bidplus.gem.gov.in/all-bids', contentHash: 'short' }).returning();
    const file = new File([(await longPdf(3)) as BlobPart], 'short.pdf', { type: 'application/pdf' });
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/documents`, { cookie: roles.analyst.cookie, form: { file } });
    expect(r.body.pageCount).toBe(3);
    expect(r.body.warnings).toEqual([]);
  });
});
