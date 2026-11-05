/**
 * Apply service (T063; FR-023..FR-025, FR-028): workspace loading, readiness, annexures and packet
 * builds. Routes in routes/{workspaces,packets,assist}.ts are thin wrappers around these helpers.
 * Every query is scoped by org (Constitution IV); packet files live under org/<orgId>/packets/….
 */
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  activityLog, analyses, annexureTemplates, bidWorkspaces, comments, companyProfiles, memberships, packets, tenderDocuments, tenders, users,
  vaultDocuments,
} from '@tp/db';
import type { ActivityItem } from '@tp/core/contracts/auth';
import type {
  AnnexureTemplateDto, CommentDto, PacketDto, PacketItemInput, PersonRef, WorkspaceAnnexure, WorkspaceCard, WorkspaceDetail, WorkspaceDto,
  WorkspaceMember, WorkspaceTender, WorkspaceVaultDoc,
} from '@tp/core/contracts/apply';
import { readiness as computeReadiness, type MappableDoc, type Readiness } from '@tp/core/packet/mapping';
import {
  SYSTEM_TEMPLATES, SYSTEM_TEMPLATE_BY_KEY, buildTemplateContext, missingPlaceholders, placeholdersOf, renderAnnexurePdf,
  type TemplateContext, type TemplateKey,
} from '@tp/core/packet/templates';
import { buildPacket, type BuildItem } from '@tp/core/packet/build';
import { docStatus } from '@tp/core/vault/status';
import type { AppDeps } from '../deps';
import { HttpError, notFound } from '../lib/errors';
import { toAnalysisDto } from './analyse';

export type WorkspaceRow = typeof bidWorkspaces.$inferSelect;
type TenderRow = typeof tenders.$inferSelect;
type AnalysisRow = typeof analyses.$inferSelect;
type VaultRow = typeof vaultDocuments.$inferSelect;
type ProfileRow = typeof companyProfiles.$inferSelect;
type PacketRow = typeof packets.$inferSelect;

const iso = (d: Date | string | null | undefined) => (d == null ? null : d instanceof Date ? d.toISOString() : d);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ───────────── loaders ─────────────

export async function getWorkspace(deps: AppDeps, org: string, id: string): Promise<WorkspaceRow> {
  if (!UUID_RE.test(id)) throw notFound('Bid workspace');
  const [w] = await deps.db.select().from(bidWorkspaces).where(and(eq(bidWorkspaces.orgId, org), eq(bidWorkspaces.id, id)));
  if (!w) throw notFound('Bid workspace');
  return w;
}

export async function getTenderRow(deps: AppDeps, id: string): Promise<TenderRow> {
  if (!UUID_RE.test(id)) throw notFound('Tender');
  const [t] = await deps.db.select().from(tenders).where(eq(tenders.id, id));
  if (!t) throw notFound('Tender');
  return t;
}

export async function latestAnalysis(deps: AppDeps, org: string, tenderId: string): Promise<AnalysisRow | null> {
  const [a] = await deps.db.select().from(analyses)
    .where(and(eq(analyses.orgId, org), eq(analyses.tenderId, tenderId)))
    .orderBy(desc(analyses.createdAt)).limit(1);
  return a ?? null;
}

export async function latestAnalyses(deps: AppDeps, org: string, tenderIds: string[]): Promise<Map<string, AnalysisRow>> {
  const out = new Map<string, AnalysisRow>();
  if (!tenderIds.length) return out;
  const rows = await deps.db.select().from(analyses)
    .where(and(eq(analyses.orgId, org), inArray(analyses.tenderId, tenderIds))).orderBy(desc(analyses.createdAt));
  for (const r of rows) if (!out.has(r.tenderId)) out.set(r.tenderId, r);
  return out;
}

export async function vaultRows(deps: AppDeps, org: string): Promise<VaultRow[]> {
  return deps.db.select().from(vaultDocuments).where(eq(vaultDocuments.orgId, org)).orderBy(desc(vaultDocuments.createdAt));
}

export async function profileRow(deps: AppDeps, org: string): Promise<ProfileRow | null> {
  const [p] = await deps.db.select().from(companyProfiles).where(eq(companyProfiles.orgId, org));
  return p ?? null;
}

