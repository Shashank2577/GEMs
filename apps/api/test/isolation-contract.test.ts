/**
 * 008/US3 scenario 4 — contract-driven cross-org isolation sweep (008/FR-016, extends 002 T052, NFR-005).
 *
 * Every route of `specs/001-gem-tender-copilot/contracts/api.md` is parsed from the contract. Each route with a path
 * parameter must be listed below:
 * - `foreign`: org B's owner calls it with org A's ids → exactly 404 `not_found` (never 200/403);
 * - `global`: the parameter names public data (a GeM tender, a template key), so the call is allowed but may only touch
 *   org B's own rows.
 * After all calls, every row of org A (every table with an `org_id` column) is byte-for-byte unchanged.
 * A new parameterised route in the contract fails this test until it is covered here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifications, tenderMatches } from '@tp/db';
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

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW, fetch: async () => new Response('not found', { status: 404 }) });
  A = await seedApply(ctx);
  const a = A.org;
  const ok = (r: TestResponse, what: string) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };

  ids.tender = A.tender.id;
  ids.analysis = A.analysis.id;
  ids.vault = A.docs.gst.id;
  ids.workspace = ok(await request(ctx.app, 'POST', `/tenders/${ids.tender}/workspace`, { cookie: a.analyst.cookie }), 'workspace').id;
  ok(await request(ctx.app, 'POST', `/workspaces/${ids.workspace}/comments`, { cookie: a.analyst.cookie, json: { body: 'Org A only' } }), 'comment');
  ok(await request(ctx.app, 'POST', `/workspaces/${ids.workspace}/overrides`, { cookie: a.bidManager.cookie, json: { itemId: 'oem_authorization', reason: 'Renewed MAF arriving tomorrow' } }), 'override');
  ids.packet = ok(await request(ctx.app, 'POST', `/workspaces/${ids.workspace}/packets`, { cookie: a.analyst.cookie, json: {} }), 'packet').id;
  ids.watchlist = ok(await request(ctx.app, 'POST', '/watchlists', { cookie: a.analyst.cookie, json: { name: 'A laptops', criteria: { keywords: ['laptop'] } } }), 'watchlist').id;
  ids.pastContract = ok(await request(ctx.app, 'POST', '/past-contracts', {
    cookie: a.analyst.cookie, json: { buyer: 'NIC, MeitY', title: 'Supply of 200 laptops', value: 12_000_000, startDate: '2024-04-01', endDate: '2024-09-30' },
  }), 'past contract').id;
  ids.tenderDoc = ok(await request(ctx.app, 'POST', `/tenders/${ids.tender}/documents`, { cookie: a.analyst.cookie, form: { file: file(await pdf('A bid doc'), 'a-bid.pdf') } }), 'tender doc').id;
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
  'GET /workspaces/:id/annexures/:key.pdf': () => asB('GET', `/workspaces/${ids.workspace}/annexures/non_blacklisting.pdf`),
  'POST /workspaces/:id/packets': () => asB('POST', `/workspaces/${ids.workspace}/packets`, {}),
  'GET /packets/:id/download': () => asB('GET', `/packets/${ids.packet}/download`),
  'GET /assist/:workspaceId': () => asB('GET', `/assist/${ids.workspace}`),
  'PUT /workspaces/:id/assist-values': () => asB('PUT', `/workspaces/${ids.workspace}/assist-values`, { make: 'Hijack' }),
  'POST /workspaces/:id/submitted': () => asB('POST', `/workspaces/${ids.workspace}/submitted`, { note: 'Hijack' }),
};

/** Implemented routes not (yet) in the contract, swept the same way. */
const FOREIGN_EXTRA: Record<string, () => Call> = {
  'GET /vault/:id': () => asB('GET', `/vault/${ids.vault}`),
  'PUT /vault/:id/file': () => asBForm('PUT', `/vault/${ids.vault}/file`),
  'DELETE /org/invitations/:id': () => asB('DELETE', `/org/invitations/${ids.invitation}`),
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
  'PUT /annexure-templates/:key': {
    why: 'key is a template name; writes B’s own override',
    call: () => asB('PUT', '/annexure-templates/non_blacklisting', { title: 'B undertaking', body: 'We, {{legalName}}, are not blacklisted.' }),
  },
};

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
    expect(uncovered, 'add these routes to test/isolation.test.ts').toEqual([]);
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

  it('the ids are real: org A itself can read its resources', async () => {
    const a = A.org.owner.cookie;
    for (const path of [`/workspaces/${ids.workspace}`, `/vault/${ids.vault}`, `/packets/${ids.packet}/download`, `/tenders/${ids.tender}/analysis`,
      `/tenders/${ids.tender}/documents/${ids.tenderDoc}/download`, `/assist/${ids.workspace}`]) {
      expect((await request(ctx.app, 'GET', path, { cookie: a })).status, path).toBe(200);
    }
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
