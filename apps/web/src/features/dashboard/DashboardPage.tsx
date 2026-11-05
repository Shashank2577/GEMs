/**
 * Dashboard (T071; US6) — the Owner's morning glance on a phone and the Bid Manager's command centre on desktop.
 * Data: GET /api/dashboard (one round trip). Mobile-first stacking: KPIs → closing soon → setup → charts → activity.
 */
import { useEffect, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  ArrowRight, BadgeIndianRupee, CalendarClock, CheckCircle2, Circle, FileWarning, FlaskConical, KanbanSquare, PartyPopper, Radar,
  Sparkles, Trophy, type LucideIcon,
} from 'lucide-react';
import type { DashboardActivity, DashboardResponse, DashboardTenderRef } from '@tp/core/contracts/experience';
import {
  Avatar, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Countdown, EmptyState, ErrorState, Progress,
  ScoreRing, Skeleton, StageBadge, StatTile, Tooltip, VerdictBadge, toast,
} from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { formatDateIST, formatINR, formatINRCompact, formatNumberIN, relativeTime } from '@/lib/format';
import { useDocumentTitle, useNow } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import type { Stage } from '@/lib/types';
import { useDashboard, useSeedDemo } from './api';
import { describeActivity, SELF_CONTAINED } from './activity';
import { MatchesTrend, PipelineFunnel, VerdictDonut } from './charts';
import { DecisionsCard } from './DecisionsCard';
import { DemoBanner } from './DemoBanner';
import { MyBidsCard } from './MyBidsCard';
import { StaleBanner } from './StaleBanner';
import { greeting, isEmptyOrg, pctDelta, roleGate, summaryLine } from './summary';

/** FR-073: shown instead of "Create a watchlist" to roles that would get a 403. */
export const ASK_FOR_WATCHLISTS = 'Ask an Owner or Bid Manager to set up watchlists.';

const ONBOARDING_REDIRECT_KEY = 'tp:onboarding-redirected';

export default function DashboardPage() {
  const { me, can, role } = useAuth();
  const now = useNow(60_000);
  const q = useDashboard();
  useDocumentTitle('Dashboard');

  // A brand-new org (no onboarding state at all) is guided through onboarding once per browser session.
  const fresh = !!me && Object.keys(me.org.onboardingState ?? {}).length === 0 && can('bid_manager');
  let redirect = false;
  if (fresh) {
    try { redirect = sessionStorage.getItem(ONBOARDING_REDIRECT_KEY) !== me!.org.id; } catch { redirect = false; }
  }
  useEffect(() => {
    if (redirect) try { sessionStorage.setItem(ONBOARDING_REDIRECT_KEY, me!.org.id); } catch { /* private mode */ }
  }, [redirect, me]);
  if (redirect) return <Navigate to="/onboarding" replace />;

  const firstName = me?.user.name.split(' ')[0] ?? '';
  const d = q.data;
  // FR-073: setup is a bid_manager+ job (analysts/viewers get Go / No-Go in its place). FR-071/072: persona widgets.
  const gate = roleGate(role);
  const showSetup = !!d && !d.setupComplete && gate.setupCard;
  const showPersona = gate.persona; // viewers see neither widget
  const isOwner = gate.ownerLayout;
  const persona = (
    <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
      <MyBidsCard items={d?.myWork} />
      <DecisionsCard items={d?.awaitingDecision} />
    </div>
  );

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-muted-foreground">
            {now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}
          </p>
          <h1 className="mt-1 text-[22px] font-semibold leading-tight tracking-tight sm:text-2xl">
            {greeting(now)}{firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            {d ? summaryLine(d) : <span className="inline-block"><Skeleton className="h-4 w-72" /></span>}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {d?.demo && <Badge tone="accent" size="lg"><FlaskConical /> Demo data</Badge>}
          <Button variant="secondary" asChild><Link to="/pipeline"><KanbanSquare /> Pipeline</Link></Button>
          <Button asChild><Link to="/tenders?matched=1">Review matches <ArrowRight /></Link></Button>
        </div>
      </header>

      {q.isError && !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          {/* FR-012: a failed background refresh keeps the cached widgets and shows a non-blocking banner. */}
          {q.isError && d && <StaleBanner generatedAt={d.generatedAt} onRetry={() => q.refetch()} retrying={q.isFetching} />}
          {d?.demo && <DemoBanner />}
          <KpiGrid d={d} />
          {showPersona && !isOwner && persona}
          {d && isEmptyOrg(d) && <GetStartedBanner />}
          <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
            <ClosingSoon d={d} className="lg:col-span-2" />
            {showSetup ? <SetupCard d={d} /> : <VerdictCard d={d} />}
          </div>
          {showPersona && isOwner && persona}
          <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
            <Card className="lg:col-span-2">
              <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
                <div>
                  <CardTitle>New matches</CardTitle>
                  <CardDescription>Tenders matching your watchlists, per day (IST), last 14 days</CardDescription>
                </div>
                {d && <span className="tabular text-2xl font-semibold tracking-tight">{formatNumberIN(d.matchesByDay.reduce((a, b) => a + b.count, 0))}</span>}
              </CardHeader>
              <CardContent>{d ? <MatchesTrend data={d.matchesByDay} /> : <Skeleton className="h-56 w-full" />}</CardContent>
            </Card>
            {showSetup ? <VerdictCard d={d} /> : <ExpiringCard d={d} />}
          </div>
          <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
            <Card>
              <CardHeader>
                <CardTitle>Pipeline</CardTitle>
                <CardDescription>Bids by stage and estimated value</CardDescription>
              </CardHeader>
              <CardContent>{d ? <PipelineFunnel pipeline={d.pipeline} value={d.pipelineValue} /> : <SkeletonRows n={7} />}</CardContent>
            </Card>
            {showSetup ? <ExpiringCard d={d} /> : <RecentMatches d={d} />}
            <ActivityCard d={d} />
          </div>
          {showSetup && <RecentMatches d={d} />}
        </>
      )}
    </div>
  );
}

