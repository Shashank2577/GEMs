/**
 * Watchlist builder (FR-003): chips for keywords / exclusions / categories / HSN, state & buyer
 * pickers, value range, closing window, bid types — with a live preview of matching open bids.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertCircle, BellRing, Info, Loader2, Radar, Sparkles } from 'lucide-react';
import type { TenderListResponse, WatchlistCriteriaInput, WatchlistDto } from '@tp/core/contracts/identify';
import { INDIAN_STATES } from '@tp/core/gem/states';
import {
  Badge, Button, Countdown, Field, Input, Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
  Select, Tooltip, toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatINR, formatNumberIN } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { useCreateWatchlist, useUpdateWatchlist, useWatchlistPreview } from './api';
import { ChipInput, MultiSelect } from './ChipInput';

export interface Draft {
  name: string;
  keywords: string[];
  excludeKeywords: string[];
  categories: string[];
  hsnCodes: string[];
  states: string[];
  ministries: string[];
  minLakh: string;
  maxLakh: string;
  minDaysToClose: string;
  bidTypes: string[];
}

const LAKH = 1_00_000;

export function draftFrom(name: string, c?: Partial<WatchlistCriteriaInput> | null): Draft {
  return {
    name,
    keywords: c?.keywords ?? [],
    excludeKeywords: c?.excludeKeywords ?? [],
    categories: c?.categories ?? [],
    hsnCodes: c?.hsnCodes ?? [],
    states: c?.states ?? [],
    ministries: c?.ministries ?? [],
    minLakh: c?.minValue != null ? String(c.minValue / LAKH) : '',
    maxLakh: c?.maxValue != null ? String(c.maxValue / LAKH) : '',
    minDaysToClose: c?.minDaysToClose != null ? String(c.minDaysToClose) : '0',
    bidTypes: (c?.bidTypes as string[] | undefined) ?? [],
  };
}

export function draftToCriteria(d: Draft): WatchlistCriteriaInput {
  const lakh = (s: string) => (s.trim() && Number.isFinite(Number(s)) ? Math.round(Number(s) * LAKH) : null);
  return {
    keywords: d.keywords, excludeKeywords: d.excludeKeywords, categories: d.categories, hsnCodes: d.hsnCodes,
    states: d.states, ministries: d.ministries, minValue: lakh(d.minLakh), maxValue: lakh(d.maxLakh),
    minDaysToClose: Number(d.minDaysToClose) > 0 ? Number(d.minDaysToClose) : null,
    bidTypes: d.bidTypes as WatchlistCriteriaInput['bidTypes'],
  };
}

const hasCriteria = (d: Draft) =>
  d.keywords.length + d.categories.length + d.hsnCodes.length + d.states.length + d.ministries.length + d.bidTypes.length > 0
  || !!d.minLakh.trim() || !!d.maxLakh.trim();

function useDebouncedValue<T>(v: T, ms: number) {
  const [x, setX] = useState(v);
  useEffect(() => { const id = setTimeout(() => setX(v), ms); return () => clearTimeout(id); }, [v, ms]);
  return x;
}

const BID_TYPES = [
  { value: 'bid', label: 'Bids' }, { value: 'ra', label: 'Reverse auctions' }, { value: 'service', label: 'Services' }, { value: 'bunch', label: 'Bunch bids' },
];

function Preview({ draft }: { draft: Draft }) {
  const criteria = useDebouncedValue(useMemo(() => draftToCriteria(draft), [draft]), 400);
  const ready = hasCriteria(draft);
  const q = useWatchlistPreview(criteria, ready);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Live preview</p>
        {q.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Updating preview" />}
      </div>
      <div className="mt-3 rounded-xl border bg-card p-4 shadow-xs" aria-live="polite">
        {!ready ? (
          <p className="text-sm text-muted-foreground">Add a keyword, state or buyer to see matching open bids.</p>
        ) : q.isError ? (
          <p className="text-sm text-danger">Preview unavailable — {(q.error as Error).message}</p>
        ) : (
          <>
            <p className="text-3xl font-semibold tracking-tight tabular">{q.data ? formatNumberIN(q.data.count) : '—'}</p>
            <p className="text-[13px] text-muted-foreground">open GeM {q.data?.count === 1 ? 'bid matches' : 'bids match'} right now</p>
          </>
        )}
      </div>
      {ready && q.data && q.data.sample.length > 0 && (
        <ul className="mt-3 flex min-w-0 flex-col gap-2" aria-label="Sample matches">
          {q.data.sample.map((t) => (
            <li key={t.id} className="min-w-0 rounded-lg border bg-card p-3 text-[13px] shadow-xs">
              <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
                <span className="truncate font-mono">{t.bidNumber}</span>
                <Countdown to={t.endAt} compact className="text-2xs" />
              </div>
              <Link to={`/tenders/${t.id}`} target="_blank" className="mt-0.5 line-clamp-2 font-medium hover:text-primary hover:underline">{t.title}</Link>
              <p className="truncate text-2xs text-muted-foreground">{[t.department ?? t.ministry, t.state].filter(Boolean).join(' · ')}{t.estimatedValue ? ` · ${formatINR(t.estimatedValue, { compact: true })}` : ''}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {t.previewReasons.slice(0, 3).map((r) => <Badge key={r} size="sm" tone="primary" className="font-normal">{r}</Badge>)}
              </div>
            </li>
          ))}
        </ul>
      )}
      {ready && q.data?.count === 0 && (
        <p className="mt-3 rounded-lg bg-subtle p-3 text-xs text-muted-foreground">
          Nothing open right now — that’s fine. You’ll be alerted the moment GeM publishes a matching bid.
        </p>
      )}
      <p className="mt-auto flex items-start gap-1.5 pt-4 text-2xs text-muted-foreground">
        <BellRing className="mt-px size-3.5 shrink-0" />
        Existing bids are added to your feed silently; alerts go out for bids published after you save.
      </p>
    </div>
  );
}

export function WatchlistBuilder({ open, onOpenChange, editing, initial }: {
  open: boolean; onOpenChange: (o: boolean) => void; editing?: WatchlistDto | null; initial?: Draft | null;
}) {
  const isMobile = useIsMobile();
  const [d, setD] = useState<Draft>(() => initial ?? draftFrom(''));
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Form-level server error that isn't tied to a field, e.g. the 50-watchlist limit (FR-027). */
  const [formError, setFormError] = useState<string | null>(null);
  const create = useCreateWatchlist();
  const update = useUpdateWatchlist();
  const saving = create.isPending || update.isPending;

  useEffect(() => {
    if (!open) return;
    setD(editing ? draftFrom(editing.name, editing.criteria) : initial ?? draftFrom(''));
    setErrors({});
    setFormError(null);
  }, [open, editing, initial]);

  // Buyer suggestions from currently open tenders.
  const facets = useQuery({
    queryKey: ['tenders', 'facets'],
    queryFn: () => api.get<TenderListResponse>('/tenders', { pageSize: 1 }),
    staleTime: 5 * 60_000,
    enabled: open,
  });
  const ministryOptions = facets.data?.facets.ministries.map((f) => f.value) ?? [];
  const categoryOptions = facets.data?.facets.categories.map((f) => f.value) ?? [];

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setD((x) => ({ ...x, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!d.name.trim()) errs.name = 'Give the watchlist a name, e.g. “Laptops — Maharashtra”';
    if (!hasCriteria(d)) errs.keywords = 'Add at least one keyword, state, buyer, category, HSN code or value limit';
    const c = draftToCriteria(d);
    if (c.minValue != null && c.maxValue != null && c.minValue > c.maxValue) errs.maxLakh = 'Maximum must be at least the minimum';
    setErrors(errs);
    setFormError(null);
    if (Object.values(errs).some(Boolean)) return;
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, name: d.name.trim(), criteria: c });
        toast.success('Watchlist updated');
      } else {
        const w = await create.mutateAsync({ name: d.name.trim(), criteria: c });
        toast.success(`“${w.name}” is live`, { description: w.openCount ? `${w.openCount} open ${w.openCount === 1 ? 'bid' : 'bids'} already match — see them in your feed.` : 'We’ll alert you as soon as a matching bid is published.' });
      }
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === 'object' && 'fields' in e.details) {
        const f = (e.details as { fields: Record<string, string> }).fields;
        setErrors({ name: f.name ?? '', keywords: f.criteria ?? f['criteria.keywords'] ?? '', maxLakh: f['criteria.maxValue'] ?? '', hsnCodes: Object.entries(f).find(([k]) => k.startsWith('criteria.hsnCodes'))?.[1] ?? '' });
      }
      // The limit message is shown inline in the form; a toast would only repeat it.
      if (e instanceof ApiError && e.code === 'watchlist_limit') { setFormError(e.message); return; }
      toast.error(e instanceof Error ? e.message : 'Could not save the watchlist');
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className={cn(isMobile ? 'h-[94dvh]' : 'w-[min(100%,60rem)] max-w-none')}>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2"><Radar className="size-4 text-primary" />{editing ? 'Edit watchlist' : 'New watchlist'}</SheetTitle>
          <SheetDescription>Describe what you sell. Every new GeM bid is checked against this the moment it’s published.</SheetDescription>
        </SheetHeader>
        <SheetBody className="p-0">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <form className="grid min-w-0 grid-cols-1 content-start gap-5 px-5 py-5" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
              {formError && (
                <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-[13px] text-danger animate-fade-in">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>{formError}</span>
                </div>
              )}
              <Field className="content-start" label="Name" required error={errors.name}>
                <Input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Laptops & desktops — West India" maxLength={80} autoFocus={!isMobile} />
              </Field>

              <Field className="content-start" label="Keywords" hint="Any keyword matches — searched in item names, categories and buyer. Plurals included." error={errors.keywords}>
                <ChipInput value={d.keywords} onChange={(v) => set('keywords', v)} placeholder="laptop, CCTV, manpower… press Enter" />
              </Field>

              <Field className="content-start" label="Exclude keywords" hint="Skip bids that mention any of these (e.g. “refurbished”, “AMC”).">
                <ChipInput value={d.excludeKeywords} onChange={(v) => set('excludeKeywords', v)} placeholder="Words to ignore" tone="danger" />
              </Field>

              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field className="content-start" label="States" hint="Buyer / consignee state. Leave empty for all of India.">
                  <MultiSelect label="States" options={[...INDIAN_STATES]} value={d.states} onChange={(v) => set('states', v)} placeholder="All of India" />
                </Field>
                <Field className="content-start" label="Ministries & buyers" hint="Matches ministry, department or organisation.">
                  <ChipInput value={d.ministries} onChange={(v) => set('ministries', v)} placeholder="e.g. Ministry of Defence, NTPC" suggestions={ministryOptions} tone="neutral" />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field className="content-start" label="GeM categories" hint="Category names as they appear on GeM.">
                  <ChipInput value={d.categories} onChange={(v) => set('categories', v)} placeholder="e.g. Laptop - Notebook" suggestions={categoryOptions} tone="neutral" />
                </Field>
                <Field
                  className="content-start"
                  label={<span className="inline-flex items-center gap-1">HSN codes <Tooltip content="Harmonised System of Nomenclature — a 4-digit heading (e.g. 8471) also matches its 8-digit codes."><Info className="size-3.5 text-muted-foreground" /></Tooltip></span>}
                  error={errors.hsnCodes}
                >
                  <ChipInput value={d.hsnCodes} onChange={(v) => set('hsnCodes', v)} placeholder="e.g. 8471, 85258020" tone="neutral" validate={(s) => (/^\d{2,8}$/.test(s) ? null : 'HSN codes are 2–8 digits')} />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field className="content-start" label="Estimated value (₹ lakh)" hint="Bids without a published value still match." error={errors.maxLakh}>
                  <div className="flex items-center gap-2">
                    <Input inputMode="decimal" value={d.minLakh} onChange={(e) => set('minLakh', e.target.value.replace(/[^\d.]/g, ''))} placeholder="Min" aria-label="Minimum value in lakh" trailing={<span className="text-2xs">L</span>} />
                    <span className="text-muted-foreground">–</span>
                    <Input inputMode="decimal" value={d.maxLakh} onChange={(e) => set('maxLakh', e.target.value.replace(/[^\d.]/g, ''))} placeholder="Max" aria-label="Maximum value in lakh" trailing={<span className="text-2xs">L</span>} />
                  </div>
                </Field>
                <Field className="content-start" label="Time to prepare" hint="Skip bids closing sooner than this.">
                  <Select
                    value={d.minDaysToClose}
                    onValueChange={(v) => set('minDaysToClose', v)}
                    options={[{ value: '0', label: 'Any deadline' }, { value: '2', label: 'At least 2 days left' }, { value: '5', label: 'At least 5 days left' }, { value: '7', label: 'At least a week left' }, { value: '14', label: 'At least 2 weeks left' }]}
                  />
                </Field>
              </div>

              <Field className="content-start" label="Bid types">
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Bid types">
                  {BID_TYPES.map((b) => {
                    const on = d.bidTypes.includes(b.value);
                    return (
                      <button key={b.value} type="button" aria-pressed={on}
                        onClick={() => set('bidTypes', on ? d.bidTypes.filter((x) => x !== b.value) : [...d.bidTypes, b.value])}
                        className={cn('h-8 rounded-full border px-3 text-[13px] font-medium transition-colors focus-ring', on ? 'border-primary/30 bg-primary-soft text-primary' : 'bg-card text-muted-foreground hover:text-foreground')}
                      >{b.label}</button>
                    );
                  })}
                  {!d.bidTypes.length && <span className="self-center text-xs text-muted-foreground">All types</span>}
                </div>
              </Field>
              <button type="submit" hidden />
            </form>
            <aside className="min-w-0 border-t bg-subtle/60 px-5 py-5 lg:border-l lg:border-t-0" aria-label="Preview">
              <Preview draft={d} />
            </aside>
          </div>
        </SheetBody>
        <SheetFooter className="justify-between">
          <p className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"><Sparkles className="size-3.5 text-primary" />Alerts follow each member’s notification settings.</p>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button variant="ghost" onClick={() => onOpenChange(false)} className="flex-1 sm:flex-none">Cancel</Button>
            <Button onClick={submit} loading={saving} className="flex-1 sm:flex-none">{editing ? 'Save changes' : 'Create watchlist'}</Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
