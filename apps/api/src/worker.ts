/**
 * Cloudflare Worker entry (Constitution VII): /api/* → Hono app with a per-request Neon pool and
 * R2 blob store; everything else → static SPA assets. Cron → ingestion → alerts → reminders.
 */
import { createNeonDb } from '@tp/db';
import { spaCspFor } from '@tp/core/security/headers';
import { createApp } from './app';
import { createDeps } from './adapters/index';
import { createR2BlobStore, type R2BucketLike } from './adapters/blob-r2';
import type { RuntimeEnv } from './env';
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
  const deps = createDeps({ env: envVars(env), db, blobs: createR2BlobStore(env.BLOBS) });
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

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await withDeps(env, ctx, async (deps) => createApp(deps).fetch(request, env, ctx as never));
      } catch (e) {
        console.error('[tp] worker bootstrap failed', (e as Error).message);
        return Response.json({ error: { code: 'service_unavailable', message: 'Service temporarily unavailable' } }, { status: 503 });
      }
    }
    return withSecurityHeaders(request, await env.ASSETS.fetch(request));
  },

  async scheduled(_event: { cron?: string; scheduledTime?: number }, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(withDeps(env, ctx, (deps) => runScheduledJobs(deps, { trigger: 'cron' })).then(() => undefined));
  },
};
