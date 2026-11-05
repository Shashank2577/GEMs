/** Pure helpers for the Competitors page (003/US6, FR-064): URL state, paging and copy. */
export const PAGE_SIZE = 25;
export const ALL = 'all';
export const EMPTY_COPY = 'No awarded results for your tracked tenders yet';

export interface CompetitorFilters { category?: string; state?: string; page: number }

/** Read filters from the URL; unknown/blank values fall back to "all", page to 1. */
export function parseFilters(params: URLSearchParams): CompetitorFilters {
  const clean = (k: string) => params.get(k)?.trim() || undefined;
  const p = Number.parseInt(params.get('page') ?? '', 10);
  return { category: clean('category'), state: clean('state'), page: Number.isFinite(p) && p >= 1 ? Math.min(p, 1000) : 1 };
}

/** Serialise filters for the URL (defaults omitted). */
export function toSearchParams(f: CompetitorFilters): URLSearchParams {
  const n = new URLSearchParams();
  if (f.category) n.set('category', f.category);
  if (f.state) n.set('state', f.state);
  if (f.page > 1) n.set('page', String(f.page));
  return n;
}

/** Query for GET /insights/competitors. */
export function toQuery(f: CompetitorFilters) {
  return { ...(f.category ? { category: f.category } : {}), ...(f.state ? { state: f.state } : {}), page: f.page, pageSize: PAGE_SIZE };
}

/** A filter value is only offered when it is one of the facet options (stale URLs are shown as "all"). */
export const selectValue = (v: string | undefined, options: string[]) => (v && options.includes(v) ? v : ALL);

export const totalPages = (total: number, pageSize = PAGE_SIZE) => Math.max(1, Math.ceil(total / pageSize));

/** 1-based rank of a row on the current page. */
export const rankOf = (index: number, page: number, pageSize = PAGE_SIZE) => (page - 1) * pageSize + index + 1;

/** "Showing 26–50 of 61 sellers" */
export function rangeLabel(page: number, count: number, total: number, pageSize = PAGE_SIZE) {
  if (total === 0 || count === 0) return 'No sellers';
  const from = (page - 1) * pageSize + 1;
  return `Showing ${from}–${from + count - 1} of ${total} ${total === 1 ? 'seller' : 'sellers'}`;
}

export const hasFilters = (f: CompetitorFilters) => !!(f.category || f.state);
