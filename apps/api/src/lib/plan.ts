/**
 * Plan limits and usage metering (spec 008 US5: FR-034…FR-039, FR-043).
 *
 *   await assertWithinPlan(deps, orgId, 'watchlists', 1);       // → 402 plan_limit_reached when over
 *   const u = await usageFor(deps, orgId);                      // GET /org/usage
 *
 * The plan is read from the database on every call (no caching beyond one request, FR-043); `enterprise` is never
 * limited. Monthly counters use the IST calendar month (`istMonthPeriod`).
 *
 * Serialisation (review N2): analyses (`reserveAnalysisQuota`) and watchlists check and insert under the org row lock,
 * so concurrent requests cannot overshoot those limits. Seats, vault bytes and packets are check-then-insert without
 * the lock: two requests racing past the check can overshoot by at most the concurrent requests (one invite, one file,
 * one packet each). Accepted — they are not a cost risk like the LLM, and the next request sees the real count.
 */
import { and, count, countDistinct, eq, gt, gte, isNotNull, isNull, lt, ne, sum } from 'drizzle-orm';
import {
  analyses, invitations, llmUsage, memberships, organizations, packets, vaultDocuments, vaultDocumentVersions, watchlists,
  type Db,
} from '@tp/db';
import {
  MONTHLY_LIMITS, USAGE_FIELD, isPlanKey, istMonthPeriod, limitsFor, planLimitMessage,
  type OrgUsage, type OrgUsageResponse, type PlanKey, type PlanLimitDetails, type PlanLimitKey,
} from '@tp/core/contracts/plans';
import type { AppDeps, LlmResult } from '../deps';
import { paymentRequired } from './errors';

/** A database handle or an open transaction. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

const num = (v: unknown) => Number(v ?? 0) || 0;

export async function loadPlan(db: DbOrTx, orgId: string, opts: { forUpdate?: boolean } = {}): Promise<{ plan: PlanKey; trialEndsAt: Date | null }> {
  const q = db.select({ plan: organizations.plan, trialEndsAt: organizations.trialEndsAt }).from(organizations).where(eq(organizations.id, orgId));
  // NO KEY UPDATE: serialises quota checks without blocking inserts that only reference the org row (review N1, as org.ts).
  const [o] = opts.forUpdate ? await q.for('no key update') : await q;
  return { plan: o && isPlanKey(o.plan) ? o.plan : 'trial', trialEndsAt: o?.trialEndsAt ?? null };
}

/** Current value of one metered quantity. */
export async function usedOf(db: DbOrTx, orgId: string, limit: PlanLimitKey, now: Date): Promise<number> {
  const { start, end } = istMonthPeriod(now);
  switch (limit) {
    case 'seats': {
      const [m] = await db.select({ n: count() }).from(memberships).where(eq(memberships.orgId, orgId));
      const [i] = await db.select({ n: count() }).from(invitations)
        .where(and(eq(invitations.orgId, orgId), isNull(invitations.acceptedAt), gt(invitations.expiresAt, now)));
      return num(m?.n) + num(i?.n);
    }
    case 'watchlists': {
      const [r] = await db.select({ n: count() }).from(watchlists).where(eq(watchlists.orgId, orgId));
      return num(r?.n);
    }
    case 'analysesPerMonth': {
      // Failed analyses (our fault, not the user's) do not count; nor do the rows the demo seeder wrote (007/FR-065).
      // Anything a user runs counts, whatever the tender's source (review S2).
      const [r] = await db.select({ n: count() }).from(analyses)
        .where(and(eq(analyses.orgId, orgId), gte(analyses.createdAt, start), lt(analyses.createdAt, end), ne(analyses.status, 'failed'),
          eq(analyses.seeded, false)));
      return num(r?.n);
    }
    case 'llmAnalysesPerMonth': {
      // `analysis_ref` has no foreign key: deleting an analysis (e.g. `DELETE /demo`) does not give its AI slot back (review B1).
      const [r] = await db.select({ n: countDistinct(llmUsage.analysisRef) }).from(llmUsage)
        .where(and(eq(llmUsage.orgId, orgId), eq(llmUsage.kind, 'extract'), isNotNull(llmUsage.analysisRef),
          gte(llmUsage.createdAt, start), lt(llmUsage.createdAt, end)));
      return num(r?.n);
    }
    case 'packetsPerMonth': {
      // The demo seeder writes no packets, so every packet a user built counts — demo workspace or not (review S2).
      const [r] = await db.select({ n: count() }).from(packets)
        .where(and(eq(packets.orgId, orgId), gte(packets.createdAt, start), lt(packets.createdAt, end), ne(packets.status, 'failed')));
      return num(r?.n);
    }
    case 'vaultBytes': {
      // Current files plus the kept previous versions (FR-065) — both occupy storage.
      const [d] = await db.select({ n: sum(vaultDocuments.sizeBytes) }).from(vaultDocuments).where(eq(vaultDocuments.orgId, orgId));
      const [v] = await db.select({ n: sum(vaultDocumentVersions.sizeBytes) }).from(vaultDocumentVersions).where(eq(vaultDocumentVersions.orgId, orgId));
      return num(d?.n) + num(v?.n);
    }
  }
}

