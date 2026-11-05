import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const { ApiError, ME_KEY, ME_RECHECK_MS, apiFetch, queryClient } = await import('./api');

const expiredOrg = { id: 'o1', plan: 'trial', trialEndsAt: '2020-01-01T00:00:00.000Z' };
const ME = { user: { id: 'u1', name: 'Asha', email: 'a@x.in', phone: null }, org: expiredOrg, role: 'owner', orgs: [] };
const UPGRADED = { ...ME, org: { ...expiredOrg, plan: 'starter', trialEndsAt: null } };
const flush = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => { queryClient.clear(); vi.unstubAllGlobals(); });

describe('local expired-trial block re-checks /auth/me (008/FR-041, review S4)', () => {
  it('a blocked write refetches a stale /auth/me, so the next write after an upgrade reaches the server', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'w1' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    let meCalls = 0;
    queryClient.setQueryData(ME_KEY, ME, { updatedAt: Date.now() - ME_RECHECK_MS - 1000 });
    const observer = new QueryObserver(queryClient, { queryKey: ME_KEY, queryFn: () => { meCalls++; return UPGRADED; }, staleTime: 5 * 60_000 });
    const unsubscribe = observer.subscribe(() => {});

    await expect(apiFetch('/watchlists', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 402, code: 'plan_expired' });
    expect(fetchMock).not.toHaveBeenCalled();
    await flush();
    expect(meCalls).toBe(1);

    await expect(apiFetch('/watchlists', { method: 'POST', body: {} })).resolves.toEqual({ id: 'w1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('a freshly fetched /auth/me is not refetched on every blocked click', async () => {
    let meCalls = 0;
    queryClient.setQueryData(ME_KEY, ME);
    const observer = new QueryObserver(queryClient, { queryKey: ME_KEY, queryFn: () => { meCalls++; return ME; }, staleTime: 5 * 60_000 });
    const unsubscribe = observer.subscribe(() => {});
    await expect(apiFetch('/watchlists', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError);
    await flush();
    expect(meCalls).toBe(0);
    unsubscribe();
  });
});
