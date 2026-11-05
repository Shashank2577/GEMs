/** Preview drawer: inline PDF/image preview, metadata (view & edit), replace file, download, delete. */
import { useEffect, useState } from 'react';
import { BellRing, Calendar, Download, ExternalLink, FileWarning, Hash, Pencil, RefreshCw, Tag, Trash2, User } from 'lucide-react';
import type { VaultDocumentDto } from '@tp/core/contracts/vault';
import { VAULT_ACCEPT } from '@tp/core/contracts/vault';
import { docTypeInfo } from '@tp/core/vault/status';
import {
  Badge, Button, ConfirmDialog, Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, Skeleton, formatBytes, toast,
} from '@/components/ui';
import { apiUrl, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateIST, relativeTime } from '@/lib/format';
import { useDeleteVault, useReplaceVaultFile, useUpdateVault } from './api';
import { checkVaultFile } from './file-check';
import { DocTypeIcon, ExpiryBadge } from './doc-ui';
import { DocumentForm, validateDraft, type DocDraft } from './DocumentForm';
import { nextReminderLine } from './reminders';
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
  const update = useUpdateVault();
  const replace = useReplaceVaultFile();
  const del = useDeleteVault();

  useEffect(() => { if (doc) { setDraft(toDraft(doc)); setErrors({}); } }, [doc?.id, doc?.updatedAt]);
  useEffect(() => { if (!open) setEditing(false); }, [open]);

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

  const onReplace = (f: File | undefined) => {
    if (!f) return;
    const problem = checkVaultFile(f);
    if (problem) { toast.error(problem); return; }
    replace.mutate({ id: doc.id, file: f }, {
      onSuccess: () => toast.success('File replaced', { description: 'Metadata kept. Update the expiry date if this is a renewed copy.' }),
      onError: (err) => toast.error(errorMessage(err)),
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
            {doc.status === 'expired' && (
              <div role="status" className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger-soft/60 px-3 py-2.5 text-sm">
                <FileWarning className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                <p>This document expired on <strong>{formatDateIST(doc.expiryDate)}</strong>. Bids that need it can’t be marked ready until you upload the renewed copy{canWrite ? ' with “Replace file”' : ''}.</p>
              </div>
            )}
            {editing && draft ? (
              <form id="vault-edit" onSubmit={(e) => { e.preventDefault(); save(); }} noValidate>
                <DocumentForm draft={draft} onChange={setDraft} errors={errors} />
              </form>
            ) : (
              <>
                <Preview doc={doc} />
                <dl className="grid gap-x-6 sm:grid-cols-2">
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
                  <div className="flex gap-2">
                    <Button variant="ghost" size="icon-sm" aria-label="Delete document" className="text-danger hover:bg-danger-soft hover:text-danger" onClick={() => setConfirm(true)}><Trash2 /></Button>
                    <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border bg-card px-3 text-[13px] font-medium hover:bg-muted focus-within:ring-2 focus-within:ring-ring">
                      <RefreshCw className={replace.isPending ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />{replace.isPending ? 'Replacing…' : 'Replace file'}
                      <input type="file" className="sr-only" accept={VAULT_ACCEPT} disabled={replace.isPending} onChange={(e) => { onReplace(e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                    <Button size="sm" onClick={() => setEditing(true)}><Pencil />Edit details</Button>
                  </div>
                )}
              </>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm} loading={del.isPending} onConfirm={onDelete} confirmLabel="Delete document"
        title={`Delete “${doc.title}”?`}
        description="The file is removed from the vault for everyone in your organisation. Packets already generated keep their copy."
      />
    </>
  );
}
