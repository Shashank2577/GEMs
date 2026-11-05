/**
 * Cloudflare Worker entry (Constitution VII): /api/* → Hono app with a per-request Neon pool and
 * R2 blob store; everything else → static SPA assets. Cron → ingestion → alerts → reminders.
 */
import { createNeonDb } from '@tp/db';
import { createApp } from './app';
import { createDeps } from './adapters/index';
import { createR2BlobStore, type R2BucketLike } from './adapters/blob-r2';
import type { RuntimeEnv } from './env';
import { runScheduledJobs } from './lib/scheduled';
import { settleDeferred } from './lib/defer';

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
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: { cron?: string; scheduledTime?: number }, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(withDeps(env, ctx, (deps) => runScheduledJobs(deps, { trigger: 'cron' })).then(() => undefined));
  },
};
