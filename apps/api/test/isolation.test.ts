/**
 * 002/FR-023, NFR-008, SC-003 — cross-org isolation sweep (T052, Constitution IV).
 *
 * Org A gets one of every org-scoped resource. Org B (signed in as its OWNER, so no role gate can be the reason
 * for a refusal) requests each of A's ids on every read/update/delete route: the answer must be 404 `not_found`
 * (never 403, never data), B's list endpoints must not contain A's rows, B cannot reference A's ids from its own
 * resources, and A's rows — snapshotted straight from the database — are byte-for-byte unchanged.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activityLog, analyses, annexureTemplates, apiTokens, bidWorkspaces, comments, companyProfiles, invitations, memberships, notificationPrefs,
  notifications, organizations, packets, pastContracts, sessions, tenderDocuments, tenderMatches, vaultDocuments, watchlists,
} from '@tp/db';
import { createTestContext, request, seedOrgWithRoles, uniqueEmail, type TestContext } from './helpers';
import { file, NOW, pdf, seedAnalysis, seedApply } from './workspace-fixtures';

let ctx: TestContext;
let A: Awaited<ReturnType<typeof seedApply>>;
let B: Awaited<ReturnType<typeof seedOrgWithRoles>>;
/** A's resource ids. */
const ids: Record<string, string> = {};

const json = (r: { status: number; text: string }) => `${r.status} ${r.text.slice(0, 200)}`;

