import { useEffect, useRef, useState } from 'react';
import { Link, useBlocker } from 'react-router-dom';
import {
  BadgeIndianRupee, Check, CheckCircle2, Copy, Download, Fingerprint, FileSearch, Hand, KeyRound, MousePointerClick, PartyPopper, PencilLine, Puzzle, Send, Trophy, Upload, XCircle,
} from 'lucide-react';
import { parseAwardResult, MAX_RESULT_HTML } from '@tp/core/gem/award';
import { canTransition, type AssistField, type WorkspaceDetail } from '@tp/core/contracts/apply';
import {
  Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, ErrorState, Field, Input,
  Segmented, SkeletonList, Textarea, Tooltip, toast,
} from '@/components/ui';
import { useCan } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { formatDateIST, formatINR } from '@/lib/format';
import { cn } from '@/lib/utils';
import { changedAssistKeys, isAssistDraftDirty, needsBuild } from './assist-draft';
import { useAssist, useMarkSubmitted, useRecordOutcome, useSaveAssist, useUpdateWorkspace } from './api';

const GROUP_LABEL: Record<AssistField['group'], string> = { product: 'Product', offer: 'Offer', compliance: 'Compliance', declaration: 'Declaration' };
const SOURCE_LABEL: Record<AssistField['source'], string> = { saved: 'Edited', profile: 'From profile', tender: 'From tender', analysis: 'From analysis', empty: 'Not set' };
const STEP_ICON = { price: BadgeIndianRupee, upload: Upload, auth: Fingerprint, submit: MousePointerClick } as const;

/** The API returns absolute URLs (for the extension); in the app use same-origin paths. */
const toPath = (u: string) => { try { const x = new URL(u, window.location.origin); return x.pathname + x.search; } catch { return u; } };

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip content={done ? 'Copied' : `Copy ${label}`}>
      <Button size="icon-xs" variant="ghost" disabled={!value} aria-label={`Copy ${label}`}
        onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); } catch { toast.error('Copy failed — select the text instead'); } }}>
        {done ? <Check className="text-success" /> : <Copy />}
      </Button>
    </Tooltip>
  );
}

/**
 * "Discard unsaved changes?" for the assist-values editor (FR-092): in-app navigation (links, Back/Forward, step strip)
 * and tab close. Rendered ONLY while the editor is open with unsaved edits, so the router's single blocker slot is
 * taken only then (the US4 template editor follows the same rule).
 */
const leavesPage = ({ currentLocation, nextLocation }: { currentLocation: { pathname: string; search: string }; nextLocation: { pathname: string; search: string } }) =>
  currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search;

function UnsavedValuesGuard() {
  const blocker = useBlocker(leavesPage);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(o) => { if (!o && blocker.state === 'blocked') blocker.reset(); }}
      title="Discard unsaved changes?"
      description="Your edits to the values for GeM have not been saved."
      cancelLabel="Keep editing"
      confirmLabel="Discard changes"
      onConfirm={() => { if (blocker.state === 'blocked') blocker.proceed(); }}
    />
  );
}