export const asMappable = (d: VaultRow): MappableDoc => ({
  id: d.id, type: d.type, title: d.title, expiryDate: d.expiryDate, issueDate: d.issueDate, financialYear: d.financialYear,
  tags: d.tags, fileName: d.fileName, createdAt: d.createdAt,
});

/** No finished analysis yet (none, pending, running or failed) → honest 0 % (not "100 % of nothing") and cannot be marked ready (T021; 006/FR-009). */
const notAnalysed = (): Readiness => ({ items: [], percent: 0, total: 0, covered: 0, blockers: [], warnings: [], canMarkReady: false, analysed: false });

export function readinessFor(w: WorkspaceRow, a: AnalysisRow | null, docs: VaultRow[], now: Date): Readiness {
  if (!a || a.status !== 'done') return notAnalysed();
  return computeReadiness(a?.checklist ?? [], w.docMapping ?? {}, docs.map(asMappable), w.overrides ?? [], now);
}

export async function people(deps: AppDeps, ids: (string | null | undefined)[]): Promise<Map<string, PersonRef>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const rows = await deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, uniq));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function orgMembers(deps: AppDeps, org: string): Promise<WorkspaceMember[]> {
  const rows = await deps.db.select({ id: users.id, name: users.name, email: users.email, role: memberships.role })
    .from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.orgId, org)).orderBy(asc(users.name));
  return rows;
}

// ───────────── DTOs ─────────────

export function toWorkspaceDto(w: WorkspaceRow, ppl: Map<string, PersonRef>): WorkspaceDto {
  return {
    id: w.id, tenderId: w.tenderId, stage: w.stage,
    owner: w.ownerId ? ppl.get(w.ownerId) ?? null : null,
    assignees: (w.assigneeIds ?? []).map((id) => ppl.get(id)).filter((p): p is PersonRef => !!p),
    dueAt: iso(w.dueAt), mapping: w.docMapping ?? {},
    overrides: (w.overrides ?? []).map((o) => ({ ...o, byName: ppl.get(o.by)?.name ?? null })),
    assistValues: w.assistValues ?? {}, outcome: w.outcome ?? null, submittedAt: iso(w.submittedAt), position: w.position,
    createdAt: iso(w.createdAt)!, updatedAt: iso(w.updatedAt)!,
  };
}

export async function workspaceDto(deps: AppDeps, w: WorkspaceRow): Promise<WorkspaceDto> {
  const ppl = await people(deps, [w.ownerId, ...(w.assigneeIds ?? []), ...(w.overrides ?? []).map((o) => o.by)]);
  return toWorkspaceDto(w, ppl);
}

export function toWorkspaceTender(t: TenderRow): WorkspaceTender {
  return {
    id: t.id, bidNumber: t.bidNumber, title: t.title, bidType: t.bidType, category: t.category, quantity: t.quantity,
    ministry: t.ministry, department: t.department, organisation: t.organisation, buyerOffice: t.buyerOffice, state: t.state, city: t.city,
    startAt: iso(t.startAt), endAt: iso(t.endAt), emdAmount: t.emdAmount, estimatedValue: t.estimatedValue, status: t.status,
    sourceUrl: t.sourceUrl, documentUrl: t.documentUrl, items: t.items ?? [],
  };
}

export function toPacketDto(p: PacketRow, ppl: Map<string, PersonRef>): PacketDto {
  return {
    id: p.id, workspaceId: p.workspaceId, status: p.status, items: p.items as PacketDto['items'], warnings: p.warnings,
    sizeBytes: p.sizeBytes, pageCount: p.pageCount, createdBy: p.createdBy ? ppl.get(p.createdBy) ?? null : null,
    createdAt: iso(p.createdAt)!, downloadUrl: p.status === 'ready' && p.blobKey ? `/api/packets/${p.id}/download` : null,
  };
}

function toVaultDoc(d: VaultRow, now: Date): WorkspaceVaultDoc {
  const s = docStatus(d.expiryDate, now);
  return {
    id: d.id, type: d.type, title: d.title, fileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, pageCount: d.pageCount,
    expiryDate: d.expiryDate, financialYear: d.financialYear, tags: d.tags, status: s.status, daysToExpiry: s.daysToExpiry,
    downloadUrl: `/api/vault/${d.id}/download`,
  };
}