function KpiGrid({ d }: { d?: DashboardResponse }) {
    const tiles: { label: ReactNode; value: ReactNode; icon: LucideIcon; tone: 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info'; to: string; delta?: number | null; hint?: ReactNode; sparkline?: ReactNode; invert?: boolean }[] = [
    {
      label: 'New matches today', value: d ? formatNumberIN(d.tiles.newMatchesToday) : '', icon: Radar, tone: 'primary', to: '/tenders?matched=1',
      delta: d ? pctDelta(d.tiles.newMatchesToday, d.stats.newMatchesYesterday) : null, hint: 'vs yesterday',
    },
    {
      label: <Tooltip content="Open bids matched or in your pipeline, closing in the next 7 days."><span className="cursor-help underline decoration-dotted underline-offset-4">Closing this week</span></Tooltip>,
      value: d ? formatNumberIN(d.tiles.closingThisWeek) : '', icon: CalendarClock, tone: d?.stats.closingToday ? 'danger' : 'warning',
      to: '/tenders?matched=1&closing=7&sort=endAt', hint: d ? (d.stats.closingToday ? <span className="font-medium text-danger">{d.stats.closingToday} today</span> : 'none today') : undefined,
    },
    { label: 'Active bids', value: d ? formatNumberIN(d.tiles.activeBids) : '', icon: KanbanSquare, tone: 'info', to: '/pipeline', hint: d ? `${d.pipeline.ready} ready to submit` : undefined },
    {
      label: <Tooltip content="Earnest Money Deposit on your active bids. MSEs with Udyam are usually exempt."><span className="cursor-help underline decoration-dotted underline-offset-4">EMD at stake</span></Tooltip>,
      value: d ? formatINR(d.tiles.emdAtStake, { compact: d.tiles.emdAtStake >= 1e5 }) : '', icon: BadgeIndianRupee, tone: 'accent', to: '/pipeline', hint: 'across active bids',
    },
    {
      label: 'Win rate', value: d ? (d.tiles.winRate == null ? '—' : `${d.tiles.winRate}%`) : '', icon: Trophy, tone: 'success', to: '/pipeline?stage=won',
      hint: d ? (d.stats.won + d.stats.lost ? `${d.stats.won} won · ${d.stats.lost} lost` : 'no results yet') : undefined,
    },
    {
      label: 'Docs expiring', value: d ? formatNumberIN(d.tiles.expiringDocs) : '', icon: FileWarning, tone: d?.stats.expiredDocs ? 'danger' : 'warning', to: '/vault?status=expiring',
      hint: d ? (d.stats.expiredDocs ? <span className="font-medium text-danger">{d.stats.expiredDocs} expired</span> : 'within 30 days') : undefined,
    },
  ];
  return (
    <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t, i) => (
        <StatTile key={i} label={t.label} value={t.value} icon={t.icon} tone={t.tone} to={t.to} loading={!d}
          delta={t.delta} deltaLabel={t.delta != null ? t.hint : undefined} hint={t.delta == null ? t.hint : undefined} sparkline={t.sparkline} />
      ))}
    </section>
  );
}

