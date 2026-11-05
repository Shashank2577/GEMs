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
 *   PUT    /vault/:id/file        multipart file (+ issueDate, expiryDate, number) — replace/renew;
 *                                 the previous file becomes a version (max 5)             analyst+ (FR-064, FR-065)
 *   DELETE /vault/:id             removes the row, its versions and all blobs, unlinks CRAC + OEM refs   analyst+
 *   GET    /vault/:id/download    streams the file (?inline=1 for preview)               viewer+
 *   GET    /vault/:id/versions    previous files, newest first → { items }               viewer+ (FR-066)
 *   GET    /vault/:id/versions/:versionId/download   streams a previous file             viewer+ (FR-066)
 *
 * POST and PUT …/file reject a file whose SHA-256 matches another document of the org with 409
 * `duplicate_document {existingId,title}` unless `allowDuplicate=1` is sent (FR-067). Web Crypto only (NFR-010).
 *   POST   /vault/reminders/run   run expiry reminders for this org now → {documents, notifications}  bid_manager+ (FR-052)
 */
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { PDFDocument } from 'pdf-lib';
import { companyProfiles, pastContracts, users, vaultDocuments, vaultDocumentVersions } from '@tp/db';
import { uuidSchema } from '@tp/core/contracts/common';
import {
  VAULT_MAX_BYTES, VAULT_MAX_VERSIONS, vaultQuerySchema, vaultUpdateSchema, vaultUploadFieldsSchema,
  type VaultDocumentDto, type VaultSummary, type VaultVersionDto,
} from '@tp/core/contracts/vault';
import { DOC_TYPES, docStatus, EXPIRING_WITHIN_DAYS, guessDocType, guessFinancialYear, nextReminder, type DocType } from '@tp/core/vault/status';
import type { AppDeps } from '../deps';
import { logActivity } from '../lib/activity';
import { assertWithinPlan } from '../lib/plan';
import { runExpiryReminders } from '../services/reminders';
import { badRequest, HttpError, notFound, validationError } from '../lib/errors';
import { parseQuery, parseWith } from '../lib/validate';
import { orgId, requireAuth, requireRole, userId } from '../middleware/auth';
import { VAULT_TOO_LARGE, VAULT_UPLOAD_MAX_BYTES, bodyLimit } from '../middleware/body-limit';
import { rateLimit } from '../middleware/rate-limit';
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

/** UTF-8 byte budget for the stored base name: well under the 255-byte file-name limit of common filesystems. */
const BASE_MAX_BYTES = 180;
const utf8 = new TextEncoder();

/** Cut to at most `max` UTF-8 bytes on a grapheme (or at least code-point) boundary — never a split surrogate. */
function truncateUtf8(s: string, max: number): string {
  if (utf8.encode(s).length <= max) return s;
  const parts = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment)
    : Array.from(s);
  let out = '';
  let bytes = 0;
  for (const g of parts) {
    const n = utf8.encode(g).length;
    if (bytes + n > max) break;
    out += g;
    bytes += n;
  }
  return out;
}

/**
 * Stored file name: last path segment, NFC, letters/marks/digits of any script plus `_ . - ( ) &` and
 * spaces (control and bidi characters such as CR/LF or U+202E become `_`), no leading dots, base at most
 * 180 UTF-8 bytes, extension from the sniffed type. Keeps "प्रमाणपत्र.pdf" readable on download (FR-030).
 */
export function safeFileName(name: string, mime: string): string {
  const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
  let base = (name.split(/[\\/]/).pop() ?? '').normalize('NFC').replace(/[^\p{L}\p{M}\p{N}_.\- ()&]+/gu, '_').replace(/\s+/g, ' ').trim();
  base = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/^[.\s]+/, '');
  base = truncateUtf8(base, BASE_MAX_BYTES).trim();
  return `${base || 'document'}.${ext}`;
}

