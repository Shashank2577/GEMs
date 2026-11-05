/**
 * Error reporter adapters (008/FR-046). No-op by default (Workers Logs / console remain the source of truth); when
 * `SENTRY_DSN` is set the entry point builds a Sentry-backed reporter from `@sentry/cloudflare` (Worker) or
 * `@sentry/node` (Node). The SDKs are imported by worker.ts / node.ts only, never here, so each runtime bundles one.
 */
import type { AppConfig } from '../env';
import type { ErrorReporter } from '../deps';

export const noopErrorReporter: ErrorReporter = { capture() { /* nothing configured */ } };

/** The slice of the Sentry SDK we use (both `@sentry/cloudflare` and `@sentry/node` satisfy it). */
export interface SentryLike {
  captureException(error: unknown, hint?: { tags?: Record<string, string>; user?: { id: string }; extra?: Record<string, unknown> }): unknown;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * Context keys we forward: `rid`, `orgId`, `userId`, `route` (the route pattern, never a concrete URL with ids/tokens)
 * and `job`. Anything else is ignored so request data (bodies, emails, cookies) cannot leak to Sentry.
 */
export function createSentryReporter(sdk: SentryLike): ErrorReporter {
  return {
    capture(error, context = {}) {
      try {
        const tags: Record<string, string> = {};
        for (const k of ['rid', 'orgId', 'route', 'job'] as const) { const v = str(context[k]); if (v) tags[k] = v; }
        const userId = str(context.userId);
        sdk.captureException(error, { tags, ...(userId ? { user: { id: userId } } : {}) });
      } catch { /* reporting must never break a request */ }
    },
  };
}

/** The parts of a Sentry event that can carry request data (structural, so both SDKs' event types fit). */
export interface ScrubbableEvent {
  request?: { url?: string; headers?: unknown; cookies?: unknown; query_string?: unknown; data?: unknown; env?: unknown };
  breadcrumbs?: { data?: Record<string, unknown> }[];
}

const stripQuery = (url: string) => url.replace(/[?#].*$/, '');

/**
 * NFR-008 / ADR-0011: nothing from the request may reach Sentry except the path. Drops headers (Authorization: Bearer
 * tp_… extension tokens, ADMIN_TOKEN), cookies, body, env and the query string (`?q=` search text, `?token=`), and
 * strips queries from breadcrumb URLs (outbound fetches to GeM / Resend / Meta).
 */
export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  const req = event.request;
  if (req) {
    delete req.headers; delete req.cookies; delete req.query_string; delete req.data; delete req.env;
    if (typeof req.url === 'string') req.url = stripQuery(req.url);
  }
  for (const b of event.breadcrumbs ?? []) {
    if (b.data && typeof b.data.url === 'string') b.data.url = stripQuery(b.data.url);
  }
  return event;
}

/**
 * Sentry init options shared by both runtimes: release = APP_VERSION, environment = SENTRY_ENVIRONMENT or
 * production|development from NODE_ENV (the Worker forces NODE_ENV=production, so staging must set SENTRY_ENVIRONMENT).
 * No tracing and no trace propagation: `sentry-trace`/`baggage` headers are never added to calls to third parties.
 */
export function sentryOptions(config: Pick<AppConfig, 'sentryDsn' | 'version' | 'environment'>, environmentOverride?: string) {
  const environment = environmentOverride || (config.environment === 'production' ? 'production' : 'development');
  return {
    dsn: config.sentryDsn ?? undefined,
    release: config.version,
    environment,
    sendDefaultPii: false,
    tracePropagationTargets: [] as string[],
    // The RequestData integration copies headers/URL/query onto every event; drop it (scrubEvent is the backstop).
    integrations: <I extends { name: string }>(defaults: I[]): I[] => defaults.filter((i) => i.name !== 'RequestData'),
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: <B extends { data?: Record<string, unknown> }>(b: B): B => {
      if (b.data && typeof b.data.url === 'string') b.data.url = stripQuery(b.data.url);
      return b;
    },
  };
}