// ───────────── list (Kanban cards) ─────────────

export async function listWorkspaceCards(deps: AppDeps, org: string, filter: { stage?: string[]; mine?: string | null; q?: string | null }): Promise<WorkspaceCard[]> {
  const rows = await deps.db.select({ w: bidWorkspaces, t: tenders }).from(bidWorkspaces)
    .innerJoin(tenders, eq(tenders.id, bidWorkspaces.tenderId))
    .where(and(eq(bidWorkspaces.orgId, org), filter.stage?.length ? inArray(bidWorkspaces.stage, filter.stage as WorkspaceRow['stage'][]) : undefined))
    .orderBy(asc(bidWorkspaces.position), desc(bidWorkspaces.updatedAt));
  let list = rows;
  if (filter.mine) list = list.filter((r) => r.w.ownerId === filter.mine || (r.w.assigneeIds ?? []).includes(filter.mine!));
  if (filter.q) {
    const q = filter.q.toLowerCase();
    list = list.filter((r) => [r.t.title, r.t.bidNumber, r.t.organisation, r.t.ministry].some((s) => (s ?? '').toLowerCase().includes(q)));
  }
  if (!list.length) return [];
  const [an, docs, ppl, counts] = await Promise.all([
    latestAnalyses(deps, org, list.map((r) => r.t.id)),
    vaultRows(deps, org),
    people(deps, list.flatMap((r) => [r.w.ownerId, ...(r.w.assigneeIds ?? [])])),
    deps.db.select({ workspaceId: comments.workspaceId }).from(comments)
      .where(and(eq(comments.orgId, org), inArray(comments.workspaceId, list.map((r) => r.w.id)))),
  ]);
  const commentCount = new Map<string, number>();
  for (const c of counts) commentCount.set(c.workspaceId, (commentCount.get(c.workspaceId) ?? 0) + 1);
  const now = deps.clock.now();
  return list.map(({ w, t }) => {
    const a = an.get(t.id) ?? null;
    const r = readinessFor(w, a, docs, now);
    const dto = toWorkspaceDto(w, ppl);
    return {
      id: w.id, stage: w.stage, position: w.position, owner: dto.owner, assignees: dto.assignees, dueAt: dto.dueAt, updatedAt: dto.updatedAt,
      submittedAt: dto.submittedAt, outcome: dto.outcome,
      tender: {
        id: t.id, bidNumber: t.bidNumber, title: t.title, organisation: t.organisation, ministry: t.ministry, state: t.state,
        endAt: iso(t.endAt), emdAmount: t.emdAmount, estimatedValue: t.estimatedValue, status: t.status,
      },
      analysis: a ? { id: a.id, score: a.score, verdict: a.verdict, stale: a.stale } : null,
      readiness: { percent: r.percent, blockers: r.blockers.length, total: r.total, covered: r.covered, analysed: r.analysed },
      commentCount: commentCount.get(w.id) ?? 0,
    };
  });
}

// ───────────── templates & annexures ─────────────

export async function templatesFor(deps: AppDeps, org: string): Promise<AnnexureTemplateDto[]> {
  const rows = await deps.db.select().from(annexureTemplates)
    .where(or(eq(annexureTemplates.orgId, org), isNull(annexureTemplates.orgId)));
  const orgRows = new Map(rows.filter((r) => r.orgId === org).map((r) => [r.key, r]));
  return SYSTEM_TEMPLATES.map((t) => {
    const o = orgRows.get(t.key);
    const body = o?.body ?? t.body;
    return {
      key: t.key, title: o?.title ?? t.title, description: t.description, body, custom: !!o,
      systemTitle: t.title, systemBody: t.body, placeholders: placeholdersOf(body), updatedAt: o ? iso(o.updatedAt) : null,
    };
  });
}

