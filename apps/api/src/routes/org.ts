/**
 * Organization routes (FR-031..033): /org, /org/members, /org/invitations (+ resend, 002/FR-020), /activity.
 * Mounted at /api.
 */
import { and, asc, count, desc, eq, gt, isNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Hono, type Context } from 'hono';
import { activityLog, apiTokens, invitations, memberships, organizations, savedViews, sessions, users, type Db, type Role } from '@tp/db';
import {
  activityQuerySchema, changeRoleInputSchema, inviteInputSchema, updateOrgInputSchema,
  type ActivityItem, type CreatedInvitation, type Member, type MembersResponse, type PendingInvitation,
} from '@tp/core/contracts/auth';
import { ROLE_LABELS } from '@tp/core/contracts/common';
import { logActivity } from '../lib/activity';
import { randomToken, sha256Hex } from '../lib/crypto';
import { HttpError, conflict, forbidden, notFound } from '../lib/errors';
import { parseJson, parseQuery } from '../lib/validate';
import { orgId, requireAuth, requireRole, requireSession, userId } from '../middleware/auth';
import type { AppEnv } from '../types';

export const orgRoutes = new Hono<AppEnv>();

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Email an invitation link (002/FR-015). A mail failure is logged, never fails the request; the link is not logged. */
async function sendInviteEmail(c: Context<AppEnv>, to: string, roleName: Role, inviteUrl: string) {
  const org = c.var.org.name, inviter = c.var.user.name, role = ROLE_LABELS[roleName];
  try {
    await c.var.deps.mailer.send({
      to,
      subject: `${inviter} invited you to ${org} on TenderPilot`,
      text: `${inviter} invited you to join ${org} on TenderPilot as ${role}.\n\nAccept the invitation: ${inviteUrl}\n\nThis link expires in 7 days.`,
      html: `<p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(org)}</strong> on TenderPilot as <strong>${role}</strong>.</p>`
        + `<p><a href="${inviteUrl}">Accept the invitation</a></p><p style="color:#666">This link expires in 7 days.</p>`,
    });
  } catch (e) {
    c.var.deps.logger.warn('invitation email failed', { error: (e as Error).message });
  }
}

async function getMember(db: Db, oid: string, uid: string): Promise<Member | null> {
  const [m] = await db.select({
    userId: users.id, name: users.name, email: users.email, phone: users.phone, role: memberships.role, joinedAt: memberships.createdAt,
  }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, oid), eq(memberships.userId, uid)));
  return m ? { ...m, joinedAt: m.joinedAt.toISOString() } : null;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const LAST_OWNER = {
  demote: 'An organization needs at least one Owner. Make someone else an Owner first.',
  remove: 'You cannot remove the last Owner of the organization.',
  leave: 'You are the last Owner of this organization. Make someone else an Owner before you leave.',
} as const;

/**
 * FR-024 under concurrency: lock the organization row (FOR UPDATE) so membership changes in one org run one at a
 * time, then re-read the owners and refuse (409 `last_owner`) when `uid` is the only one. Call inside the transaction
 * that makes the change; two owners leaving / demoting each other at once can no longer leave the org ownerless.
 */
async function assertNotLastOwner(tx: Tx, oid: string, uid: string, why: keyof typeof LAST_OWNER): Promise<void> {
  await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, oid)).for('update');
  const owners = await tx.select({ userId: memberships.userId }).from(memberships)
    .where(and(eq(memberships.orgId, oid), eq(memberships.role, 'owner')));
  if (owners.length <= 1 && owners.some((o) => o.userId === uid)) throw new HttpError(409, 'last_owner', LAST_OWNER[why]);
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
  const { db, clock, config } = c.var.deps;
  const oid = orgId(c);
  if (body.role === 'owner' && c.var.role !== 'owner') throw forbidden('Only an Owner can invite another Owner');

  const [already] = await db.select({ id: users.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, oid), eq(users.email, body.email)));
  if (already) {
    const msg = `${body.email} is already a member of this organization`;
    throw conflict(msg, { fields: { email: msg } });
  }

  // Re-inviting replaces any pending invitation for the same email.
  await db.delete(invitations).where(and(eq(invitations.orgId, oid), eq(invitations.email, body.email), isNull(invitations.acceptedAt)));
  const token = randomToken();
  const expiresAt = new Date(clock.now().getTime() + INVITE_TTL_MS);
  const [row] = await db.insert(invitations).values({
    orgId: oid, email: body.email, role: body.role, tokenHash: await sha256Hex(token), invitedBy: userId(c), expiresAt,
  }).returning({ id: invitations.id });
  const inviteUrl = `${config.appUrl}/invite/${token}`;

  await logActivity(db, { orgId: oid, userId: userId(c), action: 'member.invited', entityType: 'invitation', entityId: row.id, meta: { email: body.email, role: body.role } });

  await sendInviteEmail(c, body.email, body.role, inviteUrl);

  const out: CreatedInvitation = { id: row.id, email: body.email, role: body.role, inviteUrl, expiresAt: expiresAt.toISOString() };
  return c.json(out, 201);
});

