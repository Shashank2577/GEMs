import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDto, WorkspaceListResponse } from '@tp/core/contracts/apply';
import { api } from '@/lib/api';

export const pipelineKeys = { list: (f: { mine: boolean; q: string }) => ['workspaces', 'list', f] as const };

export function usePipeline(f: { mine: boolean; q: string }) {
  return useQuery({
    queryKey: pipelineKeys.list(f),
    queryFn: () => api.get<WorkspaceListResponse>('/workspaces', { mine: f.mine ? 1 : undefined, q: f.q.trim() || undefined }),
    placeholderData: keepPreviousData,
  });
}

export function useMoveCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, stage, position }: { id: string; stage?: string; position: number }) =>
      api.patch<WorkspaceDto>(`/workspaces/${id}`, { ...(stage ? { stage } : {}), position }),
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      qc.invalidateQueries({ queryKey: ['workspace', v.id] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
