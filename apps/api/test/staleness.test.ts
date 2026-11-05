/**
 * Staleness service (T010, T074; FR-043, FR-044, FR-045): markStale scopes (org, tenders, open only),
 * reason/time recording, done + running rows only, the DTO fields staleReason/staleAt/notes, and a run's
 * completion keeping a flag set while it ran.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { analyses, tenderDocuments, tenders } from '@tp/db';
import type { LlmClient } from '../src/deps';
import { keepStaleOnCompletion, markStale } from '../src/services/staleness';
import { analyseTender, toAnalysisDto } from '../src/services/analyse';
import { createTestContext, request, seedOrgWithRoles, type TestContext } from './helpers';

let ctx: TestContext;
let orgA: string;
let orgB: string;
let userA: string;
let rolesA: Awaited<ReturnType<typeof seedOrgWithRoles>>;
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
  rolesA = a; orgA = a.orgId; orgB = b.orgId; userA = a.analyst.me.user.id;
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

// T075-T077 (FR-044): each org-level change flags that org's analyses of open tenders, with the right reason.
describe('mutations flag open analyses', () => {
  const as = (r: { cookie: string }) => ({ cookie: r.cookie });
  let id: string;       // org A's analysis of the open tender
  let closedId: string; // ... and of the closed one
  let otherId: string;  // org B's analysis of the open tender
  beforeEach(async () => {
    id = await analysis(orgA, openT); closedId = await analysis(orgA, closedT); otherId = await analysis(orgB, openT);
  });
  const expectFlagged = async (reason: string) => {
    expect(await row(id)).toMatchObject({ stale: true, staleReason: reason, staleAt: ctx.clock.now() });
    expect((await row(closedId)).stale).toBe(false); // closed tenders keep their historical result
    expect((await row(otherId)).stale).toBe(false);  // another org is untouched
  };
  const unflag = () => ctx.db.update(analyses).set({ stale: false, staleReason: null, staleAt: null });
  const pdf = async (title: string) => {
    const d = await PDFDocument.create(); d.addPage().drawText(title);
    return new File([await d.save() as Uint8Array<ArrayBuffer>], `${title}.pdf`, { type: 'application/pdf' });
  };

  it('PUT /profile -> profile_changed; a body that changes nothing flags nothing; a viewer is refused', async () => {
    expect((await request(ctx.app, 'PUT', '/profile', { ...as(rolesA.viewer), json: { legalName: 'X' } })).status).toBe(403);
    expect((await row(id)).stale).toBe(false);
    expect((await request(ctx.app, 'PUT', '/profile', { ...as(rolesA.analyst), json: {} })).status).toBe(200);
    expect((await row(id)).stale).toBe(false);
    expect((await request(ctx.app, 'PUT', '/profile', { ...as(rolesA.analyst), json: { legalName: 'Stale Traders' } })).status).toBe(200);
    await expectFlagged('profile_changed');
  });

  it('past contracts: POST, PATCH and DELETE -> profile_changed; a failed one flags nothing', async () => {
    const bad = await request(ctx.app, 'POST', '/past-contracts', { ...as(rolesA.analyst), json: { buyer: 'IOCL' } });
    expect(bad.status).toBe(400);
    expect((await row(id)).stale).toBe(false);
    const post = await request(ctx.app, 'POST', '/past-contracts', { ...as(rolesA.analyst), json: { buyer: 'IOCL', title: 'Laptops', value: 100 } });
    expect(post.status).toBe(201);
    await expectFlagged('profile_changed');
    await unflag();
    expect((await request(ctx.app, 'PATCH', `/past-contracts/${post.body.id}`, { ...as(rolesA.analyst), json: { title: 'Laptops 2' } })).status).toBe(200);
    await expectFlagged('profile_changed');
    await unflag();
    expect((await request(ctx.app, 'DELETE', `/past-contracts/${post.body.id}`, as(rolesA.analyst))).status).toBe(200);
    await expectFlagged('profile_changed');
  });

  it('vault: POST, PATCH, PUT file and DELETE -> vault_changed', async () => {
    const up = await request(ctx.app, 'POST', '/vault', { ...as(rolesA.analyst), form: { file: await pdf('GST'), type: 'gst', title: 'GST' } });
    expect(up.status).toBe(201);
    await expectFlagged('vault_changed');
    await unflag();
    expect((await request(ctx.app, 'PATCH', `/vault/${up.body.id}`, { ...as(rolesA.analyst), json: { title: 'GST certificate' } })).status).toBe(200);
    await expectFlagged('vault_changed');
    await unflag();
    expect((await request(ctx.app, 'PUT', `/vault/${up.body.id}/file`, { ...as(rolesA.analyst), form: { file: await pdf('GST v2') } })).status).toBe(200);
    await expectFlagged('vault_changed');
    await unflag();
    expect((await request(ctx.app, 'DELETE', `/vault/${up.body.id}`, as(rolesA.analyst))).status).toBe(200);
    await expectFlagged('vault_changed');
  });

  it('a refused vault write (viewer) and an empty PATCH flag nothing', async () => {
    const up = await request(ctx.app, 'POST', '/vault', { ...as(rolesA.analyst), form: { file: await pdf('PAN'), type: 'pan', title: 'PAN' } });
    await unflag();
    expect((await request(ctx.app, 'PATCH', `/vault/${up.body.id}`, { ...as(rolesA.viewer), json: { title: 'x' } })).status).toBe(403);
    expect((await request(ctx.app, 'PATCH', `/vault/${up.body.id}`, { ...as(rolesA.analyst), json: {} })).status).toBe(200);
    expect((await row(id)).stale).toBe(false);
  });

  it('PUT /scoring-weights -> weights_changed only when the weights change', async () => {
    const put = (json: object) => request(ctx.app, 'PUT', '/scoring-weights', { ...as(rolesA.bidManager), json });
    expect((await put({ turnover: 30 })).status).toBe(200);
    await expectFlagged('weights_changed');
    await unflag();
    expect((await put({ turnover: 30 })).status).toBe(200); // same weights again
    expect((await row(id)).stale).toBe(false);
  });

  it('document upload and delete -> document_added / document_removed', async () => {
    const up = await request(ctx.app, 'POST', `/tenders/${openT}/documents`, { ...as(rolesA.analyst), form: { file: await pdf('Addendum'), kind: 'bid' } });
    expect(up.status).toBe(201);
    expect(await row(id)).toMatchObject({ stale: true, staleReason: 'document_added' });
    expect((await row(otherId)).stale).toBe(false);
    await unflag();
    expect((await request(ctx.app, 'DELETE', `/tenders/${openT}/documents/${up.body.id}`, as(rolesA.analyst))).status).toBe(204);
    expect(await row(id)).toMatchObject({ stale: true, staleReason: 'document_removed' });
  });
});