export async function templateFor(deps: AppDeps, org: string, key: TemplateKey): Promise<{ title: string; body: string; signatureRole: string }> {
  const sys = SYSTEM_TEMPLATE_BY_KEY.get(key);
  if (!sys) throw notFound('Annexure template');
  const [o] = await deps.db.select().from(annexureTemplates).where(and(eq(annexureTemplates.orgId, org), eq(annexureTemplates.key, key)));
  return { title: o?.title ?? sys.title, body: o?.body ?? sys.body, signatureRole: sys.signatureRole };
}

export function templateContext(t: TenderRow, profile: ProfileRow | null, w: WorkspaceRow | null, now: Date): TemplateContext {
  return buildTemplateContext({ company: profile, tender: t, now, offer: w?.assistValues ?? {} });
}

/** Annexures relevant to a workspace: required ones from the checklist, then the always-useful extras. */
export function workspaceAnnexures(wsId: string, a: AnalysisRow | null, templates: AnnexureTemplateDto[], ctx: TemplateContext): WorkspaceAnnexure[] {
  const checklist = a?.checklist ?? [];
  const byKey = new Map(templates.map((t) => [t.key, t]));
  const out: WorkspaceAnnexure[] = [];
  const add = (key: string, itemId: string | null, required: boolean) => {
    const t = byKey.get(key as TemplateKey);
    if (!t || out.some((o) => o.key === key)) return;
    out.push({
      key: t.key, title: t.title, description: t.description, itemId, required, missing: missingPlaceholders(t.body, ctx),
      pdfUrl: `/api/workspaces/${wsId}/annexures/${t.key}.pdf`,
    });
  };
  add('bid_cover_letter', null, false);
  for (const i of checklist) if (i.generated) add(i.generated, i.id, i.mandatory);
  if (checklist.some((i) => i.docType === 'oem_authorization')) add('oem_auth_request', 'oem_authorization', false);
  add('technical_compliance', null, false);
  add('non_blacklisting', null, false);
  add('authority_letter', null, false);
  return out;
}

export async function renderAnnexure(deps: AppDeps, org: string, w: WorkspaceRow, key: TemplateKey, draft?: { title: string; body: string }): Promise<Uint8Array> {
  const [t, profile, tpl] = await Promise.all([getTenderRow(deps, w.tenderId), profileRow(deps, org), templateFor(deps, org, key)]);
  const ctx = templateContext(t, profile, w, deps.clock.now());
  return renderAnnexurePdf(draft?.title ?? tpl.title, draft?.body ?? tpl.body, ctx, { signatureRole: tpl.signatureRole });
}

// ───────────── packet ─────────────

/** cover → covering letter → required annexures → mapped documents (checklist order, de-duplicated). */
export function defaultPacketItems(r: Readiness, annexures: WorkspaceAnnexure[], docs: VaultRow[]): PacketItemInput[] {
  const items: PacketItemInput[] = [{ kind: 'cover', title: 'Cover page & index' }];
  const cover = annexures.find((a) => a.key === 'bid_cover_letter');
  if (cover) items.push({ kind: 'annexure', refId: cover.key, title: cover.title, pages: 1 });
  // Annexures the checklist asks for (the OEM request letter goes to the OEM, not into the packet).
  for (const a of annexures) if (a.itemId && a.key !== 'oem_auth_request') items.push({ kind: 'annexure', refId: a.key, title: a.title, pages: 1 });
  const byId = new Map(docs.map((d) => [d.id, d]));
  const seen = new Set<string>();
  for (const i of r.items) {
    if (!i.docId || seen.has(i.docId)) continue;
    const d = byId.get(i.docId);
    if (!d) continue;
    seen.add(d.id);
    items.push({ kind: 'vault', refId: d.id, title: i.item.label, pages: d.pageCount ?? undefined });
  }
  return items;
}

const PACKET_FILE = (bid: string) => `${bid.replace(/[^\w-]+/g, '_').replace(/_+/g, '_')}_technical_packet.pdf`;

