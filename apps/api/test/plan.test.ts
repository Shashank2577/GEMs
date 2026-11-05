/**
 * Spec 008 US5 — plans, trial expiry and AI usage metering (FR-034…FR-039, FR-042, FR-043).
 * Run: TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test_us5 pnpm exec vitest run test/plan.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  activityLog, analyses, bidWorkspaces, invitations, llmUsage, organizations, subscriptions, tenders, vaultDocuments, watchlists,
} from '@tp/db';
import { generateBidPdf, getSampleBidSpec } from '@tp/core/analyse/sample-bid';
import { PLAN_LIMITS, WATCHLIST_LIMIT, type PlanKey } from '@tp/core/contracts/plans';
import { createApp, type App } from '../src/app';
import type { AppDeps, LlmClient } from '../src/deps';
import { assertWithinPlan, meteredCompleteJson, usageFor, usedOf } from '../src/lib/plan';
import { createTestContext, request, seedOrgWithRoles, signup, type TestContext } from './helpers';

// 5 Nov 2026 10:00 IST
const NOW = new Date('2026-11-05T04:30:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const ADMIN = 'adm_test_0123456789abcdef0123456789abcdef';

let ctx: TestContext;
let adminApp: App;
let bidPdf: Uint8Array;
let seq = 0;

beforeAll(async () => {
  bidPdf = await generateBidPdf(getSampleBidSpec('go-it-services')!);
  ctx = await createTestContext({ now: NOW });
  adminApp = createApp({ ...ctx.deps, config: { ...ctx.deps.config, adminToken: ADMIN } });
});
afterAll(() => ctx?.close());

// ───────────── fixtures ─────────────

async function newOrg(plan: PlanKey = 'trial') {
  const o = await seedOrgWithRoles(ctx.app, `Plan Traders ${++seq}`);
  if (plan !== 'trial') await ctx.db.update(organizations).set({ plan, trialEndsAt: null }).where(eq(organizations.id, o.orgId));
  return o;
}

async function newTender() {
  const n = ++seq;
  const [t] = await ctx.db.insert(tenders).values({
    bidNumber: `GEM/2026/B/88${String(n).padStart(5, '0')}`, title: 'IT services', category: 'IT services', state: 'Delhi',
    endAt: new Date('2026-11-28T09:30:00Z'), sourceUrl: 'https://bidplus.gem.gov.in/all-bids', contentHash: `plan-${n}`,
  }).returning();
  return t!;
}

const pdfFile = (name = 'Bid.pdf') => new File([bidPdf as BlobPart], name, { type: 'application/pdf' });

/** A tender with one (or more) uploaded bid PDFs, ready to analyse. */
async function analysableTender(cookie: string, docs = 1) {
  const t = await newTender();
  for (let i = 0; i < docs; i++) {
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/documents`, { cookie, form: { file: pdfFile(`Doc ${i + 1}.pdf`), kind: i ? 'atc' : 'bid' } });
    expect(r.status, r.text).toBe(201);
  }
  return t;
}

async function seedAnalyses(orgId: string, n: number, at = NOW, status = 'done') {
  const t = await newTender();
  const iso = at.toISOString();
  await ctx.db.execute(sql`insert into analyses (org_id, tender_id, status, created_at, updated_at)
    select ${orgId}::uuid, ${t.id}::uuid, ${status}, ${iso}::timestamptz, ${iso}::timestamptz from generate_series(1, ${n})`);
}

async function seedLlmAnalyses(orgId: string, n: number, at = NOW) {
  await seedAnalyses(orgId, n, at);
  const iso = at.toISOString();
  await ctx.db.execute(sql`insert into llm_usage (org_id, analysis_id, analysis_ref, kind, model, input_tokens, output_tokens, created_at)
    select org_id, id, id, 'extract', 'seed', 100, 10, ${iso}::timestamptz from analyses where org_id = ${orgId}::uuid and created_at = ${iso}::timestamptz`);
}

async function seedWatchlists(orgId: string, n: number) {
  await ctx.db.execute(sql`insert into watchlists (org_id, name, criteria)
    select ${orgId}::uuid, 'W ' || g, '{"keywords":["laptop"],"excludeKeywords":[],"categories":[],"hsnCodes":[],"states":[],"ministries":[]}'::jsonb
    from generate_series(1, ${n}) g`);
}

async function seedInvites(orgId: string, n: number) {
  const exp = new Date(NOW.getTime() + 7 * DAY).toISOString();
  await ctx.db.execute(sql`insert into invitations (org_id, email, role, token_hash, expires_at)
    select ${orgId}::uuid, 'seed' || g || '.' || ${String(++seq)} || '@example.in', 'viewer', md5(g::text || ${String(seq)}), ${exp}::timestamptz
    from generate_series(1, ${n}) g`);
}

/** Vault rows totalling `bytes` (integer column → ≤ 2 GB per row). */
async function seedVaultBytes(orgId: string, bytes: number) {
  const chunk = 2 * GB - 1;
  let left = bytes;
  let i = 0;
  while (left > 0) {
    const size = Math.min(chunk, left);
    await ctx.db.insert(vaultDocuments).values({
      orgId, type: 'other', title: `Seed ${i}`, blobKey: `org/${orgId}/vault/seed-${i}.pdf`, fileName: `seed-${i}.pdf`, mimeType: 'application/pdf', sizeBytes: size,
    });
    left -= size;
    i++;
  }
}

async function seedPackets(orgId: string, n: number, at = NOW) {
  const t = await newTender();
  const [w] = await ctx.db.insert(bidWorkspaces).values({ orgId, tenderId: t.id, stage: 'preparing' }).returning();
  const iso = at.toISOString();
  if (n) {
    await ctx.db.execute(sql`insert into packets (org_id, workspace_id, status, created_at)
      select ${orgId}::uuid, ${w!.id}::uuid, 'ready', ${iso}::timestamptz from generate_series(1, ${n})`);
  }
  return w!;
}

/** A demo tender with a demo workspace of this (demo-seeded) org. */
async function demoTender(orgId: string) {
  const [t] = await ctx.db.select({ tenderId: bidWorkspaces.tenderId, workspaceId: bidWorkspaces.id }).from(bidWorkspaces)
    .innerJoin(tenders, eq(tenders.id, bidWorkspaces.tenderId)).where(and(eq(bidWorkspaces.orgId, orgId), eq(tenders.source, 'demo'))).limit(1);
  expect(t, 'demo seed made a workspace on a demo tender').toBeTruthy();
  return t!;
}

const watchlistBody = (name = 'Laptops') => ({
  name, criteria: { keywords: ['laptop'], excludeKeywords: [], categories: [], hsnCodes: [], states: [], ministries: [] },
});

const vaultForm = (bytes = 1024) => {
  // A tiny real PDF padded to `bytes` with a trailing comment (PDF readers ignore it).
  const head = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const out = new Uint8Array(Math.max(bytes, head.length));
  out.set(head);
  out.fill(0x25, head.length); // '%'
  return { file: new File([out as BlobPart], 'gst.pdf', { type: 'application/pdf' }), type: 'gst', title: `GST ${++seq}` };
};

function fakeLlm(usage = { inputTokens: 1234, outputTokens: 56 }) {
  const calls: unknown[] = [];
  const llm: LlmClient = {
    model: 'fake-model',
    complete: async () => ({ text: '', model: 'fake-model', stopReason: null, usage }),
    completeJson: async <T>(req: unknown, opts?: { onUsage?: (r: { model: string; usage: typeof usage }) => void }) => {
      calls.push(req);
      opts?.onUsage?.({ model: 'fake-model-2026', usage });
      return { requirements: [{ key: 'certificate', label: 'EPF registration', value: 'EPF registration', page: 1, confidence: 0.8 }] } as T;
    },
  };
  return { llm, calls };
}

const appWith = (over: Partial<AppDeps>) => createApp({ ...ctx.deps, ...over });

// ───────────── FR-034/FR-035: plan + trial end on /auth/me and /org ─────────────

describe('trial end (FR-035)', () => {
  it('a sign-up on 5 Nov 2026 10:00 IST is a trial ending 19 Nov 04:30 UTC (scenario 1)', async () => {
    const o = await signup(ctx.app, { orgName: 'Fresh Trial Co' });
    expect(o.me.org.plan).toBe('trial');
    expect(o.me.org.trialEndsAt).toBe('2026-11-19T04:30:00.000Z');
    const me = await request(ctx.app, 'GET', '/auth/me', { cookie: o.cookie });
    expect(me.body.org).toMatchObject({ plan: 'trial', trialEndsAt: '2026-11-19T04:30:00.000Z' });
    const org = await request(ctx.app, 'GET', '/org', { cookie: o.cookie });
    expect(org.body).toMatchObject({ plan: 'trial', trialEndsAt: '2026-11-19T04:30:00.000Z' });
    const patched = await request(ctx.app, 'PATCH', '/org', { cookie: o.cookie, json: { name: 'Fresh Trial Co Pvt Ltd' } });
    expect(patched.body.trialEndsAt).toBe('2026-11-19T04:30:00.000Z');
  });
});

// ───────────── FR-036: lib/plan.ts unit tests ─────────────

describe('lib/plan usage counting', () => {
  it('counts monthly usage in the IST calendar month (boundaries at 18:30 UTC)', async () => {
    const o = await newOrg('pro');
    await seedAnalyses(o.orgId, 2, new Date('2026-10-31T18:29:59.999Z')); // 31 Oct 23:59:59 IST → October
    await seedAnalyses(o.orgId, 3, new Date('2026-10-31T18:30:00.000Z')); // 1 Nov 00:00 IST → November
    await seedAnalyses(o.orgId, 1, new Date('2026-11-30T18:29:59.000Z')); // 30 Nov 23:59:59 IST → November
    await seedAnalyses(o.orgId, 4, new Date('2026-11-30T18:30:00.000Z')); // 1 Dec 00:00 IST → December
    await seedAnalyses(o.orgId, 5, NOW, 'failed'); // failed analyses never count
    expect(await usedOf(ctx.db, o.orgId, 'analysesPerMonth', NOW)).toBe(4);
    expect(await usedOf(ctx.db, o.orgId, 'analysesPerMonth', new Date('2026-10-31T18:00:00Z'))).toBe(2);
    expect(await usedOf(ctx.db, o.orgId, 'analysesPerMonth', new Date('2026-12-01T00:00:00Z'))).toBe(4);
  });

  it('seats count members plus pending (unexpired, unaccepted) invitations', async () => {
    const o = await newOrg();
    expect(await usedOf(ctx.db, o.orgId, 'seats', NOW)).toBe(4);
    await seedInvites(o.orgId, 2);
    await ctx.db.insert(invitations).values({ orgId: o.orgId, email: 'old@example.in', role: 'viewer', tokenHash: 'x-expired', expiresAt: new Date(NOW.getTime() - DAY) });
    expect(await usedOf(ctx.db, o.orgId, 'seats', NOW)).toBe(6);
  });

  it('assertWithinPlan throws 402 plan_limit_reached with {limit, used, max, plan, resetsAt} and never limits enterprise', async () => {
    const o = await newOrg();
    await seedAnalyses(o.orgId, 10);
    const err = await assertWithinPlan(ctx.deps, o.orgId, 'analysesPerMonth', 1).catch((e) => e);
    expect(err).toMatchObject({ status: 402, code: 'plan_limit_reached' });
    expect(err.details).toEqual({ limit: 'analysesPerMonth', used: 10, max: 10, plan: 'trial', resetsAt: '2026-11-30T18:30:00.000Z' });
    await expect(assertWithinPlan(ctx.deps, o.orgId, 'analysesPerMonth', 0)).resolves.toBeUndefined();
    await ctx.db.update(organizations).set({ plan: 'enterprise' }).where(eq(organizations.id, o.orgId));
    await expect(assertWithinPlan(ctx.deps, o.orgId, 'analysesPerMonth', 1_000_000)).resolves.toBeUndefined();
  });
});

// ───────────── FR-036/FR-043: per-resource 402s ─────────────

describe('plan limits per resource (FR-036, scenarios 2–5)', () => {
  it('watchlists: a Starter org with 5 cannot save a 6th', async () => {
    const o = await newOrg('starter');
    await seedWatchlists(o.orgId, 4);
    expect((await request(ctx.app, 'POST', '/watchlists', { cookie: o.analyst.cookie, json: watchlistBody('Fifth') })).status).toBe(201);
    const r = await request(ctx.app, 'POST', '/watchlists', { cookie: o.bidManager.cookie, json: watchlistBody('Sixth') });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('plan_limit_reached');
    expect(r.body.error.details).toEqual({ limit: 'watchlists', used: 5, max: 5, plan: 'starter' });
    expect(r.body.error.message).toMatch(/^Your Starter plan includes 5 watchlists\. You have 5\./);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(watchlists).where(eq(watchlists.orgId, o.orgId));
    expect(n).toBe(5);
  });

  it('seats: a Starter org with 3 members + invites cannot invite a 4th; re-inviting a pending email is fine', async () => {
    const owner = await signup(ctx.app, { orgName: `Seat Co ${++seq}` });
    const orgId = owner.me.org.id;
    await ctx.db.update(organizations).set({ plan: 'starter', trialEndsAt: null }).where(eq(organizations.id, orgId));
    expect((await request(ctx.app, 'POST', '/org/invitations', { cookie: owner.cookie, json: { email: 'a@example.in', role: 'analyst' } })).status).toBe(201);
    expect((await request(ctx.app, 'POST', '/org/invitations', { cookie: owner.cookie, json: { email: 'b@example.in', role: 'viewer' } })).status).toBe(201);
    // 1 member + 2 pending = 3 seats: re-inviting b@ replaces its invitation (still 3)
    expect((await request(ctx.app, 'POST', '/org/invitations', { cookie: owner.cookie, json: { email: 'b@example.in', role: 'analyst' } })).status).toBe(201);
    const r = await request(ctx.app, 'POST', '/org/invitations', { cookie: owner.cookie, json: { email: 'c@example.in', role: 'viewer' } });
    expect(r.status).toBe(402);
    expect(r.body.error.details).toEqual({ limit: 'seats', used: 3, max: 3, plan: 'starter' });
  });

  it('seats: resending an EXPIRED invitation takes a seat again; resending a pending one does not (review S3)', async () => {
    const owner = await signup(ctx.app, { orgName: `Resend Co ${++seq}` });
    const orgId = owner.me.org.id;
    await ctx.db.update(organizations).set({ plan: 'starter', trialEndsAt: null }).where(eq(organizations.id, orgId));
    const a = await request(ctx.app, 'POST', '/org/invitations', { cookie: owner.cookie, json: { email: 'a@example.in', role: 'analyst' } });
    const b = await request(ctx.app, 'POST', '/org/invitations', { cookie: owner.cookie, json: { email: 'b@example.in', role: 'viewer' } });
    expect([a.status, b.status]).toEqual([201, 201]);
    // a@ expires: 1 member + 1 pending = 2 seats, so c@ fits (3 / 3).
    await ctx.db.update(invitations).set({ expiresAt: new Date(NOW.getTime() - DAY) }).where(eq(invitations.id, a.body.id));
    const c = await request(ctx.app, 'POST', '/org/invitations', { cookie: owner.cookie, json: { email: 'c@example.in', role: 'viewer' } });
    expect(c.status, c.text).toBe(201);
    const revive = await request(ctx.app, 'POST', `/org/invitations/${a.body.id}/resend`, { cookie: owner.cookie, json: {} });
    expect(revive.status, revive.text).toBe(402);
    expect(revive.body.error.details).toEqual({ limit: 'seats', used: 3, max: 3, plan: 'starter' });
    const [still] = await ctx.db.select({ expiresAt: invitations.expiresAt }).from(invitations).where(eq(invitations.id, a.body.id));
    expect(still!.expiresAt.getTime()).toBeLessThan(NOW.getTime());
    // Resending a still-pending invitation keeps the seat count → allowed at the limit.
    expect((await request(ctx.app, 'POST', `/org/invitations/${b.body.id}/resend`, { cookie: owner.cookie, json: {} })).status).toBeLessThan(300);
    // Free a seat (revoke c@) → reviving a@ works.
    expect((await request(ctx.app, 'DELETE', `/org/invitations/${c.body.id}`, { cookie: owner.cookie })).status).toBeLessThan(300);
    expect((await request(ctx.app, 'POST', `/org/invitations/${a.body.id}/resend`, { cookie: owner.cookie, json: {} })).status).toBeLessThan(300);
  });

  it('vault bytes: a Pro org holding 9.99 GB cannot upload 20 MB (POST /vault and PUT /vault/:id/file)', async () => {
    const o = await newOrg('pro');
    const first = await request(ctx.app, 'POST', '/vault', { cookie: o.analyst.cookie, form: vaultForm(2048) });
    expect(first.status, first.text).toBe(201);
    await seedVaultBytes(o.orgId, Math.round(9.99 * GB) - 2048);
    const r = await request(ctx.app, 'POST', '/vault', { cookie: o.analyst.cookie, form: vaultForm(20 * MB - 100 * 1024) });
    expect(r.status, r.text).toBe(402);
    expect(r.body.error.details).toMatchObject({ limit: 'vaultBytes', max: 10 * GB, plan: 'pro' });
    expect(r.body.error.details.resetsAt).toBeUndefined();
    const put = await request(ctx.app, 'PUT', `/vault/${first.body.id}/file`, { cookie: o.analyst.cookie, form: { file: vaultForm(20 * MB - 100 * 1024).file } });
    expect(put.status, put.text).toBe(402);
    // a small file still fits
    expect((await request(ctx.app, 'POST', '/vault', { cookie: o.analyst.cookie, form: vaultForm(4096) })).status).toBe(201);
  });

  it('packets: the 201st Pro packet this month is refused before anything is built', async () => {
    const o = await newOrg('pro');
    const w = await seedPackets(o.orgId, 200);
    const r = await request(ctx.app, 'POST', `/workspaces/${w.id}/packets`, { cookie: o.analyst.cookie, json: {} });
    expect(r.status, r.text).toBe(402);
    expect(r.body.error.details).toEqual({ limit: 'packetsPerMonth', used: 200, max: 200, plan: 'pro', resetsAt: '2026-11-30T18:30:00.000Z' });
  });

  it('enterprise is never limited, even at 10× the Pro numbers (scenario 5, FR-043)', async () => {
    const o = await newOrg('enterprise');
    const pro = PLAN_LIMITS.pro;
    // No plan limit on watchlists; 003/FR-027's product cap of 50 per org still applies to every plan.
    await seedWatchlists(o.orgId, WATCHLIST_LIMIT - 1);
    await seedInvites(o.orgId, pro.seats! * 10);
    await seedVaultBytes(o.orgId, pro.vaultBytes! * 10);
    await seedAnalyses(o.orgId, pro.analysesPerMonth! * 10);
    const w = await seedPackets(o.orgId, pro.packetsPerMonth! * 10);

    expect((await request(ctx.app, 'POST', '/watchlists', { cookie: o.analyst.cookie, json: watchlistBody() })).status).toBe(201);
    expect((await request(ctx.app, 'POST', '/org/invitations', { cookie: o.owner.cookie, json: { email: `e${++seq}@example.in`, role: 'viewer' } })).status).toBe(201);
    expect((await request(ctx.app, 'POST', '/vault', { cookie: o.analyst.cookie, form: vaultForm(20 * MB - 100 * 1024) })).status).toBe(201);
    const t = await analysableTender(o.analyst.cookie);
    const a = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: o.analyst.cookie });
    expect(a.status, a.text).toBe(201);
    const p = await request(ctx.app, 'POST', `/workspaces/${w.id}/packets`, { cookie: o.analyst.cookie, json: {} });
    expect(p.status, p.text).not.toBe(402);
  });
});

// ───────────── FR-036: analyse quota under a row lock ─────────────

describe('analyse quota (T084)', () => {
  it('the 11th trial analysis this month → 402 with the spec message, and no analyses row (scenario 2)', async () => {
    const o = await newOrg();
    const t = await analysableTender(o.analyst.cookie);
    await seedAnalyses(o.orgId, 9);
    const tenth = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: o.analyst.cookie });
    expect(tenth.status, tenth.text).toBe(201);
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: o.analyst.cookie });
    expect(r.status).toBe(402);
    expect(r.body).toEqual({
      error: {
        code: 'plan_limit_reached',
        message: "Your Free trial includes 10 analyses a month. You've used 10. Talk to us to upgrade, or wait until 1 Dec.",
        details: { limit: 'analysesPerMonth', used: 10, max: 10, plan: 'trial', resetsAt: '2026-11-30T18:30:00.000Z' },
      },
    });
    const rows = await ctx.db.select({ id: analyses.id }).from(analyses).where(eq(analyses.orgId, o.orgId));
    expect(rows).toHaveLength(10);
  });

  it('concurrent requests cannot exceed the limit (org row lock)', async () => {
    const o = await newOrg();
    // Six different tenders: one running analysis per org+tender (004/FR-028) is a separate 409, so only the org row lock
    // keeps these from overshooting the monthly quota together.
    const ts = [];
    for (let i = 0; i < 6; i++) ts.push(await analysableTender(o.analyst.cookie));
    await seedAnalyses(o.orgId, 8);
    const results = await Promise.all(ts.map((t) => request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: o.analyst.cookie })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 402, 402, 402, 402]);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(analyses).where(eq(analyses.orgId, o.orgId));
    expect(n).toBe(10);
  });

  it('a new IST month resets the counter', async () => {
    const o = await newOrg();
    const t = await analysableTender(o.analyst.cookie);
    await seedAnalyses(o.orgId, 10, new Date('2026-10-20T04:30:00Z'));
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/analyse`, { cookie: o.analyst.cookie });
    expect(r.status, r.text).toBe(201);
  });

  it('the demo dataset does not use up the quota: only the rows the seeder wrote are left out (007/FR-065)', async () => {
    const o = await newOrg();
    const seeded = await request(ctx.app, 'POST', '/demo/seed', { cookie: o.owner.cookie, json: {} });
    expect(seeded.status, seeded.text).toBeLessThan(300);
    const rows = await ctx.db.select({ seeded: analyses.seeded }).from(analyses).where(eq(analyses.orgId, o.orgId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.seeded)).toBe(true);
    const u = await request(ctx.app, 'GET', '/org/usage', { cookie: o.viewer.cookie });
    expect(u.body.usage.analysesThisMonth).toBe(0);
    expect(u.body.usage.packetsThisMonth).toBe(0);
  });

  it('what a user runs on a demo tender or demo workspace counts (review S2)', async () => {
    const o = await newOrg();
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: o.owner.cookie, json: {} })).status).toBeLessThan(300);
    const t = await demoTender(o.orgId);
    const up = await request(ctx.app, 'POST', `/tenders/${t.tenderId}/documents`, { cookie: o.analyst.cookie, form: { file: pdfFile('Real bid.pdf'), kind: 'bid' } });
    expect(up.status, up.text).toBe(201);
    const a = await request(ctx.app, 'POST', `/tenders/${t.tenderId}/analyse`, { cookie: o.analyst.cookie });
    expect(a.status, a.text).toBe(201);
    // A packet built on a demo workspace (e.g. from the org's real vault documents) counts too.
    await ctx.db.execute(sql`insert into packets (org_id, workspace_id, status, created_at) values (${o.orgId}::uuid, ${t.workspaceId}::uuid, 'ready', ${NOW.toISOString()}::timestamptz)`);
    const u = await request(ctx.app, 'GET', '/org/usage', { cookie: o.viewer.cookie });
    expect(u.body.usage.analysesThisMonth).toBe(1);
    expect(u.body.usage.packetsThisMonth).toBe(1);
  });
});

