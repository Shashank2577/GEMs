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
import { enrichWithLlm } from '@tp/core/analyse/llm';
import { PdfTextError, extractPages, isPdf, joinPages, looksScanned, splitPages } from '@tp/core/analyse/pdf-text';
import { combineRequirements, detectBidNumber, extractRequirementsRules, normalizeBidNumber, requirementsFromListing } from '@tp/core/analyse/rules';
import { computeScore, effectiveStatus, resolveWeights, scoreTender, DEFAULT_WEIGHTS, type FactorOverride } from '@tp/core/analyse/score';
import {
  MAX_TENDER_DOC_BYTES, type AnalysisDto, type AnalysisWarning, type OverrideFactorInput, type ScoringWeights, type TenderDocKind, type TenderDocumentDto,
  type TenderDocumentWarning,
} from '@tp/core/contracts/analyse';
import { GemClient, GemError } from '@tp/core/gem/client';
import type { AppDeps } from '../deps';
import { logActivity } from '../lib/activity';
import { HttpError, forbidden, notFound } from '../lib/errors';
import { assertWithinPlan, meteredCompleteJson, reserveAnalysisQuota } from '../lib/plan';
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

export async function getTender(deps: AppDeps, tenderId: string): Promise<TenderRow> {
  const [t] = await deps.db.select().from(tenders).where(eq(tenders.id, tenderId));
  if (!t) throw notFound('Tender');
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

async function extractOrThrow(bytes: Uint8Array): Promise<string[]> {
  try {
    return await extractPages(bytes);
  } catch (e) {
    if (e instanceof PdfTextError) throw new HttpError(422, 'unreadable_pdf', 'We could not read this PDF. It may be password-protected or damaged.');
    throw e;
  }
}

// ───────────── Upload ─────────────

export interface UploadInput {
  orgId: string; userId: string; tenderId: string; kind: TenderDocKind;
  file: { name: string; type?: string; bytes: Uint8Array };
}

export async function uploadTenderDocument(deps: AppDeps, input: UploadInput): Promise<{ doc: DocRow; tender: TenderRow }> {
  const tender = await getTender(deps, input.tenderId);
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

export async function removeTenderDocument(deps: AppDeps, input: { orgId: string; userId: string; tenderId: string; docId: string }): Promise<void> {
  await getTender(deps, input.tenderId);
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

export async function fetchGemDocuments(deps: AppDeps, input: { orgId: string; userId: string; tenderId: string }): Promise<{ documents: DocRow[]; fetched: number; tender: TenderRow }> {
  const tender = await getTender(deps, input.tenderId);
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

export async function analyseTender(deps: AppDeps, input: { orgId: string; userId: string; tenderId: string }): Promise<{ analysis: AnalysisRow; documents: DocRow[] }> {
  const tender = await getTender(deps, input.tenderId);
  await assertWithinPlan(deps, input.orgId, 'analysesPerMonth'); // fail fast, before any GeM download (re-checked under lock)
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
  const previous = await latestAnalysis(deps, tender.id, input.orgId);
  const now = deps.clock.now();
  // 008/FR-036/FR-037: quota check and insert serialised per org (row lock), so concurrent requests cannot overshoot.
  const { row, llmAllowed } = await deps.db.transaction(async (tx) => {
    const quota = await reserveAnalysisQuota(deps, tx, input.orgId);
    const [inserted] = await tx.insert(analyses).values({
      orgId: input.orgId, tenderId: tender.id, status: 'running', method: 'rules', createdBy: input.userId, createdAt: now, updatedAt: now,
    }).returning();
    return { row: inserted!, llmAllowed: quota.llmAllowed };
  });
  const warnings: AnalysisWarning[] = deps.llm && !llmAllowed ? [{ code: 'llm_quota_reached' }] : [];

  try {
    const ordered = [...docs].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.createdAt.getTime() - b.createdAt.getTime());
    const perDoc: Requirement[][] = [];
    let usedLlm = false;
    for (const d of ordered) {
      const pages = splitPages(d.text);
      if (!pages.length) continue;
      const meta = { documentId: d.id, fileName: d.fileName, estimatedValue: tender.estimatedValue };
      const rules = extractRequirementsRules(pages, meta);
      if (deps.llm && llmAllowed) {
        const completeJson = meteredCompleteJson(deps, { orgId: input.orgId, analysisId: row.id, kind: 'extract' });
        const r = await enrichWithLlm(pages, rules, (req) => completeJson(req), { documentId: d.id, fileName: d.fileName });
        if (r.error) deps.logger.warn('analyse: LLM enrichment failed; using rules only', { tenderId: tender.id, error: r.error });
        usedLlm ||= r.used;
        perDoc.push(r.requirements);
      } else perDoc.push(rules);
    }
    const requirements = combineRequirements(perDoc, requirementsFromListing(tender));
    const company = await loadCompany(deps, input.orgId);
    const result = scoreTender({
      requirements, profile: company.profile, pastContracts: company.pastContracts, vaultDocs: company.vault,
      tender: { endAt: tender.endAt, state: tender.state, emdAmount: tender.emdAmount }, weights: company.weights, now,
      overrides: overridesOf(previous),
    });
    const checklist = buildChecklist(requirements, company.profile);
    const [done] = await deps.db.update(analyses).set({
      status: 'done', method: usedLlm ? 'rules+llm' : 'rules', requirements, factors: result.factors, checklist,
      score: result.score, confidence: result.confidence, verdict: result.verdict, summary: result.summary, error: null, stale: false,
      warnings, updatedAt: deps.clock.now(),
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
  const [updated] = await deps.db.update(analyses).set({
    factors, score: r.score, confidence: r.confidence, verdict: r.verdict, summary: r.summary, updatedAt: deps.clock.now(),
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
