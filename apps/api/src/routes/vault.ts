/**
 * Document vault (T052; FR-021). Owned by the Vault team. Files live in private blob storage under
 * `org/<orgId>/vault/<uuid>/<filename>` and are only served through these authorised routes
 * (Constitution IV).
 *
 *   GET    /vault                 ?type&status&category&q&sort → { items, total }        viewer+
 *   GET    /vault/summary         → VaultSummary                                         viewer+
 *   POST   /vault                 multipart file + metadata → VaultDocumentDto (201)     analyst+
 *   GET    /vault/:id             → VaultDocumentDto                                     viewer+
 *   PATCH  /vault/:id             metadata → VaultDocumentDto                            analyst+
 *   PUT    /vault/:id/file        multipart file — replace the file, keep metadata       analyst+
 *   DELETE /vault/:id             removes the row and the blob, unlinks CRAC + OEM refs   analyst+
 *   GET    /vault/:id/download    streams the file (?inline=1 for preview)               viewer+
 *   POST   /vault/reminders/run   run expiry reminders for this org now → {documents, notifications}  bid_manager+ (FR-052)
 */
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { PDFDocument } from 'pdf-lib';
import { companyProfiles, pastContracts, users, vaultDocuments } from '@tp/db';
import { uuidSchema } from '@tp/core/contracts/common';
import {
  VAULT_MAX_BYTES, vaultQuerySchema, vaultUpdateSchema, vaultUploadFieldsSchema, type VaultDocumentDto, type VaultSummary,
} from '@tp/core/contracts/vault';
import { DOC_TYPES, docStatus, EXPIRING_WITHIN_DAYS, guessDocType, guessFinancialYear, nextReminder, type DocType } from '@tp/core/vault/status';
import type { AppDeps } from '../deps';
import { logActivity } from '../lib/activity';
import { runExpiryReminders } from '../services/reminders';
import { badRequest, HttpError, notFound, validationError } from '../lib/errors';
import { parseQuery, parseWith } from '../lib/validate';
import { orgId, requireAuth, requireRole, userId } from '../middleware/auth';
import type { AppEnv } from '../types';

export const vaultRoutes = new Hono<AppEnv>();

type VaultRow = typeof vaultDocuments.$inferSelect;

// ───────────── helpers ─────────────

/** Detect the real file type from magic bytes (never trust the client's content-type). */
export function sniffMime(bytes: Uint8Array): 'application/pdf' | 'image/png' | 'image/jpeg' | null {
  const head = bytes.subarray(0, 1024);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // %PDF may be preceded by junk bytes in the first 1 KB (allowed by the spec).
  for (let i = 0; i + 4 < head.length; i++) if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46) return 'application/pdf';
  return null;
}

export function safeFileName(name: string, mime: string): string {
  const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
  // Keep letters/digits of any script (e.g. Devanagari "प्रमाणपत्र.pdf") so downloads keep the original name (FR-030).
  let base = (name.split(/[\\/]/).pop() ?? '').normalize('NFC').replace(/[^\p{L}\p{M}\p{N}_.\- ()&]+/gu, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  base = base.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return `${base || 'document'}.${ext}`;
}

const titleFromFileName = (name: string) =>
  (name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').replace(/(?<!\d)(20\d{2}) (\d{2})(?!\d)/, '$1-$2').trim() || 'Untitled document').slice(0, 200);

async function readFile(c: Context<AppEnv>): Promise<{ body: Record<string, string | File>; file: { name: string; bytes: Uint8Array; mime: 'application/pdf' | 'image/png' | 'image/jpeg' }; pageCount: number | null }> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > VAULT_MAX_BYTES + 64 * 1024) throw new HttpError(413, 'payload_too_large', 'Files can be at most 20 MB. Compress the scan or split it and try again.');
  let body: Record<string, string | File>;
  try {
    body = await c.req.parseBody();
  } catch {
    throw badRequest('Send the document as multipart/form-data with a "file" field');
  }
  const f = body.file;
  if (!f || typeof f === 'string') throw validationError('file: Choose a file to upload', { fields: { file: 'Choose a PDF, PNG or JPG file' } });
  const bytes = new Uint8Array(await f.arrayBuffer());
  if (bytes.length === 0) throw validationError('file: The file is empty', { fields: { file: 'The file is empty' } });
  if (bytes.length > VAULT_MAX_BYTES) throw new HttpError(413, 'payload_too_large', 'Files can be at most 20 MB. Compress the scan or split it and try again.');
  const mime = sniffMime(bytes);
  if (!mime) throw new HttpError(415, 'unsupported_media_type', 'Only PDF, PNG and JPG files can be stored in the vault.');
  let pageCount: number | null = 1;
  if (mime === 'application/pdf') {
    try {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
      pageCount = pdf.getPageCount();
    } catch {
      throw new HttpError(422, 'unreadable_pdf', 'This PDF looks damaged and could not be opened. Re-export or re-scan it and try again.');
    }
  }
  return { body, file: { name: f.name || 'document', bytes, mime }, pageCount };
}

