import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, ChevronDown, ExternalLink, FileSignature, Search, ShieldCheck, Sparkles, Upload, Wand2, X } from 'lucide-react';
import type { ReadinessItem, WorkspaceDetail, WorkspaceVaultDoc } from '@tp/core/contracts/apply';
import { docTypeInfo } from '@tp/core/vault/status';
import {
  Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Field, Input, Popover,
  PopoverContent, PopoverTrigger, Textarea, Tooltip, toast,
} from '@/components/ui';
import { useCan } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { formatDateIST, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DocTypeIcon, ExpiryBadge } from '@/features/vault/doc-ui';
import { useOverride, useRemoveOverride, useSetMapping } from './api';
import { StateChip } from './labels';
import { nextTabIndex, readinessLabel } from './a11y';

type Filter = 'all' | 'attention' | 'ready';

export function DocumentsStep({ data, onNext, onOpenAnnexure }: { data: WorkspaceDetail; onNext: () => void; onOpenAnnexure: (key: string) => void }) {
  const r = data.readiness;
  const [filter, setFilter] = useState<Filter>('all');
  const docs = useMemo(() => new Map(data.vaultDocs.map((d) => [d.id, d])), [data.vaultDocs]);
  const attention = r.items.filter((i) => i.state === 'missing' || i.state === 'expired' || i.state === 'expiring');
  const shown = filter === 'attention' ? attention : filter === 'ready' ? r.items.filter((i) => !attention.includes(i)) : r.items;
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const tabId = (k: Filter) => `${baseId}-tab-${k}`;
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabs = [['all', `All ${r.items.length}`], ['attention', `Needs attention ${attention.length}`], ['ready', `Covered ${r.items.length - attention.length}`]] as const;
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = nextTabIndex(e.key, i, tabs.length);
    if (next == null) return;
    e.preventDefault();
    setFilter(tabs[next][0]);
    tabRefs.current[next]?.focus();
  };

  if (!data.analysis || !r.analysed) {
    return <EmptyState icon={FileSignature} title="No checklist yet" body="Analyse the tender to get the list of documents this bid needs." action={<Button asChild><Link to={`/tenders/${data.tender.id}`}>Analyse tender <ArrowRight /></Link></Button>} />;
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-4">
            <div role="img" aria-label={readinessLabel(r.percent)} className="relative flex size-16 items-center justify-center">
              <svg viewBox="0 0 36 36" className="size-16 -rotate-90" aria-hidden>
                <circle cx="18" cy="18" r="15.5" fill="none" stroke="hsl(var(--muted))" strokeWidth="3.5" />
                <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3.5" strokeLinecap="round"
                  stroke={r.percent === 100 ? 'hsl(var(--success))' : r.percent >= 60 ? 'hsl(var(--warning))' : 'hsl(var(--danger))'}
                  strokeDasharray={`${(r.percent / 100) * 97.4} 97.4`} className="transition-[stroke-dasharray] duration-700" />
              </svg>
              <span aria-hidden className="tabular absolute text-sm font-semibold">{r.percent}%</span>
            </div>
            <div>
              <div className="text-[15px] font-semibold tracking-tight">{r.canMarkReady ? 'All required documents are covered' : `${pluralize(r.blockers.length, 'blocker')} before “Ready to submit”`}</div>
              <p className="text-[13px] text-muted-foreground">{r.covered} of {r.total} required items covered · {pluralize(r.items.length, 'item')} in the checklist</p>
            </div>
          </div>
          <div className="flex gap-2 sm:ml-auto">
            <Button variant="secondary" asChild><Link to="/vault?upload=1">
              <Upload /> Upload to vault</Link></Button>
            <Button onClick={onNext}>Annexures <ArrowRight /></Button>
          </div>
        </div>
        {r.blockers.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Blockers">
            {r.blockers.map((b) => (
              <li key={b.itemId}><a href={`#item-${b.itemId}`} className="inline-flex items-center gap-1 rounded-full border border-danger/25 bg-danger-soft px-2.5 py-1 text-xs font-medium text-[hsl(350_74%_38%)] dark:text-danger hover:border-danger/50 focus-ring">
                {b.state === 'expired' ? 'Expired' : 'Missing'} · {b.label.length > 48 ? `${b.label.slice(0, 46)}…` : b.label}
              </a></li>
            ))}
          </ul>
        )}
      </Card>

      <div className="flex items-center justify-between gap-2">
        <div role="tablist" aria-label="Filter checklist" className="inline-flex rounded-lg bg-muted p-0.5">
          {tabs.map(([k, label], i) => (
            <button key={k} ref={(el) => { tabRefs.current[i] = el; }} type="button" role="tab" id={tabId(k)} aria-selected={filter === k} aria-controls={panelId}
              tabIndex={filter === k ? 0 : -1} onClick={() => setFilter(k)} onKeyDown={(e) => onTabKey(e, i)}
              className={cn('h-7 rounded-md px-2.5 text-xs font-medium focus-ring', filter === k ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{label}</button>
          ))}
        </div>
      </div>

      <div role="tabpanel" id={panelId} aria-labelledby={tabId(filter)} tabIndex={0} className="focus-ring rounded-lg">
        <ul className="grid grid-cols-1 gap-2.5">
          {shown.map((it) => (
            <ChecklistRow key={it.item.id} wsId={data.workspace.id} it={it} doc={it.docId ? docs.get(it.docId) ?? null : null} allDocs={data.vaultDocs} onOpenAnnexure={onOpenAnnexure} />
          ))}
          {!shown.length && <li><EmptyState compact icon={Check} title="Nothing here" body="Everything in this view is covered." /></li>}
        </ul>
      </div>
    </div>
  );
}

