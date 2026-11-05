/**
 * Every request rate limit of the API in one table (008/FR-019). Tune numbers here only.
 *
 * Two mechanisms enforce them:
 * - `engine: 'generic'` — `middleware/rate-limit.ts#rateLimit(rule)` → `AppDeps.rateLimiter` (`rate_limits` table,
 *   aligned fixed windows, every request counts).
 * - `engine: 'auth-attempts'` — spec 002's credential limiter (`lib/rate-limit.ts`, `auth_attempts` table): attempts
 *   are reserved before PBKDF2 and a success clears the email counter, so only failures stick. The numbers come
 *   from that module so they are defined once.
 *
 * When several counters of one request are over, the 429 names the binding one (longest Retry-After).
 * `failClosed`: when the counter cannot be written, auth rules refuse with 503 instead of allowing (FR-020).
 */
import { LOGIN_EMAIL_LIMIT, LOGIN_IP_LIMIT, RESET_EMAIL_LIMIT, RESET_IP_LIMIT } from './rate-limit';

/** What the counter is keyed by. `user_or_token`: the API token when the request uses one, else the user. */
export type RateLimitSubject = 'email' | 'ip' | 'user' | 'org' | 'user_or_token';

export interface RateLimitRule {
  limit: number;
  windowSec: number;
  subject: RateLimitSubject;
  engine: 'generic' | 'auth-attempts';
  failClosed: boolean;
  /** Where it applies (documentation; the wiring is in the routes). */
  routes: string;
}

const MIN = 60;
const HOUR = 60 * MIN;
const sec = (ms: number) => Math.round(ms / 1000);

export const RATE_LIMIT_RULES = {
  'auth.fail.email': {
    limit: LOGIN_EMAIL_LIMIT.limit, windowSec: sec(LOGIN_EMAIL_LIMIT.windowMs), subject: 'email', engine: 'auth-attempts', failClosed: true,
    routes: 'POST /auth/login, POST /auth/accept-invite (existing user), POST /me/password',
  },
  'auth.fail.ip': {
    limit: LOGIN_IP_LIMIT.limit, windowSec: sec(LOGIN_IP_LIMIT.windowMs), subject: 'ip', engine: 'auth-attempts', failClosed: true,
    routes: 'POST /auth/login, POST /auth/accept-invite (existing user), POST /me/password, POST /auth/reset-password',
  },
  'auth.signup.ip': { limit: 20, windowSec: HOUR, subject: 'ip', engine: 'generic', failClosed: true, routes: 'POST /auth/signup' },
  'auth.reset.email': {
    limit: RESET_EMAIL_LIMIT.limit, windowSec: sec(RESET_EMAIL_LIMIT.windowMs), subject: 'email', engine: 'auth-attempts', failClosed: true,
    routes: 'POST /auth/forgot-password',
  },
  'auth.reset.ip': {
    limit: RESET_IP_LIMIT.limit, windowSec: sec(RESET_IP_LIMIT.windowMs), subject: 'ip', engine: 'auth-attempts', failClosed: true,
    routes: 'POST /auth/forgot-password',
  },
  'watchlist.preview.user': { limit: 30, windowSec: MIN, subject: 'user', engine: 'generic', failClosed: false, routes: 'POST /watchlists/preview' },
  'upload.org': {
    limit: 120, windowSec: HOUR, subject: 'org', engine: 'generic', failClosed: false,
    routes: 'POST /vault, PUT /vault/:id/file, POST /tenders/:id/documents',
  },
  'gem.fetch.org': { limit: 30, windowSec: HOUR, subject: 'org', engine: 'generic', failClosed: false, routes: 'POST /tenders/:id/fetch-documents' },
  'ocr.org': { limit: 20, windowSec: HOUR, subject: 'org', engine: 'generic', failClosed: false, routes: 'POST /tenders/:id/documents/:docId/ocr' },
  'analyse.user': { limit: 30, windowSec: HOUR, subject: 'user', engine: 'generic', failClosed: false, routes: 'POST /tenders/:id/analyse' },
  'packet.org': { limit: 30, windowSec: HOUR, subject: 'org', engine: 'generic', failClosed: false, routes: 'POST /workspaces/:id/packets' },
  'api.user': { limit: 600, windowSec: MIN, subject: 'user_or_token', engine: 'generic', failClosed: false, routes: 'every authenticated /api/*' },
  'api.ip': { limit: 300, windowSec: MIN, subject: 'ip', engine: 'generic', failClosed: false, routes: 'every unauthenticated /api/* except /api/health' },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitRuleName = keyof typeof RATE_LIMIT_RULES;

/** Rules enforced by the generic middleware. */
export type GenericRuleName = { [K in RateLimitRuleName]: (typeof RATE_LIMIT_RULES)[K]['engine'] extends 'generic' ? K : never }[RateLimitRuleName];

export const rateLimitRule = (name: RateLimitRuleName): RateLimitRule => RATE_LIMIT_RULES[name];
