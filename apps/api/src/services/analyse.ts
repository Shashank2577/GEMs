/**
 * Analyse service (T045; FR-010..FR-016). Pure-ish orchestration over the DB, blob store, GeM
 * client and (optional) LLM. Routes in routes/analysis.ts are thin wrappers.
 *
 *   uploadTenderDocument → store PDF under tenders/<tenderId>/<orgId>/…, extract text per page
 *   fetchGemDocuments    → download /showbidDocument/<gemBidId> once (public, org_id null)
 *   removeTenderDocument → delete the org's own upload (blob + row), mark the analysis stale
 *   ocrTenderDocument    → transcribe a scanned PDF with the OCR model (FR-052), store it as text_source 'ocr'
 *   analyseTender        → rules (+ LLM when configured) → score → checklist → analyses row
 *   overrideFactor       → audited manual status change + re-score
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  activityLog, analyses, companyProfiles, llmUsage, organizations, pastContracts, rateLimits, tenderDocuments, tenderEvents, tenders, vaultDocuments,
  type Requirement, type ScoreFactor,
} from '@tp/db';
import { buildChecklist } from '@tp/core/analyse/checklist';
import {
  CURRENT_EXTRACTOR_VERSION, MAX_CHUNK_CHARS, buildEscalationPrompt, buildLlmPrompt, chunkPages, enrichWithLlm, escalateWithLlm, escalationCandidates,
  mergeRequirements, pageChars, partlyReadPagesNote, promptChars, unreadPagesNote,
} from '@tp/core/analyse/llm';
import {
  PdfPageLimitError, PdfTextError, extractPdf, isPdf, isScannedDocument, joinPages, looksScanned, splitPages,
} from '@tp/core/analyse/pdf-text';
import { matchCheckPrefix } from '@tp/core/analyse/check-prefix';
import {
  OCR_CALL_TIMEOUT_MS, OCR_DOCUMENT_BUDGET_MS, OCR_MAX_CALLS_PER_ANALYSIS, OCR_MAX_CALLS_PER_DOCUMENT, OCR_PAGES_PER_CALL, buildOcrRequest,
  markOcrRequirements, openPdfForOcr, parseOcrPages, type OcrSource,
} from '@tp/core/analyse/ocr';
import { combineRequirements, detectBidNumber, extractRequirementsRules, normalizeBidNumber, requirementsFromListing } from '@tp/core/analyse/rules';
import { computeScore, effectiveStatus, resolveWeights, scoreTender, DEFAULT_WEIGHTS, type FactorOverride } from '@tp/core/analyse/score';
import {
  ANALYSIS_BUDGET_MS, GEM_LEASE_MAX_WAIT_MS, LLM_CALL_TIMEOUT_MS, MAX_LLM_CALLS_PER_ANALYSIS, MAX_LLM_INPUT_CHARS, MAX_TENDER_DOC_PAGES,
  SCANNED_EMPTY_PAGE_RATIO,
} from '@tp/core/contracts/caps';
import {
  MAX_EXTRACT_PAGES, MAX_TENDER_DOC_BYTES, isRescorableReason, type AnalysisDto, type AnalysisWarning, type OverrideFactorInput, type ScoringWeights, type StaleReason, type TenderDocKind, type TenderDocumentDto,
  type TenderDocumentWarning,
} from '@tp/core/contracts/analyse';
import { GemClient, GemError } from '@tp/core/gem/client';
import { parentBidRef } from '@tp/core/gem/parse';
import type { AppDeps, LlmRequest } from '../deps';
import { logActivity } from '../lib/activity';
import { HttpError, conflict, forbidden, notFound, serviceUnavailable, unprocessable } from '../lib/errors';
import { canSeeTender, type TenderViewer } from '../lib/tender-scope';
import { assertWithinPlan, checkAnalysisQuota, meteredCompleteJson, releaseAbandonedReservations, releaseLlmReservation, reserveLlmSlot, reserveOcrSlot, type MeteredCompleteJson } from '../lib/plan';
import { keepStaleOnCompletion, lockTenderInputs, markStale, type DbOrTx } from './staleness';

type TenderRow = typeof tenders.$inferSelect;
type DocRow = typeof tenderDocuments.$inferSelect;
type AnalysisRow = typeof analyses.$inferSelect;

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);

/**
 * The bid number printed on the document when it differs from the tender's (FR-010), else null.
 * Computed from the stored text (page 1 only), so no schema column is needed.
 */
export function bidNumberMismatch(d: Pick<DocRow, 'text'>, tenderBidNumber: string | null | undefined): string | null {
  const found = detectBidNumber(splitPages(d.text).slice(0, 1));
  const expected = normalizeBidNumber(tenderBidNumber);
  return found && expected && found !== expected ? found : null;
}

/**
 * "Check documents: a.pdf is for GEM/2026/B/1." prefix for the analysis summary when any analysed
 * document's printed bid number differs from the tender's (FR-010, US2 #13); '' when all match.
 */
export function documentCheckPrefix(docs: Pick<DocRow, 'text' | 'fileName'>[], tenderBidNumber: string | null | undefined): string {
  const wrong = docs.flatMap((d) => {
    const found = bidNumberMismatch(d, tenderBidNumber);
    return found ? [`${d.fileName} is for ${found}`] : [];
  });
  return wrong.length ? `Check documents: ${wrong.join('; ')}.` : '';
}

export const withPrefix = (prefix: string, summary: string) => (prefix ? `${prefix} ${summary}` : summary);

/** `tenderBidNumber` enables `bidNumberFound`; without it the field is null. */
export function toDocumentDto(d: DocRow, tenderBidNumber?: string | null): TenderDocumentDto {
  return {
    id: d.id, tenderId: d.tenderId, orgId: d.orgId, kind: d.kind, fileName: d.fileName, sizeBytes: d.sizeBytes,
    pageCount: d.pageCount, totalPages: d.totalPages ?? null, sourceUrl: d.sourceUrl, hasText: !!d.text && d.text.replace(/\s+/g, '').length > 0,
    needsOcr: needsOcr(d), source: d.orgId ? 'upload' : 'gem', textSource: d.textSource, bidNumberFound: bidNumberMismatch(d, tenderBidNumber),
    createdAt: iso(d.createdAt),
  };
}

/** Upload warnings (non-blocking): currently only a bid-number mismatch. */
export function uploadWarnings(dto: TenderDocumentDto, totalPages?: number): TenderDocumentWarning[] {
  return [
    ...(dto.bidNumberFound ? [{ code: 'bid_number_mismatch' as const, found: dto.bidNumberFound }] : []),
    ...(totalPages && dto.pageCount != null && totalPages > dto.pageCount ? [{ code: 'pages_truncated' as const, analysed: dto.pageCount, total: totalPages }] : []),
  ];
}

export function toAnalysisDto(a: AnalysisRow, docs?: DocRow[]): AnalysisDto {
  return {
    id: a.id, orgId: a.orgId, tenderId: a.tenderId, status: a.status, method: a.method,
    requirements: a.requirements, factors: a.factors, checklist: a.checklist,
    score: a.score, confidence: a.confidence, verdict: a.verdict, summary: a.summary, error: a.error, stale: a.stale,
    staleReason: a.staleReason ?? null, staleAt: a.staleAt ? iso(a.staleAt) : null, notes: a.notes ?? [], warnings: a.warnings ?? [],
    createdBy: a.createdBy, createdAt: iso(a.createdAt), updatedAt: iso(a.updatedAt),
    ...(docs ? { documents: docs.map((d) => ({ id: d.id, fileName: d.fileName, kind: d.kind, pageCount: d.pageCount, totalPages: d.totalPages ?? null })) } : {}),
  };
}

/** A tender the caller's org may see: demo tenders do not exist for orgs that never loaded the demo (008/FR-016). */
export async function getTender(deps: AppDeps, tenderId: string, viewer: TenderViewer): Promise<TenderRow> {
  const [t] = await deps.db.select().from(tenders).where(eq(tenders.id, tenderId));
  if (!t || !canSeeTender(viewer, t)) throw notFound('Tender');
  return t;
}

/** Documents visible to an org: public GeM documents + its own uploads, oldest first. */
export async function listTenderDocuments(deps: AppDeps, tenderId: string, orgId: string): Promise<DocRow[]> {
  return documentsIn(deps.db, tenderId, orgId);
}

function documentsIn(db: DbOrTx, tenderId: string, orgId: string): Promise<DocRow[]> {
  return db.select().from(tenderDocuments)
    .where(and(eq(tenderDocuments.tenderId, tenderId), or(isNull(tenderDocuments.orgId), eq(tenderDocuments.orgId, orgId))))
    .orderBy(asc(tenderDocuments.createdAt));
}

export async function getTenderDocument(deps: AppDeps, tenderId: string, docId: string, orgId: string): Promise<DocRow> {
  const [d] = await deps.db.select().from(tenderDocuments)
    .where(and(eq(tenderDocuments.id, docId), eq(tenderDocuments.tenderId, tenderId), or(isNull(tenderDocuments.orgId), eq(tenderDocuments.orgId, orgId))));
  if (!d) throw notFound('Document');
  return d;
}

