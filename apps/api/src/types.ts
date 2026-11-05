/** Hono environment shared by every router: `new Hono<AppEnv>()`. */
import type { Role } from '@tp/db';
import type { AppDeps } from './deps';

export interface AuthUser { id: string; name: string; email: string; phone: string | null }
export interface AuthOrg {
  id: string; name: string; slug: string; plan: string;
  onboardingState: Record<string, boolean>;
  scoringWeights: Record<string, number> | null;
  /** End of the free trial (008/FR-035); null for paid plans. Read fresh on every request (FR-043). */
  trialEndsAt: Date | null;
}

export interface AppVariables {
  deps: AppDeps;
  requestId: string;
  /** Set by requireAuth / requireRole. */
  user: AuthUser;
  org: AuthOrg;
  role: Role;
  /** How the request authenticated. */
  authKind: 'session' | 'token';
  /** sessions.id when authenticated by cookie, else null. */
  sessionId: string | null;
  /** api_tokens.id when authenticated by Bearer token, else null. */
  apiTokenId: string | null;
}

export type AppEnv = { Variables: AppVariables };
