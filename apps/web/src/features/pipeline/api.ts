import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OutcomeInput, WorkspaceDto, WorkspaceListResponse } from '@tp/core/contracts/apply';
import type { BidResultHint } from '@tp/core/gem/award';
import { api } from '@/lib/api';

export const pipelineKeys = { list: (f: { mine: boolean; q: string }) => ['workspaces', 'list', f] as const };

export function usePipeline(f: { mine: boolean; q: string }) {
  return useQuery({
    queryKey: pipelineKeys.list(f),
    queryFn: () => api.get<WorkspaceListResponse>('/workspaces', { mine: f.mine ? 1 : undefined, q: f.q.trim() || undefined }),
    placeholderData: keepPreviousData,
  });
}

/** PATCH body of a card move: only the fields that were given (a plain stage move carries no `position`). */
export const moveBody = ({ stage, position }: { stage?: string; position?: number }) => ({
  ...(stage ? { stage } : {}), ...(position !== undefined ? { position } : {}),
});

export function useMoveCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, stage, position }: { id: string; stage?: string; position?: number }) =>
      api.patch<WorkspaceDto>(`/workspaces/${id}`, moveBody({ stage, position })),
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      qc.invalidateQueries({ queryKey: ['workspace', v.id] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** "Record the result" (007/FR-030): PATCH { outcome } after a move to Won/Lost. */
export function useRecordOutcome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: OutcomeInput }) => api.patch<WorkspaceDto>(`/workspaces/${id}`, { outcome }),
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      qc.invalidateQueries({ queryKey: ['workspace', v.id] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** Optional L1 suggestion read from GeM’s public result page (007/T033). Never blocks the dialog: errors (incl. 429 rate_limited) just mean no hint link; no toast. */
export function useResultHint(tenderId: string | null) {
  return useQuery({
    queryKey: ['tenders', tenderId, 'result-hint'],
    queryFn: () => api.get<BidResultHint>(`/tenders/${tenderId}/result-hint`),
    enabled: !!tenderId,
    staleTime: 10 * 60_000,
    retry: false,
  });
}