const safeName = (name: string) => {
  const base = name.split(/[\\/]/).pop() ?? 'document.pdf';
  const cleaned = base.replace(/[^\w.\- ()]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned || 'document.pdf';
};

/** 008/FR-030 messages (spec 008 US4 scenarios 8–9). */
export const documentTooLongMessage = (pages: number) =>
  `This document has ${pages} pages. TenderPilot accepts documents of up to ${MAX_TENDER_DOC_PAGES} pages and reads the first ${MAX_EXTRACT_PAGES} — upload the bid document and ATC separately.`;
export const SCANNED_DOCUMENT_MESSAGE = 'This PDF is a scan without text. Upload the text PDF from GeM or an OCR’d copy.';

/**
 * > MAX_TENDER_DOC_PAGES pages → 422 `document_too_long` before any text is read (008/FR-030); otherwise reads at
 * most MAX_EXTRACT_PAGES pages (NFR-005) and `totalPages` is the PDF's real page count.
 */
async function extractOrThrow(bytes: Uint8Array): Promise<{ pages: string[]; totalPages: number }> {
  try {
    return await extractPdf(bytes, { maxPages: MAX_EXTRACT_PAGES, rejectAbovePages: MAX_TENDER_DOC_PAGES });
  } catch (e) {
    if (e instanceof PdfPageLimitError) throw unprocessable('document_too_long', documentTooLongMessage(e.pages), { pages: e.pages, maxPages: e.maxPages });
    if (e instanceof PdfTextError) throw new HttpError(422, 'unreadable_pdf', 'We could not read this PDF. It may be password-protected or damaged.');
    throw e;
  }
}

// ───────────── Upload ─────────────

export interface UploadInput {
  orgId: string; userId: string; tenderId: string; kind: TenderDocKind;
  /** The caller's org (tender visibility, 008/FR-016). */
  viewer: TenderViewer;
  file: { name: string; type?: string; bytes: Uint8Array };
}

export async function uploadTenderDocument(deps: AppDeps, input: UploadInput): Promise<{ doc: DocRow; tender: TenderRow; totalPages: number }> {
  const tender = await getTender(deps, input.tenderId, input.viewer);
  const { bytes } = input.file;
  if (bytes.length === 0) throw new HttpError(400, 'bad_request', 'The file is empty');
  if (bytes.length > MAX_TENDER_DOC_BYTES) throw new HttpError(413, 'payload_too_large', 'The file is larger than 25 MB');
  if (!isPdf(bytes)) throw new HttpError(415, 'unsupported_media_type', 'Only PDF files can be analysed. Export the document to PDF and try again.');
  const { pages, totalPages } = await extractOrThrow(bytes);
  const id = crypto.randomUUID();
  const fileName = safeName(input.file.name || 'document.pdf');
  const blobKey = `tenders/${input.tenderId}/${input.orgId}/${id}.pdf`;
  await deps.blobs.put(blobKey, bytes, { contentType: 'application/pdf' });
  // Row, activity entry and stale flag commit together (S2), under the org+tender lifecycle lock so a run starting now
  // either reads this document or is flagged by markStale (S4).
  const doc = await deps.db.transaction(async (tx) => {
    await lockAnalyses(tx, input.orgId, input.tenderId);
    const [doc] = await tx.insert(tenderDocuments).values({
      id, tenderId: input.tenderId, orgId: input.orgId, kind: input.kind, fileName, blobKey,
      sizeBytes: bytes.length, pageCount: pages.length, totalPages, text: joinPages(pages), sourceUrl: null,
    }).returning();
    await logActivity(tx, {
      orgId: input.orgId, userId: input.userId, action: 'tender.document_uploaded', entityType: 'tender', entityId: input.tenderId,
      meta: { documentId: id, fileName, kind: input.kind, pages: pages.length, ...(totalPages > pages.length ? { totalPages } : {}), scanned: looksScanned(pages) },
    });
    await markStale(tx, { orgId: input.orgId, tenderIds: [input.tenderId] }, 'document_added', deps.clock.now());
    return doc;
  }).catch(async (e) => {
    await deps.blobs.delete(blobKey).catch(() => {});
    throw e;
  });
  return { doc, tender, totalPages };
}

// ───────────── Remove (FR-009) ─────────────

export async function removeTenderDocument(deps: AppDeps, input: { orgId: string; userId: string; tenderId: string; docId: string; viewer: TenderViewer }): Promise<void> {
  await getTender(deps, input.tenderId, input.viewer);
  const doc = await getTenderDocument(deps, input.tenderId, input.docId, input.orgId);
  if (doc.orgId === null) throw forbidden('Documents fetched from GeM are shared and cannot be removed');
  // Delete, activity entry and stale flag commit together (S2), under the lifecycle lock (S4, see uploadTenderDocument).
  await deps.db.transaction(async (tx) => {
    await lockAnalyses(tx, input.orgId, input.tenderId);
    const deleted = await tx.delete(tenderDocuments)
      .where(and(eq(tenderDocuments.id, doc.id), eq(tenderDocuments.orgId, input.orgId)))
      .returning({ id: tenderDocuments.id });
    // A concurrent delete already removed it: only one request logs and marks the analysis stale.
    if (!deleted.length) throw notFound('Document');
    await logActivity(tx, {
      orgId: input.orgId, userId: input.userId, action: 'tender.document_removed', entityType: 'tender', entityId: input.tenderId,
      meta: { documentId: doc.id, fileName: doc.fileName, kind: doc.kind },
    });
    await markStale(tx, { orgId: input.orgId, tenderIds: [input.tenderId] }, 'document_removed', deps.clock.now());
  });
  try {
    await deps.blobs.delete(doc.blobKey);
  } catch (e) {
    // The row is gone, so the file is unreachable; log and keep going rather than failing the user.
    deps.logger.warn('analyse: blob delete failed after document removal', { tenderId: input.tenderId, blobKey: doc.blobKey, error: (e as Error).message });
  }
}

// ───────────── OCR (T091, FR-052) ─────────────

export const OCR_UNAVAILABLE_MESSAGE = 'AI OCR is not set up. Upload the text PDF from GeM, or ask your admin to enable AI OCR.';
export const OCR_FAILED_MESSAGE = 'AI OCR could not read this document. Try again in a few minutes, or upload the text PDF from GeM.';

/**
 * A document analysis cannot read (no text layer, 008/FR-030) and that OCR has not transcribed yet. OCR text is never
 * treated as a scan again, even when it is sparse.
 */
export const needsOcr = (d: Pick<DocRow, 'text' | 'textSource'>) =>
  d.textSource !== 'ocr' && isScannedDocument(splitPages(d.text), SCANNED_EMPTY_PAGE_RATIO);

/** Activity action recording that analyse's automatic OCR of a document failed: analyse does not retry it (review S2). */
export const OCR_FAILED_ACTION = 'tender.document_ocr_failed';

/** 502 `ocr_failed`, with the (logged, never shown) reason. */
class OcrFailedError extends HttpError {
  constructor(readonly reason: string) { super(502, 'ocr_failed', OCR_FAILED_MESSAGE); }
}

interface OcrRun {
  /** Metered OCR-tier `completeJson`. */
  completeJson: (req: LlmRequest) => Promise<unknown>;
  /** Most calls this document may take; more parts than this → failure (before any call when the page count shows it). */
  maxCalls: number;
  /** deps.clock time (ms) after which no call starts. */
  deadline: number;
  callWithTimeout: typeof withTimeout;
  /** Called as each call starts, with the text characters it sends. */
  onCall?: (chars: number) => void;
}

/**
 * Transcribe the stored PDF page by page with the OCR model: parts of ≤ OCR_PAGES_PER_CALL pages (≤ 22 MB) built one at
 * a time (review S6), one call per part, sequentially, each bounded by OCR_CALL_TIMEOUT_MS and the run's deadline. Only
 * the pages the document's text covers are split and kept (its `pageCount`, ≤ MAX_EXTRACT_PAGES = 150; `totalPages` is
 * unchanged), at their real page numbers. The request carries only the PDF and the fixed OCR prompt (FR-054).
 *
 * Any failure → 502 `ocr_failed` and nothing is stored: missing file, unreadable PDF, provider error, refusal,
 * truncation, budget, a reply that leaves out any page of its part (review S3: a page the model explicitly returned as
 * '' is a blank page and is fine; an absent page means the transcription is incomplete), or no text at all. The reason
 * is logged, never the document text. `chars` counts the text sent (system + instruction; the PDF is a document block).
 */
async function transcribeDocument(deps: AppDeps, doc: DocRow, run: OcrRun): Promise<{ pages: string[]; calls: number; chars: number }> {
  const fail = (reason: string, error?: unknown, extra: Record<string, unknown> = {}) => {
    deps.logger.warn('ocr: failed', { tenderId: doc.tenderId, documentId: doc.id, reason, ...extra, ...(error ? { error: (error as Error).message } : {}) });
    return new OcrFailedError(reason);
  };
  const obj = await deps.blobs.get(doc.blobKey);
  if (!obj) throw fail('file_missing');
  let source: OcrSource;
  try {
    source = await openPdfForOcr(new Uint8Array(await obj.arrayBuffer()));
  } catch (e) {
    throw fail('unreadable_pdf', e);
  }
  const pageLimit = Math.min(doc.pageCount || source.totalPages, source.totalPages, MAX_EXTRACT_PAGES);
  if (Math.ceil(pageLimit / OCR_PAGES_PER_CALL) > run.maxCalls) throw fail('too_many_parts');
  const pages: string[] = Array.from({ length: pageLimit }, () => '');
  let calls = 0;
  let chars = 0;
  try {
    for await (const part of source.parts({ maxPages: OCR_PAGES_PER_CALL, pageLimit })) {
      // A part halved for size can add calls beyond the page-count estimate above.
      if (calls >= run.maxCalls) throw fail('too_many_parts');
      const remaining = run.deadline - deps.clock.now().getTime();
      if (remaining <= 0) throw fail('budget');
      const req = buildOcrRequest(part);
      const [document, instruction] = req.content;
      const timeoutMs = Math.min(OCR_CALL_TIMEOUT_MS, remaining);
      const sent = req.system.length + instruction.text.length;
      calls++;
      chars += sent;
      run.onCall?.(sent);
      let reply: unknown;
      try {
        reply = await run.callWithTimeout((signal) => run.completeJson({
          system: req.system, documents: [document], prompt: instruction.text, maxTokens: req.maxTokens, jsonSchema: req.jsonSchema, timeoutMs, signal,
        }), timeoutMs);
      } catch (e) {
        throw fail('call', e);
      }
      const parsed = parseOcrPages(reply, req.pageCount);
      if (parsed.absent.length) throw fail('pages_missing', undefined, { pages: parsed.absent.map((p) => part.firstPage + p - 1) });
      parsed.pages.forEach((text, i) => {
        const page = part.firstPage + i;
        if (page <= pageLimit) pages[page - 1] = text;
      });
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw fail('unreadable_pdf', e); // a part that could not be built (e.g. one page over 22 MB)
  }
  if (pages.every((p) => !p)) throw fail('no_text');
  return { pages, calls, chars };
}

export const OCR_BUSY_MESSAGE = 'This document is already being read with AI OCR. Wait a minute and reload.';

/** A claim older than this is from a run that died (a live run ends within the 10-minute OCR budget). */
const OCR_CLAIM_TTL_MS = OCR_DOCUMENT_BUDGET_MS + 2 * 60_000;

/**
 * Claim a document for one OCR run (review N4), BEFORE any AI slot is reserved or any model call made: a second OCR
 * of the same document — manual or analyse's automatic one, from any org (a shared GeM copy is one row) — finds the
 * claim and backs off. The claim lives across transactions (the OCR calls take minutes and must not hold a database
 * connection or lock), so it is a row, not a lock: `rate_limits` key `ocr-claim:<documentId>` with `window_start` = the
 * claim time. That table needs no migration, is keyed by text and its old rows are pruned by the scheduler anyway. The
 * check-and-insert runs under a transaction-scoped advisory lock on that key, so two claimers cannot both see it free;
 * a claim older than OCR_CLAIM_TTL_MS (a run that crashed) is ignored and replaced. Returns the claim time to pass to
 * `releaseOcrClaim`, or null when the document is already being read.
 */
async function claimOcr(deps: Pick<AppDeps, 'db' | 'clock'>, docId: string): Promise<Date | null> {
  const key = `ocr-claim:${docId}`;
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    await tx.delete(rateLimits).where(and(eq(rateLimits.key, key), lt(rateLimits.windowStart, new Date(now.getTime() - OCR_CLAIM_TTL_MS))));
    const [held] = await tx.select({ at: rateLimits.windowStart }).from(rateLimits).where(eq(rateLimits.key, key)).limit(1);
    if (held) return null;
    await tx.insert(rateLimits).values({ key, windowStart: now, count: 1 });
    return now;
  });
}

