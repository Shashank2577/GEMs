/**
 * CSRF defence in depth (002/FR-028), on top of the SameSite=Lax session cookie.
 *
 * A cookie-authenticated request that can change state (anything but GET/HEAD) is rejected with 403 `bad_origin`
 * before any handler runs when
 *   - it carries an `Origin` header that is not the web app's origin (`APP_URL`), or
 *   - it has no `Origin` but the browser marks it `Sec-Fetch-Site: cross-site`.
 * Requests with neither header (curl, server-to-server) and `Authorization: Bearer tp_…` API-token requests (the
 * browser extension) are not affected: a cross-site page cannot attach a bearer token without a CORS preflight,
 * which the API never grants. OPTIONS is not exempt either; preflights carry no cookie, so they pass anyway.
 *
 * Local development: when APP_URL itself is a loopback URL (http://localhost:8787 by default), any loopback origin
 * is accepted, so the Vite dev server (:5173, proxying /api to :8787) keeps working. A deployed APP_URL is never
 * loopback, so production stays strict. APP_URL must therefore match the origin the app is served from.
 */
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { API_TOKEN_PREFIX } from '@tp/core/contracts/auth';
import { HttpError } from '../lib/errors';
import { SESSION_COOKIE } from '../lib/session';
import type { AppEnv } from '../types';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export const BAD_ORIGIN_MESSAGE = 'This request came from another website and was blocked. Reload TenderPilot and try again.';

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export const originCheck = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  // Same test as resolveAuth: a `Bearer tp_…` header wins over the cookie, so the cookie is not what authenticates.
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer?.startsWith(API_TOKEN_PREFIX)) return next();
  if (!getCookie(c, SESSION_COOKIE)) return next();
  const origin = c.req.header('origin');
  if (!origin) {
    if (c.req.header('sec-fetch-site')?.toLowerCase() === 'cross-site') throw new HttpError(403, 'bad_origin', BAD_ORIGIN_MESSAGE);
    return next();
  }
  const appOrigin = originOf(c.var.deps.config.appUrl);
  if (origin === appOrigin) return next();
  if (appOrigin && LOOPBACK.test(appOrigin) && LOOPBACK.test(origin)) return next();
  throw new HttpError(403, 'bad_origin', BAD_ORIGIN_MESSAGE);
});
