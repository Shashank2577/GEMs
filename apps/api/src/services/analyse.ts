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
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import {
  analyses, companyProfiles, organizations, pastContracts, tenderDocuments, tenders, vaultDocuments,
  type Requirement, type ScoreFactor,
} from '@tp/db';
import { buildChecklist } from '@tp/core/analyse/checklist';
import { enrichWithLlm } from '@tp/core/analyse/llm';
import { PdfTextError, extractPdf, isPdf, joinPages, looksScanned, splitPages } from '@tp/core/analyse/pdf-text';
import { matchCheckPrefix } from '@tp/core/analyse/check-prefix';
import { combineRequirements, detectBidNumber, extractRequirementsRules, normalizeBidNumber, requirementsFromListing } from '@tp/core/analyse/rules';
import { computeScore, effectiveStatus, resolveWeights, scoreTender, DEFAULT_WEIGHTS, type FactorOverride } from '@tp/core/analyse/score';
import {
  MAX_EXTRACT_PAGES, MAX_TENDER_DOC_BYTES, type AnalysisDto, type OverrideFactorInput, type ScoringWeights, type TenderDocKind, type TenderDocumentDto,
  type TenderDocumentWarning,
} from '@tp/core/contracts/analyse';
import { GemClient, GemError } from '@tp/core/gem/client';
import type { AppDeps } from '../deps';
import { logActivity } from '../lib/activity';
import { HttpError, forbidden, notFound } from '../lib/errors';
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
    pageCount: d.pageCount, totalPages: d.totalPages ?? null, sourceUrl: d.sourceUrl, hasText: !!d.text && d.text.replace(/\s+/g, '').length > 0,
    source: d.orgId ? 'upload' : 'gem', textSource: d.textSource, bidNumberFound: bidNumberMismatch(d, tenderBidNumber),
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
    staleReason: a.staleReason ?? null, staleAt: a.staleAt ? iso(a.staleAt) : null, notes: a.notes ?? [],
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

/** Reads at most MAX_EXTRACT_PAGES pages (NFR-005); `totalPages` is the PDF's real page count. */
async function extractOrThrow(bytes: Uint8Array): Promise<{ pages: string[]; totalPages: number }> {
  try {
    return await extractPdf(bytes, { maxPages: MAX_EXTRACT_PAGES });
  } catch (e) {
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
  const [doc] = await deps.db.insert(tenderDocuments).values({
    id, tenderId: input.tenderId, orgId: input.orgId, kind: input.kind, fileName, blobKey,
    sizeBytes: bytes.length, pageCount: pages.length, totalPages, text: joinPages(pages), sourceUrl: null,
  }).returning();
  await logActivity(deps.db, {
    orgId: input.orgId, userId: input.userId, action: 'tender.document_uploaded', entityType: 'tender', entityId: input.tenderId,
    meta: { documentId: id, fileName, kind: input.kind, pages: pages.length, ...(totalPages > pages.length ? { totalPages } : {}), scanned: looksScanned(pages) },
  });
  await markStale(deps.db, { orgId: input.orgId, tenderIds: [input.tenderId] }, 'document_added', deps.clock.now());
  return { doc, tender, totalPages };
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
    maxDocumentBytes: MAX_TENDER_DOC_BYTES,
  });
  let got: { bytes: Uint8Array; url: string };
  try {
    got = await client.fetchBidDocument(ref);
  } catch (e) {
    deps.logger.warn('analyse: GeM document fetch failed', { tenderId: tender.id, error: (e as Error).message });
    const msg = e instanceof GemError && e.code === 'too_large'
      ? 'The GeM document is larger than 25 MB — download it from GeM and upload it here.'
      : e instanceof GemError && e.status === 404
        ? 'GeM no longer serves this bid document. Upload the PDF instead.'
        : 'Could not download the bid document from GeM right now. Try again in a few minutes or upload the PDF.';
    throw new HttpError(502, 'gem_unavailable', msg);
  }
  const { pages, totalPages } = await extractOrThrow(got.bytes);
  if (totalPages > pages.length) deps.logger.warn('analyse: GeM document truncated to the page cap', { tenderId: tender.id, pages: pages.length, totalPages });
  const id = crypto.randomUUID();
  const blobKey = `tenders/${tender.id}/gem/${id}.pdf`;
  await deps.blobs.put(blobKey, got.bytes, { contentType: 'application/pdf' });
  const fileName = `${tender.bidNumber.replace(/[^\w-]+/g, '-')}.pdf`;
  const [doc] = await deps.db.insert(tenderDocuments).values({
    id, tenderId: tender.id, orgId: null, kind: 'bid', fileName, blobKey, sizeBytes: got.bytes.length,
    pageCount: pages.length, totalPages, text: joinPages(pages), sourceUrl: got.url,
  }).returning();
  if (!tender.documentUrl) await deps.db.update(tenders).set({ documentUrl: got.url }).where(eq(tenders.id, tender.id));
  await logActivity(deps.db, {
    orgId: input.orgId, userId: input.userId, action: 'tender.document_fetched', entityType: 'tender', entityId: tender.id,
    meta: { documentId: id, pages: pages.length, ...(totalPages > pages.length ? { totalPages } : {}), sourceUrl: got.url },
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

/** A `running` analysis older than this is treated as failed ("timed out") (FR-028). */
export const ANALYSIS_RUNNING_TIMEOUT_MS = 2 * 60 * 1000;
export const ANALYSIS_TIMED_OUT = 'timed out';

/**
 * Wall-clock budget for the LLM stage of one run, across all its documents (FR-028). A `running` row
 * counts as timed out ANALYSIS_RUNNING_TIMEOUT_MS after it was created, so a run must not legitimately
 * take that long: capping the LLM stage (the only slow, unbounded stage) at 90 s leaves ~30 s for
 * extraction, scoring and the DB writes. When the budget runs out, the in-flight call is abandoned and
 * the remaining documents use rules only. We chose this budget over heart-beating `updatedAt`: it needs
 * no background timer and keeps "timed out" a pure function of `createdAt`. A run that still overruns
 * (e.g. a stalled DB) cannot clobber anything: the final write only applies while the row is `running`.
 */
export const ANALYSIS_LLM_BUDGET_MS = 90_000;

class LlmBudgetExceeded extends Error {
  constructor() { super('LLM time budget exhausted'); }
}

/** `p`, or a rejection once `ms` has elapsed. The underlying call is not cancelled, only ignored. */
function withinBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new LlmBudgetExceeded());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LlmBudgetExceeded()), ms); });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

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

