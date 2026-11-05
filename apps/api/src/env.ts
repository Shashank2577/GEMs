/**
 * Runtime configuration. The same variable names are used by the Worker (`wrangler.toml` vars +
 * secrets) and by the Node server (`process.env`). Missing optional integrations degrade to
 * logged no-ops (Constitution VII).
 */

/** All string environment variables the API understands. */
export interface RuntimeEnv {
  DATABASE_URL?: string;
  APP_URL?: string;
  APP_VERSION?: string;
  GEM_BASE_URL?: string;
  GEM_USER_AGENT?: string;
  GEM_MIN_INTERVAL_MS?: string;
  GEM_MAX_PAGES?: string;
  ANTHROPIC_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_ID?: string;
  WHATSAPP_API_VERSION?: string;
  LOG_REQUESTS?: string;
  /**
   * Which proxy header carries the client IP: "cloudflare" (cf-connecting-ip; Worker only, set by worker.ts and refused
   * by the Node server), "1"/"xff" (right-most x-forwarded-for hop), unset = socket address (lib/client-ip.ts).
   */
  TRUST_PROXY?: string;
  /** Packet build input cap in bytes (006/FR-056, NFR-003). Default 60 MB. */
  PACKET_MAX_INPUT_BYTES?: string;
  /** "development" | "production" | "test" */
  NODE_ENV?: string;
  /** Operator token for /api/admin/* (008/FR-042). Unset → admin routes answer 404. */
  ADMIN_TOKEN?: string;
  /** Sentry DSN; unset → error reporter is a no-op (008/FR-046). */
  SENTRY_DSN?: string;
  /** "debug" | "info" | "warn" | "error" (default info). */
  LOG_LEVEL?: string;
  /** /api/health reports `ingestion_stale` when the last successful sync is older than this (default 120). */
  HEALTH_INGESTION_MAX_AGE_MIN?: string;
  /** Minimum minutes between manual "Sync now" runs (008/FR-026, default 10). */
  MANUAL_SYNC_COOLDOWN_MIN?: string;
}

export interface AppConfig {
  /** Public base URL of the web app, no trailing slash (used for invite / email links). */
  appUrl: string;
  version: string;
  environment: 'development' | 'production' | 'test';
  /** Log one line per API request. */
  logRequests: boolean;
  mailFrom: string;
  llmModel: string;
  /** Proxy whose client-IP header is trusted for rate limiting (002/FR-010). */
  trustProxy: TrustProxy;
  /** Max Σ stored input size of a packet build before it is refused with 413 (006/FR-056, NFR-003). */
  packetMaxInputBytes: number;
  /** Null when ADMIN_TOKEN is unset. */
  adminToken: string | null;
  /** Null when SENTRY_DSN is unset. */
  sentryDsn: string | null;
  logLevel: LogLevel;
  healthIngestionMaxAgeMin: number;
  manualSyncCooldownMin: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function parseLogLevel(v: string | undefined): LogLevel {
  const l = (v ?? '').toLowerCase();
  return l === 'debug' || l === 'warn' || l === 'error' ? l : 'info';
}

export type TrustProxy = 'cloudflare' | 'xff' | 'none';

function parseTrustProxy(v: string | undefined): TrustProxy {
  if (!v) return 'none';
  if (/^cloudflare$/i.test(v)) return 'cloudflare';
  return /^(1|true|yes|on|xff|x-forwarded-for)$/i.test(v) ? 'xff' : 'none';
}

export const DEFAULT_LLM_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_GEM_BASE_URL = 'https://bidplus.gem.gov.in';
export const DEFAULT_GEM_USER_AGENT = 'TenderPilot/0.1 (+https://tenderpilot.in/bot; public BidPlus listings only)';
export const APP_VERSION = '0.1.0';
/** Default packet input cap: 60 MB (006/FR-056). */
export const DEFAULT_PACKET_MAX_INPUT_BYTES = 60 * 1024 * 1024;

const trimSlash = (s: string) => s.replace(/\/+$/, '');
const truthy = (v: string | undefined, dflt: boolean) => (v == null || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));

const positiveInt = (v: string | undefined, d: number) => {
  const n = v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

export function loadConfig(env: RuntimeEnv): AppConfig {
  const environment = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  return {
    appUrl: trimSlash(env.APP_URL || 'http://localhost:8787'),
    version: env.APP_VERSION || APP_VERSION,
    environment,
    logRequests: truthy(env.LOG_REQUESTS, environment !== 'test'),
    mailFrom: env.MAIL_FROM || 'TenderPilot <alerts@tenderpilot.in>',
    llmModel: env.LLM_MODEL || DEFAULT_LLM_MODEL,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    packetMaxInputBytes: positiveInt(env.PACKET_MAX_INPUT_BYTES, DEFAULT_PACKET_MAX_INPUT_BYTES),
    adminToken: env.ADMIN_TOKEN || null,
    sentryDsn: env.SENTRY_DSN || null,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    healthIngestionMaxAgeMin: nonNegativeInt(env.HEALTH_INGESTION_MAX_AGE_MIN, 120),
    manualSyncCooldownMin: nonNegativeInt(env.MANUAL_SYNC_COOLDOWN_MIN, 10),
  };
}

/** Like positiveInt but 0 is allowed (e.g. MANUAL_SYNC_COOLDOWN_MIN=0 turns the cooldown off). */
function nonNegativeInt(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

export interface GemConfig {
  /** BidPlus base URL (points at tools/mock-gem in dev/E2E). */
  baseUrl: string;
  /** Honest User-Agent (Constitution II). */
  userAgent: string;
  /** Minimum delay between requests to GeM (NFR-002: ≤ 1 req/s). */
  minIntervalMs: number;
  /** Default number of listing pages per ingestion run. */
  maxPages: number;
}

export function loadGemConfig(env: RuntimeEnv): GemConfig {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    baseUrl: trimSlash(env.GEM_BASE_URL || DEFAULT_GEM_BASE_URL),
    userAgent: env.GEM_USER_AGENT || DEFAULT_GEM_USER_AGENT,
    minIntervalMs: Math.max(0, num(env.GEM_MIN_INTERVAL_MS, 1000)),
    maxPages: Math.max(1, num(env.GEM_MAX_PAGES, 5)),
  };
}
