/**
 * Organization routes (FR-031..033): /org, /org/members, /org/invitations, /activity.
 * Mounted at /api.
 */
import { and, asc, count, desc, eq, gt, isNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { activityLog, apiTokens, invitations, memberships, organizations, sessions, users, type Db } from '@tp/db';
import {
  activityQuerySchema, changeRoleInputSchema, inviteInputSchema, updateOrgInputSchema,
  type ActivityItem, type CreatedInvitation, type Member, type MembersResponse, type PendingInvitation,
} from '@tp/core/contracts/auth';
import { ROLE_LABELS } from '@tp/core/contracts/common';
import { logActivity } from '../lib/activity';
import { randomToken, sha256Hex } from '../lib/crypto';
import { HttpError, conflict, forbidden, notFound } from '../lib/errors';
import { parseJson, parseQuery } from '../lib/validate';
import { firstMembership } from '../lib/session';
import { orgId, requireAuth, requireRole, requireSession, userId } from '../middleware/auth';
import type { AppEnv } from '../types';

export const orgRoutes = new Hono<AppEnv>();

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

async function getMember(db: Db, oid: string, uid: string): Promise<Member | null> {
  const [m] = await db.select({
    userId: users.id, name: users.name, email: users.email, phone: users.phone, role: memberships.role, joinedAt: memberships.createdAt,
  }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, oid), eq(memberships.userId, uid)));
  return m ? { ...m, joinedAt: m.joinedAt.toISOString() } : null;
}

async function ownerCount(db: Db, oid: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(memberships).where(and(eq(memberships.orgId, oid), eq(memberships.role, 'owner')));
  return Number(r?.n ?? 0);
}

function memberIdParam(id: string) {
  if (!UUID_RE.test(id)) throw notFound('Member');
  return id;
}

// ───────────── Organization ─────────────

orgRoutes.get('/org', requireAuth, (c) => c.json(c.var.org));

orgRoutes.patch('/org', requireRole('bid_manager'), async (c) => {
  const body = await parseJson(c, updateOrgInputSchema);
  const { db } = c.var.deps;
  const patch: Partial<typeof organizations.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.onboardingState !== undefined) patch.onboardingState = { ...(c.var.org.onboardingState ?? {}), ...body.onboardingState };
  if (body.scoringWeights !== undefined) patch.scoringWeights = body.scoringWeights;
  if (!Object.keys(patch).length) return c.json(c.var.org);
  const [org] = await db.update(organizations).set(patch).where(eq(organizations.id, orgId(c))).returning({
    id: organizations.id, name: organizations.name, slug: organizations.slug, plan: organizations.plan,
    onboardingState: organizations.onboardingState, scoringWeights: organizations.scoringWeights,
  });
  // Onboarding ticks are too chatty for the activity feed; log meaningful changes only.
  if (body.name !== undefined || body.scoringWeights !== undefined) {
    await logActivity(db, {
      orgId: orgId(c), userId: userId(c), action: 'org.updated', entityType: 'organization', entityId: orgId(c),
      meta: { fields: Object.keys(patch).filter((k) => k !== 'onboardingState') },
    });
  }
  return c.json(org);
});

// ───────────── Members ─────────────

orgRoutes.get('/org/members', requireAuth, async (c) => {
  const { db, clock } = c.var.deps;
  const oid = orgId(c);
  const rows = await db.select({
    userId: users.id, name: users.name, email: users.email, phone: users.phone, role: memberships.role, joinedAt: memberships.createdAt,
  }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, oid)).orderBy(asc(memberships.createdAt));
  const inviter = alias(users, 'inviter');
  const inv = await db.select({
    id: invitations.id, email: invitations.email, role: invitations.role, createdAt: invitations.createdAt, expiresAt: invitations.expiresAt,
    inviterId: inviter.id, inviterName: inviter.name,
  }).from(invitations).leftJoin(inviter, eq(inviter.id, invitations.invitedBy))
    .where(and(eq(invitations.orgId, oid), isNull(invitations.acceptedAt), gt(invitations.expiresAt, clock.now())))
    .orderBy(desc(invitations.createdAt));
  const items: Member[] = rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
  const pending: PendingInvitation[] = inv.map((i) => ({
    id: i.id, email: i.email, role: i.role, createdAt: i.createdAt.toISOString(), expiresAt: i.expiresAt.toISOString(),
    invitedBy: i.inviterId ? { id: i.inviterId, name: i.inviterName ?? '' } : null,
  }));
  const out: MembersResponse = { items, total: items.length, invitations: pending };
  return c.json(out);
});

