/** Inject deps, assign a request id (x-request-id), and log one line per request. */
import { createMiddleware } from 'hono/factory';
import type { AppDeps } from '../deps';
import type { AppEnv } from '../types';

/**
 * Path for logs with secrets removed (002/NFR-003): the invitation token in `GET /api/auth/invite/:token` is a bearer
 * credential and must never reach the logs. Query strings are never logged.
 */
export function redactPath(path: string): string {
  return path.replace(/(\/auth\/invite\/)[^/]+/i, '$1:token');
}

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
      // 008/FR-045: after auth resolved (c.var.user/org are set by requireAuth); no query string, no headers, no body.
      const path = redactPath(new URL(c.req.url).pathname);
      const meta = {
        rid: requestId, method: c.req.method, path, status: c.res.status, ms: Date.now() - t0,
        orgId: c.var.org?.id ?? null, userId: c.var.user?.id ?? null,
      };
      // Uptime-monitor polls (every 5 min per monitor) would drown real traffic: debug only.
      if (/^\/api\/health\/?$/.test(path)) deps.logger.debug?.('request', meta);
      else deps.logger.info('request', meta);
    }
  });

/** Never cache API responses in shared caches. */
export const noStore = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
});
