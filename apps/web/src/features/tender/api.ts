/** Data hooks for the tender detail page (Identify: GET /tenders/:id; Analyse: documents, analysis, override). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TenderDetail } from '@tp/core/contracts/identify';
import type { AnalysisCapabilities, AnalysisDto, FactorStatus, TenderDocKind, TenderDocumentDto, UploadTenderDocumentResponse } from '@tp/core/contracts/analyse';
import type { ActivityItem } from '@tp/core/contracts/auth';
import { api, ApiError } from '@/lib/api';
import { ANALYSIS_POLL_MS, isAnalysisRunning } from './labels';

export const tenderKeys = {
  detail: (id: string) => ['tender', id] as const,
  analysis: (id: string) => ['tender', id, 'analysis'] as const,
  documents: (id: string) => ['tender', id, 'documents'] as const,
  activity: (id: string) => ['tender', id, 'activity'] as const,
};

/** GET /analysis/capabilities: is AI (and OCR) configured? Drives the "Analysing…" copy and OCR actions (004/FR-053). */
export function useAnalysisCapabilities() {
  return useQuery({ queryKey: ['analysis', 'capabilities'] as const, queryFn: () => api.get<AnalysisCapabilities>('/analysis/capabilities'), staleTime: 5 * 60_000 });
}

export function useTender(id: string) {
  return useQuery({ queryKey: tenderKeys.detail(id), queryFn: () => api.get<TenderDetail>(`/tenders/${id}`) });
}

/**
 * Latest done analysis for this org (+ `lastAttempt`); `null` when none exists yet (404).
 * Polls every 3 s while another member's analysis is running (FR-029).
 */
export function useAnalysis(id: string) {
  return useQuery({
    queryKey: tenderKeys.analysis(id),
    refetchInterval: (q) => (isAnalysisRunning(q.state.data) ? ANALYSIS_POLL_MS : false),
    queryFn: async () => {
      try {
        return await api.get<AnalysisDto>(`/tenders/${id}/analysis`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  });
}

export function useTenderDocuments(id: string) {
  return useQuery({ queryKey: tenderKeys.documents(id), queryFn: () => api.get<{ items: TenderDocumentDto[]; total: number }>(`/tenders/${id}/documents`) });
}

export function useTenderActivity(id: string, enabled: boolean) {
  return useQuery({
    queryKey: tenderKeys.activity(id),
    enabled,
    queryFn: () => api.get<{ items: ActivityItem[] }>('/activity', { entityType: 'tender', entityId: id, pageSize: 50 }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimum time the "analysing" animation is shown so the steps can be read. */
export const ANALYSE_MIN_MS = 2400;

export function useAnalyse(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const [a] = await Promise.all([api.post<AnalysisDto>(`/tenders/${id}/analyse`), sleep(ANALYSE_MIN_MS)]);
      return a;
    },
    onSuccess: (a) => {
      qc.setQueryData(tenderKeys.analysis(id), a);
      qc.invalidateQueries({ queryKey: tenderKeys.detail(id) });
      qc.invalidateQueries({ queryKey: tenderKeys.documents(id) });
      qc.invalidateQueries({ queryKey: tenderKeys.activity(id) });
      qc.invalidateQueries({ queryKey: ['tenders'] });
    },
    // 409 analysis_running → the refetch shows "Analysis in progress…" and polls; 500 → the failed-attempt warning.
    onError: () => { qc.invalidateQueries({ queryKey: tenderKeys.analysis(id) }); },
  });
}

/** POST …/analyse answered 409: another analysis for this tender is running (FR-028). */
export const isAnalysisRunningError = (e: unknown) => e instanceof ApiError && e.code === 'analysis_running';

export function useUploadDocument(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, kind }: { file: File; kind: TenderDocKind }) => api.upload<UploadTenderDocumentResponse>(`/tenders/${id}/documents`, file, { kind }),
    // A new document marks the analysis stale (FR-044), so refresh it as well.
    onSuccess: () => invalidateDocumentChange(qc, id),
  });
}

