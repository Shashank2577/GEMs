/**
 * Bid workspace routes (T063; FR-023, FR-028). Owned by the Apply team.
 *
 *   POST  /tenders/:id/workspace          create-or-get (auto-maps vault docs from the latest analysis)   analyst+
 *   GET   /workspaces                     ?stage&mine&q → Kanban cards { items, total, byStage }        viewer+
 *   GET   /workspaces/:id                 WorkspaceDetail                                               viewer+
 *   PATCH /workspaces/:id                 stage/owner/assignees/due/position/outcome; `ready` + won/lost guarded (409) analyst+
 *   PUT   /workspaces/:id/mapping         { itemId: docId | null | "auto" }                              analyst+
 *   POST  /workspaces/:id/overrides       { itemId, reason }                                            bid_manager+
 *   DELETE /workspaces/:id/overrides/:itemId                                                            bid_manager+
 *   GET   /workspaces/:id/comments        CommentDto[]                                                  viewer+
 *   POST  /workspaces/:id/comments        { body }                                                      analyst+
 *   PUT   /workspaces/:id/assist-values   allow-listed non-financial values only (price-like → 400)    analyst+
 *   POST  /workspaces/:id/submitted       human confirms they submitted on GeM                          analyst+
 *   GET   /tenders/:id/result-hint        optional L1 hint from GeM's public result page (007/FR-030)    analyst+
 *
 * TenderPilot never submits on GeM (Constitution I): "submitted" only records what the human did.
 */
import { and, asc, desc, eq, inArray, max, ne } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { bidWorkspaces, comments, memberships, notifications } from '@tp/db';
import {
  STAGES, STAGE_LABELS, assistValuesSchema, canTransition, commentInputSchema, mappingInputSchema, overrideInputSchema, submittedInputSchema,
  workspaceUpdateSchema, type StageName, type WorkspaceListResponse,
} from '@tp/core/contracts/apply';
import { validateAssistValues, isForbiddenKey } from '@tp/core/assist/allowlist';
import { autoMap } from '@tp/core/packet/mapping';
import { parseBidResult, type BidResultHint } from '@tp/core/gem/award';
import { GemClient } from '@tp/core/gem/client';
import type { AppDeps } from '../deps';
import { logActivity } from '../lib/activity';
import { HttpError, conflict, notFound, validationError } from '../lib/errors';
import { parseJson, parseWith } from '../lib/validate';
import { orgId, requireAuth, requireRole, userId } from '../middleware/auth';
import {
  asMappable, getTenderRow, getWorkspace, latestAnalysis, listComments, listWorkspaceCards, readinessFor, vaultRows, workspaceDetail,
  workspaceDto, type WorkspaceRow,
} from '../services/packet';
import type { AppEnv } from '../types';

export const workspacesRoutes = new Hono<AppEnv>();

const log = (c: Context<AppEnv>, w: { id: string; tenderId: string }, action: string, meta: Record<string, unknown> = {}) =>
  logActivity(c.var.deps.db, { orgId: orgId(c), userId: userId(c), action, entityType: 'workspace', entityId: w.id, meta: { tenderId: w.tenderId, ...meta } });

async function touch(deps: AppDeps, org: string, id: string, set: Partial<typeof bidWorkspaces.$inferInsert>): Promise<WorkspaceRow> {
  const [w] = await deps.db.update(bidWorkspaces).set({ ...set, updatedAt: deps.clock.now() })
    .where(and(eq(bidWorkspaces.orgId, org), eq(bidWorkspaces.id, id))).returning();
  if (!w) throw notFound('Bid workspace');
  return w;
}

async function readinessOf(deps: AppDeps, org: string, w: WorkspaceRow) {
  const [a, docs] = await Promise.all([latestAnalysis(deps, org, w.tenderId), vaultRows(deps, org)]);
  return { analysis: a, readiness: readinessFor(w, a, docs, deps.clock.now()), docs };
}

async function nextPosition(deps: AppDeps, org: string, stage: StageName): Promise<number> {
  const [r] = await deps.db.select({ m: max(bidWorkspaces.position) }).from(bidWorkspaces)
    .where(and(eq(bidWorkspaces.orgId, org), eq(bidWorkspaces.stage, stage)));
  return (r?.m ?? 0) + 1;
}