function limitError(plan: PlanKey, limit: PlanLimitKey, used: number, max: number, now: Date) {
  const details: PlanLimitDetails = { limit, used, max, plan };
  if (MONTHLY_LIMITS.includes(limit)) details.resetsAt = istMonthPeriod(now).end.toISOString();
  return paymentRequired('plan_limit_reached', planLimitMessage(details), details);
}

/**
 * Throw 402 `plan_limit_reached` (details `{limit, used, max, plan, resetsAt?}`) when `used + increment > max`.
 * `opts.db` lets a caller run the check inside its own transaction (after locking the org row).
 */
export async function assertWithinPlan(
  deps: Pick<AppDeps, 'db' | 'clock'>, orgId: string, limit: PlanLimitKey, increment = 1, opts: { db?: DbOrTx; plan?: PlanKey } = {},
): Promise<void> {
  const db = opts.db ?? deps.db;
  const plan = opts.plan ?? (await loadPlan(db, orgId)).plan;
  if (plan === 'enterprise') return; // FR-043
  const max = limitsFor(plan)[limit];
  if (max == null) return;
  const now = deps.clock.now();
  const used = await usedOf(db, orgId, limit, now);
  if (used + increment > max) throw limitError(plan, limit, used, max, now);
}

/**
 * Analyse quota (FR-036, FR-037), to be called inside the transaction that inserts the `analyses` row: locks the org
 * row (`SELECT … FOR NO KEY UPDATE`) so concurrent analyses of one org are counted one at a time, throws 402 when the
 * monthly analyses are used up, and reports whether this analysis may still use the LLM.
 *
 * With `llm` given (an LLM is configured) and the AI quota not used up, it also RESERVES the AI slot in the same
 * transaction: a 0-token `llm_usage` reservation row (`kind: 'extract'`, `analysis_ref` = the new analysis id) that
 * counts at once, so concurrent analyses cannot all get AI past the quota (review S1). The first LLM call of the
 * analysis fills that row in (`meteredCompleteJson`'s `reservationId`); an analysis that ends with no metered LLM
 * call gives the slot back (`releaseLlmReservation`).
 */
export async function reserveAnalysisQuota(
  deps: Pick<AppDeps, 'clock'>, tx: DbOrTx, orgId: string, llm?: { analysisRef: string; model: string } | null,
): Promise<{ llmAllowed: boolean; reservationId: string | null }> {
  const { plan } = await loadPlan(tx, orgId, { forUpdate: true });
  let llmAllowed = true;
  if (plan !== 'enterprise') {
    await assertWithinPlan({ db: tx as Db, clock: deps.clock }, orgId, 'analysesPerMonth', 1, { db: tx, plan });
    const llmMax = limitsFor(plan).llmAnalysesPerMonth;
    if (llmMax != null) llmAllowed = (await usedOf(tx, orgId, 'llmAnalysesPerMonth', deps.clock.now())) < llmMax;
  }
  if (!llm || !llmAllowed) return { llmAllowed, reservationId: null };
  const [row] = await tx.insert(llmUsage).values({
    orgId, analysisRef: llm.analysisRef, kind: 'extract', model: llm.model, inputTokens: 0, outputTokens: 0, createdAt: deps.clock.now(),
  }).returning({ id: llmUsage.id });
  return { llmAllowed, reservationId: row!.id };
}

/**
 * At the end of an analysis: give back an AI slot reserved by `reserveAnalysisQuota` that no metered LLM call filled
 * in (no call made, or none reached the provider). A filled row has `analysis_id` set and is kept. A call still in
 * flight that settles later finds the row gone and inserts its own (`recordLlmUsage`). Never throws.
 */
export async function releaseLlmReservation(deps: Pick<AppDeps, 'db' | 'logger'>, reservationId: string): Promise<void> {
  try {
    await deps.db.delete(llmUsage).where(and(eq(llmUsage.id, reservationId), isNull(llmUsage.analysisId)));
  } catch (e) {
    deps.logger.error('llm usage: releasing the reservation failed', { reservationId, error: (e as Error).message });
  }
}

