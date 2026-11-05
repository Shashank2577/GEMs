/**
 * Hono app factory shared by the Cloudflare Worker (worker.ts) and the Node server (node.ts).
 * Everything lives under /api; each area router is mounted at "/api" and declares its full
 * sub-paths from contracts/api.md.
 */
import { Hono } from 'hono';
import type { AppDeps } from './deps';
import { readOnlyTokenGuard } from './middleware/auth';
import { bodyLimits } from './middleware/body-limit';
import { errorHandler, notFoundHandler } from './middleware/error';
import { ipLimit } from './middleware/rate-limit';
import { injectDeps, noStore } from './middleware/request';
import { requireActivePlan } from './middleware/plan';
import { originCheck, securityHeaders } from './middleware/security';
import { adminRoutes } from './routes/admin';
import { analysisRoutes } from './routes/analysis';
import { assistRoutes } from './routes/assist';
import { authRoutes } from './routes/auth';
import { dashboardRoutes } from './routes/dashboard';
import { demoRoutes } from './routes/demo';
import { healthRoutes } from './routes/health';
import { ingestionRoutes } from './routes/ingestion';
import { insightsRoutes } from './routes/insights';
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
import { refreshResults, ResultsBusyError } from './services/results';
import type { AppEnv } from './types';

export type { AppEnv, AppVariables, AuthOrg, AuthUser } from './types';
export type { AppDeps } from './deps';

/** All area routers, mounted at /api in this order. */
export const routers = {
  health: healthRoutes,
  auth: authRoutes,
  sessions: sessionsRoutes,
  org: orgRoutes,
  tenders: tendersRoutes,
  watchlists: watchlistsRoutes,
  views: viewsRoutes,
  ingestion: ingestionRoutes,
  insights: insightsRoutes,
  notifications: notificationsRoutes,
  analysis: analysisRoutes,
  profile: profileRoutes,
  vault: vaultRoutes,
  workspaces: workspacesRoutes,
  packets: packetsRoutes,
  assist: assistRoutes,
  dashboard: dashboardRoutes,
  demo: demoRoutes,
  admin: adminRoutes,
} as const;

export function createApp(deps: AppDeps, opts: { testHooks?: boolean } = {}) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  app.use('*', securityHeaders()); // 002/FR-050: every response, incl. errors and 404s

  const api = new Hono<AppEnv>();
  api.use('*', injectDeps(deps));
  api.use('*', noStore);
  api.use('*', originCheck); // 002/FR-028: before any handler
  // 008/FR-021: 413 before any body is read (1 MB JSON, upload caps on multipart; routes add tighter caps).
  api.use('*', bodyLimits);
  // 008/FR-019 `api.ip` for requests without credentials (`api.user` is applied once authenticated, middleware/auth.ts).
  api.use('*', ipLimit);
  // 006/FR-074: read-only API tokens may only GET (uses the credentials ipLimit resolved).
  api.use('*', readOnlyTokenGuard);
  // 008/FR-038: an expired trial is read-only (402 plan_expired); /api/health, auth and the allow-list stay reachable.
  api.use('*', requireActivePlan);

  // 003/NFR-008: E2E-only mail capture. Opt-in via E2E_TEST_HOOKS=1 on the Node server (never wired in worker.ts),
  // never in production, and only with the in-memory log mailer.
  if (opts.testHooks && deps.config.environment !== 'production' && 'sent' in deps.mailer && Array.isArray(deps.mailer.sent)) {
    const mailer = deps.mailer as { sent: unknown[] };
    api.get('/__test/mail', (c) => c.json({ sent: mailer.sent }));
  }

  // 003/US6 E2E: run the daily results refresh now (skips the 10:00 IST daily gate, keeps the single-run guard and
  // the 24 h per-tender recheck window). Same opt-in and production exclusion as the mail hook.
  if (opts.testHooks && deps.config.environment !== 'production') {
    api.post('/__test/results/refresh', async (c) => {
      try {
        const run = await refreshResults(c.var.deps, { trigger: 'manual' });
        return c.json({ id: run.id, status: run.status, checked: run.tendersSeen, stored: run.tendersUpdated, awarded: run.tendersCreated, error: run.error });
      } catch (e) {
        if (e instanceof ResultsBusyError) return c.json({ error: { code: 'results_running', message: e.message } }, 409);
        throw e;
      }
    });
  }

  for (const r of Object.values(routers)) api.route('/', r);

  // Unknown /api/* paths → JSON 404 (never the SPA).
  api.all('*', notFoundHandler);

  app.route('/api', api);
  return app;
}

export type App = ReturnType<typeof createApp>;
