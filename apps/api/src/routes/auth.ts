/**
 * Auth & current-user routes (FR-030): /auth/*, /me, /me/notification-prefs, /me/api-tokens, /me/sessions.
 * Mounted at /api. Rate limiting: 002/FR-010; password reset: 002/FR-011; sessions: 002/FR-012.
 */
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  apiTokens, invitations, memberships, notificationPrefs, organizations, passwordResets, sessions, users, type Db,
} from '@tp/db';
import {
  API_TOKEN_PREFIX, PASSWORD_RESET_TTL_MINUTES, acceptInviteInputSchema, changePasswordInputSchema, createApiTokenInputSchema,
  forgotPasswordInputSchema, loginInputSchema, notificationPrefsSchema, passwordSchema, resetPasswordInputSchema,
  signupInputSchema, summarizeUserAgent, switchOrgInputSchema, updateMeInputSchema,
  type ApiTokenSummary, type InvitePreview, type NotificationPrefs, type RevokeOtherSessionsResponse, type SessionsResponse,
} from '@tp/core/contracts/auth';
import { requireAuth, requireSession, orgId, userId } from '../middleware/auth';
import { logActivity } from '../lib/activity';
import { getDummyHash, hashPassword, randomToken, sha256Hex, verifyPassword } from '../lib/crypto';
import { HttpError, badRequest, conflict, notFound, unauthorized } from '../lib/errors';
import { buildMe } from '../lib/me';
import { LOGIN_IP_LIMIT, RESET_EMAIL_LIMIT, check, clientIp, credentialLimiter, hit, rateLimited, reset } from '../lib/rate-limit';
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

const NO_ORGANIZATION = () => new HttpError(403, 'no_organization', 'You are not a member of any organization. Ask an owner to invite you.');

/** The org to sign into: the most recently used one the user is still a member of, else the oldest membership. */
async function pickSignInOrg(db: Db, uid: string) {
  const [last] = await db.select({ orgId: sessions.activeOrgId }).from(sessions)
    .where(eq(sessions.userId, uid)).orderBy(desc(sessions.createdAt)).limit(1);
  let m = last?.orgId ? await loadMembership(db, uid, last.orgId) : null;
  if (!m) m = await firstMembership(db, uid);
  return m;
}

authRoutes.post('/auth/login', async (c) => {
  const body = await parseJson(c, loginInputSchema);
  const { db, clock } = c.var.deps;
  // 002/FR-010: 10 failures per email, 30 per IP per 15 min. Checked before the password so a full window
  // rejects even the right password.
  const limiter = credentialLimiter(db, body.email, clientIp(c), clock.now());
  await limiter.assert();
  const [u] = await db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.email, body.email));
  const ok = await verifyPassword(body.password, u?.passwordHash ?? (await getDummyHash()));
  if (!u || !ok) {
    await limiter.fail();
    throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password');
  }
  await limiter.succeed();

  // Keep the org the user last worked in when possible.
  const m = await pickSignInOrg(db, u.id);
  if (!m) throw NO_ORGANIZATION();
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

// ───────────── Password reset (002/FR-011) ─────────────

const RESET_INVALID = () => new HttpError(400, 'reset_invalid', 'This password reset link is invalid, already used or has expired. Request a new one.');

/** Always 200 `{ok:true}` (no account enumeration). Emails a single-use 60-minute link to existing users. */
authRoutes.post('/auth/forgot-password', async (c) => {
  const { email } = await parseJson(c, forgotPasswordInputSchema);
  const { db, clock, config, mailer, logger } = c.var.deps;
  const now = clock.now();
  // Counted for every email (existing or not) so the 429 reveals nothing about accounts.
  const st = await hit(db, email, 'reset_email', RESET_EMAIL_LIMIT, now);
  if (st.count > RESET_EMAIL_LIMIT.limit) throw rateLimited(st.retryAfterSec);

  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (u) {
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000);
    // A new link replaces any earlier unused one.
    await db.delete(passwordResets).where(and(eq(passwordResets.userId, u.id), isNull(passwordResets.usedAt)));
    await db.insert(passwordResets).values({ userId: u.id, tokenHash: await sha256Hex(token), expiresAt });
    const resetUrl = `${config.appUrl}/reset-password/${token}`;
    try {
      await mailer.send({
        to: email,
        subject: 'Reset your TenderPilot password',
        text: `Someone asked to reset the password for your TenderPilot account.\n\nSet a new password: ${resetUrl}\n\n`
          + `This link expires in 1 hour and can be used once. If you didn’t ask for this, you can ignore this email.`,
        html: `<p>Someone asked to reset the password for your TenderPilot account.</p><p><a href="${resetUrl}">Set a new password</a></p>`
          + `<p style="color:#666">This link expires in 1 hour and can be used once. If you didn’t ask for this, you can ignore this email.</p>`,
      });
    } catch (e) {
      logger.warn('password reset email failed', { error: (e as Error).message });
    }
  }
  return c.json({ ok: true as const });
});

