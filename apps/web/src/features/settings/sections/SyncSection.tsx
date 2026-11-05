import { CheckCircle2, CircleAlert, CloudOff, RefreshCw, ShieldCheck } from 'lucide-react';
import type { IngestionRunDto } from '@tp/core/contracts/identify';
import { Badge, Button, EmptyState, ErrorState, ResponsiveTable, SkeletonList, StatTile, toast, type Column } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { RoleGate } from '@/lib/auth';
import { formatDateIST, formatNumberIN, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { useRunIngestion, useRuns } from '../api';
import { Panel } from './Panel';

const statusTone = { success: 'success', partial: 'warning', failed: 'danger', running: 'info' } as const;
const statusLabel = { success: 'Success', partial: 'Partial', failed: 'Failed', running: 'Running' } as const;
const duration = (ms: number | null) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

export default function SyncSection() {
  const now = useNow(30_000);
  const q = useRuns();
  const run = useRunIngestion();
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <SkeletonList rows={5} />;
  const { items, lastSuccessAt, lastRun, openTenders, totalTenders } = q.data;
  const stale = !lastSuccessAt || now.getTime() - Date.parse(lastSuccessAt) > 2 * 3_600_000;
  const health = !lastRun ? 'never' : lastRun.status === 'failed' ? 'error' : stale ? 'stale' : 'ok';

  const columns: Column<IngestionRunDto>[] = [
    { key: 'when', header: 'Started', primary: true, cell: (r) => <span><span className="font-medium">{formatDateIST(r.startedAt, { time: true })}</span> <span className="text-xs text-muted-foreground">({relativeTime(r.startedAt, now)})</span></span> },
    { key: 'status', header: 'Status', cell: (r) => <Badge tone={statusTone[r.status]} size="sm" dot>{statusLabel[r.status]}</Badge> },
    { key: 'trigger', header: 'Trigger', cell: (r) => <span className="capitalize text-muted-foreground">{r.trigger}</span> },
    { key: 'pages', header: 'Pages', className: 'text-right', cell: (r) => <span className="tabular">{r.pagesFetched}</span> },
    { key: 'new', header: 'New / updated', className: 'text-right', cell: (r) => <span className="tabular">{r.tendersCreated} / {r.tendersUpdated}</span> },
    { key: 'matches', header: 'Matches', className: 'text-right', cell: (r) => <span className="tabular">{r.matchesCreated}</span> },
    { key: 'dur', header: 'Duration', hideOnMobile: true, className: 'text-right', cell: (r) => <span className="tabular text-muted-foreground">{duration(r.durationMs)}</span> },
  ];

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile label="Sync status" icon={health === 'ok' ? CheckCircle2 : health === 'never' ? CloudOff : CircleAlert}
          tone={health === 'ok' ? 'success' : health === 'error' ? 'danger' : 'warning'}
          value={health === 'ok' ? 'Healthy' : health === 'error' ? 'Last run failed' : health === 'stale' ? 'Delayed' : 'Not synced yet'}
          hint={lastSuccessAt ? `Last success ${relativeTime(lastSuccessAt, now)}` : 'Waiting for the first run'} />
        <StatTile label="Open GeM bids" icon={ShieldCheck} tone="primary" value={formatNumberIN(openTenders)} hint={`${formatNumberIN(totalTenders)} tracked in total`} />
        <StatTile label="Last run" icon={RefreshCw} tone="info" className="col-span-2 md:col-span-1"
          value={lastRun ? `${lastRun.tendersCreated} new` : '—'} hint={lastRun ? `${lastRun.tendersUpdated} updated · ${lastRun.matchesCreated} matches` : 'No runs yet'} />
      </div>
      <Panel title="Ingestion runs" description="TenderPilot reads public BidPlus listings every 30 minutes, politely rate-limited. It never logs in to GeM on your behalf."
        aside={
          <RoleGate min="bid_manager">
            <Button variant="secondary" loading={run.isPending}
              onClick={() => run.mutate(undefined, { onSuccess: () => toast.success('Sync finished'), onError: (e) => toast.error(errorMessage(e)) })}>
              {!run.isPending && <RefreshCw />} Sync now
            </Button>
          </RoleGate>
        }>
        {lastRun?.status === 'failed' && lastRun.error && (
          <p className="mb-4 rounded-lg border border-danger/25 bg-danger-soft/60 p-3 text-[13px]"><strong>Last error:</strong> {lastRun.error}</p>
        )}
        <ResponsiveTable columns={columns} rows={items} rowKey={(r) => r.id}
          empty={<EmptyState compact icon={CloudOff} title="No sync runs yet" body="The first scheduled run fetches the latest GeM bids and matches them to your watchlists." />} />
      </Panel>
    </div>
  );
}
