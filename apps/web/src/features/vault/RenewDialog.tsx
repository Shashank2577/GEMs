/**
 * Renew a document in one step (T070; FR-064, FR-068): new file + issue date (default today), expiry
 * (pre-filled with `suggestExpiry`) and number, sent with `PUT /vault/:id/file`. The previous file is kept
 * as a version server-side; a new expiry restarts the 30/7/1-day reminders.
 */
import { useEffect, useState } from 'react';
import { FileText, ImageIcon, RefreshCw } from 'lucide-react';
import type { VaultDocumentDto } from '@tp/core/contracts/vault';
import { VAULT_ACCEPT, VAULT_MAX_BYTES } from '@tp/core/contracts/vault';
import { docTypeInfo, suggestExpiry } from '@tp/core/vault/status';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, FileDropzone, Input, formatBytes, toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useReplaceVaultFile } from './api';
import { DuplicatePrompt } from './doc-ui';
import { checkVaultFile } from './file-check';
import { duplicateOf, renewDefaults, renewedMessage, type DuplicateInfo, type RenewDraft } from './renew';
import { serverFieldErrors } from './UploadDialog';

export function RenewDialog({ doc, open, onOpenChange, onOpenExisting }: {
  doc: VaultDocumentDto; open: boolean; onOpenChange: (o: boolean) => void; onOpenExisting: (id: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<RenewDraft>(() => renewDefaults(doc));
  const [expiryTouched, setExpiryTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dup, setDup] = useState<DuplicateInfo | null>(null);
  const replace = useReplaceVaultFile();
  const info = docTypeInfo(doc.type);

  useEffect(() => {
    if (!open) return;
    setFile(null); setDraft(renewDefaults(doc)); setExpiryTouched(false); setErrors({}); setDup(null);
  }, [open, doc.id]);

  const pick = (f: File) => {
    const problem = checkVaultFile(f);
    if (problem) { setErrors({ file: problem }); return; }
    setFile(f); setErrors({}); setDup(null);
  };

  const setIssue = (issueDate: string) => setDraft((d) => ({
    ...d, issueDate,
    // Keep the expiry following the issue date until the user picks one themselves.
    expiryDate: expiryTouched ? d.expiryDate : (suggestExpiry(doc.type, issueDate || null) ?? d.expiryDate),
  }));

  const submit = (allowDuplicate = false) => {
    if (!file) { setErrors({ file: 'Choose the renewed file' }); return; }
    const e: Record<string, string> = {};
    if (draft.issueDate && draft.expiryDate && draft.expiryDate < draft.issueDate) e.expiryDate = 'Expiry date is before the issue date';
    setErrors(e);
    if (Object.keys(e).length) return;
    replace.mutate({
      id: doc.id, file,
      fields: { issueDate: draft.issueDate, expiryDate: draft.expiryDate, number: draft.number.trim(), allowDuplicate },
    }, {
      onSuccess: (updated) => { toast.success(renewedMessage(updated)); onOpenChange(false); },
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
    <Dialog open={open} onOpenChange={(o) => !replace.isPending && onOpenChange(o)}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{`Renew “${doc.title}”`}</DialogTitle>
          <DialogDescription>Upload the renewed copy and confirm its dates. The current file is kept under Versions and reminders restart for the new expiry.</DialogDescription>
        </DialogHeader>
        <form id="vault-renew" className="grid gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
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
              onReject={(m) => setErrors({ file: m })}
              title="Choose the renewed file" hint="PDF, PNG or JPG · up to 20 MB"
            />
          )}
          {errors.file && <p role="alert" className="-mt-2 text-xs font-medium text-danger">{errors.file}</p>}
          {dup && (
            <DuplicatePrompt
              title={dup.title} busy={replace.isPending}
              onOpenExisting={() => { onOpenChange(false); onOpenExisting(dup.existingId); }}
              onUploadAnyway={() => submit(true)}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Issue date" error={errors.issueDate}>
              <Input type="date" value={draft.issueDate} onChange={(e) => setIssue(e.target.value)} max="2100-12-31" />
            </Field>
            <Field label="Expiry date" error={errors.expiryDate} hint={info.expires ? undefined : 'Leave empty if it never expires.'}>
              <Input
                type="date" value={draft.expiryDate} min={draft.issueDate || undefined} max="2100-12-31"
                onChange={(e) => { setExpiryTouched(true); setDraft((d) => ({ ...d, expiryDate: e.target.value })); }}
              />
            </Field>
            <Field label="Number" error={errors.number} className="sm:col-span-2">
              <Input value={draft.number} onChange={(e) => setDraft((d) => ({ ...d, number: e.target.value }))} placeholder="Optional" className="font-mono text-[13px]" />
            </Field>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={replace.isPending}>Cancel</Button>
          <Button type="submit" form="vault-renew" loading={replace.isPending} disabled={!file}>Renew document</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
