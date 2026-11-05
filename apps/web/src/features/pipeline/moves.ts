/** Pure helpers for the pipeline's non-drag moves and the "Record the result" dialog (007/FR-029…FR-031). */
import { STAGES, STAGE_LABELS, canTransition, type OutcomeInput, type StageName } from '@tp/core/contracts/apply';

export const DROP_CONFIRM_TITLE = 'Drop this bid?';
export const DROP_CONFIRM_BODY = 'It leaves the active pipeline but keeps its history.';
export const VIEW_ONLY_NOTE = 'You have view-only access. Ask an Analyst, Bid Manager or Owner to move bids between stages.';
export const SEARCH_DEBOUNCE_MS = 300;
export const NOTES_MAX = 2000;

export interface MoveTarget { stage: StageName; label: string; disabled: boolean; hint?: string }

/** Every stage except the current one (Dropped included), in pipeline order; Won/Lost need a recorded submission. */
export function moveTargets(from: StageName): MoveTarget[] {
  return STAGES.filter((s) => s !== from).map((stage) => {
    const ok = canTransition(from, stage).ok;
    return { stage, label: STAGE_LABELS[stage], disabled: !ok, ...(ok ? {} : { hint: 'After Submitted' }) };
  });
}

/** Whole rupees from user input ("29,50,000", "₹ 2950000.4") → 2950000; blank → null; garbage → NaN. */
export function parseRupees(s: string): number | null {
  const t = s.replace(/[,₹\s]/g, '');
  if (!t) return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return Number.NaN;
  return Math.round(Number(t));
}

export interface OutcomeForm { l1: string; ours: string; notes: string }

/** Validated `outcome` body for PATCH /workspaces/:id, or field errors. */
export function outcomePayload(result: 'won' | 'lost', f: OutcomeForm):
  { ok: true; outcome: OutcomeInput } | { ok: false; errors: Partial<Record<keyof OutcomeForm, string>> } {
  const errors: Partial<Record<keyof OutcomeForm, string>> = {};
  const l1 = parseRupees(f.l1);
  const ours = parseRupees(f.ours);
  if (Number.isNaN(l1)) errors.l1 = 'Enter an amount in rupees, e.g. 29,50,000';
  if (Number.isNaN(ours)) errors.ours = 'Enter an amount in rupees, e.g. 29,50,000';
  if (f.notes.length > NOTES_MAX) errors.notes = `Keep notes to ${NOTES_MAX} characters or fewer`;
  if (Object.keys(errors).length) return { ok: false, errors };
  const notes = f.notes.trim();
  return { ok: true, outcome: { result, l1Price: l1, ourPrice: ours, notes: notes || null } };
}

/** Keyboard drag (FR-022, US2-13): the column one step left/right of `from` among the visible `stages`, or null at an edge. */
export function adjacentStage(stages: readonly StageName[], from: StageName | null, dir: 1 | -1): StageName | null {
  if (!from) return null;
  const i = stages.indexOf(from);
  if (i < 0) return null;
  return stages[i + dir] ?? null;
}

/** "Truly empty" vs "filtered to nothing" (FR-027, US2-15): any active search/owner/closing filter means filtered. */
export function emptyKind(total: number, filtering: boolean): 'pipeline' | 'filtered' | null {
  if (total > 0) return null;
  return filtering ? 'filtered' : 'pipeline';
}
