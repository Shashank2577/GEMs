/** Past contracts / CRACs — saved immediately (separate API from the profile form). */
import { useEffect, useState } from 'react';
import { Briefcase, Link2, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { BUYER_TYPES, BUYER_TYPE_LABELS, pastContractCreateSchema, type PastContractDto } from '@tp/core/contracts/vault';
import {
  Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, ErrorState, Field, Input, ResponsiveTable, Select, SkeletonList, toast, type Column,
} from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateIST, formatINR, formatINRCompact } from '@/lib/format';
import { useVault } from '@/features/vault/api';
import { serverFieldErrors, UploadDialog } from '@/features/vault/UploadDialog';
import { useDeletePastContract, usePastContracts, useSavePastContract } from './api';
import { RupeeInput } from './RupeeInput';

interface Draft { buyer: string; buyerType: (typeof BUYER_TYPES)[number]; title: string; category: string; value: number | null; startDate: string; endDate: string; gemContractNo: string; cracDocumentId: string }
const empty: Draft = { buyer: '', buyerType: 'central', title: '', category: '', value: null, startDate: '', endDate: '', gemContractNo: '', cracDocumentId: '' };
const fromDto = (c: PastContractDto): Draft => ({
  buyer: c.buyer, buyerType: c.buyerType, title: c.title, category: c.category ?? '', value: c.value, startDate: c.startDate ?? '', endDate: c.endDate ?? '',
  gemContractNo: c.gemContractNo ?? '', cracDocumentId: c.cracDocumentId ?? '',
});

