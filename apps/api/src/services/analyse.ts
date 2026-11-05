/**
 * Analyse service (T045; FR-010..FR-016). Pure-ish orchestration over the DB, blob store, GeM
 * client and (optional) LLM. Routes in routes/analysis.ts are thin wrappers.
 *
 *   uploadTenderDocument → store PDF under tenders/<tenderId>/<orgId>/…, extract text per page
 *   fetchGemDocuments    → download /showbidDocument/<gemBidId> once (public, org_id null)
 *   removeTenderDocument → delete the org's own upload (blob + row), mark the analysis stale
 *   analyseTender        → rules (+ LLM when configured) → score → checklist → analyses row
 *   overrideFactor       → audited manual status change + re-score
 */
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import {
  analyses, companyProfiles, organizations, pastContracts, tenderDocuments, tenders, vaultDocuments,
  type Requirement, type ScoreFactor,
} from '@tp/db';
import { buildChecklist } from '@tp/core/analyse/checklist';
import { buildLlmPrompt, enrichWithLlm, promptChars } from '@tp/core/analyse/llm';
import {
  PdfPageLimitError, PdfTextError, extractPages, isPdf, isScannedDocument, joinPages, looksScanned, splitPages,
} from '@tp/core/analyse/pdf-text';
import { matchCheckPrefix } from '@tp/core/analyse/check-prefix';
import { combineRequirements, detectBidNumber, extractRequirementsRules, normalizeBidNumber, requirementsFromListing } from '@tp/core/analyse/rules';
import { computeScore, effectiveStatus, resolveWeights, scoreTender, DEFAULT_WEIGHTS, type FactorOverride } from '@tp/core/analyse/score';
import {
  ANALYSIS_BUDGET_MS, GEM_LEASE_MAX_WAIT_MS, LLM_CALL_TIMEOUT_MS, MAX_LLM_CALLS_PER_ANALYSIS, MAX_LLM_INPUT_CHARS, MAX_TENDER_DOC_PAGES,
  SCANNED_EMPTY_PAGE_RATIO,
} from '@tp/core/contracts/caps';
import {
  MAX_TENDER_DOC_BYTES, type AnalysisDto, type AnalysisWarning, type OverrideFactorInput, type ScoringWeights, type TenderDocKind, type TenderDocumentDto,
  type TenderDocumentWarning,
} from '@tp/core/contracts/analyse';
import { GemClient, GemError } from '@tp/core/gem/client';
import type { AppDeps } from '../deps';
import { logActivity } from '../lib/activity';
import { HttpError, forbidden, notFound, unprocessable } from '../lib/errors';
import { canSeeTender, type TenderViewer } from '../lib/tender-scope';
import { markStale } from './staleness';

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
    pageCount: d.pageCount, sourceUrl: d.sourceUrl, hasText: !!d.text && d.text.replace(/\s+/g, '').length > 0,
    source: d.orgId ? 'upload' : 'gem', textSource: d.textSource, bidNumberFound: bidNumberMismatch(d, tenderBidNumber),
    createdAt: iso(d.createdAt),
  };
}

/** Upload warnings (non-blocking): currently only a bid-number mismatch. */
export function uploadWarnings(dto: TenderDocumentDto): TenderDocumentWarning[] {
  return dto.bidNumberFound ? [{ code: 'bid_number_mismatch', found: dto.bidNumberFound }] : [];
}