/** End an OCR run's claim on a document (see `claimOcr`). Never throws: a claim left behind expires on its own. */
async function releaseOcrClaim(deps: Pick<AppDeps, 'db' | 'logger'>, docId: string, at: Date): Promise<void> {
  try {
    await deps.db.delete(rateLimits).where(and(eq(rateLimits.key, `ocr-claim:${docId}`), eq(rateLimits.windowStart, at)));
  } catch (e) {
    deps.logger.warn('ocr: releasing the document claim failed; it expires on its own', { documentId: docId, error: (e as Error).message });
  }
}

/**
 * Store OCR text on the document (`text_source = 'ocr'`), log `tender.document_ocr` and mark the analyses that read
 * the document stale (`document_added`: the text they analysed changed), all in one transaction (S2). Locks like the
 * other writers of this input (S4): an org's own upload under that org's lifecycle lock (as upload/remove); a shared
 * GeM copy under the tender's exclusive input lock, and then every org's analyses are flagged (as a new GeM copy).
 * The update only applies while the row still has the text (and text source) we read: a concurrent OCR that won → 409
 * `conflict`; a row deleted meanwhile → 404.
 */
async function storeOcrText(
  deps: AppDeps, input: { orgId: string; userId: string; tenderId: string }, doc: DocRow, pages: string[],
  meta: { calls: number; trigger: 'manual' | 'analysis'; force?: boolean },
): Promise<DocRow> {
  return deps.db.transaction(async (tx) => {
    if (doc.orgId) await lockAnalyses(tx, input.orgId, input.tenderId);
    else await lockTenderInputs(tx, input.tenderId, 'exclusive');
    const [updated] = await tx.update(tenderDocuments).set({ text: joinPages(pages), textSource: 'ocr', pageCount: pages.length })
      .where(and(
        eq(tenderDocuments.id, doc.id), eq(tenderDocuments.textSource, doc.textSource),
        doc.text === null ? isNull(tenderDocuments.text) : eq(tenderDocuments.text, doc.text),
      ))
      .returning();
    if (!updated) {
      const [still] = await tx.select({ id: tenderDocuments.id }).from(tenderDocuments).where(eq(tenderDocuments.id, doc.id));
      if (!still) throw notFound('Document');
      throw conflict('This document was changed while it was being read. Reload to see its text.');
    }
    await logActivity(tx, {
      orgId: input.orgId, userId: input.userId, action: 'tender.document_ocr', entityType: 'tender', entityId: input.tenderId,
      meta: { documentId: doc.id, fileName: doc.fileName, pages: pages.length, calls: meta.calls, trigger: meta.trigger, ...(meta.force ? { force: true } : {}) },
    });
    await markStale(tx, doc.orgId ? { orgId: input.orgId, tenderIds: [input.tenderId] } : { tenderIds: [input.tenderId] }, 'document_added', deps.clock.now());
    return updated;
  });
}

/**
 * POST /tenders/:id/documents/:docId/ocr (FR-052): transcribe a scanned document on demand → the updated row.
 * 404 unknown/other-org document (tender visibility first), 409 `conflict` when it already has text or is being read
 * by another OCR run right now (review N4, checked before any slot or call), 503 `ocr_unavailable` without an OCR
 * model, 402 `plan_limit_reached` when the org's monthly AI slots are used up (008/FR-037), 502 `ocr_failed`.
 *
 * Cost control (review B1, ADR-0008 amendment): each run reserves one monthly AI slot (`reserveOcrSlot`) under its own
 * `analysis_ref`, so manual OCR counts against `llmAnalysesPerMonth` like an AI analysis; a run whose calls reached the
 * model keeps the slot even when it fails, so a failing document cannot be retried for free.
 *
 * `force` re-runs OCR on a document whose text already came from OCR and replaces that text — same guards, locks,
 * stale marking and metering. It needs `canForce` (bid_manager+, from the route) → else 403 (review S3), and only
 * applies to the org's own uploads: a shared GeM copy is read once for all organisations → 403 (review N5). On a
 * document that still needs OCR the flag is ignored (review N7).
 */
export async function ocrTenderDocument(
  deps: AppDeps, input: { orgId: string; userId: string; tenderId: string; docId: string; viewer: TenderViewer; force?: boolean; canForce?: boolean },
  opts: { withTimeout?: typeof withTimeout } = {},
): Promise<{ doc: DocRow; tender: TenderRow }> {
  const tender = await getTender(deps, input.tenderId, input.viewer);
  const doc = await getTenderDocument(deps, input.tenderId, input.docId, input.orgId);
  const reread = !needsOcr(doc) && doc.textSource === 'ocr' && !!input.force;
  if (!needsOcr(doc) && !reread) {
    throw conflict(doc.textSource === 'ocr'
      ? 'This document was already read with AI OCR.'
      : 'This document already has text — OCR is only for scanned PDFs.');
  }
  if (reread && !input.canForce) throw forbidden('Only a bid manager or owner can re-run AI OCR on a document');
  if (reread && doc.orgId === null) {
    throw forbidden('Shared GeM documents are read once for all organisations and cannot be re-read with AI OCR. Upload your own copy of the PDF to read it again.');
  }
  const ocrLlm = deps.llmFor('ocr');
  if (!ocrLlm) throw serviceUnavailable('ocr_unavailable', OCR_UNAVAILABLE_MESSAGE);
  const claim = await claimOcr(deps, doc.id);
  if (!claim) throw conflict(OCR_BUSY_MESSAGE);
  try {
    const slot = await reserveOcrSlot(deps, input.orgId, ocrLlm.model);
    const completeJson = meteredCompleteJson({ ...deps, llm: ocrLlm }, {
      orgId: input.orgId, analysisId: null, analysisRef: slot.ref, kind: 'extract', reservationId: slot.reservationId,
    });
    try {
      const { pages, calls } = await transcribeDocument(deps, doc, {
        completeJson, maxCalls: OCR_MAX_CALLS_PER_DOCUMENT, deadline: deps.clock.now().getTime() + OCR_DOCUMENT_BUDGET_MS,
        callWithTimeout: opts.withTimeout ?? withTimeout,
      });
      return { doc: await storeOcrText(deps, input, doc, pages, { calls, trigger: 'manual', force: reread }), tender };
    } finally {
      await completeJson.finish();
    }
  } finally {
    await releaseOcrClaim(deps, doc.id, claim);
  }
}

/** Documents of this tender whose automatic OCR failed for this org (review S2): analyse does not OCR them again. */
async function ocrFailedDocIds(db: DbOrTx, orgId: string, tenderId: string): Promise<Set<string>> {
  const rows = await db.select({ meta: activityLog.meta }).from(activityLog)
    .where(and(eq(activityLog.orgId, orgId), eq(activityLog.entityType, 'tender'), eq(activityLog.entityId, tenderId), eq(activityLog.action, OCR_FAILED_ACTION)));
  return new Set(rows.flatMap((r) => {
    const id = (r.meta as { documentId?: unknown } | null)?.documentId;
    return typeof id === 'string' ? [id] : [];
  }));
}

export interface AutoOcrResult {
  /** Documents whose OCR failed in this run. */
  failed: string[];
  /** Documents too long to OCR within this analysis's call cap. */
  tooLong: string[];
  /** Documents skipped because an earlier analysis's OCR of them failed (review S2). */
  failedBefore: string[];
  /** Documents skipped because another OCR run is reading them right now (review N4). */
  busy: string[];
  /** OCR calls made and text characters sent (counted in the analysis's LLM budget, review S4). */
  calls: number;
  chars: number;
  /** Documents whose OCR text this run stored. */
  stored: number;
  /**
   * The AI slot automatic OCR reserved under the coming analysis's id (review N3), with the meter its calls went
   * through; null when no OCR ran (nothing to read, no OCR model, slots used up, a run already going).
   */
  slot: { meter: MeteredCompleteJson } | null;
}

/**
 * Analyse's automatic OCR (FR-052): before the run's row exists (a slow OCR cannot make the run look timed out), the
 * scanned documents are transcribed with at most `maxCalls` calls in total (≤ OCR_MAX_CALLS_PER_ANALYSIS; they count
 * towards the analysis's 8-call cap), whole documents only, inside the analysis deadline.
 *
 * Cost control (review N3): before any OCR call the analysis's monthly AI slot is reserved atomically under the org
 * row lock (`reserveOcrSlot` with the coming analysis's id as `analysis_ref`), so concurrent analyses at the quota
 * cannot all OCR; slots used up → no OCR. The analysis then links that reservation and uses it for its own AI calls
 * (`analyseTender`); if the analysis row is never inserted, `settleOrphanOcrSlot` decides what the rows become.
 * Each document is claimed first (`claimOcr`, review N4): one that another OCR run is reading is skipped (`busy`).
 *
 * Nothing runs when OCR is off or a run is already going (that request then answers 409). A document whose OCR fails
 * — for any reason, the run's time budget included (review N2) — stays a scan, is recorded as
 * `tender.document_ocr_failed` and is not OCR'd by analyse again (only `POST …/ocr` retries it; a changed document is
 * a new row).
 */
async function autoOcr(
  deps: AppDeps, input: { orgId: string; userId: string; tenderId: string }, analysisRef: string,
  run: { deadline: number; callWithTimeout: typeof withTimeout; maxCalls: number },
): Promise<AutoOcrResult> {
  const out: AutoOcrResult = { failed: [], tooLong: [], failedBefore: [], busy: [], calls: 0, chars: 0, stored: 0, slot: null };
  const ocrLlm = deps.llmFor('ocr');
  if (!ocrLlm) return out;
  const scans = (await listTenderDocuments(deps, input.tenderId, input.orgId)).filter(needsOcr);
  if (!scans.length) return out;
  const failedIds = await ocrFailedDocIds(deps.db, input.orgId, input.tenderId);
  out.failedBefore = scans.filter((d) => failedIds.has(d.id)).map((d) => d.fileName);
  const callsFor = (d: DocRow) => Math.ceil(Math.min(d.pageCount || MAX_EXTRACT_PAGES, MAX_EXTRACT_PAGES) / OCR_PAGES_PER_CALL);
  const fresh = scans.filter((d) => !failedIds.has(d.id));
  out.tooLong = fresh.filter((d) => callsFor(d) > run.maxCalls).map((d) => d.fileName);
  const candidates = fresh.filter((d) => callsFor(d) <= run.maxCalls);
  if (!candidates.length) return out;
  const now = deps.clock.now();
  const [running] = await deps.db.select({ id: analyses.id }).from(analyses).where(and(
    eq(analyses.orgId, input.orgId), eq(analyses.tenderId, input.tenderId), eq(analyses.status, 'running'),
    gt(analyses.createdAt, new Date(now.getTime() - ANALYSIS_RUNNING_TIMEOUT_MS)),
  )).limit(1);
  if (running) return out;
  const claims = new Map<string, Date>();
  try {
    const docs: DocRow[] = [];
    for (const d of candidates) {
      const at = await claimOcr(deps, d.id);
      if (at) { claims.set(d.id, at); docs.push(d); } else out.busy.push(d.fileName);
    }
    if (!docs.length) return out;
    let reservationId: string;
    try {
      ({ reservationId } = await reserveOcrSlot(deps, input.orgId, ocrLlm.model, { ref: analysisRef }));
    } catch (e) {
      if (e instanceof HttpError && e.status === 402) return out; // AI slots used up: the scans stay unread
      throw e;
    }
    const meter = meteredCompleteJson({ ...deps, llm: ocrLlm }, { orgId: input.orgId, analysisId: null, analysisRef, kind: 'extract', reservationId });
    out.slot = { meter };
    for (const d of docs) {
      const left = run.maxCalls - out.calls;
      if (callsFor(d) > left) { out.tooLong.push(d.fileName); continue; }
      if (deps.clock.now().getTime() >= run.deadline) { out.failed.push(d.fileName); continue; }
      const callsBefore = out.calls;
      try {
        const r = await transcribeDocument(deps, d, {
          completeJson: meter, maxCalls: left, deadline: run.deadline, callWithTimeout: run.callWithTimeout, onCall: (c) => { out.calls++; out.chars += c; },
        });
        await storeOcrText(deps, input, d, r.pages, { calls: r.calls, trigger: 'analysis' });
        out.stored++;
      } catch (e) {
        // Transcribed by a concurrent request meanwhile: it has text now. Removed meanwhile: nothing to read.
        if (e instanceof HttpError && (e.code === 'conflict' || e.status === 404)) continue;
        deps.logger.warn('analyse: automatic OCR of a scanned document failed; it is skipped', { tenderId: input.tenderId, documentId: d.id, error: (e as Error).message });
        out.failed.push(d.fileName);
        // Remembered so the next analyse does not pay for the same failing OCR again (review S2) — also when it ran out
        // of time (review N2): the same document would most likely run out again on every analyse. Only a document
        // that ran out before its first call (an earlier document used the time up) cost nothing and is not marked.
        const reason = e instanceof OcrFailedError ? e.reason : 'error';
        if (!(reason === 'budget' && out.calls === callsBefore)) {
          await logActivity(deps.db, {
            orgId: input.orgId, userId: input.userId, action: OCR_FAILED_ACTION, entityType: 'tender', entityId: input.tenderId,
            meta: { documentId: d.id, fileName: d.fileName, reason }, createdAt: deps.clock.now(),
          });
        }
      }
    }
    return out;
  } finally {
    for (const [docId, at] of claims) await releaseOcrClaim(deps, docId, at);
  }
}

