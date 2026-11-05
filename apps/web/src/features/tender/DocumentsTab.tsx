import { useState } from 'react';
import { CloudDownload, Download, Eye, FileText, Globe, Loader2, MoreHorizontal, ScanText, Sparkles, Trash2, TriangleAlert, Upload } from 'lucide-react';
import type { TenderDocKind, TenderDocumentDto } from '@tp/core/contracts/analyse';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, EmptyState, ErrorState, FileDropzone, Select, SkeletonList, Tooltip, formatBytes, toast,
} from '@/components/ui';
import { apiUrl, errorMessage } from '@/lib/api';
import { RoleGate, useCan } from '@/lib/auth';
import { formatDateIST, relativeTime } from '@/lib/format';
import { useAnalysisCapabilities, useFetchFromGem, useOcrDocument, useRemoveDocument, useTender, useTenderDocuments, useUploadDocument } from './api';
import { DOC_KIND_LABEL, isOcrDocument, ocrActionState, type OcrActionState, unreadableDocumentNotice, unreadableDocuments } from './labels';

const KIND_OPTIONS = (Object.keys(DOC_KIND_LABEL) as TenderDocKind[]).map((k) => ({ value: k, label: DOC_KIND_LABEL[k] }));

export function DocumentsTab({ tenderId, hasGemLink, hasAnalysis, onReanalyse }: { tenderId: string; hasGemLink: boolean; hasAnalysis: boolean; onReanalyse: () => void }) {
  const docs = useTenderDocuments(tenderId);
  const upload = useUploadDocument(tenderId);
  const fetchGem = useFetchFromGem(tenderId);
  const remove = useRemoveDocument(tenderId);
  const bidNumber = useTender(tenderId).data?.bidNumber ?? '';
  const canRemove = useCan('analyst');
  const ocr = useOcrDocument(tenderId);
  const ocrAvailable = !!useAnalysisCapabilities().data?.ocr;
  const [kind, setKind] = useState<TenderDocKind>('bid');
  const [removing, setRemoving] = useState<TenderDocumentDto | null>(null);

  const onFiles = (files: File[]) => {
    const file = files[0];
    if (!file) return;
    upload.mutate({ file, kind }, {
      onSuccess: (d) => {
        const pagesRead = `${d.pageCount ?? 0} pages read${d.hasText ? '' : ' — no text found; it may be a scan'}`;
        const action = hasAnalysis ? { label: 'Re-analyse', onClick: onReanalyse } : undefined;
        toast.success(`${d.fileName} uploaded`, { description: pagesRead, action });
        // FR-010: the document is stored either way; warn separately that it may belong to another bid.
        const mismatch = d.warnings?.find((w) => w.code === 'bid_number_mismatch');
        const truncated = d.warnings?.find((w) => w.code === 'pages_truncated');
        if (truncated) toast.warning(`Only the first ${truncated.analysed} of ${truncated.total} pages were read`, { description: 'Long documents are capped so they can be processed. Upload the key sections (eligibility, ATC) as a separate PDF if they are later in the file.' });
        if (mismatch) toast.warning(`This PDF looks like ${mismatch.found}, not ${bidNumber || 'this bid'}`, { description: 'Check that you uploaded the right document.' });
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  const onRemove = () => removing && remove.mutate(removing.id, {
    onSuccess: () => { toast.success(`${removing.fileName} removed`); setRemoving(null); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const onOcr = (d: TenderDocumentDto) => ocr.mutate(d.id, {
    onSuccess: () => toast.success(`${d.fileName} read with AI`, {
      description: 'Text via OCR. Requirements from it are marked — check them against the original.',
      action: hasAnalysis ? { label: 'Re-analyse', onClick: onReanalyse } : undefined,
    }),
    onError: (e) => toast.error(errorMessage(e, 'AI OCR failed')),
  });

  const onFetch = () => fetchGem.mutate(undefined, {
    onSuccess: (r) => toast.success(r.fetched ? 'Bid document downloaded from GeM' : 'The GeM bid document is already here'),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const items = docs.data?.items ?? [];
  const unreadable = unreadableDocuments(items);
  const offerOcr = ocrAvailable && canRemove;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Tender documents</CardTitle>
            <CardDescription>Bid document, ATC, corrigenda and BOQ used for the analysis.</CardDescription>
          </div>
          {hasGemLink && (
            <RoleGate min="analyst">
              <Button size="sm" variant="secondary" onClick={onFetch} loading={fetchGem.isPending}>{!fetchGem.isPending && <CloudDownload />} Fetch from GeM</Button>
            </RoleGate>
          )}
        </CardHeader>
        <CardContent>
          {docs.isLoading ? <SkeletonList rows={2} /> : docs.isError ? <ErrorState compact error={docs.error} onRetry={() => docs.refetch()} /> : items.length === 0 ? (
            <EmptyState compact icon={FileText} title="No documents yet" body={hasGemLink ? 'Fetch the bid document from GeM, or upload the PDF you downloaded.' : 'Upload the bid PDF you downloaded from GeM.'} />
          ) : (
            <>
            {unreadable.length > 0 && (
              <ul role="status" aria-label="Documents without readable text" data-testid="unreadable-notice" className="mb-3 grid gap-1.5 rounded-lg border border-warning/30 bg-warning-soft/60 px-3 py-2 text-sm">
                {unreadable.map((d) => (
                  <li key={d.id} className="flex items-start gap-2 break-words">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[hsl(32_90%_36%)] dark:text-warning" aria-hidden />
                    <span>{unreadableDocumentNotice(d.fileName, offerOcr)}</span>
                  </li>
                ))}
              </ul>
            )}
            <ul className="grid gap-2">
              {items.map((d) => (
                <DocRow key={d.id} doc={d} tenderId={tenderId} bidNumber={bidNumber} ocrState={ocrActionState(d, { ocrAvailable, canRun: canRemove, running: ocr.isPending && ocr.variables === d.id })} ocrBusy={ocr.isPending} onOcr={() => onOcr(d)} onRemove={canRemove && d.source === 'upload' ? () => setRemoving(d) : undefined} />
              ))}
            </ul>
            </>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} loading={remove.isPending} confirmLabel="Remove"
        title={removing ? `Remove ${removing.fileName}?` : 'Remove document?'} description="The next analysis will no longer use it."
        onConfirm={onRemove}
      />

      <RoleGate min="analyst" fallback={<Card><CardContent className="p-5 text-sm text-muted-foreground">Viewers can read documents. Ask an analyst to upload new ones.</CardContent></Card>}>
        <Card className="content-start">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Upload className="size-4 text-primary" aria-hidden /> Upload a document</CardTitle>
            <CardDescription>Corrigendum or ATC published separately? Add it and re-analyse — later documents supersede earlier values.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-1.5">
              <span className="text-[13px] font-medium" id="doc-kind-label">Document type</span>
              <Select options={KIND_OPTIONS} value={kind} onValueChange={(v) => setKind(v as TenderDocKind)} aria-label="Document type" />
            </div>
            <FileDropzone
              accept=".pdf,application/pdf" onFiles={onFiles} disabled={upload.isPending}
              title={upload.isPending ? 'Uploading and reading…' : undefined} hint="PDF up to 25 MB"
              onReject={(m) => toast.error(m)}
            />
          </CardContent>
        </Card>
      </RoleGate>
    </div>
  );
}

function DocRow({ doc, tenderId, bidNumber, onRemove, ocrState, ocrBusy, onOcr }: {
  doc: TenderDocumentDto; tenderId: string; bidNumber: string; onRemove?: () => void; ocrState: OcrActionState; ocrBusy: boolean; onOcr: () => void;
}) {
  const base = `/tenders/${tenderId}/documents/${doc.id}/download`;
  return (
    <li className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-danger"><FileText className="size-5" aria-hidden /></span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" title={doc.fileName}>{doc.fileName}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge size="sm" tone={doc.kind === 'corrigendum' ? 'warning' : 'neutral'}>{DOC_KIND_LABEL[doc.kind]}</Badge>
            {doc.source === 'gem' ? <span className="inline-flex items-center gap-1"><Globe className="size-3" aria-hidden /> From GeM</span> : <span>Uploaded</span>}
            <span>· {doc.pageCount ?? '?'} pages · {formatBytes(doc.sizeBytes)}</span>
            {doc.pageCount != null && doc.totalPages != null && doc.totalPages > doc.pageCount && (
              <Badge size="sm" tone="warning" data-testid="pages-truncated">Only the first {doc.pageCount} of {doc.totalPages} pages were read</Badge>
            )}
            <Tooltip content={formatDateIST(doc.createdAt, { time: true })}><span>· {relativeTime(doc.createdAt)}</span></Tooltip>
            {isOcrDocument(doc) && <Badge size="sm" tone="info" data-testid="ocr-badge"><Sparkles aria-hidden /> Text via OCR</Badge>}
            {!doc.hasText && <Badge size="sm" tone="warning">No text — scanned?</Badge>}
            {doc.bidNumberFound && (
              <Tooltip content={`Page 1 shows ${doc.bidNumberFound}${bidNumber ? `, but this tender is ${bidNumber}` : ''}. Check that this is the right PDF.`}>
                <span tabIndex={0} className="rounded focus-ring"><Badge size="sm" tone="warning">Different bid?</Badge></span>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {ocrState !== 'hidden' && (
          <Button size="sm" variant="secondary" onClick={onOcr} disabled={ocrBusy} aria-label={ocrState === 'running' ? `Reading ${doc.fileName} with AI` : `Read ${doc.fileName} with AI (OCR)`}>
            {ocrState === 'running' ? <Loader2 className="animate-spin" aria-hidden /> : <ScanText aria-hidden />} {ocrState === 'running' ? 'Reading…' : 'Read with AI (OCR)'}
          </Button>
        )}
        {ocrState === 'running' && <span role="status" className="sr-only">Reading {doc.fileName} with AI. This can take a minute.</span>}
        <Button asChild size="sm" variant="secondary"><a href={apiUrl(base, { inline: 1 })} target="_blank" rel="noreferrer"><Eye /> View</a></Button>
        <Button asChild size="sm" variant="ghost"><a href={apiUrl(base)} download={doc.fileName} aria-label={`Download ${doc.fileName}`}><Download /> <span className="sm:sr-only">Download</span></a></Button>
        {onRemove && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`More actions for ${doc.fileName}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem destructive onSelect={onRemove}><Trash2 />Remove</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  );
}
