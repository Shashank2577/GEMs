import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Briefcase, Building2, Check, ChevronRight, Copy, ExternalLink, EyeOff, Gauge, Info, MapPin, MoreHorizontal, Package, Percent, RefreshCw, Wallet,
} from 'lucide-react';
import type { TenderDetail } from '@tp/core/contracts/identify';
import type { AnalysisDto } from '@tp/core/contracts/analyse';
import {
  Badge, Button, Card, Countdown, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  ScoreRing, StageBadge, Tooltip, VerdictBadge, toast,
} from '@/components/ui';
import { RoleGate } from '@/lib/auth';
import { SampleBadge } from '@/features/feed/SampleBadge';
import { formatDateIST, formatINR, formatNumberIN } from '@/lib/format';
import type { Stage } from '@/lib/types';
import { useState } from 'react';

const BID_TYPE_LABEL: Record<string, string> = { bid: 'Bid', ra: 'Reverse auction', bunch: 'Bunch bid', service: 'Service bid' };

function Fact({ icon: Icon, label, help, children }: { icon: typeof Wallet; label: string; help?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border bg-card/60 px-3.5 py-3 backdrop-blur">
      <dt className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3.5" aria-hidden /> {label}
        {help && <Tooltip content={help}><Info className="size-3 cursor-help" aria-label={`What is ${label}?`} /></Tooltip>}
      </dt>
      <dd className="tabular mt-1 truncate text-[15px] font-semibold tracking-tight">{children}</dd>
    </div>
  );
}

