/**
 * Auth & current-user routes (FR-030): /auth/*, /me, /me/notification-prefs, /me/api-tokens.
 * Mounted at /api.
 */
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  apiTokens, invitations, memberships, notificationPrefs, organizations, sessions, users, type Db,
} from '@tp/db';
import {
  API_TOKEN_PREFIX, acceptInviteInputSchema, changePasswordInputSchema, createApiTokenInputSchema, loginInputSchema,
  notificationPrefsSchema, passwordSchema, signupInputSchema, switchOrgInputSchema, updateMeInputSchema,
  type ApiTokenSummary, type InvitePreview, type NotificationPrefs,
} from '@tp/core/contracts/auth';
import { requireAuth, requireSession, orgId, userId } from '../middleware/auth';
import { logActivity } from '../lib/activity';
import { getDummyHash, hashPassword, randomToken, sha256Hex, verifyPassword } from '../lib/crypto';
import { HttpError, badRequest, conflict, notFound, unauthorized } from '../lib/errors';
import { buildMe } from '../lib/me';
import { clearSessionCookie, firstMembership, loadMembership, loadUser, resolveAuth, startSession } from '../lib/session';
import { slugify } from '../lib/slug';
import { parseJson, parseWith } from '../lib/validate';
import type { AppEnv } from '../types';

export const authRoutes = new Hono<AppEnv>();

const DEFAULT_PREFS: NotificationPrefs = { inApp: true, email: true, whatsapp: false, frequency: 'instant', expiryReminders: true };

