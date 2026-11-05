import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertOctagon, Bot, ChevronDown, Cpu, ExternalLink, Gavel, History, Info, Loader2, Quote, RefreshCw, ShieldAlert, TriangleAlert, UserRoundPen } from 'lucide-react';
import type { AnalysisDto, FactorStatus, Requirement, ScoreFactor } from '@tp/core/contracts/analyse';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, Field, Progress, ScoreRing, Segmented, Textarea, Tooltip, VerdictBadge, toast,
} from '@/components/ui';
import { apiUrl, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { checklistReadiness } from '@tp/core/analyse/checklist';
import { useVault } from '@/features/vault/api';
import { useOverride } from './api';
import { ChecklistCard } from './ChecklistCard';
import { FACTOR_HELP, FACTOR_ICON, STATUS_META, analysisPanelState, analysisWarningText, failedAttemptCopy, friendlyAnalysisError, isAnalysisRunning, truncatedDocuments } from './labels';

const eff = (f: ScoreFactor): FactorStatus => f.overridden?.status ?? f.status;

/** Link to a page of a tender document, opened inline in a new tab (pdf.js / browser viewer honours #page). */
export function pageHref(tenderId: string, r: Pick<Requirement, 'source'> | undefined) {
  if (!r?.source.documentId) return null;
  return `${apiUrl(`/tenders/${tenderId}/documents/${r.source.documentId}/download`, { inline: 1 })}${r.source.page ? `#page=${r.source.page}` : ''}`;
}

export function PageChip({ tenderId, req, className }: { tenderId: string; req?: Requirement; className?: string }) {
  if (!req?.source.page) return null;
  const href = pageHref(tenderId, req);
  const label = `p. ${req.source.page}`;
  const cls = cn('inline-flex h-5 items-center gap-1 rounded-md border bg-card px-1.5 text-2xs font-medium text-muted-foreground tabular', className);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={cn(cls, 'hover:border-primary/40 hover:text-primary focus-ring')} aria-label={`${label}: Open ${req.source.fileName ?? 'document'} at page ${req.source.page}`}>
      {label}<ExternalLink className="size-2.5" aria-hidden />
    </a>
  ) : <span className={cls}>{label}</span>;
}

/** Another member's analysis is running (FR-029): the page polls every 3 s until it finishes. */
export function AnalysisInProgress({ hasResult }: { hasResult: boolean }) {
  return (
    <div role="status" className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary-soft/50 p-4 text-sm">
      <Loader2 className="size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
      <div className="min-w-0">
        <div className="font-semibold">Analysis in progress…</div>
        <div className="text-muted-foreground">
          {hasResult ? 'Someone on your team is re-analysing this tender. The previous result is shown until it finishes.' : 'Someone on your team is analysing this tender. The result will appear here when it finishes.'}
        </div>
      </div>
    </div>
  );
}

/** US3 #15: the newest attempt failed; the previous result stays visible below (FR-029). */
function FailedAttemptWarning({ copy, canAnalyse, onReanalyse, reanalysing, disabled }: { copy: string; canAnalyse: boolean; onReanalyse: () => void; reanalysing: boolean; disabled: boolean }) {
  return (
    <div role="status" className="flex flex-col gap-3 rounded-xl border border-danger/30 bg-danger-soft/50 p-4 sm:flex-row sm:items-center">
      <TriangleAlert className="size-5 shrink-0 text-danger" aria-hidden />
      <p className="min-w-0 flex-1 text-sm">{copy}</p>
      {canAnalyse && <Button size="sm" variant="secondary" onClick={onReanalyse} loading={reanalysing} disabled={disabled}>{!reanalysing && <RefreshCw />} Try again</Button>}
    </div>
  );
}

