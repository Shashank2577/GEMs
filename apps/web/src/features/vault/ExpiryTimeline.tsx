/** "Next 90 days" expiry strip: a track from today to +90d with a marker per document. */
import { CalendarClock, CheckCircle2 } from 'lucide-react';
import type { VaultSummary } from '@tp/core/contracts/vault';
import { Card, Skeleton, Tooltip } from '@/components/ui';
import { formatDateIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DocTypeIcon, statusLabel } from './doc-ui';

const HORIZON = 90;

export function ExpiryTimeline({ summary, loading, onOpen }: { summary?: VaultSummary; loading?: boolean; onOpen: (id: string) => void }) {
  if (loading) return <Skeleton className="h-[150px] w-full rounded-xl" />;
  if (!summary || summary.total === 0) return null;
  const items = summary.nextExpiries;
  const expired = items.filter((i) => i.daysToExpiry < 0);
  const upcoming = items.filter((i) => i.daysToExpiry >= 0);
  // Stack markers that land close together.
  const lanes: number[] = [];
  const placed = upcoming.map((i) => {
    const pct = Math.min(100, (i.daysToExpiry / HORIZON) * 100);
    let lane = lanes.findIndex((end) => pct - end > 7);
    if (lane === -1) { lane = lanes.length; lanes.push(pct); } else lanes[lane] = pct;
    return { ...i, pct, lane: Math.min(lane, 2) };
  });
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarClock className="size-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold tracking-tight">Expiring in the next 90 days</h2>
        </div>
        <p className="text-xs text-muted-foreground">Reminders go out 30, 7 and 1 day before expiry</p>
      </div>
      {items.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg bg-success-soft/60 px-3 py-3 text-sm text-success">
          <CheckCircle2 className="size-4" aria-hidden />Nothing expires in the next 90 days. You’re bid-ready.
        </div>
      ) : (
        <>
          {/* Desktop / tablet: track */}
          <div className="hidden sm:block">
            <div className="relative ml-[4.5rem] h-[100px]">
              <div className="absolute inset-x-0 top-[72px] h-1.5 rounded-full bg-gradient-to-r from-danger/40 via-warning/40 via-[33%] to-success/30" aria-hidden />
              {[0, 30, 60, 90].map((d) => (
                <div key={d} className="absolute top-[82px] -translate-x-1/2 whitespace-nowrap text-2xs text-muted-foreground" style={{ left: `${(d / HORIZON) * 100}%` }}>
                  {d === 0 ? 'Today' : `${d}d`}
                </div>
              ))}
              {placed.length === 0 && <p className="absolute inset-x-0 top-[44px] text-center text-xs text-muted-foreground">Nothing else expires in the next 90 days</p>}
              {placed.map((i) => (
                <Tooltip key={i.id} content={<span><strong>{i.title}</strong><br />{statusLabel(i.status, i.daysToExpiry)} · {formatDateIST(i.expiryDate)}</span>}>
                  <button
                    type="button" onClick={() => onOpen(i.id)} aria-label={`${i.title}, ${statusLabel(i.status, i.daysToExpiry)}`}
                    className="absolute -translate-x-1/2 rounded-lg transition-transform hover:z-10 hover:scale-110 focus-ring"
                    style={{ left: `${i.pct}%`, top: `${40 - i.lane * 20}px` }}
                  >
                    <span className={cn('flex rounded-lg ring-2 ring-card', i.daysToExpiry <= 7 && 'shadow-[0_0_0_4px_hsl(var(--danger)/0.15)]')}>
                      <DocTypeIcon type={i.type} size="sm" />
                    </span>
                  </button>
                </Tooltip>
              ))}
              <div className="absolute -left-[4.5rem] top-0 flex w-16 flex-col items-start gap-1">
                <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Expired</span>
                {expired.length ? (
                  <button type="button" onClick={() => onOpen(expired[0]!.id)} className="rounded-md bg-danger-soft px-2 py-1 text-xs font-semibold text-danger hover:bg-danger/15 focus-ring">
                    {expired.length} doc{expired.length === 1 ? '' : 's'}
                  </button>
                ) : <span className="text-xs text-muted-foreground">None</span>}
              </div>
            </div>
          </div>
          {/* Phone: compact list */}
          <ul className="grid gap-1.5 sm:hidden">
            {items.slice(0, 5).map((i) => (
              <li key={i.id}>
                <button type="button" onClick={() => onOpen(i.id)} className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1.5 text-left hover:bg-muted focus-ring">
                  <DocTypeIcon type={i.type} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm">{i.title}</span>
                  <span className={cn('shrink-0 text-xs font-medium tabular', i.status === 'expired' ? 'text-danger' : i.daysToExpiry <= 7 ? 'text-danger' : i.status === 'expiring' ? 'text-warning' : 'text-muted-foreground')}>
                    {i.daysToExpiry < 0 ? 'Expired' : i.daysToExpiry === 0 ? 'Today' : `${i.daysToExpiry}d`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
