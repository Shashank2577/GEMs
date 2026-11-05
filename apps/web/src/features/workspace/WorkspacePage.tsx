/**
 * Bid workspace (T066; US4, US5): Qualify → Documents → Annexures → Packet → Submit, with comments and
 * activity in a right rail (desktop) or a tab (mobile). TenderPilot prepares; the human prices,
 * authenticates and submits on GeM (Constitution I).
 */
import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Briefcase, Check, ChevronRight, FileSignature, FileStack, FolderCheck, Gauge, MessageSquare, Send } from 'lucide-react';
import type { WorkspaceDetail } from '@tp/core/contracts/apply';
import { Button, EmptyState, ErrorState, Segmented, Skeleton, SkeletonList } from '@/components/ui';
import { useDocumentTitle } from '@/lib/hooks';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWorkspace } from './api';
import { ActivityRail } from './ActivityRail';
import { AnnexuresStep } from './AnnexuresStep';
import { DocumentsStep } from './DocumentsStep';
import { PacketStep } from './PacketStep';
import { QualifyStep } from './QualifyStep';
import { SubmitStep } from './SubmitStep';
import { WorkspaceHeader } from './WorkspaceHeader';

const STEPS = [
  { key: 'qualify', label: 'Qualify', icon: Gauge },
  { key: 'documents', label: 'Documents', icon: FolderCheck },
  { key: 'annexures', label: 'Annexures', icon: FileSignature },
  { key: 'packet', label: 'Packet', icon: FileStack },
  { key: 'submit', label: 'Submit', icon: Send },
] as const;
type StepKey = (typeof STEPS)[number]['key'];

function stepStatus(d: WorkspaceDetail): Record<StepKey, { done: boolean; hint: string }> {
  const a = d.analysis;
  const submitted = !!d.workspace.submittedAt || ['submitted', 'won', 'lost'].includes(d.workspace.stage);
  const required = d.annexures.filter((x) => x.required);
  return {
    qualify: { done: !!a && a.status === 'done', hint: a?.score != null ? `Score ${a.score}` : 'Not analysed' },
    documents: { done: d.readiness.canMarkReady && !!a, hint: !d.readiness.analysed ? 'Not analysed' : `${d.readiness.percent}% ready` }, // FR-009/FR-023
    annexures: { done: !!a && required.every((x) => !x.missing.length), hint: `${required.length} required` },
    packet: { done: d.packets.some((p) => p.status === 'ready'), hint: d.packets[0]?.pageCount ? `${d.packets[0].pageCount} pages` : 'Not built' },
    submit: { done: submitted, hint: submitted ? 'Submitted' : 'Human-only' },
  };
}

function defaultStep(d: WorkspaceDetail): StepKey {
  const s = stepStatus(d);
  if (!s.qualify.done) return 'qualify';
  if (['ready', 'submitted', 'won', 'lost'].includes(d.workspace.stage)) return 'submit';
  if (!s.documents.done) return 'documents';
  if (!s.packet.done) return 'packet';
  return 'submit';
}

