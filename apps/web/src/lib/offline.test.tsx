/** 007/FR-096: offline banner + mutations that fail fast instead of pausing. */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const online = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/hooks', async (orig) => ({ ...(await orig<typeof import('@/lib/hooks')>()), useOnline: () => online.value }));

const { toast } = await import('sonner');
const { ApiError, queryClient } = await import('./api');
const { OfflineBanner } = await import('@/components/layout/AppShell');

afterEach(() => { queryClient.clear(); vi.mocked(toast.error).mockClear(); online.value = true; });

describe('OfflineBanner (FR-096)', () => {
  it('is an empty polite status region while online', () => {
    const html = renderToStaticMarkup(<OfflineBanner />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('You’re offline');
  });
  it('says the data is stale while offline', () => {
    online.value = false;
    const html = renderToStaticMarkup(<OfflineBanner />);
    expect(html).toContain('role="status"');
    expect(html).toContain('You’re offline — showing the last loaded data');
  });
});

describe('mutations while offline (FR-096)', () => {
  it('do not pause: networkMode is "always" so they fail fast', () => {
    expect(queryClient.getDefaultOptions().mutations?.networkMode).toBe('always');
    expect(queryClient.getDefaultOptions().queries?.networkMode).toBeUndefined(); // queries keep the default "online" pause
  });
  it('a network failure ends in an error toast, not a forever-pending mutation', async () => {
    const m = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => { throw new ApiError(0, 'network_error', 'Can’t reach TenderPilot. Check your connection and try again.'); },
    });
    await expect(m.execute(undefined)).rejects.toBeInstanceOf(ApiError);
    expect(m.state.status).toBe('error');
    expect(m.state.isPaused).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
