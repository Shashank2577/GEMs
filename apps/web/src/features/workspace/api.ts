/** Data hooks for the bid workspace (Apply: /workspaces, /annexure-templates, /packets, /assist). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnnexureTemplateDto, AssistPayload, CommentDto, OutcomeInput, PacketDto, PacketItemInput, Readiness, WorkspaceDetail, WorkspaceDto,
  WorkspaceUpdateInput,
} from '@tp/core/contracts/apply';
import { api, apiFetch, ApiError } from '@/lib/api';

export const wsKeys = {
  detail: (id: string) => ['workspace', id] as const,
  assist: (id: string) => ['workspace', id, 'assist'] as const,
  templates: ['annexure-templates'] as const,
};

export type AssistResponse = AssistPayload & { stage: string; workspaceUrl: string; readiness: { percent: number; blockers: number; analysed: boolean } };

export function useWorkspace(id: string) {
  return useQuery({ queryKey: wsKeys.detail(id), queryFn: () => api.get<WorkspaceDetail>(`/workspaces/${id}`) });
}

export function useAssist(id: string, enabled = true) {
  return useQuery({ queryKey: wsKeys.assist(id), enabled, queryFn: () => api.get<AssistResponse>(`/assist/${id}`) });
}

export function useTemplates(enabled = true) {
  return useQuery({ queryKey: wsKeys.templates, enabled, queryFn: () => api.get<{ items: AnnexureTemplateDto[] }>('/annexure-templates') });
}

/** Invalidate everything that shows workspace data. */
function useRefresh(id: string) {
  const qc = useQueryClient();
  return (also: 'assist' | null = null) => {
    qc.invalidateQueries({ queryKey: wsKeys.detail(id) });
    qc.invalidateQueries({ queryKey: ['workspaces'] });
    qc.invalidateQueries({ queryKey: ['tender'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    if (also === 'assist') qc.invalidateQueries({ queryKey: wsKeys.assist(id) });
  };
}

/** Patch the cached detail optimistically-ish with the server's workspace + readiness. */
function usePatchCache(id: string) {
  const qc = useQueryClient();
  return (patch: { workspace?: WorkspaceDto; readiness?: Readiness }) =>
    qc.setQueryData<WorkspaceDetail>(wsKeys.detail(id), (d) => (d ? { ...d, ...patch } : d));
}

export function useUpdateWorkspace(id: string) {
  const refresh = useRefresh(id);
  const patch = usePatchCache(id);
  return useMutation({
    mutationFn: (body: WorkspaceUpdateInput) => api.patch<WorkspaceDto>(`/workspaces/${id}`, body),
    onSuccess: (w) => { patch({ workspace: w }); refresh(); },
  });
}

export function useSetMapping(id: string) {
  const refresh = useRefresh(id);
  const patch = usePatchCache(id);
  return useMutation({
    mutationFn: (body: Record<string, string | null>) => api.put<{ workspace: WorkspaceDto; readiness: Readiness }>(`/workspaces/${id}/mapping`, body),
    onSuccess: (r) => { patch(r); refresh('assist'); },
  });
}

export function useOverride(id: string) {
  const refresh = useRefresh(id);
  const patch = usePatchCache(id);
  return useMutation({
    mutationFn: (body: { itemId: string; reason: string }) => api.post<{ workspace: WorkspaceDto; readiness: Readiness }>(`/workspaces/${id}/overrides`, body),
    onSuccess: (r) => { patch(r); refresh(); },
  });
}

export function useRemoveOverride(id: string) {
  const refresh = useRefresh(id);
  const patch = usePatchCache(id);
  return useMutation({
    mutationFn: (itemId: string) => api.delete<{ workspace: WorkspaceDto; readiness: Readiness }>(`/workspaces/${id}/overrides/${encodeURIComponent(itemId)}`),
    onSuccess: (r) => { patch(r); refresh(); },
  });
}

export function useComment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.post<CommentDto>(`/workspaces/${id}/comments`, { body }),
    onSuccess: (c) => {
      qc.setQueryData<WorkspaceDetail>(wsKeys.detail(id), (d) => (d ? { ...d, comments: [...d.comments, c] } : d));
      qc.invalidateQueries({ queryKey: wsKeys.detail(id) });
    },
  });
}

export function useDeleteComment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => api.delete<void>(`/workspaces/${id}/comments/${commentId}`),
    onSuccess: (_r, commentId) => {
      qc.setQueryData<WorkspaceDetail>(wsKeys.detail(id), (d) => (d ? { ...d, comments: d.comments.filter((c) => c.id !== commentId) } : d));
      qc.invalidateQueries({ queryKey: wsKeys.detail(id) });
    },
  });
}

export function useBuildPacket(id: string) {
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (items: PacketItemInput[]) => api.post<PacketDto>(`/workspaces/${id}/packets`, { items }),
    onSuccess: () => refresh('assist'),
  });
}

export function useSaveAssist(id: string) {
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (values: Record<string, string>) => api.put<{ assistValues: Record<string, string> }>(`/workspaces/${id}/assist-values`, values),
    onSuccess: () => refresh('assist'),
  });
}

export function useMarkSubmitted(id: string) {
  const refresh = useRefresh(id);
  const patch = usePatchCache(id);
  return useMutation({
    mutationFn: (note?: string) => api.post<WorkspaceDto>(`/workspaces/${id}/submitted`, note ? { note } : {}),
    onSuccess: (w) => { patch({ workspace: w }); refresh(); },
  });
}

export function useRecordOutcome(id: string) {
  const update = useUpdateWorkspace(id);
  return { ...update, mutateAsync: (o: OutcomeInput) => update.mutateAsync({ outcome: o }) };
}

export function useSaveTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, title, body }: { key: string; title: string; body: string }) => api.put<AnnexureTemplateDto>(`/annexure-templates/${key}`, { title, body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: wsKeys.templates }); qc.invalidateQueries({ queryKey: ['workspace'] }); },
  });
}

export function useResetTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.delete<AnnexureTemplateDto>(`/annexure-templates/${key}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: wsKeys.templates }); qc.invalidateQueries({ queryKey: ['workspace'] }); },
  });
}

/** Render a draft template to a PDF blob URL (template editor preview). */
export async function previewAnnexure(wsId: string, key: string, title: string, body: string): Promise<string> {
  const res = await fetch(`/api/workspaces/${wsId}/annexures/${key}/preview`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body }),
  });
  if (!res.ok) {
    let msg = 'Preview failed';
    let code = 'preview_failed';
    let details: unknown;
    try {
      const err = (await res.json()).error;
      msg = err?.message ?? msg;
      code = err?.code ?? code;
      details = err?.details;
    } catch { /* ignore */ }
    throw new ApiError(res.status, code, msg, details);
  }
  return URL.createObjectURL(await res.blob());
}

export { apiFetch };
