/**
 * Document vault (US3, FR-021/022): every certificate a GeM bid asks for, with expiry tracking.
 * Header stats → expiry timeline → filters → grid/list. Upload via button, `?upload=1`, or by
 * dropping a file anywhere on the page. `?doc=<id>` opens the preview drawer (reminder links),
 * `?status=expiring` pre-filters (dashboard links).
 */
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowUpDown, CheckCircle2, Clock, FileUp, FolderLock, LayoutGrid, List, Plus, Search, ShieldCheck, X,
} from 'lucide-react';
import type { VaultDocumentDto } from '@tp/core/contracts/vault';
import { DOC_CATEGORIES, DOC_TYPES, docTypeInfo, type DocCategory, type DocStatus, type DocType } from '@tp/core/vault/status';
import {
  Badge, Button, Card, EmptyState, ErrorState, Input, PageHeader, ResponsiveTable, Segmented, Select, Skeleton, StatTile, toast, type Column,
} from '@/components/ui';
import { RoleGate, useAuth } from '@/lib/auth';
import { formatDateIST, relativeTime } from '@/lib/format';
import { useLocalStorage } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { DOC_NOT_FOUND_MESSAGE, isStaleDocLink, useVault, useVaultDoc, useVaultSummary, type VaultFilters } from './api';
import { DocTypeIcon, ExpiryBadge, STATUS_LABEL } from './doc-ui';
import { DocumentDrawer } from './DocumentDrawer';
import { checkVaultFile } from './file-check';
import { ExpiryTimeline } from './ExpiryTimeline';
import { UploadDialog } from './UploadDialog';

type Sort = NonNullable<VaultFilters['sort']>;
const SORTS: { value: Sort; label: string }[] = [
  { value: 'recent', label: 'Recently added' }, { value: 'expiry', label: 'Expiring first' }, { value: 'title', label: 'Title A–Z' }, { value: 'type', label: 'Type' },
];

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function DocCard({ doc, onOpen }: { doc: VaultDocumentDto; onOpen: () => void }) {
  const info = docTypeInfo(doc.type);
  return (
    <Card interactive className="group relative flex flex-col p-4">
      <button type="button" onClick={onOpen} className="absolute inset-0 z-[1] rounded-xl focus-ring" aria-label={`Open ${doc.title}`} />
      <div className="flex items-start gap-3">
        <DocTypeIcon type={doc.type} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold tracking-tight" title={doc.title}>{doc.title}</h3>
          <p className="truncate text-xs text-muted-foreground">{info.label}</p>
        </div>
      </div>
      <div className="mt-3 min-h-[20px] truncate font-mono text-xs text-muted-foreground">{doc.number ?? <span className="font-sans italic opacity-70">No number</span>}</div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <ExpiryBadge status={doc.status} days={doc.daysToExpiry} />
        {doc.financialYear && <Badge size="sm" tone="outline">FY {doc.financialYear}</Badge>}
        {doc.tags.slice(0, 2).map((t) => <Badge key={t} size="sm" className="max-w-[7rem]"><span className="truncate">{t}</span></Badge>)}
      </div>
      <div className="mt-auto pt-4"><div className="flex items-center justify-between gap-2 border-t pt-3 text-2xs text-muted-foreground">
        <span>{doc.expiryDate ? `Expires ${formatDateIST(doc.expiryDate)}` : `Added ${relativeTime(doc.createdAt)}`}</span>
        <span className="uppercase">{doc.mimeType === 'application/pdf' ? `PDF${doc.pageCount ? ` · ${doc.pageCount}p` : ''}` : doc.mimeType.split('/')[1]}</span>
      </div></div>
    </Card>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <Card key={i} className="p-4">
          <div className="flex gap-3"><Skeleton className="size-10 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/2" /></div></div>
          <Skeleton className="mt-4 h-3 w-2/5" />
          <div className="mt-3 flex gap-2"><Skeleton className="h-5 w-20 rounded-full" /><Skeleton className="h-5 w-14 rounded-full" /></div>
          <Skeleton className="mt-4 h-3 w-full" />
        </Card>
      ))}
    </div>
  );
}

