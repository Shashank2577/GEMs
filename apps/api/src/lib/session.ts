/** Session & API-token lookup and cookie handling. */
import { and, asc, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { apiTokens, memberships, organizations, sessions, users, type Db, type Role } from '@tp/db';
import { API_TOKEN_PREFIX } from '@tp/core/contracts/auth';
import type { AppEnv, AuthOrg, AuthUser } from '../types';
import { randomToken, sha256Hex } from './crypto';

export const SESSION_COOKIE = 'tp_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Re-extend a session when less than this much lifetime remains (sliding expiry). */
const SESSION_REFRESH_MS = 15 * 24 * 60 * 60 * 1000;
/** `sessions.last_seen_at` is refreshed at most this often (002/FR-012). */
export const SESSION_SEEN_INTERVAL_MS = 5 * 60 * 1000;
const USER_AGENT_MAX = 512;

export interface ResolvedAuth {
  user: AuthUser;
  org: AuthOrg | null;
  role: Role | null;
  kind: 'session' | 'token';
  sessionId: string | null;
  apiTokenId: string | null;
}

function isHttps(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  return new URL(c.req.url).protocol === 'https:';
}

export function setSessionCookie(c: Context, token: string, expires: Date) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'Lax', secure: isHttps(c), path: '/', expires,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isHttps(c) });
}

/** Create a session row and set the cookie. */
export async function startSession(c: Context<AppEnv>, userId: string, activeOrgId: string | null) {
  const { db, clock } = c.var.deps;
  const token = randomToken();
  const expiresAt = new Date(clock.now().getTime() + SESSION_TTL_MS);
  const userAgent = c.req.header('user-agent')?.slice(0, USER_AGENT_MAX) || null;
  const [row] = await db.insert(sessions).values({
    userId, tokenHash: await sha256Hex(token), activeOrgId, expiresAt, userAgent, lastSeenAt: clock.now(),
  }).returning({ id: sessions.id });
  if (activeOrgId) await rememberOrg(db, userId, activeOrgId);
  setSessionCookie(c, token, expiresAt);
  return { sessionId: row.id, token, expiresAt };
}

/** Remember the org the user last worked in, so a later sign-in resumes there (002/FR-021). */
export async function rememberOrg(db: Db, userId: string, orgId: string) {
  await db.update(users).set({ lastOrgId: orgId }).where(eq(users.id, userId));
}

export async function loadUser(db: Db, userId: string): Promise<AuthUser | null> {
  const [u] = await db.select({ id: users.id, name: users.name, email: users.email, phone: users.phone }).from(users).where(eq(users.id, userId));
  return u ?? null;
}

const orgCols = {
  id: organizations.id, name: organizations.name, slug: organizations.slug, plan: organizations.plan,
  onboardingState: organizations.onboardingState, scoringWeights: organizations.scoringWeights,
  trialEndsAt: organizations.trialEndsAt,
};

/** Membership + org for (user, org); null when not a member. */
export async function loadMembership(db: Db, userId: string, orgId: string): Promise<{ org: AuthOrg; role: Role } | null> {
  const [r] = await db.select({ ...orgCols, role: memberships.role })
    .from(memberships).innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)));
  if (!r) return null;
  const { role, ...org } = r;
  return { org: org as AuthOrg, role };
}

/** The user's oldest membership (fallback active org). */
export async function firstMembership(db: Db, userId: string): Promise<{ org: AuthOrg; role: Role } | null> {
  const [r] = await db.select({ ...orgCols, role: memberships.role })
    .from(memberships).innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, userId)).orderBy(asc(memberships.createdAt)).limit(1);
  if (!r) return null;
  const { role, ...org } = r;
  return { org: org as AuthOrg, role };
}

function bearerToken(c: Context): string | null {
  const h = c.req.header('authorization');
  if (!h) return null;
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m && m[1].startsWith(API_TOKEN_PREFIX) ? m[1] : null;
}

/**
 * Resolve the caller from the session cookie or a `Bearer tp_…` API token.
 * Returns null when unauthenticated. Org/role are null when the user has no membership left.
 */
export async function resolveAuth(c: Context<AppEnv>): Promise<ResolvedAuth | null> {
  const { db, clock } = c.var.deps;
  const now = clock.now();

  const bearer = bearerToken(c);
  if (bearer) {
    const [t] = await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, await sha256Hex(bearer)));
    if (!t) return null;
    const user = await loadUser(db, t.userId);
    if (!user) return null;
    const m = await loadMembership(db, t.userId, t.orgId);
    if (!m) return null; // token's org membership was revoked
    if (!t.lastUsedAt || now.getTime() - t.lastUsedAt.getTime() > 60_000) {
      await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, t.id));
    }
    return { user, org: m.org, role: m.role, kind: 'token', sessionId: null, apiTokenId: t.id };
  }

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const [s] = await db.select().from(sessions)
    .where(and(eq(sessions.tokenHash, await sha256Hex(token)), gt(sessions.expiresAt, now)));
  if (!s) return null;
  const user = await loadUser(db, s.userId);
  if (!user) return null;

  let m = s.activeOrgId ? await loadMembership(db, s.userId, s.activeOrgId) : null;
  const patch: Partial<typeof sessions.$inferInsert> = {};
  if (!m) {
    m = await firstMembership(db, s.userId);
    if ((m?.org.id ?? null) !== s.activeOrgId) patch.activeOrgId = m?.org.id ?? null;
  }
  if (s.expiresAt.getTime() - now.getTime() < SESSION_REFRESH_MS) {
    patch.expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    setSessionCookie(c, token, patch.expiresAt);
  }
  if (!s.lastSeenAt || now.getTime() - s.lastSeenAt.getTime() >= SESSION_SEEN_INTERVAL_MS) patch.lastSeenAt = now;
  if (Object.keys(patch).length) await db.update(sessions).set(patch).where(eq(sessions.id, s.id));

  return { user, org: m?.org ?? null, role: m?.role ?? null, kind: 'session', sessionId: s.id, apiTokenId: null };
}