/** Below this gap two neighbouring positions are treated as exhausted (007/FR-033). */
export const MIN_POSITION_GAP = 1e-9;

/**
 * Where a card asked for `requested` in `stage` lands (007/FR-033). Normally the requested fractional position
 * is used as is. When it is not representable — it collides with a neighbour once stored as `real` (float4), or
 * the neighbours differ by < 1e-9 — the column is renumbered 1, 2, 3, … in its current order with the card
 * inserted at the requested slot; `renumber` lists the sibling updates to apply in the same transaction.
 */
async function planPosition(deps: AppDeps, org: string, id: string, stage: StageName, requested: number): Promise<{ position: number; renumber: { id: string; position: number }[] | null }> {
  const sibs = await deps.db.select({ id: bidWorkspaces.id, position: bidWorkspaces.position }).from(bidWorkspaces)
    .where(and(eq(bidWorkspaces.orgId, org), eq(bidWorkspaces.stage, stage), ne(bidWorkspaces.id, id)))
    .orderBy(asc(bidWorkspaces.position), desc(bidWorkspaces.updatedAt));
  const found = sibs.findIndex((s) => s.position >= requested);
  const at = found < 0 ? sibs.length : found;
  const lower = sibs[at - 1]?.position;
  const upper = sibs[at]?.position;
  const stored = Math.fround(requested); // what Postgres `real` will keep
  const exhausted = (upper !== undefined && !(stored < upper)) || (lower !== undefined && !(stored > lower))
    || (lower !== undefined && upper !== undefined && upper - lower < MIN_POSITION_GAP);
  if (!exhausted) return { position: requested, renumber: null };
  const order = [...sibs.slice(0, at).map((s) => s.id), id, ...sibs.slice(at).map((s) => s.id)];
  return { position: at + 1, renumber: order.map((x, i) => ({ id: x, position: i + 1 })).filter((x) => x.id !== id) };
}

async function notify(deps: AppDeps, org: string, userIds: string[], n: { kind: 'assignment' | 'mention'; title: string; body: string; link: string; dedupeKey: string }) {
  if (!userIds.length) return;
  const now = deps.clock.now();
  await deps.db.insert(notifications).values(userIds.map((u) => ({
    orgId: org, userId: u, channel: 'in_app' as const, kind: n.kind, title: n.title, body: n.body, link: n.link, dedupeKey: n.dedupeKey,
    status: 'sent' as const, sentAt: now, createdAt: now,
  }))).onConflictDoNothing();
}

// ───────────── create-or-get ─────────────

workspacesRoutes.post('/tenders/:id/workspace', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const t = await getTenderRow(deps, c.req.param('id'));
  const [existing] = await deps.db.select().from(bidWorkspaces).where(and(eq(bidWorkspaces.orgId, org), eq(bidWorkspaces.tenderId, t.id)));
  if (existing) return c.json({ ...(await workspaceDto(deps, existing)), created: false });

  const [a, docs] = await Promise.all([latestAnalysis(deps, org, t.id), vaultRows(deps, org)]);
  const now = deps.clock.now();
  // Store NO mapping: absent keys mean "automatic" (FR-014), resolved at read time, so a document uploaded later
  // is picked up and a deleted one falls back to the next best (FR-020, US2 #9). Snapshotting the auto picks here
  // would turn them into explicit choices. The count is kept for the activity entry only.
  const autoMatched = Object.values(autoMap(a?.checklist ?? [], docs.map(asMappable), now)).filter(Boolean).length;
  const docMapping: Record<string, string> = {};
  const stage: StageName = a?.verdict === 'go' ? 'go' : a?.status === 'running' ? 'analysing' : 'identified';
  const [w] = await deps.db.insert(bidWorkspaces).values({
    orgId: org, tenderId: t.id, stage, ownerId: userId(c), assigneeIds: [], dueAt: t.endAt, docMapping,
    position: await nextPosition(deps, org, stage), createdAt: now, updatedAt: now,
  }).onConflictDoNothing().returning();
  if (!w) {
    // Lost a race with a concurrent create — return the winner.
    const [again] = await deps.db.select().from(bidWorkspaces).where(and(eq(bidWorkspaces.orgId, org), eq(bidWorkspaces.tenderId, t.id)));
    return c.json({ ...(await workspaceDto(deps, again)), created: false });
  }
  await log(c, w, 'workspace.created', { stage, bidNumber: t.bidNumber, autoMatched });
  await logActivity(deps.db, { orgId: org, userId: userId(c), action: 'workspace.created', entityType: 'tender', entityId: t.id, meta: { workspaceId: w.id } });
  return c.json({ ...(await workspaceDto(deps, w)), created: true }, 201);
});