export function AnalysisPanel({
  analysis, tenderId, onReanalyse, reanalysing, canAnalyse, hasWorkspace, analyseDisabled = false,
}: {
  analysis: AnalysisDto; tenderId: string; onReanalyse: () => void; reanalysing: boolean; canAnalyse: boolean; hasWorkspace: boolean;
  /** Another analysis is running (lastAttempt or a 409 analysis_running): keep Analyse buttons disabled (FR-028). */
  analyseDisabled?: boolean;
}) {
  const [overrideFor, setOverrideFor] = useState<ScoreFactor | null>(null);
  const canOverride = useCan('bid_manager');
  const reqByKey = useMemo(() => {
    const m = new Map<string, Requirement>();
    for (const r of analysis.requirements) if (!m.has(r.key)) m.set(r.key, r);
    return m;
  }, [analysis.requirements]);

  // Vault readiness for checklist rows (FR-040): only without a workspace; hidden if the vault query fails.
  const vault = useVault({}, { enabled: !hasWorkspace });
  const vaultItems = vault.data?.items;
  const readiness = useMemo(
    () => (hasWorkspace || vault.isError || !vaultItems ? null : checklistReadiness(analysis.checklist, vaultItems.map((d) => ({ type: d.type, title: d.title, expiryDate: d.expiryDate, tags: d.tags })), new Date())),
    [hasWorkspace, vault.isError, vaultItems, analysis.checklist],
  );

  const running = isAnalysisRunning(analysis);
  const failedCopy = failedAttemptCopy(analysis);
  const truncated = truncatedDocuments(analysis.documents);

  const state = analysisPanelState(analysis);
  if (state.kind === 'in_progress') return <AnalysisInProgress hasResult={false} />;

  if (state.kind === 'failed') {
    return (
      <Card className="border-danger/30">
        <CardContent className="flex flex-col items-start gap-3 p-6">
          <div className="flex items-center gap-2 font-semibold text-danger"><AlertOctagon className="size-5" /> The last analysis failed</div>
          <p className="text-sm text-muted-foreground">Reason: {friendlyAnalysisError(state.error)}. Try again, or upload a cleaner PDF in the Documents tab.</p>
          {canAnalyse && <Button size="sm" onClick={onReanalyse} loading={reanalysing} disabled={analyseDisabled}><RefreshCw /> Try again</Button>}
        </CardContent>
      </Card>
    );
  }

  const applicable = analysis.factors.filter((f) => eff(f) !== 'na');
  const na = analysis.factors.filter((f) => eff(f) === 'na');
  const order: FactorStatus[] = ['fail', 'unknown', 'pass', 'exempt'];
  const sorted = [...applicable].sort((a, b) => (Number(b.blocking && eff(b) === 'fail') - Number(a.blocking && eff(a) === 'fail')) || order.indexOf(eff(a)) - order.indexOf(eff(b)) || b.weight - a.weight);
  const maxW = Math.max(1, ...analysis.factors.map((f) => f.weight));

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid min-w-0 content-start gap-6">
        {running && <AnalysisInProgress hasResult />}
        {!running && failedCopy && <FailedAttemptWarning copy={failedCopy} canAnalyse={canAnalyse} onReanalyse={onReanalyse} reanalysing={reanalysing} disabled={analyseDisabled} />}
        {truncated.length > 0 && (
          <div data-testid="truncated-note" className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft/50 p-4 text-sm">
            <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p>{truncated.map((d) => `${d.fileName}: only the first ${d.analysed} of ${d.total} pages were read.`).join(' ')} Requirements later in the file were not analysed; upload the key sections as a separate PDF.</p>
          </div>
        )}
        <ScoreCard analysis={analysis} onReanalyse={onReanalyse} reanalysing={reanalysing} canAnalyse={canAnalyse} disabled={analyseDisabled} />

        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle>Factor breakdown</CardTitle>
              <CardDescription>Every factor that produced the score, with evidence from the bid.</CardDescription>
            </div>
            <Tooltip content="Weights are set per organisation in Settings → Scoring. Unknown counts as half.">
              <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex"><Info className="size-3.5" /> How scoring works</span>
            </Tooltip>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {sorted.map((f, i) => (
                <FactorRow
                  key={f.key} factor={f} index={i} maxWeight={maxW} tenderId={tenderId}
                  requirement={f.requirementKey ? reqByKey.get(f.requirementKey) : undefined}
                  canOverride={canOverride && analysis.status === 'done'} onOverride={() => setOverrideFor(f)}
                />
              ))}
            </ul>
            {na.length > 0 && <NotApplicable factors={na} canOverride={canOverride} onOverride={setOverrideFor} />}
          </CardContent>
        </Card>
      </div>

      <div className="grid content-start gap-6">
        <ChecklistCard items={analysis.checklist} hasWorkspace={hasWorkspace} readiness={readiness} vaultUnavailable={!hasWorkspace && vault.isError} />
      </div>

      <OverrideDialog analysis={analysis} factor={overrideFor} tenderId={tenderId} onClose={() => setOverrideFor(null)} />
    </div>
  );
}

