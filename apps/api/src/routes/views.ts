/**
 * Saved feed views (T039; FR-035, NFR-004): personal, scoped to (org, user). A view that belongs to
 * someone else — or to another org — is indistinguishable from a missing one (404, never 403).
 */
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { organizations, savedViews } from '@tp/db';
import { SAVED_VIEW_LIMIT, savedViewCreateSchema, savedViewUpdateSchema, type SavedViewDto } from '@tp/core/contracts/identify';
import { uuidSchema } from '@tp/core/contracts/common';
import type { AppDeps } from '../deps';
import { HttpError, notFound } from '../lib/errors';
import { parseJson } from '../lib/validate';
import { orgId, requireAuth, userId } from '../middleware/auth';
import type { AppEnv } from '../types';

export const viewsRoutes = new Hono<AppEnv>();

type Row = typeof savedViews.$inferSelect;
const toDto = (v: Row): SavedViewDto => ({
  id: v.id, name: v.name, params: v.params, position: v.position, createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString(),
});

const duplicate = () => new HttpError(409, 'view_exists', 'You already have a view with that name — pick another.');
const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
};

async function loadOwn(deps: AppDeps, org: string, user: string, id: string | undefined) {
  if (!id || !uuidSchema.safeParse(id).success) throw notFound('View');
  const [v] = await deps.db.select().from(savedViews).where(and(eq(savedViews.id, id), eq(savedViews.orgId, org), eq(savedViews.userId, user)));
  if (!v) throw notFound('View');
  return v;
}

viewsRoutes.get('/views', requireAuth, async (c) => {
  const rows = await c.var.deps.db.select().from(savedViews)
    .where(and(eq(savedViews.orgId, orgId(c)), eq(savedViews.userId, userId(c))))
    .orderBy(asc(savedViews.position), asc(savedViews.createdAt));
  return c.json({ items: rows.map(toDto), total: rows.length, limit: SAVED_VIEW_LIMIT });
});

viewsRoutes.post('/views', requireAuth, async (c) => {
  const deps = c.var.deps;
  const body = await parseJson(c, savedViewCreateSchema);
  const org = orgId(c);
  const user = userId(c);
  const now = deps.clock.now();
  try {
    const row = await deps.db.transaction(async (tx) => {
      // Serialise concurrent creates for the same org so the limit can't be raced past.
      await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, org)).for('update');
      const [{ n, last }] = await tx.select({ n: count(), last: sql<number>`coalesce(max(${savedViews.position}), -1)` }).from(savedViews)
        .where(and(eq(savedViews.orgId, org), eq(savedViews.userId, user)));
      if (n >= SAVED_VIEW_LIMIT) {
        throw new HttpError(409, 'view_limit', `You can save up to ${SAVED_VIEW_LIMIT} views — delete one first.`, { limit: SAVED_VIEW_LIMIT });
      }
      const [v] = await tx.insert(savedViews).values({
        orgId: org, userId: user, name: body.name, params: body.params, position: Number(last) + 1, createdAt: now, updatedAt: now,
      }).returning();
      return v;
    });
    return c.json(toDto(row), 201);
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicate();
    throw e;
  }
});

viewsRoutes.patch('/views/:id', requireAuth, async (c) => {
  const deps = c.var.deps;
  const org = orgId(c);
  const user = userId(c);
  const v = await loadOwn(deps, org, user, c.req.param('id'));
  const body = await parseJson(c, savedViewUpdateSchema);
  try {
    const [updated] = await deps.db.update(savedViews).set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.params !== undefined ? { params: body.params } : {}),
      updatedAt: deps.clock.now(),
    }).where(and(eq(savedViews.id, v.id), eq(savedViews.orgId, org), eq(savedViews.userId, user))).returning();
    return c.json(toDto(updated));
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicate();
    throw e;
  }
});

viewsRoutes.delete('/views/:id', requireAuth, async (c) => {
  const deps = c.var.deps;
  const org = orgId(c);
  const user = userId(c);
  const v = await loadOwn(deps, org, user, c.req.param('id'));
  await deps.db.delete(savedViews).where(and(eq(savedViews.id, v.id), eq(savedViews.orgId, org), eq(savedViews.userId, user)));
  return c.json({ ok: true });
});
