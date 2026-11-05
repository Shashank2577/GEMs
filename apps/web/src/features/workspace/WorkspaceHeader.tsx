import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, CalendarClock, Check, ChevronDown, Copy, ExternalLink, UserPlus, Users } from 'lucide-react';
import { DECISION_TOOLTIP, canMoveToStage, canTransition, type WorkspaceDetail, type StageName } from '@tp/core/contracts/apply';
import {
  Avatar, AvatarGroup, Badge, Button, Card, Countdown, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger, Input, Popover, PopoverContent, PopoverTrigger, ScoreRing, StageBadge, Tooltip, VerdictBadge, toast,
} from '@/components/ui';
import { useAuth, useCan } from '@/lib/auth';
import { ApiError, errorMessage } from '@/lib/api';
import { formatDateIST, formatINR } from '@/lib/format';
import { STAGE_LABEL, type Stage } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useUpdateWorkspace } from './api';

const STAGE_ORDER: StageName[] = ['identified', 'analysing', 'go', 'preparing', 'ready', 'submitted', 'won', 'lost', 'dropped'];

/** "2026-11-19" (IST calendar date) ↔ ISO at 6 PM IST. */
const istDay = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10) : '');
const fromIstDay = (d: string) => new Date(`${d}T18:00:00+05:30`).toISOString();

