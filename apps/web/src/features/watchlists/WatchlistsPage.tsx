/**
 * Watchlists (US1, FR-003): what the org wants to hear about. List with live counts, pause toggle,
 * quick-start templates, and the builder sheet (opened via "New", `?new=1`, `?edit=<id>`, or
 * "Save as watchlist" from the feed with prefilled criteria).
 */
import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight, BellPlus, Building2, Cctv, Cpu, HeartPulse, MapPin, MoreHorizontal, Pencil, Radar, Sofa, SunMedium, Trash2, Users,
} from 'lucide-react';
import type { WatchlistCriteriaInput, WatchlistDto } from '@tp/core/contracts/identify';
import {
  Badge, Button, Card, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  EmptyState, ErrorState, PageHeader, Skeleton, StatTile, Switch, Tooltip, toast,
} from '@/components/ui';
import { RoleGate, useAuth } from '@/lib/auth';
import { formatINR, formatNumberIN, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useDeleteWatchlist, useUpdateWatchlist, useWatchlists } from './api';
import { draftFrom, WatchlistBuilder, type Draft } from './WatchlistBuilder';

const TEMPLATES: { name: string; blurb: string; icon: typeof Cpu; criteria: WatchlistCriteriaInput }[] = [
  { name: 'IT hardware', blurb: 'Laptops, desktops, servers, printers', icon: Cpu, criteria: { keywords: ['laptop', 'desktop', 'server', 'printer', 'multifunction machine'], hsnCodes: ['8471'] } },
  { name: 'CCTV & security systems', blurb: 'Cameras, NVRs, access control', icon: Cctv, criteria: { keywords: ['cctv', 'network video recorder', 'access control', 'biometric'] } },
  { name: 'Manpower & facility services', blurb: 'Security, housekeeping, outsourcing', icon: Users, criteria: { keywords: ['manpower', 'security', 'housekeeping', 'cleaning', 'sanitation'], bidTypes: ['service'] } },
  { name: 'Medical equipment', blurb: 'Monitors, ventilators, hospital beds', icon: HeartPulse, criteria: { keywords: ['patient monitor', 'ventilator', 'hospital bed', 'ecg'] } },
  { name: 'Solar & electrical', blurb: 'Rooftop PV, street lights, DG sets', icon: SunMedium, criteria: { keywords: ['solar', 'street light', 'generator'] } },
  { name: 'Office furniture', blurb: 'Chairs, desks, almirahs', icon: Sofa, criteria: { keywords: ['chair', 'office table', 'almirah', 'desk', 'furniture'] } },
];

function CriteriaSummary({ c }: { c: WatchlistDto['criteria'] }) {
  const chips: { label: string; tone: 'primary' | 'neutral' | 'danger' | 'info'; icon?: React.ReactNode }[] = [];
  c.keywords.forEach((k) => chips.push({ label: k, tone: 'primary' }));
  c.categories.forEach((k) => chips.push({ label: k, tone: 'neutral' }));
  c.hsnCodes.forEach((k) => chips.push({ label: `HSN ${k}`, tone: 'neutral' }));
  c.states.forEach((k) => chips.push({ label: k, tone: 'info', icon: <MapPin aria-hidden /> }));
  c.ministries.forEach((k) => chips.push({ label: k, tone: 'info', icon: <Building2 aria-hidden /> }));
  if (c.minValue != null || c.maxValue != null) chips.push({ label: `${c.minValue != null ? formatINR(c.minValue, { compact: true }) : '₹0'} – ${c.maxValue != null ? formatINR(c.maxValue, { compact: true }) : 'any'}`, tone: 'neutral' });
  if (c.bidTypes.length) chips.push({ label: c.bidTypes.map((b) => (b === 'ra' ? 'RA' : b)).join(', '), tone: 'neutral' });
  if (c.minDaysToClose) chips.push({ label: `≥ ${c.minDaysToClose} days to prepare`, tone: 'neutral' });
  c.excludeKeywords.forEach((k) => chips.push({ label: `not “${k}”`, tone: 'danger' }));
  const max = 8;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.slice(0, max).map((x, i) => <Badge key={`${x.label}-${i}`} tone={x.tone} size="sm" className="max-w-[14rem] font-medium">{x.icon}<span className="truncate">{x.label}</span></Badge>)}
      {chips.length > max && <Badge size="sm" tone="outline">+{chips.length - max}</Badge>}
    </div>
  );
}