orgRoutes.post('/org/invitations', requireRole('bid_manager'), async (c) => {
  const body = await parseJson(c, inviteInputSchema);
  const { db, clock, config, mailer, logger } = c.var.deps;
  const oid = orgId(c);
  if (body.role === 'owner' && c.var.role !== 'owner') throw forbidden('Only an Owner can invite another Owner');

  const [already] = await db.select({ id: users.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, oid), eq(users.email, body.email)));
  if (already) throw conflict(`${body.email} is already a member of this organization`, { fields: { email: 'Already a member' } });

  // Re-inviting replaces any pending invitation for the same email.
  await db.delete(invitations).where(and(eq(invitations.orgId, oid), eq(invitations.email, body.email), isNull(invitations.acceptedAt)));
  const token = randomToken();
  const expiresAt = new Date(clock.now().getTime() + INVITE_TTL_MS);
  const [row] = await db.insert(invitations).values({
    orgId: oid, email: body.email, role: body.role, tokenHash: await sha256Hex(token), invitedBy: userId(c), expiresAt,
  }).returning({ id: invitations.id });
  const inviteUrl = `${config.appUrl}/invite/${token}`;

  await logActivity(db, { orgId: oid, userId: userId(c), action: 'member.invited', entityType: 'invitation', entityId: row.id, meta: { email: body.email, role: body.role } });

  const org = c.var.org.name, inviter = c.var.user.name, role = ROLE_LABELS[body.role];
  try {
    await mailer.send({
      to: body.email,
      subject: `${inviter} invited you to ${org} on TenderPilot`,
      text: `${inviter} invited you to join ${org} on TenderPilot as ${role}.\n\nAccept the invitation: ${inviteUrl}\n\nThis link expires in 7 days.`,
      html: `<p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(org)}</strong> on TenderPilot as <strong>${role}</strong>.</p>`
        + `<p><a href="${inviteUrl}">Accept the invitation</a></p><p style="color:#666">This link expires in 7 days.</p>`,
    });
  } catch (e) {
    logger.warn('invitation email failed', { error: (e as Error).message });
  }

  const out: CreatedInvitation = { id: row.id, email: body.email, role: body.role, inviteUrl, expiresAt: expiresAt.toISOString() };
  return c.json(out, 201);
});

orgRoutes.delete('/org/invitations/:id', requireRole('bid_manager'), async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) throw notFound('Invitation');
  const { db } = c.var.deps;
  const del = await db.delete(invitations)
    .where(and(eq(invitations.id, id), eq(invitations.orgId, orgId(c)), isNull(invitations.acceptedAt)))
    .returning({ email: invitations.email });
  if (!del.length) throw notFound('Invitation');
  await logActivity(db, { orgId: orgId(c), userId: userId(c), action: 'member.invite_revoked', entityType: 'invitation', entityId: id, meta: { email: del[0].email } });
  return c.json({ ok: true as const });
});

