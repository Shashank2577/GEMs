/**
 * Tender detail — the "aha" screen (T046, US2): hero with key facts and actions, Go/No-Go analysis
 * with evidence, requirements, documents and history.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Bot, CheckCircle2, FileSearch, FileText, Gauge, History, ListChecks, RefreshCw, ShieldCheck, Sparkles, TriangleAlert, Upload } from 'lucide-react';
import type { AnalysisDto } from '@tp/core/contracts/analyse';
import {
  Badge, Button, Card, EmptyState, ErrorState, Skeleton, SkeletonText, Tabs, TabsContent, TabsList, TabsTrigger, toast,
} from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { RoleGate, useCan } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';
import { AnalysingState } from './AnalysingState';
import { AnalysisPanel } from './AnalysisPanel';
import { DocumentsTab } from './DocumentsTab';
import { HistoryTab } from './HistoryTab';
import { RequirementsTab } from './RequirementsTab';
import { TenderHero } from './TenderHero';
import { isAnalysisRunningError, tenderKeys, useAnalyse, useAnalysis, useAnalysisCapabilities, useDismiss, useRescore, useStartBid, useTender, useTenderDocuments } from './api';
import { canRescoreFor, isAnalysisRunning, staleReasonCopy, staleSinceCopy } from './labels';

const TABS = ['analysis', 'requirements', 'documents', 'history'] as const;
type Tab = (typeof TABS)[number];

export default function TenderPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'analysis';
  const setTab = (t: string) => setParams((p) => { const n = new URLSearchParams(p); if (t === 'analysis') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true });

  const tender = useTender(id);
  const analysisQ = useAnalysis(id);
  const docs = useTenderDocuments(id);
  const analyse = useAnalyse(id);
  const capabilities = useAnalysisCapabilities();
  const rescore = useRescore(id);
  const startBid = useStartBid(id);
  const dismiss = useDismiss(id);
  const canAnalyse = useCan('analyst');
  const qc = useQueryClient();
  // FR-028/FR-029: another member's run (lastAttempt running, polled every 3 s) or a 409 whose refetch is in flight.
  const running = isAnalysisRunning(analysisQ.data);
  const analyseBlocked = running || (isAnalysisRunningError(analyse.error) && analysisQ.isFetching);
  useDocumentTitle(tender.data ? `${tender.data.bidNumber} · ${tender.data.title}` : 'Tender');

  // Mark a new match as seen once opened.
  const marked = useRef(false);
  useEffect(() => {
    if (tender.data?.isNew && !marked.current) {
      marked.current = true;
      api.post(`/tenders/${id}/seen`).catch(() => {});
    }
  }, [tender.data?.isNew, id]);

  // When a run we were polling finishes, refresh the hero score, documents and history too.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      qc.invalidateQueries({ queryKey: tenderKeys.detail(id), exact: true });
      qc.invalidateQueries({ queryKey: tenderKeys.activity(id) });
    }
    wasRunning.current = running;
  }, [running, qc, id]);

  const runAnalyse = () => {
    if (analyseBlocked) return;
    setTab('analysis');
    analyse.mutate(undefined, {
      onSuccess: (a) => toast.success(`${a.verdict === 'go' ? 'Go' : a.verdict === 'review' ? 'Review' : 'No-Go'} · ${a.score}/100`, {
        description: a.method === 'rules+llm' ? 'Rules + AI analysis complete' : 'Rules-only analysis complete',
      }),
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'no_documents') {
          toast.error('Add the bid document first', { description: e.message, action: { label: 'Upload PDF', onClick: () => setTab('documents') } });
          setTab('documents');
        } else if (isAnalysisRunningError(e)) {
          toast(e instanceof Error ? e.message : 'An analysis is already running for this tender', { description: 'The result will appear here when it finishes.' });
        } else toast.error(errorMessage(e, 'Analysis failed'));
      },
    });
  };

  const runRescore = () => {
    if (!analysis || analyseBlocked) return;
    rescore.mutate(analysis.id, {
      onSuccess: (a) => toast.success(`Re-scored · ${a.score}/100`, { description: 'Updated with your current profile, vault and weights.' }),
      onError: (e) => toast.error(errorMessage(e, 'Re-score failed')),
    });
  };

  const onStartBid = () => startBid.mutate(undefined, {
    onSuccess: (wid) => { toast.success('Bid workspace ready'); navigate(`/workspaces/${wid}`); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const onDismiss = () => dismiss.mutate(undefined, {
    onSuccess: () => { toast('Tender dismissed', { description: 'It will no longer show in your feed.' }); navigate('/tenders'); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (tender.isLoading) return <TenderSkeleton />;
  if (tender.isError) {
    const nf = tender.error instanceof ApiError && tender.error.status === 404;
    return (
      <>
        <BackLink />
        {nf ? (
          <EmptyState icon={FileSearch} title="Tender not found" body="It may have been removed from GeM, or the link is wrong." action={<Button asChild><Link to="/tenders">Back to tenders</Link></Button>} />
        ) : <ErrorState error={tender.error} onRetry={() => tender.refetch()} retrying={tender.isFetching} />}
      </>
    );
  }
  const t = tender.data!;
  const analysis: AnalysisDto | null = analysisQ.data ?? null;
  const docCount = docs.data?.total ?? t.documents.length;
  const hasGemLink = !!(t.gemBidId || t.documentUrl);
  const stale = !!analysis?.stale || (!!t.analysis?.stale && analysis?.id === t.analysis.id);
  const staleSince = staleSinceCopy(analysis?.staleAt);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6">
      <nav aria-label="Breadcrumb" className="-mb-2">
        <ol className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground">
          <li><Link to="/tenders" className="inline-flex items-center gap-1 rounded hover:text-foreground focus-ring"><ArrowLeft className="size-3.5" aria-hidden /> Tenders</Link></li>
          <li aria-hidden className="opacity-60">/</li>
          <li aria-current="page" className="truncate font-mono text-xs text-foreground/80">{t.bidNumber}</li>
        </ol>
      </nav>
      <TenderHero
        tender={t} analysis={analysis} analysing={analyse.isPending} analyseDisabled={analyseBlocked} onAnalyse={runAnalyse}
        onStartBid={onStartBid} startingBid={startBid.isPending} onDismiss={onDismiss} dismissing={dismiss.isPending}
      />

      <Tabs value={tab} onValueChange={setTab} id="analysis">
        <TabsList aria-label="Tender sections">
          <TabsTrigger value="analysis"><Gauge /> Analysis</TabsTrigger>
          <TabsTrigger value="requirements"><ListChecks /> Requirements {analysis?.requirements.length ? <Badge size="sm" className="tabular">{analysis.requirements.length}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="documents"><FileText /> Documents {docCount ? <Badge size="sm" className="tabular">{docCount}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="history"><History /> History {t.hasCorrigendum && <span className="size-1.5 rounded-full bg-warning" aria-label="corrigendum" />}</TabsTrigger>
        </TabsList>

        <TabsContent value="analysis" className="grid gap-4">
          {stale && !analyse.isPending && (
            <div role="status" className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning-soft/60 p-4 sm:flex-row sm:items-center">
              <TriangleAlert className="size-5 shrink-0 text-[hsl(32_90%_36%)] dark:text-warning" aria-hidden />
              <div className="min-w-0 flex-1 text-sm">
                <div className="font-semibold">
                  Re-analysis needed
                  {staleSince && <span className="text-xs font-normal text-muted-foreground"> · {staleSince}</span>}
                </div>
                <div className="text-muted-foreground">{staleReasonCopy(analysis?.staleReason)}</div>
              </div>
              <RoleGate min="analyst">
                {canRescoreFor(analysis?.staleReason) && analysis ? (
                  <Button size="sm" variant="secondary" onClick={runRescore} loading={rescore.isPending} disabled={analyseBlocked}><RefreshCw /> Re-score</Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={runAnalyse} disabled={analyseBlocked}><RefreshCw /> Re-analyse now</Button>
                )}
              </RoleGate>
            </div>
          )}
          {analyse.isPending ? <AnalysingState withAi={!!capabilities.data?.ai} /> : analysisQ.isLoading ? <AnalysisSkeleton /> : analysisQ.isError ? (
            <ErrorState error={analysisQ.error} onRetry={() => analysisQ.refetch()} />
          ) : analysis ? (
            <AnalysisPanel analysis={analysis} tenderId={id} onReanalyse={runAnalyse} reanalysing={analyse.isPending} canAnalyse={canAnalyse} hasWorkspace={!!t.workspace} analyseDisabled={analyseBlocked} />
          ) : (
            <AnalyseEmpty canAnalyse={canAnalyse} hasDocs={docCount > 0} hasGemLink={hasGemLink} onAnalyse={runAnalyse} onUpload={() => setTab('documents')} />
          )}
        </TabsContent>
        <TabsContent value="requirements">
          <RequirementsTab analysis={analysis} tenderId={id} documents={docs.data?.items} bidNumber={t.bidNumber} />
        </TabsContent>
        <TabsContent value="documents">
          <DocumentsTab tenderId={id} hasGemLink={hasGemLink} hasAnalysis={!!analysis} onReanalyse={runAnalyse} />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab tenderId={id} events={t.events} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/tenders" className="mb-4 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground focus-ring">
      <ArrowLeft className="size-4" aria-hidden /> All tenders
    </Link>
  );
}

const CHECKS = [
  'Minimum turnover & years of experience',
  'EMD, ePBG and MSE / Startup exemptions',
  'Make in India class and OEM authorisation',
  'ATC certificates and every document to upload',
];

function AnalyseEmpty({ canAnalyse, hasDocs, hasGemLink, onAnalyse, onUpload }: { canAnalyse: boolean; hasDocs: boolean; hasGemLink: boolean; onAnalyse: () => void; onUpload: () => void }) {
  const ready = hasDocs || hasGemLink;
  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-40 [mask-image:radial-gradient(ellipse_at_top_right,black,transparent_65%)]" aria-hidden />
      <div className="relative grid gap-8 p-6 sm:p-8 md:grid-cols-[1fr_auto] md:items-center">
        <div>
          <Badge tone="primary" className="mb-3"><Sparkles /> Go / No-Go in under a minute</Badge>
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">Should you bid on this tender?</h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            TenderPilot reads the GeM bid document, extracts every eligibility condition with the page it came from, and scores it against your company profile and vault.
          </p>
          <ul className="mt-5 grid gap-2 sm:grid-cols-2">
            {CHECKS.map((c) => (
              <li key={c} className="flex items-start gap-2 text-sm"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> {c}</li>
            ))}
          </ul>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {canAnalyse ? (
              ready ? (
                <Button size="lg" onClick={onAnalyse}><Gauge /> Analyse eligibility</Button>
              ) : (
                <Button size="lg" onClick={onUpload}><Upload /> Upload the bid PDF</Button>
              )
            ) : <p className="text-sm text-muted-foreground">Ask an analyst or bid manager on your team to run the analysis.</p>}
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck className="size-3.5" aria-hidden /> Works without AI keys · <Bot className="size-3.5" aria-hidden /> AI adds ATC extras when enabled</span>
          </div>
        </div>
        <div className="hidden md:block" aria-hidden>
          <div className="relative flex size-44 items-center justify-center rounded-full border-[10px] border-muted">
            <div className="absolute inset-[-10px] rounded-full border-[10px] border-transparent border-t-primary/60 border-r-primary/30" />
            <div className="text-center">
              <div className="text-4xl font-semibold tracking-tight text-muted-foreground/60">?</div>
              <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Score</div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function AnalysisSkeleton() {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid gap-6">
        <Card className="flex gap-6 p-6"><Skeleton className="size-32 rounded-full" /><div className="flex-1"><Skeleton className="h-6 w-40" /><SkeletonText lines={3} className="mt-4" /></div></Card>
        <Card className="grid gap-4 p-5">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="flex gap-3"><Skeleton className="size-9 rounded-lg" /><div className="flex-1"><Skeleton className="h-4 w-1/3" /><Skeleton className="mt-2 h-3 w-2/3" /></div></div>)}</Card>
      </div>
      <Card className="grid content-start gap-3 p-5">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</Card>
    </div>
  );
}

function TenderSkeleton() {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-6" aria-busy="true" aria-label="Loading tender">
      <Skeleton className="h-4 w-48" />
      <Card className="grid gap-5 p-6">
        <div className="flex gap-2"><Skeleton className="h-7 w-44" /><Skeleton className="h-7 w-16" /></div>
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
        <div className="flex gap-2"><Skeleton className="h-10 w-44" /><Skeleton className="h-10 w-32" /></div>
      </Card>
      <Skeleton className="h-9 w-80" />
      <AnalysisSkeleton />
    </div>
  );
}
