/** Bid workspace API (T063, T067; FR-023, FR-028, US4 acceptance 1–2, US6 activity). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { activityLog, analyses, notifications, type ChecklistItem } from '@tp/db';
import { createTestContext, request, seedOrgWithRoles, signup, type TestContext } from './helpers';
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

  it('creates the workspace in "go" and stores an empty (all-automatic) mapping (US1 #1)', async () => {
    const r = await request(ctx.app, 'POST', `/tenders/${s.tender.id}/workspace`, { cookie: s.org.analyst.cookie });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    expect(r.body.stage).toBe('go');
    expect(r.body.owner.id).toBe(s.org.analyst.me.user.id);
    expect(r.body.dueAt).toBe('2026-11-20T09:30:00.000Z');
    // Nothing is stored: every item stays "automatic" (absent key, FR-014) and is resolved at read time.
    expect(r.body.mapping).toEqual({});
    const [created] = await ctx.db.select().from(activityLog).where(and(eq(activityLog.action, 'workspace.created'), eq(activityLog.entityId, r.body.id)));
    expect(created.meta).toMatchObject({ autoMatched: 4, stage: 'go' });
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
    const picks = Object.fromEntries(r.body.readiness.items.filter((i: any) => i.docId).map((i: any) => [i.item.id, [i.docId, i.auto]]));
    expect(picks).toEqual({
      gst: [s.docs.gst.id, true], pan: [s.docs.pan.id, true], balance_sheets: [s.docs.bsNew.id, true], oem_authorization: [s.docs.oem.id, true],
    });
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

describe('PATCH /workspaces/:id — won/lost only after submission (T020; 006/FR-008)', () => {
  let goId: string;
  beforeAll(async () => {
    const t = await seedTender(ctx, 4);
    await seedAnalysis(ctx, s.org.orgId, t.id);
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/workspace`, { cookie: s.org.analyst.cookie });
    expect(r.body.stage).toBe('go');
    goId = r.body.id;
  });

  it('won from go → 409 invalid_transition, stage unchanged', async () => {
    for (const json of [{ stage: 'won' }, { stage: 'lost' }, { outcome: { result: 'won' } }, { stage: 'preparing', outcome: { result: 'lost' } }]) {
      const r = await request(ctx.app, 'PATCH', `/workspaces/${goId}`, { cookie: s.org.analyst.cookie, json });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('invalid_transition');
      expect(r.body.error.message).toBe('Record the submission on GeM first — a bid can only be won or lost after it was submitted.');
    }
    const d = await request(ctx.app, 'GET', `/workspaces/${goId}`, { cookie: s.org.analyst.cookie });
    expect(d.body.workspace).toMatchObject({ stage: 'go', outcome: null });
  });

  it('submitted → preparing → outcome won → 409 (guard is stage-based, not submittedAt-based)', async () => {
    expect((await request(ctx.app, 'PATCH', `/workspaces/${goId}`, { cookie: s.org.analyst.cookie, json: { stage: 'submitted' } })).status).toBe(200);
    const back = await request(ctx.app, 'PATCH', `/workspaces/${goId}`, { cookie: s.org.analyst.cookie, json: { stage: 'preparing' } });
    expect(back.status).toBe(200);
    expect(back.body.submittedAt).not.toBeNull();
    const r = await request(ctx.app, 'PATCH', `/workspaces/${goId}`, { cookie: s.org.analyst.cookie, json: { outcome: { result: 'won' } } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('invalid_transition');
  });

  it('won from submitted → 200, and the result can be corrected to lost', async () => {
    expect((await request(ctx.app, 'PATCH', `/workspaces/${goId}`, { cookie: s.org.analyst.cookie, json: { stage: 'submitted' } })).status).toBe(200);
    const won = await request(ctx.app, 'PATCH', `/workspaces/${goId}`, { cookie: s.org.analyst.cookie, json: { stage: 'won' } });
    expect(won.status).toBe(200);
    expect(won.body.stage).toBe('won');
    const lost = await request(ctx.app, 'PATCH', `/workspaces/${goId}`, { cookie: s.org.analyst.cookie, json: { outcome: { result: 'lost' } } });
    expect(lost.status).toBe(200);
    expect(lost.body).toMatchObject({ stage: 'lost', outcome: { result: 'lost' } });
  });
});

describe('readiness without an analysis (T021; 006/FR-009)', () => {
  it('reports analysed:false and 0 % on the card and the detail', async () => {
    const t = await seedTender(ctx, 3);
    const c = await request(ctx.app, 'POST', `/tenders/${t.id}/workspace`, { cookie: s.org.analyst.cookie });
    expect(c.status).toBe(201);
    expect(c.body.stage).toBe('identified');
    const list = await request(ctx.app, 'GET', '/workspaces?stage=identified', { cookie: s.org.viewer.cookie });
    const card = list.body.items.find((i: any) => i.id === c.body.id);
    expect(card.analysis).toBeNull();
    expect(card.readiness).toEqual({ percent: 0, total: 0, covered: 0, blockers: 0, analysed: false });
    const d = await request(ctx.app, 'GET', `/workspaces/${c.body.id}`, { cookie: s.org.viewer.cookie });
    expect(d.body.readiness).toMatchObject({ percent: 0, total: 0, covered: 0, blockers: [], analysed: false, canMarkReady: false });
    // FR-005: cannot be marked ready without an analysis.
    const ready = await request(ctx.app, 'PATCH', `/workspaces/${c.body.id}`, { cookie: s.org.analyst.cookie, json: { stage: 'ready' } });
    expect(ready.status).toBe(409);
    expect(ready.body.error.code).toBe('conflict');
    expect(ready.body.error.message).toBe('Analyse the tender before marking the bid ready to submit.');
    expect(ready.body.error.details.reason).toBe('not_analysed');
    // Analysed workspaces say so.
    const other = await request(ctx.app, 'GET', `/workspaces/${wsId}`, { cookie: s.org.viewer.cookie });
    expect(other.body.readiness.analysed).toBe(true);
  });

  it('treats a running (unfinished) analysis as not analysed', async () => {
    const t = await seedTender(ctx, 5);
    const a = await seedAnalysis(ctx, s.org.orgId, t.id);
    await ctx.db.update(analyses).set({ status: 'running' }).where(eq(analyses.id, a.id));
    const c = await request(ctx.app, 'POST', `/tenders/${t.id}/workspace`, { cookie: s.org.analyst.cookie });
    expect(c.status).toBe(201);
    const d = await request(ctx.app, 'GET', `/workspaces/${c.body.id}`, { cookie: s.org.viewer.cookie });
    expect(d.body.readiness).toMatchObject({ percent: 0, total: 0, analysed: false, canMarkReady: false });
    const list = await request(ctx.app, 'GET', '/workspaces', { cookie: s.org.viewer.cookie });
    expect(list.body.items.find((i: any) => i.id === c.body.id).readiness).toEqual({ percent: 0, total: 0, covered: 0, blockers: 0, analysed: false });
    const ready = await request(ctx.app, 'PATCH', `/workspaces/${c.body.id}`, { cookie: s.org.analyst.cookie, json: { stage: 'ready' } });
    expect(ready.status).toBe(409);
    expect(ready.body.error.details.reason).toBe('not_analysed');
  });
});

describe('mapping & readiness edge cases (T028; 006/FR-013, FR-016, FR-017, FR-020)', () => {
  const EDGE: ChecklistItem[] = [
    { id: 'gst', label: 'GST registration certificate', docType: 'gst', mandatory: true, reason: 'Seller identity' },
    { id: 'pan', label: 'PAN card of the firm', docType: 'pan', mandatory: true, reason: 'Seller identity' },
    { id: 'oem_authorization', label: 'OEM authorisation certificate (MAF) for this bid', docType: 'oem_authorization', mandatory: true, reason: 'OEM' },
    { id: 'fire_noc', label: 'Fire safety NOC from municipal authority', docType: 'other', mandatory: false, reason: 'ATC' },
    { id: 'cert_iso_9001', label: 'ISO 9001 quality management certificate', docType: 'other', mandatory: false, reason: 'ATC' },
  ];
  let org: Awaited<ReturnType<typeof seedOrgWithRoles>>;
  let id: string;
  let d: Record<string, { id: string }>;
  const item = (body: any, itemId: string) => body.readiness.items.find((i: any) => i.item.id === itemId);
  const detail = async () => (await request(ctx.app, 'GET', `/workspaces/${id}`, { cookie: org.viewer.cookie })).body;

  beforeAll(async () => {
    org = await seedOrgWithRoles(ctx.app);
    const t = await seedTender(ctx, 6);
    await seedAnalysis(ctx, org.orgId, t.id, EDGE);
    const up = (n: string, f: Record<string, string>) => upload(ctx, org.analyst.cookie, n, f);
    d = {
      gstNew: await up('e1', { type: 'gst', title: 'GST REG-06 amended', issueDate: '2025-06-01' }),
      gstOld: await up('e2', { type: 'gst', title: 'GST REG-06 original', issueDate: '2019-04-01' }),
      panBest: await up('e3', { type: 'pan', title: 'PAN card', issueDate: '2024-01-01' }),
      panAlt: await up('e4', { type: 'pan', title: 'PAN card scan', issueDate: '2018-01-01' }),
      // NOW is 4 Nov 2026 (IST) → expires in 12 days.
      oem: await up('e5', { type: 'oem_authorization', title: 'Dell MAF', issueDate: '2026-05-16', expiryDate: '2026-11-16' }),
      // Shares only 2 of 5 significant words ("fire", "noc") with fire_noc → relevance 0.4, must not map.
      fireWeak: await up('e6', { type: 'other', title: 'Fire NOC Panipat' }),
      // Shares 2 of 5 words ("iso", "9001") with cert_iso_9001 → 0.4, must not map.
      isoWeak: await up('e7', { type: 'other', title: 'ISO 9001 audit summary' }),
    };
    const r = await request(ctx.app, 'POST', `/tenders/${t.id}/workspace`, { cookie: org.analyst.cookie });
    expect(r.status).toBe(201);
    id = r.body.id;
  });

  it('auto picks the best document; an expiring mandatory doc is covered, warned, not a blocker (FR-016, FR-017)', async () => {
    const b = await detail();
    expect(item(b, 'gst')).toMatchObject({ docId: d.gstNew.id, auto: true, state: 'ready' });
    expect(item(b, 'pan')).toMatchObject({ docId: d.panBest.id, auto: true, state: 'ready' });
    expect(item(b, 'oem_authorization')).toMatchObject({
      docId: d.oem.id, state: 'expiring', docStatus: 'expiring', daysToExpiry: 12, blocking: false, note: 'Expires in 12 day(s).',
    });
    expect(b.readiness).toMatchObject({ percent: 100, total: 3, covered: 3, blockers: [], canMarkReady: true });
    expect(b.readiness.warnings).toContainEqual({ itemId: 'oem_authorization', label: EDGE[2].label, state: 'expiring' });
  });

  it('`other` items do not map below relevance 0.5 (FR-013)', async () => {
    const b = await detail();
    expect(item(b, 'fire_noc')).toMatchObject({ docId: null, auto: true, state: 'missing', note: 'No matching document in the vault.' });
    expect(item(b, 'cert_iso_9001')).toMatchObject({ docId: null, auto: true, state: 'missing' });
    // optional uncovered items are warnings, never blockers
    expect(b.readiness.warnings.map((w: any) => w.itemId)).toEqual(expect.arrayContaining(['fire_noc', 'cert_iso_9001']));
    expect(b.readiness.blockers).toEqual([]);
  });

  it('`other` items map at relevance ≥ 0.5 or by an exact item-id tag, on the next read (FR-013, FR-020)', async () => {
    const fire = await upload(ctx, org.analyst.cookie, 'e8', { type: 'other', title: 'Fire safety NOC' }); // 3 of 5 words → 0.6
    const iso = await upload(ctx, org.analyst.cookie, 'e9', { type: 'other', title: 'Scan 0042', tags: 'cert_iso_9001' });
    const b = await detail();
    expect(item(b, 'fire_noc')).toMatchObject({ docId: fire.id, auto: true, state: 'ready' });
    expect(item(b, 'cert_iso_9001')).toMatchObject({ docId: iso.id, auto: true, state: 'ready' });
  });

  it('a deleted vault document: explicit mapping → missing, auto item → next best (FR-013, FR-016)', async () => {
    const m = await request(ctx.app, 'PUT', `/workspaces/${id}/mapping`, { cookie: org.analyst.cookie, json: { pan: d.panAlt.id } });
    expect(m.status).toBe(200);
    expect(item(m.body, 'pan')).toMatchObject({ docId: d.panAlt.id, auto: false, state: 'ready' });

    expect((await request(ctx.app, 'DELETE', `/vault/${d.panAlt.id}`, { cookie: org.analyst.cookie })).status).toBeLessThan(300);
    expect((await request(ctx.app, 'DELETE', `/vault/${d.gstNew.id}`, { cookie: org.analyst.cookie })).status).toBeLessThan(300);

    const b = await detail();
    // The dangling explicit id resolves to no document — it does NOT silently fall back to the other PAN.
    expect(item(b, 'pan')).toMatchObject({ docId: null, auto: false, state: 'missing', blocking: true, note: 'No matching document in the vault.' });
    expect(b.workspace.mapping.pan).toBe(d.panAlt.id);
    // The untouched GST item falls back to the next best GST document.
    expect(item(b, 'gst')).toMatchObject({ docId: d.gstOld.id, auto: true, state: 'ready' });
    expect(b.readiness).toMatchObject({ percent: 67, covered: 2, total: 3, canMarkReady: false });
    expect(b.readiness.blockers).toEqual([{ itemId: 'pan', label: EDGE[1].label, state: 'missing' }]);

    // Re-mapping to the deleted id is refused; "auto" restores the remaining PAN.
    const bad = await request(ctx.app, 'PUT', `/workspaces/${id}/mapping`, { cookie: org.analyst.cookie, json: { pan: d.panAlt.id } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields.pan).toBe('Document not found in your vault');
    const auto = await request(ctx.app, 'PUT', `/workspaces/${id}/mapping`, { cookie: org.analyst.cookie, json: { pan: 'auto' } });
    expect(item(auto.body, 'pan')).toMatchObject({ docId: d.panBest.id, auto: true, state: 'ready' });
    expect(auto.body.readiness.canMarkReady).toBe(true);
  });

  it('rejects unknown checklist items with the exact message; viewers cannot map', async () => {
    const r = await request(ctx.app, 'PUT', `/workspaces/${id}/mapping`, { cookie: org.analyst.cookie, json: { nope: null } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    expect(r.body.error.details.fields.nope).toBe('Not an item of this bid’s checklist');
    expect((await request(ctx.app, 'PUT', `/workspaces/${id}/mapping`, { cookie: org.viewer.cookie, json: { pan: 'auto' } })).status).toBe(403);
  });
});
