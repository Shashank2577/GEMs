/**
 * Checklist → vault auto-mapping and bid readiness (T060; FR-023, FR-028).
 *
 *   autoMap(checklist, docs, now)            → { [itemId]: docId | null }
 *   readiness(checklist, mapping, docs, overrides, now) → per-item state + percent + blockers
 *
 * Mapping semantics used by the workspace: a key that is ABSENT from the stored mapping means
 * "automatic" (the best vault document is picked at read time, so a document uploaded later is
 * matched without any user action); an explicit `null` means the user cleared it ("none").
 */
import type { ChecklistItem, DocType } from '../analyse/types';
import { docStatus, type DocStatus } from '../vault/status';

/** The subset of a vault document the mapper needs (VaultDocumentDto and DB rows both fit). */
export interface MappableDoc {
  id: string;
  type: DocType | string;
  title: string;
  expiryDate?: string | null;
  issueDate?: string | null;
  financialYear?: string | null;
  tags?: string[] | null;
  fileName?: string | null;
  createdAt?: string | Date | null;
}

export type ReadinessState = 'ready' | 'missing' | 'expired' | 'expiring' | 'generated' | 'overridden';

export interface ItemOverride { itemId: string; reason: string; by: string; at: string }

export interface ReadinessItem {
  item: ChecklistItem;
  state: ReadinessState;
  /** Vault document chosen for the item (null for generated / missing). */
  docId: string | null;
  /** True when the document was picked automatically (no explicit user choice). */
  auto: boolean;
  docStatus: DocStatus | null;
  daysToExpiry: number | null;
  /** Counts as a blocker for "Ready to submit". */
  blocking: boolean;
  override: ItemOverride | null;
  /** Short human explanation of the state. */
  note: string;
}

export interface Readiness {
  items: ReadinessItem[];
  /** 0..100 — share of mandatory items (all items when none are mandatory) that are covered. */
  percent: number;
  total: number;
  covered: number;
  /** Mandatory items that are missing or expired and not overridden. */
  blockers: { itemId: string; label: string; state: ReadinessState }[];
  /** Covered but worth a look (expiring soon, optional items missing). */
  warnings: { itemId: string; label: string; state: ReadinessState }[];
  canMarkReady: boolean;
}

/** Closely related document types accepted as a fallback when the exact type is not in the vault. */
const FALLBACK_TYPES: Partial<Record<DocType, DocType[]>> = {
  crac: ['work_order'],
  work_order: ['crac'],
  ca_turnover_certificate: [],
  mii_certificate: [],
  emd_exemption: ['udyam', 'startup_dpiit'],
};

const PER_FY: ReadonlySet<string> = new Set(['balance_sheet', 'itr', 'ca_turnover_certificate']);

const STOP = new Set([
  'the', 'and', 'for', 'of', 'a', 'an', 'to', 'in', 'on', 'by', 'with', 'as', 'or', 'from', 'this', 'bid', 'certificate',
  'copy', 'document', 'documents', 'proof', 'last', 'years', 'year', 'specified', 'atc', 'requested', 'required', 'seller',
]);

const tokens = (s: string | null | undefined): string[] =>
  (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w));

/** "2024-25" / "FY 2024-2025" → 2024 (start year) for ordering; null when unknown. */
export function fyStartYear(fy: string | null | undefined): number | null {
  if (!fy) return null;
  const m = fy.match(/(20\d{2})/);
  return m ? Number(m[1]) : null;
}

const STATUS_RANK: Record<DocStatus, number> = { valid: 3, expiring: 2, expired: 0 };

const toTime = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() || 0 : 0);

/** Tag/title overlap between a checklist item and a document (0..1). */
export function relevance(item: ChecklistItem, doc: MappableDoc): number {
  const want = new Set([...tokens(item.label), ...tokens(item.id.replace(/_/g, ' '))]);
  if (!want.size) return 0;
  const have = new Set([...tokens(doc.title), ...(doc.tags ?? []).flatMap((t) => tokens(t)), ...tokens(doc.fileName)]);
  let hit = 0;
  for (const w of want) if (have.has(w)) hit++;
  // Explicit tag equal to the item id is a strong signal (e.g. tag "cert_iso_9001").
  if ((doc.tags ?? []).some((t) => t.toLowerCase() === item.id.toLowerCase())) hit += want.size;
  return Math.min(1, hit / want.size);
}

/** Sort key: higher is better. */
function rank(item: ChecklistItem, doc: MappableDoc, now: Date, exactType: boolean): number[] {
  const st = docStatus(doc.expiryDate ?? null, now).status;
  const fy = PER_FY.has(String(doc.type)) ? fyStartYear(doc.financialYear) ?? 0 : 0;
  return [
    exactType ? 1 : 0,
    STATUS_RANK[st],
    Math.round(relevance(item, doc) * 100),
    fy,
    toTime(doc.expiryDate),
    toTime(doc.issueDate),
    toTime(doc.createdAt),
  ];
}

