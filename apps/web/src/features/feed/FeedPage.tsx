/**
 * Tender feed — the hero screen (US1, FR-006): live GeM BidPlus bids with match reasons, filters rail,
 * saved views, cards/table, infinite pagination and sync health. Filters live in the URL so every
 * view is shareable (e.g. alert emails link to /tenders?matched=1).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  BellPlus, BookmarkPlus, FileStack, LayoutGrid, Loader2, MoreHorizontal, Pencil, Radar, RefreshCw, Rows3, Search, SlidersHorizontal, Trash2, X,
} from 'lucide-react';
import { SAVED_VIEW_LIMIT, SAVED_VIEW_NAME_MAX, type SavedViewDto, type TenderListResponse } from '@tp/core/contracts/identify';
import {
  Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, ErrorState, Input, Kbd, PageHeader, Segmented, Select, Sheet,
  SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle, Switch, Label, Tooltip, toast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { RoleGate, useAuth } from '@/lib/auth';
import { formatINR, formatNumberIN, pluralize } from '@/lib/format';
import { useIsMobile, useLocalStorage } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { useWatchlists } from '@/features/watchlists/api';
import { useCreateView, useDeleteView, useSavedViews, useSyncNow, useTenderFeed, useUpdateView } from './api';
import { asBidNumber, bidJumpTarget } from './bidJump';
import { FilterRail } from './FilterRail';
import {
  activeFilterCount, DEFAULT_FILTERS, filtersFromParams, filtersToCriteria, filtersToParams, filtersToViewParams, isPristine, sameFilters, SORT_OPTIONS,
  STATUS_OPTIONS, viewParamsToFilters, VIEWS, type FeedFilters,
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

/** Name dialog for "Save view" and "Rename". */
function ViewNameDialog({ open, onOpenChange, title, description, initial, submitLabel, busy, error, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; initial: string; submitLabel: string;
  busy: boolean; error: string | null; onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  useEffect(() => { if (open) setName(initial); }, [open, initial]);
  const trimmed = name.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form id="view-name-form" onSubmit={(e) => { e.preventDefault(); if (trimmed) onSubmit(trimmed); }} noValidate>
          <Label htmlFor="view-name">View name</Label>
          <Input
            id="view-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={SAVED_VIEW_NAME_MAX} autoFocus
            placeholder="e.g. Maharashtra laptops closing soon" className="mt-1.5"
            aria-invalid={!!error} aria-describedby="view-name-hint"
          />
          <p id="view-name-hint" className={cn('mt-1.5 text-xs', error ? 'text-danger' : 'text-muted-foreground')} role={error ? 'alert' : undefined}>
            {error ?? `${name.length}/${SAVED_VIEW_NAME_MAX} characters`}
          </p>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="view-name-form" loading={busy} disabled={!trimmed}>{submitLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
  if (f.status !== 'open') chips.push({ key: 'status', label: `Status: ${STATUS_OPTIONS.find((o) => o.value === f.status)?.label ?? f.status}`, clear: () => onChange({ status: 'open' }) });
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

  const savedViews = useSavedViews();
  const createView = useCreateView();
  const updateView = useUpdateView();
  const deleteView = useDeleteView();
  const [saveOpen, setSaveOpen] = useState(false);
  const [renaming, setRenaming] = useState<SavedViewDto | null>(null);
  const [deleting, setDeleting] = useState<SavedViewDto | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);

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
  const myViews = savedViews.data?.items ?? [];
  const activeMine = myViews.find((v) => sameFilters(viewParamsToFilters(v.params), filters));
  const activePersonal = activeMine?.id;
  const activeView = activePersonal ? undefined : VIEWS.find((v) => v.match(filters))?.key;
  // Keep the active personal tab visible inside the scrolling tab strip.
  useEffect(() => {
    if (activePersonal) document.querySelector(`[data-view-tab="${activePersonal}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activePersonal, myViews.length]);
  const viewLimit = savedViews.data?.limit ?? SAVED_VIEW_LIMIT;
  const atViewLimit = myViews.length >= viewLimit;

  const viewFailed = (e: unknown) => {
    const err = e as { code?: string; message?: string };
    setViewError(err.code === 'view_exists' ? 'You already have a view with that name.' : err.message ?? 'Could not save the view.');
  };
  const saveView = (name: string) => createView.mutate({ name, params: filtersToViewParams(filters) }, {
    onSuccess: () => { setSaveOpen(false); toast.success(`Saved view “${name}”`); },
    onError: viewFailed,
  });
  const renameView = (name: string) => renaming && updateView.mutate({ id: renaming.id, name }, {
    onSuccess: () => { setRenaming(null); toast.success('View renamed'); },
    onError: viewFailed,
  });
  const removeView = () => deleting && deleteView.mutate(deleting.id, {
    onSuccess: () => { setDeleting(null); toast.success(`Deleted view “${deleting.name}”`); },
    onError: (e) => { setDeleting(null); toast.error((e as Error).message); },
  });

  // Enter on an exact bid number opens that tender when exactly one exists (FR-037).
  const onSearchKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const bid = asBidNumber(q);
    if (!bid) return;
    e.preventDefault();
    try {
      const r = await api.get<TenderListResponse>('/tenders', { q: bid, status: 'all', includeDismissed: 1, pageSize: 5 });
      const target = bidJumpTarget(q, r.items);
      if (target) navigate(target);
    } catch { /* stay on the feed; the normal (debounced) search still runs */ }
  };
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

      {/* Views: built-in, then personal (FR-035) */}
      <div className="-mx-4 mb-4 flex items-center gap-3 px-4 sm:mx-0 sm:px-0">
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto pb-1 scrollbar-thin" role="tablist" aria-label="Saved views">
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
          {myViews.map((v) => {
            const on = activePersonal === v.id;
            return (
              <button
                key={v.id}
                role="tab"
                data-view-tab={v.id}
                title={v.name}
                aria-selected={on}
                onClick={() => setParams(filtersToParams(viewParamsToFilters(v.params)), { replace: true })}
                className={cn(
                  'h-8 max-w-[12rem] shrink-0 truncate rounded-full px-3.5 text-[13px] font-medium transition-colors focus-ring',
                  on ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {v.name}
              </button>
            );
          })}
        </div>
        {activeMine && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={`Options for view ${activeMine.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => { setViewError(null); setRenaming(activeMine); }}><Pencil />Rename</DropdownMenuItem>
              <DropdownMenuItem destructive onSelect={() => setDeleting(activeMine)}><Trash2 />Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Tooltip content={atViewLimit ? `You can save up to ${viewLimit} views — delete one first.` : 'Save the current search and filters as a tab'}>
          <span className="shrink-0">
            <Button variant="outline" size="sm" disabled={atViewLimit} onClick={() => { setViewError(null); setSaveOpen(true); }}>
              <BookmarkPlus />Save view
            </Button>
          </span>
        </Tooltip>
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
                  onKeyDown={onSearchKeyDown}
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

      <ViewNameDialog
        open={saveOpen} onOpenChange={setSaveOpen} title="Save view" initial=""
        description="Saves your current search, filters and sort as a personal tab. Only you can see it."
        submitLabel="Save view" busy={createView.isPending} error={viewError} onSubmit={saveView}
      />
      <ViewNameDialog
        open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)} title="Rename view" initial={renaming?.name ?? ''}
        description="Only the name changes; the filters stay as they are."
        submitLabel="Rename" busy={updateView.isPending} error={viewError} onSubmit={renameView}
      />
      <ConfirmDialog
        open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete “${deleting?.name ?? ''}”?`}
        description="The tab disappears for you. Tenders and watchlists are not affected."
        confirmLabel="Delete view" loading={deleteView.isPending} onConfirm={removeView}
      />

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
