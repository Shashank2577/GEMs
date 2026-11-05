/**
 * Hono app factory shared by the Cloudflare Worker (worker.ts) and the Node server (node.ts).
 * Everything lives under /api; each area router is mounted at "/api" and declares its full
 * sub-paths from contracts/api.md.
 */
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps } from './deps';
import { errorHandler, notFoundHandler } from './middleware/error';
import { injectDeps, noStore } from './middleware/request';
import { originCheck } from './middleware/security';
import { analysisRoutes } from './routes/analysis';
import { assistRoutes } from './routes/assist';
import { authRoutes } from './routes/auth';
import { dashboardRoutes } from './routes/dashboard';
import { demoRoutes } from './routes/demo';
import { ingestionRoutes } from './routes/ingestion';
import { notificationsRoutes } from './routes/notifications';
import { orgRoutes } from './routes/org';
import { packetsRoutes } from './routes/packets';
import { profileRoutes } from './routes/profile';
import { sessionsRoutes } from './routes/sessions';
import { tendersRoutes } from './routes/tenders';
import { vaultRoutes } from './routes/vault';
import { viewsRoutes } from './routes/views';
import { watchlistsRoutes } from './routes/watchlists';
import { workspacesRoutes } from './routes/workspaces';
import type { AppEnv } from './types';

export type { AppEnv, AppVariables, AuthOrg, AuthUser } from './types';
export type { AppDeps } from './deps';

/** All area routers, mounted at /api in this order. */
export const routers = {
  auth: authRoutes,
  sessions: sessionsRoutes,
  org: orgRoutes,
  tenders: tendersRoutes,
  watchlists: watchlistsRoutes,
  views: viewsRoutes,
  ingestion: ingestionRoutes,
  notifications: notificationsRoutes,
  analysis: analysisRoutes,
  profile: profileRoutes,
  vault: vaultRoutes,
  workspaces: workspacesRoutes,
  packets: packetsRoutes,
  assist: assistRoutes,
  dashboard: dashboardRoutes,
  demo: demoRoutes,
} as const;

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  const api = new Hono<AppEnv>();
  api.use('*', injectDeps(deps));
  api.use('*', noStore);
  api.use('*', originCheck); // 002/FR-028: before any handler

  api.get('/health', async (c) => {
    let db = false;
    try {
      await deps.db.execute(sql`select 1`);
      db = true;
    } catch (e) {
      deps.logger.error('health: database unreachable', { error: (e as Error).message });
    }
    return c.json({ ok: db, db, version: deps.config.version }, db ? 200 : 503);
  });

  for (const r of Object.values(routers)) api.route('/', r);

  // Unknown /api/* paths → JSON 404 (never the SPA).
  api.all('*', notFoundHandler);

  app.route('/api', api);
  return app;
}

export type App = ReturnType<typeof createApp>;
