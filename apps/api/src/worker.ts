/**
 * Cloudflare Worker entry (Constitution VII): /api/* → Hono app with a per-request Neon pool and
 * R2 blob store; everything else → static SPA assets. Cron → ingestion → alerts → reminders.
 */
import * as Sentry from '@sentry/cloudflare';
import { createNeonDb } from '@tp/db';
import { spaCspFor } from '@tp/core/security/headers';
import { createApp } from './app';
import { createDeps } from './adapters/index';
import { createSentryReporter, sentryOptions } from './adapters/errors';
import { createJsonLogger } from './adapters/logger';
import { unreachableHealth } from './routes/health';
import { createR2BlobStore, type R2BucketLike } from './adapters/blob-r2';
import { loadConfig, type RuntimeEnv } from './env';
import { runScheduledJobs } from './lib/scheduled';
import { settleDeferred } from './lib/defer';
import { applySecurityHeaders } from './middleware/security';

export interface WorkerEnv extends RuntimeEnv {
  DATABASE_URL: string;
  BLOBS: R2BucketLike;
  ASSETS: { fetch(req: Request): Promise<Response> };
}

interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException?(): void;
}

function envVars(env: WorkerEnv): RuntimeEnv {
  // On Workers, cf-connecting-ip is set by Cloudflare and cannot be forged by the client.
  return { NODE_ENV: 'production', TRUST_PROXY: 'cloudflare', ...env };
}

async function withDeps<T>(env: WorkerEnv, ctx: ExecutionContextLike, fn: (deps: ReturnType<typeof createDeps>) => Promise<T>): Promise<T> {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL secret is not set');
  const { db, close } = await createNeonDb(env.DATABASE_URL);
  const vars = envVars(env);
  // 008/FR-046: events are only sent when SENTRY_DSN is set (withSentry below is inert without a DSN).
  const errors = vars.SENTRY_DSN ? createSentryReporter(Sentry) : undefined;
  const deps = createDeps({ env: vars, db, blobs: createR2BlobStore(env.BLOBS), errors });
  try {
    return await fn(deps);
  } finally {
    // Background work (lib/defer.ts) still needs the pool: close only after it settles.
    ctx.waitUntil(settleDeferred(deps).then(() => close()).catch(() => {}));
  }
}

/**
 * 002/FR-050 for static responses that pass through the Worker. Assets served directly by Cloudflare (the usual path,
 * `run_worker_first` is only /api/*) get the same headers from `apps/web/dist/_headers`, generated at build time.
 * The CSP hash is computed from the HTML being served, so it always matches the inline theme script.
 */
export async function withSecurityHeaders(request: Request, res: Response): Promise<Response> {
  const https = new URL(request.url).protocol === 'https:';
  const nullBody = res.status === 204 || res.status === 304;
  if (!nullBody && request.method !== 'HEAD' && (res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) {
    const html = await res.text();
    const out = new Response(html, res);
    applySecurityHeaders(out.headers, { https, csp: await spaCspFor(html) });
    return out;
  }
  const out = new Response(nullBody ? null : res.body, res);
  applySecurityHeaders(out.headers, { https });
  return out;
}

/**
 * The per-request bootstrap (DB pool, deps) failed before the Hono app could run: JSON log line, Sentry event when a DSN
 * is set (withSentry has initialised the client), and for /api/health the same `db_unreachable` body the route returns.
 */
export function bootstrapFailed(e: unknown, url: URL, env: WorkerEnv): Response {
  const config = loadConfig(envVars(env));
  createJsonLogger({ level: config.logLevel }).error('worker bootstrap failed', { path: url.pathname, error: (e as Error)?.message });
  if (env.SENTRY_DSN) {
    try { Sentry.captureException(e, { tags: { route: url.pathname === '/api/health' ? '/api/health' : 'bootstrap' } }); } catch { /* never mask the 503 */ }
  }
  const headers = { 'cache-control': 'no-store' };
  if (/^\/api\/health\/?$/.test(url.pathname)) return Response.json(unreachableHealth(config.version), { status: 503, headers });
  return Response.json({ error: { code: 'service_unavailable', message: 'Service temporarily unavailable' } }, { status: 503, headers });
}

const handler = {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await withDeps(env, ctx, async (deps) => createApp(deps).fetch(request, env, ctx as never));
      } catch (e) {
        return bootstrapFailed(e, url, env);
      }
    }
    return withSecurityHeaders(request, await env.ASSETS.fetch(request));
  },

  async scheduled(_event: { cron?: string; scheduledTime?: number }, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(withDeps(env, ctx, (deps) => runScheduledJobs(deps, { trigger: 'cron' })).then(() => undefined));
  },
};

export default Sentry.withSentry(
  (env: WorkerEnv) => sentryOptions(loadConfig(envVars(env)), env.SENTRY_ENVIRONMENT),
  handler as unknown as ExportedHandler<WorkerEnv>,
) as unknown as typeof handler;