export function toAnalysisDto(a: AnalysisRow, docs?: DocRow[]): AnalysisDto {
  return {
    id: a.id, orgId: a.orgId, tenderId: a.tenderId, status: a.status, method: a.method,
    requirements: a.requirements, factors: a.factors, checklist: a.checklist,
    score: a.score, confidence: a.confidence, verdict: a.verdict, summary: a.summary, error: a.error, stale: a.stale,
    staleReason: a.staleReason ?? null, staleAt: a.staleAt ? iso(a.staleAt) : null, notes: a.notes ?? [], warnings: a.warnings ?? [],
    createdBy: a.createdBy, createdAt: iso(a.createdAt), updatedAt: iso(a.updatedAt),
    ...(docs ? { documents: docs.map((d) => ({ id: d.id, fileName: d.fileName, kind: d.kind, pageCount: d.pageCount })) } : {}),
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
  return deps.db.select().from(tenderDocuments)
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
  `This document has ${pages} pages. TenderPilot reads up to ${MAX_TENDER_DOC_PAGES} pages — upload the bid document and ATC separately.`;
export const SCANNED_DOCUMENT_MESSAGE = 'This PDF is a scan without text. Upload the text PDF from GeM or an OCR’d copy.';

/** Extract text per page; > MAX_TENDER_DOC_PAGES pages → 422 `document_too_long` before any text is read. */
async function extractOrThrow(bytes: Uint8Array): Promise<string[]> {
  try {
    return await extractPages(bytes, { maxPages: MAX_TENDER_DOC_PAGES });
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

export async function uploadTenderDocument(deps: AppDeps, input: UploadInput): Promise<{ doc: DocRow; tender: TenderRow }> {
  const tender = await getTender(deps, input.tenderId, input.viewer);
  const { bytes } = input.file;
  if (bytes.length === 0) throw new HttpError(400, 'bad_request', 'The file is empty');
  if (bytes.length > MAX_TENDER_DOC_BYTES) throw new HttpError(413, 'payload_too_large', 'The file is larger than 25 MB');
  if (!isPdf(bytes)) throw new HttpError(415, 'unsupported_media_type', 'Only PDF files can be analysed. Export the document to PDF and try again.');
  const pages = await extractOrThrow(bytes);
  const id = crypto.randomUUID();
  const fileName = safeName(input.file.name || 'document.pdf');
  const blobKey = `tenders/${input.tenderId}/${input.orgId}/${id}.pdf`;
  await deps.blobs.put(blobKey, bytes, { contentType: 'application/pdf' });
  const [doc] = await deps.db.insert(tenderDocuments).values({
    id, tenderId: input.tenderId, orgId: input.orgId, kind: input.kind, fileName, blobKey,
    sizeBytes: bytes.length, pageCount: pages.length, text: joinPages(pages), sourceUrl: null,
  }).returning();
  await logActivity(deps.db, {
    orgId: input.orgId, userId: input.userId, action: 'tender.document_uploaded', entityType: 'tender', entityId: input.tenderId,
    meta: { documentId: id, fileName, kind: input.kind, pages: pages.length, scanned: looksScanned(pages) },
  });
  await markStale(deps.db, { orgId: input.orgId, tenderIds: [input.tenderId] }, 'document_added', deps.clock.now());
  return { doc, tender };
}

// ───────────── Remove (FR-009) ─────────────

export async function removeTenderDocument(deps: AppDeps, input: { orgId: string; userId: string; tenderId: string; docId: string; viewer: TenderViewer }): Promise<void> {
  await getTender(deps, input.tenderId, input.viewer);
  const doc = await getTenderDocument(deps, input.tenderId, input.docId, input.orgId);
  if (doc.orgId === null) throw forbidden('Documents fetched from GeM are shared and cannot be removed');
  const deleted = await deps.db.delete(tenderDocuments)
    .where(and(eq(tenderDocuments.id, doc.id), eq(tenderDocuments.orgId, input.orgId)))
    .returning({ id: tenderDocuments.id });
  // A concurrent delete already removed it: only one request logs and marks the analysis stale.
  if (!deleted.length) throw notFound('Document');
  try {
    await deps.blobs.delete(doc.blobKey);
  } catch (e) {
    // The row is gone, so the file is unreachable; log and keep going rather than failing the user.
    deps.logger.warn('analyse: blob delete failed after document removal', { tenderId: input.tenderId, blobKey: doc.blobKey, error: (e as Error).message });
  }
  await logActivity(deps.db, {
    orgId: input.orgId, userId: input.userId, action: 'tender.document_removed', entityType: 'tender', entityId: input.tenderId,
    meta: { documentId: doc.id, fileName: doc.fileName, kind: doc.kind },
  });
  await markStale(deps.db, { orgId: input.orgId, tenderIds: [input.tenderId] }, 'document_removed', deps.clock.now());
}

// ───────────── Fetch from GeM ─────────────

export async function fetchGemDocuments(deps: AppDeps, input: { orgId: string; userId: string; tenderId: string; viewer: TenderViewer }): Promise<{ documents: DocRow[]; fetched: number; tender: TenderRow }> {
  const tender = await getTender(deps, input.tenderId, input.viewer);
  const existing = (await listTenderDocuments(deps, tender.id, input.orgId)).filter((d) => d.orgId === null);
  if (existing.length) return { documents: existing, fetched: 0, tender };
  const ref = tender.gemBidId ?? tender.documentUrl;
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
  try {
    got = await client.fetchBidDocument(ref);
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
  const pages = await extractOrThrow(got.bytes);
  const id = crypto.randomUUID();
  const blobKey = `tenders/${tender.id}/gem/${id}.pdf`;
  await deps.blobs.put(blobKey, got.bytes, { contentType: 'application/pdf' });
  const fileName = `${tender.bidNumber.replace(/[^\w-]+/g, '-')}.pdf`;
  const [doc] = await deps.db.insert(tenderDocuments).values({
    id, tenderId: tender.id, orgId: null, kind: 'bid', fileName, blobKey, sizeBytes: got.bytes.length,
    pageCount: pages.length, text: joinPages(pages), sourceUrl: got.url,
  }).returning();
  if (!tender.documentUrl) await deps.db.update(tenders).set({ documentUrl: got.url }).where(eq(tenders.id, tender.id));
  await logActivity(deps.db, {
    orgId: input.orgId, userId: input.userId, action: 'tender.document_fetched', entityType: 'tender', entityId: tender.id,
    meta: { documentId: id, pages: pages.length, sourceUrl: got.url },
  });
  return { documents: [doc], fetched: 1, tender };
}

// ───────────── Analyse ─────────────

const KIND_ORDER: Record<TenderDocKind, number> = { bid: 0, atc: 1, boq: 2, other: 3, corrigendum: 4 };

async function loadCompany(deps: AppDeps, orgId: string) {
  const [[profile], pcs, vault, [org]] = await Promise.all([
    deps.db.select().from(companyProfiles).where(eq(companyProfiles.orgId, orgId)),
    deps.db.select().from(pastContracts).where(eq(pastContracts.orgId, orgId)),
    deps.db.select({ id: vaultDocuments.id, type: vaultDocuments.type, title: vaultDocuments.title, expiryDate: vaultDocuments.expiryDate, tags: vaultDocuments.tags })
      .from(vaultDocuments).where(eq(vaultDocuments.orgId, orgId)),
    deps.db.select({ scoringWeights: organizations.scoringWeights }).from(organizations).where(eq(organizations.id, orgId)),
  ]);
  return { profile: profile ?? null, pastContracts: pcs, vault, weights: org?.scoringWeights ?? null };
}

export async function latestAnalysis(deps: AppDeps, tenderId: string, orgId: string): Promise<AnalysisRow | null> {
  const [a] = await deps.db.select().from(analyses)
    .where(and(eq(analyses.tenderId, tenderId), eq(analyses.orgId, orgId)))
    .orderBy(desc(analyses.createdAt)).limit(1);
  return a ?? null;
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
/** A document gets an LLM call only when at least this much of its text still fits the character budget. */
const MIN_LLM_DOC_CHARS = 2_000;
/** Reserve per page for the "=== Page N ===" header around the page text. */
const PAGE_HEADER_CHARS = 24;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM call timed out after ${Math.round(ms / 1000)} s`)), Math.max(0, ms));
  });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

export async function analyseTender(
  deps: AppDeps, input: { orgId: string; userId: string; tenderId: string; viewer: TenderViewer }, opts: { llmBudget?: Partial<LlmBudgetLimits> } = {},
): Promise<{ analysis: AnalysisRow; documents: DocRow[] }> {
  const tender = await getTender(deps, input.tenderId, input.viewer);
  let docs = await listTenderDocuments(deps, tender.id, input.orgId);
  if (!docs.length && (tender.gemBidId || tender.documentUrl)) {
    try {
      docs = (await fetchGemDocuments(deps, input)).documents;
    } catch (e) {
      // GeM busy (503) and over-long documents (422) are actionable for the user; anything else falls through.
      if (e instanceof HttpError && (e.status === 503 || e.code === 'document_too_long')) throw e;
      deps.logger.warn('analyse: auto-fetch of GeM document failed', { tenderId: tender.id, error: (e as Error).message });
    }
  }
  if (!docs.length) {
    throw new HttpError(422, 'no_documents', 'Add the bid document first — upload the PDF or fetch it from GeM.');
  }
  // 008/FR-030: scans without a text layer cannot be analysed. Skip them; with nothing readable left → 422.
  const scanned = docs.filter((d) => isScannedDocument(splitPages(d.text), SCANNED_EMPTY_PAGE_RATIO));
  const readable = docs.filter((d) => !scanned.includes(d));
  if (!readable.length) throw unprocessable('scanned_document', SCANNED_DOCUMENT_MESSAGE, { documents: scanned.map((d) => d.fileName) });
  const notes = scanned.map((d) => `${d.fileName} is a scan without text and was not read — upload the text PDF from GeM or an OCR’d copy.`);

  const previous = await latestAnalysis(deps, tender.id, input.orgId);
  const now = deps.clock.now();
  const [row] = await deps.db.insert(analyses).values({
    orgId: input.orgId, tenderId: tender.id, status: 'running', method: 'rules', createdBy: input.userId, createdAt: now, updatedAt: now,
  }).returning();

  try {
    const ordered = [...readable].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.createdAt.getTime() - b.createdAt.getTime());
    const perDoc: Requirement[][] = [];
    let usedLlm = false;
    // 008/FR-031: ≤ 2 LLM calls, ≤ 90k characters, 60 s per call, 120 s overall; the rest is rules-only.
    const limits = { ...DEFAULT_LLM_BUDGET, ...opts.llmBudget };
    const started = Date.now();
    const llmUse = { calls: 0, chars: 0, covered: 0, skipped: 0, total: 0 };
    for (const d of ordered) {
      const pages = splitPages(d.text);
      if (!pages.length) continue;
      llmUse.total++;
      const meta = { documentId: d.id, fileName: d.fileName, estimatedValue: tender.estimatedValue };
      const rules = extractRequirementsRules(pages, meta);
      if (!deps.llm) { perDoc.push(rules); continue; }
      const llm = deps.llm;
      const elapsed = Date.now() - started;
      const remaining = limits.maxChars - llmUse.chars;
      const docBudget = remaining - promptChars(buildLlmPrompt([], rules)) - PAGE_HEADER_CHARS * pages.length;
      const fits = docBudget >= Math.min(MIN_LLM_DOC_CHARS, pages.join('').length)
        && promptChars(buildLlmPrompt(pages, rules, docBudget)) <= remaining;
      if (llmUse.calls >= limits.maxCalls || elapsed >= limits.budgetMs || !fits) {
        llmUse.skipped++;
        perDoc.push(rules);
        continue;
      }
      llmUse.calls++;
      const timeoutMs = Math.min(limits.callTimeoutMs, limits.budgetMs - elapsed);
      const r = await enrichWithLlm(pages, rules, (req) => withTimeout(llm.completeJson(req), timeoutMs), { documentId: d.id, fileName: d.fileName }, { maxChars: docBudget });
      llmUse.chars += r.inputChars;
      if (r.error) deps.logger.warn('analyse: LLM enrichment failed; using rules only', { tenderId: tender.id, error: r.error });
      if (r.used) llmUse.covered++;
      usedLlm ||= r.used;
      perDoc.push(r.requirements);
    }
    const warnings: AnalysisWarning[] = llmUse.skipped
      ? [{ code: 'llm_budget_exhausted', covered: llmUse.covered, total: llmUse.total }]
      : [];
    if (deps.llm) deps.logger.info('analyse: llm budget', { tenderId: tender.id, ...llmUse, ms: Date.now() - started });
    const requirements = combineRequirements(perDoc, requirementsFromListing(tender));
    const company = await loadCompany(deps, input.orgId);
    const result = scoreTender({
      requirements, profile: company.profile, pastContracts: company.pastContracts, vaultDocs: company.vault,
      tender: { endAt: tender.endAt, state: tender.state, emdAmount: tender.emdAmount }, weights: company.weights, now,
      overrides: overridesOf(previous),
    });
    const checklist = buildChecklist(requirements, company.profile);
    const summary = withPrefix(documentCheckPrefix(ordered, tender.bidNumber), result.summary);
    const [done] = await deps.db.update(analyses).set({
      status: 'done', method: usedLlm ? 'rules+llm' : 'rules', requirements, factors: result.factors, checklist,
      score: result.score, confidence: result.confidence, verdict: result.verdict, summary, error: null, stale: false,
      notes, warnings, updatedAt: deps.clock.now(),
    }).where(eq(analyses.id, row.id)).returning();
    await logActivity(deps.db, {
      orgId: input.orgId, userId: input.userId, action: 'tender.analysed', entityType: 'tender', entityId: tender.id,
      meta: { analysisId: row.id, score: result.score, verdict: result.verdict, method: done.method, bidNumber: tender.bidNumber },
    });
    return { analysis: done, documents: ordered };
  } catch (e) {
    deps.logger.error('analyse: failed', { tenderId: tender.id, error: (e as Error).message });
    await deps.db.update(analyses).set({ status: 'failed', error: (e as Error).message.slice(0, 500), updatedAt: deps.clock.now() }).where(eq(analyses.id, row.id));
    throw new HttpError(500, 'analysis_failed', 'The analysis failed. Please try again; if it keeps failing, upload a cleaner PDF.');
  }
}

// ───────────── Override (FR-016) ─────────────

export async function overrideFactor(
  deps: AppDeps,
  input: { orgId: string; userId: string; userName: string; analysisId: string } & OverrideFactorInput,
): Promise<AnalysisRow> {
  const [a] = await deps.db.select().from(analyses).where(and(eq(analyses.id, input.analysisId), eq(analyses.orgId, input.orgId)));
  if (!a) throw notFound('Analysis');
  if (a.status !== 'done') throw new HttpError(409, 'conflict', 'Only a completed analysis can be overridden');
  const factor = a.factors.find((f) => f.key === input.factorKey);
  if (!factor) throw new HttpError(404, 'not_found', `Factor "${input.factorKey}" is not part of this analysis`);
  const from = effectiveStatus(factor);
  const at = deps.clock.now().toISOString();
  const factors: ScoreFactor[] = a.factors.map((f) => {
    if (f.key !== input.factorKey) return f;
    const { overridden: _drop, ...rest } = f;
    return input.status === f.status ? rest : { ...rest, overridden: { status: input.status, reason: input.reason, by: input.userName, at } };
  });
  const r = computeScore(factors);
  const prefix = matchCheckPrefix(a.summary) ?? '';
  const [updated] = await deps.db.update(analyses).set({
    factors, score: r.score, confidence: r.confidence, verdict: r.verdict, summary: withPrefix(prefix, r.summary), updatedAt: deps.clock.now(),
  }).where(eq(analyses.id, a.id)).returning();
  await logActivity(deps.db, {
    orgId: input.orgId, userId: input.userId, action: 'analysis.factor_overridden', entityType: 'tender', entityId: a.tenderId,
    meta: { analysisId: a.id, factorKey: input.factorKey, label: factor.label, from, to: input.status, reason: input.reason, score: r.score, verdict: r.verdict },
  });
  return updated;
}

// ───────────── Scoring weights ─────────────

export function weightsResponse(stored: Record<string, number> | null | undefined): ScoringWeights {
  return { weights: resolveWeights(stored), defaults: { ...DEFAULT_WEIGHTS }, custom: !!stored && Object.keys(stored).length > 0 };
}

export async function saveWeights(deps: AppDeps, input: { orgId: string; userId: string; weights: Record<string, number | undefined> }): Promise<ScoringWeights> {
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(input.weights)) if (typeof v === 'number') clean[k] = v;
  const stored = Object.keys(clean).length ? resolveWeights(clean) : null;
  await deps.db.update(organizations).set({ scoringWeights: stored }).where(eq(organizations.id, input.orgId));
  await logActivity(deps.db, { orgId: input.orgId, userId: input.userId, action: 'org.scoring_weights_updated', entityType: 'organization', entityId: input.orgId, meta: { weights: stored } });
  return weightsResponse(stored);
}