async function uniqueSlug(db: Db, name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 6; i++) {
    const slug = i === 0 ? base : `${base}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    const [hit] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
    if (!hit) return slug;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Respond with Me for the given user/org (after login, signup, switch…). */
async function respondMe(c: Context<AppEnv>, uid: string, oid: string, status: 200 | 201 = 200) {
  const db = c.var.deps.db;
  const user = await loadUser(db, uid);
  const m = await loadMembership(db, uid, oid);
  if (!user || !m) throw unauthorized();
  return c.json(await buildMe(db, user, m.org, m.role), status);
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}

// ───────────── Signup / login / logout ─────────────

authRoutes.post('/auth/signup', async (c) => {
  const body = await parseJson(c, signupInputSchema);
  const { db } = c.var.deps;
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
  if (existing) throw conflict('An account with this email already exists. Try signing in instead.', { fields: { email: 'Already registered' } });

  const passwordHash = await hashPassword(body.password);
  const slug = await uniqueSlug(db, body.orgName);
  let ids: { userId: string; orgId: string };
  try {
    ids = await db.transaction(async (tx) => {
      const [u] = await tx.insert(users).values({ email: body.email, name: body.name, passwordHash }).returning({ id: users.id });
      const [o] = await tx.insert(organizations).values({ name: body.orgName, slug }).returning({ id: organizations.id });
      await tx.insert(memberships).values({ orgId: o.id, userId: u.id, role: 'owner' });
      await tx.insert(notificationPrefs).values({ orgId: o.id, userId: u.id, ...DEFAULT_PREFS });
      return { userId: u.id, orgId: o.id };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('An account with this email already exists. Try signing in instead.', { fields: { email: 'Already registered' } });
    throw e;
  }
  await logActivity(db, { orgId: ids.orgId, userId: ids.userId, action: 'org.created', entityType: 'organization', entityId: ids.orgId, meta: { name: body.orgName } });
  await startSession(c, ids.userId, ids.orgId);
  return respondMe(c, ids.userId, ids.orgId, 201);
});

authRoutes.post('/auth/login', async (c) => {
  const body = await parseJson(c, loginInputSchema);
  const { db } = c.var.deps;
  const [u] = await db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.email, body.email));
  const ok = await verifyPassword(body.password, u?.passwordHash ?? (await getDummyHash()));
  if (!u || !ok) throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password');

  // Keep the org the user last worked in when possible.
  const [last] = await db.select({ orgId: sessions.activeOrgId }).from(sessions)
    .where(eq(sessions.userId, u.id)).orderBy(desc(sessions.createdAt)).limit(1);
  let m = last?.orgId ? await loadMembership(db, u.id, last.orgId) : null;
  if (!m) m = await firstMembership(db, u.id);
  if (!m) throw new HttpError(403, 'no_organization', 'You are not a member of any organization. Ask an owner to invite you.');
  await startSession(c, u.id, m.org.id);
  return respondMe(c, u.id, m.org.id);
});

authRoutes.post('/auth/logout', async (c) => {
  const auth = await resolveAuth(c).catch(() => null);
  if (auth?.sessionId) await c.var.deps.db.delete(sessions).where(eq(sessions.id, auth.sessionId));
  clearSessionCookie(c);
  return c.json({ ok: true as const });
});

authRoutes.get('/auth/me', requireAuth, async (c) => {
  return c.json(await buildMe(c.var.deps.db, c.var.user, c.var.org, c.var.role));
});

authRoutes.post('/auth/switch-org', requireSession, async (c) => {
  const { orgId: target } = await parseJson(c, switchOrgInputSchema);
  const { db } = c.var.deps;
  const m = await loadMembership(db, c.var.user.id, target);
  if (!m) throw notFound('Organization');
  await db.update(sessions).set({ activeOrgId: target }).where(eq(sessions.id, c.var.sessionId!));
  return respondMe(c, c.var.user.id, target);
});

// ───────────── Invitations (public side) ─────────────

async function findInvite(db: Db, token: string, now: Date) {
  const [inv] = await db.select({
    id: invitations.id, orgId: invitations.orgId, email: invitations.email, role: invitations.role,
    expiresAt: invitations.expiresAt, invitedBy: invitations.invitedBy, orgName: organizations.name,
  }).from(invitations).innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(and(eq(invitations.tokenHash, await sha256Hex(token)), isNull(invitations.acceptedAt), gt(invitations.expiresAt, now)));
  return inv ?? null;
}

const INVITE_INVALID = () => new HttpError(404, 'invite_invalid', 'This invitation link is invalid, already used or has expired. Ask your admin for a new one.');

/** Preview an invitation before accepting (public). */
authRoutes.get('/auth/invite/:token', async (c) => {
  const { db, clock } = c.var.deps;
  const inv = await findInvite(db, c.req.param('token'), clock.now());
  if (!inv) throw INVITE_INVALID();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
  const inviter = inv.invitedBy ? await loadUser(db, inv.invitedBy) : null;
  const out: InvitePreview = {
    orgName: inv.orgName, email: inv.email, role: inv.role, invitedBy: inviter?.name ?? null,
    expiresAt: inv.expiresAt.toISOString(), existingUser: !!existing,
  };
  return c.json(out);
});

/**
 * Accept an invitation.
 * - Signed in: joins the current user to the org.
 * - Not signed in, account exists for the invited email: `password` required (acts as login).
 * - Not signed in, new email: `name` + `password` required (creates the account).
 */
authRoutes.post('/auth/accept-invite', async (c) => {
  const body = await parseJson(c, acceptInviteInputSchema);
  const { db, clock } = c.var.deps;
  const inv = await findInvite(db, body.token, clock.now());
  if (!inv) throw INVITE_INVALID();

  const current = await resolveAuth(c).catch(() => null);
  let uid: string;
  let needsSession = true;
  if (current && current.kind === 'session') {
    uid = current.user.id;
    needsSession = false;
  } else {
    const [u] = await db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.email, inv.email));
    if (u) {
      if (!body.password || !(await verifyPassword(body.password, u.passwordHash))) {
        throw new HttpError(401, 'invalid_credentials', 'Enter the password for your existing TenderPilot account', { fields: { password: 'Incorrect password' } });
      }
      uid = u.id;
    } else {
      if (!body.name) throw badRequest('Your name is required', { fields: { name: 'Required' } });
      const password = parseWith(passwordSchema, body.password ?? '', 'password');
      const [created] = await db.insert(users).values({ email: inv.email, name: body.name, passwordHash: await hashPassword(password) }).returning({ id: users.id });
      uid = created.id;
    }
  }

  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ orgId: inv.orgId, userId: uid, role: inv.role }).onConflictDoNothing();
    await tx.insert(notificationPrefs).values({ orgId: inv.orgId, userId: uid, ...DEFAULT_PREFS }).onConflictDoNothing();
    await tx.update(invitations).set({ acceptedAt: clock.now() }).where(eq(invitations.id, inv.id));
  });
  await logActivity(db, { orgId: inv.orgId, userId: uid, action: 'member.joined', entityType: 'user', entityId: uid, meta: { role: inv.role, email: inv.email } });

  if (needsSession) await startSession(c, uid, inv.orgId);
  else await db.update(sessions).set({ activeOrgId: inv.orgId }).where(eq(sessions.id, current!.sessionId!));
  return respondMe(c, uid, inv.orgId);
});

// ───────────── Me ─────────────

authRoutes.patch('/me', requireAuth, async (c) => {
  const body = await parseJson(c, updateMeInputSchema);
  const patch: Partial<typeof users.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.phone !== undefined) patch.phone = body.phone;
  if (Object.keys(patch).length) await c.var.deps.db.update(users).set(patch).where(eq(users.id, userId(c)));
  return respondMe(c, userId(c), orgId(c));
});

authRoutes.post('/me/password', requireSession, async (c) => {
  const body = await parseJson(c, changePasswordInputSchema);
  const { db } = c.var.deps;
  const [u] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId(c)));
  if (!u || !(await verifyPassword(body.currentPassword, u.passwordHash))) {
    throw new HttpError(400, 'invalid_credentials', 'Current password is incorrect', { fields: { currentPassword: 'Incorrect password' } });
  }
  await db.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, userId(c)));
  // Sign out other sessions.
  await db.delete(sessions).where(and(eq(sessions.userId, userId(c)), ne(sessions.id, c.var.sessionId!)));
  return c.json({ ok: true as const });
});

authRoutes.get('/me/notification-prefs', requireAuth, async (c) => {
  const [p] = await c.var.deps.db.select().from(notificationPrefs)
    .where(and(eq(notificationPrefs.orgId, orgId(c)), eq(notificationPrefs.userId, userId(c))));
  const out: NotificationPrefs = p
    ? { inApp: p.inApp, email: p.email, whatsapp: p.whatsapp, frequency: p.frequency, expiryReminders: p.expiryReminders }
    : DEFAULT_PREFS;
  return c.json(out);
});

authRoutes.put('/me/notification-prefs', requireAuth, async (c) => {
  const body = await parseJson(c, notificationPrefsSchema);
  if (body.whatsapp && !c.var.user.phone) {
    throw badRequest('Add your mobile number in your profile to receive WhatsApp alerts', { fields: { whatsapp: 'Phone number required' } });
  }
  await c.var.deps.db.insert(notificationPrefs).values({ orgId: orgId(c), userId: userId(c), ...body })
    .onConflictDoUpdate({ target: [notificationPrefs.orgId, notificationPrefs.userId], set: body });
  return c.json(body);
});

// ───────────── API tokens (browser extension) ─────────────

const tokenSummary = (t: typeof apiTokens.$inferSelect): ApiTokenSummary => ({
  id: t.id, name: t.name, lastUsedAt: t.lastUsedAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString(),
});

authRoutes.get('/me/api-tokens', requireAuth, async (c) => {
  const rows = await c.var.deps.db.select().from(apiTokens)
    .where(and(eq(apiTokens.orgId, orgId(c)), eq(apiTokens.userId, userId(c)))).orderBy(desc(apiTokens.createdAt));
  return c.json({ items: rows.map(tokenSummary), total: rows.length });
});

authRoutes.post('/me/api-tokens', requireSession, async (c) => {
  const body = await parseJson(c, createApiTokenInputSchema);
  const { db } = c.var.deps;
  const token = API_TOKEN_PREFIX + randomToken();
  const [row] = await db.insert(apiTokens).values({ orgId: orgId(c), userId: userId(c), name: body.name, tokenHash: await sha256Hex(token) }).returning();
  await logActivity(db, { orgId: orgId(c), userId: userId(c), action: 'api_token.created', entityType: 'api_token', entityId: row.id, meta: { name: body.name } });
  return c.json({ ...tokenSummary(row), token }, 201);
});

authRoutes.delete('/me/api-tokens/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('API token');
  const { db } = c.var.deps;
  const deleted = await db.delete(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.orgId, orgId(c)), eq(apiTokens.userId, userId(c)))).returning({ id: apiTokens.id });
  if (!deleted.length) throw notFound('API token');
  await logActivity(db, { orgId: orgId(c), userId: userId(c), action: 'api_token.revoked', entityType: 'api_token', entityId: id });
  return c.json({ ok: true as const });
});
