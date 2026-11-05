/**
 * In-app notifications (T036; FR-005): list with email/WhatsApp delivery status, mark read.
 * Scoped to the signed-in user in the active org.
 * Test alert (002/FR-034): `POST /me/notifications/test` across the user's enabled channels.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { memberships, notificationPrefs, notifications } from '@tp/db';
import { notificationsQuerySchema, type NotificationDto } from '@tp/core/contracts/identify';
import {
  DEFAULT_NOTIFICATION_PREFS, TEST_ALERT_TITLE, type TestAlertOutcome, type TestAlertResult, type TestAlertSkipReason,
} from '@tp/core/contracts/auth';
import { uuidSchema } from '@tp/core/contracts/common';
import { HttpError, notFound } from '../lib/errors';
import { unsubscribeHeaders, verifyUnsubscribeToken } from '../lib/unsubscribe';
import { TEST_ALERT_LIMIT, hit, rateLimited } from '../lib/rate-limit';
import { parseQuery } from '../lib/validate';
import { orgId, requireAuth, requireSession, userId } from '../middleware/auth';
import { WHATSAPP_TEMPLATE, renderAlertEmail } from '../services/alerts';
import type { AppEnv } from '../types';

export const notificationsRoutes = new Hono<AppEnv>();

notificationsRoutes.get('/notifications', requireAuth, async (c) => {
  const { db } = c.var.deps;
  const q = parseQuery(c, notificationsQuerySchema);
  const scope = and(eq(notifications.orgId, orgId(c)), eq(notifications.userId, userId(c)), eq(notifications.channel, 'in_app'));
  const where = and(
    scope,
    q.unread ? ne(notifications.status, 'read') : undefined,
    q.kind ? eq(notifications.kind, q.kind) : undefined,
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

/**
 * One-click unsubscribe (003/FR-048, RFC 8058). PUBLIC: the signed `?token=` is the credential (lib/unsubscribe.ts), so
 * mail clients can POST `List-Unsubscribe=One-Click` and people can click the GET link without signing in. Switches
 * email alerts off for that user in that org; idempotent. Tampered/unknown token → 400 `invalid_token`.
 */
async function unsubscribe(c: Context<AppEnv>) {
  const { db, config } = c.var.deps;
  const who = await verifyUnsubscribeToken(config.unsubscribeSecret, c.req.query('token') ?? '');
  const [member] = who
    ? await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.userId, who.userId), eq(memberships.orgId, who.orgId)))
    : [];
  if (!who || !member) throw new HttpError(400, 'invalid_token', 'This unsubscribe link is invalid');
  await db.insert(notificationPrefs).values({ orgId: who.orgId, userId: who.userId, email: false })
    .onConflictDoUpdate({ target: [notificationPrefs.orgId, notificationPrefs.userId], set: { email: false } });
  return who;
}

notificationsRoutes.post('/notifications/unsubscribe', async (c) => {
  await unsubscribe(c);
  return c.json({ ok: true, email: false });
});

