/**
 * 008/US3 scenario 4 — contract-driven cross-org isolation sweep (008/FR-016, extends 002 T052, NFR-005).
 *
 * Every route of `specs/001-gem-tender-copilot/contracts/api.md` is parsed from the contract. Each route with a path
 * parameter must be listed below:
 * - `foreign`: org B's owner calls it with org A's ids → exactly 404 `not_found` (never 200/403);
 * - `global`: the parameter names public data (a GeM tender, a template key), so the call is allowed but may only touch
 *   org B's own rows.
 * After all calls, every row of org A (every table with an `org_id` column) is byte-for-byte unchanged, and every id
 * used has a positive control (org A itself gets 2xx), so a 404 can't come from a bad fixture.
 * A new parameterised route — in the contract OR registered on the Hono app — fails this test until it is covered.
 * Demo tenders (008/FR-016): a non-demo org gets 404 on every `/tenders/:id*` route and no GeM request is made.
 * (Spec 002's own sweep lives in isolation.test.ts.)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNotNull } from 'drizzle-orm';
import { bidWorkspaces, notifications, tenderMatches, tenders } from '@tp/db';
import { createTestContext, request, signup, type SignedUp, type TestContext, type TestResponse } from './helpers';
import { NOW, file, pdf, seedApply } from './workspace-fixtures';

const CONTRACT = fileURLToPath(new URL('../../../specs/001-gem-tender-copilot/contracts/api.md', import.meta.url));

/** `METHOD /path` for every route in the contract tables (methods split on "/", optional `[/:id]` segments expanded). */
export function contractRoutes(markdown: string): string[] {
  const out = new Set<string>();
  for (const line of markdown.split('\n')) {
    const m = /^\|\s*([A-Z/]+)\s*(?:\([A-Z]\))?\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m || !/^(GET|POST|PUT|PATCH|DELETE)/.test(m[1]!)) continue;
    const methods = m[1]!.split('/').filter(Boolean);
    const paths = m[2]!.split(',').map((p) => p.trim()).filter((p) => p.startsWith('/'));
    for (const method of methods) {
      for (const p of paths) {
        const opt = /\[(\/:[^\]]+)\]/.exec(p);
        // `/me/api-tokens[/:id]`: collection methods use the bare path, item methods the id.
        const path = opt ? (['GET', 'POST'].includes(method) ? p.replace(opt[0], '') : p.replace(opt[0], opt[1]!)) : p;
        out.add(`${method} ${path}`);
      }
    }
  }
  return [...out].sort();
}

