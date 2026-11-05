/** T039 — saved feed views: CRUD, limits, validation, and (org, user) isolation (FR-035, NFR-004). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAVED_VIEW_LIMIT } from '@tp/core/contracts/identify';
import { eq } from 'drizzle-orm';
import { savedViews } from '@tp/db';
import { createTestContext, request, seedOrgWithRoles, signup, type SignedUp, type TestContext } from './helpers';

let ctx: TestContext;
let team: Awaited<ReturnType<typeof seedOrgWithRoles>>;
let other: SignedUp;

const PARAMS = { state: ['Maharashtra', 'Delhi'], closing: ['7'], sort: ['endAt'] };
const call = (method: string, path: string, who: SignedUp, json?: unknown) => request(ctx.app, method, path, { cookie: who.cookie, json });

beforeAll(async () => {
  ctx = await createTestContext();
  team = await seedOrgWithRoles(ctx.app, 'Views Traders');
  other = await signup(ctx.app, { orgName: 'Rival Views Co' });
});
afterAll(async () => { await ctx?.close(); });

describe('saved views', () => {
  it('requires sign-in', async () => {
    expect((await request(ctx.app, 'GET', '/views')).status).toBe(401);
    expect((await request(ctx.app, 'POST', '/views', { json: { name: 'x', params: {} } })).status).toBe(401);
  });

  it('creates, lists, renames, updates params and deletes (any role, including viewers)', async () => {
    expect((await call('GET', '/views', team.viewer)).body).toMatchObject({ items: [], total: 0, limit: SAVED_VIEW_LIMIT });
    const created = await call('POST', '/views', team.viewer, { name: '  Closing soon, Maharashtra  ', params: PARAMS });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Closing soon, Maharashtra', params: PARAMS, position: 0 });
    const second = await call('POST', '/views', team.viewer, { name: 'Second', params: {} });
    expect(second.body.position).toBe(1);

    const list = await call('GET', '/views', team.viewer);
    expect(list.body.items.map((v: { name: string }) => v.name)).toEqual(['Closing soon, Maharashtra', 'Second']);

    const renamed = await call('PATCH', `/views/${created.body.id}`, team.viewer, { name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Renamed', params: PARAMS });
    const reparam = await call('PATCH', `/views/${created.body.id}`, team.viewer, { params: { matched: ['1'] } });
    expect(reparam.body).toMatchObject({ name: 'Renamed', params: { matched: ['1'] } });

    expect((await call('DELETE', `/views/${created.body.id}`, team.viewer)).body).toEqual({ ok: true });
    expect((await call('DELETE', `/views/${created.body.id}`, team.viewer)).status).toBe(404);
    expect((await call('GET', '/views', team.viewer)).body.total).toBe(1);
    await call('DELETE', `/views/${second.body.id}`, team.viewer);
  });

  it('validates the name (≤ 40, non-empty), params and ids; names are unique per user', async () => {
    expect((await call('POST', '/views', team.analyst, { name: 'a'.repeat(41), params: {} })).status).toBe(400);
    expect((await call('POST', '/views', team.analyst, { name: '   ', params: {} })).status).toBe(400);
    expect((await call('POST', '/views', team.analyst, { name: 'ok' })).status).toBe(400);
    expect((await call('POST', '/views', team.analyst, { name: 'ok', params: { q: 'not-an-array' } })).status).toBe(400);
    // Serialised params are capped at 4096 chars (30 keys x 50 values x 200 chars would otherwise be ~300 kB).
    const big = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, Array.from({ length: 10 }, () => 'x'.repeat(100))]));
    expect(JSON.stringify(big).length).toBeGreaterThan(4096);
    expect((await call('POST', '/views', team.analyst, { name: 'big', params: big })).status).toBe(400);
    const ok = await call('POST', '/views', team.analyst, { name: 'a'.repeat(40), params: {} });
    expect(ok.status).toBe(201);
    const dup = await call('POST', '/views', team.analyst, { name: 'a'.repeat(40), params: {} });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('view_exists');
    const b = await call('POST', '/views', team.analyst, { name: 'b', params: {} });
    expect((await call('PATCH', `/views/${b.body.id}`, team.analyst, { name: 'a'.repeat(40) })).status).toBe(409);
    expect((await call('PATCH', `/views/${b.body.id}`, team.analyst, { name: 'a'.repeat(41) })).status).toBe(400);
    expect((await call('PATCH', '/views/not-a-uuid', team.analyst, { name: 'z' })).status).toBe(404);
    // The same name is fine for a different user.
    expect((await call('POST', '/views', team.bidManager, { name: 'b', params: {} })).status).toBe(201);
  });

  it('caps at 20 views per user with 409 view_limit, and frees a slot on delete', async () => {
    const ids: string[] = [];
    for (let i = 0; i < SAVED_VIEW_LIMIT; i++) {
      const r = await call('POST', '/views', team.owner, { name: `View ${i}`, params: { q: [`v${i}`] } });
      expect(r.status).toBe(201);
      ids.push(r.body.id);
    }
    const over = await call('POST', '/views', team.owner, { name: 'One too many', params: {} });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({ code: 'view_limit', details: { limit: 20 } });
    // The limit is per user, not per org.
    expect((await call('POST', '/views', team.bidManager, { name: 'Mine', params: {} })).status).toBe(201);
    await call('DELETE', `/views/${ids[0]}`, team.owner);
    expect((await call('POST', '/views', team.owner, { name: 'One too many', params: {} })).status).toBe(201);
  });

  it('isolates users in the same org and other orgs: 404, never 403', async () => {
    const mine = await call('POST', '/views', team.viewer, { name: 'Private', params: { q: ['secret'] } });
    expect(mine.status).toBe(201);
    const id = mine.body.id;
    for (const who of [team.owner, team.analyst, other]) {
      expect((await call('GET', '/views', who)).body.items.some((v: { id: string }) => v.id === id)).toBe(false);
      const p = await call('PATCH', `/views/${id}`, who, { name: 'Hijacked' });
      expect(p.status).toBe(404);
      expect(p.body.error.code).toBe('not_found');
      expect((await call('DELETE', `/views/${id}`, who)).status).toBe(404);
    }
    const still = await call('GET', '/views', team.viewer);
    expect(still.body.items.find((v: { id: string }) => v.id === id)).toMatchObject({ name: 'Private', params: { q: ['secret'] } });
  });

  describe('same user in two orgs, and leaving an org', () => {
    /** A user who owns org B and is invited into the Views Traders org as a viewer; the cookie starts in the team org. */
    async function twoOrgUser() {
      const home = await signup(ctx.app, { orgName: 'Second Home Co' });
      const inv = await request(ctx.app, 'POST', '/api/org/invitations', { cookie: team.owner.cookie, json: { email: home.email, role: 'viewer' } });
      const token = inv.body.inviteUrl.split('/invite/')[1];
      const acc = await request(ctx.app, 'POST', '/api/auth/accept-invite', { json: { token, password: home.password } });
      expect(acc.status).toBe(200);
      const inTeam = { ...home, cookie: acc.cookie! } as SignedUp;
      const switchTo = async (orgId: string) => {
        expect((await request(ctx.app, 'POST', '/api/auth/switch-org', { cookie: inTeam.cookie, json: { orgId } })).status).toBe(200);
      };
      return { user: inTeam, teamOrgId: team.owner.me.org.id, homeOrgId: home.me.org.id, switchTo };
    }

    it('views are per (org, user): empty in the other org, PATCH/DELETE of the other org’s id is 404, cap is per org', async () => {
      const { user, teamOrgId, homeOrgId, switchTo } = await twoOrgUser();
      const a = await call('POST', '/views', user, { name: 'Org A view', params: { q: ['a'] } });
      expect(a.status).toBe(201);

      await switchTo(homeOrgId);
      expect((await call('GET', '/views', user)).body).toMatchObject({ items: [], total: 0 });
      const p = await call('PATCH', `/views/${a.body.id}`, user, { name: 'Nope' });
      expect(p.status).toBe(404);
      expect(p.body.error.code).toBe('not_found');
      expect((await call('DELETE', `/views/${a.body.id}`, user)).status).toBe(404);

      // 20 views fit in org B even though org A already holds one; the 21st is refused.
      for (let i = 0; i < SAVED_VIEW_LIMIT; i++) expect((await call('POST', '/views', user, { name: `B ${i}`, params: {} })).status).toBe(201);
      expect((await call('POST', '/views', user, { name: 'B over', params: {} })).status).toBe(409);

      await switchTo(teamOrgId);
      const list = await call('GET', '/views', user);
      expect(list.body.items.map((v: { id: string }) => v.id)).toEqual([a.body.id]);
      expect((await call('POST', '/views', user, { name: 'Org A second', params: {} })).status).toBe(201);
    });

    it('leaving an org or being removed deletes that user’s views for the org only', async () => {
      const { user, teamOrgId, homeOrgId, switchTo } = await twoOrgUser();
      await call('POST', '/views', user, { name: 'Team view', params: {} });
      await switchTo(homeOrgId);
      await call('POST', '/views', user, { name: 'Home view', params: {} });
      await switchTo(teamOrgId);

      const left = await call('DELETE', '/org/members/me', user);
      expect(left.status).toBe(200);
      const rows = await ctx.db.select().from(savedViews).where(eq(savedViews.userId, user.me.user.id));
      expect(rows.map((r) => [r.orgId, r.name])).toEqual([[homeOrgId, 'Home view']]);

      // Owner removing a member also clears that member's views.
      const viewer = await signup(ctx.app, { role: 'viewer', ownerCookie: team.owner.cookie });
      await call('POST', '/views', viewer, { name: 'Doomed', params: {} });
      expect((await call('DELETE', `/org/members/${viewer.me.user.id}`, team.owner)).status).toBe(200);
      expect(await ctx.db.select().from(savedViews).where(eq(savedViews.userId, viewer.me.user.id))).toEqual([]);
    });
  });
});
