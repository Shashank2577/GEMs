/** Feed filter state ⇄ URL search params ⇄ API query ⇄ watchlist criteria. */
import type { TenderSort, WatchlistCriteriaInput } from '@tp/core/contracts/identify';

export interface FeedFilters {
  q: string;
  states: string[];
  ministries: string[];
  categories: string[];
  closingWithin: number | null;
  minValue: number | null;
  maxValue: number | null;
  matched: boolean;
  unseen: boolean;
  verdicts: string[];
  bidTypes: string[];
  watchlistId: string | null;
  sort: TenderSort;
  status: 'open' | 'all';
}

export const DEFAULT_FILTERS: FeedFilters = {
  q: '', states: [], ministries: [], categories: [], closingWithin: null, minValue: null, maxValue: null,
  matched: false, unseen: false, verdicts: [], bidTypes: [], watchlistId: null, sort: '-createdAt', status: 'open',
};

const SORTS: TenderSort[] = ['endAt', '-endAt', '-createdAt', 'score', '-score', 'value', '-value', 'relevance'];

export const SORT_OPTIONS: { value: TenderSort; label: string }[] = [
  { value: '-createdAt', label: 'Newest first' },
  { value: 'endAt', label: 'Closing soonest' },
  { value: 'relevance', label: 'Best match' },
  { value: 'score', label: 'Highest score' },
  { value: 'value', label: 'Highest value' },
];

const num = (v: string | null) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export function filtersFromParams(p: URLSearchParams): FeedFilters {
  const sort = p.get('sort') as TenderSort | null;
  return {
    q: p.get('q') ?? '',
    states: p.getAll('state'),
    ministries: p.getAll('ministry'),
    categories: p.getAll('category'),
    closingWithin: num(p.get('closing')),
    minValue: num(p.get('min')),
    maxValue: num(p.get('max')),
    matched: p.get('matched') === '1',
    unseen: p.get('unseen') === '1',
    verdicts: p.getAll('verdict'),
    bidTypes: p.getAll('type'),
    watchlistId: p.get('watchlistId'),
    sort: sort && SORTS.includes(sort) ? sort : DEFAULT_FILTERS.sort,
    status: p.get('status') === 'all' ? 'all' : 'open',
  };
}

export function filtersToParams(f: FeedFilters, view?: string): URLSearchParams {
  const p = new URLSearchParams();
  if (view) p.set('view', view);
  if (f.q) p.set('q', f.q);
  f.states.forEach((s) => p.append('state', s));
  f.ministries.forEach((s) => p.append('ministry', s));
  f.categories.forEach((s) => p.append('category', s));
  if (f.closingWithin != null) p.set('closing', String(f.closingWithin));
  if (f.minValue != null) p.set('min', String(f.minValue));
  if (f.maxValue != null) p.set('max', String(f.maxValue));
  if (f.matched) p.set('matched', '1');
  if (f.unseen) p.set('unseen', '1');
  f.verdicts.forEach((s) => p.append('verdict', s));
  f.bidTypes.forEach((s) => p.append('type', s));
  if (f.watchlistId) p.set('watchlistId', f.watchlistId);
  if (f.sort !== DEFAULT_FILTERS.sort) p.set('sort', f.sort);
  if (f.status !== 'open') p.set('status', f.status);
  return p;
}

/** Query for GET /tenders (repeated keys for multi-value filters). */
export function toApiQuery(f: FeedFilters) {
  return {
    q: f.q || undefined,
    state: f.states,
    ministry: f.ministries,
    category: f.categories,
    closingWithinDays: f.closingWithin ?? undefined,
    minValue: f.minValue ?? undefined,
    maxValue: f.maxValue ?? undefined,
    matched: f.matched ? 1 : undefined,
    unseen: f.unseen ? 1 : undefined,
    verdict: f.verdicts,
    bidType: f.bidTypes,
    watchlistId: f.watchlistId ?? undefined,
    sort: f.sort,
    status: f.status,
  };
}

/** Number of user-set refinements (excluding sort / view toggles), for the "Filters (n)" badge. */
export function activeFilterCount(f: FeedFilters): number {
  return f.states.length + f.ministries.length + f.categories.length + f.verdicts.length + f.bidTypes.length
    + (f.closingWithin != null ? 1 : 0) + (f.minValue != null || f.maxValue != null ? 1 : 0) + (f.watchlistId ? 1 : 0);
}

export function isPristine(f: FeedFilters): boolean {
  return !f.q && activeFilterCount(f) === 0 && !f.matched && !f.unseen && f.status === 'open';
}

/** Turn the current feed filters into watchlist criteria ("Save as watchlist"). */
export function filtersToCriteria(f: FeedFilters): WatchlistCriteriaInput {
  return {
    keywords: f.q ? [f.q.trim()] : [],
    excludeKeywords: [],
    categories: f.categories,
    hsnCodes: [],
    states: f.states,
    ministries: f.ministries,
    minValue: f.minValue,
    maxValue: f.maxValue,
    minDaysToClose: null,
    bidTypes: f.bidTypes as WatchlistCriteriaInput['bidTypes'],
  };
}

/** Saved views shown as quick tabs above the feed. */
export const VIEWS: { key: string; label: string; apply: (f: FeedFilters) => FeedFilters; match: (f: FeedFilters) => boolean }[] = [
  {
    key: 'matched', label: 'My matches',
    apply: () => ({ ...DEFAULT_FILTERS, matched: true, sort: 'relevance' }),
    match: (f) => f.matched && !f.unseen && f.closingWithin == null && !f.verdicts.length,
  },
  {
    key: 'new', label: 'New',
    apply: () => ({ ...DEFAULT_FILTERS, matched: true, unseen: true }),
    match: (f) => f.unseen,
  },
  {
    key: 'closing', label: 'Closing this week',
    apply: () => ({ ...DEFAULT_FILTERS, closingWithin: 7, sort: 'endAt' }),
    match: (f) => f.closingWithin === 7 && !f.matched,
  },
  {
    key: 'go', label: 'Go verdicts',
    apply: () => ({ ...DEFAULT_FILTERS, verdicts: ['go'], sort: 'score' }),
    match: (f) => f.verdicts.length === 1 && f.verdicts[0] === 'go',
  },
  {
    key: 'all', label: 'All open bids',
    apply: () => ({ ...DEFAULT_FILTERS }),
    match: (f) => isPristine(f),
  },
];

/** Value presets (rupees). */
export const VALUE_PRESETS: { label: string; min: number | null; max: number | null }[] = [
  { label: 'Under ₹10 L', min: null, max: 10_00_000 },
  { label: '₹10 L – ₹1 Cr', min: 10_00_000, max: 1_00_00_000 },
  { label: '₹1 Cr – ₹5 Cr', min: 1_00_00_000, max: 5_00_00_000 },
  { label: 'Above ₹5 Cr', min: 5_00_00_000, max: null },
];

export const CLOSING_OPTIONS: { value: string; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: '3', label: '3 days' },
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
];

export const BID_TYPE_OPTIONS = [
  { value: 'bid', label: 'Bid' },
  { value: 'ra', label: 'Reverse auction' },
  { value: 'service', label: 'Service' },
  { value: 'bunch', label: 'Bunch' },
];

export const VERDICT_OPTIONS = [
  { value: 'go', label: 'Go' },
  { value: 'review', label: 'Review' },
  { value: 'no_go', label: 'No-Go' },
  { value: 'none', label: 'Not analysed' },
];