// ───────────── list & detail ─────────────

workspacesRoutes.get('/workspaces', requireAuth, async (c) => {
  const stages = c.req.queries('stage')?.flatMap((s) => s.split(',')).filter(Boolean) ?? [];
  const bad = stages.filter((s) => !(STAGES as readonly string[]).includes(s));
  if (bad.length) throw validationError(`stage: unknown stage "${bad[0]}"`, { fields: { stage: `Use one of ${STAGES.join(', ')}` } });
  const mine = c.req.query('mine');
  const items = await listWorkspaceCards(c.var.deps, orgId(c), {
    stage: stages, q: c.req.query('q')?.trim() || null, mine: mine === '1' || mine === 'true' ? userId(c) : null,
  });
  const byStage: WorkspaceListResponse['byStage'] = {};
  for (const i of items) byStage[i.stage] = (byStage[i.stage] ?? 0) + 1;
  return c.json({ items, total: items.length, byStage } satisfies WorkspaceListResponse);
});

workspacesRoutes.get('/workspaces/:id', requireAuth, async (c) => {
  const org = orgId(c);
  const w = await getWorkspace(c.var.deps, org, c.req.param('id'));
  return c.json(await workspaceDetail(c.var.deps, org, w));
});

// ───────────── update (stage guard) ─────────────