async function snapshotA() {
  const oid = A.org.orgId;
  const userIds = [A.org.owner, A.org.bidManager, A.org.analyst, A.org.viewer].map((u) => u.me.user.id);
  const byOrg = async (t: any) => ctx.db.select().from(t).where(eq(t.orgId, oid)).orderBy(asc(t.createdAt ?? t.orgId));
  return JSON.stringify({
    org: await ctx.db.select().from(organizations).where(eq(organizations.id, oid)),
    memberships: await byOrg(memberships),
    invitations: await byOrg(invitations),
    apiTokens: await byOrg(apiTokens),
    prefs: await ctx.db.select().from(notificationPrefs).where(eq(notificationPrefs.orgId, oid)).orderBy(asc(notificationPrefs.userId)),
    profile: await ctx.db.select().from(companyProfiles).where(eq(companyProfiles.orgId, oid)),
    pastContracts: await byOrg(pastContracts),
    vault: await byOrg(vaultDocuments),
    tenderDocs: await byOrg(tenderDocuments),
    watchlists: await byOrg(watchlists),
    matches: await byOrg(tenderMatches),
    analyses: await byOrg(analyses),
    workspaces: await byOrg(bidWorkspaces),
    comments: await byOrg(comments),
    templates: await byOrg(annexureTemplates),
    packets: await byOrg(packets),
    notifications: await byOrg(notifications),
    activity: await ctx.db.select().from(activityLog).where(eq(activityLog.orgId, oid)).orderBy(asc(activityLog.id)),
    sessions: await ctx.db.select().from(sessions).where(inArray(sessions.userId, userIds)).orderBy(asc(sessions.id)),
  });
}

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW });
  A = await seedApply(ctx); // org with every role, profile, tender + "go" analysis, 5 vault docs
  B = await seedOrgWithRoles(ctx.app, 'Org B Intruders');
  const a = A.org;

  ids.tender = A.tender.id;
  ids.analysis = A.analysis.id;
  ids.vault = A.docs.gst.id;
  ids.wsMember = a.analyst.me.user.id;

  const ws = await request(ctx.app, 'POST', `/tenders/${A.tender.id}/workspace`, { cookie: a.analyst.cookie });
  expect(ws.status, json(ws)).toBe(201);
  ids.workspace = ws.body.id;

  const ov = await request(ctx.app, 'POST', `/workspaces/${ids.workspace}/overrides`, { cookie: a.bidManager.cookie, json: { itemId: 'oem_authorization', reason: 'OEM letter is on its way' } });
  expect(ov.status, json(ov)).toBe(201);

  const cm = await request(ctx.app, 'POST', `/workspaces/${ids.workspace}/comments`, { cookie: a.owner.cookie, json: { body: 'Org A secret pricing strategy' } });
  expect(cm.status, json(cm)).toBe(201);
  ids.comment = cm.body.id;

  const pk = await request(ctx.app, 'POST', `/workspaces/${ids.workspace}/packets`, { cookie: a.analyst.cookie, json: {} });
  expect(pk.status, json(pk)).toBe(201);
  ids.packet = pk.body.id;

  const td = await request(ctx.app, 'POST', `/tenders/${A.tender.id}/documents`, { cookie: a.analyst.cookie, form: { file: file(await pdf('A CORRIGENDUM'), 'a-corrigendum.pdf'), kind: 'corrigendum' } });
  expect(td.status, json(td)).toBe(201);
  ids.tenderDoc = td.body.id;

  const wl = await request(ctx.app, 'POST', '/watchlists', { cookie: a.analyst.cookie, json: { name: 'A laptops', criteria: { keywords: ['laptop'] } } });
  expect(wl.status, json(wl)).toBe(201);
  ids.watchlist = wl.body.id;
  // A's watchlist matched A's tender (unseen, not dismissed) — the feed filter below must not be vacuous.
  await ctx.db.insert(tenderMatches).values({ orgId: a.orgId, tenderId: A.tender.id, watchlistId: ids.watchlist, reasons: ['keyword: laptop'], relevance: 0.9 })
    .onConflictDoNothing();
  const [match] = await ctx.db.select().from(tenderMatches).where(eq(tenderMatches.orgId, a.orgId));
  expect(match).toMatchObject({ seen: false, dismissed: false });

  const pc = await request(ctx.app, 'POST', '/past-contracts', { cookie: a.analyst.cookie, json: { buyer: 'IOCL', title: 'Laptops 2025', value: 2_500_000, cracDocumentId: A.docs.gst.id } });
  expect(pc.status, json(pc)).toBe(201);
  ids.pastContract = pc.body.id;

  const tpl = await request(ctx.app, 'PUT', '/annexure-templates/non_blacklisting', { cookie: a.bidManager.cookie, json: { title: 'A custom NB', body: 'Org A custom non-blacklisting declaration text.' } });
  expect(tpl.status, json(tpl)).toBe(200);

  const tok = await request(ctx.app, 'POST', '/me/api-tokens', { cookie: a.owner.cookie, json: { name: 'A extension' } });
  expect(tok.status, json(tok)).toBe(201);
  ids.apiToken = tok.body.id;
  ids.apiTokenSecret = tok.body.token;

  const inv = await request(ctx.app, 'POST', '/org/invitations', { cookie: a.owner.cookie, json: { email: uniqueEmail('a-invitee'), role: 'analyst' } });
  expect(inv.status, json(inv)).toBe(201);
  ids.invitation = inv.body.id;

  const [n] = await ctx.db.insert(notifications).values({
    orgId: a.orgId, userId: a.owner.me.user.id, channel: 'in_app', kind: 'tender_match', title: 'A match', body: 'For org A only',
    link: `/tenders/${A.tender.id}`, status: 'sent', dedupeKey: 'iso:a', createdAt: NOW,
  }).returning();
  ids.notification = n.id;

  const sess = await request(ctx.app, 'GET', '/me/sessions', { cookie: a.owner.cookie });
  ids.session = sess.body.items[0].id;
});
afterAll(async () => { await ctx?.close(); });