// ───────────── FR-037/FR-039: LLM metering ─────────────

describe('LLM metering (T085)', () => {
  it('writes one llm_usage row per LLM call with the fake LLM tokens; /org/usage returns the totals (scenario 10)', async () => {
    const o = await newOrg();
    const { llm, calls } = fakeLlm({ inputTokens: 1234, outputTokens: 56 });
    const app = appWith({ llm });
    const t = await analysableTender(o.analyst.cookie, 2);
    const r = await request(app, 'POST', `/tenders/${t.id}/analyse`, { cookie: o.analyst.cookie });
    expect(r.status, r.text).toBe(201);
    expect(r.body.method).toBe('rules+llm');
    expect(r.body.warnings).toEqual([]);
    const rows = await ctx.db.select().from(llmUsage).where(eq(llmUsage.orgId, o.orgId));
    expect(rows).toHaveLength(calls.length);
    expect(calls.length).toBe(2);
    for (const row of rows) {
      expect(row).toMatchObject({ orgId: o.orgId, analysisId: r.body.id, kind: 'extract', model: 'fake-model-2026', inputTokens: 1234, outputTokens: 56 });
    }
    const u = await request(ctx.app, 'GET', '/org/usage', { cookie: o.viewer.cookie });
    expect(u.body.usage.llmTokensThisMonth).toEqual({ input: 1234 * calls.length, output: 56 * calls.length });
    expect(u.body.usage.llmAnalysesThisMonth).toBe(1);
    expect(u.body.usage.analysesThisMonth).toBe(1);
  });

  it('a call that fails before the provider answers is not metered; an unusable reply is', async () => {
    const o = await newOrg();
    const t = await analysableTender(o.analyst.cookie);
    const down: LlmClient = { ...fakeLlm().llm, completeJson: async () => { throw new Error('connect ECONNREFUSED'); } };
    expect((await request(appWith({ llm: down }), 'POST', `/tenders/${t.id}/analyse`, { cookie: o.analyst.cookie })).status).toBe(201);
    // The AI slot reserved for it is given back: no row, not an AI analysis.
    expect(await ctx.db.select().from(llmUsage).where(eq(llmUsage.orgId, o.orgId))).toHaveLength(0);
    expect((await usageFor(ctx.deps, o.orgId)).usage.llmAnalysesThisMonth).toBe(0);
    const garbled: LlmClient = {
      ...fakeLlm().llm,
      completeJson: async (_req, opts) => { opts?.onUsage?.({ model: 'm', usage: { inputTokens: 900, outputTokens: 3 } }); throw new Error('Model reply was not valid JSON'); },
    };
    const r = await request(appWith({ llm: garbled }), 'POST', `/tenders/${t.id}/analyse`, { cookie: o.analyst.cookie });
    expect(r.body.method).toBe('rules');
    const rows = await ctx.db.select().from(llmUsage).where(eq(llmUsage.orgId, o.orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputTokens: 900, outputTokens: 3, analysisId: r.body.id });
  });

  it('a call that timed out or was aborted in flight is metered with 0 tokens (review N3)', async () => {
    const o = await newOrg();
    const ctrl = new AbortController();
    const slow: LlmClient = { ...fakeLlm().llm, completeJson: async () => { ctrl.abort(new Error('LLM call timed out after 60 s')); throw new Error('LLM call timed out after 60 s'); } };
    const call = meteredCompleteJson({ ...ctx.deps, llm: slow }, { orgId: o.orgId, analysisId: null, kind: 'assist' });
    await expect(call({ system: 's', prompt: 'p', signal: ctrl.signal } as never)).rejects.toThrow(/timed out/);
    const rows = await ctx.db.select().from(llmUsage).where(eq(llmUsage.orgId, o.orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'assist', model: 'fake-model', inputTokens: 0, outputTokens: 0 });
  });

  it('deleting analyses (DELETE /demo) does not give AI analyses back (review B1)', async () => {
    const o = await newOrg();
    expect((await request(ctx.app, 'POST', '/demo/seed', { cookie: o.owner.cookie, json: {} })).status).toBeLessThan(300);
    const t = await demoTender(o.orgId);
    const up = await request(ctx.app, 'POST', `/tenders/${t.tenderId}/documents`, { cookie: o.analyst.cookie, form: { file: pdfFile('Real bid.pdf'), kind: 'bid' } });
    expect(up.status, up.text).toBe(201);
    const { llm } = fakeLlm();
    const a = await request(appWith({ llm }), 'POST', `/tenders/${t.tenderId}/analyse`, { cookie: o.analyst.cookie });
    expect(a.status, a.text).toBe(201);
    expect(a.body.method).toBe('rules+llm');
    expect((await usageFor(ctx.deps, o.orgId)).usage.llmAnalysesThisMonth).toBe(1);
    const del = await request(ctx.app, 'DELETE', '/demo', { cookie: o.owner.cookie });
    expect(del.status, del.text).toBeLessThan(300);
    expect(await ctx.db.select().from(analyses).where(eq(analyses.id, a.body.id))).toHaveLength(0);
    expect((await usageFor(ctx.deps, o.orgId)).usage.llmAnalysesThisMonth).toBe(1);
  });

  it('concurrent analyses cannot all get AI past the quota: the slot is reserved in the quota transaction (review S1)', async () => {
    const o = await newOrg('starter');
    const max = PLAN_LIMITS.starter.llmAnalysesPerMonth!;
    await seedLlmAnalyses(o.orgId, max - 1);
    const ts = [];
    for (let i = 0; i < 3; i++) ts.push(await analysableTender(o.analyst.cookie));
    const { llm } = fakeLlm();
    const app = appWith({ llm });
    const results = await Promise.all(ts.map((t) => request(app, 'POST', `/tenders/${t.id}/analyse`, { cookie: o.analyst.cookie })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(results.map((r) => r.body.method).sort()).toEqual(['rules', 'rules', 'rules+llm']);
    expect(results.filter((r) => r.body.warnings.some((w: { code: string }) => w.code === 'llm_quota_reached'))).toHaveLength(2);
    expect((await usageFor(ctx.deps, o.orgId)).usage.llmAnalysesThisMonth).toBe(max);
  });

  it('llmAnalysesPerMonth used up → rules-only with warning llm_quota_reached, no LLM call (scenario 11, FR-037)', async () => {
    const o = await newOrg('starter');
    await seedLlmAnalyses(o.orgId, PLAN_LIMITS.starter.llmAnalysesPerMonth!);
    const { llm, calls } = fakeLlm();
    const t = await analysableTender(o.analyst.cookie);
    const r = await request(appWith({ llm }), 'POST', `/tenders/${t.id}/analyse`, { cookie: o.analyst.cookie });
    expect(r.status, r.text).toBe(201);
    expect(r.body.method).toBe('rules');
    expect(r.body.warnings).toEqual([{ code: 'llm_quota_reached' }]);
    expect(calls).toHaveLength(0);
    const latest = await request(ctx.app, 'GET', `/tenders/${t.id}/analysis`, { cookie: o.viewer.cookie });
    expect(latest.status).toBe(200);
    expect(latest.body.warnings).toEqual([{ code: 'llm_quota_reached' }]);
  });
});

// ───────────── FR-039: GET /org/usage ─────────────

describe('GET /org/usage (T087)', () => {
  it('returns plan, trial end, IST period, usage and limits to any member', async () => {
    const o = await newOrg();
    await seedAnalyses(o.orgId, 7);
    await seedWatchlists(o.orgId, 2);
    await seedVaultBytes(o.orgId, 120 * MB);
    const r = await request(ctx.app, 'GET', '/org/usage', { cookie: o.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      plan: 'trial',
      trialEndsAt: '2026-11-19T04:30:00.000Z',
      period: { start: '2026-10-31T18:30:00.000Z', end: '2026-11-30T18:30:00.000Z' },
      usage: {
        seats: 4, watchlists: 2, analysesThisMonth: 7, llmAnalysesThisMonth: 0, vaultBytes: 120 * MB, packetsThisMonth: 0,
        llmTokensThisMonth: { input: 0, output: 0 },
      },
      limits: { ...PLAN_LIMITS.trial },
    });
    expect((await request(ctx.app, 'GET', '/org/usage')).status).toBe(401);
  });

  it('is org-scoped', async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedAnalyses(a.orgId, 3);
    expect((await usageFor(ctx.deps, b.orgId)).usage.analysesThisMonth).toBe(0);
    expect((await request(ctx.app, 'GET', '/org/usage', { cookie: b.owner.cookie })).body.usage.analysesThisMonth).toBe(0);
  });
});

// ───────────── FR-038: expired trial is read-only ─────────────

describe('requireActivePlan (T086, scenario 6)', () => {
  let o: Awaited<ReturnType<typeof newOrg>>;
  let tenderId: string;
  let vaultId: string;
  let workspaceId: string;
  let tokenId: string;
  let notificationId: string;
  const EXPIRED_MESSAGE = 'Your free trial ended on 19 Nov 2026. Your data is safe and read-only — talk to us to choose a plan.';

  beforeAll(async () => {
    o = await newOrg();
    tenderId = (await analysableTender(o.analyst.cookie)).id;
    vaultId = (await request(ctx.app, 'POST', '/vault', { cookie: o.analyst.cookie, form: vaultForm(2048) })).body.id;
    workspaceId = (await seedPackets(o.orgId, 0)).id;
    tokenId = (await request(ctx.app, 'POST', '/me/api-tokens', { cookie: o.owner.cookie, json: { name: 'ext' } })).body.id;
    const [n] = await ctx.db.execute(sql`insert into notifications (org_id, user_id, channel, kind, title, body)
      values (${o.orgId}::uuid, ${o.owner.me.user.id}::uuid, 'in_app', 'system', 'Hi', 'Hello') returning id`).then((x) => (x as unknown as { rows: { id: string }[] }).rows);
    notificationId = n!.id;
    ctx.clock.set(new Date(NOW.getTime() + 15 * DAY)); // 20 Nov — the trial ended on 19 Nov
  });
  afterAll(() => ctx.clock.set(NOW));

  const blocked: [string, string, () => Record<string, unknown>][] = [
    ['POST', '/watchlists', () => ({ json: watchlistBody() })],
    ['POST', '/tenders/:tender/analyse', () => ({})],
    ['POST', '/vault', () => ({ form: vaultForm(2048) })],
    ['PATCH', '/vault/:vault', () => ({ json: { title: 'Renamed' } })],
    ['POST', '/org/invitations', () => ({ json: { email: 'x@example.in', role: 'viewer' } })],
    ['PATCH', '/org', () => ({ json: { name: 'New name' } })],
    ['POST', '/me/api-tokens', () => ({ json: { name: 'another' } })],
    ['POST', '/workspaces/:ws/packets', () => ({ json: {} })],
    ['POST', '/demo/seed', () => ({ json: {} })],
    ['POST', '/tenders/:tender/workspace', () => ({ json: {} })],
    ['PUT', '/scoring-weights', () => ({ json: {} })],
    ['POST', '/org/invitations/00000000-0000-4000-8000-000000000001/resend', () => ({ json: {} })],
  ];
  const fill = (p: string) => p.replace(':tender', tenderId).replace(':vault', vaultId).replace(':ws', workspaceId);

  it.each(blocked.map(([m, p, b]) => [`${m} ${p}`, m, p, b] as const))('blocks %s with 402 plan_expired', async (_n, m, p, b) => {
    const r = await request(ctx.app, m, fill(p), { cookie: o.owner.cookie, ...b() });
    expect(r.status, r.text).toBe(402);
    expect(r.body.error).toEqual({ code: 'plan_expired', message: EXPIRED_MESSAGE, details: { plan: 'trial', trialEndsAt: '2026-11-19T04:30:00.000Z' } });
  });

  it('blocks API-token writes too', async () => {
    // An API token created before expiry (bearer auth path).
    const created = await (async () => {
      ctx.clock.set(NOW);
      const t = await request(ctx.app, 'POST', '/me/api-tokens', { cookie: o.owner.cookie, json: { name: 'bearer' } });
      ctx.clock.set(new Date(NOW.getTime() + 15 * DAY));
      return t.body.token as string;
    })();
    const r = await request(ctx.app, 'POST', '/watchlists', { bearer: created, json: watchlistBody() });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('plan_expired');
  });

  it('GETs still work: health, feed, analysis, vault list and download (all roles)', async () => {
    expect((await request(ctx.app, 'GET', '/health')).status).toBe(200);
    for (const u of [o.viewer, o.analyst, o.owner]) {
      expect((await request(ctx.app, 'GET', '/tenders', { cookie: u.cookie })).status).toBe(200);
      expect((await request(ctx.app, 'GET', '/vault', { cookie: u.cookie })).status).toBe(200);
      expect((await request(ctx.app, 'GET', `/vault/${vaultId}/download`, { cookie: u.cookie })).status).toBe(200);
      expect((await request(ctx.app, 'GET', `/tenders/${tenderId}/documents`, { cookie: u.cookie })).status).toBe(200);
      expect((await request(ctx.app, 'GET', '/org/usage', { cookie: u.cookie })).status).toBe(200);
    }
  });

  it('every FR-038 allow-listed write still runs (no 402)', async () => {
    const allowed: [string, string, Record<string, unknown>][] = [
      ['PATCH', '/me', { json: { name: 'Owner Renamed' } }],
      ['POST', '/me/password', { json: { currentPassword: 'wrong-password-1', newPassword: 'another-horse-77' } }],
      ['POST', '/me/sessions/revoke-others', { json: {} }],
      ['DELETE', '/me/sessions/00000000-0000-4000-8000-00000000abcd', {}],
      ['DELETE', `/me/api-tokens/${tokenId}`, {}],
      ['POST', `/notifications/${notificationId}/read`, {}],
      ['POST', '/notifications/read-all', {}],
      ['PUT', '/me/notification-prefs', { json: { inApp: true, email: true, whatsapp: false, frequency: 'instant', expiryReminders: true } }],
      ['POST', `/tenders/${tenderId}/seen`, {}],
      ['DELETE', '/demo', {}],
      // Writes that only reduce usage (review N6).
      ['DELETE', '/org/invitations/00000000-0000-4000-8000-000000000001', {}],
      ['DELETE', '/org/members/me', {}],
      ['POST', '/auth/switch-org', { json: { orgId: o.orgId } }],
      ['POST', '/auth/forgot-password', { json: { email: o.owner.email } }],
      ['POST', '/auth/login', { json: { email: o.analyst.email, password: o.analyst.password } }],
      ['POST', '/auth/logout', {}],
    ];
    for (const [m, p, b] of allowed) {
      const r = await request(ctx.app, m, p, { cookie: o.owner.cookie, ...b });
      expect(r.status, `${m} ${p}: ${r.text}`).not.toBe(402);
      expect(r.status, `${m} ${p}: ${r.text}`).toBeLessThan(500);
    }
  });

  it('paid plans and unexpired trials are never read-only', async () => {
    const paid = await newOrg('starter');
    expect((await request(ctx.app, 'POST', '/watchlists', { cookie: paid.analyst.cookie, json: watchlistBody() })).status).toBe(201);
  });
});

// ───────────── FR-042: admin plan flip ─────────────

describe('POST /admin/orgs/:id/plan (T088, scenario 12)', () => {
  const call = (app: App, orgId: string, body: unknown, token?: string) =>
    request(app, 'POST', `/admin/orgs/${orgId}/plan`, { json: body, headers: token ? { authorization: `Bearer ${token}` } : {} });

  it('answers the generic 404 without ADMIN_TOKEN configured, without a token, with a wrong token or for an unknown org', async () => {
    const o = await newOrg();
    const body = { plan: 'starter', note: 'Invoice INV-0012' };
    const unknownRoute = await request(ctx.app, 'POST', `/admin/orgs/${o.orgId}/nope`, { json: body });
    for (const r of [
      await call(ctx.app, o.orgId, body, ADMIN), // token unset in this app
      await call(adminApp, o.orgId, body),
      await call(adminApp, o.orgId, body, `${ADMIN}x`),
      await call(adminApp, o.orgId, body, 'short'),
      await call(adminApp, '00000000-0000-4000-8000-00000000abcd', body, ADMIN),
      await call(adminApp, 'not-a-uuid', body, ADMIN),
    ]) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe(unknownRoute.body.error.code);
      expect(Object.keys(r.body.error)).toEqual(Object.keys(unknownRoute.body.error));
    }
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, o.orgId));
    expect(org!.plan).toBe('trial');
  });

  it('validates the body (400) once authorised', async () => {
    const o = await newOrg();
    expect((await call(adminApp, o.orgId, { plan: 'gold', note: 'x' }, ADMIN)).status).toBe(400);
    expect((await call(adminApp, o.orgId, { plan: 'pro', note: '' }, ADMIN)).status).toBe(400);
    expect((await call(adminApp, o.orgId, { plan: 'pro', note: 'x'.repeat(501) }, ADMIN)).status).toBe(400);
  });

  it('expired trial → flip to starter: trial cleared, subscription row, activity org.plan_changed, writes work again', async () => {
    const o = await newOrg();
    ctx.clock.set(new Date(NOW.getTime() + 15 * DAY));
    try {
      expect((await request(ctx.app, 'POST', '/watchlists', { cookie: o.analyst.cookie, json: watchlistBody() })).status).toBe(402);
      const r = await call(adminApp, o.orgId, { plan: 'starter', note: 'Invoice INV-0012' }, ADMIN);
      expect(r.status, r.text).toBe(200);
      expect(r.body).toEqual({ org: { id: o.orgId, plan: 'starter', trialEndsAt: null }, subscriptionId: expect.any(String) });
      // the very next request sees the new plan (FR-043)
      expect((await request(ctx.app, 'POST', '/watchlists', { cookie: o.analyst.cookie, json: watchlistBody() })).status).toBe(201);
      const me = await request(ctx.app, 'GET', '/auth/me', { cookie: o.owner.cookie });
      expect(me.body.org).toMatchObject({ plan: 'starter', trialEndsAt: null });
      const subs = await ctx.db.select().from(subscriptions).where(eq(subscriptions.orgId, o.orgId));
      expect(subs).toHaveLength(1);
      expect(subs[0]).toMatchObject({ id: r.body.subscriptionId, plan: 'starter', status: 'active', note: 'Invoice INV-0012', endsAt: null });
      const act = await request(ctx.app, 'GET', '/activity', { cookie: o.viewer.cookie });
      const item = act.body.items.find((i: { action: string }) => i.action === 'org.plan_changed');
      expect(item).toMatchObject({ entityType: 'organization', entityId: o.orgId, user: null, meta: { from: 'trial', to: 'starter', note: 'Invoice INV-0012' } });
    } finally {
      ctx.clock.set(NOW);
    }
  });

  it('a later change cancels the previous subscription; trial extensions set trialEndsAt', async () => {
    const o = await newOrg();
    await call(adminApp, o.orgId, { plan: 'pro', note: 'INV-1' }, ADMIN);
    const r = await call(adminApp, o.orgId, { plan: 'trial', note: 'Extended pilot', trialEndsAt: '2026-12-31T18:29:59.000Z' }, ADMIN);
    expect(r.body.org).toEqual({ id: o.orgId, plan: 'trial', trialEndsAt: '2026-12-31T18:29:59.000Z' });
    const subs = await ctx.db.select().from(subscriptions).where(eq(subscriptions.orgId, o.orgId));
    expect(subs.map((s) => [s.plan, s.status]).sort()).toEqual([['pro', 'cancelled'], ['trial', 'active']]);
    const logs = await ctx.db.select().from(activityLog).where(and(eq(activityLog.orgId, o.orgId), eq(activityLog.action, 'org.plan_changed')));
    expect(logs).toHaveLength(2);
  });
});
