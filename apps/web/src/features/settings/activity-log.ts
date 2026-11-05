/** Pure helpers for the Activity log page (002/FR-044). */
import type { ActivityQuery } from '@tp/core/contracts/auth';

export const ACTIVITY_PAGE_SIZE = 25;
export const ALL = 'all';

/**
 * "Type" filter groups; `value` is a comma-separated list of the API's `entityType`s (every type the API writes).
 * Note `workspace.created` is logged with entityType `tender`, hence tenders and workspaces share a group.
 */
export const ACTIVITY_TYPES: { value: string; label: string }[] = [
  { value: ALL, label: 'All activity' },
  { value: 'tender,workspace', label: 'Tenders & bids' },
  { value: 'vault_document', label: 'Vault documents' },
  { value: 'watchlist', label: 'Watchlists' },
  { value: 'profile,past_contract,annexure_template', label: 'Company profile' },
  { value: 'user,invitation', label: 'Team' },
  { value: 'api_token', label: 'API tokens' },
  { value: 'organization,ingestion_run', label: 'Organization & sync' },
];

/** Build the `/activity` query from the UI state (`all` = no filter). */
export function activityParams(f: { page: number; member: string; type: string }): ActivityQuery {
  return {
    page: f.page, pageSize: ACTIVITY_PAGE_SIZE,
    ...(f.member !== ALL ? { userId: f.member } : {}),
    ...(f.type !== ALL ? { entityType: f.type } : {}),
  } as ActivityQuery;
}

/** "Showing 26–50 of 61" (or "No results"). */
export function rangeLabel(page: number, count: number, total: number, pageSize = ACTIVITY_PAGE_SIZE): string {
  if (total === 0 || count === 0) return 'No results';
  const from = (page - 1) * pageSize + 1;
  return `Showing ${from}–${from + count - 1} of ${total}`;
}

export const pageCount = (total: number, pageSize = ACTIVITY_PAGE_SIZE) => Math.max(1, Math.ceil(total / pageSize));

/** Generic object per action family, used when neither the server nor `meta` names the entity. */
const GENERIC_OBJECT: [prefix: string, object: string][] = [
  ['workspace.', 'a bid workspace'], ['packet.', 'a bid workspace'], ['tender.', 'a tender'], ['analysis.', 'a tender'],
  ['vault.', 'a document'], ['watchlist.', 'a watchlist'], ['profile.', 'company profile'], ['member.invite', 'a teammate'], ['member.', 'a teammate'],
];

/**
 * What the entry acted on: the server-resolved `target` label, else safe `meta` fields
 * (name / title / file name / email), else a generic noun for the action family.
 */
export function activityObject(a: { action?: string; meta: Record<string, unknown>; target?: { label: string } | null }): string | null {
  if (a.target?.label) return a.target.label;
  const m = a.meta ?? {};
  for (const v of [m.name, m.title, m.fileName, m.email]) if (typeof v === 'string' && v) return v;
  return GENERIC_OBJECT.find(([p]) => a.action?.startsWith(p))?.[1] ?? null;
}
