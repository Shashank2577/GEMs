import { memo, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, Building2, EyeOff, FileWarning, MapPin, MoreHorizontal, Package, RotateCcw, Sparkles } from 'lucide-react';
import type { TenderListItem } from '@tp/core/contracts/identify';
import {
  Badge, Button, Countdown, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  ScoreRing, StageBadge, Tooltip, VerdictBadge, toast,
} from '@/components/ui';
import { formatDateIST, formatINR, formatNumberIN } from '@/lib/format';
import type { Stage } from '@/lib/types';
import { cn } from '@/lib/utils';
import { SampleBadge } from './SampleBadge';
import { useDismiss, useMarkSeen } from './api';

export const BID_TYPE_LABEL: Record<string, string> = { bid: 'Bid', ra: 'Reverse auction', bunch: 'Bunch bid', service: 'Service' };

export function buyerLine(t: Pick<TenderListItem, 'department' | 'ministry' | 'organisation'>) {
  const primary = t.organisation ?? t.department ?? t.ministry;
  const secondary = t.organisation ? t.department ?? t.ministry : t.department ? t.ministry : null;
  return { primary: primary ?? 'Buyer not published', secondary: secondary && secondary !== primary ? secondary : null };
}

export function locationLine(t: Pick<TenderListItem, 'city' | 'state'>) {
  return [t.city, t.state].filter(Boolean).join(', ') || null;
}

/** Up to N unique match-reason chips across all watchlists. */
export function reasonChips(t: TenderListItem, max = 3) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of t.matches) for (const r of m.reasons) if (!seen.has(r)) { seen.add(r); out.push(r); }
  return { chips: out.slice(0, max), more: Math.max(0, out.length - max) };
}

function Metric({ label, children, hint, className }: { label: string; children: React.ReactNode; hint?: string; className?: string }) {
  const body = (
    <div className={cn('min-w-0', className)}>
      <dt className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] font-semibold tabular">{children}</dd>
    </div>
  );
  return hint ? <Tooltip content={hint}>{body}</Tooltip> : body;
}