function ContractDialog({ open, onOpenChange, editing }: { open: boolean; onOpenChange: (o: boolean) => void; editing: PastContractDto | null }) {
  const [d, setD] = useState<Draft>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useSavePastContract();
  const docs = useVault({ category: 'Experience' });
  const [uploading, setUploading] = useState(false);
  useEffect(() => { if (open) { setD(editing ? fromDto(editing) : empty); setErrors({}); } }, [open, editing]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const submit = () => {
    const body = { ...d, value: d.value ?? 0, cracDocumentId: d.cracDocumentId || null };
    const r = pastContractCreateSchema.safeParse(body);
    if (!r.success) {
      const e: Record<string, string> = {};
      r.error.issues.forEach((i) => { const k = i.path.join('.'); if (!e[k]) e[k] = i.message; });
      setErrors(e);
      return;
    }
    save.mutate({ ...body, id: editing?.id }, {
      onSuccess: () => { toast.success(editing ? 'Contract updated' : 'Contract added', { description: 'Experience criteria will use it on the next analysis.' }); onOpenChange(false); },
      onError: (err) => { const f = serverFieldErrors(err); setErrors(f); if (!Object.keys(f).length) toast.error(errorMessage(err)); },
    });
  };

  const docOptions = [
    { value: '__none', label: 'Not linked' },
    ...(docs.data?.items ?? []).map((x) => ({ value: x.id, label: x.title })),
    { value: '__upload', label: 'Upload a new CRAC…' },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit past contract' : 'Add a past contract'}</DialogTitle>
          <DialogDescription>Bids typically ask for 1–3 similar orders worth 40–80% of the estimated value in the last 3–7 years.</DialogDescription>
        </DialogHeader>
        <form id="pc-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          <Field label="Buyer / organisation" required error={errors.buyer} className="sm:col-span-2">
            <Input value={d.buyer} onChange={(e) => set('buyer', e.target.value)} placeholder="e.g. National Informatics Centre, MeitY" autoFocus />
          </Field>
          <Field label="Work / supply" required error={errors.title} className="sm:col-span-2">
            <Input value={d.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Supply & installation of 200 desktop computers" />
          </Field>
          <Field label="Buyer type" error={errors.buyerType}>
            <Select value={d.buyerType} onValueChange={(v) => set('buyerType', v as Draft['buyerType'])} options={BUYER_TYPES.map((b) => ({ value: b, label: BUYER_TYPE_LABELS[b] }))} />
          </Field>
          <Field label="Contract value" required error={errors.value}>
            <RupeeInput value={d.value} onChange={(v) => set('value', v)} />
          </Field>
          <Field label="Start date" error={errors.startDate}><Input type="date" value={d.startDate} onChange={(e) => set('startDate', e.target.value)} /></Field>
          <Field label="Completion date" error={errors.endDate}><Input type="date" value={d.endDate} min={d.startDate || undefined} onChange={(e) => set('endDate', e.target.value)} /></Field>
          <Field label="Category" error={errors.category}><Input value={d.category} onChange={(e) => set('category', e.target.value)} placeholder="e.g. Desktop computers" /></Field>
          <Field label="GeM contract no." error={errors.gemContractNo}><Input value={d.gemContractNo} onChange={(e) => set('gemContractNo', e.target.value)} placeholder="GEMC-5116877…" className="font-mono text-[13px]" /></Field>
          <Field label="CRAC / completion certificate" error={errors.cracDocumentId} hint="Link the proof from your vault (Experience documents)." className="sm:col-span-2">
            <Select
              value={d.cracDocumentId || '__none'} options={docOptions}
              onValueChange={(v) => (v === '__upload' ? setUploading(true) : set('cracDocumentId', v === '__none' ? '' : v))}
            />
          </Field>
        </form>
        {/* FR-062: rendered inside the contract dialog so it stacks on top and the draft is kept. */}
        <UploadDialog open={uploading} onOpenChange={setUploading} presetType="crac" onUploaded={(id) => set('cracDocumentId', id)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="pc-form" loading={save.isPending}>{editing ? 'Save contract' : 'Add contract'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PastContracts() {
  const { can } = useAuth();
  const canWrite = can('analyst');
  const list = usePastContracts();
  const del = useDeletePastContract();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PastContractDto | null>(null);
  const [deleting, setDeleting] = useState<PastContractDto | null>(null);
  const items = list.data?.items ?? [];
  const total = items.reduce((s, c) => s + c.value, 0);
  const largest = items.reduce((m, c) => Math.max(m, c.value), 0);

  const columns: Column<PastContractDto>[] = [
    { key: 'title', header: 'Contract', primary: true, cell: (c) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{c.title}</div>
        <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">{c.buyer}<Badge size="sm" tone="outline">{BUYER_TYPE_LABELS[c.buyerType]}</Badge></div>
      </div>
    ) },
    { key: 'value', header: 'Value', cell: (c) => <span className="tabular font-medium">{formatINR(c.value)}</span> },
    { key: 'period', header: 'Period', hideOnMobile: true, cell: (c) => <span className="text-[13px] text-muted-foreground">{c.startDate || c.endDate ? `${formatDateIST(c.startDate, { fallback: '…' })} – ${formatDateIST(c.endDate, { fallback: 'ongoing' })}` : '—'}</span> },
    { key: 'crac', header: 'Proof', hideOnMobile: true, cell: (c) => c.cracDocumentId ? <Badge tone="success" size="sm"><Link2 />Linked</Badge> : <Badge tone="warning" size="sm">No CRAC</Badge> },
    ...(canWrite ? [{ key: 'actions', header: <span className="sr-only">Actions</span>, className: 'w-10', cell: (c: PastContractDto) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.title}`} onClick={(e) => e.stopPropagation()}><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => { setEditing(c); setOpen(true); }}><Pencil />Edit</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDeleting(c)} className="text-danger focus:text-danger"><Trash2 />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) }] : []),
  ];

  return (
    <div className="grid gap-3">
      {list.isLoading ? <SkeletonList rows={3} /> : list.isError ? <ErrorState compact error={list.error} onRetry={() => list.refetch()} /> : items.length === 0 ? (
        <EmptyState compact icon={Briefcase} title="No past contracts yet"
          body="Add completed orders with their values — they’re matched against each bid’s experience criteria."
          action={canWrite ? <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus />Add contract</Button> : undefined} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] text-muted-foreground">
              <strong className="text-foreground">{items.length}</strong> contract{items.length === 1 ? '' : 's'} · total <strong className="text-foreground tabular">{formatINRCompact(total)}</strong> · largest <strong className="text-foreground tabular">{formatINRCompact(largest)}</strong>
            </p>
            {canWrite && <Button type="button" size="sm" variant="outline" onClick={() => { setEditing(null); setOpen(true); }}><Plus />Add contract</Button>}
          </div>
          <ResponsiveTable columns={columns} rows={items} rowKey={(c) => c.id} onRowClick={canWrite ? (c) => { setEditing(c); setOpen(true); } : undefined} />
        </>
      )}
      <ContractDialog open={open} onOpenChange={setOpen} editing={editing} />
      <ConfirmDialog
        open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} loading={del.isPending} confirmLabel="Delete contract"
        title="Delete this contract?" description={deleting ? `“${deleting.title}” for ${deleting.buyer} will no longer count towards experience criteria.` : undefined}
        onConfirm={() => deleting && del.mutate(deleting.id, { onSuccess: () => { toast.success('Contract deleted'); setDeleting(null); }, onError: (e) => toast.error(errorMessage(e)) })}
      />
    </div>
  );
}