let ctx: TestContext;
let A: Awaited<ReturnType<typeof seedApply>>;
let B: SignedUp;
const ids: Record<string, string> = {};
/** Outbound requests (GeM) made by the app. */
const gemCalls: string[] = [];
let demoTenderId: string;

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW, fetch: async (input) => { gemCalls.push(String(input)); return new Response('not found', { status: 404 }); } });
  A = await seedApply(ctx);
  const a = A.org;
  const ok = (r: TestResponse, what: string) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };

  ids.tender = A.tender.id;
  ids.analysis = A.analysis.id;
  ids.vault = A.docs.gst.id;
  ids.workspace = ok(await request(ctx.app, 'POST', `/tenders/${ids.tender}/workspace`, { cookie: a.analyst.cookie }), 'workspace').id;
  ids.comment = ok(await request(ctx.app, 'POST', `/workspaces/${ids.workspace}/comments`, { cookie: a.analyst.cookie, json: { body: 'Org A only' } }), 'comment').id;
  ok(await request(ctx.app, 'POST', `/workspaces/${ids.workspace}/overrides`, { cookie: a.bidManager.cookie, json: { itemId: 'oem_authorization', reason: 'Renewed MAF arriving tomorrow' } }), 'override');
  ids.packet = ok(await request(ctx.app, 'POST', `/workspaces/${ids.workspace}/packets`, { cookie: a.analyst.cookie, json: {} }), 'packet').id;
  ids.watchlist = ok(await request(ctx.app, 'POST', '/watchlists', { cookie: a.analyst.cookie, json: { name: 'A laptops', criteria: { keywords: ['laptop'] } } }), 'watchlist').id;
  ids.pastContract = ok(await request(ctx.app, 'POST', '/past-contracts', {
    cookie: a.analyst.cookie, json: { buyer: 'NIC, MeitY', title: 'Supply of 200 laptops', value: 12_000_000, startDate: '2024-04-01', endDate: '2024-09-30' },
  }), 'past contract').id;
  ids.tenderDoc = ok(await request(ctx.app, 'POST', `/tenders/${ids.tender}/documents`, { cookie: a.analyst.cookie, form: { file: file(await pdf('A bid doc'), 'a-bid.pdf') } }), 'tender doc').id;
  ids.vaultReplaced = A.docs.pan.id;
  ok(await request(ctx.app, 'PUT', `/vault/${ids.vaultReplaced}/file`, { cookie: a.analyst.cookie, form: { file: file(await pdf('PAN v2'), 'pan-v2.pdf') } }), 'replace file');
  ids.vaultVersion = ok(await request(ctx.app, 'GET', `/vault/${ids.vaultReplaced}/versions`, { cookie: a.viewer.cookie }), 'versions').items[0].id;
  ids.apiToken = ok(await request(ctx.app, 'POST', '/me/api-tokens', { cookie: a.owner.cookie, json: { name: 'A extension' } }), 'token').id;
  ids.invitation = ok(await request(ctx.app, 'POST', '/org/invitations', { cookie: a.owner.cookie, json: { email: 'new.hire@a.example.in', role: 'viewer' } }), 'invite').id;
  ids.memberUser = a.analyst.me.user.id;
  ids.session = ok(await request(ctx.app, 'GET', '/me/sessions', { cookie: a.owner.cookie }), 'sessions').items[0].id;
  const [n] = await ctx.db.insert(notifications).values({
    orgId: a.orgId, userId: a.owner.me.user.id, channel: 'in_app', kind: 'tender_match', title: 'A alert', body: 'x',
    link: `/tenders/${ids.tender}`, dedupeKey: `tender:${ids.tender}:${a.orgId}`, status: 'sent',
  }).returning();
  ids.notification = n!.id;
  await ctx.db.insert(tenderMatches).values({ orgId: a.orgId, tenderId: ids.tender, watchlistId: ids.watchlist }).onConflictDoNothing();

  B = await signup(ctx.app, { orgName: 'Org B Intruder' }); // owner: no role check can mask a 404

  // A third org loads the demo: its tenders must not exist for B.
  const D = await signup(ctx.app, { orgName: 'Org D Demo' });
  ok(await request(ctx.app, 'POST', '/demo/seed', { cookie: D.cookie }), 'demo seed');
  const [demo] = await ctx.db.select({ id: tenders.id }).from(tenders).where(and(eq(tenders.source, 'demo'), isNotNull(tenders.gemBidId))).limit(1);
  demoTenderId = demo!.id;
});
afterAll(() => ctx?.close());

type Call = () => Promise<TestResponse>;
const asB = (method: string, path: string, json?: unknown): Call => () => request(ctx.app, method, path, { cookie: B.cookie, json });
const asBForm = (method: string, path: string): Call => async () =>
  request(ctx.app, method, path, { cookie: B.cookie, form: { file: file(await pdf('B'), 'b.pdf'), type: 'gst', title: 'B doc' } });

