/**
 * Analyse contracts (US2) — shared by apps/api (validation) and apps/web (typing).
 * See specs/001-gem-tender-copilot/contracts/api.md § Analyse.
 */
import { z } from 'zod';
import type { ChecklistItem, Requirement, ScoreFactor } from '../analyse/types';
import { DEFAULT_WEIGHTS, FACTOR_KEYS, FACTOR_LABELS, type FactorKey } from '../analyse/score';

export { DEFAULT_WEIGHTS, FACTOR_KEYS, FACTOR_LABELS };
export type { FactorKey, ChecklistItem, Requirement, ScoreFactor };

export const FACTOR_STATUSES = ['pass', 'fail', 'unknown', 'exempt', 'na'] as const;
export const factorStatusSchema = z.enum(FACTOR_STATUSES);
export type FactorStatus = z.infer<typeof factorStatusSchema>;

export const TENDER_DOC_KINDS = ['bid', 'atc', 'corrigendum', 'boq', 'other'] as const;
export const tenderDocKindSchema = z.enum(TENDER_DOC_KINDS);
export type TenderDocKind = z.infer<typeof tenderDocKindSchema>;

export const TENDER_DOC_KIND_LABELS: Record<TenderDocKind, string> = {
  bid: 'Bid document', atc: 'ATC', corrigendum: 'Corrigendum', boq: 'BOQ', other: 'Other',
};

/** Max upload size for tender documents. */
export const MAX_TENDER_DOC_BYTES = 25 * 1024 * 1024;
/** Pages read from one uploaded/fetched PDF (NFR-005): keeps text extraction inside the 128 MB Worker budget. */
export const MAX_EXTRACT_PAGES = 150;

/** POST /analyses/:id/override */
export const overrideFactorInputSchema = z.object({
  factorKey: z.enum(FACTOR_KEYS),
  status: factorStatusSchema,
  reason: z.string().trim().min(3, 'Give a short reason (at least 3 characters)').max(500),
});
export type OverrideFactorInput = z.infer<typeof overrideFactorInputSchema>;

/** GET /analysis/capabilities (004/FR-053): which AI tiers are configured; model ids only, never keys. */
export interface AnalysisCapabilities {
  /** An LLM key is configured: enrichment (and escalation) can run. */
  ai: boolean;
  /** An OCR model is available for scanned PDFs. */
  ocr: boolean;
  models: { enrichment?: string; ocr?: string; escalation?: string };
}

/** PUT /scoring-weights — partial map of factor → weight 0..100. */
export const scoringWeightsSchema = z
  .object(Object.fromEntries(FACTOR_KEYS.map((k) => [k, z.number().min(0).max(100).optional()])) as Record<FactorKey, z.ZodOptional<z.ZodNumber>>)
  .strict()
  .refine((w) => Object.values(w).some((v) => (v ?? 0) > 0) || Object.keys(w).length === 0, 'At least one weight must be above 0');
export type ScoringWeightsInput = z.infer<typeof scoringWeightsSchema>;

/** GET/PUT /scoring-weights response. */
export interface ScoringWeights { weights: Record<FactorKey, number>; defaults: Record<FactorKey, number>; custom: boolean }

/** Why an analysis became stale (FR-043). */
export const STALE_REASONS = ['corrigendum', 'document_added', 'document_removed', 'profile_changed', 'vault_changed', 'weights_changed'] as const;
export type StaleReason = (typeof STALE_REASONS)[number];

/**
 * Stale reasons a Re-score fixes (FR-037): only the company side changed, the stored requirements are
 * still right. Any other reason (or a stale flag without a reason) needs a full re-analysis.
 */
export const RESCORABLE_STALE_REASONS = ['profile_changed', 'vault_changed', 'weights_changed'] as const satisfies readonly StaleReason[];
export const isRescorableReason = (reason: StaleReason | null | undefined): boolean =>
  !!reason && (RESCORABLE_STALE_REASONS as readonly string[]).includes(reason);

/** Non-blocking upload warnings (FR-010). */
export type TenderDocumentWarning =
  | { code: 'bid_number_mismatch'; found: string }
  | { code: 'pages_truncated'; analysed: number; total: number };

/** Tender document (GeM-fetched when orgId is null, else uploaded by the org). Text is omitted. */
export interface TenderDocumentDto {
  id: string;
  tenderId: string;
  orgId: string | null;
  kind: TenderDocKind;
  fileName: string;
  sizeBytes: number;
  /** Pages read (capped at 150, 004/NFR-005). */
  pageCount: number | null;
  /** The PDF's real page count; > pageCount means the document was truncated. Null for rows that predate the column. */
  totalPages: number | null;
  sourceUrl: string | null;
  hasText: boolean;
  /**
   * The document cannot be analysed as it is: its text layer is empty on at least 80% of pages (008/FR-030,
   * `SCANNED_EMPTY_PAGE_RATIO`) and OCR has not transcribed it yet. The UI offers "Read with AI (OCR)" / the unreadable
   * notice on this flag, not on `hasText` (a scan with a few text pages has text but still needs OCR).
   */
  needsOcr: boolean;
  source: 'gem' | 'upload';
  /** Where the stored text came from: the PDF text layer or OCR (FR-052). */
  textSource: 'pdf' | 'ocr';
  /** Bid number printed on page 1 when it differs from the tender's (FR-010), else null. */
  bidNumberFound: string | null;
  createdAt: string;
}

/** POST /tenders/:id/documents response (201). */
export interface UploadTenderDocumentResponse extends TenderDocumentDto { warnings: TenderDocumentWarning[] }

/**
 * Analysis caveats (008/FR-031, FR-037). The web renders them:
 * `llm_budget_exhausted` → "AI review covered {covered} of {total} documents; the rest were checked by rules only."
 * `llm_quota_reached` → "Monthly AI review limit reached — this analysis used rules only."
 */
export type AnalysisWarning =
  | { code: 'llm_budget_exhausted'; covered: number; total: number }
  | { code: 'llm_quota_reached' };

export type AnalysisStatus = 'pending' | 'running' | 'done' | 'failed';
export type Verdict = 'go' | 'review' | 'no_go';

export interface AnalysisDto {
  id: string;
  orgId: string;
  tenderId: string;
  status: AnalysisStatus;
  method: 'rules' | 'rules+llm';
  requirements: Requirement[];
  factors: ScoreFactor[];
  checklist: ChecklistItem[];
  score: number | null;
  confidence: number | null;
  verdict: Verdict | null;
  summary: string | null;
  error: string | null;
  stale: boolean;
  staleReason: StaleReason | null;
  staleAt: string | null;
  /** Analysis notes, e.g. pages not read by AI (FR-051). */
  notes: string[];
  /** Machine-readable caveats (008/FR-031); empty when the analysis ran in full. */
  warnings: AnalysisWarning[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Documents the analysis read. */
  documents?: { id: string; fileName: string; kind: TenderDocKind; pageCount: number | null; totalPages?: number | null }[];
  /**
   * GET …/analysis only (FR-029): the newest attempt when it is still running or failed. The DTO
   * itself is then the latest done analysis (or that attempt when nothing has completed yet).
   */
  lastAttempt?: AnalysisLastAttempt;
}

export interface AnalysisLastAttempt { status: 'running' | 'failed'; error: string | null; at: string }
