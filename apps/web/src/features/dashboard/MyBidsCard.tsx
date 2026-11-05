/**
 * "My bids" (T060; 007/FR-071, US5) — the active bids the signed-in user owns or is assigned to, soonest due first.
 * Placement and role gating live in DashboardPage (analyst/bid_manager after the KPI tiles, owner below the first row,
 * never rendered for viewers). Data: `myWork` of GET /api/dashboard.
 */
import { Link } from 'react-router-dom';
import { ArrowRight, ClipboardList } from 'lucide-react';
import type { MyWorkItem } from '@tp/core/contracts/experience';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Progress, Skeleton, StageBadge } from '@/components/ui';
import { formatDateIST } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import type { Stage } from '@/lib/types';

export const MY_BIDS_EMPTY = 'Nothing assigned to you — bids you own or are assigned to will appear here.';

/** A bid is overdue once its due date has passed (it is still active, so the list only ever holds open bids). */
export const isOverdue = (dueAt: string | null, now: Date): boolean => !!dueAt && Date.parse(dueAt) < now.getTime();

export function MyBidsCard({ items, className }: { items?: MyWorkItem[]; className?: string }) {
  const now = useNow(60_000);
  return (
    <Card role="region" className={cn('flex flex-col', className)} aria-labelledby="my-bids-title">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle id="my-bids-title">My bids</CardTitle>
          <CardDescription>Bids you own or are assigned to, soonest due first</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild><Link to="/pipeline">Pipeline <ArrowRight /></Link></Button>
      </CardHeader>
      <CardContent className="flex-1">
        {!items ? (
          <div className="grid gap-3" aria-hidden>{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : items.length === 0 ? (
          <EmptyState compact icon={ClipboardList} title="No bids on your plate" body={MY_BIDS_EMPTY} />
        ) : (
          <ul className="-mx-2 divide-y">
            {items.map((w) => <MyBidRow key={w.workspaceId} w={w} now={now} />)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function MyBidRow({ w, now }: { w: MyWorkItem; now: Date }) {
  const overdue = isOverdue(w.dueAt, now);
  const { percent, blockers, analysed } = w.readiness;
  return (
    <li>
      <Link to={`/workspaces/${w.workspaceId}`} className="block rounded-lg px-2 py-3 transition-colors hover:bg-muted/60 focus-ring">
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{w.title}</span>
            <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{w.bidNumber}</span>
          </span>
          <StageBadge stage={w.stage as Stage} size="sm" className="shrink-0" />
        </span>
        <span className="mt-2 flex items-center gap-3">
          <span className="flex min-w-0 flex-1 items-center gap-2" title={analysed ? `${percent}% of the packet is ready` : 'Not analysed yet'}>
            <Progress value={analysed ? percent : 0} tone="auto" size="sm" aria-label={`Readiness: ${w.title}`} />
            <span className="tabular shrink-0 text-xs text-muted-foreground">
              {analysed ? `${percent}%${blockers ? ` · ${blockers} blocker${blockers === 1 ? '' : 's'}` : ''}` : 'Not analysed'}
            </span>
          </span>
          {w.dueAt ? (
            <span className={cn('tabular shrink-0 text-xs font-medium', overdue ? 'text-danger' : 'text-muted-foreground')} data-overdue={overdue || undefined}>
              Due {formatDateIST(w.dueAt)}
            </span>
          ) : <span className="shrink-0 text-xs text-muted-foreground">No due date</span>}
        </span>
      </Link>
    </li>
  );
}