/** Routes whose path parameter is another org's id: B must get 404. */
const FOREIGN: Record<string, () => Call> = {
  'DELETE /me/api-tokens/:id': () => asB('DELETE', `/me/api-tokens/${ids.apiToken}`),
  'PATCH /org/members/:userId': () => asB('PATCH', `/org/members/${ids.memberUser}`, { role: 'viewer' }),
  'DELETE /org/members/:userId': () => asB('DELETE', `/org/members/${ids.memberUser}`),
  'PATCH /watchlists/:id': () => asB('PATCH', `/watchlists/${ids.watchlist}`, { name: 'Hijacked' }),
  'DELETE /watchlists/:id': () => asB('DELETE', `/watchlists/${ids.watchlist}`),
  'POST /notifications/:id/read': () => asB('POST', `/notifications/${ids.notification}/read`),
  'GET /tenders/:id/documents/:docId/download': () => asB('GET', `/tenders/${ids.tender}/documents/${ids.tenderDoc}/download`),
  'GET /tenders/:id/analysis': () => asB('GET', `/tenders/${ids.tender}/analysis`),
  'POST /analyses/:id/override': () => asB('POST', `/analyses/${ids.analysis}/override`, { factorKey: 'emd', status: 'fail', reason: 'Hijack attempt' }),
  'GET /vault/:id': () => asB('GET', `/vault/${ids.vault}`),
  'PUT /vault/:id/file': () => asBForm('PUT', `/vault/${ids.vault}/file`),
  'PATCH /past-contracts/:id': () => asB('PATCH', `/past-contracts/${ids.pastContract}`, { value: 1 }),
  'DELETE /past-contracts/:id': () => asB('DELETE', `/past-contracts/${ids.pastContract}`),
  'PATCH /vault/:id': () => asB('PATCH', `/vault/${ids.vault}`, { title: 'Hijacked' }),
  'DELETE /vault/:id': () => asB('DELETE', `/vault/${ids.vault}`),
  'GET /vault/:id/download': () => asB('GET', `/vault/${ids.vault}/download`),
  'GET /workspaces/:id': () => asB('GET', `/workspaces/${ids.workspace}`),
  'PATCH /workspaces/:id': () => asB('PATCH', `/workspaces/${ids.workspace}`, { stage: 'preparing' }),
  'PUT /workspaces/:id/mapping': () => asB('PUT', `/workspaces/${ids.workspace}/mapping`, { gst: null }),
  'POST /workspaces/:id/overrides': () => asB('POST', `/workspaces/${ids.workspace}/overrides`, { itemId: 'gst', reason: 'Hijack attempt' }),
  'GET /workspaces/:id/comments': () => asB('GET', `/workspaces/${ids.workspace}/comments`),
  'POST /workspaces/:id/comments': () => asB('POST', `/workspaces/${ids.workspace}/comments`, { body: 'Hijack' }),
  'DELETE /workspaces/:id/comments/:commentId': () => asB('DELETE', `/workspaces/${ids.workspace}/comments/${ids.comment}`),
  'GET /workspaces/:id/annexures/:key.pdf': () => asB('GET', `/workspaces/${ids.workspace}/annexures/non_blacklisting.pdf`),
  'POST /workspaces/:id/packets': () => asB('POST', `/workspaces/${ids.workspace}/packets`, {}),
  'GET /packets/:id/download': () => asB('GET', `/packets/${ids.packet}/download`),
  'GET /assist/:workspaceId': () => asB('GET', `/assist/${ids.workspace}`),
  'DELETE /tenders/:id/documents/:docId': () => asB('DELETE', `/tenders/${ids.tender}/documents/${ids.tenderDoc}`),
  'GET /vault/:id/versions': () => asB('GET', `/vault/${ids.vaultReplaced}/versions`),
  'GET /vault/:id/versions/:versionId/download': () => asB('GET', `/vault/${ids.vaultReplaced}/versions/${ids.vaultVersion}/download`),
  'PUT /workspaces/:id/assist-values': () => asB('PUT', `/workspaces/${ids.workspace}/assist-values`, { make: 'Hijack' }),
  'POST /workspaces/:id/submitted': () => asB('POST', `/workspaces/${ids.workspace}/submitted`, { note: 'Hijack' }),
};

