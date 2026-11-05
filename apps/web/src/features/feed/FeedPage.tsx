/**
 * Tender feed — the hero screen (US1, FR-006): live GeM BidPlus bids with match reasons, filters rail,
 * saved views, cards/table, infinite pagination and sync health. Filters live in the URL so every
 * view is shareable (e.g. alert emails link to /tenders?matched=1).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  BellPlus, FileStack, LayoutGrid, Loader2, Radar, RefreshCw, Rows3, Search, SlidersHorizontal, X,
} from 'lucide-react';
import {
  Badge, Button, EmptyState, ErrorState, Input, Kbd, PageHeader, Segmented, Select, Sheet, SheetBody, SheetContent,
  SheetFooter, SheetHeader, SheetTitle, Switch, Label, Tooltip,
} from '@/components/ui';
import { RoleGate, useAuth } from '@/lib/auth';
import { formatINR, formatNumberIN, pluralize } from '@/lib/format';
import { useIsMobile, useLocalStorage } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { useWatchlists } from '@/features/watchlists/api';
import { useSyncNow, useTenderFeed } from './api';
import { FilterRail } from './FilterRail';
import {
  activeFilterCount, DEFAULT_FILTERS, filtersFromParams, filtersToCriteria, filtersToParams, isPristine, SORT_OPTIONS, VIEWS, type FeedFilters,
} from './filters';
import { SyncHealth } from './SyncHealth';
import { TenderCard, TenderCardSkeleton } from './TenderCard';
import { TenderTable } from './TenderTable';

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

function ActiveChips({ f, onChange }: { f: FeedFilters; onChange: (p: Partial<FeedFilters>) => void }) {
  const chips: { key: string; label: string; clear: () => void }[] = [];
  f.states.forEach((s) => chips.push({ key: `s-${s}`, label: s, clear: () => onChange({ states: f.states.filter((x) => x !== s) }) }));
  f.ministries.forEach((s) => chips.push({ key: `m-${s}`, label: s, clear: () => onChange({ ministries: f.ministries.filter((x) => x !== s) }) }));
  f.categories.forEach((s) => chips.push({ key: `c-${s}`, label: s, clear: () => onChange({ categories: f.categories.filter((x) => x !== s) }) }));
  if (f.closingWithin != null) chips.push({ key: 'closing', label: `Closes ≤ ${f.closingWithin} days`, clear: () => onChange({ closingWithin: null }) });
  if (f.minValue != null || f.maxValue != null) {
    chips.push({ key: 'value', label: `${f.minValue != null ? formatINR(f.minValue, { compact: true }) : '₹0'} – ${f.maxValue != null ? formatINR(f.maxValue, { compact: true }) : 'any'}`, clear: () => onChange({ minValue: null, maxValue: null }) });
  }
  f.verdicts.forEach((v) => chips.push({ key: `v-${v}`, label: v === 'none' ? 'Not analysed' : v === 'no_go' ? 'No-Go' : v === 'go' ? 'Go' : 'Review', clear: () => onChange({ verdicts: f.verdicts.filter((x) => x !== v) }) }));
  f.bidTypes.forEach((v) => chips.push({ key: `b-${v}`, label: v === 'ra' ? 'Reverse auction' : v[0].toUpperCase() + v.slice(1), clear: () => onChange({ bidTypes: f.bidTypes.filter((x) => x !== v) }) }));
  if (f.watchlistId) chips.push({ key: 'wl', label: 'One watchlist', clear: () => onChange({ watchlistId: null }) });
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
      {chips.map((c) => (
        <button key={c.key} type="button" onClick={c.clear} className="group inline-flex h-7 max-w-[16rem] items-center gap-1 rounded-full border bg-card pl-2.5 pr-1.5 text-xs font-medium shadow-xs transition-colors hover:border-danger/30 hover:text-danger focus-ring" aria-label={`Remove filter ${c.label}`}>
          <span className="truncate">{c.label}</span>
          <X className="size-3.5 text-muted-foreground group-hover:text-danger" />
        </button>
      ))}
      <button type="button" onClick={() => onChange({ ...DEFAULT_FILTERS, q: f.q, matched: f.matched, unseen: f.unseen, sort: f.sort })} className="h-7 rounded-full px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-ring">Clear all</button>
    </div>
  );
}

export default function FeedPage() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { can } = useAuth();
  const [layout, setLayout] = useLocalStorage<'cards' | 'table'>('tp.feed.layout', 'cards');
  const [railOpen, setRailOpen] = useLocalStorage('tp.feed.rail', true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [q, setQ] = useState(filters.q);
  const debouncedQ = useDebounced(q, 350);
  const searchRef = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const update = (patch: Partial<FeedFilters>) => setParams(filtersToParams({ ...filters, ...patch }), { replace: true });

  // URL → input when navigating (e.g. ⌘K search); input → URL debounced.
  useEffect(() => { setQ(filters.q); }, [filters.q]);
  useEffect(() => {
    if (debouncedQ !== filters.q) update({ q: debouncedQ.trim() ? debouncedQ : '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  // "/" focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !el.isContentEditable) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const feed = useTenderFeed(filters);
  const watchlists = useWatchlists();
  const sync = useSyncNow();
  const first = feed.data?.pages[0];
  const items = useMemo(() => feed.data?.pages.flatMap((p) => p.items) ?? [], [feed.data]);
  const total = first?.total ?? 0;
  const facets = first?.facets;
  const nFilters = activeFilterCount(filters);
  const activeView = VIEWS.find((v) => v.match(filters))?.key;
  const hasWatchlists = (watchlists.data?.total ?? 0) > 0;
  const showTable = layout === 'table' && !isMobile;

  // Auto-load more when the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !feed.hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !feed.isFetchingNextPage) feed.fetchNextPage();
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [feed.hasNextPage, feed.isFetchingNextPage, feed.fetchNextPage, items.length]);

  const saveAsWatchlist = () => {
    const criteria = filtersToCriteria(filters);
    const name = [filters.q, filters.states.slice(0, 2).join(' & '), filters.categories[0]].filter(Boolean).join(' · ') || 'My watchlist';
    navigate('/watchlists?new=1', { state: { criteria, name: name.slice(0, 60) } });
  };

  const rail = (
    <FilterRail
      filters={filters}
      facets={facets}
      onChange={update}
      onReset={() => setParams(filtersToParams({ ...DEFAULT_FILTERS }), { replace: true })}
    />
  );

  return (
    <>
      <PageHeader
        title="Tenders"
        description="Live GeM BidPlus bids, matched to your watchlists. Score a bid in one click and start preparing."
        actions={
          <>
            <SyncHealth />
            <RoleGate min="analyst">
              <Button variant="secondary" size="sm" onClick={saveAsWatchlist} disabled={isPristine(filters) && !filters.q}>
                <BellPlus />Save as watchlist
              </Button>
            </RoleGate>
          </>
        }
      />

      {/* Saved views */}
      <div className="-mx-4 mb-4 flex items-center gap-3 overflow-x-auto px-4 pb-1 scrollbar-thin sm:mx-0 sm:px-0" role="tablist" aria-label="Saved views">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            role="tab"
            aria-selected={activeView === v.key}
            onClick={() => setParams(filtersToParams(v.apply(filters)), { replace: true })}
            className={cn(
              'h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium transition-colors focus-ring',
              activeView === v.key ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="flex gap-8">
        {/* Desktop filter rail */}
        {!isMobile && railOpen && (
          <aside className="hidden w-64 shrink-0 lg:block" aria-label="Filters">
            <div className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto pb-6 pr-2 scrollbar-thin">{rail}</div>
          </aside>
        )}

        <div className="min-w-0 flex-1">
          {/* Toolbar */}
          <div className="sticky top-14 z-10 -mx-4 mb-3 bg-background/85 px-4 py-2 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[12rem] flex-1">
                <Input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search item, buyer, bid number, city…"
                  aria-label="Search tenders"
                  leading={<Search />}
                  trailing={q ? (
                    <button type="button" onClick={() => setQ('')} className="rounded p-1 hover:bg-muted focus-ring" aria-label="Clear search"><X /></button>
                  ) : <Kbd className="hidden sm:inline-flex">/</Kbd>}
                  className="h-10"
                />
              </div>
              <Button
                variant="secondary"
                className={cn('h-10', !isMobile && railOpen && 'lg:hidden')}
                onClick={() => (isMobile || window.innerWidth < 1024 ? setSheetOpen(true) : setRailOpen(true))}
                aria-label="Open filters"
              >
                <SlidersHorizontal />Filters{nFilters > 0 && <Badge tone="primary" size="sm">{nFilters}</Badge>}
              </Button>
              {!isMobile && railOpen && (
                <Tooltip content="Hide filters">
                  <Button variant="ghost" size="icon" className="hidden h-10 lg:inline-flex" onClick={() => setRailOpen(false)} aria-label="Hide filters"><SlidersHorizontal /></Button>
                </Tooltip>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground" aria-live="polite">
                {feed.isLoading ? <span className="h-4 w-24 animate-pulse rounded bg-muted" /> : (
                  <span><span className="font-semibold text-foreground tabular">{formatNumberIN(total)}</span> {total === 1 ? 'tender' : 'tenders'}</span>
                )}
                {feed.isFetching && !feed.isLoading && !feed.isFetchingNextPage && <Loader2 className="size-3.5 animate-spin" aria-label="Updating" />}
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2">
                  <Switch id="matched-only" checked={filters.matched} onCheckedChange={(v) => update({ matched: v, unseen: v ? filters.unseen : false })} />
                  <Label htmlFor="matched-only" className="cursor-pointer whitespace-nowrap text-[13px] font-medium">Matched only</Label>
                </div>
                <Select
                  value={filters.sort}
                  onValueChange={(v) => update({ sort: v as FeedFilters['sort'] })}
                  options={SORT_OPTIONS}
                  aria-label="Sort tenders"
                  className="h-8 w-[10.5rem] text-[13px]"
                />
                {!isMobile && (
                  <Segmented
                    size="sm"
                    aria-label="Layout"
                    value={layout}
                    onChange={setLayout}
                    options={[{ value: 'cards', label: <LayoutGrid className="size-3.5" aria-label="Cards" /> }, { value: 'table', label: <Rows3 className="size-3.5" aria-label="Table" /> }]}
                  />
                )}
              </div>
            </div>
            <div className="mt-2 empty:hidden"><ActiveChips f={filters} onChange={update} /></div>
          </div>

          {/* Results */}
          {feed.isLoading ? (
            <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading tenders">
              {Array.from({ length: 5 }, (_, i) => <TenderCardSkeleton key={i} />)}
            </div>
          ) : feed.isError ? (
            <ErrorState error={feed.error} onRetry={() => feed.refetch()} retrying={feed.isRefetching} />
          ) : items.length === 0 ? (
            filters.matched && !hasWatchlists && !watchlists.isLoading ? (
              <EmptyState
                icon={Radar}
                title="Tell us what you sell"
                body="Create a watchlist with your products, HSN codes, states and buyers. Matching GeM bids land here — and on WhatsApp or email — the moment they’re published."
                action={can('analyst') ? <Button asChild><Link to="/watchlists?new=1"><BellPlus />Create a watchlist</Link></Button> : undefined}
                secondaryAction={<Button variant="ghost" onClick={() => update({ matched: false, unseen: false })}>Browse all open bids</Button>}
              />
            ) : total === 0 && isPristine(filters) ? (
              <EmptyState
                icon={FileStack}
                title="No tenders yet"
                body="TenderPilot hasn’t synced with GeM BidPlus yet. The first sync runs automatically within 30 minutes."
                action={can('bid_manager') ? <Button onClick={() => sync.mutate()} loading={sync.isPending}>{!sync.isPending && <RefreshCw />}Sync with GeM now</Button> : undefined}
              />
            ) : (
              <EmptyState
                icon={Search}
                title={filters.unseen ? 'You’re all caught up' : 'No tenders match these filters'}
                body={filters.unseen
                  ? 'Every new match has been reviewed. We’ll alert you as soon as GeM publishes another one.'
                  : 'Try widening the closing window, removing a state, or saving this search as a watchlist to get alerted when a matching bid is published.'}
                action={!filters.unseen ? <Button variant="secondary" onClick={() => setParams(filtersToParams({ ...DEFAULT_FILTERS }), { replace: true })}>Clear filters</Button> : undefined}
                secondaryAction={!filters.unseen && can('analyst') ? <Button variant="ghost" onClick={saveAsWatchlist}><BellPlus />Alert me when one appears</Button> : undefined}
              />
            )
          ) : (
            <>
              {showTable ? <TenderTable items={items} /> : (
                <ul className="flex flex-col gap-3" aria-label="Tenders">
                  {items.map((t) => <li key={t.id} className="min-w-0"><TenderCard t={t} /></li>)}
                </ul>
              )}
              <div ref={sentinel} className="flex flex-col items-center gap-2 py-6">
                {feed.hasNextPage ? (
                  <Button variant="secondary" onClick={() => feed.fetchNextPage()} loading={feed.isFetchingNextPage}>
                    Load more <span className="text-muted-foreground">({formatNumberIN(total - items.length)} left)</span>
                  </Button>
                ) : items.length > 8 ? (
                  <p className="text-xs text-muted-foreground">That’s all {pluralize(total, 'tender')}.</p>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Mobile / tablet filters */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className={cn(isMobile && 'h-[88dvh]')}>
          <SheetHeader><SheetTitle>Filters</SheetTitle></SheetHeader>
          <SheetBody>{rail}</SheetBody>
          <SheetFooter>
            <Button block onClick={() => setSheetOpen(false)}>Show {formatNumberIN(total)} {total === 1 ? 'tender' : 'tenders'}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
