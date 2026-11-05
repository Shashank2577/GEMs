import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TenderListItem, WatchlistCreateInput, WatchlistCriteriaInput, WatchlistDto, WatchlistUpdateInput } from '@tp/core/contracts/identify';
import { api, ApiError, formatRetryAfter } from '@/lib/api';

export const watchlistKeys = {
  all: ['watchlists'] as const,
  preview: (c: WatchlistCriteriaInput) => ['watchlists', 'preview', c] as const,
};

export function useWatchlists() {
  return useQuery({ queryKey: watchlistKeys.all, queryFn: () => api.get<{ items: WatchlistDto[]; total: number }>('/watchlists') });
}

export type PreviewItem = TenderListItem & { previewReasons: string[] };

/** Retry a rate-limited preview (up to 3 times, each after its Retry-After); other errors are not retried. */
export function previewRetry(failureCount: number, err: unknown): boolean {
  return err instanceof ApiError && err.isRateLimited && failureCount < 3;
}
export function previewRetryDelay(_failureCount: number, err: unknown): number {
  return ((err instanceof ApiError ? err.retryAfter : null) ?? 5) * 1000;
}

/** "Preview paused — try again in N s" for a 429 `watchlist.preview.user` (008/US3 scenario 6); null otherwise. */
export function previewPausedMessage(err: unknown): string | null {
  if (!(err instanceof ApiError) || !err.isRateLimited) return null;
  return `Preview paused — try again in ${formatRetryAfter(err.retryAfter ?? 60)}`;
}

export function useWatchlistPreview(criteria: WatchlistCriteriaInput, enabled: boolean) {
  return useQuery({
    queryKey: watchlistKeys.preview(criteria),
    queryFn: () => api.post<{ count: number; sample: PreviewItem[] }>('/watchlists/preview', { criteria }),
    enabled,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
    // A paused preview (429) fetches again by itself once the wait is over.
    retry: previewRetry,
    retryDelay: previewRetryDelay,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: watchlistKeys.all });
    qc.invalidateQueries({ queryKey: ['tenders'] });
  };
}

export function useCreateWatchlist() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (body: WatchlistCreateInput) => api.post<WatchlistDto>('/watchlists', body), onSuccess: inv });
}

export function useUpdateWatchlist() {
  const inv = useInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: WatchlistUpdateInput & { id: string }) => api.patch<WatchlistDto>(`/watchlists/${id}`, body),
    // Optimistic pause/resume toggle.
    onMutate: async (vars) => {
      if (vars.active === undefined || vars.criteria || vars.name) return;
      await qc.cancelQueries({ queryKey: watchlistKeys.all });
      const prev = qc.getQueryData<{ items: WatchlistDto[]; total: number }>(watchlistKeys.all);
      if (prev) qc.setQueryData(watchlistKeys.all, { ...prev, items: prev.items.map((w) => (w.id === vars.id ? { ...w, active: !!vars.active } : w)) });
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(watchlistKeys.all, ctx.prev); },
    onSettled: inv,
  });
}

export function useDeleteWatchlist() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/watchlists/${id}`), onSuccess: inv });
}
