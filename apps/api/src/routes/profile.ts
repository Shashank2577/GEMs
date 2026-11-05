/**
 * Company profile & past contracts (T052; FR-020). Owned by the Vault team.
 *
 *   GET    /profile                → { profile, completeness, issues, averageTurnover }   viewer+
 *   PUT    /profile                partial upsert (omitted fields keep their value)       analyst+
 *                                   optional expectedUpdatedAt → 409 conflict on mismatch (FR-014)
 *   GET    /past-contracts         → { items, total }                                     viewer+
 *   POST   /past-contracts         → PastContractDto (201)                                analyst+
 *   PATCH  /past-contracts/:id     → PastContractDto                                      analyst+
 *   DELETE /past-contracts/:id     → { ok: true }                                         analyst+
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { companyProfiles, pastContracts, vaultDocuments } from '@tp/db';
import {
  pastContractCreateSchema, pastContractUpdateSchema, profileInputSchema,
  type CompanyProfileDto, type PastContractDto, type ProfileResponse,
} from '@tp/core/contracts/vault';
import { uuidSchema } from '@tp/core/contracts/common';
import { profileCompleteness } from '@tp/core/vault/completeness';
import { averageTurnoverLastN } from '@tp/core/vault/validators';
import { dateTimeIST } from '@tp/core/time';
import type { AppDeps } from '../deps';
import { logActivity } from '../lib/activity';
import { conflict, notFound, validationError } from '../lib/errors';
import { parseJson } from '../lib/validate';
import { orgId, requireAuth, requireRole, userId } from '../middleware/auth';
import type { AppEnv } from '../types';

export const profileRoutes = new Hono<AppEnv>();

type ProfileRow = typeof companyProfiles.$inferSelect;
type PastContractRow = typeof pastContracts.$inferSelect;

const EMPTY_PROFILE: Omit<CompanyProfileDto, 'updatedAt'> = {
  legalName: '', tradeName: null, gstin: null, pan: null, cin: null, udyamNumber: null, mseCategory: null, mseSocialCategory: null,
  isStartup: false, dpiitNumber: null, miiClass: null, localContentPct: null, incorporationDate: null, address: null, state: null,
  pincode: null, contactName: null, contactEmail: null, contactPhone: null, signatoryName: null, signatoryDesignation: null,
  financials: [], categories: [], hsnCodes: [], operatingStates: [], oemAuthorizations: [], certifications: [], maxEmdCapacity: null,
};

export function toProfileDto(row: ProfileRow | null | undefined): CompanyProfileDto {
  if (!row) return { ...EMPTY_PROFILE, updatedAt: null };
  const { orgId: _o, updatedAt, ...rest } = row;
  return { ...EMPTY_PROFILE, ...rest, updatedAt: updatedAt.toISOString() } as CompanyProfileDto;
}

export function toPastContractDto(r: PastContractRow): PastContractDto {
  return {
    id: r.id, buyer: r.buyer, buyerType: r.buyerType, title: r.title, category: r.category, value: r.value,
    startDate: r.startDate, endDate: r.endDate, gemContractNo: r.gemContractNo, cracDocumentId: r.cracDocumentId,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function buildProfileResponse(deps: AppDeps, org: string): Promise<ProfileResponse> {
  const [[row], pcs, docs] = await Promise.all([
    deps.db.select().from(companyProfiles).where(eq(companyProfiles.orgId, org)),
    deps.db.select({ id: pastContracts.id }).from(pastContracts).where(eq(pastContracts.orgId, org)),
    deps.db.select({ type: vaultDocuments.type, expiryDate: vaultDocuments.expiryDate, title: vaultDocuments.title }).from(vaultDocuments).where(eq(vaultDocuments.orgId, org)),
  ]);
  const profile = toProfileDto(row);
  const c = profileCompleteness(profile, pcs, docs, deps.clock.now());
  return { profile, completeness: c.percent, issues: c.issues, averageTurnover: averageTurnoverLastN(profile.financials, 3) };
}

profileRoutes.get('/profile', requireAuth, async (c) => c.json(await buildProfileResponse(c.var.deps, orgId(c))));

/** Thrown inside the profile transaction when another save won the race (FR-014). */
const profileConflict = (stored: Date | null) =>
  conflict(`Someone else saved the profile at ${stored ? dateTimeIST(stored) : 'an earlier time'}. Reload to see their changes.`, {
    updatedAt: stored?.toISOString() ?? null,
  });

/** `updated_at` truncated to whole milliseconds (JS Date precision) as epoch ms; Postgres keeps microseconds. */
const updatedAtMs = sql<number>`floor(extract(epoch from ${companyProfiles.updatedAt}) * 1000)::float8`;

