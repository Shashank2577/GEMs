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

/** POST /analyses/:id/override */
export const overrideFactorInputSchema = z.object({
  factorKey: z.enum(FACTOR_KEYS),
  status: factorStatusSchema,
  reason: z.string().trim().min(3, 'Give a short reason (at least 3 characters)').max(500),
});
export type OverrideFactorInput = z.infer<typeof overrideFactorInputSchema>;

/** PUT /scoring-weights — partial map of factor → weight 0..100. */
export const scoringWeightsSchema = z
  .object(Object.fromEntries(FACTOR_KEYS.map((k) => [k, z.number().min(0).max(100).optional()])) as Record<FactorKey, z.ZodOptional<z.ZodNumber>>)
  .strict()
  .refine((w) => Object.values(w).some((v) => (v ?? 0) > 0) || Object.keys(w).length === 0, 'At least one weight must be above 0');
export type ScoringWeightsInput = z.infer<typeof scoringWeightsSchema>;

/** GET/PUT /scoring-weights response. */
export interface ScoringWeights { weights: Record<FactorKey, number>; defaults: Record<FactorKey, number>; custom: boolean }

/** Tender document (GeM-fetched when orgId is null, else uploaded by the org). Text is omitted. */
export interface TenderDocumentDto {
  id: string;
  tenderId: string;
  orgId: string | null;
  kind: TenderDocKind;
  fileName: string;
  sizeBytes: number;
  pageCount: number | null;
  sourceUrl: string | null;
  hasText: boolean;
  source: 'gem' | 'upload';
  createdAt: string;
}

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
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Documents the analysis read. */
  documents?: { id: string; fileName: string; kind: TenderDocKind; pageCount: number | null }[];
}
