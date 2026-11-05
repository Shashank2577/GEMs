/**
 * "Awaiting your decision" (T061; 007/FR-072, US5) — analysed bids that need a Go / No-Go call. bid_manager+ get one-tap
 * "Go" (one tap, no dialog) and "Drop" (behind a confirmation) that reuse the pipeline's `useMoveCard()` PATCH; analysts see the same
 * list read-only; viewers never get the card (DashboardPage). Moving a card refreshes ['dashboard'], so it leaves the list.
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Gavel, X } from 'lucide-react';
import type { DecisionItem } from '@tp/core/contracts/experience';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Countdown, EmptyState, ScoreRing, Skeleton, VerdictBadge, toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useMoveCard } from '../pipeline/api';

export const DECISIONS_EMPTY = 'Nothing is waiting on a decision — analysed bids will appear here for a Go or Drop call.';

type Choice = 'go' | 'drop';
export const CHOICES: Record<Choice, { stage: 'go' | 'dropped'; label: string; title: string; confirm: string; done: string; tone: 'primary' | 'danger' }> = {
  go: { stage: 'go', label: 'Go', title: 'Move this bid to Go?', confirm: 'Go', done: 'Moved to Go', tone: 'primary' }, // one tap: title/confirm unused
  drop: { stage: 'dropped', label: 'Drop', title: 'Drop this bid?', confirm: 'Drop', done: 'Bid dropped', tone: 'danger' },
};

export function DecisionsCard({ items, className }: { items?: DecisionItem[]; className?: string }) {
  const { can } = useAuth();
  const canDecide = can('bid_manager');
  const move = useMoveCard();
  const [pending, setPending] = useState<{ item: DecisionItem; choice: Choice } | null>(null);
  const choice = pending ? CHOICES[pending.choice] : null;
  // Rows with a Go in flight: a ref guards against same-tick double taps, state drives the disabled UI.
  const inFlight = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const setRowBusy = (id: string, on: boolean) => {
    if (on) inFlight.current.add(id); else inFlight.current.delete(id);
    setBusy(new Set(inFlight.current));
  };
  const goNow = (workspaceId: string) => {
    if (inFlight.current.has(workspaceId)) return;
    setRowBusy(workspaceId, true);
    move.mutate({ id: workspaceId, stage: CHOICES.go.stage }, {
      onSuccess: () => toast.success(CHOICES.go.done),
      onError: (e) => toast.error(errorMessage(e)),
      onSettled: () => setRowBusy(workspaceId, false),
    });
  };

  return (
    <Card role="region" className={cn('flex flex-col', className)} aria-labelledby="decisions-title">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle id="decisions-title">Awaiting your decision</CardTitle>
          <CardDescription>{canDecide ? 'Analysed bids that need a Go or Drop call' : 'Analysed bids waiting on a Bid Manager'}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild><Link to="/pipeline">Pipeline <ArrowRight /></Link></Button>
      </CardHeader>
      <CardContent className="flex-1">
        {!items ? (
          <div className="grid gap-3" aria-hidden>{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : items.length === 0 ? (
          <EmptyState compact icon={Gavel} title="No decisions pending" body={DECISIONS_EMPTY} />
        ) : (
          <ul className="-mx-2 divide-y">
            {items.map((it) => (
              <li key={it.tenderId} className="flex flex-col gap-3 px-2 py-3 sm:flex-row sm:items-center">
                <Link to={it.workspaceId ? `/workspaces/${it.workspaceId}` : `/tenders/${it.tenderId}`}
                  className="-mx-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1 transition-colors hover:bg-muted/60 focus-ring">
                  <ScoreRing score={it.score} verdict={it.verdict ?? undefined} size={44} animate={false} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{it.title}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      {it.verdict && <VerdictBadge verdict={it.verdict} size="sm" showIcon={false} />}
                      <Countdown to={it.endAt} compact />
                    </span>
                  </span>
                </Link>
                {canDecide && it.workspaceId && (
                  <div className="flex shrink-0 gap-2">
                    <Button className="h-11 flex-1 sm:h-9 sm:flex-none" onClick={() => goNow(it.workspaceId!)} disabled={busy.has(it.workspaceId)} aria-label={`Go: ${it.title}`}><Check /> Go</Button>
                    <Button variant="secondary" className="h-11 flex-1 sm:h-9 sm:flex-none" onClick={() => setPending({ item: it, choice: 'drop' })} disabled={busy.has(it.workspaceId)} aria-label={`Drop: ${it.title}`}><X /> Drop</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={!!pending} onOpenChange={(o) => { if (!o && !move.isPending) setPending(null); }} loading={move.isPending}
        title={choice?.title ?? ''} description={pending ? <>{pending.item.title} <span className="font-mono text-xs">({pending.item.bidNumber})</span></> : undefined}
        confirmLabel={choice?.confirm} tone={choice?.tone}
        onConfirm={() => {
          if (!pending?.item.workspaceId || !choice) return;
          move.mutate({ id: pending.item.workspaceId, stage: choice.stage }, {
            onSuccess: () => { toast.success(choice.done); setPending(null); },
            onError: (e) => { toast.error(errorMessage(e)); setPending(null); },
          });
        }}
      />
    </Card>
  );
}
