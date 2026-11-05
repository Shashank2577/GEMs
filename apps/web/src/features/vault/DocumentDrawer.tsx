/** Preview drawer: inline PDF/image preview, metadata (view & edit), renew / replace file, versions, download, delete. */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BellRing, Calendar, CalendarClock, Download, ExternalLink, FileWarning, Hash, History, Pencil, RefreshCw, Tag, Trash2, User } from 'lucide-react';
import type { VaultDocumentDto } from '@tp/core/contracts/vault';
import { VAULT_ACCEPT } from '@tp/core/contracts/vault';
import { docTypeInfo } from '@tp/core/vault/status';
import {
  Badge, Button, ConfirmDialog, Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, Skeleton, formatBytes, toast,
} from '@/components/ui';
import { apiUrl, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateIST, relativeTime } from '@/lib/format';
import { useDeleteVault, useReplaceVaultFile, useUpdateVault, useVaultVersions } from './api';
import { checkVaultFile } from './file-check';
import { DocTypeIcon, DuplicatePrompt, ExpiryBadge } from './doc-ui';
import { DocumentForm, validateDraft, type DocDraft } from './DocumentForm';
import { nextReminderLine } from './reminders';
import { RenewDialog } from './RenewDialog';
import { duplicateOf, versionLine, type DuplicateInfo } from './renew';
import { serverFieldErrors } from './UploadDialog';

const toDraft = (d: VaultDocumentDto): DocDraft => ({
  type: d.type, title: d.title, number: d.number ?? '', issuer: d.issuer ?? '', issueDate: d.issueDate ?? '', expiryDate: d.expiryDate ?? '',
  financialYear: d.financialYear ?? '', tags: d.tags,
});