const blobKeyFor = (org: string, docId: string, fileName: string) => `org/${org}/vault/${docId}/${fileName}`;

export function toVaultDto(r: VaultRow, now: Date, uploader?: { id: string; name: string } | null): VaultDocumentDto {
  const s = docStatus(r.expiryDate, now);
  return {
    id: r.id, type: r.type, title: r.title, number: r.number, issuer: r.issuer, issueDate: r.issueDate, expiryDate: r.expiryDate,
    financialYear: r.financialYear, tags: r.tags, fileName: r.fileName, mimeType: r.mimeType, sizeBytes: r.sizeBytes, pageCount: r.pageCount,
    uploadedBy: uploader ?? null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    status: s.status, daysToExpiry: s.daysToExpiry,
    nextReminder: nextReminder(r.expiryDate, r.lastReminderDays, now), downloadUrl: `/api/vault/${r.id}/download`,
  };
}

async function uploaders(deps: AppDeps, rows: VaultRow[]): Promise<Map<string, { id: string; name: string }>> {
  const ids = [...new Set(rows.map((r) => r.uploadedBy).filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const us = await deps.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return new Map(us.map((u) => [u.id, u]));
}

async function getDoc(deps: AppDeps, org: string, rawId: string): Promise<VaultRow> {
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw notFound('Document');
  const [row] = await deps.db.select().from(vaultDocuments).where(and(eq(vaultDocuments.orgId, org), eq(vaultDocuments.id, id.data)));
  if (!row) throw notFound('Document');
  return row;
}

async function dto(deps: AppDeps, row: VaultRow): Promise<VaultDocumentDto> {
  const u = await uploaders(deps, [row]);
  return toVaultDto(row, deps.clock.now(), row.uploadedBy ? u.get(row.uploadedBy) : null);
}

/** Vault docs of an org with derived status — used by other modules (dashboard, packets). */
export async function listVault(deps: AppDeps, org: string): Promise<VaultDocumentDto[]> {
  const rows = await deps.db.select().from(vaultDocuments).where(eq(vaultDocuments.orgId, org)).orderBy(desc(vaultDocuments.createdAt));
  const u = await uploaders(deps, rows);
  const now = deps.clock.now();
  return rows.map((r) => toVaultDto(r, now, r.uploadedBy ? u.get(r.uploadedBy) : null));
}

export async function vaultSummary(deps: AppDeps, org: string): Promise<VaultSummary> {
  const rows = await deps.db.select({ id: vaultDocuments.id, type: vaultDocuments.type, title: vaultDocuments.title, expiryDate: vaultDocuments.expiryDate })
    .from(vaultDocuments).where(eq(vaultDocuments.orgId, org));
  const now = deps.clock.now();
  const out: VaultSummary = { total: rows.length, valid: 0, expiring: 0, expired: 0, byType: {}, nextExpiries: [], missingCommon: [] };
  for (const r of rows) {
    const s = docStatus(r.expiryDate, now);
    out[s.status]++;
    out.byType[r.type] = (out.byType[r.type] ?? 0) + 1;
    if (r.expiryDate && s.daysToExpiry != null && s.daysToExpiry >= -EXPIRING_WITHIN_DAYS && s.daysToExpiry <= 90) {
      out.nextExpiries.push({ id: r.id, type: r.type, title: r.title, expiryDate: r.expiryDate, daysToExpiry: s.daysToExpiry, status: s.status });
    }
  }
  out.nextExpiries.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  out.nextExpiries = out.nextExpiries.slice(0, 20);
  out.missingCommon = DOC_TYPES.filter((d) => d.commonInBids && !out.byType[d.type]).map((d) => d.type);
  return out;
}

// ───────────── routes ─────────────

vaultRoutes.get('/vault', requireAuth, async (c) => {
  const q = parseQuery(c, vaultQuerySchema);
  const org = orgId(c);
  const conds: SQL[] = [eq(vaultDocuments.orgId, org)];
  if (q.type) conds.push(eq(vaultDocuments.type, q.type));
  if (q.category) {
    const types = DOC_TYPES.filter((d) => d.category === q.category).map((d) => d.type);
    conds.push(inArray(vaultDocuments.type, types));
  }
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conds.push(or(ilike(vaultDocuments.title, like), ilike(vaultDocuments.number, like), ilike(vaultDocuments.issuer, like),
      ilike(vaultDocuments.fileName, like), sql`${vaultDocuments.tags}::text ilike ${like}`)!);
  }
  const rows = await c.var.deps.db.select().from(vaultDocuments).where(and(...conds)).orderBy(desc(vaultDocuments.createdAt)).limit(2000);
  const now = c.var.deps.clock.now();
  const u = await uploaders(c.var.deps, rows);
  let items = rows.map((r) => toVaultDto(r, now, r.uploadedBy ? u.get(r.uploadedBy) : null));
  if (q.status) items = items.filter((d) => d.status === q.status);
  if (q.sort === 'expiry') items.sort((a, b) => (a.daysToExpiry ?? Infinity) - (b.daysToExpiry ?? Infinity));
  else if (q.sort === 'title') items.sort((a, b) => a.title.localeCompare(b.title));
  else if (q.sort === 'type') items.sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));
  return c.json({ items, total: items.length });
});

