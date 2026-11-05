import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  AlertTriangle, ArrowDown, ArrowRight, ArrowUp, BookOpen, Download, ExternalLink, FileSignature, FileStack, FileText, GripVertical, Loader2, Plus,
  RotateCcw, X,
} from 'lucide-react';
import type { PacketDto, PacketItemInput, WorkspaceDetail } from '@tp/core/contracts/apply';
import { Badge, Button, Card, EmptyState, Progress, Tooltip, toast } from '@/components/ui';
import { useCan } from '@/lib/auth';
import { packetReorderAnnouncements } from './a11y';
import { errorMessage } from '@/lib/api';
import { formatDateIST, pluralize, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/components/ui/dropzone';
import { useBuildPacket } from './api';

const LIMIT = 20 * 1024 * 1024;

interface Row extends PacketItemInput { uid: string; sizeBytes: number; group: string }

const uidOf = (i: PacketItemInput) => `${i.kind}:${i.refId ?? ''}`;

function allRows(data: WorkspaceDetail): { rows: Row[]; proposed: string[]; computed: string[] } {
  const vault = new Map(data.vaultDocs.map((d) => [d.id, d]));
  const make = (i: PacketItemInput): Row => {
    const d = i.kind === 'vault' && i.refId ? vault.get(i.refId) : undefined;
    const td = i.kind === 'tender_doc' ? data.tenderDocs.find((x) => x.id === i.refId) : undefined;
    return {
      ...i, uid: uidOf(i),
      pages: i.kind === 'cover' ? 2 : d?.pageCount ?? td?.pageCount ?? i.pages ?? 1,
      sizeBytes: d?.sizeBytes ?? td?.sizeBytes ?? (i.kind === 'cover' ? 15_000 : 25_000),
      group: i.kind === 'cover' ? 'Cover' : i.kind === 'annexure' ? 'Annexure' : i.kind === 'tender_doc' ? 'Bid document' : 'Vault',
    };
  };
  const out = new Map<string, Row>();
  // Proposed order (006/FR-055): the last successful build's order, shared by the whole team.
  for (const i of data.defaultPacketItems) out.set(uidOf(i), make(i));
  const proposed = [...out.keys()];
  // Computed default (006/FR-045): what "Default order" resets to.
  const computedItems = data.computedPacketItems ?? data.defaultPacketItems;
  for (const i of computedItems) if (!out.has(uidOf(i))) out.set(uidOf(i), make(i));
  const computed = computedItems.map(uidOf);
  for (const a of data.annexures) if (a.key !== 'oem_auth_request') { const r = make({ kind: 'annexure', refId: a.key, title: a.title, pages: 1 }); if (!out.has(r.uid)) out.set(r.uid, r); }
  for (const d of data.vaultDocs) { const r = make({ kind: 'vault', refId: d.id, title: d.title }); if (!out.has(r.uid)) out.set(r.uid, r); }
  for (const d of data.tenderDocs) { const r = make({ kind: 'tender_doc', refId: d.id, title: d.fileName }); if (!out.has(r.uid)) out.set(r.uid, r); }
  return { rows: [...out.values()], proposed, computed };
}

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

interface PacketDraft { basePacketId: string | null; order: string[] }

/**
 * Per-browser packet order kept only as an unsaved draft (006/FR-055), stored under `tp:packet-order:<workspaceId>` as
 * `{ basePacketId, order }` where `basePacketId` is the latest ready build the draft was made on. `null` means "use the
 * server's proposed order". A draft made on an older build (a newer ready build now exists — ours or a teammate's) is
 * dropped; this also clears the draft after our own successful build, once the refreshed workspace arrives, so the
 * list never flashes back to the previous order in between.
 */
function usePacketDraft(workspaceId: string, basePacketId: string | null) {
  const key = `tp:packet-order:${workspaceId}`;
  const read = (): PacketDraft | null => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? 'null') as PacketDraft | null;
      return v && Array.isArray(v.order) ? { basePacketId: v.basePacketId ?? null, order: v.order.map(String) } : null;
    } catch { return null; }
  };
  const [draft, setDraftState] = useState<PacketDraft | null>(read);
  useEffect(() => { setDraftState(read()); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const write = useCallback((v: PacketDraft | null) => {
    setDraftState(v);
    try { if (v) localStorage.setItem(key, JSON.stringify(v)); else localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }, [key]);
  const stale = !!draft && draft.basePacketId !== basePacketId;
  useEffect(() => { if (stale) write(null); }, [stale, write]);
  const setDraft = useCallback((order: string[] | null) => write(order ? { basePacketId, order } : null), [write, basePacketId]);
  return [stale ? null : draft?.order ?? null, setDraft] as const;
}

const KIND_ICON = { cover: BookOpen, annexure: FileSignature, vault: FileText, tender_doc: FileStack } as const;

export function PacketStep({ data, onNext }: { data: WorkspaceDetail; onNext: () => void }) {
  const canWrite = useCan('analyst');
  const { rows, proposed, computed } = useMemo(() => allRows(data), [data]);
  const byUid = useMemo(() => new Map(rows.map((r) => [r.uid, r])), [rows]);
  const latestReadyId = data.packets.find((p) => p.status === 'ready')?.id ?? null;
  const [order, setOrder] = usePacketDraft(data.workspace.id, latestReadyId);
  const shared = proposed.filter((u) => byUid.has(u));
  const included = (order ?? shared).filter((u) => byUid.has(u));
  const isComputed = sameOrder(included, computed);
  const isDraft = !!order && !sameOrder(included, shared);
  const fromLastBuild = !order && !sameOrder(shared, computed);
  const resetOrder = () => setOrder(sameOrder(shared, computed) ? null : computed);
  const available = rows.filter((r) => !included.includes(r.uid));
  const build = useBuildPacket(data.workspace.id);
  const [phase, setPhase] = useState(0);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = included.indexOf(String(e.active.id)), to = included.indexOf(String(e.over.id));
    setOrder(arrayMove(included, from, to));
  };
  const announcements = useMemo(() => packetReorderAnnouncements(included, (id) => byUid.get(id)?.title ?? 'document'), [included, byUid]);
  const move = (uid: string, dir: -1 | 1) => {
    const i = included.indexOf(uid), j = i + dir;
    if (j < 0 || j >= included.length) return;
    setOrder(arrayMove(included, i, j));
  };

  const items = included.map((u) => byUid.get(u)!);
  const pages = items.reduce((n, r) => n + (r.pages ?? 1), 0);
  const size = items.reduce((n, r) => n + r.sizeBytes, 0);
  const latest = data.packets[0] ?? null;

  useEffect(() => {
    if (!build.isPending) { setPhase(0); return; }
    const t = window.setInterval(() => setPhase((p) => Math.min(p + 1, 3)), 900);
    return () => window.clearInterval(t);
  }, [build.isPending]);

  const doBuild = () => build.mutate(items.map(({ kind, refId, title, pages: p }) => ({ kind, refId, title, pages: p })), {
    onSuccess: (p) => {
      // The draft is dropped by usePacketDraft once the refreshed workspace shows this build as the latest ready one.
      toast.success(`Packet ready — ${p.pageCount} pages`, { description: p.warnings.length ? `${pluralize(p.warnings.length, 'warning')} to review` : 'Download it and check every page before uploading on GeM.' });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
      <div className="grid grid-cols-1 content-start gap-4">
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">Packet contents</h3>
              <p className="text-xs text-muted-foreground">Drag to reorder (or use the arrows). The index page lists every document with its page number.</p>
              {isDraft && canWrite && <p className="mt-1 text-2xs text-muted-foreground">Unsaved order on this device — build the packet to share it with your team.</p>}
              {fromLastBuild && <p className="mt-1 text-2xs text-muted-foreground">Order from the last successful build.</p>}
            </div>
            {canWrite && !isComputed && <Button size="xs" variant="ghost" onClick={resetOrder}><RotateCcw /> Default order</Button>}
          </div>
          {items.length ? (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements, screenReaderInstructions: { draggable: 'To pick up a document, press space or enter. Use the up and down arrow keys to move it, space or enter to drop it, escape to cancel.' } }}>
              <SortableContext items={included} strategy={verticalListSortingStrategy}>
                <ol className="divide-y" aria-label="Documents in the packet, in order">
                  {items.map((r, i) => (
                    <SortableRow key={r.uid} row={r} index={i} count={items.length} disabled={!canWrite}
                      onRemove={() => setOrder(included.filter((u) => u !== r.uid))} onMove={(d) => move(r.uid, d)} />
                  ))}
                </ol>
              </SortableContext>
            </DndContext>
          ) : <div className="p-4"><EmptyState compact icon={FileStack} title="Nothing in the packet" body="Add documents from the list below." /></div>}
        </Card>

        {available.length > 0 && canWrite && (
          <Card>
            <div className="border-b px-4 py-3">
              <h3 className="text-sm font-semibold">Add more</h3>
              <p className="text-xs text-muted-foreground">Other annexures, vault documents and bid documents.</p>
            </div>
            <ul className="max-h-72 divide-y overflow-y-auto">
              {available.map((r) => {
                const Icon = KIND_ICON[r.kind];
                return (
                  <li key={r.uid} className="flex items-center gap-3 px-4 py-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{r.title}</span>
                    <Badge tone="neutral" size="sm">{r.group}</Badge>
                    <Button size="icon-xs" variant="outline" aria-label={`Add ${r.title}`} onClick={() => setOrder([...included, r.uid])}><Plus /></Button>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>

      <div className="grid grid-cols-1 content-start gap-4">
        <Card className="p-4">
          <div className="grid grid-cols-2 gap-3">
            <div><div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Documents</div><div className="tabular text-xl font-semibold">{items.length}</div></div>
            <div><div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Pages (est.)</div><div className="tabular text-xl font-semibold">{pages}</div></div>
          </div>
          <div className="mt-4">
            <div className="mb-1.5 flex justify-between text-xs"><span className="text-muted-foreground">Estimated size</span><span className={cn('tabular font-medium', size > LIMIT && 'text-danger')}>{formatBytes(size)} / 20 MB</span></div>
            <Progress value={(size / LIMIT) * 100} tone={size > LIMIT ? 'danger' : size > LIMIT * 0.75 ? 'warning' : 'success'} size="sm"
              aria-label="Estimated packet size" aria-valuetext={`${(size / (1024 * 1024)).toFixed(1)} MB of 20 MB`} />
            {size > LIMIT && <p className="mt-2 text-xs text-danger">Above GeM’s typical per-file limit — remove large scans or compress them in the vault.</p>}
          </div>
          {canWrite && (
            <Button block size="lg" className="mt-4" onClick={doBuild} loading={build.isPending} disabled={!items.length}>
              {!build.isPending && <FileStack />} {latest ? 'Rebuild packet' : 'Build packet'}
            </Button>
          )}
          {build.isPending && (
            <div className="mt-3 space-y-2" role="status" aria-live="polite">
              <Progress value={20 + phase * 25} size="sm" aria-label="Packet build progress" />
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" aria-hidden />{['Rendering annexures…', 'Merging documents…', 'Writing index & bookmarks…', 'Saving the packet…'][phase]}</p>
            </div>
          )}
        </Card>

        {latest ? <LatestPacket p={latest} onNext={onNext} /> : (
          <Card className="p-4 text-[13px] text-muted-foreground">
            The packet is one PDF: a cover page, an index with page numbers, then each document in your order — with bookmarks, ready for the GeM technical upload.
          </Card>
        )}

        {data.packets.length > 1 && (
          <Card>
            <div className="border-b px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Earlier builds</div>
            <ul className="divide-y">
              {data.packets.slice(1, 6).map((p) => (
                <li key={p.id} className="flex items-center gap-2 px-4 py-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{formatDateIST(p.createdAt, { time: true })}<span className="text-muted-foreground"> · {p.pageCount ?? '—'} pages</span></span>
                  {p.downloadUrl && <Button asChild size="icon-xs" variant="ghost"><a href={p.downloadUrl} aria-label="Download this build"><Download /></a></Button>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function LatestPacket({ p, onNext }: { p: PacketDto; onNext: () => void }) {
  return (
    <Card className={cn('overflow-hidden', p.status === 'ready' ? 'border-success/30' : 'border-danger/30')}>
      <div className={cn('px-4 py-3', p.status === 'ready' ? 'bg-success-soft/60' : 'bg-danger-soft/60')}>
        <div className="text-sm font-semibold">{p.status === 'ready' ? 'Latest packet is ready' : 'The last build failed'}</div>
        <div className="text-xs text-muted-foreground">{p.createdBy?.name ?? 'Someone'} · {relativeTime(p.createdAt)} · {p.pageCount ?? '—'} pages · {p.sizeBytes ? formatBytes(p.sizeBytes) : '—'}</div>
      </div>
      {p.warnings.length > 0 && (
        <ul className="space-y-1.5 border-t px-4 py-3">
          {p.warnings.map((w, i) => (
            <li key={i} className="flex gap-2 text-xs"><AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden /><span>{w}</span></li>
          ))}
        </ul>
      )}
      {p.downloadUrl && (
        <div className="flex flex-wrap gap-2 border-t px-4 py-3">
          <Button asChild size="sm"><a href={p.downloadUrl}><Download /> Download PDF</a></Button>
          <Button asChild size="sm" variant="ghost"><a href={`${p.downloadUrl}?inline=1`} target="_blank" rel="noreferrer"><ExternalLink /> Open</a></Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onNext}>Submit step <ArrowRight /></Button>
        </div>
      )}
    </Card>
  );
}

function SortableRow({ row, index, count, disabled, onRemove, onMove }: {
  row: Row; index: number; count: number; disabled: boolean; onRemove: () => void; onMove: (d: -1 | 1) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.uid, disabled });
  const Icon = KIND_ICON[row.kind];
  const style = { transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined, transition };
  return (
    <li ref={setNodeRef} style={style} className={cn('flex items-center gap-2 bg-card px-2 py-2 sm:px-3', isDragging && 'relative z-10 rounded-lg shadow-lg ring-1 ring-primary/30')}>
      {!disabled && (
        <button type="button" {...attributes} {...listeners} className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted active:cursor-grabbing focus-ring" aria-label={`Reorder ${row.title}`}>
          <GripVertical className="size-4" aria-hidden />
        </button>
      )}
      <span className="tabular w-5 shrink-0 text-center text-xs text-muted-foreground">{index + 1}</span>
      <Icon className={cn('size-4 shrink-0', row.kind === 'annexure' ? 'text-primary' : row.kind === 'cover' ? 'text-accent' : 'text-muted-foreground')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{row.title}</div>
        <div className="text-2xs text-muted-foreground">{row.group} · {pluralize(row.pages ?? 1, 'page')}{row.kind === 'vault' ? ` · ${formatBytes(row.sizeBytes)}` : ''}</div>
      </div>
      {!disabled && (
        <div className="flex shrink-0 items-center">
          <Tooltip content="Move up"><Button size="icon-xs" variant="ghost" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move ${row.title} up`}><ArrowUp /></Button></Tooltip>
          <Tooltip content="Move down"><Button size="icon-xs" variant="ghost" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move ${row.title} down`}><ArrowDown /></Button></Tooltip>
          <Tooltip content="Remove from packet"><Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label={`Remove ${row.title}`}><X /></Button></Tooltip>
        </div>
      )}
    </li>
  );
}