workspacesRoutes.patch('/workspaces/:id', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const w = await getWorkspace(deps, org, c.req.param('id'));
  const body = await parseJson(c, workspaceUpdateSchema);
  const now = deps.clock.now();
  const set: Partial<typeof bidWorkspaces.$inferInsert> = {};

  // People must be members of this org.
  const ids = [...(body.ownerId ? [body.ownerId] : []), ...(body.assigneeIds ?? [])];
  if (ids.length) {
    const rows = await deps.db.select({ userId: memberships.userId }).from(memberships)
      .where(and(eq(memberships.orgId, org), inArray(memberships.userId, ids)));
    const ok = new Set(rows.map((r) => r.userId));
    const missing = ids.filter((i) => !ok.has(i));
    if (missing.length) throw validationError('Only members of your organization can be assigned', { fields: { [body.ownerId && missing.includes(body.ownerId) ? 'ownerId' : 'assigneeIds']: 'Not a member of this organization' } });
  }
  if (body.ownerId !== undefined) set.ownerId = body.ownerId;
  if (body.assigneeIds !== undefined) set.assigneeIds = [...new Set(body.assigneeIds)];
  if (body.dueAt !== undefined) set.dueAt = body.dueAt ? new Date(body.dueAt) : null;

  let stage = body.stage;
  // FR-008 (T020): won/lost — by stage or by outcome — only once the bid was submitted (or to correct a result).
  for (const to of [stage, body.outcome?.result]) {
    if (!to || to === w.stage) continue;
    const check = canTransition(w.stage, to);
    if (!check.ok) throw new HttpError(409, check.code, check.message, { from: w.stage, to });
  }
  if (body.outcome !== undefined) {
    set.outcome = body.outcome ? { ...body.outcome, l1Price: body.outcome.l1Price ?? undefined, ourPrice: body.outcome.ourPrice ?? undefined, notes: body.outcome.notes ?? undefined, at: now.toISOString() } : null;
    if (body.outcome && !stage) stage = body.outcome.result;
  }
  if (stage && stage !== w.stage) {
    if (stage === 'ready') {
      const { readiness } = await readinessOf(deps, org, w);
      if (!readiness.analysed) throw conflict('Analyse the tender before marking the bid ready to submit.', { blockers: [], reason: 'not_analysed' });
      if (!readiness.canMarkReady) {
        throw new HttpError(409, 'not_ready', `${readiness.blockers.length} required document${readiness.blockers.length === 1 ? ' is' : 's are'} missing or expired. Replace ${readiness.blockers.length === 1 ? 'it' : 'them'} in the vault, or ask a Bid Manager to override with a reason.`, { blockers: readiness.blockers });
      }
    }
    if ((stage === 'won' || stage === 'lost') && !body.outcome && !w.outcome) {
      set.outcome = { result: stage, at: now.toISOString() };
    }
    if (stage === 'submitted' && !w.submittedAt) set.submittedAt = now;
    set.stage = stage;
    if (body.position === undefined) set.position = await nextPosition(deps, org, stage);
  }
  let renumber: { id: string; position: number }[] | null = null;
  if (body.position !== undefined) {
    const plan = await planPosition(deps, org, w.id, (set.stage ?? w.stage) as StageName, body.position);
    set.position = plan.position;
    renumber = plan.renumber;
  }
  if (!Object.keys(set).length) return c.json(await workspaceDto(deps, w));

  let updated: WorkspaceRow;
  if (renumber) {
    // FR-033: renumber the column and apply the move atomically.
    updated = await deps.db.transaction(async (tx) => {
      for (const r of renumber!) {
        await tx.update(bidWorkspaces).set({ position: r.position }).where(and(eq(bidWorkspaces.orgId, org), eq(bidWorkspaces.id, r.id)));
      }
      const [u] = await tx.update(bidWorkspaces).set({ ...set, updatedAt: now })
        .where(and(eq(bidWorkspaces.orgId, org), eq(bidWorkspaces.id, w.id))).returning();
      if (!u) throw notFound('Bid workspace');
      return u;
    });
  } else {
    updated = await touch(deps, org, w.id, set);
  }
  if (set.stage) await log(c, w, 'workspace.stage_changed', { from: w.stage, to: set.stage, fromLabel: STAGE_LABELS[w.stage], toLabel: STAGE_LABELS[set.stage as StageName] });
  if (body.outcome) await log(c, w, 'workspace.outcome_recorded', { result: body.outcome.result, l1Price: body.outcome.l1Price ?? null });
  const newPeople = [...(body.ownerId && body.ownerId !== w.ownerId ? [body.ownerId] : []), ...(body.assigneeIds ?? []).filter((a) => !(w.assigneeIds ?? []).includes(a))]
    .filter((u) => u !== userId(c));
  if (body.ownerId !== undefined || body.assigneeIds !== undefined) {
    await log(c, w, 'workspace.assigned', { ownerId: updated.ownerId, assigneeIds: updated.assigneeIds });
    const t = await getTenderRow(deps, w.tenderId);
    await notify(deps, org, [...new Set(newPeople)], {
      kind: 'assignment', title: `You were assigned to ${t.bidNumber}`, body: `${c.var.user.name} assigned you to “${t.title}”.`,
      link: `/workspaces/${w.id}`, dedupeKey: `assign:${w.id}:${now.getTime()}`,
    });
  }
  if (body.dueAt !== undefined) await log(c, w, 'workspace.due_changed', { dueAt: body.dueAt });
  return c.json(await workspaceDto(deps, updated));
});

// ───────────── mapping & overrides ─────────────

workspacesRoutes.put('/workspaces/:id/mapping', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const w = await getWorkspace(deps, org, c.req.param('id'));
  const body = await parseJson(c, mappingInputSchema);
  const { analysis, docs } = await readinessOf(deps, org, w);
  const itemIds = new Set((analysis?.checklist ?? []).map((i) => i.id));
  const docIds = new Set(docs.map((d) => d.id));
  const fields: Record<string, string> = {};
  for (const [itemId, docId] of Object.entries(body)) {
    if (!itemIds.has(itemId)) fields[itemId] = 'Not an item of this bid’s checklist';
    else if (docId && docId !== 'auto' && !docIds.has(docId)) fields[itemId] = 'Document not found in your vault';
  }
  if (Object.keys(fields).length) throw validationError(Object.values(fields)[0], { fields });
  const mapping = { ...(w.docMapping ?? {}) };
  for (const [itemId, docId] of Object.entries(body)) {
    if (docId === 'auto') delete mapping[itemId];
    else mapping[itemId] = docId;
  }
  const updated = await touch(deps, org, w.id, { docMapping: mapping });
  await log(c, w, 'workspace.mapping_changed', { items: Object.keys(body), mapping: body });
  const r = readinessFor(updated, analysis, docs, deps.clock.now());
  return c.json({ workspace: await workspaceDto(deps, updated), readiness: r });
});