export const TenderCard = memo(function TenderCard({ t, canDismiss = true }: { t: TenderListItem; canDismiss?: boolean }) {
  const navigate = useNavigate();
  const markSeen = useMarkSeen();
  const dismiss = useDismiss();
  const buyer = buyerLine(t);
  const loc = locationLine(t);
  const { chips, more } = reasonChips(t);
  const href = `/tenders/${t.id}`;
  const open = () => { if (t.isNew) markSeen.mutate(t.id); };
  const onDismiss = (e?: MouseEvent | Event) => {
    e?.preventDefault?.();
    dismiss.mutate({ id: t.id }, {
      onSuccess: () => toast('Hidden from your feed', {
        description: t.title,
        action: { label: 'Undo', onClick: () => dismiss.mutate({ id: t.id, undo: true }) },
      }),
    });
  };

  return (
    <article
      className={cn(
        'group relative rounded-xl border bg-card p-4 shadow-xs transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-foreground/15 hover:shadow-md sm:p-5',
        t.isNew && 'border-primary/30 ring-1 ring-primary/10',
        t.dismissed && 'opacity-60',
      )}
      aria-labelledby={`t-${t.id}-title`}
    >
      {t.isNew && <span className="absolute left-0 top-5 h-8 w-[3px] rounded-r-full bg-primary" aria-hidden />}
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
            {t.isNew && (
              <span className="inline-flex items-center gap-1 font-semibold text-primary">
                <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/50" /><span className="relative inline-flex size-2 rounded-full bg-primary" /></span>
                New
              </span>
            )}
            <span className="font-mono text-[12px] tracking-tight text-foreground/70">{t.bidNumber}</span>
            {t.bidType !== 'bid' && <Badge size="sm" tone={t.bidType === 'ra' ? 'info' : 'neutral'}>{BID_TYPE_LABEL[t.bidType] ?? t.bidType}</Badge>}
            {t.isDemo && <SampleBadge />}
            {t.hasCorrigendum && (
              <Tooltip content="GeM published a corrigendum this week — dates or terms changed.">
                <span tabIndex={0} data-testid="corrigendum-badge" className="relative z-10 inline-flex rounded-sm focus-ring">
                  <Badge size="sm" tone="warning"><FileWarning aria-hidden />Corrigendum</Badge>
                </span>
              </Tooltip>
            )}
            {t.workspace && <StageBadge stage={t.workspace.stage as Stage} size="sm" />}
          </div>

          <h3 id={`t-${t.id}-title`} className="mt-1.5 text-[15px] font-semibold leading-snug tracking-tight sm:text-base">
            <Link to={href} onClick={open} className="rounded-sm outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring">
              <span className="line-clamp-2">{t.title}</span>
            </Link>
          </h3>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Building2 className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate"><span className="text-foreground/80">{buyer.primary}</span>{buyer.secondary && <span className="hidden sm:inline"> · {buyer.secondary}</span>}</span>
            </span>
            {loc && <span className="inline-flex items-center gap-1.5"><MapPin className="size-3.5 shrink-0" aria-hidden />{loc}</span>}
          </div>

          {(chips.length > 0 || t.matches.length > 0) && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {t.matches.length > 0 && (
                <Badge tone="primary" size="sm" className="font-semibold"><Sparkles aria-hidden />{t.matches.length > 1 ? `${t.matches.length} watchlists` : t.matches[0].watchlistName}</Badge>
              )}
              {chips.map((r) => <Badge key={r} tone="outline" size="sm" className="font-normal text-muted-foreground">{r}</Badge>)}
              {more > 0 && <span className="text-2xs text-muted-foreground">+{more} more</span>}
            </div>
          )}
        </div>

        <div className="relative z-10 flex shrink-0 flex-col items-end gap-2">
          {t.analysis?.score != null ? (
            <Link to={href} onClick={open} className="flex flex-col items-center gap-1 rounded-lg p-0.5 focus-ring" aria-label={`Score ${t.analysis.score}`}>
              <ScoreRing score={t.analysis.score} verdict={t.analysis.verdict ?? undefined} size={48} animate={false} />
              {t.analysis.verdict && <VerdictBadge verdict={t.analysis.verdict} size="sm" showIcon={false} />}
              {t.analysis.stale && <Tooltip content="A corrigendum changed this bid after it was scored — re-run the analysis."><Badge tone="warning" size="sm">Re-check</Badge></Tooltip>}
            </Link>
          ) : (
            <Tooltip content="Score eligibility against your company profile">
              <Button asChild variant="secondary" size="xs" className="hidden sm:inline-flex">
                <Link to={`${href}?analyse=1`} onClick={open}><Sparkles />Score it</Link>
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t pt-3">
        <dl className="relative z-10 grid flex-1 grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 sm:gap-x-8">
          <Metric label="Closes" hint={t.endAt ? `Bid end: ${formatDateIST(t.endAt, { time: true })} IST` : undefined}>
            <Countdown to={t.endAt} compact className="text-[13px] font-semibold" />
          </Metric>
          <Metric label="EMD" hint="Earnest Money Deposit — MSEs and Startups are often exempt">
            {t.emdAmount === 0 ? <span className="text-emerald-700 dark:text-success">Nil</span> : formatINR(t.emdAmount, { compact: true })}
          </Metric>
          <Metric label="Est. value" hint={t.estimatedValue ? formatINR(t.estimatedValue) : 'Not published on the listing — open the bid document'}>
            {formatINR(t.estimatedValue, { compact: true, fallback: '—' })}
          </Metric>
          <Metric label="Quantity"><span className="inline-flex items-center gap-1"><Package className="size-3.5 text-muted-foreground" aria-hidden />{formatNumberIN(t.quantity)}</span></Metric>
        </dl>
        <div className="relative z-10 flex items-center gap-1">
          {canDismiss && t.matches.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="More actions"><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {t.dismissed ? (
                  <DropdownMenuItem onSelect={() => dismiss.mutate({ id: t.id, undo: true })}><RotateCcw />Restore to feed</DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={(e) => onDismiss(e)}><EyeOff />Not relevant — hide</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href={t.sourceUrl} target="_blank" rel="noreferrer noopener"><ArrowUpRight />Open on GeM</a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="ghost" size="sm" className="text-primary hover:text-primary dark:text-indigo-300 dark:hover:text-indigo-300" onClick={() => { open(); navigate(href); }}>
            Open<ArrowUpRight />
          </Button>
        </div>
      </div>
    </article>
  );
});

export function TenderCardSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-xs sm:p-5" aria-hidden>
      <div className="flex items-start gap-4">
        <div className="flex-1 space-y-2.5">
          <div className="h-3 w-40 animate-pulse rounded bg-muted" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          <div className="flex gap-1.5 pt-1"><div className="h-5 w-24 animate-pulse rounded-full bg-muted" /><div className="h-5 w-20 animate-pulse rounded-full bg-muted" /></div>
        </div>
        <div className="size-12 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 border-t pt-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="space-y-1.5"><div className="h-2.5 w-12 animate-pulse rounded bg-muted" /><div className="h-3.5 w-16 animate-pulse rounded bg-muted" /></div>)}
      </div>
    </div>
  );
}