// 002/FR-027: leave the active organization. Registered before `/org/members/:userId` so "me" is never an id.
orgRoutes.delete('/org/members/me', requireSession, async (c) => {
  const { db } = c.var.deps;
  const oid = orgId(c);
  const uid = userId(c);
  if (c.var.role === 'owner' && (await ownerCount(db, oid)) <= 1) {
    throw new HttpError(409, 'last_owner', 'You are the last Owner of this organization. Make someone else an Owner before you leave.');
  }
  await db.transaction(async (tx) => {
    await tx.delete(memberships).where(and(eq(memberships.orgId, oid), eq(memberships.userId, uid)));
    await tx.delete(apiTokens).where(and(eq(apiTokens.orgId, oid), eq(apiTokens.userId, uid)));
  });
  await logActivity(db, { orgId: oid, userId: uid, action: 'member.left', entityType: 'user', entityId: uid, meta: { name: c.var.user.name, email: c.var.user.email, role: c.var.role } });
  const next = await firstMembership(db, uid);
  const nextOrgId = next?.org.id ?? null;
  await db.update(sessions).set({ activeOrgId: nextOrgId }).where(eq(sessions.id, c.var.sessionId!));
  return c.json({ ok: true as const, nextOrgId });
});

orgRoutes.patch('/org/members/:userId', requireRole('owner'), async (c) => {
  const target = memberIdParam(c.req.param('userId'));
  const { role } = await parseJson(c, changeRoleInputSchema);
  const { db } = c.var.deps;
  const oid = orgId(c);
  const m = await getMember(db, oid, target);
  if (!m) throw notFound('Member');
  if (m.role === role) return c.json(m);
  if (m.role === 'owner' && (await ownerCount(db, oid)) <= 1) {
    throw new HttpError(409, 'last_owner', 'An organization needs at least one Owner. Make someone else an Owner first.');
  }
  await db.update(memberships).set({ role }).where(and(eq(memberships.orgId, oid), eq(memberships.userId, target)));
  await logActivity(db, { orgId: oid, userId: userId(c), action: 'member.role_changed', entityType: 'user', entityId: target, meta: { from: m.role, to: role, name: m.name } });
  return c.json({ ...m, role });
});

orgRoutes.delete('/org/members/:userId', requireRole('owner'), async (c) => {
  const target = memberIdParam(c.req.param('userId'));
  const { db } = c.var.deps;
  const oid = orgId(c);
  const m = await getMember(db, oid, target);
  if (!m) throw notFound('Member');
  if (m.role === 'owner' && (await ownerCount(db, oid)) <= 1) {
    throw new HttpError(409, 'last_owner', 'You cannot remove the last Owner of the organization.');
  }
  await db.transaction(async (tx) => {
    await tx.delete(memberships).where(and(eq(memberships.orgId, oid), eq(memberships.userId, target)));
    await tx.delete(apiTokens).where(and(eq(apiTokens.orgId, oid), eq(apiTokens.userId, target)));
  });
  await logActivity(db, { orgId: oid, userId: userId(c), action: 'member.removed', entityType: 'user', entityId: target, meta: { name: m.name, email: m.email, role: m.role } });
  return c.json({ ok: true as const });
});

// ───────────── Activity ─────────────

orgRoutes.get('/activity', requireAuth, async (c) => {
  const q = parseQuery(c, activityQuerySchema);
  const { db } = c.var.deps;
  const conds: SQL[] = [eq(activityLog.orgId, orgId(c))];
  if (q.entityType) conds.push(eq(activityLog.entityType, q.entityType));
  if (q.entityId) conds.push(eq(activityLog.entityId, q.entityId));
  if (q.userId) conds.push(eq(activityLog.userId, q.userId));
  const where = and(...conds);
  const [rows, [{ n }]] = await Promise.all([
    db.select({
      id: activityLog.id, action: activityLog.action, entityType: activityLog.entityType, entityId: activityLog.entityId,
      meta: activityLog.meta, createdAt: activityLog.createdAt, userId: users.id, userName: users.name,
    }).from(activityLog).leftJoin(users, eq(users.id, activityLog.userId))
      .where(where).orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(activityLog).where(where),
  ]);
  const items: ActivityItem[] = rows.map((r) => ({
    id: r.id, action: r.action, entityType: r.entityType, entityId: r.entityId, meta: r.meta ?? {},
    createdAt: r.createdAt.toISOString(), user: r.userId ? { id: r.userId, name: r.userName ?? '' } : null,
  }));
  return c.json({ items, total: Number(n) });
});