// ───────────── Fetch from GeM ─────────────

/** Activity action recording a GeM re-fetch that failed (S3): analyse does not retry it until a newer corrigendum. */
export const GEM_FETCH_FAILED = 'tender.document_fetch_failed';

/**
 * FR-046: has a corrigendum changed the tender's document URL since the newest GeM copy was stored? Both sides are
 * app-clock times stamped at their own write: the corrigendum event when ingestion writes it (not when the run
 * started, review B1) and the copy's `created_at` when the fetch stores it, so a copy fetched while an ingestion run
 * was going is still compared correctly with a corrigendum that run wrote afterwards.
 *
 * With `orgId` (the analyse path, S3) a failed re-fetch recorded for that org counts like a copy: analyse falls back
 * to the stored copies and only tries again once a newer corrigendum arrives (or someone fetches explicitly).
 */
export async function gemCopyOutdated(db: DbOrTx, tenderId: string, gemDocs: Pick<DocRow, 'createdAt'>[], opts: { orgId?: string } = {}): Promise<boolean> {
  if (!gemDocs.length) return false;
  let since = gemDocs.reduce((m, d) => (d.createdAt > m ? d.createdAt : m), gemDocs[0]!.createdAt);
  if (opts.orgId) {
    const [failed] = await db.select({ at: activityLog.createdAt }).from(activityLog)
      .where(and(eq(activityLog.orgId, opts.orgId), eq(activityLog.entityType, 'tender'), eq(activityLog.entityId, tenderId), eq(activityLog.action, GEM_FETCH_FAILED)))
      .orderBy(desc(activityLog.createdAt)).limit(1);
    if (failed && failed.at > since) since = failed.at;
  }
  const events = await db.select({ changes: tenderEvents.changes }).from(tenderEvents)
    .where(and(eq(tenderEvents.tenderId, tenderId), eq(tenderEvents.kind, 'corrigendum'), gt(tenderEvents.createdAt, since)));
  return events.some((e) => !!e.changes && 'documentUrl' in e.changes);
}

/** SHA-256 (hex) of a document's extracted text: the identity used to spot a re-fetch of the same document (S5). */
async function textHash(text: string | null): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text ?? '')));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

const gemDocsIn = (db: DbOrTx, tenderId: string) =>
  db.select().from(tenderDocuments).where(and(eq(tenderDocuments.tenderId, tenderId), isNull(tenderDocuments.orgId))).orderBy(asc(tenderDocuments.createdAt));

async function fetchFirstAvailable(client: GemClient, refs: string[]): Promise<Awaited<ReturnType<GemClient['fetchBidDocument']>>> {
  let last: unknown;
  for (const r of refs) {
    try { return await client.fetchBidDocument(r); } catch (e) {
      if (e instanceof HttpError) throw e; // gem_busy: stop, do not burn the other candidates
      last = e;
    }
  }
  throw last;
}

/**
 * Download the tender's GeM bid document (public, shared by every org) once. A later call returns the stored copy,
 * unless a corrigendum changed `documentUrl` after that copy was fetched (FR-046) or `refresh` is set: then the
 * current document is downloaded as kind `corrigendum` and the earlier copy is kept. The 150-page text cap and
 * `total_pages` handling are the same as for the first copy.
 *
 * A re-fetch that stores a new copy marks every org's analyses of the tender stale (`corrigendum`, S5); a forced
 * refresh whose text hashes the same as a stored copy stores nothing. The store is a check-then-insert under the
 * tender's exclusive input lock, so two concurrent fetches store one copy. A re-fetch that fails (other than a busy
 * GeM lease) is recorded as `tender.document_fetch_failed` so analyse does not retry it on every run (S3).
 */
export async function fetchGemDocuments(deps: AppDeps, input: { orgId: string; userId: string; tenderId: string; viewer: TenderViewer; refresh?: boolean }): Promise<{ documents: DocRow[]; fetched: number; tender: TenderRow }> {
  const tender = await getTender(deps, input.tenderId, input.viewer);
  const existing = await gemDocsIn(deps.db, tender.id);
  const outdated = await gemCopyOutdated(deps.db, tender.id, existing);
  if (existing.length && !outdated && !input.refresh) return { documents: existing, fetched: 0, tender };
  // The URL a corrigendum published wins over the bid id; the first copy keeps the bid id first.
  // `documentUrl` carries the right GeM route per bid type (a reverse auction is not under /showbidDocument), so it comes first.
  // A reverse auction's own PDF is a 2-page summary: its full terms are in the parent bid, which is tried first (real GeM, 2026-11).
  const parent = tender.bidType === 'ra' && !existing.length ? parentBidRef(tender.raw, deps.gem.baseUrl) : null;
  // A re-fetch after a corrigendum tries exactly the current URL (a failure is recorded, not papered over by another document).
  const candidates = (existing.length ? [tender.documentUrl ?? tender.gemBidId] : [parent?.documentUrl, tender.documentUrl, tender.gemBidId])
    .filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
  const ref = candidates[0];
  if (!ref) throw new HttpError(422, 'no_gem_document', 'This tender has no GeM document link. Download the bid PDF from GeM and upload it here.');
  const client = new GemClient(deps.fetch, {
    baseUrl: deps.gem.baseUrl, userAgent: deps.gem.userAgent, minIntervalMs: deps.gem.minIntervalMs,
    maxRetries: 2, backoffMs: Math.min(1000, Math.max(10, deps.gem.minIntervalMs)), timeoutMs: 45_000,
    // Streamed with the ported bounded reader (gem/http.ts): aborts at 25 MB instead of buffering it (FR-021).
    maxDocumentBytes: MAX_TENDER_DOC_BYTES,
    // Cluster-wide ≤ 1 request/s to GeM (008/FR-024): wait ≤ 25 s for a slot, else 503 gem_busy.
    beforeRequest: () => deps.gemLease.acquire(GEM_LEASE_MAX_WAIT_MS),
  });
  let got: { bytes: Uint8Array; url: string };
  let pages: string[];
  let totalPages: number;
  try {
    try {
      got = await fetchFirstAvailable(client, candidates);
    } catch (e) {
      if (e instanceof HttpError) throw e; // 503 gem_busy from the lease
      deps.logger.warn('analyse: GeM document fetch failed', { tenderId: tender.id, error: (e as Error).message });
      const msg = e instanceof GemError && e.code === 'too_large'
        ? 'The GeM document is larger than 25 MB — download it from GeM and upload it here.'
        : e instanceof GemError && e.status === 404
          ? 'GeM no longer serves this bid document. Upload the PDF instead.'
          : 'Could not download the bid document from GeM right now. Try again in a few minutes or upload the PDF.';
      throw new HttpError(502, 'gem_unavailable', msg);
    }
    ({ pages, totalPages } = await extractOrThrow(got.bytes));
  } catch (e) {
    // A busy lease is transient and says nothing about the document: only real failures are remembered.
    if (existing.length && !(e instanceof HttpError && e.status === 503)) {
      await logActivity(deps.db, {
        orgId: input.orgId, userId: input.userId, action: GEM_FETCH_FAILED, entityType: 'tender', entityId: tender.id,
        meta: { code: e instanceof HttpError ? e.code : 'error', sourceUrl: ref }, createdAt: deps.clock.now(),
      });
    }
    throw e;
  }
  const text = joinPages(pages);
  const hash = await textHash(text);
  if (totalPages > pages.length) deps.logger.warn('analyse: GeM document truncated to the page cap', { tenderId: tender.id, pages: pages.length, totalPages });
  const id = crypto.randomUUID();
  const blobKey = `tenders/${tender.id}/gem/${id}.pdf`;
  await deps.blobs.put(blobKey, got.bytes, { contentType: 'application/pdf' });
  const fileName = `${tender.bidNumber.replace(/[^\w-]+/g, '-')}.pdf`;
  let stored: { documents: DocRow[]; doc: DocRow | null };
  try {
    stored = await deps.db.transaction(async (tx) => {
      // Check-then-insert under the tender's exclusive input lock (S5): a concurrent fetch that stored a copy since our
      // read wins, and runs starting now either read this copy or are flagged by markStale below (S4).
      await lockTenderInputs(tx, tender.id, 'exclusive');
      const current = await gemDocsIn(tx, tender.id);
      const known = new Set(existing.map((d) => d.id));
      if (current.some((d) => !known.has(d.id))) return { documents: current, doc: null };
      // A forced refresh that finds the same document (same text) stores nothing new.
      if (input.refresh && !outdated) {
        for (const d of current) if ((await textHash(d.text)) === hash) return { documents: current, doc: null };
      }
      const at = deps.clock.now();
      const [doc] = await tx.insert(tenderDocuments).values({
        id, tenderId: tender.id, orgId: null, kind: current.length ? 'corrigendum' : 'bid', fileName: current.length ? fileName.replace(/\.pdf$/, '-corrigendum.pdf') : fileName,
        blobKey, sizeBytes: got.bytes.length, pageCount: pages.length, totalPages, text, sourceUrl: got.url, createdAt: at,
      }).returning();
      if (!tender.documentUrl) await tx.update(tenders).set({ documentUrl: got.url }).where(eq(tenders.id, tender.id));
      await logActivity(tx, {
        orgId: input.orgId, userId: input.userId, action: 'tender.document_fetched', entityType: 'tender', entityId: tender.id,
        meta: { documentId: id, pages: pages.length, ...(totalPages > pages.length ? { totalPages } : {}), sourceUrl: got.url, ...(current.length ? { kind: 'corrigendum' } : {}) },
      });
      // Every org's analyses read the previous GeM copy: the changed document needs a full re-analysis (S5, FR-046).
      if (current.length) await markStale(tx, { tenderIds: [tender.id] }, 'corrigendum', at);
      return { documents: [...current, doc!], doc: doc! };
    });
  } catch (e) {
    await deps.blobs.delete(blobKey).catch(() => {});
    throw e;
  }
  if (!stored.doc) {
    await deps.blobs.delete(blobKey).catch(() => {});
    return { documents: stored.documents, fetched: 0, tender };
  }
  return { documents: stored.documents, fetched: 1, tender };
}