export async function buildWorkspacePacket(deps: AppDeps, org: string, userIdValue: string, w: WorkspaceRow, requested?: PacketItemInput[]): Promise<PacketRow> {
  const [t, profile, a, docs, templates] = await Promise.all([
    getTenderRow(deps, w.tenderId), profileRow(deps, org), latestAnalysis(deps, org, w.tenderId), vaultRows(deps, org), templatesFor(deps, org),
  ]);
  const now = deps.clock.now();
  const ctx = templateContext(t, profile, w, now);
  const r = readinessFor(w, a, docs, now);
  const annexures = workspaceAnnexures(w.id, a, templates, ctx);
  const items = requested?.length ? requested : defaultPacketItems(r, annexures, docs);

  // Validate references up front (org-scoped) so a bad id is a 400, not a silent skip.
  const vaultById = new Map(docs.map((d) => [d.id, d]));
  const tenderDocIds = items.filter((i) => i.kind === 'tender_doc').map((i) => i.refId!).filter(Boolean);
  const tdocs = tenderDocIds.length && tenderDocIds.every((x) => UUID_RE.test(x))
    ? await deps.db.select().from(tenderDocuments).where(and(
      eq(tenderDocuments.tenderId, t.id), inArray(tenderDocuments.id, tenderDocIds),
      or(isNull(tenderDocuments.orgId), eq(tenderDocuments.orgId, org)),
    ))
    : [];
  const tdocById = new Map(tdocs.map((d) => [d.id, d]));
  const bad: string[] = [];
  for (const i of items) {
    if (i.kind === 'vault' && !(i.refId && vaultById.has(i.refId))) bad.push(i.title);
    if (i.kind === 'annexure' && !(i.refId && SYSTEM_TEMPLATE_BY_KEY.has(i.refId))) bad.push(i.title);
    if (i.kind === 'tender_doc' && !(i.refId && tdocById.has(i.refId))) bad.push(i.title);
  }
  if (bad.length) throw new HttpError(400, 'validation_error', `Unknown packet item(s): ${bad.join(', ')}`, { items: bad });

  const [row] = await deps.db.insert(packets).values({
    orgId: org, workspaceId: w.id, status: 'building', items: items.map((i) => ({ kind: i.kind, refId: i.refId, title: i.title, pages: i.pages })),
    createdBy: userIdValue,
  }).returning();

  const templatesByKey = new Map(templates.map((tp) => [tp.key, tp]));
  const loadBytes = async (it: BuildItem): Promise<Uint8Array | null> => {
    if (it.kind === 'annexure') {
      const tp = templatesByKey.get(it.refId as TemplateKey)!;
      return renderAnnexurePdf(tp.title, tp.body, ctx, { signatureRole: SYSTEM_TEMPLATE_BY_KEY.get(tp.key)?.signatureRole });
    }
    const key = it.kind === 'vault' ? vaultById.get(it.refId!)?.blobKey : tdocById.get(it.refId!)?.blobKey;
    if (!key) return null;
    const obj = await deps.blobs.get(key);
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  };

  try {
    const built = await buildPacket({
      items, loadBytes, now, tender: { bidNumber: t.bidNumber, title: t.title, organisation: t.organisation, ministry: t.ministry, endAt: t.endAt },
      company: profile ? { legalName: profile.legalName, gstin: profile.gstin, pan: profile.pan, address: profile.address, state: profile.state } : null,
    });
    // Warn about expired / missing documents that are part of the bid (FR-023, US4 scenario 2).
    const warnings = [...built.warnings];
    for (const b of r.blockers) warnings.push(`${b.label}: ${b.state === 'expired' ? 'the vault document has expired' : 'no document in the vault'} — replace it or ask a Bid Manager to override.`);
    for (const it of items) {
      const d = it.kind === 'vault' ? vaultById.get(it.refId!) : undefined;
      if (d && docStatus(d.expiryDate, now).status === 'expired') warnings.push(`"${it.title}" uses an expired document (${d.title}).`);
    }
    const blobKey = `org/${org}/packets/${row.id}/${PACKET_FILE(t.bidNumber)}`;
    await deps.blobs.put(blobKey, built.bytes, { contentType: 'application/pdf' });
    const [done] = await deps.db.update(packets).set({
      status: 'ready', blobKey, sizeBytes: built.bytes.length, pageCount: built.pageCount, warnings: [...new Set(warnings)],
      items: built.items.map((b) => ({ kind: b.kind, refId: b.refId, title: b.title, pages: b.pages, startPage: b.startPage, included: b.included })) as PacketRow['items'],
    }).where(eq(packets.id, row.id)).returning();
    return done;
  } catch (e) {
    deps.logger.error('packet build failed', { packetId: row.id, error: (e as Error).message });
    const [failed] = await deps.db.update(packets).set({ status: 'failed', warnings: [`Build failed: ${(e as Error).message}`] }).where(eq(packets.id, row.id)).returning();
    return failed;
  }
}