describe('org B cannot read, update or delete org A’s resources by id (404, never 403, never data)', () => {
  const pdfBody = async () => ({ file: file(await pdf('B REPLACEMENT'), 'b.pdf') });
  const cases: [string, () => [string, string, { json?: unknown; form?: Record<string, string | Blob> }?] | Promise<[string, string, { json?: unknown; form?: Record<string, string | Blob> }?]>][] = [
    // tender analysis (+ org-owned tender documents)
    ['GET analysis', () => ['GET', `/tenders/${ids.tender}/analysis`]],
    ['override analysis', () => ['POST', `/analyses/${ids.analysis}/override`, { json: { factorKey: 'turnover', status: 'pass', reason: 'B tampering' } }]],
    ['download A’s tender document', () => ['GET', `/tenders/${ids.tender}/documents/${ids.tenderDoc}/download`]],
    ['delete A’s tender document', () => ['DELETE', `/tenders/${ids.tender}/documents/${ids.tenderDoc}`]],
    // watchlist
    ['update watchlist', () => ['PATCH', `/watchlists/${ids.watchlist}`, { json: { name: 'B renamed' } }]],
    ['delete watchlist', () => ['DELETE', `/watchlists/${ids.watchlist}`]],
    // vault document
    ['read vault doc', () => ['GET', `/vault/${ids.vault}`]],
    ['download vault doc', () => ['GET', `/vault/${ids.vault}/download`]],
    ['update vault doc', () => ['PATCH', `/vault/${ids.vault}`, { json: { title: 'B renamed' } }]],
    ['replace vault file', async () => ['PUT', `/vault/${ids.vault}/file`, { form: await pdfBody() }]],
    ['delete vault doc', () => ['DELETE', `/vault/${ids.vault}`]],
    // past contract
    ['update past contract', () => ['PATCH', `/past-contracts/${ids.pastContract}`, { json: { buyer: 'B' } }]],
    ['delete past contract', () => ['DELETE', `/past-contracts/${ids.pastContract}`]],
    // workspace (and everything under it)
    ['read workspace', () => ['GET', `/workspaces/${ids.workspace}`]],
    ['update workspace', () => ['PATCH', `/workspaces/${ids.workspace}`, { json: { stage: 'dropped' } }]],
    ['map workspace docs', () => ['PUT', `/workspaces/${ids.workspace}/mapping`, { json: { gst: null } }]],
    ['add override', () => ['POST', `/workspaces/${ids.workspace}/overrides`, { json: { itemId: 'gst', reason: 'B tampering here' } }]],
    ['remove override', () => ['DELETE', `/workspaces/${ids.workspace}/overrides/oem_authorization`]],
    ['save assist values', () => ['PUT', `/workspaces/${ids.workspace}/assist-values`, { json: { contactName: 'B' } }]],
    ['mark submitted', () => ['POST', `/workspaces/${ids.workspace}/submitted`, { json: {} }]],
    ['assist payload', () => ['GET', `/assist/${ids.workspace}`]],
    ['render annexure', () => ['GET', `/workspaces/${ids.workspace}/annexures/non_blacklisting.pdf`]],
    ['preview annexure', () => ['POST', `/workspaces/${ids.workspace}/annexures/non_blacklisting/preview`, { json: { title: 'B preview', body: 'B preview body that is long enough.' } }]],
    // comments
    ['list comments', () => ['GET', `/workspaces/${ids.workspace}/comments`]],
    ['add comment', () => ['POST', `/workspaces/${ids.workspace}/comments`, { json: { body: 'B was here' } }]],
    // packets
    ['list packets', () => ['GET', `/workspaces/${ids.workspace}/packets`]],
    ['build packet', () => ['POST', `/workspaces/${ids.workspace}/packets`, { json: {} }]],
    ['download packet', () => ['GET', `/packets/${ids.packet}/download`]],
    // notification
    ['mark notification read', () => ['POST', `/notifications/${ids.notification}/read`]],
    // API token, invitation, member, session
    ['revoke API token', () => ['DELETE', `/me/api-tokens/${ids.apiToken}`]],
    ['revoke invitation', () => ['DELETE', `/org/invitations/${ids.invitation}`]],
    ['change member role', () => ['PATCH', `/org/members/${ids.wsMember}`, { json: { role: 'viewer' } }]],
    ['remove member', () => ['DELETE', `/org/members/${ids.wsMember}`]],
    ['revoke session', () => ['DELETE', `/me/sessions/${ids.session}`]],
    ['switch into org A', () => ['POST', '/auth/switch-org', { json: { orgId: A.org.orgId } }]],
  ];

  it('every by-id route answers 404 not_found and A’s rows are unchanged', async () => {
    const before = await snapshotA();
    const failures: string[] = [];
    for (const [name, build] of cases) {
      const [method, path, body] = await build();
      for (const who of [B.owner, B.viewer]) {
        const r = await request(ctx.app, method, path, { cookie: who.cookie, ...body });
        if (who === B.viewer && r.status === 403 && method !== 'GET') continue; // the viewer's role gate may answer first
        if (r.status !== 404 || r.body?.error?.code !== 'not_found') failures.push(`${name} (${method} ${path}) as ${who.me.role}: ${json(r)}`);
      }
    }
    expect(failures).toEqual([]);

    // Tenders are shared, so seen/dismiss on A's matched tender are legitimate calls for B — they must only touch
    // B's own matches (none): seen is a no-op 200, dismiss is 409 "only matched tenders". A's match stays as it was.
    const seen = await request(ctx.app, 'POST', `/tenders/${ids.tender}/seen`, { cookie: B.owner.cookie });
    expect(seen.status, json(seen)).toBe(200);
    const dismiss = await request(ctx.app, 'POST', `/tenders/${ids.tender}/dismiss`, { cookie: B.owner.cookie, json: {} });
    expect(dismiss.status, json(dismiss)).toBe(409);
    const undo = await request(ctx.app, 'POST', `/tenders/${ids.tender}/dismiss`, { cookie: B.owner.cookie, json: { undo: true } });
    expect(undo.status, json(undo)).toBe(409);

    expect(await snapshotA()).toBe(before);
  });
});