/** Implemented routes not (yet) in the contract, swept the same way. */
const FOREIGN_EXTRA: Record<string, () => Call> = {
  'DELETE /org/invitations/:id': () => asB('DELETE', `/org/invitations/${ids.invitation}`),
  'POST /org/invitations/:id/resend': () => asB('POST', `/org/invitations/${ids.invitation}/resend`),
  'DELETE /me/sessions/:id': () => asB('DELETE', `/me/sessions/${ids.session}`),
  'GET /workspaces/:id/packets': () => asB('GET', `/workspaces/${ids.workspace}/packets`),
  'DELETE /workspaces/:id/overrides/:itemId': () => asB('DELETE', `/workspaces/${ids.workspace}/overrides/oem_authorization`),
  'POST /workspaces/:id/annexures/:key/preview': () =>
    asB('POST', `/workspaces/${ids.workspace}/annexures/authority_letter/preview`, { title: 'Authority', body: 'Draft body for {{tender.bidNumber}}.' }),
};

/** Parameter is public/global data; the call may succeed but must only affect org B. Run after the foreign sweep. */
const GLOBAL: Record<string, { why: string; call: () => Call }> = {
  'GET /tenders/:id': { why: 'GeM tenders are public', call: () => asB('GET', `/tenders/${ids.tender}`) },
  'POST /tenders/:id/seen': { why: 'marks B’s own matches', call: () => asB('POST', `/tenders/${ids.tender}/seen`) },
  'POST /tenders/:id/dismiss': { why: 'dismisses B’s own matches', call: () => asB('POST', `/tenders/${ids.tender}/dismiss`) },
  'POST /tenders/:id/documents': { why: 'uploads into B’s org', call: () => asBForm('POST', `/tenders/${ids.tender}/documents`) },
  'POST /tenders/:id/fetch-documents': { why: 'public GeM documents', call: () => asB('POST', `/tenders/${ids.tender}/fetch-documents`) },
  'POST /tenders/:id/analyse': { why: 'creates B’s own analysis', call: () => asB('POST', `/tenders/${ids.tender}/analyse`) },
  'POST /tenders/:id/workspace': { why: 'creates B’s own workspace', call: () => asB('POST', `/tenders/${ids.tender}/workspace`) },
  'GET /tenders/:id/documents': { why: 'public GeM documents + B’s own uploads', call: () => asB('GET', `/tenders/${ids.tender}/documents`) },
  'GET /tenders/:id/result-hint': { why: 'public GeM tender; needs B’s own workspace (404 otherwise), read-only', call: () => asB('GET', `/tenders/${ids.tender}/result-hint`) },
  'DELETE /annexure-templates/:key': {
    why: 'key is a template name; resets B’s own override',
    call: () => asB('DELETE', '/annexure-templates/non_blacklisting'),
  },
  'PUT /annexure-templates/:key': {
    why: 'key is a template name; writes B’s own override',
    call: () => asB('PUT', '/annexure-templates/non_blacklisting', { title: 'B undertaking', body: 'We, {{legalName}}, are not blacklisted.' }),
  },
};

/**
 * Positive controls: org A reaches each id the foreign sweep uses (2xx), read-only. The value is the id's key in `ids`.
 */
const asA = (path: string) => request(ctx.app, 'GET', path, { cookie: A.org.owner.cookie });
const listed = (path: string, key = 'items') => async (id: string) => {
  const r = await asA(path);
  const rows = (Array.isArray(r.body) ? r.body : r.body[key] ?? []) as { id?: string; userId?: string }[];
  return { status: r.status, found: rows.some((x) => x.id === id || x.userId === id) };
};
const CONTROLS: Record<string, (id: string) => Promise<{ status: number; found: boolean }>> = {
  apiToken: listed('/me/api-tokens'),
  memberUser: listed('/org/members'),
  invitation: listed('/org/members', 'invitations'),
  session: listed('/me/sessions'),
  watchlist: listed('/watchlists'),
  pastContract: listed('/past-contracts'),
  notification: listed('/notifications'),
  comment: async (id) => { const r = await asA(`/workspaces/${ids.workspace}/comments`); return { status: r.status, found: r.body.items.some((c: { id: string }) => c.id === id) }; },
  analysis: async (id) => { const r = await asA(`/tenders/${ids.tender}/analysis`); return { status: r.status, found: r.body.id === id }; },
  vault: async (id) => { const r = await asA(`/vault/${id}`); return { status: r.status, found: r.body.id === id }; },
  vaultReplaced: async (id) => { const r = await asA(`/vault/${id}/versions`); return { status: r.status, found: r.body.items.length > 0 }; },
  vaultVersion: async (id) => { const r = await asA(`/vault/${ids.vaultReplaced}/versions/${id}/download`); return { status: r.status, found: r.status === 200 }; },
  tenderDoc: async (id) => { const r = await asA(`/tenders/${ids.tender}/documents/${id}/download`); return { status: r.status, found: r.status === 200 }; },
  workspace: async (id) => { const r = await asA(`/workspaces/${id}`); return { status: r.status, found: r.status === 200 }; },
  packet: async (id) => { const r = await asA(`/packets/${id}/download`); return { status: r.status, found: r.status === 200 }; },
  tender: async (id) => { const r = await asA(`/tenders/${id}`); return { status: r.status, found: r.body.id === id }; },
};