function GetStartedBanner() {
  const seed = useSeedDemo();
  const { can } = useAuth();
  return (
    <Card className="relative overflow-hidden border-primary/20">
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_right,black,transparent_70%)]" aria-hidden />
      <div className="relative flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="flex items-start gap-4">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary"><Sparkles className="size-5" /></span>
          <div>
            <h2 className="text-base font-semibold tracking-tight">Your command centre fills up as GeM bids arrive</h2>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">Create a watchlist to start matching live tenders — or load a realistic sample company to see eligibility scores, the pipeline and bid packets in action.</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {can('bid_manager') && (
            <Button variant="secondary" loading={seed.isPending}
              onClick={() => seed.mutate(undefined, { onSuccess: () => toast.success('Demo data loaded — explore away!'), onError: (e) => toast.error(errorMessage(e)) })}>
              {!seed.isPending && <FlaskConical />} Explore with demo data
            </Button>
          )}
          {can('analyst') ? (
            <Button asChild><Link to="/watchlists?new=1"><Radar /> Create a watchlist</Link></Button>
          ) : (
            <p className="max-w-60 self-center text-sm text-muted-foreground">{ASK_FOR_WATCHLISTS}</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function ClosingSoon({ d, className }: { d?: DashboardResponse; className?: string }) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Closing soon</CardTitle>
          <CardDescription>Matched or in-pipeline bids closing in the next 7 days</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild><Link to="/tenders?matched=1&sort=endAt">View all <ArrowRight /></Link></Button>
      </CardHeader>
      <CardContent className="flex-1">
        {!d ? <SkeletonRows n={5} tall /> : d.closingSoon.length === 0 ? (
          <EmptyState compact icon={CalendarClock} title="Nothing closing this week" body="Bids that match your watchlists and close within 7 days will show up here with a countdown." />
        ) : (
          <ul className="-mx-2 divide-y">
            {d.closingSoon.map((t) => <ClosingRow key={t.id} t={t} />)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ClosingRow({ t }: { t: DashboardTenderRef }) {
  const href = t.workspace ? `/workspaces/${t.workspace.id}` : `/tenders/${t.id}`;
  return (
    <li>
      <Link to={href} className="flex items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-muted/60 focus-ring">
        <ScoreRing score={t.analysis?.score} verdict={t.analysis?.verdict ?? undefined} size={40} animate={false} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{t.title}</p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <span className="font-mono">{t.bidNumber}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{t.buyer ?? 'Buyer not published'}{t.state ? `, ${t.state}` : ''}</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Countdown to={t.endAt} compact />
          <div className="flex items-center gap-1.5">
            {t.workspace ? <StageBadge stage={t.workspace.stage as Stage} size="sm" /> : t.analysis?.verdict ? <VerdictBadge verdict={t.analysis.verdict} size="sm" showIcon={false} /> : null}
            {t.emdAmount ? <span className="hidden text-2xs text-muted-foreground tabular sm:inline">EMD {formatINRCompact(t.emdAmount)}</span> : null}
          </div>
        </div>
      </Link>
    </li>
  );
}

function SetupCard({ d }: { d: DashboardResponse }) {
  const done = d.setup.filter((s) => s.done).length;
  const pct = Math.round((done / d.setup.length) * 100);
  const next = d.setup.find((s) => !s.done);
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Finish setting up</CardTitle>
          <span className="tabular text-xs font-medium text-muted-foreground">{done}/{d.setup.length}</span>
        </div>
        <Progress value={pct} className="mt-2" />
      </CardHeader>
      <CardContent className="flex-1">
        <ul className="flex flex-col gap-1">
          {d.setup.map((s) => (
            <li key={s.key}>
              <Link to={s.href} className={cn('flex items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted/60 focus-ring', s === next && 'bg-primary-soft/60')}>
                {s.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Done" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="To do" />}
                <span className="min-w-0">
                  <span className={cn('block text-sm font-medium', s.done && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{s.label}</span>
                  {!s.done && <span className="block text-xs text-muted-foreground">{s.description}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <Button variant="link" size="sm" className="mt-2 px-2" asChild><Link to="/onboarding">Open the guided setup <ArrowRight /></Link></Button>
      </CardContent>
    </Card>
  );
}

function VerdictCard({ d }: { d?: DashboardResponse }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Go / No-Go</CardTitle>
        <CardDescription>Latest eligibility verdict per analysed tender</CardDescription>
      </CardHeader>
      <CardContent>{d ? <VerdictDonut verdicts={d.verdicts} /> : <Skeleton className="mx-auto size-40 rounded-full" />}</CardContent>
    </Card>
  );
}

function ExpiringCard({ d }: { d?: DashboardResponse }) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Expiring documents</CardTitle>
          <CardDescription>Renew before they block a bid</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild><Link to="/vault?status=expiring">Vault <ArrowRight /></Link></Button>
      </CardHeader>
      <CardContent className="flex-1">
        {!d ? <SkeletonRows n={4} /> : d.expiringDocuments.length === 0 ? (
          <EmptyState compact icon={CheckCircle2} title="All documents are valid" body="We’ll remind you 30, 7 and 1 day before anything expires." />
        ) : (
          <ul className="flex flex-col gap-1">
            {d.expiringDocuments.map((doc) => (
              <li key={doc.id}>
                <Link to="/vault?status=expiring" className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/60 focus-ring">
                  <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', doc.status === 'expired' ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning')}>
                    <FileWarning className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{doc.title}</span>
                    <span className="block text-xs text-muted-foreground">{formatDateIST(doc.expiryDate)}</span>
                  </span>
                  <Badge tone={doc.status === 'expired' ? 'danger' : 'warning'} size="sm" className="shrink-0">
                    {doc.status === 'expired' ? `Expired ${Math.abs(doc.daysToExpiry)}d ago` : doc.daysToExpiry === 0 ? 'Today' : `${doc.daysToExpiry}d left`}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RecentMatches({ d }: { d?: DashboardResponse }) {
  const { can } = useAuth();
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Latest matches</CardTitle>
          <CardDescription>Fresh from your watchlists</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild><Link to="/tenders?matched=1">Feed <ArrowRight /></Link></Button>
      </CardHeader>
      <CardContent className="flex-1">
        {!d ? <SkeletonRows n={4} /> : d.recentMatches.length === 0 ? (
          <EmptyState compact icon={Radar} title="No matches yet" body={can('analyst') ? 'Create a watchlist and we’ll match every new GeM bid against it.' : ASK_FOR_WATCHLISTS}
            action={can('analyst') ? <Button size="sm" asChild><Link to="/watchlists?new=1">Create watchlist</Link></Button> : undefined} />
        ) : (
          <ul className="flex flex-col gap-1">
            {d.recentMatches.map((m) => (
              <li key={m.id}>
                <Link to={`/tenders/${m.id}`} className="block rounded-lg px-2 py-2 hover:bg-muted/60 focus-ring">
                  <span className="flex items-center gap-2">
                    {m.isNew && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="New" />}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.title}</span>
                    {m.estimatedValue ? <span className="tabular shrink-0 text-xs font-medium">{formatINRCompact(m.estimatedValue)}</span> : null}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{m.buyer}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{relativeTime(m.matchedAt)}</span>
                  </span>
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    <Badge size="sm" tone="primary">{m.watchlistName}</Badge>
                    {m.reasons.slice(0, 2).map((r) => <Badge key={r} size="sm" tone="outline">{r}</Badge>)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityCard({ d }: { d?: DashboardResponse }) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Team activity</CardTitle>
        <CardDescription>Every important action, as it happens</CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        {!d ? <SkeletonRows n={5} /> : d.activity.length === 0 ? (
          <EmptyState compact icon={PartyPopper} title="It’s quiet here" body="Uploads, analyses and pipeline moves by your team will appear here." />
        ) : (
          <ol className="scrollbar-thin relative -mr-2 grid max-h-[520px] gap-4 overflow-y-auto pr-2 before:absolute before:bottom-2 before:left-[13px] before:top-2 before:w-px before:bg-border">
            {d.activity.map((a) => <ActivityRow key={a.id} a={a} />)}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityRow({ a }: { a: DashboardActivity }) {
  const showTarget = a.target && !SELF_CONTAINED.has(a.action);
  return (
    <li className="relative flex gap-3">
      <Avatar name={a.user?.name ?? 'TenderPilot'} size="sm" className="relative z-[1]" />
      <div className="min-w-0 flex-1 text-[13px] leading-snug">
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{a.user?.name ?? 'TenderPilot'}</span>{' '}
          {describeActivity(a)}
          {showTarget && <>{' '}<Link to={a.target!.href} className="font-medium text-foreground hover:underline focus-ring rounded">{a.target!.label}</Link></>}
        </p>
        <time className="text-2xs text-muted-foreground" dateTime={a.createdAt} title={formatDateIST(a.createdAt, { time: true })}>{relativeTime(a.createdAt)}</time>
      </div>
    </li>
  );
}

function SkeletonRows({ n, tall }: { n: number; tall?: boolean }) {
  return (
    <div className="grid gap-3" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className={cn('shrink-0 rounded-full', tall ? 'size-10' : 'size-8')} />
          <div className="grid flex-1 gap-1.5"><Skeleton className="h-3.5 w-4/5" /><Skeleton className="h-3 w-1/2" /></div>
        </div>
      ))}
    </div>
  );
}