export default function WorkspacePage() {
  const { id = '' } = useParams();
  const q = useWorkspace(id);
  const [params, setParams] = useSearchParams();
  const reduce = useReducedMotion();

  const data = q.data;
  const status = useMemo(() => (data ? stepStatus(data) : null), [data]);
  const step = (STEPS.some((s) => s.key === params.get('step')) ? params.get('step') : data ? defaultStep(data) : 'qualify') as StepKey;
  const view = params.get('view') === 'discussion' ? 'discussion' : 'steps';
  const annexure = params.get('annexure');

  const go = (s: string, extra: Record<string, string> = {}) => setParams((p) => {
    const n = new URLSearchParams(p);
    n.set('step', s);
    n.delete('view');
    for (const [k, v] of Object.entries(extra)) n.set(k, v);
    return n;
  }, { replace: false });
  const setView = (v: 'steps' | 'discussion') => setParams((p) => { const n = new URLSearchParams(p); if (v === 'steps') n.delete('view'); else n.set('view', v); return n; }, { replace: true });

  if (q.isLoading) return <WorkspaceSkeleton />;
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return <EmptyState icon={Briefcase} title="Bid workspace not found" body="It may belong to another organisation, or the link is wrong." action={<Button asChild><Link to="/pipeline">Go to pipeline</Link></Button>} />;
    }
    return <ErrorState error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />;
  }
  if (!data || !status) return null;

  const idx = STEPS.findIndex((s) => s.key === step);
  const next = () => go(STEPS[Math.min(idx + 1, STEPS.length - 1)].key);

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <DocTitle title={`${data.tender.bidNumber} · Bid workspace`} />
      <nav aria-label="Breadcrumb" className="mb-3">
        <ol className="flex items-center gap-1 text-[13px] text-muted-foreground">
          <li><Link to="/pipeline" className="rounded hover:text-foreground focus-ring">Pipeline</Link></li>
          <ChevronRight className="size-3.5 opacity-60" aria-hidden />
          <li aria-current="page" className="truncate font-mono text-xs text-foreground/80">{data.tender.bidNumber}</li>
        </ol>
      </nav>
      <WorkspaceHeader data={data} onGoToStep={(s) => go(s)} />

      <div className="mt-4 lg:hidden">
        <Segmented
          value={view} onChange={setView} aria-label="Workspace view" className="w-full [&>button]:flex-1"
          options={[{ value: 'steps', label: 'Bid steps' }, { value: 'discussion', label: `Discussion${data.comments.length ? ` (${data.comments.length})` : ''}`, icon: <MessageSquare /> }]}
        />
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className={cn('min-w-0', view === 'discussion' && 'hidden lg:block')}>
          <nav aria-label="Bid steps" className="-mx-4 mb-5 overflow-x-auto px-4 scrollbar-thin sm:mx-0 sm:px-0">
            <ol className="flex min-w-max gap-1.5 sm:min-w-0 sm:grid sm:grid-cols-5">
              {STEPS.map((s, i) => {
                const st = status[s.key];
                const active = s.key === step;
                const Icon = s.icon;
                return (
                  <li key={s.key} className="min-w-[132px] sm:min-w-0">
                    <button
                      type="button" onClick={() => go(s.key)} aria-current={active ? 'step' : undefined}
                      className={cn(
                        'group flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all focus-ring',
                        active ? 'border-primary/50 bg-primary-soft/60 shadow-sm' : 'bg-card hover:border-primary/25 hover:bg-muted/40',
                      )}
                    >
                      <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                        st.done ? 'bg-success text-success-foreground' : active ? 'bg-primary text-primary-foreground' : 'border bg-background text-muted-foreground')}>
                        {st.done ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : <Icon className="size-3.5" aria-hidden />}
                      </span>
                      <span className="min-w-0">
                        <span className={cn('block truncate text-[13px] font-semibold leading-tight', !active && 'text-foreground/85')}><span className="text-muted-foreground">{i + 1}.</span> {s.label}</span>
                        <span className="block truncate text-2xs text-muted-foreground">{st.hint}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          <motion.div key={step} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: 'easeOut' }}>
            {step === 'qualify' && <QualifyStep data={data} onNext={next} />}
            {step === 'documents' && <DocumentsStep data={data} onNext={next} onOpenAnnexure={(k) => go('annexures', { annexure: k })} />}
            {step === 'annexures' && <AnnexuresStep data={data} selected={annexure} onSelect={(k) => setParams((p) => { const n = new URLSearchParams(p); n.set('annexure', k); return n; }, { replace: true })} onNext={next} />}
            {step === 'packet' && <PacketStep data={data} onNext={next} />}
            {step === 'submit' && <SubmitStep data={data} />}
          </motion.div>
        </div>

        <aside className={cn('min-w-0 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:pr-1 scrollbar-thin', view === 'steps' && 'hidden lg:block')} aria-label="Discussion and activity">
          <ActivityRail data={data} />
        </aside>
      </div>
    </div>
  );
}

function DocTitle({ title }: { title: string }) {
  useDocumentTitle(title);
  return null;
}

function WorkspaceSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1400px]" aria-busy="true" aria-label="Loading bid workspace">
      <Skeleton className="mb-5 h-4 w-48" />
      <div className="rounded-xl border p-6"><Skeleton className="h-6 w-40" /><Skeleton className="mt-4 h-7 w-3/4" /><Skeleton className="mt-3 h-4 w-1/2" /><Skeleton className="mt-6 h-9 w-72" /></div>
      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div><div className="mb-5 grid grid-cols-5 gap-1.5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div><SkeletonList rows={5} /></div>
        <div className="hidden lg:block"><SkeletonList rows={4} /></div>
      </div>
    </div>
  );
}