/** Demo tender (another org's demo) on every /tenders/:id* route, as non-demo org B: 404 every time. */
const DEMO_CASES: Record<string, () => Call> = {
  'GET /tenders/:id': () => asB('GET', `/tenders/${demoTenderId}`),
  'POST /tenders/:id/seen': () => asB('POST', `/tenders/${demoTenderId}/seen`),
  'POST /tenders/:id/dismiss': () => asB('POST', `/tenders/${demoTenderId}/dismiss`),
  'GET /tenders/:id/documents': () => asB('GET', `/tenders/${demoTenderId}/documents`),
  'POST /tenders/:id/documents': () => asBForm('POST', `/tenders/${demoTenderId}/documents`),
  'POST /tenders/:id/fetch-documents': () => asB('POST', `/tenders/${demoTenderId}/fetch-documents`),
  'DELETE /tenders/:id/documents/:docId': () => asB('DELETE', `/tenders/${demoTenderId}/documents/${crypto.randomUUID()}`),
  'GET /tenders/:id/documents/:docId/download': () => asB('GET', `/tenders/${demoTenderId}/documents/${crypto.randomUUID()}/download`),
  'POST /tenders/:id/analyse': () => asB('POST', `/tenders/${demoTenderId}/analyse`),
  'GET /tenders/:id/analysis': () => asB('GET', `/tenders/${demoTenderId}/analysis`),
  'POST /tenders/:id/workspace': () => asB('POST', `/tenders/${demoTenderId}/workspace`),
  'GET /tenders/:id/result-hint': () => asB('GET', `/tenders/${demoTenderId}/result-hint`),
};

/** Registered path → sweep key where the code's parameter name differs from the contract's. */
const ROUTE_ALIASES: Record<string, string> = {
  'GET /workspaces/:id/annexures/:file': 'GET /workspaces/:id/annexures/:key.pdf',
};
/** Parameterised routes that are not about another org's data. */
const NOT_ORG_SCOPED: Record<string, string> = {
  'GET /auth/invite/:token': 'public invitation preview by secret token',
};

/** `METHOD /path` for every parameterised route registered on the app (without the /api prefix). */
function appRoutes(): string[] {
  const out = new Set<string>();
  for (const r of ctx.app.routes) {
    if (r.method === 'ALL' || !r.path.startsWith('/api/') || !r.path.includes('/:')) continue;
    const key = `${r.method} ${r.path.slice(4)}`;
    out.add(ROUTE_ALIASES[key] ?? key);
  }
  return [...out].sort();
}

