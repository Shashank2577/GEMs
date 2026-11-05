/**
 * Pipeline (T072; US6): Kanban of bid workspaces by stage with drag-and-drop (dnd-kit; mouse, touch and keyboard),
 * filters (owner, closing window, search), column totals (count + EMD) and a table view.
 * Moves call PATCH /api/workspaces/:id {stage, position}; a 409 (e.g. "Ready" with missing documents) reverts the
 * card and explains the blockers. 007/US2 hardening: a "Move to…" menu on every card (FR-029), "Record the result"
 * after Won/Lost (FR-030), "Show dropped (N)" + drop confirmation (FR-031), debounced search synced to ?q= (FR-032).
 */
import { forwardRef, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, closestCorners, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent, type KeyboardCoordinateGetter, type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { AlertTriangle, Archive, Columns3, GripVertical, KanbanSquare, Lock, MessageSquare, Search, Table2, Trophy, XCircle } from 'lucide-react';
import { DECISION_FORBIDDEN_MESSAGE, DECISION_TOOLTIP, PIPELINE_STAGES, STAGES, canMoveToStage, isDecisionStage, type StageName, type WorkspaceCard } from '@tp/core/contracts/apply';
import {
  Avatar, Badge, Button, ConfirmDialog, Countdown, EmptyState, ErrorState, Input, PageHeader, Progress, ResponsiveTable, ScoreRing, Segmented, Select,
  Skeleton, StageBadge, Tooltip, VerdictBadge, toast, type Column,
} from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateIST, formatINR, formatINRCompact, pluralize } from '@/lib/format';
import { useLocalStorage } from '@/lib/hooks';
import { STAGE_LABEL, type Stage } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useMoveCard, usePipeline } from './api';
import { MoveToMenu } from './MoveToMenu';
import { DROP_CONFIRM_BODY, DROP_CONFIRM_TITLE, SEARCH_DEBOUNCE_MS, VIEW_ONLY_NOTE, adjacentStage, emptyKind } from './moves';
import { OutcomeDialog, type OutcomeTarget } from './OutcomeDialog';
import { matchesClosing, positionAt, type ClosingFilter } from './position';

type Board = Record<StageName, WorkspaceCard[]>;

const STAGE_HINT: Partial<Record<StageName, string>> = {
  identified: 'Worth a look', analysing: 'Checking eligibility', go: 'Decided to bid', preparing: 'Building the packet',
  ready: 'Packet complete — submit on GeM yourself', submitted: 'Awaiting result', won: 'Contract awarded', lost: 'Not awarded',
  dropped: 'Not bidding — history kept',
};
const STAGE_DOT: Partial<Record<StageName, string>> = {
  identified: 'bg-muted-foreground', analysing: 'bg-info', go: 'bg-success', preparing: 'bg-primary', ready: 'bg-accent',
  submitted: 'bg-primary', won: 'bg-success', lost: 'bg-danger', dropped: 'bg-muted-foreground',
};

// Every stage (Dropped included) so non-drag moves can target hidden columns; only `stages` are rendered.
const emptyBoard = (): Board => Object.fromEntries(STAGES.map((s) => [s, []])) as unknown as Board;
const BOARD_WITH_DROPPED: StageName[] = [...PIPELINE_STAGES, 'dropped'];

function buildBoard(items: WorkspaceCard[]): Board {
  const b = emptyBoard();
  for (const it of items) if (it.stage in b) b[it.stage].push(it);
  for (const s of STAGES) b[s].sort((a, z) => a.position - z.position || a.updatedAt.localeCompare(z.updatedAt));
  return b;
}

