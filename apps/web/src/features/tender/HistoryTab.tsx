import { useMemo } from 'react';
import { AlertTriangle, CircleDot, FilePlus2, Gauge, History, Lock, RefreshCw, Trophy, UserRoundPen, XCircle, type LucideIcon } from 'lucide-react';
import type { TenderEventDto } from '@tp/core/contracts/identify';
import type { ActivityItem } from '@tp/core/contracts/auth';
import { Badge, Card, CardContent, EmptyState, ErrorState, SkeletonList, Tooltip } from '@/components/ui';
import { formatDateIST, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTenderActivity } from './api';
import { ACTIVITY_LABEL, CHANGE_LABEL, formatChangeValue } from './labels';

type Entry =
  | { kind: 'event'; at: string; e: TenderEventDto }
  | { kind: 'activity'; at: string; a: ActivityItem };

const EVENT_META: Record<TenderEventDto['kind'], { label: string; icon: LucideIcon; cls: string }> = {
  created: { label: 'Published on GeM', icon: CircleDot, cls: 'bg-primary-soft text-primary' },
  updated: { label: 'Listing updated', icon: RefreshCw, cls: 'bg-muted text-muted-foreground' },
  corrigendum: { label: 'Corrigendum issued', icon: AlertTriangle, cls: 'bg-warning-soft text-[hsl(32_90%_36%)] dark:text-warning' },
  closed: { label: 'Bid closed', icon: Lock, cls: 'bg-muted text-muted-foreground' },
  cancelled: { label: 'Bid cancelled', icon: XCircle, cls: 'bg-danger-soft text-danger' },
  awarded: { label: 'Awarded on GeM', icon: Trophy, cls: 'bg-primary-soft text-primary' }, // 003/US6 results refresh
};

function activityIcon(action: string): LucideIcon {
  if (action === 'tender.analysed' || action === 'analysis.rescored') return Gauge;
  if (action === 'analysis.factor_overridden') return UserRoundPen;
  if (action.startsWith('tender.document')) return FilePlus2;
  return History;
}

/** Tender timeline: GeM events (corrigenda highlighted) merged with your team's activity on it. */
export function HistoryTab({ tenderId, events }: { tenderId: string; events: TenderEventDto[] }) {
  const activity = useTenderActivity(tenderId, true);
  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = events.map((e) => ({ kind: 'event', at: e.createdAt, e }));
    for (const a of activity.data?.items ?? []) list.push({ kind: 'activity', at: a.createdAt, a });
    return list.sort((x, y) => y.at.localeCompare(x.at));
  }, [events, activity.data]);

  if (activity.isLoading && !events.length) return <SkeletonList rows={4} />;
  if (activity.isError && !events.length) return <ErrorState error={activity.error} onRetry={() => activity.refetch()} />;
  if (!entries.length) return <EmptyState icon={History} title="No history yet" body="Corrigenda, date changes and your team’s actions on this tender appear here." />;

  return (
    <Card>
      <CardContent className="p-5 sm:p-6">
        <ol className="relative grid gap-6 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-border">
          {entries.map((x) => x.kind === 'event' ? <EventItem key={`e-${x.e.id}`} e={x.e} /> : <ActivityEntry key={`a-${x.a.id}`} a={x.a} />)}
        </ol>
      </CardContent>
    </Card>
  );
}

function When({ at }: { at: string }) {
  return <Tooltip content={formatDateIST(at, { time: true })}><time dateTime={at} className="text-xs text-muted-foreground">{relativeTime(at)}</time></Tooltip>;
}

function EventItem({ e }: { e: TenderEventDto }) {
  const m = EVENT_META[e.kind] ?? EVENT_META.updated;
  const changes = Object.entries(e.changes ?? {});
  return (
    <li className="relative flex gap-4">
      <span className={cn('relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-card', m.cls)}><m.icon className="size-4" aria-hidden /></span>
      <div className={cn('min-w-0 flex-1', e.kind === 'corrigendum' && 'rounded-xl border border-warning/30 bg-warning-soft/40 p-3')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{m.label}</span>
          {e.kind === 'corrigendum' && <Badge tone="warning" size="sm">Re-check eligibility</Badge>}
          <When at={e.createdAt} />
        </div>
        {changes.length > 0 && (
          <dl className="mt-2 grid gap-1 text-sm">
            {changes.map(([k, v]) => (
              <div key={k} className="flex flex-wrap items-baseline gap-x-2">
                <dt className="text-muted-foreground">{CHANGE_LABEL[k] ?? k}:</dt>
                <dd className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="text-muted-foreground line-through decoration-muted-foreground/50">{formatChangeValue(k, v.from)}</span>
                  <span aria-hidden>→</span>
                  <span className="font-medium">{formatChangeValue(k, v.to)}</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  );
}

function ActivityEntry({ a }: { a: ActivityItem }) {
  const Icon = activityIcon(a.action);
  const meta = a.meta as Record<string, unknown>;
  let extra: string | null = null;
  if (a.action === 'tender.analysed' && meta.score != null) extra = `Score ${meta.score}/100 · ${meta.verdict === 'go' ? 'Go' : meta.verdict === 'review' ? 'Review' : 'No-Go'}${meta.method === 'rules+llm' ? ' · AI-assisted' : ''}`;
  if (a.action === 'analysis.rescored' && meta.score != null) extra = `Score ${meta.from != null && meta.from !== meta.score ? `${meta.from} → ` : ''}${meta.score}/100 · ${meta.verdict === 'go' ? 'Go' : meta.verdict === 'review' ? 'Review' : 'No-Go'}`;
  if (a.action === 'analysis.factor_overridden') extra = `${String(meta.label ?? meta.factorKey)}: ${String(meta.from)} → ${String(meta.to)} — “${String(meta.reason ?? '')}”`;
  if (a.action.startsWith('tender.document') && meta.fileName) extra = `${String(meta.fileName)}${meta.pages ? ` · ${meta.pages} pages` : ''}`;
  return (
    <li className="relative flex gap-4">
      <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-card text-muted-foreground ring-4 ring-card border"><Icon className="size-4" aria-hidden /></span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-center gap-x-2 text-sm">
          <span><span className="font-medium">{a.user?.name ?? 'TenderPilot'}</span> <span className="text-muted-foreground">{ACTIVITY_LABEL[a.action] ?? a.action.replace(/[._]/g, ' ')}</span></span>
          <When at={a.createdAt} />
        </div>
        {extra && <p className="mt-0.5 text-sm text-muted-foreground">{extra}</p>}
      </div>
    </li>
  );
}