/**
 * Resend a pending invitation (002/FR-020): a fresh token (the old link stops working) and a new 7-day expiry,
 * emailed again. Also revives an expired, unaccepted invitation. 404 for other orgs' or accepted invitations.
 */
orgRoutes.post('/org/invitations/:id/resend', requireRole('bid_manager'), async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) throw notFound('Invitation');
  const { db, clock, config } = c.var.deps;
  const oid = orgId(c);
  const pending = and(eq(invitations.id, id), eq(invitations.orgId, oid), isNull(invitations.acceptedAt));
  const [found] = await db.select({ role: invitations.role }).from(invitations).where(pending);
  if (!found) throw notFound('Invitation');
  if (found.role === 'owner' && c.var.role !== 'owner') throw forbidden('Only an Owner can invite another Owner');

  const token = randomToken();
  const expiresAt = new Date(clock.now().getTime() + INVITE_TTL_MS);
  const [row] = await db.update(invitations).set({ tokenHash: await sha256Hex(token), expiresAt, invitedBy: userId(c) })
    .where(pending).returning({ id: invitations.id, email: invitations.email, role: invitations.role });
  if (!row) throw notFound('Invitation');
  const inviteUrl = `${config.appUrl}/invite/${token}`;

  await logActivity(db, { orgId: oid, userId: userId(c), action: 'member.invite_resent', entityType: 'invitation', entityId: row.id, meta: { email: row.email, role: row.role } });
  await sendInviteEmail(c, row.email, row.role, inviteUrl);

  const out: CreatedInvitation = { id: row.id, email: row.email, role: row.role, inviteUrl, expiresAt: expiresAt.toISOString() };
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
  const nextOrgId = await db.transaction(async (tx) => {
    await assertNotLastOwner(tx, oid, uid, 'leave');
    await tx.delete(memberships).where(and(eq(memberships.orgId, oid), eq(memberships.userId, uid)));
    await tx.delete(apiTokens).where(and(eq(apiTokens.orgId, oid), eq(apiTokens.userId, uid)));
    await tx.delete(savedViews).where(and(eq(savedViews.orgId, oid), eq(savedViews.userId, uid)));
    await logActivity(tx, { orgId: oid, userId: uid, action: 'member.left', entityType: 'user', entityId: uid, meta: { name: c.var.user.name, email: c.var.user.email, role: c.var.role } });
    const [next] = await tx.select({ orgId: memberships.orgId }).from(memberships)
      .where(eq(memberships.userId, uid)).orderBy(asc(memberships.createdAt)).limit(1);
    const nextId = next?.orgId ?? null;
    await tx.update(sessions).set({ activeOrgId: nextId }).where(eq(sessions.id, c.var.sessionId!));
    // Sign-in resumes in the org the user is moved to, never the one they left (002/FR-021).
    await tx.update(users).set({ lastOrgId: nextId }).where(eq(users.id, uid));
    return nextId;
  });
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
  await db.transaction(async (tx) => {
    if (role !== 'owner') await assertNotLastOwner(tx, oid, target, 'demote');
    await tx.update(memberships).set({ role }).where(and(eq(memberships.orgId, oid), eq(memberships.userId, target)));
  });
  await logActivity(db, { orgId: oid, userId: userId(c), action: 'member.role_changed', entityType: 'user', entityId: target, meta: { from: m.role, to: role, name: m.name } });
  return c.json({ ...m, role });
});

orgRoutes.delete('/org/members/:userId', requireRole('owner'), async (c) => {
  const target = memberIdParam(c.req.param('userId'));
  const { db } = c.var.deps;
  const oid = orgId(c);
  const m = await getMember(db, oid, target);
  if (!m) throw notFound('Member');
  await db.transaction(async (tx) => {
    await assertNotLastOwner(tx, oid, target, 'remove');
    await tx.delete(memberships).where(and(eq(memberships.orgId, oid), eq(memberships.userId, target)));
    await tx.delete(apiTokens).where(and(eq(apiTokens.orgId, oid), eq(apiTokens.userId, target)));
    await tx.delete(savedViews).where(and(eq(savedViews.orgId, oid), eq(savedViews.userId, target)));
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