/** Debounced value; clearing (empty string) is applied at once so "Clear filters" is instant (FR-032). */
function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    if (!value.trim()) { setV(value); return; }
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function PipelinePage() {
  const { me, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useLocalStorage<'board' | 'table'>('tp:pipeline-view', 'board');
  const [showDropped, setShowDropped] = useLocalStorage<boolean>('tp:pipeline-dropped', false);
  const urlQ = params.get('q') ?? '';
  const [q, setQ] = useState(urlQ);
  const dq = useDebounced(q, SEARCH_DEBOUNCE_MS);
  const owner = params.get('owner') ?? 'all';
  const closing = (params.get('closing') as ClosingFilter | null) ?? 'any';
  const focusStage = params.get('stage') as StageName | null;
  const setParam = (k: string, v: string | null) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (v && v !== 'all' && v !== 'any') p.set(k, v); else p.delete(k);
      return p;
    }, { replace: true });
  };
  // Search ⇄ ?q= (FR-032): the debounced text is written to the URL (replace); a URL change from outside
  // (back/forward, shared link) is copied into the box.
  useEffect(() => { if (dq.trim() !== urlQ) setParam('q', dq.trim() || null); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (urlQ !== q.trim() && urlQ !== dq.trim()) setQ(urlQ); }, [urlQ]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = usePipeline({ mine: false, q: dq });
  const all = query.data?.items ?? [];
  const droppedCount = all.filter((w) => w.stage === 'dropped').length;
  const owners = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of all) if (w.owner) m.set(w.owner.id, w.owner.name);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);
  const filtered = useMemo(() => all.filter((w) =>
    (owner === 'all' || (owner === 'me' ? w.owner?.id === me?.user.id : owner === 'none' ? !w.owner : w.owner?.id === owner))
    && matchesClosing(w.tender.endAt, closing)
    && (showDropped || w.stage !== 'dropped')), [all, owner, closing, me, showDropped]);
  const filtering = owner !== 'all' || closing !== 'any' || !!q.trim();

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader
        title="Pipeline"
        description="Every bid from first look to result. Drag cards between stages — TenderPilot prepares, you submit on GeM."
        actions={
          <Segmented aria-label="View" value={view} onChange={setView}
            options={[{ value: 'board', label: 'Board', icon: <Columns3 /> }, { value: 'table', label: 'Table', icon: <Table2 /> }]} />
        }
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, bid number or buyer" aria-label="Search pipeline"
          leading={<Search />} className="sm:w-72" />
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Select aria-label="Owner" value={owner} onValueChange={(v) => setParam('owner', v)} className="sm:w-44"
            options={[{ value: 'all', label: 'All owners' }, { value: 'me', label: 'Owned by me' }, { value: 'none', label: 'Unassigned' },
              ...owners.filter(([id]) => id !== me?.user.id).map(([id, name]) => ({ value: id, label: name }))]} />
          <Select aria-label="Closing" value={closing} onValueChange={(v) => setParam('closing', v)} className="sm:w-44"
            options={[{ value: 'any', label: 'Any closing date' }, { value: '3', label: 'Closing in 3 days' }, { value: '7', label: 'Closing in 7 days' },
              { value: '30', label: 'Closing in 30 days' }, { value: 'closed', label: 'Already closed' }]} />
        </div>
        {(droppedCount > 0 || showDropped) && (
          <Button variant={showDropped ? 'secondary' : 'ghost'} size="sm" aria-pressed={showDropped} onClick={() => setShowDropped((v) => !v)}>
            <Archive /> Show dropped ({droppedCount})
          </Button>
        )}
        {filtering && (
          <Button variant="ghost" size="sm" onClick={() => { setQ(''); setParams(new URLSearchParams(), { replace: true }); }}>Clear filters</Button>
        )}
        {query.data && (
          <p className="text-[13px] text-muted-foreground sm:ml-auto">
            {pluralize(filtered.length, 'bid')}
            {' · '}EMD {formatINRCompact(filtered.filter((w) => !['won', 'lost', 'dropped'].includes(w.stage)).reduce((a, w) => a + (w.tender.emdAmount ?? 0), 0))} at stake
          </p>
        )}
      </div>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} />
      ) : query.isLoading ? (
        <BoardSkeleton />
      ) : emptyKind(all.length, filtering) === 'pipeline' ? (
        <EmptyState icon={KanbanSquare} title="Your pipeline is empty"
          body="Open a tender you like and choose “Start bid” — it lands here in Identified. From there, drag it through analysis, preparation and submission."
          action={<Button asChild><Link to="/tenders?matched=1">Browse matched tenders</Link></Button>} />
      ) : filtering && filtered.length === 0 ? (
        // The server already applied `q`, so "no items" here means the filters matched nothing (US2-15).
        <EmptyState icon={Search} title="No bids match these filters"
          body="Try another search term, a wider closing window or a different owner — or choose “Clear filters” above to see every bid." />
      ) : view === 'table' ? (
        <PipelineTable items={filtered} focusStage={focusStage} />
      ) : (
        <KanbanBoard items={filtered} canDrag={can('analyst')} focusStage={focusStage} stages={showDropped ? BOARD_WITH_DROPPED : PIPELINE_STAGES} />
      )}
    </div>
  );
}