workspacesRoutes.post('/workspaces/:id/overrides', requireRole('bid_manager'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const w = await getWorkspace(deps, org, c.req.param('id'));
  const body = await parseJson(c, overrideInputSchema);
  const { analysis, docs } = await readinessOf(deps, org, w);
  const item = (analysis?.checklist ?? []).find((i) => i.id === body.itemId);
  if (!item) throw validationError('itemId: Not an item of this bid’s checklist', { fields: { itemId: 'Not an item of this bid’s checklist' } });
  const overrides = [...(w.overrides ?? []).filter((o) => o.itemId !== body.itemId), { itemId: body.itemId, reason: body.reason, by: userId(c), at: deps.clock.now().toISOString() }];
  const updated = await touch(deps, org, w.id, { overrides });
  await log(c, w, 'workspace.item_overridden', { itemId: item.id, label: item.label, reason: body.reason });
  return c.json({ workspace: await workspaceDto(deps, updated), readiness: readinessFor(updated, analysis, docs, deps.clock.now()) }, 201);
});

workspacesRoutes.delete('/workspaces/:id/overrides/:itemId', requireRole('bid_manager'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const w = await getWorkspace(deps, org, c.req.param('id'));
  const itemId = c.req.param('itemId');
  if (!(w.overrides ?? []).some((o) => o.itemId === itemId)) throw notFound('Override');
  const updated = await touch(deps, org, w.id, { overrides: (w.overrides ?? []).filter((o) => o.itemId !== itemId) });
  await log(c, w, 'workspace.override_removed', { itemId });
  const { analysis, docs } = await readinessOf(deps, org, updated);
  return c.json({ workspace: await workspaceDto(deps, updated), readiness: readinessFor(updated, analysis, docs, deps.clock.now()) });
});

// ───────────── comments ─────────────

workspacesRoutes.get('/workspaces/:id/comments', requireAuth, async (c) => {
  const org = orgId(c);
  const w = await getWorkspace(c.var.deps, org, c.req.param('id'));
  const items = await listComments(c.var.deps, org, w.id);
  return c.json({ items, total: items.length });
});

workspacesRoutes.post('/workspaces/:id/comments', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const w = await getWorkspace(deps, org, c.req.param('id'));
  const { body } = await parseJson(c, commentInputSchema);
  const now = deps.clock.now();
  const [row] = await deps.db.insert(comments).values({ orgId: org, workspaceId: w.id, userId: userId(c), body, createdAt: now }).returning();
  await touch(deps, org, w.id, {});
  await log(c, w, 'workspace.commented', { commentId: row.id, excerpt: body.slice(0, 140) });
  const t = await getTenderRow(deps, w.tenderId);
  const watchers = [...new Set([w.ownerId, ...(w.assigneeIds ?? [])].filter((u): u is string => !!u && u !== userId(c)))];
  await notify(deps, org, watchers, {
    kind: 'mention', title: `New comment on ${t.bidNumber}`, body: `${c.var.user.name}: ${body.slice(0, 160)}`,
    link: `/workspaces/${w.id}`, dedupeKey: `comment:${row.id}`,
  });
  return c.json({ id: row.id, body: row.body, user: { id: c.var.user.id, name: c.var.user.name, email: c.var.user.email }, createdAt: row.createdAt.toISOString() }, 201);
});

// ───────────── assist values & submitted ─────────────

