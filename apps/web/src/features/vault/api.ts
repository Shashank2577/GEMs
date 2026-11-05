import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VaultDocumentDto, VaultSummary, VaultUpdateInput, VaultVersionDto } from '@tp/core/contracts/vault';
import type { DocCategory, DocStatus, DocType } from '@tp/core/vault/status';
import { api, apiFetch, ApiError, type Paged } from '@/lib/api';
import { notificationKeys } from '@/features/notifications/api';

export interface VaultFilters { type?: DocType | null; status?: DocStatus | null; category?: DocCategory | null; q?: string; sort?: 'recent' | 'expiry' | 'title' | 'type' }

export const vaultKeys = {
  all: ['vault'] as const,
  list: (f: VaultFilters) => ['vault', 'list', f] as const,
  summary: ['vault', 'summary'] as const,
};

export function useVault(f: VaultFilters) {
  return useQuery({
    queryKey: vaultKeys.list(f),
    queryFn: () => api.get<Paged<VaultDocumentDto>>('/vault', { type: f.type, status: f.status, category: f.category, q: f.q?.trim() || undefined, sort: f.sort }),
    placeholderData: keepPreviousData,
  });
}

export function useVaultSummary() {
  return useQuery({ queryKey: vaultKeys.summary, queryFn: () => api.get<VaultSummary>('/vault/summary') });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: vaultKeys.all });
    qc.invalidateQueries({ queryKey: ['profile'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
}

export interface UploadFields {
  type: DocType; title: string; number?: string; issuer?: string; issueDate?: string; expiryDate?: string; financialYear?: string; tags?: string[];
  /** Store the file even though the same content is already in the vault (FR-067). */
  allowDuplicate?: boolean;
}

export function useUploadVault() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ file, fields }: { file: File; fields: UploadFields }) => {
      const { allowDuplicate, ...rest } = fields;
      const clean = { ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== '' && v !== undefined)), ...(allowDuplicate ? { allowDuplicate: '1' } : {}) };
      return api.upload<VaultDocumentDto>('/vault', file, clean);
    },
    onSuccess: inv,
  });
}

export function useUpdateVault() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: ({ id, ...body }: VaultUpdateInput & { id: string }) => api.patch<VaultDocumentDto>(`/vault/${id}`, body), onSuccess: inv });
}

/** Renewal fields sent with the replacement file (FR-064). `undefined` = keep; '' = clear. */
export interface ReplaceFields { issueDate?: string; expiryDate?: string; number?: string; allowDuplicate?: boolean }

export function useReplaceVaultFile() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, file, fields = {} }: { id: string; file: File; fields?: ReplaceFields }) => {
      const fd = new FormData();
      fd.append('file', file);
      const { allowDuplicate, ...rest } = fields;
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) fd.append(k, v);
      if (allowDuplicate) fd.append('allowDuplicate', '1');
      return apiFetch<VaultDocumentDto>(`/vault/${id}/file`, { method: 'PUT', body: fd });
    },
    onSuccess: inv,
  });
}

export function useDeleteVault() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete<{ ok: true }>(`/vault/${id}`), onSuccess: inv });
}

/** Previous files of a document, newest first (FR-066). Refreshed with every vault invalidation. */
export function useVaultVersions(id: string | null) {
  return useQuery({ queryKey: ['vault', 'versions', id], queryFn: () => api.get<{ items: VaultVersionDto[] }>(`/vault/${id}/versions`), enabled: !!id });
}

export function useVaultDoc(id: string | null) {
  return useQuery({ queryKey: ['vault', 'doc', id], queryFn: () => api.get<VaultDocumentDto>(`/vault/${id}`), enabled: !!id });
}

/** Manual "Send reminders now" (FR-052, bid_manager+). Refreshes the vault (next-reminder lines) and the bell. */
export function useRunReminders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ documents: number; notifications: number }>('/vault/reminders/run'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: vaultKeys.all });
      qc.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

/** Text of the toast shown when `?doc=<id>` points at a document that no longer exists (FR-040). */
export const DOC_NOT_FOUND_MESSAGE = 'That document could not be found. It may have been deleted.';

/**
 * Should the page drop `?doc=<id>` and toast {@link DOC_NOT_FOUND_MESSAGE}? Only for a 404 on the
 * single-document lookup when the id is not in the loaded list (other errors keep the URL so a retry works).
 */
export function isStaleDocLink(docId: string | null, inList: boolean, error: unknown): boolean {
  return !!docId && !inList && error instanceof ApiError && error.status === 404;
}
