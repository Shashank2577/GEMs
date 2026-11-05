/** Build AppDeps from environment variables + runtime-specific db/blob store. */
import type { Db } from '@tp/db';
import type { AppDeps, BlobStore, Clock, ErrorReporter, GemLease, Logger } from '../deps';
import { loadConfig, loadGemConfig, type RuntimeEnv } from '../env';
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

export function createDeps({ env, db, blobs, clock, logger, errors, fetch: f }: CreateDepsInput): AppDeps {
  const config = loadConfig(env);
  logger ??= createJsonLogger({ level: config.logLevel });
  const doFetch: typeof fetch = f ?? ((input, init) => fetch(input, init));
  return {
    db,
    blobs,
    config,
    logger,
    clock: clock ?? systemClock,
    gem: loadGemConfig(env),
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
    gemLease: noopGemLease,
  };
}

/** GeM lease that never waits (the per-instance GemClient throttle still applies). US4 replaces it with `lib/gem-lease.ts`. */
export const noopGemLease: GemLease = { async acquire() { /* no cluster-wide lease yet */ } };

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