// ───────────── Analyse ─────────────

const KIND_ORDER: Record<TenderDocKind, number> = { bid: 0, atc: 1, boq: 2, other: 3, corrigendum: 4 };

async function loadCompany(db: AppDeps['db'] | Tx, orgId: string) {
  // Sequential: a transaction runs on one connection, so parallel queries would only queue anyway.
  const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.orgId, orgId));
  const pcs = await db.select().from(pastContracts).where(eq(pastContracts.orgId, orgId));
  const vault = await db.select({ id: vaultDocuments.id, type: vaultDocuments.type, title: vaultDocuments.title, expiryDate: vaultDocuments.expiryDate, tags: vaultDocuments.tags })
    .from(vaultDocuments).where(eq(vaultDocuments.orgId, orgId));
  const [org] = await db.select({ scoringWeights: organizations.scoringWeights }).from(organizations).where(eq(organizations.id, orgId));
  return { profile: profile ?? null, pastContracts: pcs, vault, weights: org?.scoringWeights ?? null };
}

export async function latestAnalysis(deps: AppDeps, tenderId: string, orgId: string): Promise<AnalysisRow | null> {
  const [a] = await deps.db.select().from(analyses)
    .where(and(eq(analyses.tenderId, tenderId), eq(analyses.orgId, orgId)))
    .orderBy(desc(analyses.createdAt)).limit(1);
  return a ?? null;
}

type Tx = Parameters<Parameters<AppDeps['db']['transaction']>[0]>[0];

/** Latest analysis with status `done` (FR-029): the result to show and to carry overrides from. */
export async function latestDoneAnalysis(deps: AppDeps, tenderId: string, orgId: string): Promise<AnalysisRow | null> {
  return latestDoneIn(deps.db, tenderId, orgId);
}

async function latestDoneIn(db: AppDeps['db'] | Tx, tenderId: string, orgId: string): Promise<AnalysisRow | null> {
  const [a] = await db.select().from(analyses)
    .where(and(eq(analyses.tenderId, tenderId), eq(analyses.orgId, orgId), eq(analyses.status, 'done')))
    .orderBy(desc(analyses.createdAt)).limit(1);
  return a ?? null;
}

/**
 * Serialises the analysis lifecycle of one org+tender until the transaction ends: starting a run,
 * finishing it (re-reading overrides) and overriding a factor all take it, so none interleave.
 */
const lockAnalyses = (tx: Tx, orgId: string, tenderId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:${tenderId}`}, 0))`);

/** Under the lifecycle lock: `running` rows of this org+tender older than the timeout become failed "timed out" (FR-028). */
const timedOutRuns = (orgId: string, tenderId: string, now: Date) =>
  and(eq(analyses.orgId, orgId), eq(analyses.tenderId, tenderId), eq(analyses.status, 'running'), lte(analyses.createdAt, new Date(now.getTime() - ANALYSIS_RUNNING_TIMEOUT_MS)));

/**
 * The rows are locked in ascending id order first, like markStale does (S1), so expiring several rows can never
 * deadlock with a markStale that locks an overlapping set.
 */
async function expireTimedOutRuns(tx: Tx, orgId: string, tenderId: string, now: Date) {
  const where = timedOutRuns(orgId, tenderId, now);
  const locked = await tx.select({ id: analyses.id }).from(analyses).where(where).orderBy(asc(analyses.id)).for('update');
  if (!locked.length) return;
  const expired = await tx.update(analyses).set({ status: 'failed', error: ANALYSIS_TIMED_OUT, updatedAt: now })
    .where(and(inArray(analyses.id, locked.map((r) => r.id)), eq(analyses.status, 'running')))
    .returning({ id: analyses.id });
  // 008/FR-037: a run that died before releasing its unfilled AI reservation does not keep the slot (review NIT-a).
  await releaseAbandonedReservations(tx, orgId, expired.map((r) => r.id));
}

/** A `running` analysis older than this is treated as failed ("timed out") (FR-028). */
export const ANALYSIS_RUNNING_TIMEOUT_MS = 2 * 60 * 1000;
export const ANALYSIS_TIMED_OUT = 'timed out';

/** A late finisher whose row was already marked timed out (and maybe replaced) by a newer request. */
const supersededError = () => new HttpError(409, 'analysis_superseded', 'This analysis took too long and was replaced. Reload to see the latest result.');

/**
 * A first-ever analysis whose `running` row has timed out (S3): reported as failed so the page offers
 * "Try again" instead of showing "in progress" forever. Other rows are returned as they are.
 */
export function shownAnalysisDto(shown: AnalysisRow, lastAttempt: AnalysisDto['lastAttempt'], docs?: DocRow[]): AnalysisDto {
  const dto = toAnalysisDto(shown, docs);
  if (shown.status === 'running' && lastAttempt?.status === 'failed') return { ...dto, status: 'failed', error: lastAttempt.error };
  return dto;
}

/**
 * `lastAttempt` for GET …/analysis (FR-029): set when the latest row is not the one shown (a newer
 * running/failed attempt) or when no done analysis exists yet. A `running` row older than the
 * timeout is reported as failed "timed out" even before the next analyse request marks it.
 */
export function lastAttemptOf(latest: AnalysisRow, shown: AnalysisRow, now: Date): AnalysisDto['lastAttempt'] {
  if (latest.status !== 'running' && latest.status !== 'failed') return undefined;
  if (latest.id !== shown.id || shown.status !== 'done') {
    const timedOut = latest.status === 'running' && now.getTime() - latest.createdAt.getTime() >= ANALYSIS_RUNNING_TIMEOUT_MS;
    return {
      status: timedOut ? 'failed' : latest.status,
      error: timedOut ? ANALYSIS_TIMED_OUT : latest.error ?? null,
      at: iso(latest.status === 'failed' ? latest.updatedAt : latest.createdAt),
    };
  }
  return undefined;
}

function overridesOf(a: AnalysisRow | null): Record<string, FactorOverride> {
  const out: Record<string, FactorOverride> = {};
  for (const f of a?.factors ?? []) if (f.overridden) out[f.key] = f.overridden;
  return out;
}

/** LLM limits of one analysis (008/FR-031); tests override them. */
export interface LlmBudgetLimits { maxCalls: number; maxChars: number; callTimeoutMs: number; budgetMs: number }
export const DEFAULT_LLM_BUDGET: LlmBudgetLimits = {
  maxCalls: MAX_LLM_CALLS_PER_ANALYSIS, maxChars: MAX_LLM_INPUT_CHARS, callTimeoutMs: LLM_CALL_TIMEOUT_MS, budgetMs: ANALYSIS_BUDGET_MS,
};
/** Time kept free after the last LLM call for scoring and the final write (FR-028, FR-031). */
export const LLM_FINISH_RESERVE_MS = 30_000;
/** A document gets an LLM call only when at least this much of its text still fits the character budget. */
const MIN_LLM_DOC_CHARS = 2_000;
/** Reserve per page for the "=== Page N ===" header around the page text. */
const PAGE_HEADER_CHARS = 24;

/** Merge touching or overlapping inclusive page ranges: [[5,8],[9,12]] → [[5,12]]. */
function coalesceRanges(ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const prev = out[out.length - 1];
    if (prev && a <= prev[1] + 1) prev[1] = Math.max(prev[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Run `call` with an AbortSignal that fires after `ms`: the provider request is aborted (review S3), and the race
 * also rejects at once in case the client ignores the signal.
 */
export function withTimeout<T>(call: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`LLM call timed out after ${Math.round(ms / 1000)} s`);
      ctrl.abort(err);
      reject(err);
    }, Math.max(0, ms));
  });
  return Promise.race([call(ctrl.signal), expired]).finally(() => clearTimeout(timer));
}

/**
 * 008/FR-072 shared extraction cache — tenant isolation: ONLY documents fetched from GeM (`org_id IS NULL`, public data
 * every org sees) are ever cached or reused. An org's own upload is never written to or read from the cache, so no
 * requirement derived from one tenant's document can appear in another tenant's analysis.
 */
export function cachedExtraction(d: Pick<DocRow, 'orgId' | 'requirements' | 'extractorVersion' | 'extractedMethod'>): Requirement[] | null {
  if (d.orgId !== null) return null;
  if (d.extractedMethod !== 'LLM' || d.extractorVersion !== CURRENT_EXTRACTOR_VERSION || !Array.isArray(d.requirements)) return null;
  return d.requirements;
}

/** Longest the analysis waits for the cache write; past it the write may still land, but the analysis goes on. */
export const STORE_EXTRACTION_TIMEOUT_MS = 2_000;

/**
 * Write the shared extraction (org-null documents only). Concurrent misses on the same document — two orgs analysing
 * it at once — both call the LLM and both write; the last write wins. Both replies were produced from the same public
 * text at the same extractor version, so either is a valid cache entry; the race only costs one extra LLM call.
 */
