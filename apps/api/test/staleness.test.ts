/**
 * Staleness service (T010, T074; FR-043, FR-044, FR-045): markStale scopes (org, tenders, open only),
 * reason/time recording, done + running rows only, the DTO fields staleReason/staleAt/notes, and a run's
 * completion keeping a flag set while it ran.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { analyses, tenderDocuments, tenders } from '@tp/db';
import type { LlmClient } from '../src/deps';
import { keepStaleOnCompletion, markStale } from '../src/services/staleness';
import { analyseTender, toAnalysisDto } from '../src/services/analyse';
import { createTestContext, seedOrgWithRoles, type TestContext } from './helpers';

let ctx: TestContext;
let orgA: string;
let orgB: string;
let userA: string;
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
  orgA = a.orgId; orgB = b.orgId; userA = a.analyst.me.user.id;
  openT = await tender(1);
  // A public (GeM) document both orgs can analyse.
  const page = 'Bid document. The bidder shall have an average annual turnover of Rs 50 lakh in the last three financial years. '
    + 'EMD of Rs 1,00,000 is required. Bidders must have completed similar works of at least 40% of the estimated value. ';
  await ctx.db.insert(tenderDocuments).values({
    tenderId: openT, kind: 'bid', fileName: 'bid.pdf', blobKey: 'stale/bid.pdf', sizeBytes: 1000, pageCount: 2, text: `${page.repeat(4)}\f${page.repeat(4)}`,
  });
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

  // Changed in T074 (was "only touches done analyses"): a running row is flagged too, otherwise a change
  // made while an analysis runs would be lost when it completes (FR-045); the completion decides by
  // comparing stale_at with its created_at. Failed rows have no result and stay untouched.
  it('touches done and running analyses, not failed ones', async () => {
    const running = await analysis(orgA, openT, 'running');
    const failed = await analysis(orgA, openT, 'failed');
    expect(await markStale(ctx.db, { orgId: orgA, tenderIds: [openT] }, 'document_removed', now)).toBe(1);
    expect(await row(running)).toMatchObject({ stale: true, staleReason: 'document_removed', staleAt: now });
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

describe('run completion keeps a flag set while it ran (FR-045, T074)', () => {
  const input = (orgId: string) => ({ orgId, userId: userA, tenderId: openT, viewer: {} });
  /** An LLM fake that runs `during` mid-analysis (after the running row is committed, before the final write). */
  const llmDuring = (during: () => Promise<unknown>): LlmClient => ({
    model: 'fake',
    complete: async () => ({ text: '', model: 'fake', stopReason: null, usage: { inputTokens: 0, outputTokens: 0 } }),
    completeJson: async <T>() => { await during(); return { requirements: [] } as T; },
  });

  it('a corrigendum during a run → the run completes stale with reason and time (same-millisecond change counts)', async () => {
    const b = await analysis(orgB, openT);
    const at = ctx.clock.now();
    const { analysis: done } = await analyseTender({ ...ctx.deps, llm: llmDuring(async () => {
      expect(await markStale(ctx.db, { tenderIds: [openT] }, 'corrigendum', at)).toBe(2); // org B's done row + our running row
    }) }, input(orgA));
    expect(done).toMatchObject({ status: 'done', stale: true, staleReason: 'corrigendum', staleAt: at });
    expect(done.createdAt).toEqual(at); // equal timestamps: the flag still survives (>=)
    expect(await row(b)).toMatchObject({ stale: true, staleReason: 'corrigendum' });
  });

  it('a re-scorable change during a run does not replace a corrigendum on the running row', async () => {
    const { analysis: done } = await analyseTender({ ...ctx.deps, llm: llmDuring(async () => {
      await markStale(ctx.db, { tenderIds: [openT] }, 'corrigendum', ctx.clock.now());
      ctx.clock.advance(1000);
      await markStale(ctx.db, { orgId: orgA, openOnly: true }, 'weights_changed', ctx.clock.now());
    }) }, input(orgA));
    expect(done).toMatchObject({ stale: true, staleReason: 'corrigendum', staleAt: ctx.clock.now() });
  });

  it('a run with no change completes fresh; corrigendum then re-analyse clears; org B stays stale when org A re-analyses', async () => {
    const oldA = await analysis(orgA, openT);
    const oldB = await analysis(orgB, openT);
    ctx.clock.advance(60_000);
    expect(await markStale(ctx.db, { tenderIds: [openT] }, 'corrigendum', ctx.clock.now())).toBe(2);
    ctx.clock.advance(60_000);
    const { analysis: fresh } = await analyseTender(ctx.deps, input(orgA));
    expect(fresh).toMatchObject({ status: 'done', stale: false, staleReason: null, staleAt: null });
    expect(toAnalysisDto(fresh)).toMatchObject({ stale: false, staleReason: null, staleAt: null });
    // The superseded org A row keeps its history; org B was not re-analysed, so it still needs one.
    expect(await row(oldA)).toMatchObject({ stale: true, staleReason: 'corrigendum' });
    expect(await row(oldB)).toMatchObject({ stale: true, staleReason: 'corrigendum' });
  });

  it('a flag older than the row\'s created_at is cleared by the completion write', async () => {
    const [a] = await ctx.db.insert(analyses).values({
      orgId: orgA, tenderId: openT, status: 'running', createdAt: now, updatedAt: now,
      stale: true, staleReason: 'profile_changed', staleAt: new Date(now.getTime() - 1),
    }).returning();
    await ctx.db.update(analyses).set({ status: 'done', ...keepStaleOnCompletion() }).where(eq(analyses.id, a.id));
    expect(await row(a.id)).toMatchObject({ status: 'done', stale: false, staleReason: null, staleAt: null });
  });
});
