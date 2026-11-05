import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TenderListItem, WatchlistCreateInput, WatchlistCriteriaInput, WatchlistDto, WatchlistUpdateInput } from '@tp/core/contracts/identify';
import { api } from '@/lib/api';

export const watchlistKeys = {
  all: ['watchlists'] as const,
  preview: (c: WatchlistCriteriaInput) => ['watchlists', 'preview', c] as const,
};

export function useWatchlists() {
  return useQuery({ queryKey: watchlistKeys.all, queryFn: () => api.get<{ items: WatchlistDto[]; total: number }>('/watchlists') });
}

export type PreviewItem = TenderListItem & { previewReasons: string[] };

export function useWatchlistPreview(criteria: WatchlistCriteriaInput, enabled: boolean) {
  return useQuery({
    queryKey: watchlistKeys.preview(criteria),
    queryFn: () => api.post<{ count: number; sample: PreviewItem[] }>('/watchlists/preview', { criteria }),
    enabled,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
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