export async function analyseTender(
  deps: AppDeps,
  input: { orgId: string; userId: string; tenderId: string; viewer: TenderViewer },
  opts: { llmBudgetMs?: number } = {},
): Promise<{ analysis: AnalysisRow; documents: DocRow[] }> {
  const tender = await getTender(deps, input.tenderId, input.viewer);
  let docs = await listTenderDocuments(deps, tender.id, input.orgId);
  if (!docs.length && (tender.gemBidId || tender.documentUrl)) {
    try {
      docs = (await fetchGemDocuments(deps, input)).documents;
    } catch (e) {
      deps.logger.warn('analyse: auto-fetch of GeM document failed', { tenderId: tender.id, error: (e as Error).message });
    }
  }
  if (!docs.length) {
    throw new HttpError(422, 'no_documents', 'Add the bid document first — upload the PDF or fetch it from GeM.');
  }
  const now = deps.clock.now();
  // One running analysis per org+tender (FR-028). The advisory lock serialises concurrent requests
  // for the same org+tender until commit, so the check and the insert cannot interleave.
  const row = await deps.db.transaction(async (tx) => {
    await lockAnalyses(tx, input.orgId, tender.id);
    const cutoff = new Date(now.getTime() - ANALYSIS_RUNNING_TIMEOUT_MS);
    const scope = and(eq(analyses.orgId, input.orgId), eq(analyses.tenderId, tender.id), eq(analyses.status, 'running'));
    await tx.update(analyses).set({ status: 'failed', error: ANALYSIS_TIMED_OUT, updatedAt: now })
      .where(and(scope, lte(analyses.createdAt, cutoff)));
    const [running] = await tx.select({ id: analyses.id }).from(analyses).where(scope).limit(1);
    if (running) throw new HttpError(409, 'analysis_running', 'An analysis is already running for this tender');
    const [inserted] = await tx.insert(analyses).values({
      orgId: input.orgId, tenderId: tender.id, status: 'running', method: 'rules', createdBy: input.userId, createdAt: now, updatedAt: now,
    }).returning();
    return inserted;
  });
  // Every write to this row from here on is guarded by `status = 'running'`: if a newer request marked
  // it timed out (and maybe replaced it), the late finisher changes nothing and logs nothing (FR-028).
  const ours = and(eq(analyses.id, row.id), eq(analyses.status, 'running'));

  const t0 = performance.now();
  const llmDeadline = t0 + (opts.llmBudgetMs ?? ANALYSIS_LLM_BUDGET_MS);
  let extractMs = 0;
  let llmMs = 0;
  let pageTotal = 0;
  try {
    const ordered = [...docs].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.createdAt.getTime() - b.createdAt.getTime());
    const perDoc: Requirement[][] = [];
    let usedLlm = false;
    for (const d of ordered) {
      const tx0 = performance.now();
      const pages = splitPages(d.text);
      if (!pages.length) continue;
      pageTotal += pages.length;
      const meta = { documentId: d.id, fileName: d.fileName, estimatedValue: tender.estimatedValue };
      const rules = extractRequirementsRules(pages, meta);
      extractMs += performance.now() - tx0;
      if (deps.llm && performance.now() < llmDeadline) {
        const llm = deps.llm;
        const tl0 = performance.now();
        const r = await enrichWithLlm(pages, rules, (req) => withinBudget(llm.completeJson(req), llmDeadline - performance.now()), { documentId: d.id, fileName: d.fileName });
        llmMs += performance.now() - tl0;
        if (r.error) deps.logger.warn('analyse: LLM enrichment failed; using rules only', { tenderId: tender.id, error: r.error });
        usedLlm ||= r.used;
        perDoc.push(r.requirements);
      } else perDoc.push(rules);
    }
    const ts0 = performance.now();
    const requirements = combineRequirements(perDoc, requirementsFromListing(tender));
    const company = await loadCompany(deps, input.orgId);
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
        score: result.score, confidence: result.confidence, verdict: result.verdict, summary: withPrefix(prefix, result.summary), error: null, stale: false,
        updatedAt: deps.clock.now(),
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
