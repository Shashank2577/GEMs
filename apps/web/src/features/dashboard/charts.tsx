/** Dashboard charts — themed with design tokens (hsl(var(--…))) so light/dark both work. */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useReducedMotion } from 'framer-motion';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardResponse, DashboardStage } from '@tp/core/contracts/experience';
import { formatINRCompact, formatNumberIN, pluralize } from '@/lib/format';
import { STAGE_LABEL, VERDICT_LABEL, type Verdict } from '@/lib/types';
import { cn } from '@/lib/utils';
import { verdictColor } from '@/components/ui';
import { donutSegments } from './donut';

const dayLabel = (iso: string, long = false) =>
  new Date(`${iso}T12:00:00+05:30`).toLocaleDateString('en-IN', long ? { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' } : { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length || !label) return null;
  const n = payload[0]!.value;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="text-muted-foreground">{dayLabel(label, true)}</div>
      <div className="mt-0.5 font-semibold text-foreground tabular">{pluralize(n, 'new match', 'new matches')}</div>
    </div>
  );
}

/** Single-series area chart: distinct matched tenders per IST day (last 14 days). */
export function MatchesTrend({ data }: { data: DashboardResponse['matchesByDay'] }) {
  const total = data.reduce((a, b) => a + b.count, 0);
  const reduce = useReducedMotion(); // FR-093: no chart motion when the user prefers reduced motion
  return (
    <div className="h-56 w-full" role="img" aria-label={`New matches over the last 14 days: ${total} in total`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="tp-matches-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.28} />
              <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 4" />
          <XAxis dataKey="date" tickFormatter={(d: string) => dayLabel(d)} tickLine={false} axisLine={false} minTickGap={24}
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '3 3' }} />
          <Area type="monotone" dataKey="count" stroke="hsl(var(--chart-1))" strokeWidth={2} fill="url(#tp-matches-fill)"
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }} dot={false} isAnimationActive={!reduce} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

const RING = { size: 120, r: 50, width: 14 } as const;
const RING_C = 2 * Math.PI * RING.r;

/**
 * Go / Review / No-Go donut with a labelled legend (identity never by colour alone).
 *
 * Drawn as plain SVG circles (not a recharts Pie): the ring is rendered in its final state on the first paint, so it
 * never depends on a JS animation frame (recharts drew no sectors until its animation ran and ignored reduced motion),
 * and colours are applied through the `style` property, where `hsl(var(--token))` is always resolved. The track uses
 * a visible tint so an org with no analyses still shows a ring (the old `--muted` placeholder was ~1.1:1 on the card).
 */
export function VerdictDonut({ verdicts }: { verdicts: DashboardResponse['verdicts'] }) {
  const rows = (['go', 'review', 'no_go'] as Verdict[]).map((v) => ({ key: v, name: VERDICT_LABEL[v], value: verdicts[v] }));
  const total = rows.reduce((a, r) => a + r.value, 0);
  const segments = donutSegments(rows, RING_C, 3);
  const c = RING.size / 2;
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row lg:flex-col xl:flex-row">
      <div className="relative size-40 shrink-0" role="img" aria-label={`Go/No-Go verdicts, ${total} analysed: ${rows.map((r) => `${r.name} ${r.value}`).join(', ')}`}>
        <svg viewBox={`0 0 ${RING.size} ${RING.size}`} width="100%" height="100%" className="block size-full" aria-hidden data-testid="verdict-ring">
          <circle cx={c} cy={c} r={RING.r} fill="none" strokeWidth={RING.width} style={{ stroke: 'hsl(var(--muted-foreground) / 0.22)' }} />
          {segments.map((s) => (
            <circle key={s.key} data-verdict={s.key} cx={c} cy={c} r={RING.r} fill="none" strokeWidth={RING.width}
              strokeDasharray={`${s.length} ${RING_C}`} strokeDashoffset={-s.start} transform={`rotate(-90 ${c} ${c})`}
              className="motion-safe:transition-[stroke-dasharray,stroke-dashoffset] motion-safe:duration-700 motion-safe:ease-out"
              style={{ stroke: verdictColor[s.key] }}>
              <title>{`${VERDICT_LABEL[s.key]}: ${s.value} (${Math.round((s.value / total) * 100)}%)`}</title>
            </circle>
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="tabular text-2xl font-semibold tracking-tight">{total}</span>
          <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">analysed</span>
        </div>
      </div>
      <ul className="grid w-full gap-2">
        {rows.map((r) => (
          <li key={r.key}>
            <Link to={`/tenders?verdict=${r.key}`} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-muted focus-ring">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: verdictColor[r.key] }} aria-hidden />
              <span className="flex-1 font-medium">{r.name}</span>
              <span className="tabular text-muted-foreground">{r.value}</span>
              <span className="tabular w-10 text-right text-xs text-muted-foreground">{total ? `${Math.round((r.value / total) * 100)}%` : '–'}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const FUNNEL: DashboardStage[] = ['identified', 'analysing', 'go', 'preparing', 'ready', 'submitted', 'won'];

/** Pipeline funnel as single-hue horizontal bars (magnitude), with counts and ₹ value. */
export function PipelineFunnel({ pipeline, value }: { pipeline: DashboardResponse['pipeline']; value: DashboardResponse['pipelineValue'] }) {
  const max = useMemo(() => Math.max(1, ...FUNNEL.map((s) => pipeline[s])), [pipeline]);
  return (
    <ul className="grid gap-1.5" aria-label="Bids by pipeline stage">
      {FUNNEL.map((s) => {
        const n = pipeline[s];
        const pct = (n / max) * 100;
        return (
          <li key={s}>
            <Link to={`/pipeline?stage=${s}`} className="group grid grid-cols-[6.5rem_1fr_3.5rem_1.5rem] items-center gap-3 rounded-lg px-1.5 py-1 focus-ring hover:bg-muted/60"
              title={`${STAGE_LABEL[s]}: ${pluralize(n, 'bid')} · ${formatINRCompact(value[s])}`}>
              <span className="truncate text-[13px] text-muted-foreground group-hover:text-foreground">{STAGE_LABEL[s]}</span>
              <span className="relative h-6 overflow-hidden rounded-md bg-muted/60">
                <span
                  className={cn('absolute inset-y-0 left-0 rounded-md transition-[width] duration-700 ease-out', s === 'won' ? 'bg-success' : 'bg-primary')}
                  style={{ width: `${n ? Math.max(pct, 6) : 0}%`, opacity: s === 'won' ? 0.9 : 0.35 + (0.6 * (FUNNEL.indexOf(s) + 1)) / FUNNEL.length }}
                />
              </span>
              <span className="tabular truncate text-right text-2xs text-muted-foreground">{value[s] > 0 ? formatINRCompact(value[s]) : '—'}</span>
              <span className="tabular w-6 text-right text-sm font-semibold">{n}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