vaultRoutes.get('/vault/summary', requireAuth, async (c) => c.json(await vaultSummary(c.var.deps, orgId(c))));

/** Manual "Send reminders now" (FR-052): same job as the scheduler tick, scoped to the caller's org; idempotent. */
vaultRoutes.post('/vault/reminders/run', requireRole('bid_manager'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const report = await runExpiryReminders(deps, { orgId: org });
  await logActivity(deps.db, { orgId: org, userId: userId(c), action: 'vault.reminders_run', entityType: 'vault_document', meta: { ...report } });
  return c.json(report);
});

vaultRoutes.post('/vault', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const { body, file, pageCount } = await readFile(c);
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
  const meta = parseWith(vaultUploadFieldsSchema, {
    type: str('type') || guessDocType(file.name),
    title: str('title'),
    number: str('number'), issuer: str('issuer'), issueDate: str('issueDate'), expiryDate: str('expiryDate'),
    financialYear: str('financialYear') ?? guessFinancialYear(file.name) ?? undefined,
    tags: str('tags'),
  }, 'form');
  const id = crypto.randomUUID();
  const fileName = safeFileName(file.name, file.mime);
  const blobKey = blobKeyFor(org, id, fileName);
  await deps.blobs.put(blobKey, file.bytes, { contentType: file.mime });
  let row: VaultRow;
  try {
    [row] = (await deps.db.insert(vaultDocuments).values({
      id, orgId: org, type: meta.type as DocType, title: meta.title ?? titleFromFileName(file.name), number: meta.number ?? null,
      issuer: meta.issuer ?? null, issueDate: meta.issueDate ?? null, expiryDate: meta.expiryDate ?? null,
      financialYear: meta.financialYear ?? null, tags: meta.tags ?? [], blobKey, fileName, mimeType: file.mime,
      sizeBytes: file.bytes.length, pageCount, uploadedBy: userId(c),
    }).returning()) as [VaultRow];
  } catch (e) {
    await deps.blobs.delete(blobKey).catch(() => {});
    throw e;
  }
  await logActivity(deps.db, { orgId: org, userId: userId(c), action: 'vault.uploaded', entityType: 'vault_document', entityId: id, meta: { type: row.type, title: row.title, fileName } });
  return c.json(await dto(deps, row), 201);
});

vaultRoutes.get('/vault/:id', requireAuth, async (c) => c.json(await dto(c.var.deps, await getDoc(c.var.deps, orgId(c), c.req.param('id')))));

