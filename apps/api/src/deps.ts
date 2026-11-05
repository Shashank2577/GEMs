/**
 * Dependency interfaces injected into the app (`createApp(deps)`), the Worker and the services.
 * Feature teams type against these; concrete implementations live in `adapters/`.
 */
import type { Db } from '@tp/db';
import type { AppConfig, GemConfig } from './env';

// ───────────── Blob storage (R2 in prod, filesystem locally) ─────────────

export type BlobBody = Uint8Array | ArrayBuffer | string | Blob;

export interface BlobMeta {
  key: string;
  size: number;
  contentType: string;
  uploadedAt?: Date;
}

export interface BlobObject extends BlobMeta {
  /** Stream the content (single use). */
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BlobStore {
  /** Store an object. Keys are `/`-separated, e.g. `org/<orgId>/vault/<docId>.pdf`. */
  put(key: string, body: BlobBody, opts?: { contentType?: string }): Promise<BlobMeta>;
  get(key: string): Promise<BlobObject | null>;
  head(key: string): Promise<BlobMeta | null>;
  /** Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

// ───────────── LLM ─────────────

export interface LlmRequest {
  system?: string;
  prompt: string;
  /** Default 2048. */
  maxTokens?: number;
  /** Aborts the provider request (008/FR-031: a timed-out call stops spending tokens and isolate time). */
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
  model: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmCallOptions {
  /** Called once the provider answered, with its token usage (also when the reply is not valid JSON; 008/FR-039). */
  onUsage?: (r: Pick<LlmResult, 'model' | 'usage'>) => void;
}

export interface LlmClient {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResult>;
  /**
   * Ask for JSON and parse it (tolerates ```json fences and leading prose).
   * Throws `LlmError` when the reply is not valid JSON. Validate the result with zod.
   */
  completeJson<T = unknown>(req: LlmRequest, opts?: LlmCallOptions): Promise<T>;
}

// ───────────── Messaging ─────────────

export interface SendResult {
  /** Provider message id when sent. */
  id?: string;
  /** True when the channel is not configured (message logged instead). */
  skipped?: boolean;
}

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  /** Extra headers, e.g. List-Unsubscribe / List-Unsubscribe-Post (RFC 8058). */
  headers?: Record<string, string>;
}

export interface Mailer {
  /** False when no provider key is configured; `send` then logs and returns `{skipped:true}`. */
  readonly configured: boolean;
  send(msg: EmailMessage): Promise<SendResult>;
}

export interface WhatsAppMessage {
  /** E.164 number, e.g. +919812345678. */
  to: string;
  /** Free-form text (only deliverable inside the 24h customer-service window). */
  text?: string;
  /** Pre-approved template (required for business-initiated alerts). */
  template?: { name: string; language?: string; params?: string[] };
}

export interface WhatsApp {
  readonly configured: boolean;
  send(msg: WhatsAppMessage): Promise<SendResult>;
}

// ───────────── Misc ─────────────

export interface Clock { now(): Date }

export interface Logger {
  /** Optional so test doubles need not implement it; call as `logger.debug?.()`. */
  debug?(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ───────────── Ops primitives (spec 008) ─────────────

export interface RateLimitResult {
  /** Requests counted in the current window, including this one. */
  count: number;
  limit: number;
  /** False when this request is over the limit (count > limit). */
  allowed: boolean;
  remaining: number;
  /** Seconds until the window ends (≥ 1). */
  retryAfterSec: number;
}

/**
 * Fixed-window counters shared by every isolate/process (008/FR-017). Postgres in production
 * (`lib/rate-limiter.ts#createPgRateLimiter`), in-memory or no-op in tests.
 */
export interface RateLimiter {
  /** Count one request against `key` in the window of `windowSec` containing `now`. */
  hit(key: string, limit: number, windowSec: number, now: Date): Promise<RateLimitResult>;
  /** Forget every window of `key` (e.g. after a successful sign-in). */
  reset(key: string): Promise<void>;
}

/** Error reporting (Sentry when `SENTRY_DSN` is set, otherwise a no-op; 008/FR-046). */
export interface ErrorReporter {
  capture(error: unknown, context?: Record<string, unknown>): void;
}

/**
 * Cluster-wide GeM request slot (008/FR-024, NFR-002: ≤ 1 request/s across all isolates). Implemented by US4
 * (`lib/gem-lease.ts`); the default waits for nothing.
 */
export interface GemLease {
  /** Resolve when this caller may send one request to GeM; reject (503 `gem_busy`) when the wait would exceed `maxWaitMs`. */
  acquire(maxWaitMs: number): Promise<void>;
}

export interface AppDeps {
  db: Db;
  blobs: BlobStore;
  /** null when ANTHROPIC_API_KEY is not set — rules-only mode (Constitution III). */
  llm: LlmClient | null;
  mailer: Mailer;
  whatsapp: WhatsApp;
  gem: GemConfig;
  clock: Clock;
  config: AppConfig;
  logger: Logger;
  /** Outbound fetch (GeM, providers). Injectable for tests; defaults to global fetch. */
  fetch: typeof fetch;
  /** Request rate limits (008/FR-017). */
  rateLimiter: RateLimiter;
  /** Unhandled-error reporter (008/FR-046). */
  errors: ErrorReporter;
  /** Cluster-wide GeM throttle (008/FR-024). */
  gemLease: GemLease;
}

export type { AppConfig, GemConfig };
