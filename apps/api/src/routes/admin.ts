/**
 * Operator endpoints (spec 008 FR-042, FR-043). Mounted at /api.
 *
 *   POST /admin/orgs/:id/plan  {plan, note, trialEndsAt?}   Authorization: Bearer <ADMIN_TOKEN>
 *
 * Without `ADMIN_TOKEN` configured, with no/a wrong token, or for an unknown org the route answers the same 404 as any
 * unknown path, so its existence is not revealed. The token is compared in constant time (SHA-256 digests).
 */
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { organizations, subscriptions } from '@tp/db';
import { uuidSchema } from '@tp/core/contracts/common';
import { adminPlanInputSchema, trialEndsAtFor, type AdminPlanResponse } from '@tp/core/contracts/plans';
import { logActivity } from '../lib/activity';
import { timingSafeEqual } from '../lib/crypto';
import { parseJson } from '../lib/validate';
import { notFoundHandler } from '../middleware/error';
import type { AppEnv } from '../types';

export const adminRoutes = new Hono<AppEnv>();

/** Thrown inside the transaction for an unknown org; answered with the generic 404. */
class UnknownOrg extends Error {}

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** True when the request carries `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare). */
export async function isAdmin(c: Context<AppEnv>): Promise<boolean> {
  const expected = c.var.deps.config.adminToken;
  if (!expected) return false;
  const m = (c.req.header('authorization') ?? '').match(/^Bearer\s+(\S+)$/i);
  const given = m?.[1] ?? '';
  // Always hash and compare, so the time taken does not depend on whether/how a token was sent.
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return timingSafeEqual(a, b) && given.length > 0;
}

adminRoutes.post('/admin/orgs/:id/plan', async (c) => {
  // Same response as any unknown /api path (middleware/error.ts#notFoundHandler).
  if (!(await isAdmin(c))) return notFoundHandler(c);
  const id = uuidSchema.safeParse(c.req.param('id'));
  if (!id.success) return notFoundHandler(c);
  const body = await parseJson(c, adminPlanInputSchema);
  const { db, clock } = c.var.deps;
  const now = clock.now();

  let out: AdminPlanResponse;
  try {
    out = await db.transaction(async (tx) => {
      const [org] = await tx.select({ id: organizations.id, plan: organizations.plan, trialEndsAt: organizations.trialEndsAt })
        .from(organizations).where(eq(organizations.id, id.data)).for('update');
      if (!org) throw new UnknownOrg();
      // Paid plans have no trial end; a trial keeps (or is given) one — an explicit `trialEndsAt` extends or ends it.
      const trialEndsAt = body.plan !== 'trial'
        ? null
        : body.trialEndsAt ? new Date(body.trialEndsAt) : org.trialEndsAt ?? trialEndsAtFor(now);
      await tx.update(organizations).set({ plan: body.plan, trialEndsAt }).where(eq(organizations.id, org.id));
      await tx.update(subscriptions).set({ status: 'cancelled', endsAt: now })
        .where(and(eq(subscriptions.orgId, org.id), eq(subscriptions.status, 'active')));
      const [sub] = await tx.insert(subscriptions).values({
        orgId: org.id, plan: body.plan, status: 'active', startedAt: now, note: body.note, createdBy: 'admin', createdAt: now,
      }).returning({ id: subscriptions.id });
      await logActivity(tx, {
        orgId: org.id, userId: null, action: 'org.plan_changed', entityType: 'organization', entityId: org.id,
        meta: { from: org.plan, to: body.plan, note: body.note, trialEndsAt: trialEndsAt?.toISOString() ?? null },
    });
    return { org: { id: org.id, plan: body.plan, trialEndsAt: trialEndsAt?.toISOString() ?? null }, subscriptionId: sub!.id };
    });
  } catch (e) {
    if (e instanceof UnknownOrg) return notFoundHandler(c);
    throw e;
  }
  c.var.deps.logger.info('admin: plan changed', { orgId: out.org.id, plan: out.org.plan });
  return c.json(out);
});
