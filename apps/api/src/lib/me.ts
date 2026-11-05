import { asc, eq } from 'drizzle-orm';
import { memberships, organizations, type Db, type Role } from '@tp/db';
import type { Me } from '@tp/core/contracts/auth';
import type { AuthOrg, AuthUser } from '../types';

/** Build the `Me` payload for a user in their active org. */
export async function buildMe(db: Db, user: AuthUser, org: AuthOrg, role: Role): Promise<Me> {
  const orgs = await db.select({ id: organizations.id, name: organizations.name, slug: organizations.slug, role: memberships.role })
    .from(memberships).innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, user.id)).orderBy(asc(organizations.name));
  return {
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone ?? null },
    org: {
      id: org.id, name: org.name, slug: org.slug, plan: org.plan,
      onboardingState: org.onboardingState ?? {}, scoringWeights: org.scoringWeights ?? null,
    },
    role,
    orgs,
  };
}