// ───────────── detail ─────────────

export async function listComments(deps: AppDeps, org: string, wsId: string): Promise<CommentDto[]> {
  const rows = await deps.db.select({ c: comments, u: { id: users.id, name: users.name, email: users.email } }).from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .where(and(eq(comments.orgId, org), eq(comments.workspaceId, wsId))).orderBy(asc(comments.createdAt));
  return rows.map(({ c, u }) => ({ id: c.id, body: c.body, user: u, createdAt: iso(c.createdAt)! }));
}

export async function workspaceActivity(deps: AppDeps, org: string, w: WorkspaceRow, limit = 50): Promise<ActivityItem[]> {
  const rows = await deps.db.select({ a: activityLog, u: { id: users.id, name: users.name } }).from(activityLog)
    .leftJoin(users, eq(users.id, activityLog.userId))
    .where(and(eq(activityLog.orgId, org), or(
      and(eq(activityLog.entityType, 'workspace'), eq(activityLog.entityId, w.id)),
      and(eq(activityLog.entityType, 'tender'), eq(activityLog.entityId, w.tenderId)),
    ))).orderBy(desc(activityLog.createdAt)).limit(limit);
  return rows.map(({ a, u }) => ({
    id: a.id, user: u?.id ? { id: u.id, name: u.name } : null, action: a.action, entityType: a.entityType, entityId: a.entityId,
    meta: a.meta, createdAt: iso(a.createdAt)!,
  }));
}

export async function workspaceDetail(deps: AppDeps, org: string, w: WorkspaceRow): Promise<WorkspaceDetail> {
  const [t, a, docs, profile, templates, packetRows, cmts, activity, members, tdocs] = await Promise.all([
    getTenderRow(deps, w.tenderId), latestAnalysis(deps, org, w.tenderId), vaultRows(deps, org), profileRow(deps, org), templatesFor(deps, org),
    deps.db.select().from(packets).where(and(eq(packets.orgId, org), eq(packets.workspaceId, w.id))).orderBy(desc(packets.createdAt)).limit(20),
    listComments(deps, org, w.id), workspaceActivity(deps, org, w), orgMembers(deps, org),
    deps.db.select().from(tenderDocuments).where(and(eq(tenderDocuments.tenderId, w.tenderId), or(isNull(tenderDocuments.orgId), eq(tenderDocuments.orgId, org)))).orderBy(asc(tenderDocuments.createdAt)),
  ]);
  const now = deps.clock.now();
  const ppl = await people(deps, [w.ownerId, ...(w.assigneeIds ?? []), ...(w.overrides ?? []).map((o) => o.by), ...packetRows.map((p) => p.createdBy)]);
  const ctx = templateContext(t, profile, w, now);
  const r = readinessFor(w, a, docs, now);
  const annexures = workspaceAnnexures(w.id, a, templates, ctx);
  const gaps = new Set<string>();
  for (const an of annexures) if (an.required || an.key === 'bid_cover_letter') for (const m of an.missing) gaps.add(m);
  return {
    workspace: toWorkspaceDto(w, ppl),
    tender: toWorkspaceTender(t),
    analysis: a ? toAnalysisDto(a) : null,
    readiness: r,
    annexures,
    packets: packetRows.map((p) => toPacketDto(p, ppl)),
    comments: cmts,
    activity,
    vaultDocs: docs.map((d) => toVaultDoc(d, now)),
    tenderDocs: tdocs.map((d) => ({ id: d.id, kind: d.kind, fileName: d.fileName, pageCount: d.pageCount, sizeBytes: d.sizeBytes, downloadUrl: `/api/tenders/${d.tenderId}/documents/${d.id}/download` })),
    members,
    defaultPacketItems: defaultPacketItems(r, annexures, docs),
    profileGaps: [...gaps].sort(),
  };
}
