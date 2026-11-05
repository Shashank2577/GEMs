/** Messages between the popup and the content script. */
import type { FillReport, PayloadField } from './fill';

export type ContentRequest =
  | { type: 'tp:scan'; fields: PayloadField[] }
  | { type: 'tp:fill'; fields: PayloadField[]; keys?: string[]; overwrite?: boolean }
  | { type: 'tp:clear' };

export interface ScanSummary { fillable: number; forbidden: number; unmatched: number; noValue: number; manual: number; keys: string[] }

export type ContentResponse =
  | { ok: true; scan: ScanSummary }
  | { ok: true; report: FillReport }
  | { ok: true }
  | { ok: false; error: string };
