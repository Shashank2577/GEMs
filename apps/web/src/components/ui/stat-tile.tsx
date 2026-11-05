import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Skeleton } from './skeleton';

export function StatTile({
  label, value, delta, deltaLabel, icon: Icon, hint, sparkline, to, loading, tone = 'primary', className, invertDelta,
}: {
  label: ReactNode; value: ReactNode; delta?: number | null; deltaLabel?: ReactNode; icon?: LucideIcon; hint?: ReactNode;
  sparkline?: ReactNode; to?: string; loading?: boolean; tone?: 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
  className?: string; /** true when a decrease is good (e.g. expiring docs) */ invertDelta?: boolean;
}) {
  const toneCls = {
    primary: 'bg-primary-soft text-primary', accent: 'bg-accent-soft text-accent', success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning', danger: 'bg-danger-soft text-danger', info: 'bg-info-soft text-info',
  }[tone];
  const good = delta !== undefined && delta !== null && (invertDelta ? delta < 0 : delta > 0);
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        {Icon && <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', toneCls)}><Icon className="size-4" aria-hidden /></span>}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-24" />
      ) : (
        <div className="mt-1 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="tabular truncate text-2xl font-semibold tracking-tight">{value}</div>
            {(delta !== undefined && delta !== null) || hint ? (
              <div className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                {delta !== undefined && delta !== null && (
                  <span className={cn('inline-flex items-center gap-0.5 font-medium', delta === 0 ? 'text-muted-foreground' : good ? 'text-success' : 'text-danger')}>
                    {delta > 0 ? <ArrowUpRight className="size-3.5" /> : delta < 0 ? <ArrowDownRight className="size-3.5" /> : null}
                    {Math.abs(delta)}%
                  </span>
                )}
                {deltaLabel ?? hint}
              </div>
            ) : null}
          </div>
          {sparkline && <div className="hidden h-9 w-24 shrink-0 sm:block">{sparkline}</div>}
        </div>
      )}
    </>
  );
  const cls = cn('block rounded-xl border bg-card p-4 shadow-xs sm:p-5', to && 'transition-[box-shadow,border-color] hover:border-foreground/15 hover:shadow-md focus-ring', className);
  return to ? <Link to={to} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

/** Tiny dependency-free sparkline (SVG). */
export function Sparkline({ data, className, color = 'hsl(var(--primary))' }: { data: number[]; className?: string; color?: string }) {
  if (data.length < 2) return null;
  const w = 96, h = 40, p = 2;
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [p + (i * (w - 2 * p)) / (data.length - 1), h - p - ((v - min) / range) * (h - 2 * p)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0]},${h} L${pts[0][0]},${h} Z`;
  const id = `spark-${Math.abs(data.reduce((a, b) => a * 31 + b, 7)) % 100000}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn('h-full w-full overflow-visible', className)} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