describe('org B’s lists and aggregates never include org A’s rows', () => {
  it('lists, tender detail, activity and dashboard are scoped', async () => {
    const c = { cookie: B.owner.cookie };
    const get = (p: string) => request(ctx.app, 'GET', p, c);
    expect((await get('/watchlists')).body.items).toEqual([]);
    expect((await get('/vault')).body.items).toEqual([]);
    expect((await get('/past-contracts')).body.items).toEqual([]);
    expect((await get('/workspaces')).body.items).toEqual([]);
    expect((await get('/notifications')).body.items).toEqual([]);
    expect((await get('/me/api-tokens')).body.items).toEqual([]);
    expect((await get('/me/sessions')).body.items.map((s: any) => s.id)).not.toContain(ids.session);
    const tpl = (await get('/annexure-templates')).body.items.find((t: any) => t.key === 'non_blacklisting');
    expect(tpl.custom).toBe(false);
    const prof = await get('/profile');
    expect(JSON.stringify(prof.body)).not.toContain('Sharma Infotech');

    const members = (await get('/org/members')).body;
    expect(members.items.map((m: any) => m.userId)).not.toContain(ids.wsMember);
    expect(members.invitations.map((i: any) => i.id)).not.toContain(ids.invitation);

    // Tenders are shared (public GeM data), but A's analysis, workspace and uploaded documents are not.
    const t = await get(`/tenders/${ids.tender}`);
    expect(t.status).toBe(200);
    expect(t.body.analysis ?? null).toBeNull();
    expect(t.body.analysisDetail ?? null).toBeNull();
    expect(t.body.workspace ?? null).toBeNull();
    expect(t.body.documents.map((d: any) => d.id)).not.toContain(ids.tenderDoc);
    const docs = await get(`/tenders/${ids.tender}/documents`);
    expect(docs.body.items.map((d: any) => d.id)).not.toContain(ids.tenderDoc);

    const act = await get(`/activity?entityId=${ids.workspace}`);
    expect(act.status).toBe(200);
    expect(act.body.items).toEqual([]);
    const allAct = JSON.stringify((await get('/activity?pageSize=100')).body);
    for (const id of [ids.workspace, ids.vault, ids.watchlist, ids.packet, ids.invitation]) expect(allAct).not.toContain(id);

    const dash = JSON.stringify((await get('/dashboard')).body);
    for (const id of [ids.workspace, ids.vault, ids.watchlist, ids.tender]) expect(dash).not.toContain(id);

    // A sees its match through the watchlist filter; B, passing A's watchlist id, sees nothing.
    const feedA = await request(ctx.app, 'GET', `/tenders?watchlistId=${ids.watchlist}`, { cookie: A.org.viewer.cookie });
    expect(feedA.body.items.map((t: any) => t.id)).toEqual([ids.tender]);
    const feedB = await get(`/tenders?watchlistId=${ids.watchlist}`);
    expect(feedB.status).toBe(200);
    expect(feedB.body.items).toEqual([]);
    expect(JSON.stringify((await get(`/tenders/${ids.tender}`)).body.matches ?? [])).not.toContain(ids.watchlist);
  });

  it('A’s API token stays bound to org A (it never acts in B’s org)', async () => {
    const r = await request(ctx.app, 'GET', '/auth/me', { bearer: ids.apiTokenSecret });
    expect(r.body.org.id).toBe(A.org.orgId);
    expect((await request(ctx.app, 'GET', `/workspaces/${ids.workspace}`, { bearer: ids.apiTokenSecret })).status).toBe(200);
  });
});

