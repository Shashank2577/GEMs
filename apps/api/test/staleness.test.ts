/**
 * Staleness service (T010; FR-043, FR-044): markStale scopes (org, tenders, open only), reason/time
 * recording, done-only, and the DTO fields staleReason/staleAt/notes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { analyses, tenders } from '@tp/db';
import { markStale } from '../src/services/staleness';
import { toAnalysisDto } from '../src/services/analyse';
import { createTestContext, seedOrgWithRoles, type TestContext } from './helpers';

let ctx: TestContext;
let orgA: string;
let orgB: string;
let openT: string;
let closedT: string;
let pastT: string;

const created = new Date('2026-11-01T10:00:00Z');
const now = new Date('2026-11-05T10:00:00Z');

async function tender(n: number, over: Partial<typeof tenders.$inferInsert> = {}) {
  const [t] = await ctx.db.insert(tenders).values({
    bidNumber: `GEM/2026/B/90000${n}`, title: `Tender ${n}`, sourceUrl: `https://bidplus.gem.gov.in/#${n}`, contentHash: `stale-${n}`,
    endAt: new Date('2026-12-01T10:00:00Z'), ...over,
  }).returning();
  return t.id;
}

async function analysis(orgId: string, tenderId: string, status: 'done' | 'running' | 'failed' = 'done') {
  const [a] = await ctx.db.insert(analyses).values({ orgId, tenderId, status, createdAt: created, updatedAt: created }).returning();
  return a.id;
}

const row = async (id: string) => (await ctx.db.select().from(analyses).where(eq(analyses.id, id)))[0];

beforeAll(async () => {
  ctx = await createTestContext({ now });
  const a = await seedOrgWithRoles(ctx.app, 'Stale A');
  const b = await seedOrgWithRoles(ctx.app, 'Stale B');
  orgA = a.orgId; orgB = b.orgId;
  openT = await tender(1);
  closedT = await tender(2, { status: 'closed' });
  pastT = await tender(3, { endAt: new Date('2026-11-04T10:00:00Z') });
});
afterAll(() => ctx?.close());
beforeEach(async () => { await ctx.db.delete(analyses); });

describe('markStale', () => {
  it('marks the org\'s done analyses of the given tenders with reason and time; leaves updatedAt', async () => {
    const mine = await analysis(orgA, openT);
    const other = await analysis(orgB, openT);
    const otherTender = await analysis(orgA, closedT);
    expect(await markStale(ctx.db, { orgId: orgA, tenderIds: [openT] }, 'document_added', now)).toBe(1);
    expect(await row(mine)).toMatchObject({ stale: true, staleReason: 'document_added', staleAt: now, updatedAt: created });
    expect(await row(other)).toMatchObject({ stale: false, staleReason: null, staleAt: null });
    expect((await row(otherTender)).stale).toBe(false);
  });

  it('only touches done analyses', async () => {
    const running = await analysis(orgA, openT, 'running');
    const failed = await analysis(orgA, openT, 'failed');
    expect(await markStale(ctx.db, { orgId: orgA, tenderIds: [openT] }, 'document_removed', now)).toBe(0);
    expect((await row(running)).stale).toBe(false);
    expect((await row(failed)).stale).toBe(false);
  });

  it('openOnly skips closed tenders and tenders past their end date', async () => {
    const open = await analysis(orgA, openT);
    const closed = await analysis(orgA, closedT);
    const past = await analysis(orgA, pastT);
    const otherOrg = await analysis(orgB, openT);
    expect(await markStale(ctx.db, { orgId: orgA, openOnly: true }, 'profile_changed', now)).toBe(1);
    expect(await row(open)).toMatchObject({ stale: true, staleReason: 'profile_changed' });
    expect((await row(closed)).stale).toBe(false);
    expect((await row(past)).stale).toBe(false);
    expect((await row(otherOrg)).stale).toBe(false);
  });

  it('without orgId reaches every org (corrigendum); a re-scorable reason never replaces one needing re-analysis', async () => {
    const a = await analysis(orgA, openT);
    const b = await analysis(orgB, openT);
    expect(await markStale(ctx.db, { tenderIds: [openT] }, 'corrigendum', now)).toBe(2);
    const later = new Date(now.getTime() + 60_000);
    await markStale(ctx.db, { orgId: orgA, tenderIds: [openT] }, 'weights_changed', later);
    // The corrigendum is kept (Re-score cannot fix it, FR-037); the time moves to the latest change.
    expect(await row(a)).toMatchObject({ staleReason: 'corrigendum', staleAt: later });
    expect(await row(b)).toMatchObject({ staleReason: 'corrigendum', staleAt: now });
  });

  it('the newest reason wins otherwise (re-scorable → anything, re-analysis → re-analysis)', async () => {
    const a = await analysis(orgA, openT);
    await markStale(ctx.db, { orgId: orgA, tenderIds: [openT] }, 'profile_changed', now);
    await markStale(ctx.db, { orgId: orgA, tenderIds: [openT] }, 'weights_changed', now);
    expect(await row(a)).toMatchObject({ staleReason: 'weights_changed' });
    await markStale(ctx.db, { orgId: orgA, tenderIds: [openT] }, 'document_added', now);
    expect(await row(a)).toMatchObject({ staleReason: 'document_added' });
    await markStale(ctx.db, { orgId: orgA, tenderIds: [openT] }, 'corrigendum', now);
    expect(await row(a)).toMatchObject({ staleReason: 'corrigendum' });
  });

  it('an empty tender list matches nothing; an unscoped call is refused', async () => {
    await analysis(orgA, openT);
    expect(await markStale(ctx.db, { orgId: orgA, tenderIds: [] }, 'vault_changed', now)).toBe(0);
    await expect(markStale(ctx.db, {}, 'vault_changed', now)).rejects.toThrow(/scope/);
  });

  it('the Analysis DTO exposes staleReason, staleAt and notes', async () => {
    const id = await analysis(orgA, openT);
    expect(toAnalysisDto(await row(id))).toMatchObject({ stale: false, staleReason: null, staleAt: null, notes: [] });
    await markStale(ctx.db, { orgId: orgA, tenderIds: [openT] }, 'vault_changed', now);
    expect(toAnalysisDto(await row(id))).toMatchObject({ stale: true, staleReason: 'vault_changed', staleAt: now.toISOString(), notes: [] });
  });
});