// ───────────── Board ─────────────

/** A move (drag or "Move to…") ready to send: the optimistic board and the board to restore on error/cancel. */
interface PendingMove { card: WorkspaceCard; from: StageName; to: StageName; position: number; optimistic: Board; revert: Board }

function KanbanBoard({ items, canDrag, focusStage, stages }: { items: WorkspaceCard[]; canDrag: boolean; focusStage: StageName | null; stages: StageName[] }) {
  const navigate = useNavigate();
  const { role } = useAuth();
  const move = useMoveCard();
  const [board, setBoard] = useState<Board>(() => buildBoard(items));
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<PendingMove | null>(null);
  const [outcomeFor, setOutcomeFor] = useState<OutcomeTarget | null>(null);
  const snapshot = useRef<{ board: Board; stage: StageName; index: number } | null>(null);
  const live = useRef({ board, stages });
  live.current = { board, stages };
  const scroller = useRef<HTMLDivElement>(null);

  // Server data wins whenever we're not mid-drag.
  useEffect(() => { if (!activeId) setBoard(buildBoard(items)); }, [items, activeId]);

  useEffect(() => {
    if (!focusStage) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-stage="${focusStage}"]`);
    el?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  }, [focusStage]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnKeyboardCoordinates(live) }),
  );

  const stageOf = (id: UniqueIdentifier, b = board): StageName | null => {
    if ((stages as string[]).includes(String(id))) return id as StageName;
    for (const s of stages) if (b[s].some((c) => c.id === id)) return s;
    return null;
  };
  const active = activeId ? stages.flatMap((s) => board[s]).find((c) => c.id === activeId) ?? null : null;

  /** Shared by drag-and-drop and "Move to…": same PATCH, toasts, revert and blocker explanation (FR-029). */
  const commit = (m: PendingMove) => {
    const stageChanged = m.to !== m.from;
    setBoard(m.optimistic);
    move.mutate({ id: m.card.id, stage: stageChanged ? m.to : undefined, position: m.position }, {
      onSuccess: () => {
        if (!stageChanged) return;
        if (m.to === 'won') toast.success('Marked as won', { description: 'Record the L1 price and notes to sharpen your win-rate insights.' });
        else if (m.to === 'submitted') toast.success('Marked as submitted', { description: 'Recorded for your team. TenderPilot never submits on GeM for you.' });
        else toast.success(`Moved to ${STAGE_LABEL[m.to as Stage]}`);
        if (m.to === 'won' || m.to === 'lost') setOutcomeFor({ id: m.card.id, tenderId: m.card.tender.id, title: m.card.tender.title, result: m.to });
      },
      onError: (err) => {
        setBoard(m.revert);
        explainMoveError(err, m.card, m.to, () => navigate(`/workspaces/${m.card.id}`));
      },
    });
  };
  /** Moves to Dropped need a confirmation (FR-031); the card stays put until confirmed. */
  const requestMove = (m: PendingMove) => {
    // #527: Go / Dropped are the Bid Manager's call. Refuse gracefully (card goes back) before any request is sent.
    if (!canMoveToStage(role, m.from, m.to)) { setBoard(m.revert); toast.error(DECISION_TOOLTIP, { description: DECISION_FORBIDDEN_MESSAGE }); return; }
    if (m.to === 'dropped' && m.from !== 'dropped') { setBoard(m.revert); setConfirmDrop(m); return; }
    commit(m);
  };
  /** "Move to…": append to the end of the target column. */
  const moveTo = (card: WorkspaceCard, to: StageName) => {
    const from = STAGES.find((s) => board[s].some((c) => c.id === card.id)) ?? card.stage;
    const col = board[to].filter((c) => c.id !== card.id);
    const position = positionAt(col, col.length);
    const optimistic = { ...board, [from]: board[from].filter((c) => c.id !== card.id), [to]: [...col, { ...card, stage: to, position }] };
    requestMove({ card, from, to, position, optimistic, revert: board });
  };

  const onDragStart = (e: DragStartEvent) => {
    const s = stageOf(e.active.id)!;
    snapshot.current = { board, stage: s, index: board[s].findIndex((c) => c.id === e.active.id) };
    setActiveId(e.active.id);
  };

  const onDragOver = ({ active: a, over }: DragOverEvent) => {
    if (!over) return;
    const from = stageOf(a.id), to = stageOf(over.id);
    if (!from || !to || from === to) return;
    setBoard((b) => {
      const card = b[from].find((c) => c.id === a.id);
      if (!card) return b;
      const overIndex = b[to].findIndex((c) => c.id === over.id);
      const idx = overIndex >= 0 ? overIndex : b[to].length;
      return { ...b, [from]: b[from].filter((c) => c.id !== a.id), [to]: [...b[to].slice(0, idx), card, ...b[to].slice(idx)] };
    });
  };

  const onDragEnd = ({ active: a, over }: DragEndEvent) => {
    const snap = snapshot.current;
    snapshot.current = null;
    setActiveId(null);
    if (!snap) return;
    const to = over ? stageOf(over.id) : null;
    if (!to) { setBoard(snap.board); return; }
    let next = board;
    const oldIdx = board[to].findIndex((c) => c.id === a.id);
    const overIdx = board[to].findIndex((c) => c.id === over!.id);
    if (oldIdx >= 0 && overIdx >= 0 && oldIdx !== overIdx) {
      next = { ...board, [to]: arrayMove(board[to], oldIdx, overIdx) };
      setBoard(next);
    }
    const col = next[to];
    const index = col.findIndex((c) => c.id === a.id);
    if (index < 0) { setBoard(snap.board); return; }
    if (to === snap.stage && index === snap.index) return;
    const card = col[index]!;
    const position = positionAt(col.filter((c) => c.id !== a.id), index);
    requestMove({
      card, from: snap.stage, to, position, revert: snap.board,
      optimistic: { ...next, [to]: col.map((c) => (c.id === card.id ? { ...c, stage: to, position } : c)) },
    });
  };

  return (
    <DndContext sensors={canDrag ? sensors : []} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver}
      onDragEnd={onDragEnd} onDragCancel={() => { if (snapshot.current) setBoard(snapshot.current.board); snapshot.current = null; setActiveId(null); }}
      accessibility={{
        announcements: {
          onDragStart: ({ active: a }) => `Picked up ${titleOf(board, a.id)}.`,
          onDragOver: ({ over }) => (over ? `Over ${STAGE_LABEL[(stageOf(over.id) ?? 'identified') as Stage]}.` : 'Not over a stage.'),
          onDragEnd: ({ over }) => (over ? `Dropped in ${STAGE_LABEL[(stageOf(over.id) ?? 'identified') as Stage]}.` : 'Drop cancelled.'),
          onDragCancel: () => 'Drag cancelled.',
        },
      }}>
      {/* Stage jump chips (phones) */}
      <nav aria-label="Jump to stage" className="scrollbar-thin -mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 md:hidden">
        {stages.map((s) => (
          <button key={s} type="button" className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium focus-ring"
            onClick={() => scroller.current?.querySelector<HTMLElement>(`[data-stage="${s}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })}>
            <span className={cn('size-1.5 rounded-full', STAGE_DOT[s])} />{STAGE_LABEL[s as Stage]}<span className="tabular text-muted-foreground">{board[s].length}</span>
          </button>
        ))}
      </nav>
      <div ref={scroller} className="scrollbar-thin -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 md:snap-none lg:-mx-8 lg:px-8">
        {stages.map((s) => (
          <KanbanColumn key={s} stage={s} cards={board[s]} canDrag={canDrag} locked={canDrag && isDecisionStage(s) && !canMoveToStage(role, 'identified', s)} highlighted={focusStage === s} onMove={moveTo} />
        ))}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }}>
        {active ? <CardView card={active} overlay /> : null}
      </DragOverlay>
      {!canDrag && <p className="mt-1 text-xs text-muted-foreground">{VIEW_ONLY_NOTE}</p>}
      <ConfirmDialog open={!!confirmDrop} onOpenChange={(o) => { if (!o) setConfirmDrop(null); }}
        title={DROP_CONFIRM_TITLE} description={DROP_CONFIRM_BODY} confirmLabel="Drop bid"
        onConfirm={() => { const m = confirmDrop; setConfirmDrop(null); if (m) commit({ ...m, revert: board }); }}>
        {confirmDrop && <p className="text-sm font-medium">{confirmDrop.card.tender.title}</p>}
      </ConfirmDialog>
      <OutcomeDialog target={outcomeFor} onClose={() => setOutcomeFor(null)} />
    </DndContext>
  );
}