export function TenderHero({
  tender, analysis, analysing, analyseDisabled = false, onAnalyse, onStartBid, startingBid, onDismiss, dismissing,
}: {
  tender: TenderDetail; analysis: AnalysisDto | null; analysing: boolean; onAnalyse: () => void; onStartBid: () => void; startingBid: boolean;
  onDismiss: () => void; dismissing: boolean;
  /** Another analysis for this tender is running (FR-028). */
  analyseDisabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const buyer = [tender.ministry, tender.department, tender.organisation, tender.buyerOffice].filter((x, i, a) => x && a.indexOf(x) === i) as string[];
  const place = [tender.city, tender.state].filter(Boolean).join(', ');
  const gemUrl = tender.sourceUrl || tender.documentUrl;
  const closed = tender.status !== 'open' || (tender.endAt ? new Date(tender.endAt).getTime() < Date.now() : false);
  const done = analysis?.status === 'done';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tender.bidNumber);
      setCopied(true);
      toast.success('Bid number copied');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy — select the bid number instead');
    }
  };

  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.07] via-transparent to-accent/[0.06]" aria-hidden />
      <div className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-primary/10 blur-3xl" aria-hidden />
      <div className="relative grid gap-5 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button" onClick={copy}
            className="group inline-flex h-7 items-center gap-1.5 rounded-md border bg-card px-2 font-mono text-xs font-medium tracking-tight text-foreground/90 hover:border-primary/40 focus-ring"
            aria-label={`Copy bid number ${tender.bidNumber}`}
          >
            {tender.bidNumber}
            {copied ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5 text-muted-foreground group-hover:text-primary" aria-hidden />}
          </button>
          <Badge tone="outline">{BID_TYPE_LABEL[tender.bidType] ?? tender.bidType}</Badge>
          {tender.status !== 'open' && <Badge tone={tender.status === 'cancelled' ? 'danger' : 'neutral'} className="capitalize">{tender.status}</Badge>}
          {tender.isNew && <Badge tone="primary" dot>New match</Badge>}
          {tender.isDemo && <SampleBadge size="md" />}
          {tender.hasCorrigendum && <Badge tone="warning">Corrigendum</Badge>}
          {tender.workspace && <StageBadge stage={tender.workspace.stage as Stage} />}
          {tender.matches.slice(0, 2).map((m) => (
            <Tooltip key={m.watchlistId} content={m.reasons.join(' · ') || 'Matched your watchlist'}>
              <span><Badge tone="info" size="sm">{m.watchlistName}</Badge></span>
            </Tooltip>
          ))}
        </div>

        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold leading-snug tracking-tight sm:text-2xl lg:text-[26px]">{tender.title}</h1>
            {buyer.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm text-muted-foreground">
                <Building2 className="mr-1 size-4 shrink-0" aria-hidden />
                {buyer.map((b, i) => (
                  <span key={b} className="inline-flex items-center gap-1">
                    {i > 0 && <ChevronRight className="size-3.5 opacity-50" aria-hidden />}
                    <span className={i === buyer.length - 1 ? 'text-foreground/80' : ''}>{b}</span>
                  </span>
                ))}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {place && <span className="inline-flex items-center gap-1 text-muted-foreground"><MapPin className="size-4" aria-hidden /> {place}</span>}
              <Countdown to={tender.endAt} className="text-sm" />
              {tender.endAt && <span className="text-xs text-muted-foreground">{formatDateIST(tender.endAt, { time: true })}</span>}
            </div>
          </div>

          {done && analysis && (
            <a href="#analysis" className="flex shrink-0 items-center gap-3 self-start rounded-xl border bg-card/80 p-3 pr-4 shadow-xs backdrop-blur hover:border-primary/30 focus-ring">
              <ScoreRing score={analysis.score} verdict={analysis.verdict ?? undefined} size={56} />
              <div>
                <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Eligibility</div>
                <VerdictBadge verdict={analysis.verdict ?? 'review'} className="mt-1" />
              </div>
            </a>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <Fact icon={Wallet} label="EMD" help="Earnest Money Deposit — refundable security with the bid. MSEs and DPIIT Startups are usually exempt.">
            {tender.emdAmount == null ? '—' : tender.emdAmount === 0 ? 'Not required' : formatINR(tender.emdAmount)}
          </Fact>
          <Fact icon={Briefcase} label="Est. value">{tender.estimatedValue ? formatINR(tender.estimatedValue, { compact: true }) : '—'}</Fact>
          <Fact icon={Package} label="Quantity">{tender.quantity != null ? formatNumberIN(tender.quantity) : '—'}</Fact>
          <Fact icon={Percent} label="ePBG" help="e-Performance Bank Guarantee — % of contract value the winner furnishes after award.">
            {tender.epbgPercent != null ? `${tender.epbgPercent}%` : '—'}
          </Fact>
        </dl>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <RoleGate min="analyst">
            <Button size="lg" onClick={onAnalyse} loading={analysing} disabled={(closed && !done) || analyseDisabled} className="sm:min-w-44">
              {!analysing && (done ? <RefreshCw /> : <Gauge />)} {done ? 'Re-analyse' : 'Analyse eligibility'}
            </Button>
            {tender.workspace ? (
              <Button asChild size="lg" variant="secondary">
                <Link to={`/workspaces/${tender.workspace.id}`}>Open bid workspace <ArrowRight /></Link>
              </Button>
            ) : (
              <Button size="lg" variant={analysis?.verdict === 'go' ? 'success' : 'secondary'} onClick={onStartBid} loading={startingBid} disabled={closed}>
                Start bid {!startingBid && <ArrowRight />}
              </Button>
            )}
          </RoleGate>
          <div className="flex gap-2 sm:ml-auto">
            {gemUrl && (
              <Button asChild variant="ghost" className="flex-1 sm:flex-none">
                <a href={gemUrl} target="_blank" rel="noreferrer">View on GeM <ExternalLink /></a>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="More actions"><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={copy}><Copy /> Copy bid number</DropdownMenuItem>
                {gemUrl && <DropdownMenuItem asChild><a href={gemUrl} target="_blank" rel="noreferrer"><ExternalLink /> Open on GeM</a></DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive disabled={dismissing || tender.dismissed} onSelect={onDismiss}><EyeOff /> {tender.dismissed ? 'Dismissed' : 'Dismiss from feed'}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <p className="-mt-1 text-xs text-muted-foreground">
          TenderPilot prepares everything; price entry, OTP / DSC and the final submit always happen by you on GeM.
        </p>
      </div>
    </Card>
  );
}
