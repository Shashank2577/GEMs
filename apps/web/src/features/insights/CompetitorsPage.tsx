/** Competitors (003/US6, FR-064): sellers winning the org's tracked awarded tenders, ranked by wins then awarded value. */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Swords, TriangleAlert } from 'lucide-react';
import type { CompetitorDto } from '@tp/core/contracts/identify';
import { Badge, Button, Card, EmptyState, ErrorState, Label, PageHeader, Select, Skeleton, StatTile } from '@/components/ui';
import { formatDateIST, formatINR, formatNumberIN } from '@/lib/format';
import { useCompetitors } from './api';
import { ALL, EMPTY_COPY, hasFilters, parseFilters, rangeLabel, rankOf, selectValue, toSearchParams, totalPages, type CompetitorFilters } from './competitors';

export default function CompetitorsPage() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const q = useCompetitors(filters);
  const set = (next: CompetitorFilters) => setParams(toSearchParams(next), { replace: true });
  const data = q.data;
  const pages = totalPages(data?.total ?? 0);

  return (
    <>
      <PageHeader
        title="Competitors"
        description="Sellers winning the tenders you track, from published GeM results. Ranked by wins, then awarded value."
      />

      {q.isLoading ? <PageSkeleton /> : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : data && (
        <div className="grid min-w-0 gap-5">
          {data.tenders === 0 && !hasFilters(filters) ? (
            <EmptyState icon={Swords} title={EMPTY_COPY} body="When GeM publishes the result of a tender you track, the winning sellers appear here." />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:max-w-xl">
                <StatTile label="Awarded tenders analysed" value={formatNumberIN(data.tenders)} />
                <StatTile label="Flagged: not lowest price" value={formatNumberIN(data.flaggedAwards)} />
              </div>

              <div className="grid gap-3 sm:grid-cols-2 md:max-w-xl" role="group" aria-label="Filters">
                <div className="grid gap-1.5">
                  <Label htmlFor="cmp-category">Category</Label>
                  <Select
                    id="cmp-category" value={selectValue(filters.category, data.facets.categories)}
                    onValueChange={(v) => set({ ...filters, category: v === ALL ? undefined : v, page: 1 })}
                    options={[{ value: ALL, label: 'All categories' }, ...data.facets.categories.map((c) => ({ value: c, label: c }))]}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="cmp-state">State</Label>
                  <Select
                    id="cmp-state" value={selectValue(filters.state, data.facets.states)}
                    onValueChange={(v) => set({ ...filters, state: v === ALL ? undefined : v, page: 1 })}
                    options={[{ value: ALL, label: 'All states' }, ...data.facets.states.map((s) => ({ value: s, label: s }))]}
                  />
                </div>
              </div>

              {data.items.length === 0 ? (
                <EmptyState
                  icon={Swords} title="No sellers match these filters" body="Try another category or state."
                  action={<Button variant="secondary" onClick={() => set({ page: 1 })}>Clear filters</Button>}
                />
              ) : (
                <>
                  <p className="text-sm text-muted-foreground" role="status" aria-live="polite">{rangeLabel(filters.page, data.items.length, data.total)}</p>
                  <div aria-busy={q.isFetching && q.isPlaceholderData} className={q.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
                    <CompetitorsTable items={data.items} page={filters.page} />
                  </div>
                  <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
                    <Button variant="secondary" size="sm" disabled={filters.page <= 1} onClick={() => set({ ...filters, page: filters.page - 1 })}>
                      <ChevronLeft /> Previous
                    </Button>
                    <span className="tabular text-sm text-muted-foreground">Page {filters.page} of {pages}</span>
                    <Button variant="secondary" size="sm" disabled={filters.page >= pages} onClick={() => set({ ...filters, page: filters.page + 1 })}>
                      Next <ChevronRight />
                    </Button>
                  </nav>
                </>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

function Flagged({ n }: { n: number }) {
  return n > 0
    ? <Badge tone="warning"><TriangleAlert /> {n}<span className="sr-only"> flagged {n === 1 ? 'award' : 'awards'}</span></Badge>
    : <span className="text-muted-foreground">0</span>;
}

function Cats({ c }: { c: string[] }) {
  return c.length ? <span className="break-words">{c.join(', ')}</span> : <span className="text-muted-foreground">—</span>;
}

function CompetitorsTable({ items, page }: { items: CompetitorDto[]; page: number }) {
  return (
    <>
      <div className="scrollbar-thin hidden overflow-x-auto rounded-xl border bg-card md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Competitor sellers ranked by wins, then awarded value</caption>
          <thead className="bg-subtle">
            <tr className="border-b text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="h-10 px-4">#</th>
              <th scope="col" className="h-10 px-4">Seller</th>
              <th scope="col" className="h-10 px-4 text-right">Wins</th>
              <th scope="col" className="h-10 px-4 text-right">Awarded value</th>
              <th scope="col" className="h-10 px-4 text-right">Bids</th>
              <th scope="col" className="h-10 px-4">Categories</th>
              <th scope="col" className="h-10 px-4">Flagged</th>
              <th scope="col" className="h-10 px-4">Last win</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c, i) => (
              <tr key={c.seller} className="border-b last:border-0">
                <td className="tabular px-4 py-3 text-muted-foreground">{rankOf(i, page)}</td>
                <th scope="row" className="px-4 py-3 text-left font-medium">{c.seller}</th>
                <td className="tabular px-4 py-3 text-right">{formatNumberIN(c.wins)}</td>
                <td className="tabular px-4 py-3 text-right">{formatINR(c.awardedValue)}</td>
                <td className="tabular px-4 py-3 text-right">{formatNumberIN(c.bids)}</td>
                <td className="max-w-xs px-4 py-3"><Cats c={c.categories} /></td>
                <td className="px-4 py-3"><Flagged n={c.anomalies} /></td>
                <td className="whitespace-nowrap px-4 py-3">{formatDateIST(c.lastWinAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="grid grid-cols-1 gap-2 md:hidden" aria-label="Competitor sellers ranked by wins, then awarded value">
        {items.map((c, i) => (
          <li key={c.seller} className="rounded-xl border bg-card p-4 shadow-xs">
            <div className="flex items-start gap-2">
              <span className="tabular text-sm text-muted-foreground">{rankOf(i, page)}.</span>
              <span className="min-w-0 flex-1 break-words font-medium">{c.seller}</span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Field label="Wins">{formatNumberIN(c.wins)}</Field>
              <Field label="Awarded value">{formatINR(c.awardedValue)}</Field>
              <Field label="Bids">{formatNumberIN(c.bids)}</Field>
              <Field label="Flagged"><Flagged n={c.anomalies} /></Field>
              <Field label="Categories" wide><Cats c={c.categories} /></Field>
              <Field label="Last win">{formatDateIST(c.lastWinAt)}</Field>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular mt-0.5">{children}</dd>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading competitors">
      <div className="grid grid-cols-2 gap-3 md:max-w-xl"><Skeleton className="h-20 rounded-xl" /><Skeleton className="h-20 rounded-xl" /></div>
      <Card className="grid gap-3 p-5">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</Card>
    </div>
  );
}