const OEM_DOC_MESSAGE = 'Pick an OEM authorisation from your vault';

/**
 * FR-061: every OEM `documentId` that is new or changed must be an `oem_authorization` document of the org —
 * one query for all ids. Ids already stored on the profile are accepted unchanged, so a stale link (document
 * deleted or retyped since) never blocks an unrelated save. Ids arrive lowercased from `oemAuthorizationSchema`.
 */
async function assertOemDocsInOrg(
  db: Pick<AppDeps['db'], 'select'>, org: string, rows: ProfileRow['oemAuthorizations'], stored: ProfileRow['oemAuthorizations'] = [],
) {
  const known = new Set(stored.flatMap((r) => (r.documentId ? [r.documentId.toLowerCase()] : [])));
  const isNew = (id: string | null | undefined): id is string => !!id && !known.has(id.toLowerCase());
  const ids = [...new Set(rows.map((r) => r.documentId).filter(isNew).map((id) => id.toLowerCase()))];
  if (!ids.length) return;
  const found = await db.select({ id: vaultDocuments.id, type: vaultDocuments.type }).from(vaultDocuments)
    .where(and(eq(vaultDocuments.orgId, org), inArray(vaultDocuments.id, ids)));
  const ok = new Set(found.filter((d) => d.type === 'oem_authorization').map((d) => d.id.toLowerCase()));
  const fields: Record<string, string> = {};
  rows.forEach((r, i) => { if (isNew(r.documentId) && !ok.has(r.documentId.toLowerCase())) fields[`oemAuthorizations.${i}.documentId`] = OEM_DOC_MESSAGE; });
  const first = Object.keys(fields)[0];
  if (first) throw validationError(`${first}: ${OEM_DOC_MESSAGE}`, { fields });
}

profileRoutes.put('/profile', requireRole('analyst'), async (c) => {
  const { db } = c.var.deps;
  const org = orgId(c);
  const { expectedUpdatedAt, ...input } = await parseJson(c, profileInputSchema);
  // Merge: keys absent from the body keep their stored value.
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<ProfileRow>;
  const now = c.var.deps.clock.now();

  await db.transaction(async (tx) => {
    // Lock the org's row so the concurrency check and the write are atomic (FR-014).
    const [found] = await tx.select({ row: companyProfiles, ms: updatedAtMs }).from(companyProfiles)
      .where(eq(companyProfiles.orgId, org)).for('update');
    const existing = found?.row;
    // Optimistic concurrency: refuse to overwrite a version the client did not load.
    // null means "I saw no saved profile yet", so it conflicts with any existing row.
    if (expectedUpdatedAt !== undefined) {
      const expected = expectedUpdatedAt === null ? null : Date.parse(expectedUpdatedAt);
      if ((found ? Number(found.ms) : null) !== expected) throw profileConflict(existing?.updatedAt ?? null);
    }
    const merged = { ...EMPTY_PROFILE, ...(existing ?? {}), ...patch };
    // Cross-field check against stored values too (e.g. only the PAN was changed).
    if (merged.gstin && merged.pan && merged.gstin.slice(2, 12) !== merged.pan && ('gstin' in patch || 'pan' in patch)) {
      const field = 'gstin' in patch ? 'gstin' : 'pan';
      throw validationError(`${field}: GSTIN ${merged.gstin} belongs to PAN ${merged.gstin.slice(2, 12)}, not ${merged.pan}`, {
        fields: { [field]: field === 'gstin' ? `This GSTIN belongs to PAN ${merged.gstin.slice(2, 12)}, not ${merged.pan}` : `Your GSTIN is registered to PAN ${merged.gstin.slice(2, 12)}` },
      });
    }
    // OEM documentIds must be oem_authorization documents in this org's vault (FR-061).
    if (patch.oemAuthorizations) await assertOemDocsInOrg(tx, org, patch.oemAuthorizations, existing?.oemAuthorizations);
    const { orgId: _o, updatedAt: _u, ...values } = merged as ProfileRow;
    if (existing) {
      // updated_at is the version token: always move it forward, even for two saves in the same millisecond.
      const prevMs = Number(found!.ms);
      const stamp = now.getTime() > prevMs ? now : new Date(prevMs + 1);
      await tx.update(companyProfiles).set({ ...values, updatedAt: stamp }).where(eq(companyProfiles.orgId, org));
    } else if (expectedUpdatedAt !== undefined) {
      // No row to lock: a concurrent first save may insert it. Only one insert may win.
      const inserted = await tx.insert(companyProfiles).values({ ...values, orgId: org, updatedAt: now })
        .onConflictDoNothing({ target: companyProfiles.orgId }).returning({ orgId: companyProfiles.orgId });
      if (!inserted.length) {
        const [other] = await tx.select({ updatedAt: companyProfiles.updatedAt }).from(companyProfiles).where(eq(companyProfiles.orgId, org));
        throw profileConflict(other?.updatedAt ?? null);
      }
    } else {
      // Legacy clients (no expectedUpdatedAt): last write wins.
      await tx.insert(companyProfiles).values({ ...values, orgId: org, updatedAt: now })
        .onConflictDoUpdate({ target: companyProfiles.orgId, set: { ...values, updatedAt: now } });
    }
  });
  await logActivity(db, { orgId: org, userId: userId(c), action: 'profile.updated', entityType: 'profile', entityId: org, meta: { fields: Object.keys(patch) } });
  return c.json(await buildProfileResponse(c.var.deps, org));
});

