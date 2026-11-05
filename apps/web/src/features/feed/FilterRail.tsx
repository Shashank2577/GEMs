import { useId, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import type { Facet } from '@tp/core/contracts/identify';
import { Button, Checkbox, Input, Tooltip } from '@/components/ui';
import { formatINR, formatNumberIN } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BID_TYPE_OPTIONS, CLOSING_OPTIONS, STATUS_OPTIONS, VALUE_PRESETS, VERDICT_OPTIONS, type FeedFilters } from './filters';

type Patch = (p: Partial<FeedFilters>) => void;

function Group({ title, children, onClear, hint }: { title: string; children: ReactNode; onClear?: () => void; hint?: ReactNode }) {
  return (
    <section className="border-b py-4 first:pt-0 last:border-0">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
          {hint}
        </h3>
        {onClear && <button type="button" onClick={onClear} className="rounded text-2xs font-medium text-primary hover:underline dark:text-indigo-300 focus-ring">Clear</button>}
      </div>
      {children}
    </section>
  );
}

/** Checkbox list with counts, inline search and "show all". */
export function FacetList({ facets, selected, onChange, label, searchable = true, initial = 6 }: {
  facets: Facet[]; selected: string[]; onChange: (v: string[]) => void; label: string; searchable?: boolean; initial?: number;
}) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const id = useId();
  const items = useMemo(() => {
    const map = new Map(facets.map((f) => [f.value, f.count]));
    for (const s of selected) if (!map.has(s)) map.set(s, 0);
    const list = [...map].map(([value, count]) => ({ value, count }));
    // selected first, then by count
    list.sort((a, b) => Number(selected.includes(b.value)) - Number(selected.includes(a.value)) || b.count - a.count || a.value.localeCompare(b.value));
    return q ? list.filter((f) => f.value.toLowerCase().includes(q.toLowerCase())) : list;
  }, [facets, selected, q]);
  const shown = all || q ? items : items.slice(0, initial);
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  if (!facets.length && !selected.length) return <p className="text-xs text-muted-foreground">No options for the current results.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {searchable && items.length > initial && (
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${label.toLowerCase()}…`}
          aria-label={`Search ${label}`}
          className="h-8 text-[13px]"
          leading={<Search />}
        />
      )}
      <ul className="flex min-w-0 flex-col gap-0.5" aria-label={label}>
        {shown.map((f) => {
          const cid = `${id}-${f.value}`;
          const on = selected.includes(f.value);
          return (
            <li key={f.value}>
              <label htmlFor={cid} className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 text-[13px] transition-colors hover:bg-muted', on && 'bg-primary-soft/60')}>
                <Checkbox id={cid} checked={on} onCheckedChange={() => toggle(f.value)} />
                <span className={cn('min-w-0 flex-1 truncate', on && 'font-medium')} title={f.value}>{f.value}</span>
                <span className="tabular text-2xs text-muted-foreground">{formatNumberIN(f.count)}</span>
              </label>
            </li>
          );
        })}
        {q && !shown.length && <li className="px-1.5 py-1 text-xs text-muted-foreground">No match for “{q}”</li>}
      </ul>
      {!q && items.length > initial && (
        <button type="button" onClick={() => setAll((x) => !x)} className="inline-flex w-fit items-center gap-1 rounded px-1.5 text-xs font-medium text-primary hover:underline dark:text-indigo-300 focus-ring">
          {all ? 'Show less' : `Show all ${items.length}`}
          <ChevronDown className={cn('size-3 transition-transform', all && 'rotate-180')} />
        </button>
      )}
    </div>
  );
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'h-7 rounded-full border px-2.5 text-xs font-medium transition-colors focus-ring',
        on ? 'border-primary/30 bg-primary-soft text-primary dark:text-indigo-300' : 'bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

const LAKH = 1_00_000;

function ValueRange({ min, max, onChange }: { min: number | null; max: number | null; onChange: (min: number | null, max: number | null) => void }) {
  const [lo, setLo] = useState(min != null ? String(min / LAKH) : '');
  const [hi, setHi] = useState(max != null ? String(max / LAKH) : '');
  const apply = () => {
    const a = lo.trim() ? Math.round(Number(lo) * LAKH) : null;
    const b = hi.trim() ? Math.round(Number(hi) * LAKH) : null;
    onChange(a != null && Number.isFinite(a) ? a : null, b != null && Number.isFinite(b) ? b : null);
  };
  return (
    <div className="grid grid-cols-1 gap-2.5">
      <div className="flex flex-wrap gap-1.5">
        {VALUE_PRESETS.map((p) => (
          <Pill key={p.label} on={min === p.min && max === p.max} onClick={() => { onChange(p.min, p.max); setLo(p.min != null ? String(p.min / LAKH) : ''); setHi(p.max != null ? String(p.max / LAKH) : ''); }}>{p.label}</Pill>
        ))}
      </div>
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <Input inputMode="decimal" value={lo} onChange={(e) => setLo(e.target.value.replace(/[^\d.]/g, ''))} onBlur={apply} placeholder="Min" aria-label="Minimum value in lakh" className="h-8 text-[13px]" trailing={<span className="text-2xs">L</span>} />
        <span className="text-muted-foreground">–</span>
        <Input inputMode="decimal" value={hi} onChange={(e) => setHi(e.target.value.replace(/[^\d.]/g, ''))} onBlur={apply} placeholder="Max" aria-label="Maximum value in lakh" className="h-8 text-[13px]" trailing={<span className="text-2xs">L</span>} />
      </form>
      {(min != null || max != null) && (
        <p className="text-2xs text-muted-foreground">{min != null ? formatINR(min) : 'Any'} – {max != null ? formatINR(max) : 'any'} · bids without a published value are hidden</p>
      )}
    </div>
  );
}

export function FilterRail({ filters, facets, onChange, onReset, className }: {
  filters: FeedFilters; facets?: { states: Facet[]; ministries: Facet[]; categories: Facet[] }; onChange: Patch; onReset: () => void; className?: string;
}) {
  const f = filters;
  return (
    <div className={cn('text-sm', className)}>
      <Group title="Status" onClear={f.status !== 'open' ? () => onChange({ status: 'open' }) : undefined}>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Status">
          {STATUS_OPTIONS.map((o) => (
            <Pill key={o.value} on={f.status === o.value} onClick={() => onChange({ status: o.value })}>{o.label}</Pill>
          ))}
        </div>
      </Group>

      <Group title="Closing within" onClear={f.closingWithin != null ? () => onChange({ closingWithin: null }) : undefined}>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Closing within">
          {CLOSING_OPTIONS.map((o) => {
            const v = o.value === 'any' ? null : Number(o.value);
            return <Pill key={o.value} on={f.closingWithin === v} onClick={() => onChange({ closingWithin: v })}>{o.label}</Pill>;
          })}
        </div>
      </Group>

      <Group title="State" onClear={f.states.length ? () => onChange({ states: [] }) : undefined}>
        <FacetList label="States" facets={facets?.states ?? []} selected={f.states} onChange={(states) => onChange({ states })} />
      </Group>

      <Group title="Ministry / State govt" onClear={f.ministries.length ? () => onChange({ ministries: [] }) : undefined}>
        <FacetList label="Ministries" facets={facets?.ministries ?? []} selected={f.ministries} onChange={(ministries) => onChange({ ministries })} />
      </Group>

      <Group title="Category" onClear={f.categories.length ? () => onChange({ categories: [] }) : undefined}>
        <FacetList label="Categories" facets={facets?.categories ?? []} selected={f.categories} onChange={(categories) => onChange({ categories })} initial={5} />
      </Group>

      <Group
        title="Estimated value"
        onClear={f.minValue != null || f.maxValue != null ? () => onChange({ minValue: null, maxValue: null }) : undefined}
      >
        <ValueRange key={`${f.minValue}-${f.maxValue}`} min={f.minValue} max={f.maxValue} onChange={(minValue, maxValue) => onChange({ minValue, maxValue })} />
      </Group>

      <Group
        title="Go / No-Go"
        hint={<Tooltip content="Your eligibility verdict after analysing the bid document against your company profile."><span className="cursor-help text-muted-foreground">ⓘ</span></Tooltip>}
        onClear={f.verdicts.length ? () => onChange({ verdicts: [] }) : undefined}
      >
        <div className="flex flex-wrap gap-1.5">
          {VERDICT_OPTIONS.map((o) => (
            <Pill key={o.value} on={f.verdicts.includes(o.value)} onClick={() => onChange({ verdicts: f.verdicts.includes(o.value) ? f.verdicts.filter((x) => x !== o.value) : [...f.verdicts, o.value] })}>{o.label}</Pill>
          ))}
        </div>
      </Group>

      <Group title="Bid type" onClear={f.bidTypes.length ? () => onChange({ bidTypes: [] }) : undefined}>
        <div className="flex flex-wrap gap-1.5">
          {BID_TYPE_OPTIONS.map((o) => (
            <Pill key={o.value} on={f.bidTypes.includes(o.value)} onClick={() => onChange({ bidTypes: f.bidTypes.includes(o.value) ? f.bidTypes.filter((x) => x !== o.value) : [...f.bidTypes, o.value] })}>{o.label}</Pill>
          ))}
        </div>
      </Group>

      <div className="pt-2">
        <Button variant="ghost" size="sm" onClick={onReset} className="text-muted-foreground"><X />Reset all filters</Button>
      </div>
    </div>
  );
}
