/** Build AppDeps from environment variables + runtime-specific db/blob store. */
import type { Db } from '@tp/db';
import type { AppDeps, BlobStore, Clock, ErrorReporter, GemLease, Logger } from '../deps';
import { adminTokenWarning, loadConfig, loadGemConfig, type AppConfig, type RuntimeEnv } from '../env';
import { createPgGemLease } from '../lib/gem-lease';
import { createPgRateLimiter } from '../lib/rate-limiter';
import { systemClock } from './clock';
import { noopErrorReporter } from './errors';
import { createAnthropicClient } from './llm';
import { createJsonLogger } from './logger';
import { createLogMailer, createResendMailer } from './mailer';
import { createLogWhatsApp, createMetaWhatsApp } from './whatsapp';

export interface CreateDepsInput {
  env: RuntimeEnv;
  db: Db;
  blobs: BlobStore;
  clock?: Clock;
  logger?: Logger;
  /** Error reporter (default no-op); worker.ts / node.ts pass a Sentry-backed one when SENTRY_DSN is set. */
  errors?: ErrorReporter;
  fetch?: typeof fetch;
}

let adminTokenWarned = false;

export function createDeps({ env, db, blobs, clock, logger, errors, fetch: f }: CreateDepsInput): AppDeps {
  const config = loadConfig(env);
  logger ??= createJsonLogger({ level: config.logLevel });
  const adminWarning = adminTokenWarning(env);
  if (adminWarning && !adminTokenWarned) { adminTokenWarned = true; logger.warn(adminWarning); }
  warnMissingUnsubscribeSecret(env, config, logger);
  const gem = loadGemConfig(env);
  const doFetch: typeof fetch = f ?? ((input, init) => fetch(input, init));
  return {
    db,
    blobs,
    config,
    logger,
    clock: clock ?? systemClock,
    gem,
    fetch: doFetch,
    llm: env.ANTHROPIC_API_KEY
      ? createAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY, model: config.llmModel, baseUrl: env.LLM_BASE_URL, fetch: doFetch })
      : null,
    mailer: env.RESEND_API_KEY
      ? createResendMailer({ apiKey: env.RESEND_API_KEY, from: config.mailFrom, fetch: doFetch, logger })
      : createLogMailer(logger),
    whatsapp: env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID
      ? createMetaWhatsApp({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_ID, apiVersion: env.WHATSAPP_API_VERSION, fetch: doFetch })
      : createLogWhatsApp(logger),
    rateLimiter: createPgRateLimiter(db),
    errors: errors ?? noopErrorReporter,
    // 008/FR-024: one GeM request per GEM_MIN_INTERVAL_MS across every isolate (0 = unthrottled, local tests only).
    // Clock bounds are cached per DATABASE_URL at module scope, not per request's pool (review S2).
    gemLease: gem.minIntervalMs > 0 ? createPgGemLease(db, gem.minIntervalMs, { clockKey: env.DATABASE_URL }) : noopGemLease,
  };
}

let warnedUnsubscribeSecret = false;
/**
 * 003/FR-048: production with real email but no UNSUBSCRIBE_SECRET sends alert emails without List-Unsubscribe
 * headers. Logged once per process / isolate (createDeps runs per request on the Worker).
 */
function warnMissingUnsubscribeSecret(env: RuntimeEnv, config: AppConfig, logger: Logger) {
  if (warnedUnsubscribeSecret || config.environment !== 'production' || !env.RESEND_API_KEY || config.unsubscribeSecret) return;
  warnedUnsubscribeSecret = true;
  logger.warn('UNSUBSCRIBE_SECRET is not set: alert emails go out without one-click unsubscribe headers (003/FR-048)');
}

/** GeM lease that never waits (the per-instance GemClient throttle still applies). */
export const noopGemLease: GemLease = { async acquire() { /* no cluster-wide lease */ } };

// createFsBlobStore: import from './blob-fs' directly (Node only — keeps node:fs out of the Worker bundle).
export { createR2BlobStore, type R2BucketLike } from './blob-r2';
export { createMemoryBlobStore } from './memory-blob';
export { createAnthropicClient, LlmError, parseJsonLoose } from './llm';
export { createLogMailer, createResendMailer } from './mailer';
export { createLogWhatsApp, createMetaWhatsApp } from './whatsapp';
export { systemClock, createFixedClock } from './clock';
export { consoleLogger, silentLogger } from './logger';
export { noopErrorReporter } from './errors';
export { createMemoryRateLimiter, createPgRateLimiter, noopRateLimiter } from '../lib/rate-limiter';