/** FR-039 usage summary for `GET /org/usage`. */
export async function usageFor(deps: Pick<AppDeps, 'db' | 'clock'>, orgId: string): Promise<OrgUsageResponse> {
  const now = deps.clock.now();
  const { start, end } = istMonthPeriod(now);
  const { plan, trialEndsAt } = await loadPlan(deps.db, orgId);
  const keys = Object.keys(USAGE_FIELD) as PlanLimitKey[];
  const values = await Promise.all(keys.map((k) => usedOf(deps.db, orgId, k, now)));
  const [tokens] = await deps.db.select({ input: sum(llmUsage.inputTokens), output: sum(llmUsage.outputTokens) }).from(llmUsage)
    .where(and(eq(llmUsage.orgId, orgId), gte(llmUsage.createdAt, start), lt(llmUsage.createdAt, end)));
  const by = Object.fromEntries(keys.map((k, i) => [USAGE_FIELD[k], values[i]!])) as Record<keyof OrgUsage, number>;
  const usage: OrgUsage = {
    seats: by.seats, watchlists: by.watchlists, analysesThisMonth: by.analysesThisMonth, llmAnalysesThisMonth: by.llmAnalysesThisMonth,
    vaultBytes: by.vaultBytes, packetsThisMonth: by.packetsThisMonth,
    llmTokensThisMonth: { input: num(tokens?.input), output: num(tokens?.output) },
  };
  return {
    plan,
    trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
    period: { start: start.toISOString(), end: end.toISOString() },
    usage,
    limits: { ...limitsFor(plan) },
  };
}

// ───────────── LLM metering (FR-039) ─────────────

export interface LlmUsageInput {
  orgId: string;
  analysisId?: string | null;
  /** Fill in this reservation row (see `reserveAnalysisQuota`) instead of inserting a new one. */
  reservationId?: string | null;
  kind: 'extract' | 'assist';
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Insert one `llm_usage` row. Never throws: metering must not fail the user's request. */
export async function recordLlmUsage(deps: Pick<AppDeps, 'db' | 'clock' | 'logger'>, u: LlmUsageInput): Promise<void> {
  const tokens = { inputTokens: Math.max(0, Math.round(u.inputTokens)), outputTokens: Math.max(0, Math.round(u.outputTokens)) };
  try {
    if (u.reservationId) {
      const filled = await deps.db.update(llmUsage).set({ analysisId: u.analysisId ?? null, model: u.model, ...tokens })
        .where(eq(llmUsage.id, u.reservationId)).returning({ id: llmUsage.id });
      if (filled.length) return;
    }
    await deps.db.insert(llmUsage).values({
      orgId: u.orgId, analysisId: u.analysisId ?? null, analysisRef: u.analysisId ?? null, kind: u.kind, model: u.model, ...tokens,
      createdAt: deps.clock.now(),
    });
  } catch (e) {
    deps.logger.error('llm usage: insert failed', { orgId: u.orgId, error: (e as Error).message });
  }
}

/**
 * `llm.completeJson` that writes one `llm_usage` row per call with the provider's token counts. A call that reached
 * the model is metered even when its reply was unusable, and so is a call that timed out or was aborted while in
 * flight (0 tokens if none were reported — the provider may still bill it, review N3); a call that failed before
 * reaching the provider (no usage, not aborted, e.g. connection refused) is not. With `reservationId`, the first call
 * fills in that reservation row instead of inserting one, so an analysis has one row per call either way.
 */
export function meteredCompleteJson(
  deps: Pick<AppDeps, 'db' | 'clock' | 'logger' | 'llm'>,
  ctx: { orgId: string; analysisId: string | null; kind: 'extract' | 'assist'; reservationId?: string | null },
) {
  const llm = deps.llm;
  if (!llm) throw new Error('meteredCompleteJson: no LLM configured');
  let reservationId = ctx.reservationId ?? null;
  return async <T = unknown>(req: Parameters<typeof llm.completeJson>[0]): Promise<T> => {
    let reported: Pick<LlmResult, 'model' | 'usage'> | null = null;
    let ok = false;
    try {
      const out = await llm.completeJson<T>(req, { onUsage: (r) => { reported = r; } });
      ok = true;
      return out;
    } finally {
      const r = reported as Pick<LlmResult, 'model' | 'usage'> | null;
      const inFlightAbort = !!(req as { signal?: AbortSignal }).signal?.aborted;
      if (r || ok || inFlightAbort) {
        await recordLlmUsage(deps, {
          orgId: ctx.orgId, analysisId: ctx.analysisId, kind: ctx.kind, reservationId, model: r?.model || llm.model, inputTokens: r?.usage.inputTokens ?? 0, outputTokens: r?.usage.outputTokens ?? 0,
        });
        reservationId = null;
      }
    }
  };
}
