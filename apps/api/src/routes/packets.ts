/**
 * Annexure templates, annexure PDFs and bid packets (T061–T063; FR-024, FR-025). Owned by the Apply team.
 *
 *   GET    /annexure-templates                      system templates merged with org overrides       viewer+
 *   PUT    /annexure-templates/:key                 { title, body } org override                      bid_manager+
 *   DELETE /annexure-templates/:key                 reset to the system template                      bid_manager+
 *   GET    /workspaces/:id/annexures/:key.pdf       rendered annexure (?download=1 for attachment)    viewer+
 *   POST   /workspaces/:id/annexures/:key/preview   { title, body } → draft PDF (template editor)     analyst+
 *   GET    /workspaces/:id/packets                  packet history                                     viewer+
 *   POST   /workspaces/:id/packets                  { items? } → build merged PDF → PacketDto (201)   analyst+
 *   GET    /packets/:id/download                    merged PDF (?inline=1)                             viewer+
 */
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { annexureTemplates, bidWorkspaces, packets } from '@tp/db';
import { annexureTemplateInputSchema, packetBuildSchema } from '@tp/core/contracts/apply';
import { normalizeTemplateKey, unknownPlaceholderMessage, unknownPlaceholders, type TemplateKey } from '@tp/core/packet/templates';
import { logActivity } from '../lib/activity';
import { HttpError, badRequest, notFound } from '../lib/errors';
import { contentDisposition } from '../lib/http';
import { parseJson, parseWith } from '../lib/validate';
import { orgId, requireAuth, requireRole, userId } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { assertPacketItemCount, buildWorkspacePacket, getTenderRow, recoverStuckPackets, getWorkspace, people, renderAnnexure, templatesFor, toPacketDto } from '../services/packet';
import type { AppEnv } from '../types';

export const packetsRoutes = new Hono<AppEnv>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function keyParam(raw: string): TemplateKey {
  const k = normalizeTemplateKey(raw.replace(/\.pdf$/i, ''));
  if (!k) throw notFound('Annexure template');
  return k;
}

const pdfResponse = (bytes: Uint8Array, fileName: string, download: boolean) =>
  new Response(bytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(bytes.length),
      'content-disposition': contentDisposition(download ? 'attachment' : 'inline', fileName),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });

/** FR-041: refuse bodies with placeholders outside the supported context paths. */
function assertKnownPlaceholders(body: string) {
  const unknown = unknownPlaceholders(body);
  if (unknown.length) throw new HttpError(400, 'unknown_placeholder', unknownPlaceholderMessage(unknown), { unknown });
}

// ───────────── templates ─────────────

packetsRoutes.get('/annexure-templates', requireAuth, async (c) => {
  const items = await templatesFor(c.var.deps, orgId(c));
  return c.json({ items, total: items.length });
});

packetsRoutes.put('/annexure-templates/:key', requireRole('bid_manager'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const key = keyParam(c.req.param('key'));
  const body = await parseJson(c, annexureTemplateInputSchema);
  assertKnownPlaceholders(body.body);
  const now = deps.clock.now();
  const [existing] = await deps.db.select().from(annexureTemplates).where(and(eq(annexureTemplates.orgId, org), eq(annexureTemplates.key, key)));
  if (existing) await deps.db.update(annexureTemplates).set({ title: body.title, body: body.body, updatedAt: now }).where(eq(annexureTemplates.id, existing.id));
  else await deps.db.insert(annexureTemplates).values({ orgId: org, key, title: body.title, body: body.body, createdAt: now, updatedAt: now });
  await logActivity(deps.db, { orgId: org, userId: userId(c), action: 'annexure.template_updated', entityType: 'annexure_template', entityId: key, meta: { title: body.title } });
  const items = await templatesFor(deps, org);
  return c.json(items.find((t) => t.key === key));
});

packetsRoutes.delete('/annexure-templates/:key', requireRole('bid_manager'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const key = keyParam(c.req.param('key'));
  await deps.db.delete(annexureTemplates).where(and(eq(annexureTemplates.orgId, org), eq(annexureTemplates.key, key)));
  await logActivity(deps.db, { orgId: org, userId: userId(c), action: 'annexure.template_reset', entityType: 'annexure_template', entityId: key });
  const items = await templatesFor(deps, org);
  return c.json(items.find((t) => t.key === key));
});

