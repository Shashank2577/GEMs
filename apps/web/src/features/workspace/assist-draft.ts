/** Assist-values editor helpers (006/FR-092). */
export interface DraftField { key: string; value: string }

/** Keys whose draft value differs from the saved one (a missing draft entry counts as empty). */
export function changedAssistKeys(draft: Record<string, string>, fields: readonly DraftField[]): string[] {
  const out: string[] = [];
  for (const f of fields) if ((draft[f.key] ?? '') !== f.value) out.push(f.key);
  return out;
}

/** True when the editor is open and at least one value was changed — the only time leaving must be confirmed. */
export const isAssistDraftDirty = (editing: boolean, draft: Record<string, string>, fields: readonly DraftField[]) =>
  editing && changedAssistKeys(draft, fields).length > 0;