async function storeExtraction(deps: AppDeps, d: DocRow, llmRequirements: Requirement[]): Promise<void> {
  if (d.orgId !== null) return; // never cache an org's own document (see cachedExtraction)
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const write = deps.db.update(tenderDocuments).set({
      requirements: llmRequirements, extractorVersion: CURRENT_EXTRACTOR_VERSION, extractedAt: deps.clock.now(), extractedMethod: 'LLM',
    }).where(and(eq(tenderDocuments.id, d.id), isNull(tenderDocuments.orgId))).execute();
    write.catch(() => {}); // a rejection after the timeout below is not unhandled
    await Promise.race([write, new Promise<never>((_r, reject) => {
      timer = setTimeout(() => reject(new Error(`cache write took longer than ${STORE_EXTRACTION_TIMEOUT_MS} ms`)), STORE_EXTRACTION_TIMEOUT_MS);
    })]);
  } catch (e) {
    // The cache is an optimisation: failing to write it must not fail the analysis.
    deps.logger.warn('analyse: could not store the shared extraction', { documentId: d.id, error: (e as Error).message });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The analysis whose id automatic OCR reserved its slot under was never inserted (409/422/402 after OCR). Review N1:
 * if OCR text was stored, that text was paid for, so its rows keep holding a slot of their own — they move to a fresh
 * `analysis_ref`, exactly like a manual OCR run. If nothing was stored, the slot is given back: an unfilled reservation
 * is released (`finish()`, which waits for a call still in flight) and the metered rows keep their tokens but lose their
 * `analysis_ref` (review S2); the failed-OCR marker and the analyse rate limit keep this from becoming a loop of free
 * OCR. Rows already linked to an analysis (`analysis_id` set) are never touched. Never throws.
 */
async function settleOrphanOcrSlot(deps: AppDeps, orgId: string, analysisRef: string, ocr: AutoOcrResult, handedOver: string | null): Promise<void> {
  if (!ocr.slot) return;
  const ours = and(eq(llmUsage.orgId, orgId), eq(llmUsage.analysisRef, analysisRef), isNull(llmUsage.analysisId));
  try {
    if (ocr.stored > 0) {
      await deps.db.update(llmUsage).set({ analysisRef: crypto.randomUUID() }).where(ours);
      return;
    }
    await ocr.slot.meter.finish();
    if (handedOver) await deps.db.delete(llmUsage).where(and(eq(llmUsage.id, handedOver), eq(llmUsage.reserved, true)));
    await deps.db.update(llmUsage).set({ analysisRef: null }).where(ours);
  } catch (e) {
    deps.logger.error('analyse: could not settle the OCR usage of an analysis that did not start', { orgId, analysisRef, error: (e as Error).message });
  }
}

export async function analyseTender(
  deps: AppDeps, input: { orgId: string; userId: string; tenderId: string; viewer: TenderViewer },
  /**
   * `llmBudgetMs` is shorthand for `llmBudget.budgetMs`. `withTimeout` is a test seam: a fake can advance the
   * clock by the time it is given instead of waiting it out.
   */
  opts: { llmBudget?: Partial<LlmBudgetLimits>; llmBudgetMs?: number; withTimeout?: typeof withTimeout } = {},
): Promise<{ analysis: AnalysisRow; documents: DocRow[] }> {
  // 008/FR-031's 120 s overall budget is wall-clock from the request, so a slow GeM auto-fetch counts too (review N4).
  // Measured on deps.clock, the same clock as the row's createdAt that the running timeout is judged by.
  const elapsedSince = (t: number) => deps.clock.now().getTime() - t;
  const started = deps.clock.now().getTime();
  const callWithTimeout = opts.withTimeout ?? withTimeout;
  const seen = await getTender(deps, input.tenderId, input.viewer);
  // 008/FR-036: fail fast, before any GeM download (re-checked under the org row lock before the insert).
  await assertWithinPlan(deps, input.orgId, 'analysesPerMonth');
  const docsBefore = await listTenderDocuments(deps, seen.id, input.orgId);
  if (seen.gemBidId || seen.documentUrl) {
    if (!docsBefore.length) {
      try {
        await fetchGemDocuments(deps, input);
      } catch (e) {
        // GeM busy (503) and over-long documents (422) are actionable for the user; anything else falls through.
        if (e instanceof HttpError && (e.status === 503 || e.code === 'document_too_long')) throw e;
        deps.logger.warn('analyse: auto-fetch of GeM document failed', { tenderId: seen.id, error: (e as Error).message });
      }
    } else if (await gemCopyOutdated(deps.db, seen.id, docsBefore.filter((d) => d.orgId === null), { orgId: input.orgId })) {
      // FR-046: a corrigendum changed the document URL after the GeM copy was fetched: pick up the new document too.
      // Any failure (busy GeM, 404, timeout, a document over the page limit, …) falls back to the copies we have
      // (S3); fetchGemDocuments records it, so the next analyse does not retry until a newer corrigendum arrives.
      try {
        await fetchGemDocuments(deps, input);
      } catch (e) {
        deps.logger.warn('analyse: re-fetch of the corrigendum GeM document failed; using the stored copies', {
          tenderId: seen.id, error: (e as Error).message, code: e instanceof HttpError ? e.code : undefined,
        });
      }
    }
  }

  // 008/FR-031: ≤ 8 LLM calls (automatic OCR included), ≤ 480k characters, 60 s per call, 120 s overall; the rest is rules-only.
  const limits = { ...DEFAULT_LLM_BUDGET, ...(opts.llmBudgetMs !== undefined ? { budgetMs: opts.llmBudgetMs } : {}), ...opts.llmBudget };
  // No LLM call starts or runs past this point, so the final write lands a fixed reserve before both the overall
  // budget and the 2-minute running timeout (FR-028): two worst-case slow calls cannot make the run look timed out.
  const llmDeadlineMs = Math.min(limits.budgetMs, ANALYSIS_RUNNING_TIMEOUT_MS) - LLM_FINISH_RESERVE_MS;
  // FR-052: scanned documents are read by the OCR model first (counted in this analysis's call budget and AI slot).
  const analysisId = crypto.randomUUID();
  const ocr = await autoOcr(deps, { ...input, tenderId: seen.id }, analysisId, {
    deadline: started + llmDeadlineMs, callWithTimeout, maxCalls: Math.min(OCR_MAX_CALLS_PER_ANALYSIS, limits.maxCalls),
  });

  // One running analysis per org+tender (FR-028). The advisory lock serialises concurrent requests
  // for the same org+tender until commit, so the check and the insert cannot interleave.
  // The inputs (tender row and documents) are read in this same transaction, under the lifecycle lock and the shared
  // tender-input lock that every writer of those inputs also takes before its write + markStale (S4): a change either
  // committed before this read (and is analysed) or its markStale runs after the running row committed (and flags it,
  // FR-045). Company inputs are read just before the final write and changes to them flag the running row.
  // 008/FR-036/FR-037: the monthly quota is then checked under the org row lock (`SELECT … FOR UPDATE`), so concurrent
  // analyses of one org (any tender) are counted and inserted one at a time and cannot overshoot the limit.
  // Lock order is always advisory (org+tender) → org row. The AI slot is reserved in the same transaction (review S1),
  // after the analyses insert, so the reservation row is born with its `analysis_id` (review NEW-B1).
  // The reservation automatic OCR made and did not use, handed to this analysis's own AI calls (see below).
  let handedOver: string | null = null;
  const begun = await deps.db.transaction(async (tx) => {
    await lockAnalyses(tx, input.orgId, seen.id);
    await lockTenderInputs(tx, seen.id, 'shared');
    const [tender] = await tx.select().from(tenders).where(eq(tenders.id, seen.id));
    if (!tender) throw notFound('Tender');
    const docs = await documentsIn(tx, tender.id, input.orgId);
    if (!docs.length) {
      throw new HttpError(422, 'no_documents', 'Add the bid document first — upload the PDF or fetch it from GeM.');
    }
    // 008/FR-030: scans without a text layer (that OCR did not read) cannot be analysed. Skip them; with nothing
    // readable left → 422 (FR-052: also when automatic OCR failed, with the same message).
    const scanned = docs.filter(needsOcr);
    const readable = docs.filter((d) => !scanned.includes(d));
    if (!readable.length) {
      const ocrFailed = [...ocr.failed, ...ocr.failedBefore];
      throw unprocessable('scanned_document', SCANNED_DOCUMENT_MESSAGE, {
        documents: scanned.map((d) => d.fileName), ...(ocrFailed.length ? { ocrFailed } : {}),
      });
    }
    const notes = scanned.map((d) => (ocr.failed.includes(d.fileName)
      ? `${d.fileName} is a scan without text and AI OCR could not read it — upload the text PDF from GeM or an OCR’d copy.`
      : ocr.failedBefore.includes(d.fileName)
        ? `${d.fileName} is a scan without text and AI OCR could not read it earlier — use “Read with AI (OCR)” on the document to try again, or upload the text PDF.`
      : ocr.busy.includes(d.fileName)
        ? `${d.fileName} is a scan without text that AI OCR is reading right now — analyse again in a few minutes.`
      : ocr.tooLong.includes(d.fileName)
        ? `${d.fileName} is a scan without text and too long to read with AI OCR during an analysis — use “Read with AI (OCR)” on the document, or upload the text PDF.`
        : `${d.fileName} is a scan without text and was not read — upload the text PDF from GeM or an OCR’d copy.`));
    const now = deps.clock.now();
    await expireTimedOutRuns(tx, input.orgId, tender.id, now);
    const scope = and(eq(analyses.orgId, input.orgId), eq(analyses.tenderId, tender.id), eq(analyses.status, 'running'));
    const [running] = await tx.select({ id: analyses.id }).from(analyses).where(scope).limit(1);
    if (running) throw new HttpError(409, 'analysis_running', 'An analysis is already running for this tender');
    const quota = await checkAnalysisQuota(deps, tx, input.orgId);
    const [inserted] = await tx.insert(analyses).values({
      id: analysisId, orgId: input.orgId, tenderId: tender.id, status: 'running', method: 'rules', createdBy: input.userId, createdAt: now, updatedAt: now,
    }).returning();
    // Review N3: whether this analysis may use AI comes from its OWN reservation. Automatic OCR reserved the slot
    // under this id (under the org lock, before its calls), so the quota above already counts it: link its rows and
    // use that slot — its unused reservation, if no OCR call was metered, goes to the enrichment calls. Without OCR,
    // the quota decides and the slot is reserved here, in the same transaction (review S1).
    let llmAllowed: boolean;
    let reservation: string | null = null;
    if (ocr.slot) {
      await tx.update(llmUsage).set({ analysisId: inserted!.id })
        .where(and(eq(llmUsage.orgId, input.orgId), eq(llmUsage.analysisRef, inserted!.id), isNull(llmUsage.analysisId)));
      llmAllowed = true;
      handedOver = ocr.slot.meter.handOver();
      reservation = handedOver;
    } else {
      llmAllowed = quota.llmAllowed;
      if (deps.llm && llmAllowed) reservation = await reserveLlmSlot(deps, tx, { orgId: input.orgId, analysisId: inserted!.id, model: deps.llm.model });
    }
    return { row: inserted!, tender, readable, notes, now, llmAllowed, reservationId: reservation };
  }).catch(async (e) => {
    // The analysis row was never inserted (409 running, 422, 402, …): see settleOrphanOcrSlot (reviews S2, N1).
    await settleOrphanOcrSlot(deps, input.orgId, analysisId, ocr, handedOver);
    throw e;
  });
  if (begun.reservationId && !deps.llm) {
    // Automatic OCR's unused slot, and no enrichment model to use it: give it back.
    await releaseLlmReservation(deps, begun.reservationId);
    begun.reservationId = null;
  }
  const { row, tender, readable, notes, now, llmAllowed, reservationId } = begun;
  // Every write to this row from here on is guarded by `status = 'running'`: if a newer request marked
  // it timed out (and maybe replaced it), the late finisher changes nothing and logs nothing (FR-028).
  const ours = and(eq(analyses.id, row.id), eq(analyses.status, 'running'));

  const t0 = performance.now();
  let extractMs = 0;
  let llmMs = 0;
  let pageTotal = 0;
  // Review S4: automatic OCR calls count towards the analysis's call cap (≤ 8 in total) and character budget.
  const llmUse = { calls: ocr.calls, chars: ocr.chars, ocrCalls: ocr.calls, covered: 0, skipped: 0, total: 0, escalated: 0, cached: 0 };
  // FR-051: pages the model did not read (beyond the 4 chunks, or chunks skipped / failed), added to the analysis notes.
  const docNotes: string[] = [];
  // 008/FR-039: one llm_usage row per call, with the provider's token counts; the first metered call fills the reservation.
  const completeJson = deps.llm && llmAllowed
    ? meteredCompleteJson(deps, { orgId: input.orgId, analysisId: row.id, kind: 'extract', reservationId })
    : null;
  // FR-050: the escalation tier, metered like any call (same analysis, so it is not a second AI analysis for the quota).
  const escalationLlm = completeJson ? deps.llmFor('escalation') : null;
  const escCompleteJson = escalationLlm
    ? meteredCompleteJson({ ...deps, llm: escalationLlm }, { orgId: input.orgId, analysisId: row.id, kind: 'extract' })
    : null;
  try {
    const ordered = [...readable].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.createdAt.getTime() - b.createdAt.getTime());
    const perDoc: Requirement[][] = [];
    let usedLlm = false;
    for (const d of ordered) {
      const tx0 = performance.now();
      const pages = splitPages(d.text);
      if (!pages.length) continue;
      pageTotal += pages.length;
      llmUse.total++;
      const meta = { documentId: d.id, fileName: d.fileName, estimatedValue: tender.estimatedValue };
      // FR-052: what is read from OCR text is marked `source.ocr` and capped at 0.8 confidence.
      const provenance = (reqs: Requirement[]) => (d.textSource === 'ocr' ? markOcrRequirements(reqs) : reqs);
      const rules = extractRequirementsRules(pages, meta);
      extractMs += performance.now() - tx0;
      // 008/FR-072: a GeM-public document already extracted at the current version is reused — no LLM call. This runs
      // BEFORE the "is an LLM available" check on purpose: a cache hit costs nothing and is public data, so it is never
      // metered or quota-gated — an org without LLM access (no client, or the monthly AI quota used up: FR-037) still gets it.
      // The cached items are the WHOLE document's extraction (every chunk read; see the store below), so nothing is unread.
      // OCR-derived text (FR-052) never uses or fills the cache: its extraction must carry OCR provenance and the OCR
      // text replaced the row's text after any earlier extraction, so a shared entry could be stale.
      const cacheEligible = d.textSource !== 'ocr';
      const cached = cacheEligible ? cachedExtraction(d) : null;
      if (cached) { perDoc.push(provenance(mergeRequirements(rules, cached))); usedLlm = true; llmUse.covered++; llmUse.cached++; continue; }
      // 008/FR-037: no LLM, or the monthly AI quota used up → this document runs on rules only.
      if (!completeJson) { perDoc.push(provenance(rules)); continue; }
      // FR-051: page-aligned chunks of ≤ 60k characters, at most 4 per document; each is one call under the analysis budget.
      const { chunks, unreadFromPage } = chunkPages(pages);
      const src = { documentId: d.id, fileName: d.fileName };
      let current = rules;
      const llmItems: Requirement[] = [];
      const unread: [number, number][] = unreadFromPage ? [[unreadFromPage, pages.length]] : [];
      const lastChunkPage = chunks.length ? chunks[chunks.length - 1]!.startPage + chunks[chunks.length - 1]!.pages.length - 1 : 0;
      const partly: [number, number][] = [];
      let readAny = false;
      let attempted = false;
      let complete = true;
      // 008/FR-072: shareable only when the first chunk's reply was cacheable (a valid, non-empty requirements array) and
      // every later chunk's reply was a valid array — possibly empty: its pages may simply have no requirements (review S5).
      let allCacheable = true;
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci]!;
        const last = chunk.startPage + chunk.pages.length - 1;
        const elapsed = elapsedSince(started);
        const remaining = limits.maxChars - llmUse.chars;
        const chunkBudget = remaining - promptChars(buildLlmPrompt([], current)) - PAGE_HEADER_CHARS * chunk.pages.length;
        const fits = chunkBudget >= Math.min(MIN_LLM_DOC_CHARS, chunk.pages.join('').length)
          && promptChars(buildLlmPrompt(chunk.pages, current, chunkBudget, chunk.startPage)) <= remaining;
        if (llmUse.calls >= limits.maxCalls || elapsed >= llmDeadlineMs || !fits) {
          // Budget gone: this chunk and the ones after it stay with the rules.
          complete = false;
          unread.push([chunk.startPage, lastChunkPage]);
          break;
        }
        attempted = true;
        llmUse.calls++;
        const timeoutMs = Math.min(limits.callTimeoutMs, llmDeadlineMs - elapsed);
        const tl0 = performance.now();
        const r = await enrichWithLlm(chunk.pages, current, (req) => callWithTimeout((signal) => completeJson({ ...req, signal }), timeoutMs), src, { maxChars: chunkBudget, startPage: chunk.startPage });
        llmMs += performance.now() - tl0;
        llmUse.chars += r.inputChars;
        if (r.error) deps.logger.warn('analyse: LLM enrichment failed; using rules only', { tenderId: tender.id, error: r.error });
        // A chunk cut short — by this analysis' remaining character budget, or a single page longer than the 60,000-character
        // chunk limit (review S5) — is not a whole read of it → never shared, and noted as partly read.
        const whole = chunk.pages.reduce((n, p) => n + pageChars(p), 0) <= MAX_CHUNK_CHARS
          && promptChars(buildLlmPrompt(chunk.pages, current, chunkBudget, chunk.startPage)) === promptChars(buildLlmPrompt(chunk.pages, current, undefined, chunk.startPage));
        if (!(ci === 0 ? r.cacheable : r.valid) || !whole) allCacheable = false;
        if (r.used) {
          readAny = true; current = r.requirements; llmItems.push(...r.llmItems);
          if (!whole) partly.push([chunk.startPage, last]);
        } else { complete = false; unread.push([chunk.startPage, last]); }
      }
      // 008/FR-072: share the extraction only when the WHOLE document was read in this pass — every chunk read and
      // cacheable, none skipped / failed / truncated, no pages beyond the chunk cap. The stored items are the union of
      // the chunks' own items (deduped by the merge rules), the same thing a cache hit merges with the rules. The
      // escalation tier below is per analysis and never stored. storeExtraction only writes GeM-public (org-null) rows.
      if (cacheEligible && complete && readAny && allCacheable && unreadFromPage === undefined && unread.length === 0 && llmItems.length) {
        await storeExtraction(deps, d, mergeRequirements([], llmItems));
      }
      if (!attempted) llmUse.skipped++;
      if (readAny && unread.length) {
        for (const [from, to] of coalesceRanges(unread)) docNotes.push(unreadPagesNote(d.fileName, from, to));
      }
      for (const [from, to] of partly) docNotes.push(partlyReadPagesNote(d.fileName, from, to));
      // FR-050: a blocking requirement the rules are unsure about (or that the model contradicts) goes to the escalation model.
      if (escCompleteJson) {
        const cands = escalationCandidates(rules, llmItems);
        const elapsed = elapsedSince(started);
        if (cands.length && llmUse.calls < limits.maxCalls && elapsed < llmDeadlineMs
          && promptChars(buildEscalationPrompt(pages, cands)) <= limits.maxChars - llmUse.chars) {
          llmUse.calls++;
          llmUse.escalated++;
          const timeoutMs = Math.min(limits.callTimeoutMs, llmDeadlineMs - elapsed);
          const tl0 = performance.now();
          const e = await escalateWithLlm(pages, current, rules, llmItems, (req) => callWithTimeout((signal) => escCompleteJson({ ...req, signal }), timeoutMs), src);
          llmMs += performance.now() - tl0;
          llmUse.chars += e.inputChars;
          if (e.error) deps.logger.warn('analyse: LLM escalation failed; keeping the earlier result', { tenderId: tender.id, error: e.error });
          if (e.used) { current = e.requirements; readAny = true; }
        }
      }
      if (complete && readAny) llmUse.covered++;
      usedLlm ||= readAny;
      perDoc.push(provenance(current));
    }
    // Any document the LLM did not cover — skipped for budget, or a call that failed/timed out — gets the caveat (S4).
    // 008/FR-037: with the monthly AI quota used up, no document went to the LLM — say why instead, unless every document
    // was served from the shared extraction cache (FR-072): then the quota cost this analysis nothing and there is no gap.
    const warnings: AnalysisWarning[] = !deps.llm ? []
      : !llmAllowed ? (llmUse.covered === llmUse.total ? [] : [{ code: 'llm_quota_reached' }])
      : llmUse.covered < llmUse.total ? [{ code: 'llm_budget_exhausted', covered: llmUse.covered, total: llmUse.total }]
      : [];
    if (deps.llm && llmAllowed) deps.logger.info('analyse: llm budget', { tenderId: tender.id, ...llmUse, ms: elapsedSince(started) });
    const ts0 = performance.now();
    const requirements = combineRequirements(perDoc, requirementsFromListing(tender));
    const company = await loadCompany(deps.db, input.orgId);
    const checklist = buildChecklist(requirements, company.profile);
    const prefix = documentCheckPrefix(ordered, tender.bidNumber);
    // Overrides are read under the lifecycle lock, right before the write, from the latest DONE
    // analysis (a failed attempt has no factors, FR-029): an override saved while this run was going
    // is carried over, and one arriving now waits for this commit and then sees the newer analysis.
    const finished = await deps.db.transaction(async (tx) => {
      await lockAnalyses(tx, input.orgId, tender.id);
      const previous = await latestDoneIn(tx, tender.id, input.orgId);
      const result = scoreTender({
        requirements, profile: company.profile, pastContracts: company.pastContracts, vaultDocs: company.vault,
        tender: { endAt: tender.endAt, state: tender.state, emdAmount: tender.emdAmount, title: tender.title, category: tender.category, items: tender.items }, weights: company.weights, now,
        overrides: overridesOf(previous),
      });
      const [done] = await tx.update(analyses).set({
        status: 'done', method: usedLlm ? 'rules+llm' : 'rules', requirements, factors: result.factors, checklist,
        score: result.score, confidence: result.confidence, verdict: result.verdict, summary: withPrefix(prefix, result.summary), error: null,
        // FR-045: a change made while this run was going (markStale flags running rows) keeps it stale.
        ...keepStaleOnCompletion(),
        notes: [...notes, ...docNotes], warnings, updatedAt: deps.clock.now(),
      }).where(ours).returning();
      return done ?? null;
    });
    if (!finished) {
      deps.logger.warn('analyse: run finished after it was marked timed out; result discarded', { tenderId: tender.id, analysisId: row.id });
      throw supersededError();
    }
    const scoreMs = performance.now() - ts0;
    // NFR-001: stage timings (ms) so slow stages are visible without a profiler.
    const timing = {
      extract_ms: Math.round(extractMs), llm_ms: Math.round(llmMs), score_ms: Math.round(scoreMs),
      total_ms: Math.round(performance.now() - t0), pages: pageTotal, docs: ordered.length,
    };
    deps.logger.info('analyse: done', { tenderId: tender.id, analysisId: row.id, method: finished.method, ...timing });
    await logActivity(deps.db, {
      orgId: input.orgId, userId: input.userId, action: 'tender.analysed', entityType: 'tender', entityId: tender.id,
      meta: { analysisId: row.id, score: finished.score, verdict: finished.verdict, method: finished.method, bidNumber: tender.bidNumber, ...timing },
    });
    return { analysis: finished, documents: ordered };
  } catch (e) {
    if (e instanceof HttpError && e.code === 'analysis_superseded') throw e;
    deps.logger.error('analyse: failed', { tenderId: tender.id, error: (e as Error).message });
    const marked = await deps.db.update(analyses).set({ status: 'failed', error: (e as Error).message.slice(0, 500), updatedAt: deps.clock.now() })
      .where(ours).returning({ id: analyses.id });
    if (!marked.length) throw supersededError();
    throw new HttpError(500, 'analysis_failed', 'The analysis failed. Please try again; if it keeps failing, upload a cleaner PDF.');
  } finally {
    // 008/FR-037: an analysis with no metered LLM call (documents skipped for budget, provider unreachable, or it failed
    // first) is not an AI analysis — the meter gives the reserved slot back; a metered one keeps it, even when the
    // analysis row was deleted meanwhile (review NEW-B1).
    await completeJson?.finish();
    await escCompleteJson?.finish();
  }
}

