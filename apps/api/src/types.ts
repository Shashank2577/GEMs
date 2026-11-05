/** Hono environment shared by every router: `new Hono<AppEnv>()`. */
import type { Role } from '@tp/db';
import type { AppDeps } from './deps';
import type { ResolvedAuth } from './lib/session';

export interface AuthUser { id: string; name: string; email: string; phone: string | null }
export interface AuthOrg {
  id: string; name: string; slug: string; plan: string;
  onboardingState: Record<string, boolean>;
  scoringWeights: Record<string, number> | null;
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
  /**
   * Credentials resolved once by the global rate limiter (middleware/rate-limit.ts#ipLimit) so requireAuth does not
   * resolve them again. Unset when the request carried no credentials.
   */
  preAuth?: { auth: ResolvedAuth | null };
  /** True once `api.ip` was counted for this request (middleware/rate-limit.ts). */
  ipCounted?: boolean;
}

export type AppEnv = { Variables: AppVariables };