/** `content-disposition` value with an ASCII `filename` fallback and an RFC 8187 `filename*` (FR-030). */
export function contentDisposition(fileName: string, inline: boolean): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot + 1) : 'pdf';
  let ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  if (!/[A-Za-z0-9]/.test(dot > 0 ? ascii.slice(0, ascii.lastIndexOf('.')) : ascii)) ascii = `document.${ext}`;
  const star = encodeURIComponent(fileName).replace(/[()'*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${star}`;
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
/** Replacement files get a unique key so they can never overwrite a kept version (FR-065). */
const replacementBlobKey = (org: string, docId: string, fileName: string) => `org/${org}/vault/${docId}/${crypto.randomUUID()}/${fileName}`;

/** Lower-case hex SHA-256 via Web Crypto (Worker and Node alike; NFR-010). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lazy backfill budget per request (FR-067): at most 5 un-hashed rows and ~40 MB of blob reads. */
const LAZY_HASH_MAX_ROWS = 5;
const LAZY_HASH_MAX_BYTES = 40 * 1024 * 1024;
/** `content_sha256` sentinel for a row whose blob is gone, so it is not fetched again. Never matches a hex digest. */
const SHA_MISSING = 'missing';

/**
 * Another document of the org with the same content (FR-067), or null. Rows stored before hashing
 * (`content_sha256` null = unknown) are hashed lazily here when their size matches, and the hash is saved.
 */
async function findDuplicate(deps: AppDeps, org: string, sha: string, size: number, excludeId?: string): Promise<{ id: string; title: string } | null> {
  const notSelf = excludeId ? [sql`${vaultDocuments.id} <> ${excludeId}`] : [];
  const [hit] = await deps.db.select({ id: vaultDocuments.id, title: vaultDocuments.title }).from(vaultDocuments)
    .where(and(eq(vaultDocuments.orgId, org), eq(vaultDocuments.contentSha256, sha), ...notSelf))
    .orderBy(vaultDocuments.createdAt).limit(1);
  if (hit) return hit;
  const unknown = await deps.db.select({ id: vaultDocuments.id, title: vaultDocuments.title, blobKey: vaultDocuments.blobKey }).from(vaultDocuments)
    .where(and(eq(vaultDocuments.orgId, org), isNull(vaultDocuments.contentSha256), eq(vaultDocuments.sizeBytes, size), ...notSelf))
    .orderBy(vaultDocuments.createdAt).limit(Math.max(1, Math.min(LAZY_HASH_MAX_ROWS, Math.floor(LAZY_HASH_MAX_BYTES / Math.max(size, 1)))));
  for (const r of unknown) {
    let obj: Awaited<ReturnType<AppDeps['blobs']['get']>>;
    try { obj = await deps.blobs.get(r.blobKey); } catch { continue; } // transient storage error: retry on a later upload
    const h = obj ? await sha256Hex(new Uint8Array(await obj.arrayBuffer())) : SHA_MISSING;
    await deps.db.update(vaultDocuments).set({ contentSha256: h })
      .where(and(eq(vaultDocuments.orgId, org), eq(vaultDocuments.id, r.id), isNull(vaultDocuments.contentSha256)));
    if (h === sha) return { id: r.id, title: r.title };
  }
  return null;
}

/** 409 unless the caller confirmed with `allowDuplicate=1`. */
async function rejectDuplicate(deps: AppDeps, org: string, body: Record<string, string | File>, sha: string, size: number, excludeId?: string): Promise<void> {
  if (body.allowDuplicate === '1' || body.allowDuplicate === 'true') return;
  const dup = await findDuplicate(deps, org, sha, size, excludeId);
  if (dup) throw new HttpError(409, 'duplicate_document', `This file is already in your vault as “${dup.title}”.`, { existingId: dup.id, title: dup.title });
}

/** Stream a stored file with the private, no-sniff headers used by every vault download (FR-030). */
async function serveFile(c: Context<AppEnv>, blobKey: string, mimeType: string, fileName: string, what: string): Promise<Response> {
  const obj = await c.var.deps.blobs.get(blobKey);
  if (!obj) throw notFound(what);
  const inline = c.req.query('inline') === '1';
  return new Response(obj.body, {
    headers: {
      'content-type': mimeType || obj.contentType || 'application/octet-stream',
      'content-length': String(obj.size),
      'content-disposition': contentDisposition(fileName, inline),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

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

vaultRoutes.post('/vault', bodyLimit(VAULT_UPLOAD_MAX_BYTES, VAULT_TOO_LARGE), requireRole('analyst'), rateLimit('upload.org'), async (c) => {
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
  const contentSha256 = await sha256Hex(file.bytes);
  await rejectDuplicate(deps, org, body, contentSha256, file.bytes.length);
  await assertWithinPlan(deps, org, 'vaultBytes', file.bytes.length); // 008/FR-036
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
      sizeBytes: file.bytes.length, pageCount, uploadedBy: userId(c), contentSha256,
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

vaultRoutes.put('/vault/:id/file', bodyLimit(VAULT_UPLOAD_MAX_BYTES, VAULT_TOO_LARGE), requireRole('analyst'), rateLimit('upload.org'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const uid = userId(c);
  const existing = await getDoc(deps, org, c.req.param('id'));
  const { body, file, pageCount } = await readFile(c);
  // 008/FR-036: the previous file is kept as a version, so the new file adds its full size.
  await assertWithinPlan(deps, org, 'vaultBytes', file.bytes.length);
  // Renewal fields (FR-064): only the ones sent are applied; '' clears, like PATCH.
  const sent = Object.fromEntries((['issueDate', 'expiryDate', 'number'] as const)
    .filter((k) => typeof body[k] === 'string').map((k) => [k, body[k] as string]));
  const input = parseWith(vaultUpdateSchema, sent, 'form');
  const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Pick<Partial<VaultRow>, 'issueDate' | 'expiryDate' | 'number'>;
  const issue = fields.issueDate !== undefined ? fields.issueDate : existing.issueDate;
  const expiry = fields.expiryDate !== undefined ? fields.expiryDate : existing.expiryDate;
  if (issue && expiry && expiry < issue) throw validationError('expiryDate: Expiry date is before the issue date', { fields: { expiryDate: 'Expiry date is before the issue date' } });
  // A renewal = a new, non-empty expiry date: restart reminders and log vault.renewed (FR-064). Clearing it is a plain edit.
  const expiryChanged = fields.expiryDate != null && fields.expiryDate !== existing.expiryDate;

  const contentSha256 = await sha256Hex(file.bytes);
  await rejectDuplicate(deps, org, body, contentSha256, file.bytes.length, existing.id);

  const fileName = safeFileName(file.name, file.mime);
  const blobKey = replacementBlobKey(org, existing.id, fileName);
  await deps.blobs.put(blobKey, file.bytes, { contentType: file.mime });
  let row: VaultRow;
  let pruned: string[] = [];
  try {
    ({ row, pruned } = await deps.db.transaction(async (tx) => {
      const now = deps.clock.now();
      // Only replace the file we read: a concurrent replace makes this a no-op → 409 below.
      const [updated] = await tx.update(vaultDocuments).set({
        ...fields, ...(expiryChanged ? { lastReminderDays: null } : {}),
        blobKey, fileName, mimeType: file.mime, sizeBytes: file.bytes.length, pageCount, contentSha256, uploadedBy: uid, updatedAt: now,
      }).where(and(eq(vaultDocuments.orgId, org), eq(vaultDocuments.id, existing.id), eq(vaultDocuments.blobKey, existing.blobKey))).returning();
      if (!updated) throw new HttpError(409, 'conflict', 'This document was changed by someone else. Reload it and try again.');
      const older = await tx.select({ id: vaultDocumentVersions.id, blobKey: vaultDocumentVersions.blobKey, replacedAt: vaultDocumentVersions.replacedAt })
        .from(vaultDocumentVersions)
        .where(and(eq(vaultDocumentVersions.orgId, org), eq(vaultDocumentVersions.documentId, existing.id)))
        .orderBy(desc(vaultDocumentVersions.replacedAt));
      // Strictly newer than every kept version, so "newest first" is well defined even within one clock tick.
      const newest = older[0]?.replacedAt;
      const replacedAt = newest && newest >= now ? new Date(newest.getTime() + 1) : now;
      await tx.insert(vaultDocumentVersions).values({
        orgId: org, documentId: existing.id, blobKey: existing.blobKey, fileName: existing.fileName, mimeType: existing.mimeType,
        sizeBytes: existing.sizeBytes, pageCount: existing.pageCount, expiryDate: existing.expiryDate, replacedBy: uid, replacedAt,
      });
      const drop = older.slice(VAULT_MAX_VERSIONS - 1);
      if (drop.length) {
        await tx.delete(vaultDocumentVersions).where(and(eq(vaultDocumentVersions.orgId, org), inArray(vaultDocumentVersions.id, drop.map((v) => v.id))));
      }
      return { row: updated, pruned: drop.map((v) => v.blobKey) };
    }));
  } catch (e) {
    // Nothing committed: the new blob is an orphan; the old file and its versions are untouched.
    await deps.blobs.delete(blobKey).catch(() => {});
    throw e;
  }
  // After commit: purge blobs of versions beyond the cap.
  for (const key of pruned) await deps.blobs.delete(key).catch((e) => deps.logger.warn('vault version blob delete failed', { key, error: String(e) }));
  await logActivity(deps.db, { orgId: org, userId: uid, action: 'vault.file_replaced', entityType: 'vault_document', entityId: existing.id, meta: { fileName } });
  if (expiryChanged) {
    await logActivity(deps.db, { orgId: org, userId: uid, action: 'vault.renewed', entityType: 'vault_document', entityId: existing.id, meta: { fromExpiry: existing.expiryDate, toExpiry: row.expiryDate } });
  }
  return c.json(await dto(deps, row));
});

vaultRoutes.delete('/vault/:id', requireRole('analyst'), async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const existing = await getDoc(deps, org, c.req.param('id'));
  // One transaction: CRAC unlink, OEM unlink (FR-041), versions (FR-065) and the row delete commit together.
  const blobKeys = await deps.db.transaction(async (tx) => {
    await tx.update(pastContracts).set({ cracDocumentId: null }).where(and(eq(pastContracts.orgId, org), eq(pastContracts.cracDocumentId, existing.id)));
    // Profile OEM authorisations pointing at this document (case-insensitive id match, order preserved).
    await tx.update(companyProfiles).set({
      oemAuthorizations: sql`(select coalesce(jsonb_agg(case when lower(e->>'documentId') = lower(${existing.id}) then jsonb_set(e, '{documentId}', 'null'::jsonb) else e end order by i), '[]'::jsonb)
        from jsonb_array_elements(${companyProfiles.oemAuthorizations}) with ordinality as t(e, i))`,
    }).where(and(eq(companyProfiles.orgId, org), sql`exists (select 1 from jsonb_array_elements(${companyProfiles.oemAuthorizations}) as o(e) where lower(e->>'documentId') = lower(${existing.id}))`));
    const versions = await tx.delete(vaultDocumentVersions)
      .where(and(eq(vaultDocumentVersions.orgId, org), eq(vaultDocumentVersions.documentId, existing.id)))
      .returning({ blobKey: vaultDocumentVersions.blobKey });
    // The blob key comes from the deleted row itself: a replace that committed after getDoc() must not leak its file.
    const [gone] = await tx.delete(vaultDocuments).where(and(eq(vaultDocuments.orgId, org), eq(vaultDocuments.id, existing.id)))
      .returning({ blobKey: vaultDocuments.blobKey });
    if (!gone) throw notFound('Document');
    return [gone.blobKey, ...versions.map((v) => v.blobKey)];
  });
  // After commit: the blobs (current file + versions) and the activity entry.
  for (const key of blobKeys) {
    await deps.blobs.delete(key).catch((e) => deps.logger.warn('vault blob delete failed', { key, error: String(e) }));
  }
  await logActivity(deps.db, { orgId: org, userId: userId(c), action: 'vault.deleted', entityType: 'vault_document', entityId: existing.id, meta: { type: existing.type, title: existing.title } });
  return c.json({ ok: true as const });
});

vaultRoutes.get('/vault/:id/download', requireAuth, async (c) => {
  const doc = await getDoc(c.var.deps, orgId(c), c.req.param('id'));
  return serveFile(c, doc.blobKey, doc.mimeType, doc.fileName, 'Document file');
});

vaultRoutes.get('/vault/:id/versions', requireAuth, async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const doc = await getDoc(deps, org, c.req.param('id'));
  const rows = await deps.db.select({ v: vaultDocumentVersions, by: { id: users.id, name: users.name } }).from(vaultDocumentVersions)
    .leftJoin(users, eq(users.id, vaultDocumentVersions.replacedBy))
    .where(and(eq(vaultDocumentVersions.orgId, org), eq(vaultDocumentVersions.documentId, doc.id)))
    .orderBy(desc(vaultDocumentVersions.replacedAt));
  const items: VaultVersionDto[] = rows.map(({ v, by }) => ({
    id: v.id, fileName: v.fileName, mimeType: v.mimeType, sizeBytes: v.sizeBytes, pageCount: v.pageCount, expiryDate: v.expiryDate,
    replacedBy: by?.id ? { id: by.id, name: by.name } : null, replacedAt: v.replacedAt.toISOString(),
    downloadUrl: `/api/vault/${doc.id}/versions/${v.id}/download`,
  }));
  return c.json({ items });
});

vaultRoutes.get('/vault/:id/versions/:versionId/download', requireAuth, async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const doc = await getDoc(deps, org, c.req.param('id'));
  const vid = uuidSchema.safeParse(c.req.param('versionId'));
  if (!vid.success) throw notFound('Version');
  const [v] = await deps.db.select().from(vaultDocumentVersions)
    .where(and(eq(vaultDocumentVersions.orgId, org), eq(vaultDocumentVersions.documentId, doc.id), eq(vaultDocumentVersions.id, vid.data)));
  if (!v) throw notFound('Version');
  return serveFile(c, v.blobKey, v.mimeType, v.fileName, 'Version file');
});