/**
 * Keyboard drag (FR-022, US2-13): ←/→ move exactly one visible column per press, starting from the column the card
 * is in now (its own column is also a droppable, which made the first press a no-op with dnd-kit's default getter).
 * The target is the column's droppable rect; when it is off-screen the KeyboardSensor scrolls the board to it.
 * ↑/↓ keep the sortable behaviour (reorder within a column).
 */
function columnKeyboardCoordinates(live: { current: { board: Board; stages: StageName[] } }): KeyboardCoordinateGetter {
  return (event, args) => {
    if (event.code !== 'ArrowRight' && event.code !== 'ArrowLeft') return sortableKeyboardCoordinates(event, args);
    event.preventDefault();
    const { board, stages } = live.current;
    const current = stages.find((s) => board[s].some((c) => c.id === args.active)) ?? null;
    const target = adjacentStage(stages, current, event.code === 'ArrowRight' ? 1 : -1);
    if (!target) return undefined;
    const rect = args.context.droppableRects.get(target);
    if (!rect) return undefined;
    // Also bring the column into view for sighted keyboard users (the sensor scrolls the board itself too).
    document.querySelector<HTMLElement>(`[data-stage="${target}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    return { x: rect.left, y: rect.top };
  };
}

const titleOf = (b: Board, id: UniqueIdentifier) => STAGES.flatMap((s) => b[s]).find((c) => c.id === id)?.tender.title ?? 'bid';

function explainMoveError(err: unknown, card: WorkspaceCard, to: StageName, open: () => void) {
  if (err instanceof ApiError && err.status === 409) {
    const blockers = ((err.details as { blockers?: { item?: { label?: string }; label?: string }[] } | undefined)?.blockers ?? [])
      .map((b) => b.item?.label ?? b.label).filter(Boolean) as string[];
    toast.error(`Can’t move to ${STAGE_LABEL[to as Stage]} yet`, {
      description: blockers.length ? `${err.message} Missing: ${blockers.slice(0, 3).join('; ')}${blockers.length > 3 ? ` +${blockers.length - 3} more` : ''}.` : err.message,
      action: { label: 'Open workspace', onClick: open },
      duration: 9000,
    });
    return;
  }
  toast.error(`Couldn’t move “${card.tender.title.slice(0, 40)}…”`, { description: errorMessage(err) });
}

function KanbanColumn({ stage, cards, canDrag, locked, highlighted, onMove }: {
  stage: StageName; cards: WorkspaceCard[]; canDrag: boolean; locked: boolean; highlighted: boolean; onMove: (card: WorkspaceCard, to: StageName) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const emd = cards.reduce((a, c) => a + (c.tender.emdAmount ?? 0), 0);
  return (
    <section data-stage={stage} aria-label={`${STAGE_LABEL[stage as Stage]} — ${pluralize(cards.length, 'bid')}`}
      className={cn('flex w-[84vw] max-w-[320px] shrink-0 snap-start flex-col rounded-xl border bg-subtle/80 sm:w-72',
        highlighted && 'ring-2 ring-primary/40', isOver && 'border-primary/40 bg-primary-soft/40')}>
      <header className="flex items-start justify-between gap-2 px-3 pb-2 pt-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold">
            <span className={cn('size-2 rounded-full', STAGE_DOT[stage])} aria-hidden />
            {STAGE_LABEL[stage as Stage]}
            {locked && (
              <Tooltip content={DECISION_TOOLTIP}>
                <span tabIndex={0} role="img" aria-label={DECISION_TOOLTIP} data-testid={`locked-${stage}`} className="text-muted-foreground focus-ring rounded"><Lock className="size-3" aria-hidden /></span>
              </Tooltip>
            )}
            <span className="tabular rounded-full bg-muted px-1.5 text-2xs font-medium text-muted-foreground">{cards.length}</span>
          </h2>
          <p className="mt-0.5 truncate text-2xs text-muted-foreground">{STAGE_HINT[stage]}</p>
        </div>
        {emd > 0 && (
          <Tooltip content="Total EMD (earnest money) in this column">
            <span className="tabular shrink-0 text-2xs font-medium text-muted-foreground">EMD {formatINRCompact(emd)}</span>
          </Tooltip>
        )}
      </header>
      <SortableContext id={stage} items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ol ref={setNodeRef} className="flex min-h-[120px] flex-1 flex-col gap-2 px-2 pb-2">
          {cards.map((c) => <SortableCard key={c.id} card={c} disabled={!canDrag} onMove={onMove} />)}
          {cards.length === 0 && (
            <li className="flex flex-1 items-center justify-center rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              {canDrag && !locked ? 'Drop a bid here' : 'No bids'}
            </li>
          )}
        </ol>
      </SortableContext>
    </section>
  );
}

function SortableCard({ card, disabled, onMove }: { card: WorkspaceCard; disabled: boolean; onMove: (card: WorkspaceCard, to: StageName) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id, disabled });
  const style: CSSProperties = { transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined, transition };
  return (
    <li ref={setNodeRef} style={style} className={cn(isDragging && 'opacity-40')}>
      <CardView card={card} handleProps={disabled ? undefined : { ...attributes, ...listeners }}
        menu={disabled ? undefined : <MoveToMenu title={card.tender.title} stage={card.stage} onMove={(to) => onMove(card, to)} />} />
    </li>
  );
}

const CardView = memo(forwardRef<HTMLDivElement, { card: WorkspaceCard; overlay?: boolean; handleProps?: HTMLAttributes<HTMLElement>; menu?: ReactNode }>(
  function CardView({ card, overlay, handleProps, menu }, ref) {
    const done = card.stage === 'submitted' || card.stage === 'won' || card.stage === 'lost' || card.stage === 'dropped';
    const r = card.readiness;
    return (
      <div ref={ref} className={cn('group relative rounded-lg border bg-card p-3 shadow-xs transition-shadow hover:shadow-md',
        overlay && 'rotate-[1.5deg] cursor-grabbing shadow-xl ring-1 ring-primary/30')}>
        {handleProps && (
          <button type="button" aria-label={`Move ${card.tender.title}`} {...handleProps}
            className="absolute right-1.5 top-1.5 flex size-6 cursor-grab touch-none items-center justify-center rounded text-muted-foreground opacity-60 hover:bg-muted hover:opacity-100 focus-ring active:cursor-grabbing sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100">
            <GripVertical className="size-3.5" />
          </button>
        )}
        {menu && <div className="absolute right-8 top-1.5">{menu}</div>}
        <Link to={`/workspaces/${card.id}`} className="block rounded focus-ring" draggable={false}>
          <div className={cn('flex items-start gap-2.5', menu ? 'pr-12' : 'pr-5')}>
            <ScoreRing score={card.analysis?.score} verdict={card.analysis?.verdict ?? undefined} size={34} animate={false} />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[13px] font-medium leading-snug">{card.tender.title}</p>
              <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">{card.tender.bidNumber}</p>
            </div>
          </div>
          <p className="mt-2 truncate text-xs text-muted-foreground">{card.tender.organisation ?? card.tender.ministry ?? 'Buyer not published'}{card.tender.state ? ` · ${card.tender.state}` : ''}</p>
          <div className="mt-2.5 flex items-center justify-between gap-2">
            {card.stage === 'won' ? <Badge tone="success" size="sm"><Trophy /> Won</Badge>
              : card.stage === 'lost' ? <Badge tone="danger" size="sm"><XCircle /> Lost</Badge>
                : card.stage === 'dropped' ? <Badge tone="neutral" size="sm"><Archive /> Dropped</Badge>
                : card.stage === 'submitted' ? <span className="text-2xs text-muted-foreground">Submitted {card.submittedAt ? formatDateIST(card.submittedAt) : ''}</span>
                  : <Countdown to={card.tender.endAt} compact />}
            <span className="flex items-center gap-2">
              {card.commentCount > 0 && <span className="inline-flex items-center gap-0.5 text-2xs text-muted-foreground"><MessageSquare className="size-3" />{card.commentCount}</span>}
              {card.tender.emdAmount ? <span className="tabular text-2xs font-medium text-muted-foreground">EMD {formatINRCompact(card.tender.emdAmount)}</span> : null}
              {card.owner ? <Tooltip content={`Owner: ${card.owner.name}`}><span><Avatar name={card.owner.name} size="xs" /></span></Tooltip> : null}
            </span>
          </div>
          {!done && r.total > 0 && (
            <div className="mt-2.5">
              <div className="mb-1 flex items-center justify-between text-2xs text-muted-foreground">
                <span>Packet readiness</span>
                <span className={cn('tabular font-medium', r.blockers ? 'text-danger' : 'text-foreground')}>
                  {r.blockers ? <span className="inline-flex items-center gap-0.5"><AlertTriangle className="size-3" />{pluralize(r.blockers, 'blocker')}</span> : `${r.percent}%`}
                </span>
              </div>
              <Progress value={r.percent} tone="auto" size="sm" aria-label={`Readiness ${r.percent}%`} />
            </div>
          )}
        </Link>
      </div>
    );
  },
));

function BoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-hidden" aria-busy="true" aria-label="Loading pipeline">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="grid w-[84vw] max-w-[320px] shrink-0 content-start gap-2 rounded-xl border bg-subtle p-3 sm:w-72">
          <Skeleton className="h-4 w-24" />
          {Array.from({ length: 3 - (i % 2) }, (_, j) => <Skeleton key={j} className="h-28 w-full rounded-lg" />)}
        </div>
      ))}
    </div>
  );
}

// ───────────── Table ─────────────

function PipelineTable({ items, focusStage }: { items: WorkspaceCard[]; focusStage: StageName | null }) {
  const navigate = useNavigate();
  const rows = useMemo(() => [...items]
    .filter((w) => !focusStage || w.stage === focusStage)
    .sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || (a.tender.endAt ?? '').localeCompare(b.tender.endAt ?? '')), [items, focusStage]);
  const columns: Column<WorkspaceCard>[] = [
    {
      key: 'tender', header: 'Tender', primary: true, className: 'max-w-[360px]',
      cell: (w) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{w.tender.title}</p>
          <p className="truncate text-xs text-muted-foreground"><span className="font-mono">{w.tender.bidNumber}</span> · {w.tender.organisation ?? w.tender.ministry}</p>
        </div>
      ),
    },
    { key: 'stage', header: 'Stage', cell: (w) => <StageBadge stage={w.stage as Stage} size="sm" /> },
    { key: 'score', header: 'Score', cell: (w) => (w.analysis?.verdict ? <span className="inline-flex items-center gap-1.5"><span className="tabular font-medium">{w.analysis.score}</span><VerdictBadge verdict={w.analysis.verdict} size="sm" showIcon={false} /></span> : <span className="text-muted-foreground">—</span>) },
    { key: 'closes', header: 'Closes', cell: (w) => <Countdown to={w.tender.endAt} compact /> },
    { key: 'emd', header: 'EMD', className: 'text-right', cell: (w) => <span className="tabular">{formatINR(w.tender.emdAmount, { fallback: '—' })}</span> },
    { key: 'ready', header: 'Readiness', hideOnMobile: true, cell: (w) => (w.readiness.total ? <div className="flex w-28 items-center gap-2"><Progress value={w.readiness.percent} tone="auto" size="sm" /><span className="tabular text-xs">{w.readiness.percent}%</span></div> : <span className="text-muted-foreground">—</span>) },
    { key: 'owner', header: 'Owner', hideOnMobile: true, cell: (w) => (w.owner ? <span className="inline-flex items-center gap-2"><Avatar name={w.owner.name} size="xs" />{w.owner.name}</span> : <span className="text-muted-foreground">Unassigned</span>) },
  ];
  return (
    <ResponsiveTable columns={columns} rows={rows} rowKey={(w) => w.id} onRowClick={(w) => navigate(`/workspaces/${w.id}`)}
      empty={<EmptyState compact title="No bids match these filters" body="Try a wider closing window or clear the owner filter." />} />
  );
}
