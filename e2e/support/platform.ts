/**
 * Spec 002 E2E helpers (T015, SC-006).
 *
 * `createOrgWithRoles(request)` signs up a fresh owner (new org) through the API and then invites and accepts one
 * member per other role, so a test can open the same org in four browser contexts.
 *
 *   const org = await createOrgWithRoles(playwright.request);
 *   const ctx = await browser.newContext({ storageState: org.members.analyst.storageState });
 *   ...
 *   await org.dispose();
 *
 * Must be called from a test or hook (it reads the project's `baseURL` via `test.info()`, which throws elsewhere), or
 * pass `opts.baseURL` explicitly to use it outside one.
 *
 * `request` is Playwright's `APIRequest` factory (the `playwright.request` fixture, or `request` imported from
 * `@playwright/test`, the default); its contexts are created here with the project's `baseURL`, so the cookies of each user stay
 * separate and the caller's own context is never touched.
 */
import { request as playwrightRequest, test as base, type APIRequestContext } from '@playwright/test';
import { uniqueUser } from './fixtures';

export type OrgRole = 'owner' | 'bid_manager' | 'analyst' | 'viewer';
export type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

export interface OrgMember {
  role: OrgRole;
  name: string;
  email: string;
  password: string;
  userId: string;
  /** Cookies of a logged-in session: `browser.newContext({ storageState })`. */
  storageState: StorageState;
  /** Logged-in API context for this member (closed by `dispose()`). */
  api: APIRequestContext;
}

export interface OrgWithRoles {
  orgId: string;
  orgName: string;
  owner: OrgMember;
  members: Record<OrgRole, OrgMember>;
  /** Closes every API context created by the helper. */
  dispose(): Promise<void>;
}

type RequestFactory = Pick<typeof playwrightRequest, 'newContext'>;

async function ok<T>(res: { status(): number; text(): Promise<string>; json(): Promise<T> }, want: number, what: string): Promise<T> {
  if (res.status() !== want) throw new Error(`${what}: expected ${want}, got ${res.status()}: ${await res.text()}`);
  return res.json();
}

/** Owner signup + invite/accept for bid_manager, analyst and viewer, all through the API. */
export async function createOrgWithRoles(request: RequestFactory = playwrightRequest, opts: { baseURL?: string } = {}): Promise<OrgWithRoles> {
  const baseURL = opts.baseURL ?? base.info().project.use.baseURL;
  const contexts: APIRequestContext[] = [];
  const open = async () => { const c = await request.newContext({ baseURL }); contexts.push(c); return c; };

  const ownerUser = uniqueUser('owner');
  const ownerApi = await open();
  const me = await ok<{ user: { id: string }; org: { id: string } }>(await ownerApi.post('/api/auth/signup', { data: ownerUser }), 201, 'owner signup');
  const owner: OrgMember = {
    role: 'owner', name: ownerUser.name, email: ownerUser.email, password: ownerUser.password, userId: me.user.id,
    storageState: await ownerApi.storageState(), api: ownerApi,
  };

  const members = { owner } as Record<OrgRole, OrgMember>;
  try {
    for (const role of ['bid_manager', 'analyst', 'viewer'] as const) {
      const u = uniqueUser(role.replace('_', ''));
      const inv = await ok<{ inviteUrl: string }>(await ownerApi.post('/api/org/invitations', { data: { email: u.email, role } }), 201, `invite ${role}`);
      const token = inv.inviteUrl.split('/invite/')[1];
      if (!token) throw new Error(`invite ${role}: no token in ${inv.inviteUrl}`);
      const api = await open();
      const accepted = await ok<{ user: { id: string }; role: OrgRole }>(
        await api.post('/api/auth/accept-invite', { data: { token, name: u.name, password: u.password } }), 200, `accept ${role}`);
      if (accepted.role !== role) throw new Error(`accept ${role}: joined as ${accepted.role}`);
      members[role] = { role, name: u.name, email: u.email, password: u.password, userId: accepted.user.id, storageState: await api.storageState(), api };
    }
  } catch (e) {
    await Promise.all(contexts.map((c) => c.dispose().catch(() => undefined)));
    throw e;
  }

  return {
    orgId: me.org.id, orgName: ownerUser.orgName, owner, members,
    dispose: async () => { await Promise.all(contexts.map((c) => c.dispose().catch(() => undefined))); },
  };
}