// ───────────── annexure PDFs ─────────────

packetsRoutes.get('/workspaces/:id/annexures/:file', requireAuth, async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const w = await getWorkspace(deps, org, c.req.param('id'));
  const key = keyParam(c.req.param('file'));
  const [bytes, t] = await Promise.all([renderAnnexure(deps, org, w, key), getTenderRow(deps, w.tenderId)]);
  const name = `${key}_${t.bidNumber.replace(/[^\w-]+/g, '_')}.pdf`;
  return pdfResponse(bytes, name, c.req.query('download') === '1');
});

packetsRoutes.post('/workspaces/:id/annexures/:key/preview', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const w = await getWorkspace(deps, org, c.req.param('id'));
  const key = keyParam(c.req.param('key'));
  const draft = await parseJson(c, annexureTemplateInputSchema);
  assertKnownPlaceholders(draft.body);
  const bytes = await renderAnnexure(deps, org, w, key, draft);
  return pdfResponse(bytes, `${key}_preview.pdf`, false);
});

// ───────────── packets ─────────────

packetsRoutes.get('/workspaces/:id/packets', requireAuth, async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const w = await getWorkspace(deps, org, c.req.param('id'));
  await recoverStuckPackets(deps, org, w.id);
  const rows = await deps.db.select().from(packets).where(and(eq(packets.orgId, org), eq(packets.workspaceId, w.id))).orderBy(desc(packets.createdAt)).limit(50);
  const ppl = await people(deps, rows.map((r) => r.createdBy));
  return c.json({ items: rows.map((r) => toPacketDto(r, ppl)), total: rows.length });
});

packetsRoutes.post('/workspaces/:id/packets', requireRole('analyst'), rateLimit('packet.org'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const w = await getWorkspace(deps, org, c.req.param('id'));
  // 008/FR-032: > 40 items is a 413 packet_too_large (not a 400), so count before the schema caps the array.
  // The body is read and parsed once (review N2); invalid JSON is the usual 400.
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  const peek = raw as { items?: unknown } | null;
  if (Array.isArray(peek?.items)) assertPacketItemCount(peek.items.length);
  const body = parseWith(packetBuildSchema, raw, 'body');
  const p = await buildWorkspacePacket(deps, org, userId(c), w, body.items);
  await logActivity(deps.db, {
    orgId: org, userId: userId(c), action: p.status === 'ready' ? 'workspace.packet_built' : 'workspace.packet_failed', entityType: 'workspace', entityId: w.id,
    meta: { tenderId: w.tenderId, packetId: p.id, pageCount: p.pageCount, sizeBytes: p.sizeBytes, warnings: p.warnings.length },
  });
  // Building a packet moves an early-stage bid into "Preparing".
  if (p.status === 'ready' && (w.stage === 'identified' || w.stage === 'analysing' || w.stage === 'go')) {
    await deps.db.update(bidWorkspaces).set({ stage: 'preparing', updatedAt: deps.clock.now() }).where(and(eq(bidWorkspaces.orgId, org), eq(bidWorkspaces.id, w.id)));
    await logActivity(deps.db, { orgId: org, userId: userId(c), action: 'workspace.stage_changed', entityType: 'workspace', entityId: w.id, meta: { tenderId: w.tenderId, from: w.stage, to: 'preparing', auto: true } });
  }
  const ppl = await people(deps, [p.createdBy]);
  const dto = toPacketDto(p, ppl);
  if (p.status !== 'ready') throw new HttpError(500, 'packet_build_failed', p.warnings[0] ?? 'The packet could not be built. Try again.', { packet: dto });
  return c.json(dto, 201);
});

packetsRoutes.get('/packets/:id/download', requireAuth, async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) throw notFound('Packet');
  const [p] = await deps.db.select().from(packets).where(and(eq(packets.orgId, org), eq(packets.id, id)));
  if (!p || !p.blobKey || p.status !== 'ready') throw notFound('Packet');
  const obj = await deps.blobs.get(p.blobKey);
  if (!obj) throw notFound('Packet file');
  const name = p.blobKey.split('/').pop() ?? 'packet.pdf';
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(obj.size),
      'content-disposition': contentDisposition(c.req.query('inline') === '1' ? 'inline' : 'attachment', name),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});