/** Every row of org A in every table that has an `org_id` column (plus A's organization row). */
async function snapshotOrgA(): Promise<string> {
  const res = await ctx.db.execute(sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'org_id' order by table_name`);
  const tables = (res as unknown as { rows: { table_name: string }[] }).rows.map((r) => r.table_name);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const rows = await ctx.db.execute(sql.raw(`select * from "${t}" where org_id = '${A.org.orgId}' order by 1`));
    out[t] = (rows as unknown as { rows: unknown[] }).rows;
  }
  const org = await ctx.db.execute(sql.raw(`select * from organizations where id = '${A.org.orgId}'`));
  out.organizations = (org as unknown as { rows: unknown[] }).rows;
  return JSON.stringify(out);
}

describe('cross-org isolation sweep (contracts/api.md)', () => {
  it('the contract parser finds the routes', () => {
    const routes = contractRoutes(readFileSync(CONTRACT, 'utf8'));
    expect(routes).toContain('DELETE /me/api-tokens/:id');
    expect(routes).toContain('GET /me/api-tokens');
    expect(routes).toContain('POST /tenders/:id/dismiss');
    expect(routes).toContain('PUT /annexure-templates/:key');
    expect(routes).not.toContain('GET /me/api-tokens/:id');
    expect(routes.length).toBeGreaterThan(60);
  });

  it('every parameterised route in the contract is covered (foreign → 404, or global with a reason)', () => {
    const uncovered = contractRoutes(readFileSync(CONTRACT, 'utf8'))
      .filter((r) => r.includes('/:'))
      .filter((r) => !(r in FOREIGN) && !(r in GLOBAL));
    expect(uncovered, 'add these routes to test/isolation-contract.test.ts').toEqual([]);
  });

  it('every parameterised route registered on the app is covered too (S5)', () => {
    const routes = appRoutes();
    expect(routes.length).toBeGreaterThan(40);
    const covered = (r: string) => r in FOREIGN || r in FOREIGN_EXTRA || r in GLOBAL || r in NOT_ORG_SCOPED;
    expect(routes.filter((r) => !covered(r)), 'add these routes to test/isolation-contract.test.ts').toEqual([]);
  });

  it('positive controls: org A gets 2xx for every id the sweep uses', async () => {
    const bad: string[] = [];
    for (const [key, check] of Object.entries(CONTROLS)) {
      const r = await check(ids[key]!);
      if (r.status < 200 || r.status >= 300 || !r.found) bad.push(`${key}: ${r.status} found=${r.found}`);
    }
    expect(bad).toEqual([]);
    expect(Object.keys(ids).filter((k) => !(k in CONTROLS))).toEqual([]);
  });

  it('B2: demo tenders do not exist for a non-demo org on any /tenders/:id* route, and GeM is never called', async () => {
    const tenderRoutes = appRoutes().filter((r) => / \/tenders\/:id/.test(r));
    expect(tenderRoutes.filter((r) => !(r in DEMO_CASES))).toEqual([]);
    gemCalls.length = 0;
    const results: string[] = [];
    for (const [route, call] of Object.entries(DEMO_CASES)) {
      const r = await call()();
      if (r.status !== 404 || /No API route/.test(r.text)) results.push(`${route}: ${r.status} ${r.text.slice(0, 120)}`);
    }
    expect(results).toEqual([]);
    expect(gemCalls).toEqual([]);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(bidWorkspaces).where(eq(bidWorkspaces.orgId, B.me.org.id));
    expect(n).toBe(0);
  });

  it('org B gets 404 for every org-A id and org A’s rows are unchanged', async () => {
    const before = await snapshotOrgA();
    const results: [string, number, string][] = [];
    for (const [route, call] of Object.entries({ ...FOREIGN, ...FOREIGN_EXTRA })) {
      const r = await call()();
      // A 404 from the router ("No API route …") would mean the sweep called a path that does not exist.
      const routed = !/No API route/.test(r.text);
      results.push([route, routed ? r.status : -1, r.status === 404 && routed ? 'not_found' : r.text.slice(0, 120)]);
    }
    expect(results.filter(([, status]) => status !== 404)).toEqual([]);
    expect(await snapshotOrgA()).toBe(before);
  });

  it('routes on public ids only ever touch org B', async () => {
    const before = await snapshotOrgA();
    for (const [route, g] of Object.entries(GLOBAL)) {
      const r = await g.call()();
      expect(r.status, `${route}: ${r.text.slice(0, 200)}`).toBeLessThan(500);
    }
    expect(await snapshotOrgA()).toBe(before);
  });
});
