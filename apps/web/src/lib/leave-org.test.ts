import { afterEach, describe, expect, it, vi } from 'vitest';
import { ME_KEY, queryClient } from './api';
import { leaveOrganization, type Me } from './auth';

const ME = { user: { id: 'u1', name: 'Asha', email: 'a@x.in', phone: null }, org: { id: 'o1', name: 'Alpha Supplies' }, role: 'analyst', orgs: [] } as unknown as Me;
const NEXT = { ...ME, org: { id: 'o2', name: 'Home Co' } } as unknown as Me;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Route fetch by "METHOD path". */
function stubFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(url).replace(/^\/api/, '')}`;
    calls.push(key);
    const r = routes[key];
    if (!r) throw new Error(`unexpected ${key}`);
    return r();
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); queryClient.clear(); });

describe('leaveOrganization (002/FR-027)', () => {
  it('with a next org: loads the new Me and resolves with the left org name', async () => {
    stubFetch({ 'DELETE /org/members/me': () => json(200, { ok: true, nextOrgId: 'o2' }), 'GET /auth/me': () => json(200, NEXT) });
    const setMe = vi.fn();
    await expect(leaveOrganization(ME, setMe)).resolves.toEqual({ orgName: 'Alpha Supplies', nextOrgId: 'o2' });
    expect(setMe).toHaveBeenCalledWith(NEXT);
  });

  it('with no org left: signs out', async () => {
    const calls = stubFetch({ 'DELETE /org/members/me': () => json(200, { ok: true, nextOrgId: null }), 'POST /auth/logout': () => json(200, { ok: true }) });
    const setMe = vi.fn();
    await expect(leaveOrganization(ME, setMe)).resolves.toEqual({ orgName: 'Alpha Supplies', nextOrgId: null });
    expect(calls).toContain('POST /auth/logout');
    expect(setMe).toHaveBeenCalledWith(null);
  });

  it('does not reject when the DELETE succeeded but /auth/me fails: drops org data and refetches ME_KEY', async () => {
    stubFetch({ 'DELETE /org/members/me': () => json(200, { ok: true, nextOrgId: 'o2' }), 'GET /auth/me': () => json(500, { error: { code: 'internal_error', message: 'x' } }) });
    queryClient.setQueryData(ME_KEY, ME);
    queryClient.setQueryData(['tenders'], { items: [1] });
    const setMe = vi.fn();
    await expect(leaveOrganization(ME, setMe)).resolves.toEqual({ orgName: 'Alpha Supplies', nextOrgId: 'o2' });
    expect(setMe).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['tenders'])).toBeUndefined();
    expect(queryClient.getQueryState(ME_KEY)?.isInvalidated).toBe(true);
  });

  it('rejects (nothing changed) when the DELETE itself fails, e.g. 409 last_owner', async () => {
    stubFetch({ 'DELETE /org/members/me': () => json(409, { error: { code: 'last_owner', message: 'You are the last Owner' } }) });
    const setMe = vi.fn();
    await expect(leaveOrganization(ME, setMe)).rejects.toMatchObject({ status: 409, code: 'last_owner' });
    expect(setMe).not.toHaveBeenCalled();
  });
});