// ───────────── Override (FR-016) ─────────────

export async function overrideFactor(
  deps: AppDeps,
  input: { orgId: string; userId: string; userName: string; analysisId: string } & OverrideFactorInput,
): Promise<AnalysisRow> {
  const [found] = await deps.db.select({ tenderId: analyses.tenderId }).from(analyses).where(and(eq(analyses.id, input.analysisId), eq(analyses.orgId, input.orgId)));
  if (!found) throw notFound('Analysis');
  // Under the lifecycle lock so a run finishing now either sees this override or has already
  // committed its newer analysis, in which case this one is refused rather than silently lost (FR-029).
  const { a, factor, from, r, updated } = await deps.db.transaction(async (tx) => {
    await lockAnalyses(tx, input.orgId, found.tenderId);
    const [a] = await tx.select().from(analyses).where(and(eq(analyses.id, input.analysisId), eq(analyses.orgId, input.orgId)));
    if (!a) throw notFound('Analysis');
    if (a.status !== 'done') throw new HttpError(409, 'conflict', 'Only a completed analysis can be overridden');
    const factor = a.factors.find((f) => f.key === input.factorKey);
    if (!factor) throw new HttpError(404, 'not_found', `Factor "${input.factorKey}" is not part of this analysis`);
    const [newer] = await tx.select({ id: analyses.id }).from(analyses).where(and(
      eq(analyses.orgId, input.orgId), eq(analyses.tenderId, a.tenderId), eq(analyses.status, 'done'), gt(analyses.createdAt, a.createdAt),
    )).limit(1);
    if (newer) throw new HttpError(409, 'analysis_replaced', 'A newer analysis has replaced this one. Reload and apply the override again.');
    const from = effectiveStatus(factor);
    const at = deps.clock.now().toISOString();
    const factors: ScoreFactor[] = a.factors.map((f) => {
      if (f.key !== input.factorKey) return f;
      const { overridden: _drop, ...rest } = f;
      return input.status === f.status ? rest : { ...rest, overridden: { status: input.status, reason: input.reason, by: input.userName, at } };
    });
    const r = computeScore(factors);
    const prefix = matchCheckPrefix(a.summary) ?? '';
    const [updated] = await tx.update(analyses).set({
      factors, score: r.score, confidence: r.confidence, verdict: r.verdict, summary: withPrefix(prefix, r.summary), updatedAt: deps.clock.now(),
    }).where(eq(analyses.id, a.id)).returning();
    return { a, factor, from, r, updated };
  });
  await logActivity(deps.db, {
    orgId: input.orgId, userId: input.userId, action: 'analysis.factor_overridden', entityType: 'tender', entityId: a.tenderId,
    meta: { analysisId: a.id, factorKey: input.factorKey, label: factor.label, from, to: input.status, reason: input.reason, score: r.score, verdict: r.verdict },
  });
  return updated;
}

