/**
 * Plan limits and usage metering (spec 008 US5: FR-034…FR-039, FR-043).
 *
 *   await assertWithinPlan(deps, orgId, 'watchlists', 1);       // → 402 plan_limit_reached when over
 *   const u = await usageFor(deps, orgId);                      // GET /org/usage
 *
 * The plan is read from the database on every call (no caching beyond one request, FR-043); `enterprise` is never
 * limited. Monthly counters use the IST calendar month (`istMonthPeriod`).
 *
 * Serialisation (review N2): analyses (`checkAnalysisQuota`) and watchlists check and insert under the org row lock,
 * so concurrent requests cannot overshoot those limits. Seats, vault bytes and packets are check-then-insert without
 * the lock: two requests racing past the check can overshoot by at most the concurrent requests (one invite, one file,
 * one packet each). Accepted — they are not a cost risk like the LLM, and the next request sees the real count.
 */
import { and, count, countDistinct, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, sum } from 'drizzle-orm';
import {
  analyses, invitations, llmUsage, memberships, organizations, packetLedger, vaultDocuments, vaultDocumentVersions, watchlists,
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
      // Every packet a user built counts — demo workspace or not (review S2) — and keeps counting once deleted (e.g. by
      // `DELETE /demo`, review SF-1): the FK-free ledger, written with the packet and removed only when its build fails.
      const [r] = await db.select({ n: count() }).from(packetLedger)
        .where(and(eq(packetLedger.orgId, orgId), gte(packetLedger.createdAt, start), lt(packetLedger.createdAt, end)));
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
 * Analyse quota (FR-036, FR-037), to be called inside the transaction that inserts the `analyses` row, BEFORE that
 * insert: locks the org row (`SELECT … FOR NO KEY UPDATE`) so concurrent analyses of one org are counted one at a
 * time, throws 402 when the monthly analyses are used up, and reports whether this analysis may still use the LLM.
 * When it may (and an LLM is configured), the caller then inserts the `analyses` row and reserves the AI slot with
 * `reserveLlmSlot` in the same transaction (review S1, NEW-B1).
 */
export async function checkAnalysisQuota(deps: Pick<AppDeps, 'clock'>, tx: DbOrTx, orgId: string): Promise<{ llmAllowed: boolean }> {
  const { plan } = await loadPlan(tx, orgId, { forUpdate: true });
  let llmAllowed = true;
  if (plan !== 'enterprise') {
    await assertWithinPlan({ db: tx as Db, clock: deps.clock }, orgId, 'analysesPerMonth', 1, { db: tx, plan });
    const llmMax = limitsFor(plan).llmAnalysesPerMonth;
    if (llmMax != null) llmAllowed = (await usedOf(tx, orgId, 'llmAnalysesPerMonth', deps.clock.now())) < llmMax;
  }
  return { llmAllowed };
}

/**
 * RESERVE the AI slot of a just-inserted analysis, in the transaction that inserted it (after `checkAnalysisQuota`):
 * a 0-token `llm_usage` row (`kind: 'extract'`, `analysis_id` and `analysis_ref` = the analysis) that counts at once,
 * so concurrent analyses cannot all get AI past the quota (review S1). The first metered LLM call fills in its model
 * and tokens (`meteredCompleteJson`); `analysis_id` is set here, never by the fill, so a later delete of the analysis
 * (FK `ON DELETE SET NULL`) cannot make the fill fail (review NEW-B1). Returns the reservation id.
 */
export async function reserveLlmSlot(
  deps: Pick<AppDeps, 'clock'>, tx: DbOrTx, r: { orgId: string; analysisId: string; model: string },
): Promise<string> {
  const [row] = await tx.insert(llmUsage).values({
    orgId: r.orgId, analysisId: r.analysisId, analysisRef: r.analysisId, kind: 'extract', model: r.model, inputTokens: 0, outputTokens: 0,
    reserved: true, createdAt: deps.clock.now(),
  }).returning({ id: llmUsage.id });
  return row!.id;
}

/**
 * Give back an AI slot reserved by `reserveLlmSlot`: delete that row by id. Only `LlmMeter` calls it, and only when no
 * LLM call of the analysis was metered (the decision is in-process, never read from `analysis_id`, review NEW-B1).
 * Never throws.
 */
async function releaseLlmReservation(deps: Pick<AppDeps, 'db' | 'logger'>, reservationId: string): Promise<void> {
  try {
    await deps.db.delete(llmUsage).where(eq(llmUsage.id, reservationId));
  } catch (e) {
    deps.logger.error('llm usage: releasing the reservation failed', { reservationId, error: (e as Error).message });
  }
}

/**
 * Release the unfilled reservations (`reserved = true`) of analyses that were just marked timed out (review NIT-a): a
 * run that died (process crash) before its own release leaves one behind, which would otherwise count as an AI
 * analysis for the month. A reservation a call already filled in (`reserved = false`, even with 0 tokens for an
 * aborted call) is kept; a call of that run settling even later inserts its own row (`recordLlmUsage`).
 */
export async function releaseAbandonedReservations(tx: DbOrTx, orgId: string, analysisIds: string[]): Promise<void> {
  if (!analysisIds.length) return;
  await tx.delete(llmUsage).where(and(
    eq(llmUsage.orgId, orgId), eq(llmUsage.reserved, true), inArray(llmUsage.analysisRef, analysisIds),
  ));
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
  /** Fill in this reservation row (see `reserveLlmSlot`) instead of inserting a new one. */
  reservationId?: string | null;
  kind: 'extract' | 'assist';
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** SQLSTATE of a database error, also when the driver wraps it (`cause`). */
function sqlState(e: unknown): string | undefined {
  let x = e as { code?: unknown; cause?: unknown } | undefined;
  for (let i = 0; i < 3 && x; i++, x = x.cause as typeof x) if (typeof x.code === 'string') return x.code;
  return undefined;
}

/**
 * Record one LLM call in `llm_usage`. Never throws: metering must not fail the user's request.
 * With `reservationId`, fills in that reservation's model and tokens — never `analysis_id`, which the reservation
 * already holds (review NEW-B1). Otherwise inserts a row; if the analysis was deleted meanwhile (e.g. by `DELETE /demo`,
 * SQLSTATE 23503 on `analysis_id`) it is inserted without that link but keeps `analysis_ref`, so the tokens and the
 * AI slot are still metered.
 */
export async function recordLlmUsage(deps: Pick<AppDeps, 'db' | 'clock' | 'logger'>, u: LlmUsageInput): Promise<void> {
  const tokens = { inputTokens: Math.max(0, Math.round(u.inputTokens)), outputTokens: Math.max(0, Math.round(u.outputTokens)) };
  try {
    if (u.reservationId) {
      const filled = await deps.db.update(llmUsage).set({ model: u.model, ...tokens, reserved: false })
        .where(eq(llmUsage.id, u.reservationId)).returning({ id: llmUsage.id });
      if (filled.length) return;
    }
    const row = {
      orgId: u.orgId, analysisId: u.analysisId ?? null, analysisRef: u.analysisId ?? null, kind: u.kind, model: u.model, ...tokens,
      createdAt: deps.clock.now(),
    };
    try {
      await deps.db.insert(llmUsage).values(row);
    } catch (e) {
      if (sqlState(e) !== '23503' || !row.analysisId) throw e;
      await deps.db.insert(llmUsage).values({ ...row, analysisId: null });
    }
  } catch (e) {
    deps.logger.error('llm usage: insert failed', { orgId: u.orgId, error: (e as Error).message });
  }
}

/** `llm.completeJson`, metered; `finish()` ends the analysis's use of it (see `meteredCompleteJson`). */
export type MeteredCompleteJson = (<T = unknown>(req: Parameters<NonNullable<AppDeps['llm']>['completeJson']>[0]) => Promise<T>) & {
  finish: () => Promise<void>;
};

/**
 * `llm.completeJson` that writes one `llm_usage` row per call with the provider's token counts. A call that reached
 * the model is metered even when its reply was unusable, and so is a call that timed out or was aborted while in
 * flight (0 tokens if none were reported — the provider may still bill it, review N3); a call that failed before
 * reaching the provider (no usage, not aborted, e.g. connection refused) is not. With `reservationId`, the first
 * metered call fills in that reservation row instead of inserting one, so an analysis has one row per call either way.
 *
 * `finish()` — call it when the analysis ends, whatever the outcome. The reservation is given back (deleted by id)
 * only if NO call of this analysis was metered, decided from this in-process state and never from the row's
 * `analysis_id`, which a delete of the analysis nulls (review NEW-B1). If a call is still in flight (e.g. it timed
 * out on our side but has not settled), the decision waits until it settles, so the slot is never briefly free while
 * that call may still be billed (review NIT-b). Never throws.
 */
export function meteredCompleteJson(
  deps: Pick<AppDeps, 'db' | 'clock' | 'logger' | 'llm'>,
  ctx: { orgId: string; analysisId: string | null; kind: 'extract' | 'assist'; reservationId?: string | null },
): MeteredCompleteJson {
  const llm = deps.llm;
  if (!llm) throw new Error('meteredCompleteJson: no LLM configured');
  let reservationId = ctx.reservationId ?? null;
  let metered = false;
  let finished = false;
  let inFlight = 0;
  const releaseIfUnused = async () => {
    if (!finished || metered || inFlight > 0 || !reservationId) return;
    const id = reservationId;
    reservationId = null;
    await releaseLlmReservation(deps, id);
  };
  const call = async <T = unknown>(req: Parameters<typeof llm.completeJson>[0]): Promise<T> => {
    inFlight++;
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
        // Synchronously, before any await: a concurrent `finish()` must already see this call as metered.
        metered = true;
        const fill = reservationId;
        reservationId = null;
        await recordLlmUsage(deps, {
          orgId: ctx.orgId, analysisId: ctx.analysisId, kind: ctx.kind, reservationId: fill, model: r?.model || llm.model, inputTokens: r?.usage.inputTokens ?? 0, outputTokens: r?.usage.outputTokens ?? 0,
        });
      }
      inFlight--;
      await releaseIfUnused();
    }
  };
  return Object.assign(call, { finish: async () => { finished = true; await releaseIfUnused(); } });
}