notificationsRoutes.get('/notifications/unsubscribe', async (c) => {
  await unsubscribe(c);
  return c.html('<!doctype html><meta charset="utf-8"><title>Unsubscribed</title><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto"><h1>You are unsubscribed</h1><p>TenderPilot will no longer email you new-tender match alerts. You can turn them back on in Settings &rarr; Notifications.</p></body>');
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

/**
 * Send yourself a test alert (002/FR-034; NFR-007). At most 1 per user per minute (429 `rate_limited` +
 * Retry-After). The in-app row "Test alert from TenderPilot" is ALWAYS created (spec 002 US4 scenario 8), so
 * `inApp` is always `sent` and every allowed call does work — hence the limit is taken first. Email and
 * WhatsApp are attempted only when switched on in the user's prefs for the active org (`off` otherwise); a
 * channel that is not configured on this server (log adapter) or has no mobile number reports `skipped`, with the
 * reason in the optional `skipReasons` (`not_configured` | `no_phone`).
 * Email/WhatsApp outcomes are also recorded as delivery rows linked to the in-app row (same dedupe key), so
 * the Notifications page shows them like any other alert. Rows are written in a final state, never `pending`,
 * so the dispatcher does not resend them.
 */
notificationsRoutes.post('/me/notifications/test', requireSession, async (c) => {
  const { db, clock, mailer, whatsapp, config, logger } = c.var.deps;
  const now = clock.now();
  const limit = await hit(db, userId(c), 'test_alert', TEST_ALERT_LIMIT, now);
  if (limit.over) throw rateLimited(limit.retryAfterSec);

  const [row] = await db.select().from(notificationPrefs)
    .where(and(eq(notificationPrefs.orgId, orgId(c)), eq(notificationPrefs.userId, userId(c))));
  const prefs = row ?? DEFAULT_NOTIFICATION_PREFS;
  const user = c.var.user;
  const body = `This is a test from ${c.var.org.name}. If you can read this, ${user.name} will get TenderPilot alerts here.`;
  const link = '/settings/notifications';
  const url = `${config.appUrl}${link}`;
  const base = { orgId: orgId(c), userId: userId(c), kind: 'system' as const, title: TEST_ALERT_TITLE, body, link, dedupeKey: `test:${crypto.randomUUID()}`, createdAt: now };
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

  const skipReasons: NonNullable<TestAlertResult['skipReasons']> = {};
  type Skip = { skipped: true; reason: string; code: TestAlertSkipReason };
  const attempt = async (channel: 'email' | 'whatsapp', enabled: boolean, send: () => Promise<Skip | null>): Promise<TestAlertOutcome> => {
    if (!enabled) return 'off';
    let outcome: TestAlertOutcome;
    let error: string | null = null;
    try {
      const r = await send();
      if (r) {
        outcome = 'skipped';
        error = r.reason;
        skipReasons[channel] = r.code;
      } else outcome = 'sent';
    } catch (e) {
      logger.warn('test alert send failed', { channel, error: errMsg(e) });
      outcome = 'failed';
      error = errMsg(e);
    }
    await db.insert(notifications).values({ ...base, channel, status: outcome as 'sent' | 'skipped' | 'failed', error, sentAt: outcome === 'sent' ? now : null });
    return outcome;
  };

  await db.insert(notifications).values({ ...base, channel: 'in_app', status: 'sent', sentAt: now });
  const result: TestAlertResult = { inApp: 'sent', email: 'off', whatsapp: 'off' };
  result.email = await attempt('email', prefs.email, async () => {
    const r = await mailer.send({
      to: user.email,
      subject: TEST_ALERT_TITLE,
      headers: await unsubscribeHeaders(config, userId(c), orgId(c)),
      html: renderAlertEmail({ heading: TEST_ALERT_TITLE, intro: body, rows: [], appUrl: config.appUrl, orgName: c.var.org.name, now }),
      text: `${TEST_ALERT_TITLE}\n${body}\n\nManage alerts: ${url}`,
    });
    return r.skipped ? { skipped: true as const, reason: 'Email is not configured (RESEND_API_KEY)', code: 'not_configured' as const } : null;
  });
  result.whatsapp = await attempt('whatsapp', prefs.whatsapp, async () => {
    if (!user.phone) return { skipped: true as const, reason: 'No mobile number on the account', code: 'no_phone' as const };
    const r = await whatsapp.send({
      to: user.phone,
      // Same template as real alerts (title, bid number, closing date, link): readable filler for the test.
      template: { name: WHATSAPP_TEMPLATE, language: 'en', params: [TEST_ALERT_TITLE, 'Test only (no bid)', 'No closing date (test alert)', url] },
      text: `${TEST_ALERT_TITLE}\n${body}\n${url}`,
    });
    return r.skipped ? { skipped: true as const, reason: 'WhatsApp is not configured (WHATSAPP_TOKEN)', code: 'not_configured' as const } : null;
  });
  // Optional field (backward compatible): only present when something was skipped.
  if (Object.keys(skipReasons).length) result.skipReasons = skipReasons;
  return c.json(result);
});
