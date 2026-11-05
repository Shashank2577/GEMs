import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const { toast } = await import('sonner');
const { ApiError, ME_KEY, SESSION_ENDED_MESSAGE, handleSessionEnd, queryClient } = await import('./api');

const ME = { user: { id: 'u1', name: 'Priya', email: 'p@x.in', phone: null }, org: { id: 'o1' }, role: 'owner', orgs: [] };
const flush = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => { queryClient.clear(); vi.mocked(toast.error).mockClear(); });

describe('handleSessionEnd (002/FR-013)', () => {
  it('on a 401 while signed in: clears the cache, marks signed out and toasts once', async () => {
    queryClient.setQueryData(ME_KEY, ME);
    queryClient.setQueryData(['tenders'], { items: [1] });
    const err = new ApiError(401, 'unauthorized', 'Please sign in to continue');
    expect(handleSessionEnd(err)).toBe(true);
    expect(handleSessionEnd(err)).toBe(false); // a burst of 401s → one toast
    await flush();
    expect(queryClient.getQueryData(ME_KEY)).toBeNull();
    expect(queryClient.getQueryData(['tenders'])).toBeUndefined();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(SESSION_ENDED_MESSAGE, expect.anything());
    expect(SESSION_ENDED_MESSAGE).toBe('Your session ended. Please sign in again.');
  });

  it('ignores 401s when signed out, from auth forms, and non-401 errors', async () => {
    const e401 = new ApiError(401, 'invalid_credentials', 'Incorrect email or password');
    expect(handleSessionEnd(e401)).toBe(false); // no ME
    queryClient.setQueryData(ME_KEY, ME);
    expect(handleSessionEnd(e401, { authFlow: true })).toBe(false);
    expect(handleSessionEnd(new ApiError(403, 'forbidden', 'No'))).toBe(false);
    expect(handleSessionEnd(new Error('boom'))).toBe(false);
    await flush();
    expect(queryClient.getQueryData(ME_KEY)).toEqual(ME);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('is wired into the query and mutation caches', async () => {
    queryClient.setQueryData(ME_KEY, ME);
    await queryClient.fetchQuery({ queryKey: ['x'], queryFn: () => Promise.reject(new ApiError(401, 'unauthorized', 'x')) }).catch(() => {});
    await flush();
    expect(queryClient.getQueryData(ME_KEY)).toBeNull();
    queryClient.setQueryData(ME_KEY, ME);
    const m = queryClient.getMutationCache().build(queryClient, { mutationFn: () => Promise.reject(new ApiError(401, 'unauthorized', 'x')) });
    await m.execute(undefined).catch(() => {});
    await flush();
    expect(queryClient.getQueryData(ME_KEY)).toBeNull();
    expect(toast.error).toHaveBeenCalledTimes(2);
  });
});