/** Set a new password from a reset link: signs out every session, consumes the link and starts a new session. */
authRoutes.post('/auth/reset-password', async (c) => {
  const body = await parseJson(c, resetPasswordInputSchema);
  const { db, clock } = c.var.deps;
  const now = clock.now();
  const ip = clientIp(c);
  if (ip) {
    const st = await check(db, ip, 'login_ip', LOGIN_IP_LIMIT, now);
    if (st?.limited) throw rateLimited(st.retryAfterSec);
  }
  const tokenHash = await sha256Hex(body.token);
  const passwordHash = await hashPassword(body.newPassword);
  const uid = await db.transaction(async (tx) => {
    const [r] = await tx.update(passwordResets).set({ usedAt: now })
      .where(and(eq(passwordResets.tokenHash, tokenHash), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)))
      .returning({ userId: passwordResets.userId });
    if (!r) return null;
    await tx.update(users).set({ passwordHash }).where(eq(users.id, r.userId));
    await tx.delete(sessions).where(eq(sessions.userId, r.userId));
    await tx.delete(passwordResets).where(and(eq(passwordResets.userId, r.userId), isNull(passwordResets.usedAt)));
    return r.userId;
  });
  if (!uid) {
    if (ip) await hit(db, ip, 'login_ip', LOGIN_IP_LIMIT, now);
    throw RESET_INVALID();
  }
  // Proving control of the mailbox lifts a sign-in lockout for this email.
  const user = await loadUser(db, uid);
  if (user) await reset(db, user.email, 'login_email');
  const m = await pickSignInOrg(db, uid);
  if (!m) throw NO_ORGANIZATION();
  await startSession(c, uid, m.org.id);
  return respondMe(c, uid, m.org.id);
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
      // Existing-user path acts as a sign-in: same limits as login (002/FR-010).
      const limiter = credentialLimiter(db, inv.email, clientIp(c), clock.now());
      await limiter.assert();
      if (!body.password || !(await verifyPassword(body.password, u.passwordHash))) {
        await limiter.fail();
        throw new HttpError(401, 'invalid_credentials', 'Enter the password for your existing TenderPilot account', { fields: { password: 'Incorrect password' } });
      }
      await limiter.succeed();
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
  const { db, clock } = c.var.deps;
  const limiter = credentialLimiter(db, c.var.user.email, clientIp(c), clock.now());
  await limiter.assert();
  const [u] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId(c)));
  if (!u || !(await verifyPassword(body.currentPassword, u.passwordHash))) {
    await limiter.fail();
    throw new HttpError(400, 'invalid_credentials', 'Current password is incorrect', { fields: { currentPassword: 'Incorrect password' } });
  }
  await limiter.succeed();
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

// ───────────── Sessions (002/FR-012, session-only per FR-036) ─────────────

const UUID_RE = /^[0-9a-f-]{36}$/i;

authRoutes.get('/me/sessions', requireSession, async (c) => {
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

authRoutes.post('/me/sessions/revoke-others', requireSession, async (c) => {
  const deleted = await c.var.deps.db.delete(sessions)
    .where(and(eq(sessions.userId, userId(c)), ne(sessions.id, c.var.sessionId!))).returning({ id: sessions.id });
  const out: RevokeOtherSessionsResponse = { revoked: deleted.length };
  return c.json(out);
});

/** Revoke one of your own sessions (404 for anyone else's). Revoking the current one signs you out. */
authRoutes.delete('/me/sessions/:id', requireSession, async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) throw notFound('Session');
  const deleted = await c.var.deps.db.delete(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId(c)))).returning({ id: sessions.id });
  if (!deleted.length) throw notFound('Session');
  if (id === c.var.sessionId) clearSessionCookie(c);
  return c.json({ ok: true as const });
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
