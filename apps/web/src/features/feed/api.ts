import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IngestionRunDto, IngestionRunsResponse, TenderListResponse } from '@tp/core/contracts/identify';
import { api } from '@/lib/api';
import { toast } from '@/components/ui';
import { pluralize } from '@/lib/format';
import { toApiQuery, type FeedFilters } from './filters';

export const feedKeys = {
  all: ['tenders'] as const,
  list: (f: FeedFilters, pageSize: number) => ['tenders', 'list', f, pageSize] as const,
  runs: ['ingestion', 'runs'] as const,
};

export const PAGE_SIZE = 20;

/** Infinite feed (load-more / auto-load on scroll). */
export function useTenderFeed(filters: FeedFilters) {
  return useInfiniteQuery({
    queryKey: feedKeys.list(filters, PAGE_SIZE),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api.get<TenderListResponse>('/tenders', { ...toApiQuery(filters), page: pageParam, pageSize: PAGE_SIZE }),
    getNextPageParam: (last, pages) => (pages.length * PAGE_SIZE < last.total ? pages.length + 1 : undefined),
    placeholderData: keepPreviousData,
  });
}

export function useIngestionRuns() {
  return useQuery({
    queryKey: feedKeys.runs,
    queryFn: () => api.get<IngestionRunsResponse>('/ingestion/runs'),
    refetchInterval: 60_000,
  });
}

export function useSyncNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<IngestionRunDto>('/ingestion/run', {}),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: feedKeys.all });
      qc.invalidateQueries({ queryKey: feedKeys.runs });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['watchlists'] });
      if (run.status === 'failed') {
        toast.error('GeM didn’t respond', { description: run.error ?? 'We’ll retry automatically on the next scheduled sync.' });
      } else if (run.tendersCreated || run.matchesCreated) {
        toast.success(`${pluralize(run.tendersCreated, 'new tender')} · ${pluralize(run.matchesCreated, 'new match', 'new matches')}`, {
          description: run.tendersUpdated ? `${pluralize(run.tendersUpdated, 'tender')} updated (corrigenda / changes recorded).` : 'Synced with GeM BidPlus.',
        });
      } else {
        toast.success('You’re up to date', { description: `Checked ${pluralize(run.tendersSeen, 'bid')} on GeM — nothing new since the last sync.` });
      }
    },
    onError: (e: unknown) => {
      const err = e as { status?: number; message?: string };
      if (err.status === 409) toast.info('A sync is already running', { description: 'New tenders will appear in a moment.' });
      else toast.error(err.message ?? 'Sync failed');
    },
  });
}

export function useMarkSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/tenders/${id}/seen`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useDismiss() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, undo }: { id: string; undo?: boolean }) => api.post<{ ok: true; dismissed: boolean }>(`/tenders/${id}/dismiss`, { undo: !!undo }),
    onSuccess: () => qc.invalidateQueries({ queryKey: feedKeys.all }),
  });
}
