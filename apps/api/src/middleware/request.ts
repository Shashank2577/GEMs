/** Inject deps, assign a request id (x-request-id), and log one line per request. */
import { createMiddleware } from 'hono/factory';
import type { AppDeps } from '../deps';
import type { AppEnv } from '../types';
import { FILE_FRAME_CSP, HSTS, SECURITY_HEADERS, isHttpsRequest } from '../lib/security-headers';

export const injectDeps = (deps: AppDeps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    c.set('deps', deps);
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && /^[\w.-]{1,100}$/.test(incoming) ? incoming : crypto.randomUUID();
    c.set('requestId', requestId);
    const t0 = Date.now();
    await next();
    c.header('x-request-id', requestId);
    if (deps.config.logRequests) {
      const ms = Date.now() - t0;
      deps.logger.info(`${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${ms}ms`, { rid: requestId });
    }
  });

/** Never cache API responses in shared caches. */
export const noStore = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
});

/**
 * Security headers on every API response (spec 008 FR-013): nosniff, referrer and permissions policy, HSTS on HTTPS.
 * File streams (PDF preview/download — any response with `content-disposition`) may only be framed same-origin.
 */
export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
  const trustProxy = (c.var.deps?.config.trustProxy ?? 'none') !== 'none';
  if (isHttpsRequest(c.req.url, c.req.header('x-forwarded-proto'), trustProxy)) c.header('strict-transport-security', HSTS);
  if (c.res.headers.has('content-disposition') && !c.res.headers.has('content-security-policy')) {
    c.header('content-security-policy', FILE_FRAME_CSP);
  }
});