function ScoreCard({ analysis, onReanalyse, reanalysing, canAnalyse, disabled }: { analysis: AnalysisDto; onReanalyse: () => void; reanalysing: boolean; canAnalyse: boolean; disabled: boolean }) {
  const reduce = useReducedMotion();
  const verdict = analysis.verdict ?? 'review';
  const conf = Math.round((analysis.confidence ?? 0) * 100);
  const counts = (['pass', 'exempt', 'fail', 'unknown'] as const).map((s) => ({ s, n: analysis.factors.filter((f) => eff(f) === s).length }));
  const blockers = analysis.factors.filter((f) => f.blocking && eff(f) === 'fail');
  const glow = verdict === 'go' ? 'from-success/15' : verdict === 'review' ? 'from-warning/15' : 'from-danger/15';
  const overridden = analysis.factors.filter((f) => f.overridden).length;

  return (
    <Card className="relative overflow-hidden">
      <div className={cn('pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b to-transparent', glow)} aria-hidden />
      <div className="relative grid gap-6 p-5 sm:p-6 md:grid-cols-[auto_1fr]">
        <motion.div initial={reduce ? false : { scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 160, damping: 18 }} className="flex justify-center md:block">
          <ScoreRing score={analysis.score} verdict={verdict} size={136} label="Score" />
        </motion.div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <VerdictBadge verdict={verdict} size="lg" />
            {analysis.method === 'rules+llm' ? (
              <Tooltip content="Rules extracted the standard GeM fields; AI added ATC-specific requirements. AI never decides the verdict.">
                <span><Badge tone="accent"><Bot /> AI-assisted</Badge></span>
              </Tooltip>
            ) : (
              <Tooltip content="Deterministic rules only — every value is traceable to a page of the bid document.">
                <span><Badge tone="neutral"><Cpu /> Rules only</Badge></span>
              </Tooltip>
            )}
            {overridden > 0 && <Badge tone="primary"><UserRoundPen /> {overridden} overridden</Badge>}
            {analysis.stale && <Badge tone="warning"><History /> Outdated</Badge>}
          </div>
          <p className="mt-3 text-[15px] leading-relaxed text-foreground/90">{analysis.summary}</p>
          <AnalysisWarnings analysis={analysis} />
          {blockers.length > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/60 px-3 py-2 text-sm text-danger">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span><strong className="font-semibold">Hard blocker:</strong> {blockers.map((b) => b.label).join(', ')} — a failed blocker means No-Go regardless of score.</span>
            </div>
          )}
          <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <Tooltip content="Share of applicable factors the system could determine. Unknowns lower confidence instead of silently passing or failing.">
                  <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">Confidence <Info className="size-3" /></span>
                </Tooltip>
                <span className="tabular font-semibold">{conf}%</span>
              </div>
              <Progress value={conf} size="sm" tone="auto" aria-label={`Confidence ${conf}%`} />
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {counts.filter((c) => c.n > 0).map(({ s, n }) => (
                  <span key={s} className="inline-flex items-center gap-1.5"><span className={cn('size-2 rounded-full', STATUS_META[s].dot)} aria-hidden />{n} {STATUS_META[s].label.toLowerCase()}</span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground sm:flex-col sm:items-end">
              <span>Analysed {relativeTime(analysis.updatedAt)}</span>
              {canAnalyse && <Button size="xs" variant="ghost" onClick={onReanalyse} loading={reanalysing} disabled={disabled}>{!reanalysing && <RefreshCw />} Re-analyse</Button>}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Caveats of this analysis: AI budget/quota (008/FR-031, FR-037) and documents that could not be read. */
function AnalysisWarnings({ analysis }: { analysis: AnalysisDto }) {
  const lines = [...(analysis.warnings ?? []).map(analysisWarningText), ...(analysis.notes ?? [])];
  if (!lines.length) return null;
  return (
    <div role="status" aria-label="Analysis warnings" data-testid="analysis-warnings"
      className="mt-3 rounded-lg border border-warning/30 bg-warning-soft/60 px-3 py-2 text-sm">
    <ul className="grid gap-1.5">
      {lines.map((line) => (
        <li key={line} className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[hsl(32_90%_36%)] dark:text-warning" aria-hidden />
          <span>{line}</span>
        </li>
      ))}
    </ul>
    </div>
  );
}

function FactorRow({
  factor, requirement, maxWeight, tenderId, canOverride, onOverride, index,
}: {
  factor: ScoreFactor; requirement?: Requirement; maxWeight: number; tenderId: string; canOverride: boolean; onOverride: () => void; index: number;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const st = eff(factor);
  const meta = STATUS_META[st];
  const Icon = FACTOR_ICON[factor.key] ?? Gavel;
  const StatusIcon = meta.icon;
  const isBlocker = factor.blocking && st === 'fail';
  const quote = requirement?.source.quote;

  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.4), duration: 0.25 }}
      className={cn('group relative px-5 py-4', isBlocker && 'bg-danger-soft/40')}
    >
      {isBlocker && <span className="absolute inset-y-0 left-0 w-1 bg-danger" aria-hidden />}
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg', meta.soft, meta.text)}>
          <Icon className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Tooltip content={FACTOR_HELP[factor.key] ?? factor.label}>
              <span className="text-sm font-semibold tracking-tight">{factor.label}</span>
            </Tooltip>
            <Badge tone={meta.tone} size="sm"><StatusIcon aria-hidden />{meta.label}</Badge>
            {factor.blocking && <Badge tone={isBlocker ? 'danger' : 'outline'} size="sm">{isBlocker ? 'Blocker' : 'Hard criterion'}</Badge>}
            {factor.overridden && (
              <Tooltip content={`Originally ${STATUS_META[factor.status].label.toLowerCase()} — overridden by ${factor.overridden.by}`}>
                <span><Badge tone="primary" size="sm"><UserRoundPen aria-hidden />Overridden</Badge></span>
              </Tooltip>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{factor.detail}</p>
          {factor.overridden && (
            <p className="mt-1.5 rounded-md bg-primary-soft/60 px-2.5 py-1.5 text-xs text-foreground/80">
              <span className="font-medium">{factor.overridden.by}</span> set this to <span className="font-medium">{STATUS_META[factor.overridden.status].label.toLowerCase()}</span> {relativeTime(factor.overridden.at)}: “{factor.overridden.reason}”
            </p>
          )}
          {quote && (
            <div className="mt-2">
              <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 rounded text-xs font-medium text-primary-ink hover:underline focus-ring">
                <Quote className="size-3" aria-hidden /> {open ? 'Hide evidence' : 'Show evidence'}
                <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} aria-hidden />
              </button>
              {open && (
                <motion.blockquote initial={reduce ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-2 overflow-hidden rounded-lg border-l-2 border-primary/50 bg-subtle px-3 py-2 text-xs leading-relaxed text-foreground/80">
                  <span className="italic">“{quote}”</span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-2 not-italic text-muted-foreground">
                    <PageChip tenderId={tenderId} req={requirement} />
                    {requirement?.source.fileName && <span className="truncate">{requirement.source.fileName}</span>}
                    <span>· {requirement?.method === 'LLM' ? 'AI' : 'Rule'} · {Math.round((requirement?.confidence ?? 0) * 100)}% confidence</span>
                  </span>
                </motion.blockquote>
              )}
            </div>
          )}
        </div>
        <div className="hidden w-28 shrink-0 flex-col items-end gap-1.5 sm:flex">
          <span className="tabular text-2xs font-medium uppercase tracking-wide text-muted-foreground">Weight {factor.weight}</span>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
            <motion.div className={cn('h-full rounded-full', meta.dot)} initial={reduce ? false : { width: 0 }} animate={{ width: `${(factor.weight / maxWeight) * 100}%` }} transition={{ duration: 0.6, delay: 0.1 + index * 0.04 }} />
          </div>
          {canOverride && (
            <Button size="xs" variant="ghost" className="-mr-2 mt-1 opacity-70 group-hover:opacity-100" onClick={onOverride} aria-label={`Override ${factor.label}`}>
              <UserRoundPen /> Override
            </Button>
          )}
        </div>
      </div>
      {canOverride && (
        <div className="mt-2 flex justify-end sm:hidden">
          <Button size="xs" variant="ghost" onClick={onOverride}><UserRoundPen /> Override</Button>
        </div>
      )}
    </motion.li>
  );
}

function NotApplicable({ factors, canOverride, onOverride }: { factors: ScoreFactor[]; canOverride: boolean; onOverride: (f: ScoreFactor) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between px-5 py-3 text-left text-xs font-medium text-muted-foreground hover:bg-muted/40 focus-ring">
        <span>Not applicable to this bid ({factors.length})</span>
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ul className="grid gap-2 px-5 pb-4">
          {factors.map((f) => (
            <li key={f.key} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0"><span className="font-medium">{f.label}</span> <span className="text-muted-foreground">— {f.detail}</span></span>
              {canOverride && <Button size="xs" variant="ghost" onClick={() => onOverride(f)}>Override</Button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STATUS_OPTIONS: { value: FactorStatus; label: string }[] = [
  { value: 'pass', label: 'Pass' }, { value: 'exempt', label: 'Exempt' }, { value: 'unknown', label: 'Unknown' }, { value: 'fail', label: 'Fail' }, { value: 'na', label: 'N/A' },
];

function OverrideDialog({ analysis, factor, tenderId, onClose }: { analysis: AnalysisDto; factor: ScoreFactor | null; tenderId: string; onClose: () => void }) {
  const mutation = useOverride(tenderId);
  const [status, setStatus] = useState<FactorStatus>('pass');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (factor && factor.key !== lastKey) {
    setLastKey(factor.key);
    setStatus(eff(factor) === 'pass' ? 'fail' : 'pass');
    setReason('');
    setError(null);
  }
  const submit = () => {
    if (!factor) return;
    if (reason.trim().length < 3) { setError('Give a short reason — it is kept in the audit log.'); return; }
    mutation.mutate({ analysisId: analysis.id, factorKey: factor.key, status, reason: reason.trim() }, {
      onSuccess: (a) => {
        toast.success(`${factor.label} set to ${STATUS_META[status].label.toLowerCase()}`, { description: `New score ${a.score}/100 · ${a.verdict === 'go' ? 'Go' : a.verdict === 'review' ? 'Review' : 'No-Go'}` });
        setLastKey(null);
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    });
  };
  return (
    <Dialog open={!!factor} onOpenChange={(o) => { if (!o) { setLastKey(null); onClose(); } }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Override “{factor?.label}”</DialogTitle>
          <DialogDescription>
            Use this when you know something the documents don’t show (e.g. a consortium partner’s experience). The score is recalculated and the change is audited.
          </DialogDescription>
        </DialogHeader>
        {factor && (
          <div className="grid gap-4">
            <div className="rounded-lg border bg-subtle px-3 py-2 text-sm">
              <span className="text-muted-foreground">Computed:</span> <span className={cn('font-medium', STATUS_META[factor.status].text)}>{STATUS_META[factor.status].label}</span>
              <p className="mt-0.5 text-xs text-muted-foreground">{factor.detail}</p>
            </div>
            <div className="grid gap-1.5">
              <span className="text-[13px] font-medium leading-none">New status</span>
              <Segmented value={status} onChange={setStatus} options={STATUS_OPTIONS} aria-label="New status" className="flex w-full flex-wrap [&>button]:flex-1" />
            </div>
            {status === factor.status && <p className="-mt-2 text-xs text-muted-foreground">Same as computed — this removes the override.</p>}
            <Field label="Reason" required error={error ?? undefined} hint="Visible to your team in the activity log.">
              <Textarea value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} rows={3} maxLength={500} placeholder="e.g. JV partner Acme Systems brings 6 years of CCTV AMC experience" autoFocus />
            </Field>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => { setLastKey(null); onClose(); }}>Cancel</Button>
          <Button onClick={submit} loading={mutation.isPending}>Save override</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