/** DELETE /tenders/:id/documents/:docId — remove one of the org's own uploads (FR-009). */
export function useRemoveDocument(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => api.delete<void>(`/tenders/${id}/documents/${docId}`),
    onSuccess: () => invalidateDocumentChange(qc, id),
  });
}

/** POST /tenders/:id/documents/:docId/ocr — read a scanned document with AI (004/FR-052). Marks the analysis stale, so refresh it too. */
export function useOcrDocument(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => api.post<TenderDocumentDto>(`/tenders/${id}/documents/${docId}/ocr`),
    onSuccess: () => invalidateDocumentChange(qc, id),
    // 409 (already has text) means the list is out of date; refresh it either way.
    onError: () => { qc.invalidateQueries({ queryKey: tenderKeys.documents(id) }); },
  });
}

function invalidateDocumentChange(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: tenderKeys.documents(id) });
  qc.invalidateQueries({ queryKey: tenderKeys.activity(id) });
  qc.invalidateQueries({ queryKey: tenderKeys.analysis(id) });
  qc.invalidateQueries({ queryKey: tenderKeys.detail(id), exact: true });
}

export function useFetchFromGem(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ items: TenderDocumentDto[]; total: number; fetched: number }>(`/tenders/${id}/fetch-documents`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tenderKeys.documents(id) });
      qc.invalidateQueries({ queryKey: tenderKeys.activity(id) });
    },
  });
}

export function useOverride(tenderId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ analysisId, ...body }: { analysisId: string; factorKey: string; status: FactorStatus; reason: string }) =>
      api.post<AnalysisDto>(`/analyses/${analysisId}/override`, body),
    onSuccess: (a) => {
      qc.setQueryData(tenderKeys.analysis(tenderId), a);
      qc.invalidateQueries({ queryKey: tenderKeys.analysis(tenderId) });
      qc.invalidateQueries({ queryKey: tenderKeys.activity(tenderId) });
      qc.invalidateQueries({ queryKey: tenderKeys.detail(tenderId) });
    },
    // The analysis was replaced by a newer one: refetch so the retry targets the new id.
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && err.code === 'analysis_replaced') {
        qc.invalidateQueries({ queryKey: tenderKeys.analysis(tenderId) });
      }
    },
  });
}

/** POST /analyses/:id/rescore — recompute with the current profile, vault and weights; no document re-read (FR-037). */
export function useRescore(tenderId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (analysisId: string) => api.post<AnalysisDto>(`/analyses/${analysisId}/rescore`),
    // The response has the GET shape (lastAttempt + documents), so the cache is replaced, not wiped.
    onSuccess: (a) => {
      qc.setQueryData(tenderKeys.analysis(tenderId), a);
      qc.invalidateQueries({ queryKey: tenderKeys.analysis(tenderId) });
      qc.invalidateQueries({ queryKey: tenderKeys.activity(tenderId) });
      qc.invalidateQueries({ queryKey: tenderKeys.detail(tenderId) });
      qc.invalidateQueries({ queryKey: ['tenders'] });
    },
    // Replaced by a newer analysis / a run started: refetch so the page shows the current state.
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) qc.invalidateQueries({ queryKey: tenderKeys.analysis(tenderId) });
    },
  });
}

export function useStartBid(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const r = await api.post<{ id?: string; workspace?: { id: string } }>(`/tenders/${id}/workspace`);
      const wid = r?.id ?? r?.workspace?.id;
      if (!wid) throw new Error('The bid workspace could not be created');
      return wid;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tenderKeys.detail(id) });
      qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
}

export function useDismiss(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/tenders/${id}/dismiss`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tenderKeys.detail(id) });
      qc.invalidateQueries({ queryKey: ['tenders'] });
    },
  });
}