export function SubmitStep({ data }: { data: WorkspaceDetail }) {
  const assist = useAssist(data.workspace.id);
  const canWrite = useCan('analyst');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useSaveAssist(data.workspace.id);
  const w = data.workspace;
  const submitted = !!w.submittedAt || w.stage === 'submitted' || w.stage === 'won' || w.stage === 'lost';

  useEffect(() => { if (assist.data) setDraft(Object.fromEntries(assist.data.fields.map((f) => [f.key, f.value]))); }, [assist.data]);

  const saveValues = () => {
    const changed = Object.fromEntries(changedAssistKeys(draft, assist.data?.fields ?? []).map((k) => [k, draft[k] ?? '']));
    if (!Object.keys(changed).length) { setEditing(false); return; }
    save.mutate(changed, { onSuccess: () => { toast.success('Values saved'); setEditing(false); }, onError: (e) => toast.error(errorMessage(e)) });
  };

  const dirty = isAssistDraftDirty(editing, draft, assist.data?.fields ?? []);
  const groups = (assist.data?.fields ?? []).reduce<Record<string, AssistField[]>>((acc, f) => { (acc[f.group] ??= []).push(f); return acc; }, {});

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
      {dirty && <UnsavedValuesGuard />}
      <div className="grid grid-cols-1 content-start gap-4">
        <HumanOnly />

        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">Values to enter on GeM</h3>
              <p className="text-xs text-muted-foreground">Non-financial fields only. Copy each one, or let the browser extension fill them on your click.</p>
            </div>
            {canWrite && !editing && <Button size="sm" variant="secondary" onClick={() => setEditing(true)} disabled={!assist.data}><PencilLine /> Edit values</Button>}
            {editing && <>
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(Object.fromEntries((assist.data?.fields ?? []).map((f) => [f.key, f.value]))); }}>Cancel</Button>
              <Button size="sm" onClick={saveValues} loading={save.isPending}>Save</Button>
            </>}
          </div>
          {assist.isLoading ? <div className="p-4"><SkeletonList rows={6} /></div> : assist.isError ? <div className="p-4"><ErrorState compact error={assist.error} onRetry={() => assist.refetch()} /></div> : (
            <div className="divide-y">
              {Object.entries(groups).map(([g, fields]) => (
                <div key={g} className="px-4 py-3">
                  <div className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{GROUP_LABEL[g as AssistField['group']]}</div>
                  <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {fields.map((f) => (
                      <div key={f.key} className="min-w-0 rounded-lg border bg-subtle/60 px-3 py-2">
                        <dt className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                          {f.label}
                          {!editing && <span className={cn('rounded px-1 text-[10px]', f.source === 'empty' ? 'bg-warning-soft text-[hsl(32_90%_28%)] dark:text-warning' : 'bg-muted')}>{SOURCE_LABEL[f.source]}</span>}
                        </dt>
                        {editing ? (
                          <dd className="m-0"><Input value={draft[f.key] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} className="mt-1 h-8" aria-label={f.label}
                            inputMode={f.input === 'number' ? 'decimal' : undefined} placeholder={f.help} /></dd>
                        ) : (
                          <dd className="m-0 flex items-center gap-2">
                            <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', !f.value && 'font-normal italic text-muted-foreground')} title={f.value}>{f.value || 'Not set'}</span>
                            <CopyButton value={f.value} label={f.label} />
                          </dd>
                        )}
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="border-b px-4 py-3">
            <h3 className="text-sm font-semibold">Upload in this order</h3>
            <p className="text-xs text-muted-foreground">File names as they’ll appear in your downloads.</p>
          </div>
          <ol className="divide-y">
            {assist.data && needsBuild(assist.data.documents) && <li className="px-4 py-6 text-center text-sm text-muted-foreground">Build the packet first — the merged PDF will appear here.</li>}
            {(assist.data?.documents ?? []).map((d, i) => (
              <li key={`${d.url}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-2xs font-semibold text-primary">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{d.title}</div>
                  <div className="flex items-center gap-1 truncate font-mono text-2xs text-muted-foreground">{d.fileName}{d.pages ? <span className="font-sans"> · {d.pages} p</span> : null}</div>
                </div>
                {d.kind === 'packet' && <Badge tone="success" size="sm">Merged</Badge>}
                <CopyButton value={d.fileName} label="file name" />
                <Tooltip content="Download"><Button asChild size="icon-xs" variant="ghost"><a href={toPath(d.url)} aria-label={`Download ${d.title}`}><Download /></a></Button></Tooltip>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <div className="grid grid-cols-1 content-start gap-4">
        <SubmissionCard data={data} submitted={submitted} />
        <Card className="p-4">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"><Puzzle className="size-4" aria-hidden /></div>
            <div className="min-w-0">
              <div className="text-sm font-semibold">Fill GeM forms in one click</div>
              <p className="mt-0.5 text-xs text-muted-foreground">The TenderPilot Chrome extension highlights the fields above on the GeM page and fills them when you click — never prices, OTP or submit. Its token is read-only: it can read this workspace but cannot change anything in TenderPilot.</p>
              <ol className="mt-2 list-decimal space-y-0.5 pl-4 text-xs text-muted-foreground">
                <li>Load the extension (apps/extension → Load unpacked).</li>
                <li>Create an “Extension (read-only)” API token in Settings and paste it into the extension.</li>
                <li>Open the bid on GeM and click “Fill allowed fields”.</li>
              </ol>
              <Button asChild size="xs" variant="link" className="mt-2"><Link to="/settings/api-tokens?scope=read">Create a read-only API token</Link></Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function HumanOnly() {
  const steps = [
    { key: 'price', title: 'Enter your price on GeM', detail: 'Type the unit price yourself in the GeM price schedule.' },
    { key: 'upload', title: 'Upload the documents', detail: 'Attach the merged packet and documents listed below.' },
    { key: 'auth', title: 'Authenticate with OTP / DSC / e-Sign', detail: 'Aadhaar OTP, e-Sign or your Digital Signature Certificate.' },
    { key: 'submit', title: 'Click Final Submit', detail: 'Review the GeM summary and submit — then mark it here.' },
  ] as const;
  return (
    <Card className="relative overflow-hidden border-warning/40">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-warning/[0.12] via-warning/[0.04] to-transparent" aria-hidden />
      <div className="relative p-4 sm:p-5">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-warning text-warning-foreground"><Hand className="size-4" aria-hidden /></div>
          <div>
            <h3 className="text-[15px] font-semibold tracking-tight">Human-only steps</h3>
            <p className="text-xs text-muted-foreground">TenderPilot never does these — they keep your GeM account safe and the bid legally yours.</p>
          </div>
        </div>
        <ol className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {steps.map((s, i) => {
            const Icon = STEP_ICON[s.key];
            return (
              <li key={s.key} className="flex gap-3 rounded-xl border bg-card/80 p-3 backdrop-blur">
                <div className="relative">
                  <Icon className="size-5 text-warning" aria-hidden />
                  <span className="absolute -right-2 -top-2 flex size-4 items-center justify-center rounded-full bg-foreground text-[9px] font-bold text-background">{i + 1}</span>
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold">{s.title}</div>
                  <div className="text-xs text-muted-foreground">{s.detail}</div>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="mt-3 flex items-center gap-1.5 text-xs font-medium"><KeyRound className="size-3.5 text-warning" aria-hidden /> TenderPilot never stores GeM passwords, enters prices, solves CAPTCHA or performs OTP / DSC / e-Sign.</p>
      </div>
    </Card>
  );
}

function SubmissionCard({ data, submitted }: { data: WorkspaceDetail; submitted: boolean }) {
  const w = data.workspace;
  const canWrite = useCan('analyst');
  const mark = useMarkSubmitted(w.id);
  const outcome = useRecordOutcome(w.id);
  const update = useUpdateWorkspace(w.id);
  // FR-008: the result can be recorded only while the stage is Submitted (the API guard is stage-based, not submittedAt-based).
  const canRecord = canTransition(w.stage, 'won').ok;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checks, setChecks] = useState({ price: false, auth: false, submit: false });
  const [note, setNote] = useState('');
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [result, setResult] = useState<'won' | 'lost'>('won');
  const [l1, setL1] = useState('');
  const [ours, setOurs] = useState('');
  const [notes, setNotes] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  // FR-085: null = nothing suggested yet; 'none' = the picked page has no price table; otherwise the seller that was pre-filled.
  const [suggestion, setSuggestion] = useState<null | 'none' | 'unreadable' | { seller: string }>(null);
  // What the last suggestion put into the form, so a re-suggest replaces it and a miss clears it (never touching user edits).
  const prefilled = useRef<{ l1: string; line: string | null } | null>(null);
  const NOTE_PREFIX = 'L1 seller (from GeM result): ';
  const clearPrefill = () => {
    const p = prefilled.current;
    prefilled.current = null;
    if (!p) return;
    setL1((v) => (v === p.l1 ? '' : v));
    if (p.line) setNotes((n) => n.split('\n').filter((l) => l !== p.line).join('\n'));
  };
  const suggestFrom = async (file: File) => {
    // Parsed in the browser only; the page is never uploaded. Reads at most what the parser would look at.
    let text: string;
    try { text = await file.slice(0, MAX_RESULT_HTML).text(); } catch { clearPrefill(); setSuggestion('unreadable'); return; }
    const parsed = parseAwardResult(text);
    clearPrefill();
    if (!parsed) { setSuggestion('none'); return; }
    const l1Text = String(Math.round(parsed.l1Price));
    const line = parsed.l1Seller ? `${NOTE_PREFIX}${parsed.l1Seller}` : null;
    setL1(l1Text);
    // Replace (not append) the seller-note line.
    setNotes((n) => {
      const kept = n.split('\n').filter((l) => !l.startsWith(NOTE_PREFIX)).join('\n');
      return (line ? (kept ? `${kept}\n` : '') + line : kept).slice(0, 1000);
    });
    prefilled.current = { l1: l1Text, line };
    setSuggestion({ seller: parsed.l1Seller });
  };
  const openBlockers = data.readiness.blockers;
  const allChecked = checks.price && checks.auth && checks.submit;
  const parse = (s: string) => (s.trim() ? Math.round(Number(s.replace(/[,₹\s]/g, ''))) : null);
  const l1Bad = l1.trim() !== '' && !Number.isFinite(parse(l1));
  const oursBad = ours.trim() !== '' && !Number.isFinite(parse(ours));

  if (w.outcome) {
    const won = w.outcome.result === 'won';
    return (
      <Card className={cn('p-5 text-center', won ? 'border-success/40 bg-success-soft/40' : 'border-danger/30')}>
        {won ? <Trophy className="mx-auto size-10 text-success" aria-hidden /> : <XCircle className="mx-auto size-10 text-danger" aria-hidden />}
        <div className="mt-2 text-lg font-semibold">{won ? 'Bid won' : 'Bid lost'}</div>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-left text-sm">
          <div className="rounded-lg border bg-card p-2.5"><dt className="text-2xs text-muted-foreground">L1 price</dt><dd className="tabular font-semibold">{w.outcome.l1Price ? formatINR(w.outcome.l1Price) : '—'}</dd></div>
          <div className="rounded-lg border bg-card p-2.5"><dt className="text-2xs text-muted-foreground">Our price</dt><dd className="tabular font-semibold">{w.outcome.ourPrice ? formatINR(w.outcome.ourPrice) : '—'}</dd></div>
        </dl>
        {w.outcome.notes && <p className="mt-3 text-left text-[13px] text-muted-foreground">{w.outcome.notes}</p>}
        <p className="mt-3 text-xs text-muted-foreground">Recorded {formatDateIST(w.outcome.at, { time: true })}</p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      {submitted ? (
        <>
          <div className="flex items-center gap-2.5"><CheckCircle2 className="size-6 text-success" aria-hidden /><div><div className="text-sm font-semibold">Submitted on GeM</div><div className="text-xs text-muted-foreground">{w.submittedAt ? formatDateIST(w.submittedAt, { time: true }) : ''}</div></div></div>
          <p className="mt-3 text-[13px] text-muted-foreground">When GeM publishes the result, record it here — the L1 price helps you price the next bid.</p>
          {canWrite && (canRecord
            ? <Button block className="mt-3" variant="secondary" onClick={() => setOutcomeOpen(true)}><PartyPopper /> Record result</Button>
            : <>
              <p className="mt-2 text-xs text-muted-foreground">This bid was moved out of Submitted. Move it back to record the result.</p>
              <Button block className="mt-3" variant="secondary" loading={update.isPending}
                onClick={() => update.mutate({ stage: 'submitted' }, { onSuccess: () => toast.success('Moved to Submitted'), onError: (e) => toast.error(errorMessage(e)) })}>
                <Send /> Move back to Submitted
              </Button>
            </>)}
        </>
      ) : (
        <>
          <div className="text-sm font-semibold">Done on GeM?</div>
          <p className="mt-1 text-[13px] text-muted-foreground">After you press Final Submit on GeM, record it here so your team and pipeline stay in sync.</p>
          {data.readiness.blockers.length > 0 && <p className="mt-2 rounded-md bg-warning-soft px-2 py-1.5 text-xs text-[hsl(32_90%_28%)] dark:text-warning">{data.readiness.blockers.length} checklist item(s) were still missing or expired.</p>}
          {canWrite && <Button block size="lg" className="mt-3" onClick={() => setConfirmOpen(true)}><Send /> Mark as submitted</Button>}
        </>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Confirm you submitted on GeM</DialogTitle>
            <DialogDescription>TenderPilot only records this — the submission itself happened on the GeM portal.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-2.5">
            {openBlockers.length > 0 && (
              <p role="status" className="rounded-md border border-warning/25 bg-warning-soft px-3 py-2 text-xs text-[hsl(32_90%_28%)] dark:text-warning">
                {openBlockers.length} checklist item(s) were still open: {openBlockers.map((b) => b.label).join(', ')}
              </p>
            )}
            {([['price', 'I entered the price myself on GeM'], ['auth', 'I authenticated with OTP / DSC / e-Sign'], ['submit', 'I clicked Final Submit and saw the confirmation']] as const).map(([k, label]) => (
              <label key={k} className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm hover:bg-muted/60">
                <Checkbox checked={checks[k]} onCheckedChange={(v) => setChecks((c) => ({ ...c, [k]: v === true }))} /> {label}
              </label>
            ))}
            <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Submitted by Ravi with DSC" maxLength={300} /></Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button disabled={!allChecked} loading={mark.isPending} onClick={() => mark.mutate(note || undefined, {
              onSuccess: () => { toast.success('Marked as submitted. Good luck!'); setConfirmOpen(false); },
              onError: (e) => toast.error(errorMessage(e)),
            })}>Mark as submitted</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={outcomeOpen} onOpenChange={(o) => { setOutcomeOpen(o); if (!o) setSuggestion(null); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Record the result</DialogTitle>
            <DialogDescription>Prices here are for your records and analytics only — TenderPilot never enters prices on GeM.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3">
            <div>
              <input ref={fileRef} type="file" accept=".html,.htm,text/html" className="sr-only" tabIndex={-1} aria-label="GeM result page (HTML file)"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void suggestFrom(f); }} />
              <Button type="button" size="sm" variant="secondary" onClick={() => fileRef.current?.click()}><FileSearch /> Suggest from GeM result</Button>
              <p className="mt-1 text-xs text-muted-foreground">Pick the public GeM result page you saved as HTML. It is read in your browser only.</p>
              {suggestion === 'unreadable' && <p role="status" className="mt-1.5 rounded-md border border-danger/20 bg-danger-soft px-2 py-1.5 text-xs text-[hsl(350_74%_38%)] dark:text-danger">Could not read that file.</p>}
              {suggestion === 'none' && <p role="status" className="mt-1.5 rounded-md border border-danger/20 bg-danger-soft px-2 py-1.5 text-xs text-[hsl(350_74%_38%)] dark:text-danger">No price table found in this page.</p>}
              {typeof suggestion === 'object' && suggestion && <p role="status" className="mt-1.5 rounded-md border border-info/20 bg-info-soft px-2 py-1.5 text-xs text-[hsl(205_85%_30%)] dark:text-info">Pre-filled the L1 price{suggestion.seller ? ` and seller (${suggestion.seller})` : ''} — check them before saving.</p>}
            </div>
            <Segmented value={result} onChange={setResult} aria-label="Result" options={[{ value: 'won', label: 'Won', icon: <Trophy /> }, { value: 'lost', label: 'Lost', icon: <XCircle /> }]} />
            <Field label="L1 price (₹)" hint={l1 && !l1Bad ? formatINR(parse(l1)) : 'The lowest price disclosed by GeM'} error={l1Bad ? 'Enter a number' : undefined}>
              <Input inputMode="numeric" value={l1} onChange={(e) => setL1(e.target.value)} placeholder="29,50,000" />
            </Field>
            <Field label="Our price (₹)" hint={ours && !oursBad ? formatINR(parse(ours)) : undefined} error={oursBad ? 'Enter a number' : undefined}>
              <Input inputMode="numeric" value={ours} onChange={(e) => setOurs(e.target.value)} />
            </Field>
            <Field label="Notes"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOutcomeOpen(false)}>Cancel</Button>
            <Button variant={result === 'won' ? 'success' : 'primary'} disabled={l1Bad || oursBad} loading={outcome.isPending}
              onClick={() => outcome.mutateAsync({ result, l1Price: parse(l1), ourPrice: parse(ours), notes: notes || null }).then(
                () => { toast.success(result === 'won' ? 'Congratulations on the win!' : 'Result recorded'); setOutcomeOpen(false); },
                (e) => toast.error(errorMessage(e)),
              )}>Save result</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
