/**
 * Local / CI / self-hosted entry: Node HTTP server serving the API and the built SPA
 * (apps/web/dist, with SPA fallback). Uses node-postgres and a filesystem blob store.
 *
 * Env: PORT (8787), DATABASE_URL, BLOB_DIR (.data/blobs), WEB_DIST (apps/web/dist),
 *      AUTO_MIGRATE=1 (run migrations on boot), CRON_INTERVAL_MS (in-process scheduler; 0/unset = off).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createNodeDb } from '@tp/db';
import { createApp } from './app';
import { createDeps } from './adapters/index';
import { createFsBlobStore } from './adapters/blob-fs';
import type { RuntimeEnv } from './env';
import { runScheduledJobs } from './lib/scheduled';
import { isHttpsRequest, parseHeadersFile, staticHeadersFor } from './lib/security-headers';

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
  server.route('/', createApp(deps));

  const indexPath = resolve(webDist, 'index.html');
  if (existsSync(indexPath)) {
    const root = relative(process.cwd(), webDist) || '.';
    // Same static security headers + CSP as Cloudflare (FR-013): the built copy of apps/web/public/_headers.
    const headersFile = resolve(webDist, '_headers');
    const rules = existsSync(headersFile) ? parseHeadersFile(readFileSync(headersFile, 'utf8')) : [];
    const trustProxy = deps.config.trustProxy !== 'none';
    server.use('/*', async (c, next) => {
      await next();
      if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return;
      const https = isHttpsRequest(c.req.url, c.req.header('x-forwarded-proto'), trustProxy);
      for (const [k, v] of Object.entries(staticHeadersFor(rules, c.req.path, https))) if (k !== 'cache-control') c.header(k, v);
    });
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