/** First-run: guide the user through what GeM bids usually need. */
function Onboarding({ onUpload }: { onUpload: (t: DocType) => void }) {
  const { can } = useAuth();
  const common = DOC_TYPES.filter((d) => d.commonInBids);
  return (
    <Card className="overflow-hidden">
      <div className="relative border-b bg-gradient-to-br from-primary-soft via-card to-accent-soft/40 px-5 py-8 sm:px-8">
        <div className="flex max-w-2xl flex-col gap-3">
          <span className="flex size-12 items-center justify-center rounded-xl border bg-card shadow-sm"><FolderLock className="size-5 text-primary" /></span>
          <h2 className="text-lg font-semibold tracking-tight">Build your bid-ready vault once, reuse it on every tender</h2>
          <p className="text-sm text-muted-foreground">
            Upload each certificate one time. TenderPilot tracks expiry dates, reminds your team 30, 7 and 1 day before anything lapses, and auto-attaches the right file when you prepare a bid packet.
          </p>
        </div>
      </div>
      <div className="px-5 py-5 sm:px-8">
        <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Documents most GeM bids ask for</h3>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {common.map((d) => (
            <li key={d.type}>
              <button
                type="button" disabled={!can('analyst')} onClick={() => onUpload(d.type)}
                className="group flex w-full items-start gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary-soft/30 focus-ring disabled:pointer-events-none"
              >
                <DocTypeIcon type={d.type} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{d.label}</span>
                  <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{d.description}</span>
                </span>
                {can('analyst') && <Plus className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export default function VaultPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const [view, setView] = useLocalStorage<'grid' | 'list'>('tp.vault.view', 'grid');
  const [q, setQ] = useState(params.get('q') ?? '');
  const dq = useDebounced(q);
  const status = (params.get('status') as DocStatus | null) || null;
  const category = (params.get('category') as DocCategory | null) || null;
  const type = (params.get('type') as DocType | null) || null;
  const sort = (params.get('sort') as Sort | null) || 'recent';
  const filters: VaultFilters = { status, category, type, q: dq, sort };
  const list = useVault(filters);
  const summary = useVaultSummary();

  const setParam = useCallback((k: string, v: string | null) => {
    setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  }, [setParams]);
  useEffect(() => { setParam('q', dq.trim() || null); }, [dq, setParam]);

  // Upload dialog
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [presetType, setPresetType] = useState<DocType | null>(null);
  const openUpload = (file: File | null = null, t: DocType | null = null) => { setUploadFile(file); setPresetType(t); setUploadOpen(true); };
  useEffect(() => {
    if (params.get('upload') === '1' && can('analyst')) {
      openUpload(null, (params.get('uploadType') as DocType) || null);
      setParams((p) => { const n = new URLSearchParams(p); n.delete('upload'); n.delete('uploadType'); return n; }, { replace: true });
    }
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drawer (?doc=<id>)
  const docId = params.get('doc');
  const inList = list.data?.items.find((d) => d.id === docId) ?? null;
  const single = useVaultDoc(docId && !inList ? docId : null);
  const openDoc = inList ?? single.data ?? null;
  const setDoc = (id: string | null) => setParam('doc', id);
  // FR-040: a stale `?doc=<id>` (deleted document, old reminder link) gets a visible message and is dropped from the URL.
  useEffect(() => {
    if (isStaleDocLink(docId, !!inList, single.error)) {
      toast.error(DOC_NOT_FOUND_MESSAGE, { id: 'vault-doc-not-found' });
      setParam('doc', null);
    }
  }, [docId, inList, single.error, setParam]);

  // Page-level drag & drop
  const [dragging, setDragging] = useState(false);
  const onDragOver = (e: DragEvent) => { if (can('analyst') && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (!f || !can('analyst')) return;
    const problem = checkVaultFile(f);
    if (problem) toast.error(problem); else openUpload(f);
  };

  const s = summary.data;
  const hasFilters = !!(status || category || type || dq.trim());
  const clearFilters = () => { setQ(''); setParams((p) => { const n = new URLSearchParams(p); ['status', 'category', 'type', 'q'].forEach((k) => n.delete(k)); return n; }, { replace: true }); };
  const isEmptyVault = s?.total === 0;

  const typeOptions = useMemo(() => [{ value: '__all', label: 'All types' }, ...DOC_TYPES.filter((d) => !category || d.category === category).map((d) => ({ value: d.type, label: d.label }))], [category]);

  const columns: Column<VaultDocumentDto>[] = [
    { key: 'title', header: 'Document', primary: true, cell: (d) => (
      <div className="flex min-w-0 items-center gap-3">
        <DocTypeIcon type={d.type} size="sm" />
        <div className="min-w-0">
          <div className="truncate font-medium">{d.title}</div>
          <div className="truncate text-xs text-muted-foreground">{docTypeInfo(d.type).label}</div>
        </div>
      </div>
    ) },
    { key: 'number', header: 'Number', hideOnMobile: true, cell: (d) => <span className="font-mono text-xs">{d.number ?? '—'}</span> },
    { key: 'status', header: 'Status', cell: (d) => <ExpiryBadge status={d.status} days={d.daysToExpiry} /> },
    { key: 'expiry', header: 'Expiry', cell: (d) => <span className="tabular text-[13px]">{formatDateIST(d.expiryDate, { fallback: '—' })}</span> },
    { key: 'fy', header: 'FY', hideOnMobile: true, cell: (d) => d.financialYear ?? '—' },
    { key: 'added', header: 'Added', hideOnMobile: true, cell: (d) => <span className="text-xs text-muted-foreground">{relativeTime(d.createdAt)}</span> },
  ];

  const statTile = (key: DocStatus | null, label: string, value: number | undefined, tone: 'primary' | 'success' | 'warning' | 'danger', icon: typeof ShieldCheck, hint: string) => (
    <button
      type="button" onClick={() => setParam('status', status === key ? null : key)} aria-pressed={status === key}
      className={cn('rounded-xl text-left focus-ring', status === key && key && 'ring-2 ring-primary/60')}
    >
      <StatTile label={label} value={value ?? 0} tone={tone} icon={icon} hint={hint} loading={summary.isLoading} className="h-full" />
    </button>
  );

  return (
    <div onDragOver={onDragOver} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={onDrop} className="relative">
      <PageHeader
        title="Document vault"
        description="Certificates, financials and authorisations your bids need — tracked for expiry and ready to attach."
        actions={
          <RoleGate min="analyst">
            <Button onClick={() => openUpload()}><FileUp />Upload document</Button>
          </RoleGate>
        }
      />

      {summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : isEmptyVault ? (
        <Onboarding onUpload={(t) => openUpload(null, t)} />
      ) : (
        <div className="grid grid-cols-1 gap-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {statTile(null, 'All documents', s?.total, 'primary', FolderLock, s ? `${Object.keys(s.byType).length} types` : '')}
            {statTile('valid', 'Valid', s?.valid, 'success', CheckCircle2, 'Ready to attach')}
            {statTile('expiring', 'Expiring soon', s?.expiring, 'warning', Clock, 'Within 30 days')}
            {statTile('expired', 'Expired', s?.expired, 'danger', AlertTriangle, s?.expired ? 'Renew to keep bidding' : 'All current')}
          </div>

          <ExpiryTimeline summary={s} loading={summary.isLoading} onOpen={(id) => setDoc(id)} />

          {s && s.missingCommon.length > 0 && can('analyst') && (
            <div className="flex flex-col gap-3 rounded-xl border border-dashed bg-subtle px-4 py-3 sm:flex-row sm:items-center">
              <p className="shrink-0 text-[13px] font-medium">Commonly asked for, not in your vault yet:</p>
              <div className="flex flex-wrap gap-1.5">
                {s.missingCommon.map((t) => (
                  <button key={t} type="button" onClick={() => openUpload(null, t)} className="inline-flex h-7 items-center gap-1 rounded-full border bg-card px-2.5 text-xs font-medium hover:border-primary/40 hover:text-primary focus-ring">
                    <Plus className="size-3" aria-hidden />{docTypeInfo(t).label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid min-w-0 grid-cols-1 gap-3">
            <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center">
              <Input
                value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, number, issuer, tag…" aria-label="Search documents"
                leading={<Search />} className="md:w-80"
                trailing={q ? <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="rounded p-1 hover:bg-muted"><X /></button> : undefined}
              />
              <div className="flex flex-wrap items-center gap-2 md:ml-auto">
                <Select aria-label="Document type" value={type ?? '__all'} onValueChange={(v) => setParam('type', v === '__all' ? null : v)} options={typeOptions} className="h-8 w-[11.5rem] text-[13px]" />
                <Select aria-label="Sort" value={sort} onValueChange={(v) => setParam('sort', v === 'recent' ? null : v)} options={SORTS} className="h-8 w-[10rem] text-[13px]" />
                <Segmented size="sm" aria-label="View" value={view} onChange={setView} options={[{ value: 'grid', label: <span className="sr-only">Grid</span>, icon: <LayoutGrid /> }, { value: 'list', label: <span className="sr-only">List</span>, icon: <List /> }]} />
              </div>
            </div>
            <div className="-mx-1 flex min-w-0 items-center gap-2 overflow-x-auto px-1 pb-1 scrollbar-thin">
              <Segmented
                size="sm" aria-label="Category" value={(category ?? 'all') as DocCategory | 'all'}
                onChange={(v) => { setParam('category', v === 'all' ? null : v); if (type && v !== 'all' && docTypeInfo(type).category !== v) setParam('type', null); }}
                options={[{ value: 'all', label: 'All' }, ...DOC_CATEGORIES.map((c) => ({ value: c, label: c }))] as { value: DocCategory | 'all'; label: string }[]}
                className="shrink-0"
              />
              {status && (
                <Badge tone={status === 'expired' ? 'danger' : status === 'expiring' ? 'warning' : 'success'} size="lg" className="shrink-0 gap-1.5">
                  {STATUS_LABEL[status]}
                  <button type="button" onClick={() => setParam('status', null)} aria-label={`Remove ${STATUS_LABEL[status]} filter`} className="rounded-full p-0.5 hover:bg-foreground/10 focus-ring"><X className="size-3" /></button>
                </Badge>
              )}
            </div>
            {hasFilters && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <ArrowUpDown className="size-3.5" aria-hidden />
                <span>{list.data ? `${list.data.total} of ${s?.total ?? '…'} documents` : 'Filtering…'}</span>
                <button type="button" onClick={clearFilters} className="font-medium text-primary hover:underline focus-ring rounded">Clear filters</button>
              </div>
            )}
          </div>

          {list.isError ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : list.isLoading || !list.data ? (
            <GridSkeleton />
          ) : list.data.items.length === 0 ? (
            <EmptyState
              icon={Search} title="No documents match"
              body={status === 'expired' ? 'Nothing has expired. Nice.' : 'Try a different search or clear the filters.'}
              action={<Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button>}
            />
          ) : view === 'grid' ? (
            <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 transition-opacity', list.isPlaceholderData && 'opacity-60')}>
              {list.data.items.map((d) => <DocCard key={d.id} doc={d} onOpen={() => setDoc(d.id)} />)}
            </div>
          ) : (
            <div className={cn('transition-opacity', list.isPlaceholderData && 'opacity-60')}>
              <ResponsiveTable columns={columns} rows={list.data.items} rowKey={(d) => d.id} onRowClick={(d) => setDoc(d.id)} />
            </div>
          )}
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-primary/10 backdrop-blur-[2px] animate-fade-in" aria-hidden>
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-card px-10 py-8 shadow-xl">
            <FileUp className="size-8 text-primary" />
            <p className="text-sm font-semibold">Drop to add to the vault</p>
            <p className="text-xs text-muted-foreground">PDF, PNG or JPG · up to 20 MB</p>
          </div>
        </div>
      )}

      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} initialFile={uploadFile} presetType={presetType} onUploaded={(id) => setDoc(id)} />
      <DocumentDrawer doc={openDoc} open={!!docId && !!openDoc} onOpenChange={(o) => { if (!o) setDoc(null); }} />
    </div>
  );
}