const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
  return 0;
};

/** Best vault document for one checklist item, or null. Generated items never map to a document. */
export function bestDocFor(item: ChecklistItem, docs: MappableDoc[], now: Date): MappableDoc | null {
  if (item.generated) return null;
  if (!item.docType) return null;
  let candidates: { doc: MappableDoc; key: number[] }[] = [];
  if (item.docType === 'other') {
    // "Other" items only map when the document clearly matches by title/tags.
    candidates = docs
      .filter((d) => relevance(item, d) >= 0.5)
      .map((d) => ({ doc: d, key: rank(item, d, now, d.type === item.docType) }));
  } else {
    const exact = docs.filter((d) => d.type === item.docType);
    const pool = exact.length ? exact : docs.filter((d) => (FALLBACK_TYPES[item.docType as DocType] ?? []).includes(d.type as DocType));
    candidates = pool.map((d) => ({ doc: d, key: rank(item, d, now, d.type === item.docType) }));
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => cmp(a.key, b.key));
  return candidates[0].doc;
}

/** Map every checklist item to its best vault document (null when nothing fits). */
export function autoMap(checklist: ChecklistItem[], docs: MappableDoc[], now: Date): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const item of checklist) out[item.id] = bestDocFor(item, docs, now)?.id ?? null;
  return out;
}

/** Resolve the effective document for an item: explicit mapping wins, absent key = automatic. */
export function resolveMapping(
  checklist: ChecklistItem[], mapping: Record<string, string | null | undefined>, docs: MappableDoc[], now: Date,
): Record<string, { docId: string | null; auto: boolean }> {
  const out: Record<string, { docId: string | null; auto: boolean }> = {};
  for (const item of checklist) {
    if (Object.prototype.hasOwnProperty.call(mapping, item.id) && mapping[item.id] !== undefined) {
      const id = mapping[item.id] ?? null;
      out[item.id] = { docId: id && docs.some((d) => d.id === id) ? id : null, auto: false };
    } else {
      out[item.id] = { docId: bestDocFor(item, docs, now)?.id ?? null, auto: true };
    }
  }
  return out;
}

export function readiness(
  checklist: ChecklistItem[],
  mapping: Record<string, string | null | undefined>,
  docs: MappableDoc[],
  overrides: ItemOverride[],
  now: Date,
): Readiness {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const resolved = resolveMapping(checklist, mapping, docs, now);
  const ovr = new Map(overrides.map((o) => [o.itemId, o]));
  const items: ReadinessItem[] = checklist.map((item) => {
    const { docId, auto } = resolved[item.id];
    const doc = docId ? byId.get(docId) : undefined;
    const st = doc ? docStatus(doc.expiryDate ?? null, now) : null;
    const override = ovr.get(item.id) ?? null;
    let state: ReadinessState;
    let note: string;
    if (item.generated) {
      state = 'generated';
      note = 'Generated by TenderPilot from your profile — review, sign and stamp.';
    } else if (!doc) {
      state = 'missing';
      note = mapping[item.id] === null ? 'Marked as not available.' : 'No matching document in the vault.';
    } else if (st!.status === 'expired') {
      state = 'expired';
      note = `Expired ${Math.abs(st!.daysToExpiry ?? 0)} day(s) ago — upload the renewed document.`;
    } else if (st!.status === 'expiring') {
      state = 'expiring';
      note = st!.daysToExpiry === 0 ? 'Expires today.' : `Expires in ${st!.daysToExpiry} day(s).`;
    } else {
      state = 'ready';
      note = auto ? 'Matched automatically from the vault.' : 'Selected from the vault.';
    }
    const problem = state === 'missing' || state === 'expired';
    if (problem && override) {
      state = 'overridden';
      note = `Overridden: ${override.reason}`;
    }
    return {
      item, state, docId: doc?.id ?? null, auto, docStatus: st?.status ?? null, daysToExpiry: st?.daysToExpiry ?? null,
      blocking: problem && !override && item.mandatory, override, note,
    };
  });
  const scope = items.some((i) => i.item.mandatory) ? items.filter((i) => i.item.mandatory) : items;
  const isCovered = (i: ReadinessItem) => i.state !== 'missing' && i.state !== 'expired';
  const covered = scope.filter(isCovered).length;
  const blockers = items.filter((i) => i.blocking).map((i) => ({ itemId: i.item.id, label: i.item.label, state: i.state }));
  const warnings = items
    .filter((i) => !i.blocking && (i.state === 'expiring' || (!isCovered(i) && !i.item.mandatory)))
    .map((i) => ({ itemId: i.item.id, label: i.item.label, state: i.state }));
  return {
    items,
    percent: scope.length ? Math.round((covered / scope.length) * 100) : 100,
    total: scope.length,
    covered,
    blockers,
    warnings,
    canMarkReady: blockers.length === 0,
  };
}