function WatchlistCard({ w, onEdit, onDelete }: { w: WatchlistDto; onEdit: () => void; onDelete: () => void }) {
  const update = useUpdateWatchlist();
  const { can } = useAuth();
  const toggle = (active: boolean) => update.mutate({ id: w.id, active }, {
    onSuccess: () => toast.success(active ? `“${w.name}” resumed` : `“${w.name}” paused`, { description: active ? 'Matching bids will alert you again.' : 'No alerts until you resume it.' }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card className={cn('flex flex-col p-5 transition-colors', !w.active && 'bg-subtle/60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">{w.name}</h3>
            {!w.active && <Badge size="sm" tone="neutral">Paused</Badge>}
            {w.active && w.newThisWeek > 0 && <Badge size="sm" tone="primary" dot>{w.newThisWeek} new this week</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {w.lastMatchAt ? `Last match ${relativeTime(w.lastMatchAt)}` : 'No matches yet'}{w.createdBy ? ` · by ${w.createdBy.name}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip content={w.active ? 'Pause alerts' : 'Resume alerts'}>
            <span><Switch checked={w.active} onCheckedChange={toggle} disabled={!can('analyst')} aria-label={w.active ? `Pause ${w.name}` : `Resume ${w.name}`} /></span>
          </Tooltip>
          <RoleGate min="analyst">
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${w.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onEdit}><Pencil />Edit criteria</DropdownMenuItem>
                <DropdownMenuItem asChild><Link to={`/tenders?watchlistId=${w.id}&matched=1`}><ArrowRight />View matches</Link></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={onDelete}><Trash2 />Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </RoleGate>
        </div>
      </div>
      <div className="mt-4 flex-1"><CriteriaSummary c={w.criteria} /></div>
      <div className="mt-5 grid grid-cols-3 divide-x rounded-lg border bg-subtle/50 text-center">
        <Link to={`/tenders?watchlistId=${w.id}&matched=1`} className="rounded-l-lg px-2 py-2.5 hover:bg-muted focus-ring">
          <p className="text-lg font-semibold tabular">{formatNumberIN(w.openCount)}</p>
          <p className="text-2xs text-muted-foreground">Open bids</p>
        </Link>
        <div className="px-2 py-2.5">
          <p className="text-lg font-semibold tabular">{formatNumberIN(w.newThisWeek)}</p>
          <p className="text-2xs text-muted-foreground">This week</p>
        </div>
        <div className="px-2 py-2.5">
          <p className="text-lg font-semibold tabular">{formatNumberIN(w.matchCount)}</p>
          <p className="text-2xs text-muted-foreground">All time</p>
        </div>
      </div>
    </Card>
  );
}

export default function WatchlistsPage() {
  const q = useWatchlists();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const del = useDeleteWatchlist();
  const [deleting, setDeleting] = useState<WatchlistDto | null>(null);
  const [template, setTemplate] = useState<Draft | null>(null);

  const prefill = (location.state as { criteria?: WatchlistCriteriaInput; name?: string } | null) ?? null;
  const editId = params.get('edit');
  const editing = useMemo(() => (editId ? q.data?.items.find((w) => w.id === editId) ?? null : null), [editId, q.data]);
  const builderOpen = params.get('new') === '1' || !!editing;
  const initial = useMemo(
    () => template ?? (prefill?.criteria ? draftFrom(prefill.name ?? '', prefill.criteria) : null),
    [template, prefill],
  );

  const openNew = (d?: Draft) => { setTemplate(d ?? null); setParams({ new: '1' }); };
  const close = (o: boolean) => {
    if (o) return;
    setTemplate(null);
    // Drop ?new / ?edit and any feed prefill.
    navigate('/watchlists', { replace: true, state: null });
  };

  const items = q.data?.items ?? [];
  const active = items.filter((w) => w.active);
  const totals = {
    active: active.length,
    week: items.reduce((s, w) => s + w.newThisWeek, 0),
    open: items.reduce((s, w) => s + w.openCount, 0),
  };

  return (
    <>
      <PageHeader
        title="Watchlists"
        description="Tell TenderPilot what you sell. Every new GeM bid is matched against these and you’re alerted in-app, by email or on WhatsApp."
        actions={<RoleGate min="analyst"><Button onClick={() => openNew()}><BellPlus />New watchlist</Button></RoleGate>}
      />

      {q.isLoading ? (
        <div className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-56 rounded-xl" />)}</div>
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} retrying={q.isRefetching} />
      ) : items.length === 0 ? (
        <div className="grid grid-cols-1 gap-6">
          <EmptyState
            icon={Radar}
            title="No watchlists yet"
            body="Start from a template below or build your own with keywords, HSN codes, states and buyers. We’ll show matching open bids before you save."
            action={<RoleGate min="analyst"><Button onClick={() => openNew()}><BellPlus />Build a watchlist</Button></RoleGate>}
          />
          <RoleGate min="analyst">
            <section aria-labelledby="tpl-h">
              <h2 id="tpl-h" className="mb-3 text-[15px] font-semibold tracking-tight">Quick start</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {TEMPLATES.map((t) => (
                  <button key={t.name} type="button" onClick={() => openNew(draftFrom(t.name, t.criteria))}
                    className="group flex items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-[border-color,box-shadow] hover:border-primary/30 hover:shadow-md focus-ring">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"><t.icon className="size-5" /></span>
                    <span className="min-w-0">
                      <span className="block font-medium">{t.name}</span>
                      <span className="block text-xs text-muted-foreground">{t.blurb}</span>
                    </span>
                    <ArrowRight className="ml-auto mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                  </button>
                ))}
              </div>
            </section>
          </RoleGate>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile label="Active watchlists" value={`${totals.active} / ${items.length}`} icon={Radar} />
            <StatTile label="New matches this week" value={formatNumberIN(totals.week)} icon={BellPlus} tone="primary" to="/tenders?matched=1&unseen=1" />
            <StatTile label="Open matched bids" value={formatNumberIN(totals.open)} icon={ArrowRight} to="/tenders?matched=1" />
          </div>
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2" aria-label="Watchlists">
            {items.map((w) => (
              <li key={w.id} className="flex">
                <div className="w-full"><WatchlistCard w={w} onEdit={() => setParams({ edit: w.id })} onDelete={() => setDeleting(w)} /></div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <WatchlistBuilder open={builderOpen} onOpenChange={close} editing={editing} initial={initial} />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="Its matches disappear from the feed and no more alerts are sent. Tenders you’ve already analysed or started a bid for are kept."
        confirmLabel="Delete watchlist"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id, {
          onSuccess: () => { toast.success('Watchlist deleted'); setDeleting(null); },
          onError: (e) => toast.error((e as Error).message),
        })}
      />
    </>
  );
}
