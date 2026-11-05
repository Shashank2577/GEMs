/**
 * Local / CI / self-hosted entry: Node HTTP server serving the API and the built SPA
 * (apps/web/dist, with SPA fallback). Uses node-postgres and a filesystem blob store.
 *
 * Env: PORT (8787), DATABASE_URL, BLOB_DIR (.data/blobs), WEB_DIST (apps/web/dist),
 *      AUTO_MIGRATE=1 (run migrations on boot), CRON_INTERVAL_MS (in-process scheduler; 0/unset = off).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createNodeDb } from '@tp/db';
import { spaCspFor } from '@tp/core/security/headers';
import { createApp } from './app';
import { createDeps } from './adapters/index';
import { createFsBlobStore } from './adapters/blob-fs';
import type { RuntimeEnv } from './env';
import { runScheduledJobs } from './lib/scheduled';
import { settleDeferred } from './lib/defer';
import { securityHeaders } from './middleware/security';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

export async function startNodeServer(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT || 8787);
  const databaseUrl = env.DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot';
  const blobDir = resolve(repoRoot, env.BLOB_DIR || '.data/blobs');
  const webDist = resolve(repoRoot, env.WEB_DIST || 'apps/web/dist');

  if (env.AUTO_MIGRATE === '1' || env.AUTO_MIGRATE === 'true') {
    const { runMigrations } = await import('@tp/db/migrate');
    await runMigrations(databaseUrl);
    console.log('[tp] migrations applied');
  }

  const { db, close } = await createNodeDb(databaseUrl);
  const deps = createDeps({
    env: { APP_URL: env.APP_URL || `http://localhost:${port}`, ...(env as RuntimeEnv) },
    db,
    blobs: createFsBlobStore(blobDir),
  });

  const server = new Hono();
  const indexPath = resolve(webDist, 'index.html');
  const hasWeb = existsSync(indexPath);
  // 002/FR-050: security headers on every response; the SPA's CSP allows the inline theme script by the hash of the
  // built index.html being served (recomputed when the file changes, e.g. a rebuild while the server runs).
  let cspCache: { mtimeMs: number; csp: string } | null = null;
  const spaCsp = async () => {
    if (!existsSync(indexPath)) return undefined;
    const { mtimeMs } = statSync(indexPath);
    if (cspCache?.mtimeMs !== mtimeMs) cspCache = { mtimeMs, csp: await spaCspFor(readFileSync(indexPath, 'utf8')) };
    return cspCache.csp;
  };
  server.use('*', securityHeaders({ csp: spaCsp }));
  server.route('/', createApp(deps));

  if (hasWeb) {
    const root = relative(process.cwd(), webDist) || '.';
    server.use('/*', serveStatic({
      root,
      onFound: (path, c) => {
        // Hashed build assets are immutable; HTML always revalidates.
        c.header('cache-control', /\/assets\//.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }));
    server.get('*', (c) => c.html(readFileSync(indexPath, 'utf8'), 200, { 'cache-control': 'no-cache' }));
  } else {
    server.get('/', (c) => c.text(`TenderPilot API is running. Web build not found at ${webDist} (run \`pnpm --filter @tp/web build\`).`));
  }

  const httpServer = serve({ fetch: server.fetch, port }, (info) => {
    console.log(`[tp] TenderPilot listening on http://localhost:${info.port}`);
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  const interval = Number(env.CRON_INTERVAL_MS || 0);
  if (interval > 0) {
    let running = false;
    timer = setInterval(async () => {
      if (running) return;
      running = true;
      try { await runScheduledJobs(deps, { trigger: 'cron' }); } finally { running = false; }
    }, interval);
    console.log(`[tp] in-process scheduler every ${interval}ms`);
  }

  const shutdown = async () => {
    if (timer) clearInterval(timer);
    httpServer.close();
    // Background work (lib/defer.ts, e.g. a password-reset email) still needs the pool: close only after it settles.
    await settleDeferred(deps).catch(() => {});
    await close();
  };
  return { deps, server, shutdown, port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startNodeServer().then(({ shutdown }) => {
    const stop = () => { shutdown().finally(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((e) => {
    console.error('[tp] failed to start', e);
    process.exit(1);
  });
}
