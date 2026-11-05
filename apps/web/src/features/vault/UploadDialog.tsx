/** Upload a document: drop a file, we guess type/title/FY, the user confirms the metadata. */
import { useEffect, useState } from 'react';
import { FileText, ImageIcon, Lock, RefreshCw } from 'lucide-react';
import { VAULT_ACCEPT, VAULT_MAX_BYTES, type VaultDocumentDto } from '@tp/core/contracts/vault';
import { guessDocType, guessFinancialYear, type DocType } from '@tp/core/vault/status';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FileDropzone, formatBytes, toast,
} from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import { useUploadVault } from './api';
import { DuplicatePrompt } from './doc-ui';
import { checkVaultFile } from './file-check';
import { duplicateOf, type DuplicateInfo } from './renew';
import { DocumentForm, emptyDraft, validateDraft, type DocDraft } from './DocumentForm';

const titleFrom = (name: string) => name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').replace(/(?<!\d)(20\d{2}) (\d{2})(?!\d)/, '$1-$2').trim();

export function draftForFile(file: File, presetType?: DocType | null): DocDraft {
  const type = presetType ?? guessDocType(file.name);
  return { ...emptyDraft(type), title: titleFrom(file.name), financialYear: guessFinancialYear(file.name) ?? '' };
}

export function serverFieldErrors(e: unknown): Record<string, string> {
  if (e instanceof ApiError && e.details && typeof e.details === 'object' && 'fields' in e.details) return (e.details as { fields: Record<string, string> }).fields;
  return {};
}

/** `onUploaded(id)` opens a document: the new one, or the existing one after **Open existing** (FR-067). */
export function UploadDialog({ open, onOpenChange, initialFile, presetType, onUploaded }: {
  open: boolean; onOpenChange: (o: boolean) => void; initialFile?: File | null; presetType?: DocType | null; onUploaded?: (id: string, doc: VaultDocumentDto) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<DocDraft>(emptyDraft());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dup, setDup] = useState<DuplicateInfo | null>(null);
  const upload = useUploadVault();

  useEffect(() => {
    if (!open) return;
    setErrors({}); setDup(null);
    if (initialFile && !checkVaultFile(initialFile)) { setFile(initialFile); setDraft(draftForFile(initialFile, presetType)); }
    else { setFile(null); setDraft(emptyDraft(presetType ?? 'other')); }
  }, [open, initialFile, presetType]);

  const pick = (f: File) => {
    const problem = checkVaultFile(f);
    if (problem) { setErrors({ file: problem }); return; }
    setFile(f);
    // Keep anything the user already typed; fill the rest from the file name.
    setDraft((d) => {
      const g = draftForFile(f, presetType);
      return { ...d, type: d.title || presetType ? d.type : g.type, title: d.title || g.title, financialYear: d.financialYear || g.financialYear };
    });
    setErrors({}); setDup(null);
  };

  const submit = (allowDuplicate = false) => {
    if (!file) { setErrors({ file: 'Choose a file to upload' }); return; }
    const e = validateDraft(draft);
    setErrors(e);
    if (Object.keys(e).length) return;
    upload.mutate({
      file,
      fields: {
        type: draft.type, title: draft.title.trim(), number: draft.number.trim(), issuer: draft.issuer.trim(), issueDate: draft.issueDate,
        expiryDate: draft.expiryDate, financialYear: draft.financialYear, tags: draft.tags.length ? draft.tags : undefined, allowDuplicate,
      },
    }, {
      onSuccess: (doc) => {
        toast.success(`“${doc.title}” added to the vault`, {
          description: doc.status === 'expired' ? 'Heads up: this document has already expired.' : doc.status === 'expiring' ? `It expires in ${doc.daysToExpiry} days — we’ll remind you.` : doc.pageCount ? `${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'} · stored privately` : 'Stored privately',
        });
        onUploaded?.(doc.id, doc);
        onOpenChange(false);
      },
      onError: (err) => {
        const d = duplicateOf(err);
        if (d) { setDup(d); return; }
        const f = serverFieldErrors(err);
        setErrors(Object.keys(f).length ? f : { file: errorMessage(err) });
      },
    });
  };

  const isImage = file?.type.startsWith('image/');
  return (
    <Dialog open={open} onOpenChange={(o) => !upload.isPending && onOpenChange(o)}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add a document</DialogTitle>
          <DialogDescription>PDF, PNG or JPG up to 20 MB. Files are stored privately and only your team can open them.</DialogDescription>
        </DialogHeader>
        <form id="vault-upload" className="grid gap-5" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          {file ? (
            <div className="flex items-center gap-3 rounded-xl border bg-subtle px-3 py-2.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-card text-primary">{isImage ? <ImageIcon className="size-5" /> : <FileText className="size-5" />}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
              <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border bg-card px-3 text-xs font-medium hover:bg-muted focus-within:ring-2 focus-within:ring-ring">
                <RefreshCw className="size-3.5" aria-hidden />Change
                <input type="file" className="sr-only" accept={VAULT_ACCEPT} onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }} />
              </label>
            </div>
          ) : (
            <FileDropzone
              accept={VAULT_ACCEPT} maxSize={VAULT_MAX_BYTES} onFiles={(fs) => fs[0] && pick(fs[0])}
              hint="PDF, PNG or JPG · up to 20 MB · we’ll guess the type from the file name"
            />
          )}
          {errors.file && <p role="alert" className="-mt-3 text-xs font-medium text-danger">{errors.file}</p>}
          {dup && (
            <DuplicatePrompt
              title={dup.title} busy={upload.isPending}
              onOpenExisting={() => { onUploaded?.(dup.existingId); onOpenChange(false); }}
              onUploadAnyway={() => submit(true)}
            />
          )}
          <DocumentForm draft={draft} onChange={setDraft} errors={errors} />
        </form>
        <DialogFooter className="items-center sm:justify-between">
          <p className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"><Lock className="size-3.5" aria-hidden />Private to your organisation</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={upload.isPending}>Cancel</Button>
            <Button type="submit" form="vault-upload" loading={upload.isPending} disabled={!file}>Upload document</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