vaultRoutes.patch('/vault/:id', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const existing = await getDoc(deps, org, c.req.param('id'));
  let raw: unknown;
  try { raw = JSON.parse((await c.req.text()) || '{}'); } catch { throw badRequest('Request body must be valid JSON'); }
  const input = parseWith(vaultUpdateSchema, raw, 'body');
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<VaultRow>;
  const issue = patch.issueDate !== undefined ? patch.issueDate : existing.issueDate;
  const expiry = patch.expiryDate !== undefined ? patch.expiryDate : existing.expiryDate;
  if (issue && expiry && expiry < issue) throw validationError('expiryDate: Expiry date is before the issue date', { fields: { expiryDate: 'Expiry date is before the issue date' } });
  // A renewed expiry date restarts the 30/7/1 reminder cycle.
  if (patch.expiryDate !== undefined && patch.expiryDate !== existing.expiryDate) patch.lastReminderDays = null;
  const [row] = await deps.db.update(vaultDocuments).set({ ...patch, updatedAt: deps.clock.now() })
    .where(and(eq(vaultDocuments.orgId, org), eq(vaultDocuments.id, existing.id))).returning();
  await logActivity(deps.db, { orgId: org, userId: userId(c), action: 'vault.updated', entityType: 'vault_document', entityId: existing.id, meta: { fields: Object.keys(input) } });
  return c.json(await dto(deps, row!));
});

vaultRoutes.put('/vault/:id/file', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const existing = await getDoc(deps, org, c.req.param('id'));
  const { file, pageCount } = await readFile(c);
  const fileName = safeFileName(file.name, file.mime);
  const blobKey = blobKeyFor(org, existing.id, fileName);
  await deps.blobs.put(blobKey, file.bytes, { contentType: file.mime });
  const [row] = await deps.db.update(vaultDocuments).set({
    blobKey, fileName, mimeType: file.mime, sizeBytes: file.bytes.length, pageCount, uploadedBy: userId(c), updatedAt: deps.clock.now(),
  }).where(and(eq(vaultDocuments.orgId, org), eq(vaultDocuments.id, existing.id))).returning();
  if (existing.blobKey !== blobKey) await deps.blobs.delete(existing.blobKey).catch(() => {});
  await logActivity(deps.db, { orgId: org, userId: userId(c), action: 'vault.file_replaced', entityType: 'vault_document', entityId: existing.id, meta: { fileName } });
  return c.json(await dto(deps, row!));
});

vaultRoutes.delete('/vault/:id', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const existing = await getDoc(deps, org, c.req.param('id'));
  await deps.db.update(pastContracts).set({ cracDocumentId: null }).where(and(eq(pastContracts.orgId, org), eq(pastContracts.cracDocumentId, existing.id)));
  // FR-041: unlink profile OEM authorisations pointing at this document (one statement, order preserved).
  await deps.db.update(companyProfiles).set({
    oemAuthorizations: sql`(select coalesce(jsonb_agg(case when e->>'documentId' = ${existing.id} then jsonb_set(e, '{documentId}', 'null'::jsonb) else e end order by i), '[]'::jsonb)
      from jsonb_array_elements(${companyProfiles.oemAuthorizations}) with ordinality as t(e, i))`,
  }).where(and(eq(companyProfiles.orgId, org), sql`${companyProfiles.oemAuthorizations} @> ${JSON.stringify([{ documentId: existing.id }])}::jsonb`));
  await deps.db.delete(vaultDocuments).where(and(eq(vaultDocuments.orgId, org), eq(vaultDocuments.id, existing.id)));
  await deps.blobs.delete(existing.blobKey).catch((e) => deps.logger.warn('vault blob delete failed', { key: existing.blobKey, error: String(e) }));
  await logActivity(deps.db, { orgId: org, userId: userId(c), action: 'vault.deleted', entityType: 'vault_document', entityId: existing.id, meta: { type: existing.type, title: existing.title } });
  return c.json({ ok: true as const });
});

vaultRoutes.get('/vault/:id/download', requireAuth, async (c) => {
  const doc = await getDoc(c.var.deps, orgId(c), c.req.param('id'));
  const obj = await c.var.deps.blobs.get(doc.blobKey);
  if (!obj) throw notFound('Document file');
  const inline = c.req.query('inline') === '1';
  const ascii = doc.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return new Response(obj.body, {
    headers: {
      'content-type': doc.mimeType || obj.contentType || 'application/octet-stream',
      'content-length': String(obj.size),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
