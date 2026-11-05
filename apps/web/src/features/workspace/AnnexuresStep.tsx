import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker } from 'react-router-dom';
import { AlertCircle, ArrowRight, Download, Eye, FileSignature, PencilLine, RotateCcw, ExternalLink } from 'lucide-react';
import type { WorkspaceAnnexure, WorkspaceDetail } from '@tp/core/contracts/apply';
import {
  Badge, Button, Card, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Skeleton, Textarea, Tooltip, toast,
} from '@/components/ui';
import { unknownPlaceholderMessage, unknownPlaceholders } from '@tp/core/packet/placeholders';
import { useCan } from '@/lib/auth';
import { ApiError, errorMessage } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { previewAnnexure, useResetTemplate, useSaveTemplate, useTemplates } from './api';
import { INSERTABLE_PLACEHOLDERS, placeholderLabel } from './labels';

export function AnnexuresStep({ data, selected, onSelect, onNext }: { data: WorkspaceDetail; selected: string | null; onSelect: (k: string) => void; onNext: () => void }) {
  const list = data.annexures;
  const current = list.find((a) => a.key === selected) ?? list.find((a) => a.required) ?? list[0];
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<WorkspaceAnnexure | null>(null);
  const isMobile = useIsMobile();
  // FR-043: the template editor is for Bid Manager+ only.
  const canEditTemplates = useCan('bid_manager');

  if (!list.length) return null;
  const src = `${current.pdfUrl}?v=${version}#toolbar=0&navpanes=0`;

  return (
    <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
      <div className="grid grid-cols-1 content-start gap-2">
        {data.profileGaps.length > 0 && (
          <div className="flex gap-2.5 rounded-xl border border-warning/30 bg-warning-soft/60 p-3 text-[13px]">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div>
              <div className="font-medium">Some blanks will print as “__________”</div>
              <p className="text-muted-foreground">Add {data.profileGaps.slice(0, 4).map(placeholderLabel).join(', ')}{data.profileGaps.length > 4 ? '…' : ''} to fill them automatically.</p>
              <Button asChild size="xs" variant="link" className="mt-1"><Link to="/profile">Complete company profile <ArrowRight /></Link></Button>
            </div>
          </div>
        )}
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 2xl:grid-cols-1" aria-label="Annexures">
          {list.map((a) => (
            <li key={a.key}>
              <button
                type="button" onClick={() => onSelect(a.key)} aria-current={a.key === current.key ? 'true' : undefined}
                className={cn('flex w-full items-start gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:border-primary/30 focus-ring', a.key === current.key && 'border-primary/50 bg-primary-soft/40 shadow-xs')}
              >
                <FileSignature className={cn('mt-0.5 size-4 shrink-0', a.key === current.key ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium leading-snug">{a.title}</div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{a.description}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {a.required ? <Badge tone="primary" size="sm">Required by this bid</Badge> : a.itemId ? <Badge tone="neutral" size="sm">Recommended</Badge> : <Badge tone="outline" size="sm">Optional</Badge>}
                    {a.missing.length > 0 && <Tooltip content={`Blank: ${a.missing.map(placeholderLabel).join(', ')}`}><span><Badge tone="warning" size="sm">{a.missing.length} blank{a.missing.length === 1 ? '' : 's'}</Badge></span></Tooltip>}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" onClick={onNext} className="mt-1">Build the packet <ArrowRight /></Button>
      </div>

      <Card className="flex min-h-[420px] flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="min-w-[220px] flex-1">
            <div className="truncate text-sm font-semibold">{current.title}</div>
            <div className="text-xs text-muted-foreground">Filled with your profile and this tender · sign & stamp before uploading</div>
          </div>
          {canEditTemplates && <Button size="sm" variant="ghost" onClick={() => setEditing(current)}><PencilLine /> Edit template</Button>}
          <Button asChild size="sm" variant="ghost"><a href={`${current.pdfUrl}`} target="_blank" rel="noreferrer"><ExternalLink /> Open</a></Button>
          <Button asChild size="sm" variant="secondary"><a href={`${current.pdfUrl}?download=1`}><Download /> Download</a></Button>
        </div>
        {isMobile ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <FileSignature className="size-10 text-primary" aria-hidden />
            <p className="max-w-xs text-sm text-muted-foreground">PDF previews open full-screen on phones.</p>
            <Button asChild><a href={current.pdfUrl} target="_blank" rel="noreferrer"><Eye /> Preview PDF</a></Button>
          </div>
        ) : (
          <PdfFrame key={src} src={src} title={`${current.title} preview`} />
        )}
      </Card>

      {editing && canEditTemplates && <TemplateEditor wsId={data.workspace.id} annexure={editing} onClose={() => setEditing(null)} onSaved={() => setVersion((v) => v + 1)} />}
    </div>
  );
}

function PdfFrame({ src, title }: { src: string; title: string }) {
  const [loaded, setLoaded] = useState(false);
  // Some browsers never fire onLoad for PDFs in iframes — stop showing the skeleton after a moment.
  useEffect(() => { const t = window.setTimeout(() => setLoaded(true), 2500); return () => window.clearTimeout(t); }, [src]);
  return (
    <div className="relative flex-1 bg-muted/40">
      {!loaded && <div className="absolute inset-0 grid place-items-center p-8"><div className="w-full max-w-md space-y-3"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4" /><Skeleton className="h-4" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-40" /></div></div>}
      <iframe title={title} src={src} onLoad={() => setLoaded(true)} className={cn('h-[70vh] min-h-[420px] w-full transition-opacity', loaded ? 'opacity-100' : 'opacity-0')} />
    </div>
  );
}

/** Palette entries grouped by `group`, in catalogue order. */
const PALETTE_GROUPS = [...INSERTABLE_PLACEHOLDERS.reduce((m, p) => m.set(p.group, [...(m.get(p.group) ?? []), p]), new Map<string, (typeof INSERTABLE_PLACEHOLDERS)[number][]>())];

function TemplateEditor({ wsId, annexure, onClose, onSaved }: { wsId: string; annexure: WorkspaceAnnexure; onClose: () => void; onSaved: () => void }) {
  const templates = useTemplates();
  const tpl = useMemo(() => templates.data?.items.find((t) => t.key === annexure.key), [templates.data, annexure.key]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const save = useSaveTemplate();
  const reset = useResetTemplate();
  const ta = useRef<HTMLTextAreaElement>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  /** Message from an `unknown_placeholder` refusal (FR-041); cleared when the body changes. */
  const [serverUnknown, setServerUnknown] = useState<string | null>(null);

  /** Text the editor was seeded with (or last saved/restored); edits are compared against it. */
  const [baseline, setBaseline] = useState<{ title: string; body: string } | null>(null);
  // Seed once per opened template: a background refetch of the templates list must not wipe edits.
  useEffect(() => {
    if (tpl && !baseline) { setTitle(tpl.title); setBody(tpl.body); setBaseline({ title: tpl.title, body: tpl.body }); }
  }, [tpl, baseline]);
  useEffect(() => { setServerUnknown(null); }, [body]);

  const unknown = useMemo(() => unknownPlaceholders(body), [body]);
  const bodyError = unknown.length ? unknownPlaceholderMessage(unknown) : serverUnknown;
  // FR-092: unsaved edits prompt before closing the editor or leaving the page.
  const dirty = !!baseline && (title !== baseline.title || body !== baseline.body);
  // In-app navigation (links, Back/Forward, ?step= changes). The blocker only exists while this editor is
  // mounted and only blocks while dirty, so it never competes with another page's blocker.
  const blocker = useBlocker(useCallback(
    ({ currentLocation, nextLocation }: { currentLocation: { pathname: string; search: string }; nextLocation: { pathname: string; search: string } }) =>
      dirty && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
    [dirty],
  ));
  useEffect(() => { if (blocker.state === 'blocked' && !dirty) blocker.reset(); }, [blocker, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const requestClose = () => { if (dirty) setConfirmClose(true); else onClose(); };
  /** Show unknown-placeholder refusals inline under the body instead of as a toast. */
  const handleError = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'unknown_placeholder') setServerUnknown(e.message);
    else toast.error(errorMessage(e));
  };
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const insert = (p: string) => {
    const el = ta.current;
    const token = `{{${p}}}`;
    if (!el) { setBody((b) => b + token); return; }
    const { selectionStart: s, selectionEnd: e } = el;
    const next = body.slice(0, s) + token + body.slice(e);
    setBody(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + token.length, s + token.length); });
  };
  const preview = async () => {
    setPreviewing(true);
    try { setPreviewUrl(await previewAnnexure(wsId, annexure.key, title, body)); } catch (e) { handleError(e); } finally { setPreviewing(false); }
  };
  const doSave = () => save.mutate({ key: annexure.key, title, body }, {
    onSuccess: () => { toast.success('Template saved for your organisation'); onSaved(); onClose(); },
    onError: handleError,
  });
  const doReset = () => reset.mutate(annexure.key, {
    onSuccess: (t) => { setTitle(t.title); setBody(t.body); setBaseline({ title: t.title, body: t.body }); onSaved(); toast.success('Restored the TenderPilot template'); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <>
    <Dialog open onOpenChange={(o) => !o && requestClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Edit “{annexure.title}”</DialogTitle>
          <DialogDescription>Changes apply to every bid in your organisation. Use placeholders like <code className="rounded bg-muted px-1">{'{{company.legalName}}'}</code>; blank lines separate paragraphs, lines starting with “1.” become numbered clauses.</DialogDescription>
        </DialogHeader>
        {!tpl ? <div className="space-y-3"><Skeleton className="h-9" /><Skeleton className="h-64" /></div> : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="grid grid-cols-1 content-start gap-3">
              <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
              <Field label="Body" error={bodyError}>
                <Textarea ref={ta} value={body} onChange={(e) => setBody(e.target.value)} rows={16} className="font-mono text-[12.5px] leading-relaxed" spellCheck />
              </Field>
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">Insert placeholder</div>
                <div className="grid gap-1.5">
                  {PALETTE_GROUPS.map(([group, items]) => (
                    <div key={group} role="group" aria-label={group} className="flex flex-wrap items-center gap-1">
                      <span className="mr-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">{group}</span>
                      {items.map((p) => (
                        <button key={p.path} type="button" onClick={() => insert(p.path)} className="rounded-md border bg-card px-1.5 py-0.5 font-mono text-2xs hover:border-primary/40 hover:text-primary focus-ring" title={placeholderLabel(p.path)} aria-label={`Insert ${placeholderLabel(p.path)} ({{${p.path}}})`}>{p.path}</button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex min-h-[320px] flex-col overflow-hidden rounded-xl border bg-muted/30">
              {unknown.length > 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="unknown-placeholders">
                  <AlertCircle className="size-8 text-danger" aria-hidden />
                  <p className="text-sm text-muted-foreground">Fix these placeholders to preview:</p>
                  <div className="flex flex-wrap justify-center gap-1">
                    {unknown.map((p) => <mark key={p} className="rounded-md bg-danger-soft px-1.5 py-0.5 font-mono text-xs text-danger">{`{{${p}}}`}</mark>)}
                  </div>
                </div>
              ) : previewUrl ? <iframe title="Draft preview" src={`${previewUrl}#toolbar=0`} className="h-full min-h-[420px] w-full flex-1" /> : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                  <Eye className="size-8 text-muted-foreground" aria-hidden />
                  <p className="text-sm text-muted-foreground">Preview the draft with this bid’s data before saving.</p>
                </div>
              )}
            </div>
          </div>
        )}
        <DialogFooter className="flex-wrap gap-2">
          {tpl?.custom && <Button variant="ghost" onClick={doReset} loading={reset.isPending} className="mr-auto"><RotateCcw /> Restore default</Button>}
          <Button variant="secondary" onClick={preview} loading={previewing} disabled={!tpl || body.trim().length < 20 || unknown.length > 0}><Eye /> Preview</Button>
          {/* Save stays enabled with unknown placeholders on purpose: the server refuses with 400 unknown_placeholder (FR-041), shown inline. */}
          <Button onClick={doSave} loading={save.isPending} disabled={!tpl || title.trim().length < 3 || body.trim().length < 20}>Save template</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <ConfirmDialog
      open={confirmClose || blocker.state === 'blocked'}
      onOpenChange={(o) => { if (!o) { setConfirmClose(false); if (blocker.state === 'blocked') blocker.reset(); } }}
      title="Discard unsaved changes?"
      description="Your edits to this template have not been saved."
      cancelLabel="Keep editing"
      confirmLabel="Discard changes"
      onConfirm={() => { setConfirmClose(false); if (blocker.state === 'blocked') blocker.proceed(); onClose(); }}
    />
    </>
  );
}
