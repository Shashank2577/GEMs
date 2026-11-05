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

/** Sentry init options shared by both runtimes: release = APP_VERSION, environment = production|staging|development. */
export function sentryOptions(config: Pick<AppConfig, 'sentryDsn' | 'version' | 'environment'>, environmentOverride?: string) {
  const environment = environmentOverride || (config.environment === 'production' ? 'production' : 'development');
  return { dsn: config.sentryDsn ?? undefined, release: config.version, environment, sendDefaultPii: false, tracesSampleRate: 0 };
}
