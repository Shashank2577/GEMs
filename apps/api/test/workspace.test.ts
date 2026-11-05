/** Bid workspace API (T063, T067; FR-023, FR-028, US4 acceptance 1–2, US6 activity). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { activityLog, notifications } from '@tp/db';
import { createTestContext, request, signup, type TestContext } from './helpers';
import { NOW, seedAnalysis, seedApply, seedTender, upload } from './workspace-fixtures';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof seedApply>>;
let wsId: string;

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW });
  s = await seedApply(ctx);
});
afterAll(() => ctx?.close());

describe('POST /tenders/:id/workspace', () => {
  it('viewers cannot start a bid', async () => {
    const r = await request(ctx.app, 'POST', `/tenders/${s.tender.id}/workspace`, { cookie: s.org.viewer.cookie });
    expect(r.status).toBe(403);
  });

  it('creates the workspace in "go" with auto-mapped vault documents (US4 #1)', async () => {
    const r = await request(ctx.app, 'POST', `/tenders/${s.tender.id}/workspace`, { cookie: s.org.analyst.cookie });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    expect(r.body.stage).toBe('go');
    expect(r.body.owner.id).toBe(s.org.analyst.me.user.id);
    expect(r.body.dueAt).toBe('2026-11-20T09:30:00.000Z');
    expect(r.body.mapping).toEqual({ gst: s.docs.gst.id, pan: s.docs.pan.id, balance_sheets: s.docs.bsNew.id, oem_authorization: s.docs.oem.id });
    wsId = r.body.id;
  });

  it('is idempotent (create-or-get)', async () => {
    const r = await request(ctx.app, 'POST', `/tenders/${s.tender.id}/workspace`, { cookie: s.org.bidManager.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: wsId, created: false });
  });

  it('404s for an unknown tender', async () => {
    const r = await request(ctx.app, 'POST', '/tenders/00000000-0000-4000-8000-000000000000/workspace', { cookie: s.org.analyst.cookie });
    expect(r.status).toBe(404);
  });
});

describe('GET /workspaces/:id', () => {
  it('returns workspace + tender + analysis + readiness + annexures', async () => {
    const r = await request(ctx.app, 'GET', `/workspaces/${wsId}`, { cookie: s.org.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.body.tender.bidNumber).toBe('GEM/2026/B/700001');
    expect(r.body.analysis.verdict).toBe('go');
    const states = Object.fromEntries(r.body.readiness.items.map((i: any) => [i.item.id, i.state]));
    expect(states).toEqual({
      gst: 'ready', pan: 'ready', balance_sheets: 'ready', oem_authorization: 'expired', udyam: 'missing',
      non_blacklisting: 'generated', mii_self_cert: 'generated',
    });
    expect(r.body.readiness.blockers.map((b: any) => b.itemId)).toEqual(['oem_authorization']);
    expect(r.body.readiness.percent).toBe(83); // 5 of 6 mandatory
    expect(r.body.annexures.map((a: any) => a.key)).toEqual(['bid_cover_letter', 'non_blacklisting', 'mii_self_cert', 'oem_auth_request', 'technical_compliance', 'authority_letter']);
    expect(r.body.defaultPacketItems.map((i: any) => i.kind)).toEqual(['cover', 'annexure', 'annexure', 'annexure', 'vault', 'vault', 'vault', 'vault']);
    expect(r.body.members).toHaveLength(4);
    expect(r.body.vaultDocs).toHaveLength(5);
    expect(r.body.activity[0].action).toBe('workspace.created');
  });

  it('is isolated per organization', async () => {
    const other = await signup(ctx.app);
    expect((await request(ctx.app, 'GET', `/workspaces/${wsId}`, { cookie: other.cookie })).status).toBe(404);
    expect((await request(ctx.app, 'PATCH', `/workspaces/${wsId}`, { cookie: other.cookie, json: { stage: 'preparing' } })).status).toBe(404);
    expect((await request(ctx.app, 'GET', '/workspaces', { cookie: other.cookie })).body.items).toEqual([]);
  });
});

describe('PATCH /workspaces/:id — stage guard (US4 #2)', () => {
  it('blocks "ready" while a mandatory document is expired', async () => {
    const r = await request(ctx.app, 'PATCH', `/workspaces/${wsId}`, { cookie: s.org.bidManager.cookie, json: { stage: 'ready' } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_ready');
    expect(r.body.error.details.blockers).toEqual([{ itemId: 'oem_authorization', label: expect.any(String), state: 'expired' }]);
  });

  it('moves between other stages and logs who moved it', async () => {
    const r = await request(ctx.app, 'PATCH', `/workspaces/${wsId}`, { cookie: s.org.analyst.cookie, json: { stage: 'preparing' } });
    expect(r.status).toBe(200);
    expect(r.body.stage).toBe('preparing');
    const [a] = await ctx.db.select().from(activityLog).where(and(eq(activityLog.action, 'workspace.stage_changed'), eq(activityLog.entityId, wsId)));
    expect(a.userId).toBe(s.org.analyst.me.user.id);
    expect(a.meta).toMatchObject({ from: 'go', to: 'preparing' });
  });

  it('analysts cannot override checklist items (bid_manager+ only)', async () => {
    const r = await request(ctx.app, 'POST', `/workspaces/${wsId}/overrides`, { cookie: s.org.analyst.cookie, json: { itemId: 'oem_authorization', reason: 'Renewed MAF arriving' } });
    expect(r.status).toBe(403);
  });

  it('requires a reason and a real checklist item for overrides', async () => {
    expect((await request(ctx.app, 'POST', `/workspaces/${wsId}/overrides`, { cookie: s.org.bidManager.cookie, json: { itemId: 'oem_authorization', reason: '' } })).status).toBe(400);
    expect((await request(ctx.app, 'POST', `/workspaces/${wsId}/overrides`, { cookie: s.org.bidManager.cookie, json: { itemId: 'nope', reason: 'some reason' } })).status).toBe(400);
  });

  it('a Bid Manager override with a reason unblocks "ready"', async () => {
    const o = await request(ctx.app, 'POST', `/workspaces/${wsId}/overrides`, { cookie: s.org.bidManager.cookie, json: { itemId: 'oem_authorization', reason: 'Renewed MAF arriving tomorrow from Dell' } });
    expect(o.status).toBe(201);
    expect(o.body.readiness.canMarkReady).toBe(true);
    expect(o.body.workspace.overrides[0]).toMatchObject({ itemId: 'oem_authorization', byName: 'Test bid manager' });
    const r = await request(ctx.app, 'PATCH', `/workspaces/${wsId}`, { cookie: s.org.analyst.cookie, json: { stage: 'ready' } });
    expect(r.status).toBe(200);
    expect(r.body.stage).toBe('ready');
  });

  it('removing the override brings the blocker back', async () => {
    const d = await request(ctx.app, 'DELETE', `/workspaces/${wsId}/overrides/oem_authorization`, { cookie: s.org.bidManager.cookie });
    expect(d.status).toBe(200);
    expect(d.body.readiness.blockers).toHaveLength(1);
  });

  it('assigns owner / assignees from the org only and notifies them', async () => {
    const bad = await request(ctx.app, 'PATCH', `/workspaces/${wsId}`, { cookie: s.org.bidManager.cookie, json: { assigneeIds: ['00000000-0000-4000-8000-000000000000'] } });
    expect(bad.status).toBe(400);
    const r = await request(ctx.app, 'PATCH', `/workspaces/${wsId}`, {
      cookie: s.org.bidManager.cookie, json: { ownerId: s.org.bidManager.me.user.id, assigneeIds: [s.org.analyst.me.user.id], dueAt: '2026-11-19T12:30:00.000Z' },
    });
    expect(r.status).toBe(200);
    expect(r.body.owner.name).toBe('Test bid manager');
    expect(r.body.assignees.map((a: any) => a.id)).toEqual([s.org.analyst.me.user.id]);
    expect(r.body.dueAt).toBe('2026-11-19T12:30:00.000Z');
    const n = await ctx.db.select().from(notifications).where(and(eq(notifications.userId, s.org.analyst.me.user.id), eq(notifications.kind, 'assignment')));
    expect(n).toHaveLength(1);
    expect(n[0].link).toBe(`/workspaces/${wsId}`);
  });

  it('rejects unknown fields and stages', async () => {
    expect((await request(ctx.app, 'PATCH', `/workspaces/${wsId}`, { cookie: s.org.analyst.cookie, json: { stage: 'flying' } })).status).toBe(400);
    expect((await request(ctx.app, 'PATCH', `/workspaces/${wsId}`, { cookie: s.org.analyst.cookie, json: { price: 1 } })).status).toBe(400);
    expect((await request(ctx.app, 'PATCH', `/workspaces/${wsId}`, { cookie: s.org.viewer.cookie, json: { stage: 'go' } })).status).toBe(403);
  });
});

describe('PUT /workspaces/:id/mapping', () => {
  it('lets the user pick another document, clear it, or go back to automatic', async () => {
    let r = await request(ctx.app, 'PUT', `/workspaces/${wsId}/mapping`, { cookie: s.org.analyst.cookie, json: { balance_sheets: s.docs.bsOld.id } });
    expect(r.status).toBe(200);
    expect(r.body.readiness.items.find((i: any) => i.item.id === 'balance_sheets')).toMatchObject({ docId: s.docs.bsOld.id, auto: false, state: 'ready' });
    r = await request(ctx.app, 'PUT', `/workspaces/${wsId}/mapping`, { cookie: s.org.analyst.cookie, json: { balance_sheets: null } });
    expect(r.body.readiness.items.find((i: any) => i.item.id === 'balance_sheets')).toMatchObject({ docId: null, state: 'missing' });
    r = await request(ctx.app, 'PUT', `/workspaces/${wsId}/mapping`, { cookie: s.org.analyst.cookie, json: { balance_sheets: 'auto' } });
    expect(r.body.readiness.items.find((i: any) => i.item.id === 'balance_sheets')).toMatchObject({ docId: s.docs.bsNew.id, auto: true });
    expect(r.body.workspace.mapping.balance_sheets).toBeUndefined();
  });

  it('picks up a newly uploaded document automatically (udyam)', async () => {
    const u = await upload(ctx, s.org.analyst.cookie, 'udyam', { type: 'udyam', title: 'Udyam certificate' });
    const r = await request(ctx.app, 'GET', `/workspaces/${wsId}`, { cookie: s.org.analyst.cookie });
    expect(r.body.readiness.items.find((i: any) => i.item.id === 'udyam')).toMatchObject({ docId: u.id, state: 'ready', auto: true });
  });

  it('rejects other orgs’ documents and unknown items', async () => {
    const other = await signup(ctx.app);
    const foreign = await upload(ctx, other.cookie, 'gst-other', { type: 'gst' });
    const r = await request(ctx.app, 'PUT', `/workspaces/${wsId}/mapping`, { cookie: s.org.analyst.cookie, json: { gst: foreign.id } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.fields.gst).toMatch(/not found/);
    expect((await request(ctx.app, 'PUT', `/workspaces/${wsId}/mapping`, { cookie: s.org.analyst.cookie, json: { nope: null } })).status).toBe(400);
  });
});

describe('comments & list', () => {
  it('posts and lists comments; viewers cannot post', async () => {
    expect((await request(ctx.app, 'POST', `/workspaces/${wsId}/comments`, { cookie: s.org.viewer.cookie, json: { body: 'hi' } })).status).toBe(403);
    const c = await request(ctx.app, 'POST', `/workspaces/${wsId}/comments`, { cookie: s.org.analyst.cookie, json: { body: 'MAF requested from Dell, ETA Friday.' } });
    expect(c.status).toBe(201);
    expect(c.body.user.name).toBe('Test analyst');
    const l = await request(ctx.app, 'GET', `/workspaces/${wsId}/comments`, { cookie: s.org.viewer.cookie });
    expect(l.body.items.map((x: any) => x.body)).toEqual(['MAF requested from Dell, ETA Friday.']);
    // owner (bid manager) is notified
    const n = await ctx.db.select().from(notifications).where(and(eq(notifications.userId, s.org.bidManager.me.user.id), eq(notifications.kind, 'mention')));
    expect(n).toHaveLength(1);
  });

  it('lists Kanban cards with tender summary, score, owner and readiness', async () => {
    const t2 = await seedTender(ctx, 2);
    await seedAnalysis(ctx, s.org.orgId, t2.id);
    await request(ctx.app, 'POST', `/tenders/${t2.id}/workspace`, { cookie: s.org.analyst.cookie });
    const r = await request(ctx.app, 'GET', '/workspaces', { cookie: s.org.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    const card = r.body.items.find((i: any) => i.id === wsId);
    expect(card).toMatchObject({
      stage: 'ready', owner: { name: 'Test bid manager' }, commentCount: 1,
      tender: { bidNumber: 'GEM/2026/B/700001', emdAmount: 150000 }, analysis: { score: 78, verdict: 'go' },
      readiness: { blockers: 1 },
    });
    expect(r.body.byStage).toEqual({ ready: 1, go: 1 });
    const f = await request(ctx.app, 'GET', '/workspaces?stage=go', { cookie: s.org.viewer.cookie });
    expect(f.body.items.map((i: any) => i.tender.bidNumber)).toEqual(['GEM/2026/B/700002']);
    const q = await request(ctx.app, 'GET', '/workspaces?q=batch%202', { cookie: s.org.viewer.cookie });
    expect(q.body.total).toBe(1);
    const mine = await request(ctx.app, 'GET', '/workspaces?mine=1', { cookie: s.org.analyst.cookie });
    expect(mine.body.total).toBe(2);
    expect((await request(ctx.app, 'GET', '/workspaces?stage=bogus', { cookie: s.org.viewer.cookie })).status).toBe(400);
  });
});

describe('POST /workspaces/:id/submitted & outcome', () => {
  it('records the human submission and the outcome with L1 price', async () => {
    const r = await request(ctx.app, 'POST', `/workspaces/${wsId}/submitted`, { cookie: s.org.analyst.cookie, json: { note: 'Submitted with DSC by Ravi' } });
    expect(r.status).toBe(200);
    expect(r.body.stage).toBe('submitted');
    expect(r.body.submittedAt).toBe(NOW.toISOString());
    const o = await request(ctx.app, 'PATCH', `/workspaces/${wsId}`, { cookie: s.org.bidManager.cookie, json: { outcome: { result: 'won', l1Price: 2_950_000, notes: 'L1 by 2%' } } });
    expect(o.status).toBe(200);
    expect(o.body.stage).toBe('won');
    expect(o.body.outcome).toMatchObject({ result: 'won', l1Price: 2_950_000 });
    expect((await request(ctx.app, 'POST', `/workspaces/${wsId}/submitted`, { cookie: s.org.analyst.cookie })).status).toBe(409);
    const acts = (await ctx.db.select().from(activityLog).where(eq(activityLog.entityId, wsId))).map((a) => a.action);
    expect(acts).toEqual(expect.arrayContaining(['workspace.created', 'workspace.stage_changed', 'workspace.item_overridden', 'workspace.mapping_changed', 'workspace.commented', 'workspace.submitted', 'workspace.outcome_recorded', 'workspace.assigned']));
  });
});