export function WorkspaceHeader({ data, onGoToStep }: { data: WorkspaceDetail; onGoToStep: (step: string) => void }) {
  const { workspace: w, tender: t, analysis } = data;
  const canWrite = useCan('analyst');
  const { role } = useAuth();
  const update = useUpdateWorkspace(w.id);
  const [copied, setCopied] = useState(false);

  const setStage = async (stage: StageName) => {
    if (stage === w.stage) return;
    try {
      await update.mutateAsync({ stage });
      toast.success(`Moved to ${STAGE_LABEL[stage as Stage]}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const details = e.details as { blockers?: { label: string }[]; reason?: string } | undefined;
        const blockers = (details?.blockers ?? []).map((b) => b.label);
        // Point the user at the step that resolves the conflict.
        const action = e.code === 'invalid_transition' ? { label: 'Go to Submit', onClick: () => onGoToStep('submit') } // FR-008
          : details?.reason === 'not_analysed' ? { label: 'Go to Qualify', onClick: () => onGoToStep('qualify') } // FR-005
            : { label: 'Fix documents', onClick: () => onGoToStep('documents') }; // not_ready
        toast.error(e.message, { description: blockers.length ? blockers.slice(0, 3).join(' · ') : undefined, action });
      } else toast.error(errorMessage(e));
    }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(t.bidNumber); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* ignore */ }
  };

  const buyer = [t.organisation, t.ministry].filter((x, i, a) => x && a.indexOf(x) === i).join(' · ');

  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.07] via-transparent to-accent/[0.05]" aria-hidden />
      <div className="relative grid grid-cols-1 gap-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button" onClick={copy}
            className="group inline-flex h-7 items-center gap-1.5 rounded-md border bg-card px-2 font-mono text-xs font-medium tracking-tight hover:border-primary/40 focus-ring"
            aria-label={`Copy bid number ${t.bidNumber}`}
          >
            {t.bidNumber}
            {copied ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5 text-muted-foreground group-hover:text-primary" aria-hidden />}
          </button>
          {canWrite ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="inline-flex items-center gap-1 rounded-full focus-ring" aria-label={`Stage: ${STAGE_LABEL[w.stage as Stage]}. Change stage`}>
                  <StageBadge stage={w.stage as Stage} />
                  <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>Move to stage</DropdownMenuLabel>
                {STAGE_ORDER.map((s) => {
                  // FR-008: Won/Lost only after the bid was submitted on GeM (the API enforces it too).
                  const noDecision = !canMoveToStage(role, w.stage, s); // Go / Dropped are Bid Manager+ (#527)
                  const blocked = noDecision || (s !== w.stage && !canTransition(w.stage, s).ok);
                  return (
                  // aria-disabled (not `disabled`) keeps the item focusable so screen readers reach the hint.
                  <DropdownMenuItem key={s} disabled={update.isPending} aria-disabled={blocked || undefined} title={noDecision ? DECISION_TOOLTIP : undefined}
                    onSelect={(ev) => { if (blocked) { ev.preventDefault(); return; } void setStage(s); }}
                    className={cn('justify-between', blocked && 'cursor-not-allowed opacity-50')}>
                    <StageBadge stage={s as Stage} size="sm" />
                    {blocked && <span className="text-2xs text-muted-foreground">{noDecision ? 'Bid Manager' : 'Mark as submitted first'}</span>}
                    {s === 'ready' && data.readiness.blockers.length > 0 && <span className="text-2xs text-danger">{data.readiness.blockers.length} blocker{data.readiness.blockers.length === 1 ? '' : 's'}</span>}
                    {s === w.stage && <Check className="size-4 text-primary" aria-hidden />}
                  </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : <StageBadge stage={w.stage as Stage} />}
          {analysis?.stale && <Badge tone="warning">Re-analysis needed</Badge>}
          {w.outcome && <Badge tone={w.outcome.result === 'won' ? 'success' : 'danger'} size="md">{w.outcome.result === 'won' ? 'Won' : 'Lost'}{w.outcome.l1Price ? ` · L1 ${formatINR(w.outcome.l1Price, { compact: true })}` : ''}</Badge>}
        </div>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-xl font-semibold leading-snug tracking-tight sm:text-2xl">{t.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
              {buyer && <span className="inline-flex min-w-0 items-center gap-1.5"><Building2 className="size-4 shrink-0" aria-hidden /><span className="truncate">{buyer}</span></span>}
              <Countdown to={t.endAt} className="text-sm" />
              {t.emdAmount ? <span>EMD <span className="tabular font-medium text-foreground">{formatINR(t.emdAmount)}</span></span> : null}
              {t.estimatedValue ? <span>Est. <span className="tabular font-medium text-foreground">{formatINR(t.estimatedValue, { compact: true })}</span></span> : null}
            </div>
          </div>
          {analysis?.score != null && (
            <button type="button" onClick={() => onGoToStep('qualify')} className="flex shrink-0 items-center gap-3 self-start rounded-xl border bg-card/80 p-2.5 pr-4 text-left shadow-xs backdrop-blur hover:border-primary/30 focus-ring">
              <ScoreRing score={analysis.score} verdict={analysis.verdict ?? undefined} size={48} />
              <div>
                <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Eligibility</div>
                <VerdictBadge verdict={analysis.verdict ?? 'review'} size="sm" className="mt-1" />
              </div>
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <PeoplePicker data={data} disabled={!canWrite} />
          <DueDate value={w.dueAt} endAt={t.endAt} disabled={!canWrite} onChange={(v) => update.mutate({ dueAt: v }, { onSuccess: () => toast.success('Due date updated'), onError: (e) => toast.error(errorMessage(e)) })} />
          <div className="ml-auto flex items-center gap-1">
            <Button asChild variant="ghost" size="sm"><Link to={`/tenders/${t.id}`}>Tender details</Link></Button>
            {t.sourceUrl && <Button asChild variant="ghost" size="sm"><a href={t.sourceUrl} target="_blank" rel="noreferrer">GeM <ExternalLink /></a></Button>}
          </div>
        </div>
      </div>
    </Card>
  );
}

function PeoplePicker({ data, disabled }: { data: WorkspaceDetail; disabled: boolean }) {
  const { workspace: w, members } = data;
  const update = useUpdateWorkspace(w.id);
  const assigned = new Set(w.assignees.map((a) => a.id));
  const toggle = (id: string) => {
    const next = assigned.has(id) ? [...assigned].filter((x) => x !== id) : [...assigned, id];
    update.mutate({ assigneeIds: next }, { onError: (e) => toast.error(errorMessage(e)) });
  };
  const setOwner = (id: string) => update.mutate({ ownerId: id }, { onSuccess: () => toast.success('Owner updated'), onError: (e) => toast.error(errorMessage(e)) });
  const people = [...(w.owner ? [w.owner] : []), ...w.assignees.filter((a) => a.id !== w.owner?.id)];
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" className={cn('inline-flex h-9 items-center gap-2 rounded-lg border bg-card px-2.5 text-sm hover:bg-muted focus-ring', disabled && 'pointer-events-none')} aria-label="Owner and assignees">
          {people.length ? <AvatarGroup people={people.map((p) => ({ name: p.name }))} size="xs" /> : <UserPlus className="size-4 text-muted-foreground" aria-hidden />}
          <span className="text-[13px]">{w.owner ? <><span className="text-muted-foreground">Owner</span> {w.owner.name.split(' ')[0]}</> : 'Assign'}</span>
          {w.assignees.length > 0 && <Badge tone="neutral" size="sm"><Users aria-hidden /> {w.assignees.length}</Badge>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">Owner leads the bid · assignees help prepare it</div>
        <ul className="max-h-72 overflow-y-auto p-1">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
              <Avatar name={m.name} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{m.name}</div>
                <div className="truncate text-2xs text-muted-foreground">{m.email}</div>
              </div>
              <Tooltip content={w.owner?.id === m.id ? 'Owner' : 'Make owner'}>
                <Button size="xs" variant={w.owner?.id === m.id ? 'subtle' : 'ghost'} onClick={() => setOwner(m.id)} aria-pressed={w.owner?.id === m.id} disabled={update.isPending}>
                  {w.owner?.id === m.id ? 'Owner' : 'Own'}
                </Button>
              </Tooltip>
              <Button size="icon-xs" variant={assigned.has(m.id) ? 'primary' : 'outline'} onClick={() => toggle(m.id)} aria-pressed={assigned.has(m.id)} aria-label={`${assigned.has(m.id) ? 'Unassign' : 'Assign'} ${m.name}`} disabled={update.isPending}>
                {assigned.has(m.id) ? <Check /> : <UserPlus />}
              </Button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function DueDate({ value, endAt, disabled, onChange }: { value: string | null; endAt: string | null; disabled: boolean; onChange: (v: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const late = value && endAt && new Date(value) > new Date(endAt);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" className={cn('inline-flex h-9 items-center gap-2 rounded-lg border bg-card px-2.5 text-[13px] hover:bg-muted focus-ring', disabled && 'pointer-events-none', late && 'border-warning/50')} aria-label="Internal due date">
          <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Due</span>
          <span className="tabular font-medium">{value ? formatDateIST(value) : 'Set date'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-3">
        <div className="text-sm font-medium">Internal due date</div>
        <p className="text-xs text-muted-foreground">Finish the packet before GeM closes{endAt ? ` (${formatDateIST(endAt, { time: true })})` : ''}.</p>
        <Input type="date" defaultValue={istDay(value)} max={istDay(endAt)} onChange={(e) => e.target.value && onChange(fromIstDay(e.target.value))} aria-label="Due date" />
        {value && <Button variant="ghost" size="xs" onClick={() => { onChange(null); setOpen(false); }}>Clear</Button>}
      </PopoverContent>
    </Popover>
  );
}