function ChecklistRow({ wsId, it, doc, allDocs, onOpenAnnexure }: {
  wsId: string; it: ReadinessItem; doc: WorkspaceVaultDoc | null; allDocs: WorkspaceVaultDoc[]; onOpenAnnexure: (key: string) => void;
}) {
  const canWrite = useCan('analyst');
  const canOverride = useCan('bid_manager');
  const removeOverride = useRemoveOverride(wsId);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const typeLabel = it.item.docType ? docTypeInfo(it.item.docType).label : null;
  const problem = it.state === 'missing' || it.state === 'expired';
  return (
    <li id={`item-${it.item.id}`} className="scroll-mt-24">
      <Card className={cn('p-3.5 transition-colors sm:p-4', it.blocking && 'border-danger/30 bg-danger-soft/20')}>
        <div className="flex flex-col gap-3 md:flex-row md:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StateChip state={it.state} />
              {it.item.mandatory ? <Badge tone="outline" size="sm">Required</Badge> : <Badge tone="neutral" size="sm">Optional</Badge>}
              {it.auto && it.docId && <Tooltip content="Picked automatically: right type, valid, latest financial year"><span><Badge tone="primary" size="sm"><Sparkles aria-hidden /> Auto-matched</Badge></span></Tooltip>}
            </div>
            <div className="mt-1.5 text-sm font-medium leading-snug">{it.item.label}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">{it.item.reason}</p>
            {it.override && (
              <p className="mt-1.5 inline-flex items-start gap-1.5 rounded-md bg-info-soft px-2 py-1 text-xs text-[hsl(205_85%_30%)] dark:text-info">
                <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden /> Override: {it.override.reason}
              </p>
            )}
          </div>

          <div className="flex w-full flex-col gap-2 md:w-[min(46%,380px)]">
            {it.item.generated ? (
              <div className="flex items-center gap-3 rounded-lg border border-dashed bg-primary-soft/40 px-3 py-2.5">
                <FileSignature className="size-5 shrink-0 text-primary" aria-hidden />
                <div className="min-w-0 flex-1 text-[13px]">
                  <div className="font-medium">Generated from your profile</div>
                  <div className="text-xs text-muted-foreground">Print, sign and stamp before upload</div>
                </div>
                <Button size="xs" variant="secondary" onClick={() => onOpenAnnexure(it.item.generated!)}>Preview</Button>
              </div>
            ) : doc ? (
              <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
                <DocTypeIcon type={doc.type} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{doc.title}</div>
                  <div className="flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
                    <span className="truncate">{doc.fileName}</span>
                    {doc.financialYear && <span>FY {doc.financialYear}</span>}
                    {doc.expiryDate && <span>till {formatDateIST(doc.expiryDate)}</span>}
                  </div>
                </div>
                <ExpiryBadge status={doc.status} days={doc.daysToExpiry} />
                <Tooltip content="Open document">
                  <Button asChild size="icon-xs" variant="ghost"><a href={`${doc.downloadUrl}?inline=1`} target="_blank" rel="noreferrer" aria-label={`Open ${doc.title}`}><ExternalLink /></a></Button>
                </Tooltip>
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-2.5 text-[13px] text-muted-foreground">
                <DocTypeIcon type={it.item.docType ?? 'other'} size="sm" />
                <span className="flex-1">{it.note}</span>
              </div>
            )}

            {canWrite && !it.item.generated && (
              <div className="flex flex-wrap items-center gap-1.5">
                <DocPicker wsId={wsId} it={it} docs={allDocs} />
                {(problem || it.state === 'expiring') && (
                  <Button asChild size="xs" variant={problem ? 'primary' : 'secondary'}>
                    <Link to={`/vault?upload=1${it.item.docType ? `&uploadType=${it.item.docType}` : ''}`}><Upload /> {it.state === 'missing' ? `Upload ${typeLabel ?? 'document'}` : 'Upload renewed'}</Link>
                  </Button>
                )}
                {canOverride && problem && it.item.mandatory && !it.override && (
                  <Button size="xs" variant="ghost" onClick={() => setOverrideOpen(true)}><ShieldCheck /> Override</Button>
                )}
                {canOverride && it.override && (
                  <Button size="xs" variant="ghost" loading={removeOverride.isPending} onClick={() => removeOverride.mutate(it.item.id, { onSuccess: () => toast.success('Override removed'), onError: (e) => toast.error(errorMessage(e)) })}>
                    <X /> Remove override
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>
      <OverrideDialog wsId={wsId} it={it} open={overrideOpen} onOpenChange={setOverrideOpen} />
    </li>
  );
}

function DocPicker({ wsId, it, docs }: { wsId: string; it: ReadinessItem; docs: WorkspaceVaultDoc[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const setMapping = useSetMapping(wsId);
  const pick = (docId: string | null | 'auto', label: string) =>
    setMapping.mutate({ [it.item.id]: docId }, {
      onSuccess: () => { toast.success(label); setOpen(false); },
      onError: (e) => toast.error(errorMessage(e)),
    });
  const match = (d: WorkspaceVaultDoc) => !q || `${d.title} ${d.fileName} ${d.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase());
  const sameType = docs.filter((d) => d.type === it.item.docType && match(d));
  const others = docs.filter((d) => d.type !== it.item.docType && match(d));
  const Row = ({ d }: { d: WorkspaceVaultDoc }) => (
    <button type="button" onClick={() => pick(d.id, `Using “${d.title}”`)} disabled={setMapping.isPending}
      className={cn('flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-ring', it.docId === d.id && 'bg-primary-soft/60')}>
      <DocTypeIcon type={d.type} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{d.title}</div>
        <div className="truncate text-2xs text-muted-foreground">{[d.financialYear && `FY ${d.financialYear}`, d.expiryDate && `till ${formatDateIST(d.expiryDate)}`, d.fileName].filter(Boolean).join(' · ')}</div>
      </div>
      <ExpiryBadge status={d.status} days={d.daysToExpiry} />
      {it.docId === d.id && <Check className="size-4 text-primary" aria-hidden />}
    </button>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="xs" variant="secondary">{it.docId ? 'Change' : 'Choose document'} <ChevronDown /></Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,380px)] p-0">
        <div className="border-b p-2">
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the vault…" leading={<Search />} aria-label="Search the vault" className="h-8" />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {sameType.length > 0 && <div className="px-2 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground">{it.item.docType ? docTypeInfo(it.item.docType).label : 'Matching'}</div>}
          {sameType.map((d) => <Row key={d.id} d={d} />)}
          {others.length > 0 && <div className="px-2 pb-1 pt-2 text-2xs font-medium uppercase tracking-wider text-muted-foreground">Other documents</div>}
          {others.slice(0, 30).map((d) => <Row key={d.id} d={d} />)}
          {!sameType.length && !others.length && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No documents match.</p>}
        </div>
        <div className="flex flex-wrap gap-1 border-t p-2">
          <Button size="xs" variant="ghost" onClick={() => pick('auto', 'TenderPilot will pick the best document')} disabled={setMapping.isPending}><Wand2 /> Auto-match</Button>
          <Button size="xs" variant="ghost" onClick={() => pick(null, 'Marked as not available')} disabled={setMapping.isPending}><X /> Not available</Button>
          <Button asChild size="xs" variant="ghost" className="ml-auto"><Link to={`/vault?upload=1${it.item.docType ? `&uploadType=${it.item.docType}` : ''}`}><Upload /> Upload new</Link></Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function OverrideDialog({ wsId, it, open, onOpenChange }: { wsId: string; it: ReadinessItem; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [reason, setReason] = useState('');
  const override = useOverride(wsId);
  const err = reason.trim().length > 0 && reason.trim().length < 5 ? 'Explain in a few more words' : undefined;
  const submit = () => override.mutate({ itemId: it.item.id, reason: reason.trim() }, {
    onSuccess: () => { toast.success('Override recorded'); setReason(''); onOpenChange(false); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Override “{it.item.label}”</DialogTitle>
          <DialogDescription>
            The item stops blocking “Ready to submit”. Your name and reason are recorded in the activity log. Make sure the bid will not be rejected for it.
          </DialogDescription>
        </DialogHeader>
        <Field label="Reason" required error={err} hint="e.g. “Renewed MAF arrives Friday; upload before submission.”">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} loading={override.isPending} disabled={reason.trim().length < 5}><ShieldCheck /> Override</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

