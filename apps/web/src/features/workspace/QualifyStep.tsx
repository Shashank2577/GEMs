import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, CircleHelp, Gauge, MinusCircle, ShieldAlert, XCircle } from 'lucide-react';
import type { WorkspaceDetail } from '@tp/core/contracts/apply';
import { Badge, Button, Card, EmptyState, ScoreRing, VerdictBadge } from '@/components/ui';
import { formatDateIST } from '@/lib/format';
import { cn } from '@/lib/utils';

const FACTOR_ICON = { pass: CheckCircle2, exempt: CheckCircle2, fail: XCircle, unknown: CircleHelp, na: MinusCircle } as const;
const FACTOR_TONE = { pass: 'text-success', exempt: 'text-success', fail: 'text-danger', unknown: 'text-warning', na: 'text-muted-foreground' } as const;

export function QualifyStep({ data, onNext }: { data: WorkspaceDetail; onNext: () => void }) {
  const a = data.analysis;
  if (!a || a.status !== 'done') {
    return (
      <EmptyState
        icon={Gauge}
        title="Analyse the tender first"
        body="TenderPilot reads the bid document and ATC, scores your eligibility and builds the document checklist this workspace uses."
        action={<Button asChild><Link to={`/tenders/${data.tender.id}#analysis`}>Open tender analysis <ArrowRight /></Link></Button>}
      />
    );
  }
  const blockers = a.factors.filter((f) => (f.overridden?.status ?? f.status) === 'fail' && f.blocking);
  const sorted = [...a.factors].sort((x, y) => Number(y.blocking) - Number(x.blocking) || y.weight - x.weight);
  return (
    <div className="grid grid-cols-1 gap-4">
      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <ScoreRing score={a.score} verdict={a.verdict ?? undefined} size={104} label="Score" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <VerdictBadge verdict={a.verdict ?? 'review'} size="lg" />
              <Badge tone="outline">{a.method === 'rules+llm' ? 'Rules + AI' : 'Rules only'}</Badge>
              {a.confidence != null && <Badge tone="neutral">Confidence {Math.round(a.confidence * 100)}%</Badge>}
              {a.stale && <Badge tone="warning">Corrigendum since analysis</Badge>}
            </div>
            {a.summary && <p className="mt-2 text-sm text-muted-foreground">{a.summary}</p>}
            <p className="mt-2 text-xs text-muted-foreground">Analysed {formatDateIST(a.updatedAt, { time: true })}</p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
            <Button onClick={onNext}>Continue to documents <ArrowRight /></Button>
            <Button asChild variant="ghost" size="sm"><Link to={`/tenders/${data.tender.id}#analysis`}>Full analysis</Link></Button>
          </div>
        </div>
        {blockers.length > 0 && (
          <div className="mt-5 flex gap-3 rounded-xl border border-danger/25 bg-danger-soft/60 p-3.5 text-sm">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
            <div>
              <div className="font-semibold">Hard blocker{blockers.length > 1 ? 's' : ''}: {blockers.map((b) => b.label).join(', ')}</div>
              <p className="text-muted-foreground">Bidding anyway risks rejection at technical evaluation. Check for MSE / Startup exemptions or override the factor with a reason on the tender page.</p>
            </div>
          </div>
        )}
      </Card>
      <Card className="divide-y">
        {sorted.map((f) => {
          const status = f.overridden?.status ?? f.status;
          const Icon = FACTOR_ICON[status];
          return (
            <div key={f.key} className="flex items-start gap-3 px-4 py-3 sm:px-5">
              <Icon className={cn('mt-0.5 size-5 shrink-0', FACTOR_TONE[status])} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{f.label}</span>
                  {f.blocking && <Badge tone="danger" size="sm">Blocking</Badge>}
                  {f.overridden && <Badge tone="info" size="sm">Overridden</Badge>}
                </div>
                <p className="mt-0.5 text-[13px] text-muted-foreground">{f.detail}</p>
              </div>
              <span className="tabular shrink-0 text-xs text-muted-foreground">w{f.weight}</span>
            </div>
          );
        })}
        {!sorted.length && <p className="p-5 text-sm text-muted-foreground">No scoring factors recorded.</p>}
      </Card>
    </div>
  );
}
