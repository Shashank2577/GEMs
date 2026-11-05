/**
 * "Where you're signed in" (002/FR-012): list and revoke your own browser sessions.
 * Session-only (API tokens get 403, FR-036). Mounted at /api.
 */
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { sessions } from '@tp/db';
import { summarizeUserAgent, type RevokeOtherSessionsResponse, type SessionsResponse } from '@tp/core/contracts/auth';
import { orgId, requireSession, userId } from '../middleware/auth';
import { logActivity } from '../lib/activity';
import { notFound } from '../lib/errors';
import { clearSessionCookie } from '../lib/session';
import type { AppEnv } from '../types';

export const sessionsRoutes = new Hono<AppEnv>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

sessionsRoutes.get('/me/sessions', requireSession, async (c) => {
  const { db, clock } = c.var.deps;
  const current = c.var.sessionId!;
  const rows = await db.select({
    id: sessions.id, userAgent: sessions.userAgent, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt,
  }).from(sessions)
    .where(and(eq(sessions.userId, userId(c)), gt(sessions.expiresAt, clock.now())))
    .orderBy(sql`${sessions.id} = ${current} desc`, sql`coalesce(${sessions.lastSeenAt}, ${sessions.createdAt}) desc`);
  const out: SessionsResponse = {
    items: rows.map((r) => ({
      id: r.id, current: r.id === current, userAgent: r.userAgent, device: summarizeUserAgent(r.userAgent),
      createdAt: r.createdAt.toISOString(), lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    })),
    total: rows.length,
  };
  return c.json(out);
});

sessionsRoutes.post('/me/sessions/revoke-others', requireSession, async (c) => {
  const deleted = await c.var.deps.db.delete(sessions)
    .where(and(eq(sessions.userId, userId(c)), ne(sessions.id, c.var.sessionId!))).returning({ id: sessions.id });
  if (deleted.length) {
    await logActivity(c.var.deps.db, { orgId: orgId(c), userId: userId(c), action: 'auth.sessions_revoked', entityType: 'user', entityId: userId(c), meta: { scope: 'others', count: deleted.length } });
  }
  const out: RevokeOtherSessionsResponse = { revoked: deleted.length };
  return c.json(out);
});

/** Revoke one of your own sessions (404 for anyone else's or a malformed id). Revoking the current one signs you out. */
sessionsRoutes.delete('/me/sessions/:id', requireSession, async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) throw notFound('Session');
  const deleted = await c.var.deps.db.delete(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId(c)))).returning({ id: sessions.id });
  if (!deleted.length) throw notFound('Session');
  const self = id === c.var.sessionId;
  await logActivity(c.var.deps.db, { orgId: orgId(c), userId: userId(c), action: 'auth.sessions_revoked', entityType: 'user', entityId: userId(c), meta: { scope: self ? 'current' : 'one', count: 1 } });
  if (self) clearSessionCookie(c);
  return c.json({ ok: true as const });
});