workspacesRoutes.put('/workspaces/:id/assist-values', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const w = await getWorkspace(deps, org, c.req.param('id'));
  // Check keys before types so a price-like key is always reported as forbidden.
  const input = await parseJson(c, z.record(z.string(), z.unknown()));
  const errors = validateAssistValues(input);
  if (Object.keys(errors).length) {
    const forbidden = Object.keys(errors).filter(isForbiddenKey);
    throw new HttpError(400, forbidden.length ? 'forbidden_field' : 'validation_error', Object.values(errors)[0], { fields: errors, forbidden });
  }
  const raw = parseWith(assistValuesSchema, input, 'body');
  const values = { ...(w.assistValues ?? {}) };
  for (const [k, v] of Object.entries(raw)) {
    if (v.trim() === '') delete values[k];
    else values[k] = v.trim();
  }
  const updated = await touch(deps, org, w.id, { assistValues: values });
  await log(c, w, 'workspace.assist_values_saved', { keys: Object.keys(raw) });
  return c.json({ assistValues: updated.assistValues });
});

workspacesRoutes.post('/workspaces/:id/submitted', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const w = await getWorkspace(deps, org, c.req.param('id'));
  const body = await parseJson(c, submittedInputSchema);
  if (w.stage === 'won' || w.stage === 'lost') throw conflict('This bid already has an outcome recorded.');
  if (w.stage === 'dropped') throw conflict('This bid was dropped. Move it back to the pipeline first.');
  const at = body.submittedAt ? new Date(body.submittedAt) : deps.clock.now();
  const updated = await touch(deps, org, w.id, {
    stage: 'submitted', submittedAt: at, ...(w.stage !== 'submitted' ? { position: await nextPosition(deps, org, 'submitted') } : {}),
  });
  await log(c, w, 'workspace.submitted', { from: w.stage, submittedAt: at.toISOString(), note: body.note ?? null });
  return c.json(await workspaceDto(deps, updated));
});

// ───────────── optional L1 hint (007/T033, FR-030) ─────────────

/**
 * One throttled GemClient per app instance, so hint lookups share the polite ≤ 1 req/s queue (Constitution II),
 * plus a short cache so reopening the dialog does not hit GeM again.
 */
const hintClients = new WeakMap<AppDeps, { client: GemClient; cache: Map<string, { at: number; hint: BidResultHint }> }>();
const HINT_TTL_MS = 15 * 60_000;

function hintClient(deps: AppDeps) {
  let h = hintClients.get(deps);
  if (!h) {
    h = {
      client: new GemClient(deps.fetch, {
        baseUrl: deps.gem.baseUrl, userAgent: deps.gem.userAgent, minIntervalMs: deps.gem.minIntervalMs,
        maxRetries: 1, backoffMs: Math.min(1000, Math.max(10, deps.gem.minIntervalMs)), timeoutMs: 15_000,
      }),
      cache: new Map(),
    };
    hintClients.set(deps, h);
  }
  return h;
}

/**
 * Read-only: fetches GeM's PUBLIC result page and suggests the L1 price. The user decides whether to use it;
 * nothing is entered on GeM. Requires a workspace for the tender in the caller's org (else 404).
 */
workspacesRoutes.get('/tenders/:id/result-hint', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const t = await getTenderRow(deps, c.req.param('id'));
  const [w] = await deps.db.select({ id: bidWorkspaces.id }).from(bidWorkspaces).where(and(eq(bidWorkspaces.orgId, org), eq(bidWorkspaces.tenderId, t.id)));
  if (!w) throw notFound('Bid workspace');
  if (!t.gemBidId) return c.json({ available: false, reason: 'no_gem_id' } satisfies BidResultHint);
  const h = hintClient(deps);
  const nowMs = deps.clock.now().getTime();
  const cached = h.cache.get(t.gemBidId);
  if (cached && nowMs - cached.at < HINT_TTL_MS) return c.json(cached.hint);
  let hint: BidResultHint;
  try {
    const page = await h.client.fetchBidResultHtml(t.gemBidId);
    const r = page ? parseBidResult(page.html) : null;
    hint = r && r.bidders.length
      ? { available: true, l1Price: r.l1Price, bidders: r.bidders.map(({ rank, level, price }) => ({ rank, level, price })), sourceUrl: page!.url, fetchedAt: new Date(nowMs).toISOString() }
      : { available: false, reason: 'not_published' };
  } catch (e) {
    deps.logger.warn('result-hint: GeM fetch failed', { tenderId: t.id, error: (e as Error).message });
    return c.json({ available: false, reason: 'gem_unavailable' } satisfies BidResultHint);
  }
  h.cache.set(t.gemBidId, { at: nowMs, hint });
  return c.json(hint);
});
