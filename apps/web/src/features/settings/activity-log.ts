/** Pure helpers for the Activity log page (002/FR-044). */
import type { ActivityQuery } from '@tp/core/contracts/auth';

export const ACTIVITY_PAGE_SIZE = 25;
export const ALL = 'all';

/** "Type" filter options, mapped to the API's `entityType`. */
export const ACTIVITY_TYPES: { value: string; label: string }[] = [
  { value: ALL, label: 'All activity' },
  { value: 'workspace', label: 'Bids & workspaces' },
  { value: 'tender', label: 'Tenders' },
  { value: 'vault_document', label: 'Vault documents' },
  { value: 'watchlist', label: 'Watchlists' },
  { value: 'profile', label: 'Company profile' },
  { value: 'user', label: 'Team & accounts' },
  { value: 'invitation', label: 'Invitations' },
  { value: 'api_token', label: 'API tokens' },
  { value: 'organization', label: 'Organization' },
  { value: 'ingestion_run', label: 'Sync runs' },
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

/** What the entry acted on, from safe `meta` fields only (name / email). */
export function activityObject(a: { meta: Record<string, unknown> }): string | null {
  const m = a.meta ?? {};
  const v = m.name ?? m.email;
  return typeof v === 'string' && v ? v : null;
}
