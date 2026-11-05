import { CheckCircle2, CircleAlert, CloudOff, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { IngestionRunDto } from '@tp/core/contracts/identify';
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, Skeleton } from '@/components/ui';
import { RoleGate } from '@/lib/auth';
import { formatNumberIN, formatTimeIST, formatDateIST, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { useIngestionRuns, useSyncNow } from './api';
import { nextManualSyncAt } from './cooldown';

type Health = 'ok' | 'stale' | 'error' | 'never';

function healthOf(lastSuccessAt: string | null, lastRun: IngestionRunDto | null, now: Date): Health {
  if (!lastRun && !lastSuccessAt) return 'never';
  if (lastRun?.status === 'failed') return 'error';
  if (!lastSuccessAt || now.getTime() - Date.parse(lastSuccessAt) > 2 * 3_600_000) return 'stale';
  return 'ok';
}

const dot: Record<Health, string> = { ok: 'bg-success', stale: 'bg-warning', error: 'bg-danger', never: 'bg-muted-foreground' };

const statusTone = { success: 'success', partial: 'warning', failed: 'danger', running: 'info' } as const;

/** "Synced 4 min ago · 1,243 open bids" pill with recent-run details and Sync now for managers (FR-007). */
export function SyncHealth({ className }: { className?: string }) {
  const now = useNow(5_000);
  const runs = useIngestionRuns();
  const sync = useSyncNow();
  if (runs.isLoading) return <Skeleton className={cn('h-8 w-52 rounded-full', className)} />;
  if (runs.isError || !runs.data) return null;
  const { lastSuccessAt, lastRun, openTenders, items } = runs.data;
  const health = healthOf(lastSuccessAt, lastRun, now);
  const cooldownUntil = nextManualSyncAt(items, now);
  const cooldownText = cooldownUntil ? `Next manual sync at ${formatTimeIST(cooldownUntil)} IST` : null;
  const label = sync.isPending
    ? 'Syncing with GeM…'
    : health === 'never' ? 'Not synced yet'
      : lastSuccessAt ? `Synced ${relativeTime(lastSuccessAt, now)}` : 'Sync failing';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn('inline-flex h-8 items-center gap-2 rounded-full border bg-card px-3 text-xs font-medium text-muted-foreground shadow-xs transition-colors hover:text-foreground focus-ring', className)}
          aria-label={`GeM sync status: ${label}`}
        >
          {sync.isPending ? <Loader2 className="size-3.5 animate-spin text-primary" /> : (
            <span className="relative flex size-2">
              {health === 'ok' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/60 [animation-duration:2.5s]" />}
              <span className={cn('relative inline-flex size-2 rounded-full', dot[health])} />
            </span>
          )}
          <span className="text-foreground/90">{label}</span>
          <span className="hidden sm:inline">· {formatNumberIN(openTenders)} open bids</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,22rem)] p-0">
        <div className="border-b p-4">
          <div className="flex items-center gap-2">
            {health === 'ok' ? <CheckCircle2 className="size-4 text-success" /> : health === 'error' ? <CloudOff className="size-4 text-danger" /> : <CircleAlert className="size-4 text-warning" />}
            <p className="text-sm font-semibold">
              {health === 'ok' ? 'GeM sync is healthy' : health === 'error' ? 'Last sync failed' : health === 'never' ? 'Waiting for the first sync' : 'Sync is overdue'}
            </p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {health === 'error' && lastRun?.error ? lastRun.error : 'New BidPlus tenders are fetched automatically every 30 minutes and matched to your watchlists.'}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-subtle p-2"><p className="text-muted-foreground">Open bids tracked</p><p className="text-sm font-semibold tabular">{formatNumberIN(openTenders)}</p></div>
            <div className="rounded-lg bg-subtle p-2"><p className="text-muted-foreground">Last success</p><p className="text-sm font-semibold">{lastSuccessAt ? `${formatTimeIST(lastSuccessAt)} IST` : '—'}</p></div>
          </div>
        </div>
        <ul className="max-h-56 divide-y overflow-y-auto scrollbar-thin" aria-label="Recent syncs">
          {items.slice(0, 6).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
              <div className="min-w-0">
                <p className="font-medium">{formatDateIST(r.startedAt, { time: true })} <span className="font-normal text-muted-foreground">· {r.trigger === 'manual' ? 'Manual' : 'Scheduled'}</span></p>
                <p className="truncate text-muted-foreground">
                  {r.status === 'failed' ? r.error ?? 'Failed' : `${r.tendersCreated} new · ${r.tendersUpdated} updated · ${r.matchesCreated} matches`}
                </p>
              </div>
              <Badge size="sm" tone={statusTone[r.status]}>{r.status}</Badge>
            </li>
          ))}
          {!items.length && <li className="px-4 py-6 text-center text-xs text-muted-foreground">No syncs yet.</li>}
        </ul>
        <div className="flex items-center justify-between gap-2 border-t bg-subtle/60 px-4 py-3">
          <p className="flex items-center gap-1.5 text-2xs text-muted-foreground"><ShieldCheck className="size-3.5" />Public listings only · ≤ 1 request/sec</p>
          <RoleGate min="bid_manager">
            {/* Disabled buttons swallow hover, so the tooltip lives on a wrapper; the hint is also announced. */}
            <span title={cooldownText ?? undefined} className="inline-flex">
              <Button
                size="xs"
                onClick={() => sync.mutate()}
                loading={sync.isPending}
                disabled={!!cooldownUntil && !sync.isPending}
                aria-describedby={cooldownText ? 'sync-cooldown-hint' : undefined}
              >
                {!sync.isPending && <RefreshCw />}Sync now
              </Button>
            </span>
          </RoleGate>
        </div>
        {cooldownText && (
          <RoleGate min="bid_manager">
            <p id="sync-cooldown-hint" role="status" className="border-t bg-subtle/60 px-4 pb-3 pt-2 text-right text-2xs text-muted-foreground">
              {cooldownText} — we keep manual syncs 2 minutes apart to stay polite to GeM.
            </p>
          </RoleGate>
        )}
      </PopoverContent>
    </Popover>
  );
}
