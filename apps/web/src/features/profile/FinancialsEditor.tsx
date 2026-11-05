/** Financial-year turnover editor with a mini bar chart and the computed 3-year average. */
import { useMemo } from 'react';
import { Plus, Trash2, TrendingUp } from 'lucide-react';
import type { FinancialYearDto } from '@tp/core/contracts/vault';
import { averageTurnoverLastN, fyLabel, fyLabelForDate, fyStartYear, lastCompletedFys } from '@tp/core/vault/validators';
import { Button, Checkbox, Select, Tooltip } from '@/components/ui';
import { formatINR, formatINRCompact } from '@/lib/format';
import { cn } from '@/lib/utils';
import { RupeeInput } from './RupeeInput';

export function TurnoverChart({ rows }: { rows: FinancialYearDto[] }) {
  const data = useMemo(() => [...rows].filter((r) => fyStartYear(r.fy) != null).sort((a, b) => fyStartYear(a.fy)! - fyStartYear(b.fy)!).slice(-6), [rows]);
  const avg = averageTurnoverLastN(rows, 3);
  const max = Math.max(1, ...data.map((d) => d.turnover), avg?.avg ?? 0);
  if (!data.length) return null;
  const avgYears = new Set(avg?.years ?? []);
  return (
    <figure className="rounded-xl border bg-subtle p-4" aria-label="Turnover by financial year">
      <div className="relative flex h-36 items-end gap-2 sm:gap-3">
        {avg && (
          <div className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-accent/70" style={{ bottom: `${(avg.avg / max) * 100}%` }} aria-hidden>
            <span className="absolute -top-5 right-0 rounded bg-accent-soft px-1.5 text-2xs font-semibold text-accent">avg {formatINRCompact(avg.avg)}</span>
          </div>
        )}
        {data.map((d) => (
          <Tooltip key={d.fy} content={`FY ${d.fy}: ${formatINR(d.turnover)}`}>
            <div className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end" tabIndex={0} aria-label={`FY ${d.fy}: ${formatINR(d.turnover)}`}>
              <span className="mb-1 text-2xs font-medium tabular text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100 sm:opacity-100">{formatINRCompact(d.turnover)}</span>
              <div
                className={cn('w-full max-w-[3.25rem] rounded-t-md transition-[height] duration-500', avgYears.has(d.fy) ? 'bg-primary' : 'bg-primary/35')}
                style={{ height: `${Math.max(2, (d.turnover / max) * 100)}%` }}
              />
            </div>
          </Tooltip>
        ))}
      </div>
      <div className="mt-2 flex gap-2 sm:gap-3">
        {data.map((d) => <div key={d.fy} className="flex-1 text-center text-2xs font-medium text-muted-foreground">{d.fy}</div>)}
      </div>
    </figure>
  );
}

export function FinancialsEditor({ value, onChange, errors, disabled }: {
  value: FinancialYearDto[]; onChange: (v: FinancialYearDto[]) => void; errors: Record<string, string>; disabled?: boolean;
}) {
  const now = new Date();
  const currentStart = fyStartYear(fyLabelForDate(now))!;
  const fyOptions = Array.from({ length: 10 }, (_, i) => fyLabel(currentStart - i)).map((fy) => ({ value: fy, label: `FY ${fy}` }));
  const used = new Set(value.map((r) => r.fy));
  const avg = averageTurnoverLastN(value, 3);
  const wanted = lastCompletedFys(now, 3);
  const missing = wanted.filter((fy) => !used.has(fy));

  const update = (i: number, patch: Partial<FinancialYearDto>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => {
    const next = missing[0] ?? fyOptions.map((o) => o.value).find((fy) => !used.has(fy));
    if (!next) return;
    onChange([...value, { fy: next, turnover: 0, audited: true }].sort((a, b) => (fyStartYear(b.fy) ?? 0) - (fyStartYear(a.fy) ?? 0)));
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border bg-card p-4 sm:col-span-1">
          <div className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground"><TrendingUp className="size-4 text-primary" aria-hidden />Average annual turnover</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight tabular">{avg ? formatINRCompact(avg.avg) : '—'}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {avg ? <>Last {avg.years.length} FY{avg.years.length > 1 ? 's' : ''} ({[...avg.years].reverse().join(', ')}) · {formatINR(avg.avg)}</> : 'Add at least one year'}
          </p>
          {missing.length > 0 && <p className="mt-2 text-xs font-medium text-warning">Missing: {missing.map((m) => `FY ${m}`).join(', ')}</p>}
        </div>
        <div className="sm:col-span-2"><TurnoverChart rows={value} /></div>
      </div>

      {value.length > 0 && (
        <div className="overflow-hidden rounded-xl border">
          <div className="hidden grid-cols-[9rem_1fr_1fr_6rem_2.5rem] gap-3 border-b bg-subtle px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground md:grid">
            <span>Financial year</span><span>Turnover</span><span>Net worth</span><span>Audited</span><span className="sr-only">Remove</span>
          </div>
          <ul className="divide-y">
            {value.map((r, i) => (
              <li key={i} className="grid grid-cols-2 gap-3 px-3 py-3 md:grid-cols-[9rem_1fr_1fr_6rem_2.5rem] md:items-start">
                <div className="col-span-2 md:col-span-1">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground md:hidden">Financial year</span>
                  <Select aria-label="Financial year" value={r.fy} disabled={disabled}
                    options={fyOptions.filter((o) => o.value === r.fy || !used.has(o.value)).concat(fyOptions.some((o) => o.value === r.fy) ? [] : [{ value: r.fy, label: `FY ${r.fy}` }])}
                    onValueChange={(fy) => update(i, { fy })} aria-invalid={!!errors[`financials.${i}.fy`]} />
                  {errors[`financials.${i}.fy`] && <p role="alert" className="mt-1 text-xs text-danger">{errors[`financials.${i}.fy`]}</p>}
                </div>
                <div className="col-span-2 md:col-span-1">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground md:hidden">Turnover</span>
                  <RupeeInput showCompact={false} aria-label={`Turnover FY ${r.fy}`} value={r.turnover} disabled={disabled} onChange={(v) => update(i, { turnover: v ?? 0 })} aria-invalid={!!errors[`financials.${i}.turnover`]} />
                  {errors[`financials.${i}.turnover`] && <p role="alert" className="mt-1 text-xs text-danger">{errors[`financials.${i}.turnover`]}</p>}
                </div>
                <div className="col-span-2 md:col-span-1">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground md:hidden">Net worth</span>
                  <RupeeInput showCompact={false} aria-label={`Net worth FY ${r.fy}`} value={r.netWorth ?? null} allowNegative placeholder="Optional" disabled={disabled} onChange={(v) => update(i, { netWorth: v })} />
                </div>
                <label className="flex h-9 items-center gap-2 text-[13px]">
                  <Checkbox checked={!!r.audited} disabled={disabled} onCheckedChange={(c) => update(i, { audited: c === true })} />Audited
                </label>
                <div className="flex justify-end">
                  {!disabled && <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove FY ${r.fy}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 /></Button>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!disabled && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={add} disabled={used.size >= fyOptions.length}>
            <Plus />{missing[0] ? `Add FY ${missing[0]}` : 'Add financial year'}
          </Button>
        </div>
      )}
    </div>
  );
}
