/** Inject deps, assign a request id (x-request-id), and log one line per request. */
import { createMiddleware } from 'hono/factory';
import type { AppDeps } from '../deps';
import type { AppEnv } from '../types';

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
