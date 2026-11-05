/**
 * NFR-001 / SC-007 workspace-detail performance check. NOT part of default CI (`*.perf.ts`); run with the other perf
 * checks:
 *
 *   TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test pnpm --filter @tp/api run test:perf
 *
 * Workload: a workspace whose analysis has 40 checklist items, in an org with 500 vault documents →
 * GET /api/workspaces/:id must have p95 < 600 ms.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vaultDocuments, analyses, type ChecklistItem } from '@tp/db';
import { eq } from 'drizzle-orm';
import { createTestContext, request, type TestContext } from '../helpers';
import { NOW, seedApply } from '../workspace-fixtures';

const ITEMS = 40;
const VAULT_DOCS = 500;
const RUNS = 50;
const TYPES = ['gst', 'pan', 'balance_sheet', 'oem_authorization', 'udyam', 'other'] as const;

const ms = (t0: number) => performance.now() - t0;

describe('workspace detail performance (NFR-001 / SC-007)', () => {
  let ctx: TestContext;
  let s: Awaited<ReturnType<typeof seedApply>>;
  let wsId: string;

  beforeAll(async () => {
    ctx = await createTestContext({ now: NOW });
    s = await seedApply(ctx);
    const checklist: ChecklistItem[] = Array.from({ length: ITEMS }, (_, i) => ({
      id: `item_${i}`, label: `Checklist item ${i}`, docType: TYPES[i % TYPES.length], mandatory: i % 3 !== 0, reason: 'Perf',
    }));
    await ctx.db.update(analyses).set({ checklist }).where(eq(analyses.id, s.analysis.id));
    const rows = Array.from({ length: VAULT_DOCS - 5 }, (_, i) => ({
      orgId: s.org.orgId, type: TYPES[i % TYPES.length], title: `Perf vault document ${i}`, financialYear: i % 4 === 0 ? '2024-25' : null,
      blobKey: `perf/${i}.pdf`, fileName: `perf-${i}.pdf`, mimeType: 'application/pdf', sizeBytes: 1024, pageCount: 2,
    }));
    await ctx.db.insert(vaultDocuments).values(rows);
    wsId = (await request(ctx.app, 'POST', `/tenders/${s.tender.id}/workspace`, { cookie: s.org.analyst.cookie })).body.id;
  }, 300_000);
  afterAll(() => ctx?.close());

  it('serves GET /workspaces/:id with 40 checklist items and 500 vault docs at p95 < 600 ms', async () => {
    const warm = await request(ctx.app, 'GET', `/workspaces/${wsId}`, { cookie: s.org.viewer.cookie });
    expect(warm.status).toBe(200);
    expect(warm.body.vaultDocs.length).toBeGreaterThanOrEqual(VAULT_DOCS - 5);
    const runs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      const r = await request(ctx.app, 'GET', `/workspaces/${wsId}`, { cookie: s.org.viewer.cookie });
      runs.push(ms(t0));
      expect(r.status).toBe(200);
    }
    runs.sort((a, b) => a - b);
    const p95 = runs[Math.ceil(RUNS * 0.95) - 1];
    console.log(`[perf] workspace detail (${ITEMS} items, ${VAULT_DOCS} vault docs, ${RUNS} runs): p50 ${runs[RUNS >> 1].toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${runs[RUNS - 1].toFixed(0)} ms`);
    expect(p95).toBeLessThan(600);
  }, 120_000);
});
