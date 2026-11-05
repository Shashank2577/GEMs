/**
 * Settings → Plan & usage (`/settings/usage`, spec 008 FR-041c, US5 scenario 9, NFR-011). Read-only for every role.
 * Plan badge, trial line, six meters (`role="progressbar"`; amber ≥ 80 %, red at 100 %; "Unlimited" is plain text, no bar),
 * the IST reset date and "Talk to sales". One meter per row on phones, 2 columns ≥ 1024 px, 3 ≥ 1280 px.
 */
import { Crown, Mail, Sparkles } from 'lucide-react';
import { Badge, Button, ErrorState, Skeleton } from '@/components/ui';
import { useNow } from '@/lib/hooks';
import { METER_ORDER, SALES_MAILTO, meter, planBadge, resetLine, trialLine, type Meter } from '@/lib/plan-limit';
import { cn } from '@/lib/utils';
import { USAGE_FIELD } from '@tp/core/contracts/plans';
import { useOrgUsage } from '../api';
import { Panel } from './Panel';

const GRID = 'grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3';

const BAR: Record<Meter['tone'], string> = {
  ok: 'bg-primary',
  warning: 'bg-warning',
  danger: 'bg-danger',
  unlimited: 'bg-transparent',
};
const TEXT: Record<Meter['tone'], string> = {
  ok: 'text-foreground',
  warning: 'text-[hsl(32_90%_32%)] dark:text-warning',
  danger: 'text-danger',
  unlimited: 'text-foreground',
};

function MeterCard({ m }: { m: Meter }) {
  const id = `meter-${m.key}`;
  return (
    <div className="rounded-xl border bg-card p-4 shadow-xs" data-testid={id} data-tone={m.tone}>
      <div className="flex items-baseline justify-between gap-3">
        <span id={`${id}-label`} className="text-[13px] font-medium text-muted-foreground">{m.label}</span>
        <span className={cn('text-sm font-semibold tabular-nums', TEXT[m.tone])}>{m.text}</span>
      </div>
      {m.max == null ? (
        // No cap: plain text, not a progressbar with a value and no maximum (review N5).
        <div className="mt-3 h-2 w-full" aria-hidden="true" />
      ) : (
        <div
          role="progressbar"
          aria-labelledby={`${id}-label`}
          aria-valuemin={0}
          aria-valuemax={m.max}
          aria-valuenow={Math.min(m.used, m.max)}
          aria-valuetext={m.text}
          className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div className={cn('h-full rounded-full transition-[width] duration-500', BAR[m.tone])} style={{ width: `${m.pct}%` }} />
        </div>
      )}
    </div>
  );
}

function LoadingMeters() {
  return (
    <div className={GRID} aria-busy="true" aria-label="Loading usage">
      {METER_ORDER.map((k) => (
        <div key={k} className="rounded-xl border bg-card p-4 shadow-xs">
          <div className="flex justify-between gap-3"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-14" /></div>
          <Skeleton className="mt-3 h-2 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

export default function UsageSection() {
  const q = useOrgUsage();
  const now = useNow(60_000);

  if (q.isError) return <ErrorState title="We couldn’t load your plan and usage" error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />;

  const data = q.data;
  const badge = data ? planBadge(data.plan) : null;
  const meters = data ? METER_ORDER.map((k) => meter(k, data.usage[USAGE_FIELD[k]], data.limits[k])) : [];

  return (
    <Panel
      title="Plan & usage"
      description="What your plan includes and how much of it your team has used this month."
      aside={badge && (
        <Badge tone={badge.tone} size="lg" data-testid="plan-badge">
          {data!.plan === 'enterprise' ? <Crown /> : <Sparkles />}{badge.label}
        </Badge>
      )}
      footer={
        <>
          {data && <p className="mr-auto text-[13px] text-muted-foreground" data-testid="usage-reset">{resetLine(data.period.end)}</p>}
          <Button variant="secondary" asChild><a href={SALES_MAILTO}><Mail /> Talk to sales</a></Button>
        </>
      }
    >
      {data?.plan === 'trial' && data.trialEndsAt && (
        <p className={cn('mb-4 text-sm font-medium', new Date(data.trialEndsAt) < now ? 'text-danger' : 'text-foreground')} data-testid="trial-line">
          {trialLine(data.trialEndsAt, now)}
        </p>
      )}
      {!data ? <LoadingMeters /> : (
        <div className={GRID}>
          {meters.map((m) => <MeterCard key={m.key} m={m} />)}
        </div>
      )}
    </Panel>
  );
}