function Preview({ doc }: { doc: VaultDocumentDto }) {
  const [loaded, setLoaded] = useState(false);
  const src = apiUrl(`/vault/${doc.id}/download`, { inline: 1, v: doc.updatedAt });
  useEffect(() => setLoaded(false), [src]);
  return (
    <div className="relative overflow-hidden rounded-xl border bg-subtle">
      {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
      {doc.mimeType === 'application/pdf' ? (
        <iframe title={`Preview of ${doc.title}`} src={`${src}#toolbar=0&view=FitH`} onLoad={() => setLoaded(true)} className="h-[52vh] min-h-[320px] w-full bg-white" />
      ) : (
        <img src={src} alt={`Scan of ${doc.title}`} onLoad={() => setLoaded(true)} onError={() => setLoaded(true)} className="mx-auto max-h-[52vh] min-h-[200px] w-auto object-contain" />
      )}
    </div>
  );
}

/** Previous files kept on renewal/replace, newest first, each downloadable — viewers included (T071; FR-066, FR-068). */
function Versions({ docId }: { docId: string }) {
  const q = useVaultVersions(docId);
  const items = q.data?.items ?? [];
  if (q.isLoading) return <Skeleton className="h-10 w-full" />;
  if (q.isError || !items.length) return null;
  return (
    <section aria-labelledby="vault-versions" className="grid gap-1.5">
      <h3 id="vault-versions" className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground"><History className="size-3.5" aria-hidden />Versions</h3>
      <ul className="divide-y rounded-lg border" data-testid="vault-versions">
        {items.map((v) => (
          <li key={v.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 break-words">{versionLine(v)}</span>
            <Button variant="ghost" size="sm" asChild>
              <a href={apiUrl(`/vault/${docId}/versions/${v.id}/download`)} download aria-label={`Download ${v.fileName}`}><Download />Download</a>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Meta({ icon: Icon, label, children }: { icon: typeof Calendar; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 py-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
        <dd className="mt-0.5 break-words text-sm">{children}</dd>
      </div>
    </div>
  );
}

export function DocumentDrawer({ doc, open, onOpenChange }: { doc: VaultDocumentDto | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const canWrite = can('analyst');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DocDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [, setParams] = useSearchParams();
  const openDoc = (id: string) => setParams((p) => { const n = new URLSearchParams(p); n.set('doc', id); return n; });
  /** Replace file refused as a duplicate (FR-067): the file to re-send with allowDuplicate and the existing document. */
  const [replaceDup, setReplaceDup] = useState<{ file: File; info: DuplicateInfo } | null>(null);
  const update = useUpdateVault();
  const replace = useReplaceVaultFile();
  const del = useDeleteVault();

  useEffect(() => { if (doc) { setDraft(toDraft(doc)); setErrors({}); } }, [doc?.id, doc?.updatedAt]);
  useEffect(() => { if (!open) { setEditing(false); setRenewing(false); } }, [open]);
  useEffect(() => setReplaceDup(null), [doc?.id, open]);

  if (!doc) return null;
  const info = docTypeInfo(doc.type);

  const save = () => {
    if (!draft) return;
    const e = validateDraft(draft);
    setErrors(e);
    if (Object.keys(e).length) return;
    update.mutate({
      id: doc.id, type: draft.type, title: draft.title.trim(), number: draft.number, issuer: draft.issuer, issueDate: draft.issueDate || null,
      expiryDate: draft.expiryDate || null, financialYear: draft.financialYear || null, tags: draft.tags,
    }, {
      onSuccess: () => { toast.success('Document updated'); setEditing(false); },
      onError: (err) => { const f = serverFieldErrors(err); setErrors(f); if (!Object.keys(f).length) toast.error(errorMessage(err)); },
    });
  };

  const onReplace = (f: File | undefined, allowDuplicate = false) => {
    if (!f) return;
    const problem = checkVaultFile(f);
    if (problem) { toast.error(problem); return; }
    setReplaceDup(null);
    replace.mutate({ id: doc.id, file: f, fields: { allowDuplicate } }, {
      onSuccess: () => toast.success('File replaced', { description: 'Metadata kept. Update the expiry date if this is a renewed copy.' }),
      onError: (err) => {
        const d = duplicateOf(err);
        if (d) setReplaceDup({ file: f, info: d });
        else toast.error(errorMessage(err));
      },
    });
  };

  const onDelete = () => del.mutate(doc.id, {
    onSuccess: () => { toast.success(`“${doc.title}” deleted`); setConfirm(false); onOpenChange(false); },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:w-[min(100%,42rem)]" aria-describedby={undefined}>
          <SheetHeader>
            <div className="flex items-start gap-3">
              <DocTypeIcon type={doc.type} size="lg" />
              <div className="min-w-0">
                <SheetTitle className="truncate text-base">{doc.title}</SheetTitle>
                <SheetDescription className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <span>{info.label}</span>
                  <span aria-hidden>·</span>
                  <ExpiryBadge status={doc.status} days={doc.daysToExpiry} />
                  {doc.financialYear && <Badge size="sm" tone="outline">FY {doc.financialYear}</Badge>}
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>
          <SheetBody className="grid content-start gap-5">
            {replaceDup && (
              <DuplicatePrompt
                title={replaceDup.info.title} busy={replace.isPending}
                onOpenExisting={() => { const id = replaceDup.info.existingId; setReplaceDup(null); openDoc(id); }}
                onUploadAnyway={() => onReplace(replaceDup.file, true)}
              />
            )}
            {doc.status === 'expired' && (
              <div role="status" className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger-soft/60 px-3 py-2.5 text-sm">
                <FileWarning className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                <p>This document expired on <strong>{formatDateIST(doc.expiryDate)}</strong>. Bids that need it can’t be marked ready until you upload the renewed copy{canWrite ? ' with “Renew”' : ''}.</p>
              </div>
            )}
            {editing && draft ? (
              <form id="vault-edit" onSubmit={(e) => { e.preventDefault(); save(); }} noValidate>
                <DocumentForm draft={draft} onChange={setDraft} errors={errors} />
              </form>
            ) : (
              <>
                <Preview doc={doc} />
                <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                  <Meta icon={Hash} label="Number">{doc.number ? <span className="font-mono text-[13px]">{doc.number}</span> : <span className="text-muted-foreground">—</span>}</Meta>
                  <Meta icon={User} label="Issued by">{doc.issuer ?? <span className="text-muted-foreground">—</span>}</Meta>
                  <Meta icon={Calendar} label="Issue date">{formatDateIST(doc.issueDate, { fallback: '—' })}</Meta>
                  <Meta icon={Calendar} label="Expiry date">{doc.expiryDate ? (
                    <>
                      {formatDateIST(doc.expiryDate)}
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground" data-testid="next-reminder">
                        <BellRing className="size-3.5 shrink-0" aria-hidden />{nextReminderLine(doc.nextReminder)}
                      </span>
                    </>
                  ) : <span className="text-muted-foreground">Does not expire</span>}</Meta>
                  <Meta icon={Tag} label="Tags">{doc.tags.length ? <span className="flex flex-wrap gap-1">{doc.tags.map((t) => <Badge key={t} size="sm">{t}</Badge>)}</span> : <span className="text-muted-foreground">—</span>}</Meta>
                  <Meta icon={Download} label="File">{doc.fileName} · {formatBytes(doc.sizeBytes)}{doc.pageCount ? ` · ${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}` : ''}</Meta>
                </dl>
                <p className="text-xs text-muted-foreground">Uploaded {relativeTime(doc.createdAt)}{doc.uploadedBy ? ` by ${doc.uploadedBy.name}` : ''}{doc.updatedAt !== doc.createdAt ? ` · updated ${relativeTime(doc.updatedAt)}` : ''}</p>
                <Versions docId={doc.id} />
              </>
            )}
          </SheetBody>
          <SheetFooter className="flex-wrap justify-between">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => { setEditing(false); setDraft(toDraft(doc)); setErrors({}); }}>Cancel</Button>
                <Button type="submit" form="vault-edit" loading={update.isPending}>Save changes</Button>
              </>
            ) : (
              <>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" asChild><a href={apiUrl(`/vault/${doc.id}/download`)} download><Download />Download</a></Button>
                  <Button variant="ghost" size="sm" asChild><a href={apiUrl(`/vault/${doc.id}/download`, { inline: 1 })} target="_blank" rel="noreferrer"><ExternalLink />Open</a></Button>
                </div>
                {canWrite && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" size="icon-sm" aria-label="Delete document" className="text-danger hover:bg-danger-soft hover:text-danger" onClick={() => setConfirm(true)}><Trash2 /></Button>
                    <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border bg-card px-3 text-[13px] font-medium hover:bg-muted focus-within:ring-2 focus-within:ring-ring">
                      <RefreshCw className={replace.isPending ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />{replace.isPending ? 'Replacing…' : 'Replace file'}
                      <input type="file" className="sr-only" accept={VAULT_ACCEPT} disabled={replace.isPending} onChange={(e) => { onReplace(e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                    <Button variant="outline" size="sm" onClick={() => setRenewing(true)}><CalendarClock />Renew</Button>
                    <Button size="sm" onClick={() => setEditing(true)}><Pencil />Edit details</Button>
                  </div>
                )}
              </>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>
      {canWrite && (
        <RenewDialog
          doc={doc} open={renewing} onOpenChange={setRenewing}
          onOpenExisting={openDoc}
        />
      )}
      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm} loading={del.isPending} onConfirm={onDelete} confirmLabel="Delete document"
        title={`Delete “${doc.title}”?`}
        description="The file is removed from the vault for everyone in your organisation. Packets already generated keep their copy."
      />
    </>
  );
}