describe('org B cannot reference org A’s ids from its own resources', () => {
  it('mapping, packet items, past-contract CRAC links and assignees reject A’s ids', async () => {
    await seedAnalysis(ctx, B.orgId, A.tender.id);
    const ws = await request(ctx.app, 'POST', `/tenders/${A.tender.id}/workspace`, { cookie: B.analyst.cookie });
    expect(ws.status, json(ws)).toBe(201);
    const bws = ws.body.id;
    const before = await snapshotA();
    const c = { cookie: B.owner.cookie };

    const map = await request(ctx.app, 'PUT', `/workspaces/${bws}/mapping`, { ...c, json: { gst: ids.vault } });
    expect(map.status, json(map)).toBe(400);

    const pk = await request(ctx.app, 'POST', `/workspaces/${bws}/packets`, { ...c, json: { items: [{ kind: 'vault', refId: ids.vault, title: 'A GST' }] } });
    expect(pk.status, json(pk)).toBe(400);
    const pk2 = await request(ctx.app, 'POST', `/workspaces/${bws}/packets`, { ...c, json: { items: [{ kind: 'tender_doc', refId: ids.tenderDoc, title: 'A corrigendum' }] } });
    expect(pk2.status, json(pk2)).toBe(400);

    const pc = await request(ctx.app, 'POST', '/past-contracts', { ...c, json: { buyer: 'X', title: 'Y', value: 100, cracDocumentId: ids.vault } });
    expect([400, 404], json(pc)).toContain(pc.status);

    const asg = await request(ctx.app, 'PATCH', `/workspaces/${bws}`, { ...c, json: { assigneeIds: [ids.wsMember] } });
    expect(asg.status, json(asg)).toBe(400);
    const own = await request(ctx.app, 'PATCH', `/workspaces/${bws}`, { ...c, json: { ownerId: ids.wsMember } });
    expect(own.status, json(own)).toBe(400);

    const prof = await request(ctx.app, 'PUT', '/profile', { ...c, json: { oemAuthorizations: [{ oem: 'Dell', products: 'Laptops', documentId: ids.vault }] } });
    expect(prof.status, json(prof)).toBe(400);
    expect(prof.body.error.details.fields).toEqual({ 'oemAuthorizations.0.documentId': 'Pick an OEM authorisation from your vault' });

    expect(await snapshotA()).toBe(before);
  });
});
