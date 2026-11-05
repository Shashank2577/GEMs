/**
 * Analyse routes (T045, US2) — contracts/api.md § Analyse. Mounted at /api.
 *
 *   GET  /tenders/:id/documents                       list (GeM + own uploads)       viewer+
 *   POST /tenders/:id/documents                       multipart file, kind           analyst+
 *   POST /tenders/:id/fetch-documents                 download from GeM              analyst+
 *   GET  /tenders/:id/documents/:docId/download       stream (?inline=1)             viewer+
 *   POST /tenders/:id/analyse                         rules (+LLM) → Analysis         analyst+
 *   GET  /tenders/:id/analysis                        latest Analysis or 404         viewer+
 *   POST /analyses/:id/override                       {factorKey,status,reason}      bid_manager+
 *   GET  /scoring-weights                             {weights, defaults, custom}    viewer+
 *   PUT  /scoring-weights                             partial weights ({} = reset)   bid_manager+
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { idParamSchema, uuidSchema } from '@tp/core/contracts/common';
import { overrideFactorInputSchema, scoringWeightsSchema, tenderDocKindSchema } from '@tp/core/contracts/analyse';
import { HttpError, badRequest, notFound } from '../lib/errors';
import { parseJson, parseWith } from '../lib/validate';
import { orgId, requireAuth, requireRole, userId } from '../middleware/auth';
import {
  analyseTender, fetchGemDocuments, getTender, getTenderDocument, latestAnalysis, listTenderDocuments, overrideFactor,
  saveWeights, toAnalysisDto, toDocumentDto, uploadTenderDocument, weightsResponse,
} from '../services/analyse';
import type { AppEnv } from '../types';

export const analysisRoutes = new Hono<AppEnv>();

const tenderIdOf = (id: string) => {
  const r = uuidSchema.safeParse(id);
  if (!r.success) throw notFound('Tender');
  return r.data;
};

analysisRoutes.get('/tenders/:id/documents', requireAuth, async (c) => {
  const tenderId = tenderIdOf(c.req.param('id'));
  await getTender(c.var.deps, tenderId);
  const docs = await listTenderDocuments(c.var.deps, tenderId, orgId(c));
  return c.json({ items: docs.map(toDocumentDto), total: docs.length });
});

analysisRoutes.post('/tenders/:id/documents', requireRole('analyst'), async (c) => {
  const tenderId = tenderIdOf(c.req.param('id'));
  let body: Record<string, string | File>;
  try {
    body = await c.req.parseBody();
  } catch {
    throw badRequest('Send the document as multipart/form-data with a "file" field');
  }
  const file = body.file;
  if (!file || typeof file === 'string') throw new HttpError(400, 'validation_error', 'Choose a PDF file to upload', { fields: { file: 'Required' } });
  const kind = parseWith(z.object({ kind: tenderDocKindSchema.default('bid') }), { kind: typeof body.kind === 'string' && body.kind ? body.kind : undefined }, 'form').kind;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await uploadTenderDocument(c.var.deps, {
    orgId: orgId(c), userId: userId(c), tenderId, kind, file: { name: file.name, type: file.type, bytes },
  });
  return c.json(toDocumentDto(doc), 201);
});

analysisRoutes.post('/tenders/:id/fetch-documents', requireRole('analyst'), async (c) => {
  const tenderId = tenderIdOf(c.req.param('id'));
  const r = await fetchGemDocuments(c.var.deps, { orgId: orgId(c), userId: userId(c), tenderId });
  return c.json({ items: r.documents.map(toDocumentDto), total: r.documents.length, fetched: r.fetched }, r.fetched ? 201 : 200);
});

analysisRoutes.get('/tenders/:id/documents/:docId/download', requireAuth, async (c) => {
  const tenderId = tenderIdOf(c.req.param('id'));
  const docId = uuidSchema.safeParse(c.req.param('docId'));
  if (!docId.success) throw notFound('Document');
  const doc = await getTenderDocument(c.var.deps, tenderId, docId.data, orgId(c));
  const obj = await c.var.deps.blobs.get(doc.blobKey);
  if (!obj) throw notFound('Document file');
  const inline = c.req.query('inline') === '1';
  const name = doc.fileName.replace(/"/g, '');
  return new Response(obj.body, {
    headers: {
      'content-type': obj.contentType || 'application/pdf',
      'content-length': String(obj.size),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});

analysisRoutes.post('/tenders/:id/analyse', requireRole('analyst'), async (c) => {
  const tenderId = tenderIdOf(c.req.param('id'));
  const { analysis, documents } = await analyseTender(c.var.deps, { orgId: orgId(c), userId: userId(c), tenderId });
  return c.json(toAnalysisDto(analysis, documents), 201);
});

analysisRoutes.get('/tenders/:id/analysis', requireAuth, async (c) => {
  const tenderId = tenderIdOf(c.req.param('id'));
  const a = await latestAnalysis(c.var.deps, tenderId, orgId(c));
  if (!a) throw notFound('Analysis');
  const docs = await listTenderDocuments(c.var.deps, tenderId, orgId(c));
  return c.json(toAnalysisDto(a, docs));
});

analysisRoutes.post('/analyses/:id/override', requireRole('bid_manager'), async (c) => {
  const { id } = parseWith(idParamSchema, { id: c.req.param('id') }, 'path');
  const body = await parseJson(c, overrideFactorInputSchema);
  const a = await overrideFactor(c.var.deps, { orgId: orgId(c), userId: userId(c), userName: c.var.user.name, analysisId: id, ...body });
  return c.json(toAnalysisDto(a));
});

analysisRoutes.get('/scoring-weights', requireAuth, (c) => c.json(weightsResponse(c.var.org.scoringWeights)));

analysisRoutes.put('/scoring-weights', requireRole('bid_manager'), async (c) => {
  const weights = await parseJson(c, scoringWeightsSchema);
  return c.json(await saveWeights(c.var.deps, { orgId: orgId(c), userId: userId(c), weights }));
});