// ───────────── Re-score (FR-037) ─────────────

/**
 * Recomputes factors and checklist of a completed analysis from its stored requirements against the
 * CURRENT profile, vault and weights, without re-reading documents. Overrides are kept, the stale flag
 * is cleared. Same lifecycle lock as a run / an override, so it never interleaves with either.
 *
 * Only a company-side change (profile/vault/weights) can be fixed this way: an analysis stale for a
 * corrigendum or a document change (or with no recorded reason) answers 409 `reanalysis_required`.
 * The row is locked FOR UPDATE before it is read (with the timed-out runs we expire, in id order, S1): markStale
 * (which does not take the advisory lock) then either committed before our read, so we see its reason, or waits
 * for our commit and re-flags the row afterwards, so a
 * change racing with the re-score is never lost (S3). That is why the flag is cleared unconditionally here,
 * unlike a run's completion (FR-045, `keepStaleOnCompletion`): nothing can flag this row between our read and
 * our write, and comparing with `created_at` would be wrong anyway (a re-scored row's own change is newer).
 */
export async function rescoreAnalysis(
  deps: AppDeps,
  input: { orgId: string; userId: string; analysisId: string; viewer: TenderViewer },
): Promise<AnalysisRow> {
  const [found] = await deps.db.select({ tenderId: analyses.tenderId }).from(analyses).where(and(eq(analyses.id, input.analysisId), eq(analyses.orgId, input.orgId)));
  if (!found) throw notFound('Analysis');
  const tender = await getTender(deps, found.tenderId, input.viewer);
  const now = deps.clock.now();
  const { a, updated } = await deps.db.transaction(async (tx) => {
    await lockAnalyses(tx, input.orgId, tender.id);
    // Lock our row together with the timed-out running rows we are about to expire, in ascending id order (S1): the
    // same order markStale locks in, so the two cannot deadlock whichever ids they share.
    const mine = and(eq(analyses.id, input.analysisId), eq(analyses.orgId, input.orgId));
    await tx.select({ id: analyses.id }).from(analyses).where(or(mine, timedOutRuns(input.orgId, tender.id, now))).orderBy(asc(analyses.id)).for('update');
    await expireTimedOutRuns(tx, input.orgId, tender.id, now);
    const [a] = await tx.select().from(analyses).where(mine);
    if (!a) throw notFound('Analysis');
    if (a.status !== 'done') throw new HttpError(409, 'conflict', 'Only a completed analysis can be re-scored');
    const [running] = await tx.select({ id: analyses.id }).from(analyses).where(and(
      eq(analyses.orgId, input.orgId), eq(analyses.tenderId, tender.id), eq(analyses.status, 'running'), gt(analyses.createdAt, a.createdAt),
    )).limit(1);
    if (running) throw new HttpError(409, 'analysis_running', 'An analysis is running for this tender. Wait for it to finish.');
    const [newer] = await tx.select({ id: analyses.id }).from(analyses).where(and(
      eq(analyses.orgId, input.orgId), eq(analyses.tenderId, tender.id), eq(analyses.status, 'done'), gt(analyses.createdAt, a.createdAt),
    )).limit(1);
    if (newer) throw new HttpError(409, 'analysis_replaced', 'A newer analysis has replaced this one. Reload to see it.');
    if (a.stale && !isRescorableReason(a.staleReason)) throw reanalysisRequired(a.staleReason);
    const company = await loadCompany(tx, input.orgId);
    const result = scoreTender({
      requirements: a.requirements, profile: company.profile, pastContracts: company.pastContracts, vaultDocs: company.vault,
      tender: { endAt: tender.endAt, state: tender.state, emdAmount: tender.emdAmount, title: tender.title, category: tender.category, items: tender.items },
      weights: company.weights, now, overrides: overridesOf(a),
    });
    const prefix = matchCheckPrefix(a.summary) ?? '';
    const [updated] = await tx.update(analyses).set({
      factors: result.factors, checklist: buildChecklist(a.requirements, company.profile), score: result.score, confidence: result.confidence,
      verdict: result.verdict, summary: withPrefix(prefix, result.summary), stale: false, staleReason: null, staleAt: null, updatedAt: now,
    }).where(eq(analyses.id, a.id)).returning();
    return { a, updated };
  });
  await logActivity(deps.db, {
    orgId: input.orgId, userId: input.userId, action: 'analysis.rescored', entityType: 'tender', entityId: a.tenderId,
    meta: { analysisId: a.id, from: a.score, score: updated.score, verdict: updated.verdict, reason: a.staleReason },
  });
  return updated;
}

const REANALYSIS_COPY: Partial<Record<StaleReason, string>> = {
  corrigendum: 'A corrigendum changed this bid after it was analysed.',
  document_added: 'A document was added since this analysis.',
  document_removed: 'A document was removed since this analysis.',
};

function reanalysisRequired(reason: StaleReason | null): HttpError {
  const why = (reason && REANALYSIS_COPY[reason]) ?? 'This analysis is out of date.';
  return new HttpError(409, 'reanalysis_required', `${why} Re-score cannot pick that up; re-analyse the tender instead.`);
}

// ───────────── Scoring weights ─────────────

export function weightsResponse(stored: Record<string, number> | null | undefined): ScoringWeights {
  return { weights: resolveWeights(stored), defaults: { ...DEFAULT_WEIGHTS }, custom: !!stored && Object.keys(stored).length > 0 };
}

function sameWeights(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => a[k] === b[k]);
}

export async function saveWeights(deps: AppDeps, input: { orgId: string; userId: string; weights: Record<string, number | undefined> }): Promise<ScoringWeights> {
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(input.weights)) if (typeof v === 'number') clean[k] = v;
  const stored = Object.keys(clean).length ? resolveWeights(clean) : null;
  // Save, activity entry and stale flags commit together (S2); the org row is locked so `changed` compares with
  // what this save replaces.
  await deps.db.transaction(async (tx) => {
    const [before] = await tx.select({ scoringWeights: organizations.scoringWeights }).from(organizations).where(eq(organizations.id, input.orgId)).for('update');
    const changed = !sameWeights(resolveWeights(before?.scoringWeights), resolveWeights(stored));
    await tx.update(organizations).set({ scoringWeights: stored }).where(eq(organizations.id, input.orgId));
    await logActivity(tx, { orgId: input.orgId, userId: input.userId, action: 'org.scoring_weights_updated', entityType: 'organization', entityId: input.orgId, meta: { weights: stored } });
    // Existing results of open tenders were scored with the old weights (FR-044): flag them so the banner
    // offers Re-score. Closed tenders keep their historical result; a save that changes nothing flags nothing.
    if (changed) await markStale(tx, { orgId: input.orgId, openOnly: true }, 'weights_changed', deps.clock.now());
  });
  return weightsResponse(stored);
}
