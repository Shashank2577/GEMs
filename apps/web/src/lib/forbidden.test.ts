import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const { toast } = await import('sonner');
const { ApiError, ME_KEY, handleForbidden, queryClient } = await import('./api');

const ME = { user: { id: 'u1', name: 'Asha', email: 'a@x.in', phone: null }, org: { id: 'o1' }, role: 'analyst', orgs: [] };
const MSG = 'You need to be at least an Analyst to do that';
const flush = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => { queryClient.clear(); vi.mocked(toast.error).mockClear(); });

describe('handleForbidden (002/FR-029)', () => {
  it('toasts the server message and refetches /auth/me so role-gated UI updates', async () => {
    let calls = 0;
    const fresh = { ...ME, role: 'viewer' };
    queryClient.setQueryData(ME_KEY, ME);
    // An active observer of ME_KEY (as AuthProvider has) makes the invalidation refetch.
    const { QueryObserver } = await import('@tanstack/react-query');
    const observer = new QueryObserver(queryClient, { queryKey: ME_KEY, queryFn: () => { calls++; return fresh; }, staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => {});

    expect(handleForbidden(new ApiError(403, 'forbidden', MSG))).toBe(true);
    await flush();
    expect(toast.error).toHaveBeenCalledWith(MSG, { id: `error:${MSG}` });
    expect(calls).toBe(1);
    expect(queryClient.getQueryData(ME_KEY)).toEqual(fresh);
    unsubscribe();
  });

  it('ignores other errors, other 403 codes and signed-out state', () => {
    expect(handleForbidden(new ApiError(403, 'forbidden', MSG))).toBe(false); // signed out
    queryClient.setQueryData(ME_KEY, ME);
    expect(handleForbidden(new ApiError(403, 'bad_origin', 'x'))).toBe(false);
    expect(handleForbidden(new ApiError(403, 'no_organization', 'x'))).toBe(false);
    expect(handleForbidden(new ApiError(404, 'not_found', 'x'))).toBe(false);
    expect(handleForbidden(new Error('boom'))).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(ME_KEY)?.isInvalidated).toBe(false);
  });

  it('is wired into the mutation cache (not the query cache)', async () => {
    queryClient.setQueryData(ME_KEY, ME);
    const m = queryClient.getMutationCache().build(queryClient, { mutationFn: () => Promise.reject(new ApiError(403, 'forbidden', MSG)) });
    await m.execute(undefined).catch(() => {});
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(ME_KEY)?.isInvalidated).toBe(true);

    queryClient.setQueryData(ME_KEY, ME);
    await queryClient.fetchQuery({ queryKey: ['x'], queryFn: () => Promise.reject(new ApiError(403, 'forbidden', MSG)) }).catch(() => {});
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
