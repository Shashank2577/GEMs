/**
 * Analyse domain types. Structurally identical to the jsonb types declared in
 * packages/db/src/schema.ts (Requirement, ScoreFactor, ChecklistItem, DocType) — core does not
 * depend on @tp/db, so they are mirrored here; keep both in sync.
 */
export type DocType =
  | 'gst' | 'pan' | 'udyam' | 'startup_dpiit' | 'incorporation' | 'balance_sheet' | 'itr'
  | 'ca_turnover_certificate' | 'oem_authorization' | 'crac' | 'work_order' | 'iso' | 'bis'
  | 'mii_certificate' | 'emd_exemption' | 'bank_details' | 'power_of_attorney' | 'product_catalogue'
  | 'test_report' | 'other';

export interface Requirement {
  key: string;
  label: string;
  value?: string | number | boolean | null;
  numeric?: number | null;
  mandatory: boolean;
  source: { documentId?: string; fileName?: string; page?: number; quote?: string; ocr?: boolean };
  method: 'RULE' | 'LLM' | 'MANUAL';
  confidence: number;
}

export interface ScoreFactor {
  key: string;
  label: string;
  status: 'pass' | 'fail' | 'unknown' | 'exempt' | 'na';
  weight: number;
  blocking: boolean;
  detail: string;
  requirementKey?: string;
  overridden?: { status: ScoreFactor['status']; reason: string; by: string; at: string };
}

export interface ChecklistItem {
  id: string;
  label: string;
  docType: DocType | null;
  mandatory: boolean;
  reason: string;
  generated?: string;
}
