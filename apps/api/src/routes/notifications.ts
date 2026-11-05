/**
 * In-app notifications (T036; FR-005): list with email/WhatsApp delivery status, mark read.
 * Scoped to the signed-in user in the active org.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { notifications } from '@tp/db';
import { notificationsQuerySchema, type NotificationDto } from '@tp/core/contracts/identify';
import { uuidSchema } from '@tp/core/contracts/common';
import { notFound } from '../lib/errors';
import { parseQuery } from '../lib/validate';
import { orgId, requireAuth, userId } from '../middleware/auth';
import type { AppEnv } from '../types';

export const notificationsRoutes = new Hono<AppEnv>();

notificationsRoutes.get('/notifications', requireAuth, async (c) => {
  const { db } = c.var.deps;
  const q = parseQuery(c, notificationsQuerySchema);
  const scope = and(eq(notifications.orgId, orgId(c)), eq(notifications.userId, userId(c)), eq(notifications.channel, 'in_app'));
  const where = and(
    scope,
    q.unread ? ne(notifications.status, 'read') : undefined,
    q.kind ? eq(notifications.kind, q.kind as NotificationDto['kind']) : undefined,
  );
  const [rows, [{ total }], [{ unread }]] = await Promise.all([
    db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(notifications).where(where),
    db.select({ unread: sql<number>`count(*)::int` }).from(notifications).where(and(scope, ne(notifications.status, 'read'))),
  ]);
  const keys = rows.map((r) => r.dedupeKey).filter((k): k is string => !!k);
  const deliveries = keys.length
    ? await db.select({ dedupeKey: notifications.dedupeKey, channel: notifications.channel, status: notifications.status, error: notifications.error, sentAt: notifications.sentAt })
      .from(notifications)
      .where(and(eq(notifications.orgId, orgId(c)), eq(notifications.userId, userId(c)), ne(notifications.channel, 'in_app'), inArray(notifications.dedupeKey, keys)))
    : [];
  const items: NotificationDto[] = rows.map((r) => ({
    id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, read: r.status === 'read', createdAt: r.createdAt.toISOString(),
    deliveries: deliveries.filter((d) => d.dedupeKey === r.dedupeKey).map((d) => ({
      channel: d.channel as 'email' | 'whatsapp', status: d.status, error: d.error, sentAt: d.sentAt?.toISOString() ?? null,
    })),
  }));
  return c.json({ items, unreadCount: Number(unread), total: Number(total) });
});

notificationsRoutes.post('/notifications/read-all', requireAuth, async (c) => {
  const { db, clock } = c.var.deps;
  const res = await db.update(notifications).set({ status: 'read', readAt: clock.now() })
    .where(and(eq(notifications.orgId, orgId(c)), eq(notifications.userId, userId(c)), eq(notifications.channel, 'in_app'), ne(notifications.status, 'read')))
    .returning({ id: notifications.id });
  return c.json({ ok: true, updated: res.length });
});

notificationsRoutes.post('/notifications/:id/read', requireAuth, async (c) => {
  const { db, clock } = c.var.deps;
  const id = c.req.param('id');
  if (!uuidSchema.safeParse(id).success) throw notFound('Notification');
  const [row] = await db.update(notifications).set({ status: 'read', readAt: clock.now() })
    .where(and(eq(notifications.id, id), eq(notifications.orgId, orgId(c)), eq(notifications.userId, userId(c)), eq(notifications.channel, 'in_app')))
    .returning({ id: notifications.id });
  if (!row) throw notFound('Notification');
  return c.json({ ok: true });
});
