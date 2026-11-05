/**
 * Analyse performance smoke (T051; NFR-001, SC-002): a rules-only analysis of each sample bid finishes in
 * under 5 s, and the `tender.analysed` activity carries the stage timings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { activityLog, tenders } from '@tp/db';
import { generateBidPdf, getSampleBidSpec } from '@tp/core/analyse/sample-bid';
import { createTestContext, request, seedOrgWithRoles, type TestContext } from './helpers';

const KEYS = ['go-it-services', 'nogo-experience', 'emd-exempt-mse', 'review-hardware-oem'];
let ctx: TestContext;
let roles: Awaited<ReturnType<typeof seedOrgWithRoles>>;

beforeAll(async () => {
  ctx = await createTestContext({ now: '2026-11-04T04:30:00Z' }); // no LLM configured → rules only
  roles = await seedOrgWithRoles(ctx.app, 'Perf Infotech');
});
afterAll(() => ctx?.close());

describe('rules-only analysis time (NFR-001)', () => {
  for (const key of KEYS) {
    it(`${key} analyses in < 5 s and logs stage timings`, async () => {
      const spec = getSampleBidSpec(key)!;
      const [t] = await ctx.db.insert(tenders).values({
        bidNumber: spec.bidNumber, title: spec.itemCategory, category: spec.itemCategory, sourceUrl: `https://bidplus.gem.gov.in/all-bids#${key}`, contentHash: key,
      }).returning();
      const file = new File([(await generateBidPdf(spec)) as BlobPart], `${key}.pdf`, { type: 'application/pdf' });
      expect((await request(ctx.app, 'POST', `/tenders/${t.id}/documents`, { cookie: roles.analyst.cookie, form: { file } })).status).toBe(201);

      const t0 = performance.now();
      const r = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: roles.analyst.cookie });
      const wall = performance.now() - t0;
      expect(r.status).toBe(201);
      expect(wall).toBeLessThan(5000);

      const [log] = await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, t.id), eq(activityLog.action, 'tender.analysed')));
      const m = log.meta as Record<string, number>;
      for (const k of ['extract_ms', 'llm_ms', 'score_ms', 'total_ms', 'pages', 'docs']) expect(typeof m[k]).toBe('number');
      expect(m.llm_ms).toBe(0);
      expect(m.docs).toBe(1);
      expect(m.pages).toBeGreaterThan(0);
      expect(m.total_ms).toBeLessThan(5000);
      expect(m.total_ms).toBeGreaterThanOrEqual(m.extract_ms);
    });
  }
});
