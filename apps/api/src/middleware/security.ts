/**
 * Security headers (002/FR-050) — see `securityHeaders` below — and
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
 * One route is exempt: `POST /api/notifications/unsubscribe` (003/FR-048). It is authenticated by the signed `?token=`
 * alone and never reads the session cookie, so — like a Bearer request — a forged cross-site POST gains nothing a
 * holder of the token could not already do. Its own confirmation page posts with `Origin: null` (the page is served
 * with `Referrer-Policy: no-referrer`), which would otherwise be refused for a signed-in browser. Exact path, POST only.
 *
 * Local development: when APP_URL itself is a loopback URL (http://localhost:8787 by default), any loopback origin
 * is accepted, so the Vite dev server (:5173, proxying /api to :8787) keeps working. A deployed APP_URL is never
 * loopback, so production stays strict. APP_URL must therefore match the origin the app is served from.
 */
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { API_TOKEN_PREFIX } from '@tp/core/contracts/auth';
import { BASE_SECURITY_HEADERS, HSTS_VALUE } from '@tp/core/security/headers';
import { HttpError } from '../lib/errors';
import { SESSION_COOKIE, isHttps } from '../lib/session';
import type { AppEnv } from '../types';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
/** Token-authenticated (never cookie-authenticated) mutation exempt from the check; see the header comment. */
const TOKEN_ONLY_POST = '/api/notifications/unsubscribe';
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
  if (c.req.method === 'POST' && c.req.path === TOKEN_ONLY_POST) return next();
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

// ───────────── Security headers (002/FR-050) ─────────────

export interface SecurityHeaderOptions {
  /** Content-Security-Policy for HTML responses (the SPA document); omitted for API responses. */
  csp?: string;
  /** Whether the response was served over https (adds HSTS). */
  https: boolean;
}

/**
 * Add the FR-050 headers to `headers` (mutates). A response the SPA itself shows in an `<iframe>` (an inline file
 * preview: `content-disposition: inline`, e.g. `/api/vault/:id/download?inline=1`) may be framed by the same origin
 * only (`SAMEORIGIN`); everything else is `DENY`. The CSP is only added to `text/html` responses.
 */
export function applySecurityHeaders(headers: Headers, opts: SecurityHeaderOptions): void {
  for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) headers.set(k, v);
  if (/^\s*inline\b/i.test(headers.get('content-disposition') ?? '')) headers.set('X-Frame-Options', 'SAMEORIGIN');
  if (opts.https) headers.set('Strict-Transport-Security', HSTS_VALUE);
  if (opts.csp && (headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) {
    headers.set('Content-Security-Policy', opts.csp);
  }
}

/**
 * Run after every handler (incl. errors and 404s) and set the FR-050 headers. The SPA server passes `csp` (a value, or
 * a function evaluated only for HTML responses so it can follow a rebuilt index.html).
 */
export const securityHeaders = (opts: { csp?: string | (() => Promise<string | undefined>) } = {}) => createMiddleware(async (c, next) => {
  await next();
  const isHtml = (c.res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html');
  const csp = isHtml ? (typeof opts.csp === 'function' ? await opts.csp() : opts.csp) : undefined;
  const o = { csp, https: isHttps(c) };
  try {
    applySecurityHeaders(c.res.headers, o);
  } catch {
    // Immutable headers (a Response passed through from fetch): copy it first.
    c.res = new Response(c.res.body, c.res);
    applySecurityHeaders(c.res.headers, o);
  }
});
