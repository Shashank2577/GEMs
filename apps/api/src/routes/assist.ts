/**
 * Submission assistant payload (T065; FR-026, FR-027). Owned by the Apply team.
 *
 *   GET /assist/:workspaceId   session cookie or `Authorization: Bearer tp_…` (browser extension)
 *
 * Returns only allow-listed, NON-FINANCIAL values (make, model, quantity, delivery, origin, local
 * content, MSE/Startup claim …), the documents to upload in order, and the human-only steps. It never
 * returns a price, and nothing here can enter a price, solve a CAPTCHA, do OTP/DSC/e-Sign or submit.
 */
import { Hono } from 'hono';
import { assistPayload, type AssistDocument } from '@tp/core/assist/allowlist';
import { orgId, requireAuth } from '../middleware/auth';
import {
  getTenderRow, getWorkspace, latestAnalysis, profileRow, readinessFor, templatesFor, templateContext, vaultRows, workspaceAnnexures,
} from '../services/packet';
import { and, desc, eq } from 'drizzle-orm';
import { packets } from '@tp/db';
import type { AppEnv } from '../types';

export const assistRoutes = new Hono<AppEnv>();

assistRoutes.get('/assist/:workspaceId', requireAuth, async (c) => {
  const { deps } = c.var;
  const org = orgId(c);
  const w = await getWorkspace(deps, org, c.req.param('workspaceId'));
  const [t, a, docs, profile, templates, [packet]] = await Promise.all([
    getTenderRow(deps, w.tenderId), latestAnalysis(deps, org, w.tenderId), vaultRows(deps, org), profileRow(deps, org), templatesFor(deps, org),
    deps.db.select().from(packets).where(and(eq(packets.orgId, org), eq(packets.workspaceId, w.id), eq(packets.status, 'ready'))).orderBy(desc(packets.createdAt)).limit(1),
  ]);
  const now = deps.clock.now();
  const base = deps.config.appUrl;
  const r = readinessFor(w, a, docs, now);
  const documents: AssistDocument[] = [];
  if (packet?.blobKey) {
    documents.push({ kind: 'packet', title: 'Technical bid packet (merged PDF)', fileName: packet.blobKey.split('/').pop()!, url: `${base}/api/packets/${packet.id}/download`, pages: packet.pageCount });
  }
  const byId = new Map(docs.map((d) => [d.id, d]));
  const seen = new Set<string>();
  for (const i of r.items) {
    const d = i.docId ? byId.get(i.docId) : undefined;
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    documents.push({ kind: 'vault', title: i.item.label, fileName: d.fileName, url: `${base}/api/vault/${d.id}/download`, pages: d.pageCount });
  }
  const ctx = templateContext(t, profile, w, now);
  for (const an of workspaceAnnexures(w.id, a, templates, ctx)) {
    if (!an.itemId || an.key === 'oem_auth_request') continue;
    documents.push({ kind: 'annexure', title: an.title, fileName: `${an.key}.pdf`, url: `${base}${an.pdfUrl}?download=1`, pages: 1 });
  }
  const delivery = a?.requirements.find((q) => q.key === 'delivery_days')?.numeric ?? null;
  const payload = assistPayload({
    workspace: { id: w.id, assistValues: w.assistValues },
    tender: { bidNumber: t.bidNumber, title: t.title, quantity: t.quantity, hsnCodes: t.hsnCodes, items: t.items },
    profile, documents, deliveryDays: delivery,
  });
  return c.json({ ...payload, stage: w.stage, readiness: { percent: r.percent, blockers: r.blockers.length }, workspaceUrl: `${base}/workspaces/${w.id}` });
});