// ───────────── Past contracts ─────────────

async function assertDocInOrg(deps: AppDeps, org: string, docId: string | null | undefined) {
  if (!docId) return;
  const [d] = await deps.db.select({ id: vaultDocuments.id }).from(vaultDocuments).where(and(eq(vaultDocuments.orgId, org), eq(vaultDocuments.id, docId)));
  if (!d) throw validationError('cracDocumentId: That document is not in your vault', { fields: { cracDocumentId: 'That document is not in your vault' } });
}

const contractId = (raw: string) => {
  const r = uuidSchema.safeParse(raw);
  if (!r.success) throw notFound('Past contract');
  return r.data;
};

profileRoutes.get('/past-contracts', requireAuth, async (c) => {
  const rows = await c.var.deps.db.select().from(pastContracts).where(eq(pastContracts.orgId, orgId(c)))
    .orderBy(sql`${pastContracts.endDate} desc nulls last`, desc(pastContracts.createdAt));
  return c.json({ items: rows.map(toPastContractDto), total: rows.length });
});

profileRoutes.post('/past-contracts', requireRole('analyst'), async (c) => {
  const org = orgId(c);
  const input = await parseJson(c, pastContractCreateSchema);
  await assertDocInOrg(c.var.deps, org, input.cracDocumentId);
  const [row] = await c.var.deps.db.insert(pastContracts).values({
    orgId: org, buyer: input.buyer, buyerType: input.buyerType, title: input.title, category: input.category ?? null, value: input.value,
    startDate: input.startDate ?? null, endDate: input.endDate ?? null, gemContractNo: input.gemContractNo ?? null, cracDocumentId: input.cracDocumentId ?? null,
  }).returning();
  await logActivity(c.var.deps.db, { orgId: org, userId: userId(c), action: 'profile.past_contract_added', entityType: 'past_contract', entityId: row!.id, meta: { buyer: row!.buyer, value: row!.value } });
  return c.json(toPastContractDto(row!), 201);
});

profileRoutes.patch('/past-contracts/:id', requireRole('analyst'), async (c) => {
  const org = orgId(c);
  const id = contractId(c.req.param('id'));
  const input = await parseJson(c, pastContractUpdateSchema);
  const [existing] = await c.var.deps.db.select().from(pastContracts).where(and(eq(pastContracts.orgId, org), eq(pastContracts.id, id)));
  if (!existing) throw notFound('Past contract');
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<PastContractRow>;
  const start = patch.startDate !== undefined ? patch.startDate : existing.startDate;
  const end = patch.endDate !== undefined ? patch.endDate : existing.endDate;
  if (start && end && end < start) throw validationError('endDate: End date is before the start date', { fields: { endDate: 'End date is before the start date' } });
  await assertDocInOrg(c.var.deps, org, patch.cracDocumentId);
  const [row] = Object.keys(patch).length
    ? await c.var.deps.db.update(pastContracts).set(patch).where(and(eq(pastContracts.orgId, org), eq(pastContracts.id, id))).returning()
    : [existing];
  await logActivity(c.var.deps.db, { orgId: org, userId: userId(c), action: 'profile.past_contract_updated', entityType: 'past_contract', entityId: id, meta: { fields: Object.keys(patch) } });
  return c.json(toPastContractDto(row!));
});

profileRoutes.delete('/past-contracts/:id', requireRole('analyst'), async (c) => {
  const org = orgId(c);
  const id = contractId(c.req.param('id'));
  const [row] = await c.var.deps.db.delete(pastContracts).where(and(eq(pastContracts.orgId, org), eq(pastContracts.id, id))).returning({ id: pastContracts.id, buyer: pastContracts.buyer });
  if (!row) throw notFound('Past contract');
  await logActivity(c.var.deps.db, { orgId: org, userId: userId(c), action: 'profile.past_contract_deleted', entityType: 'past_contract', entityId: id, meta: { buyer: row.buyer } });
  return c.json({ ok: true as const });
});
