/**
 * Pure fill logic for the TenderPilot browser extension (T065; FR-027, Constitution I).
 *
 * Works on an abstract `FillTarget` so it can be unit-tested without a browser. The content script
 * adapts real DOM controls (see dom.ts). Rules enforced here:
 *  - a field is filled only if it matches an allow-listed key from the assist payload AND is not
 *    forbidden (price / rate / amount / CAPTCHA / OTP / DSC / e-Sign / Aadhaar / password / submit);
 *  - forbidden fields are never written, even when a caller asks for them explicitly;
 *  - existing user input is not overwritten unless `overwrite` is set;
 *  - nothing is ever clicked or submitted — filling happens only in response to a user click.
 */
import { forbiddenReason, matchField, type FieldDescriptor } from '@tp/core/assist/allowlist';

export interface PayloadField { key: string; label: string; value: string; selectorHints: string[] }

export type MarkState = 'available' | 'filled' | 'blocked' | 'manual' | 'none';

export interface FillTarget {
  descriptor: FieldDescriptor;
  /** `choice` = radio / checkbox question: reported as "left for you", never clicked (FR-077). */
  kind: 'input' | 'textarea' | 'select' | 'choice';
  disabled?: boolean;
  readOnly?: boolean;
  getValue(): string;
  /** Write the value (and fire input/change events). Returns false when it could not be applied. */
  setValue(value: string): boolean;
  mark(state: MarkState, note?: string): void;
}

export type PlanStatus = 'fillable' | 'forbidden' | 'unmatched' | 'no_value' | 'disabled' | 'manual';

export interface PlanEntry {
  target: FillTarget;
  status: PlanStatus;
  field?: PayloadField;
  reason?: string;
}

export interface FillReport {
  filled: { key: string; label: string; value: string }[];
  skipped: { key?: string; label?: string; reason: string }[];
  forbidden: number;
  unmatched: number;
}

/** Decide, for every control on the page, whether it may be filled and with which value. */
export function plan(targets: FillTarget[], fields: PayloadField[]): PlanEntry[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  return targets.map((target) => {
    if (target.kind === 'choice') {
      // Radio / checkbox: judged on text only (the input type is always "forbidden"). A pattern hit is still
      // forbidden; an allow-listed question is reported as manual — we show the answer, the user clicks.
      const text = { ...target.descriptor, type: 'text' };
      const why = forbiddenReason(text);
      if (why) return { target, status: 'forbidden', reason: why } as PlanEntry;
      const k = matchField(text, fields);
      if (!k) return { target, status: 'unmatched' } as PlanEntry;
      return { target, status: 'manual', field: byKey.get(k)! } as PlanEntry;
    }
    const reason = forbiddenReason(target.descriptor);
    if (reason) return { target, status: 'forbidden', reason } as PlanEntry;
    const key = matchField(target.descriptor, fields);
    if (!key) return { target, status: 'unmatched' } as PlanEntry;
    const field = byKey.get(key)!;
    if (target.disabled || target.readOnly) return { target, status: 'disabled', field } as PlanEntry;
    if (!field.value) return { target, status: 'no_value', field } as PlanEntry;
    return { target, status: 'fillable', field } as PlanEntry;
  });
}

/** Human text for every skip reason code (FR-075). */
export const SKIP_REASON_TEXT: Record<string, string> = {
  fillable: 'could not be filled',
  forbidden: 'protected field — never filled',
  unmatched: 'not a recognised field',
  no_value: 'no prepared value',
  disabled: 'disabled or read-only',
  manual: 'left for you',
};
export const skipReasonText = (code: string) => SKIP_REASON_TEXT[code] ?? code;

/** Fill a single planned entry (called when the user clicks that field's chip). */
export function fillOne(entry: PlanEntry, opts: { overwrite?: boolean } = {}): { ok: boolean; reason?: string } {
  // Radio / checkbox questions are never clicked (FR-077).
  if (entry.status === 'manual' || entry.target.kind === 'choice') return { ok: false, reason: 'left for you' };
  // Defence in depth: re-check the descriptor right before writing.
  const reason = forbiddenReason(entry.target.descriptor);
  if (reason) { entry.target.mark('blocked', `Never filled: ${reason}`); return { ok: false, reason: `forbidden (${reason})` }; }
  if (entry.status !== 'fillable' || !entry.field) return { ok: false, reason: skipReasonText(entry.status) };
  if (!opts.overwrite && entry.target.getValue().trim() !== '') return { ok: false, reason: 'already has a value' };
  const ok = entry.target.setValue(entry.field.value);
  if (ok) entry.target.mark('filled', `${entry.field.label} filled by TenderPilot — please verify`);
  return ok ? { ok } : { ok, reason: 'value not accepted by the field' };
}

/** "Fill allowed fields" button: fill every fillable entry, report what was skipped and why. */
export function fillAll(targets: FillTarget[], fields: PayloadField[], opts: { overwrite?: boolean; keys?: string[] } = {}): FillReport {
  const report: FillReport = { filled: [], skipped: [], forbidden: 0, unmatched: 0 };
  for (const e of plan(targets, fields)) {
    if (e.status === 'forbidden') { report.forbidden++; e.target.mark('blocked', `Never filled by TenderPilot (${e.reason})`); continue; }
    if (e.status === 'unmatched') { report.unmatched++; continue; }
    if (opts.keys && e.field && !opts.keys.includes(e.field.key)) continue;
    if (e.status === 'manual') { report.skipped.push({ key: e.field!.key, label: e.field!.label, reason: `left for you — choose “${e.field!.value}” yourself` }); continue; }
    const r = fillOne(e, opts);
    if (r.ok) report.filled.push({ key: e.field!.key, label: e.field!.label, value: e.field!.value });
    else report.skipped.push({ key: e.field?.key, label: e.field?.label, reason: skipReasonText(r.reason ?? e.status) });
  }
  return report;
}

const YES = ['yes', 'y', 'comply', 'complied', 'true', 'agree'];
const NO = ['no', 'n', 'not applicable', 'false'];

/** Choose the <option> that best matches a wanted value (exact → yes/no synonyms → prefix → contains). */
export function pickOption(options: { value: string; text: string }[], wanted: string): string | null {
  const w = wanted.trim().toLowerCase();
  if (!w) return null;
  const norm = options.map((o) => ({ ...o, v: o.value.trim().toLowerCase(), t: o.text.trim().toLowerCase() })).filter((o) => o.v || o.t);
  const exact = norm.find((o) => o.v === w || o.t === w);
  if (exact) return exact.value;
  for (const group of [YES, NO]) {
    if (group.includes(w)) {
      const hit = norm.find((o) => group.includes(o.v) || group.includes(o.t) || group.some((g) => o.t.startsWith(`${g} `)));
      if (hit) return hit.value;
    }
  }
  const prefix = norm.find((o) => o.t.startsWith(w) || o.v.startsWith(w));
  if (prefix) return prefix.value;
  const contains = norm.find((o) => w.length >= 3 && (o.t.includes(w) || w.includes(o.t)) && o.t.length >= 3);
  return contains ? contains.value : null;
}
