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
  /** Which proxy header carries the client IP: "cloudflare" (cf-connecting-ip), "xff"/"1" (x-forwarded-for), unset = none. */
  TRUST_PROXY?: string;
  /** "development" | "production" | "test" */
  NODE_ENV?: string;
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

const trimSlash = (s: string) => s.replace(/\/+$/, '');
const truthy = (v: string | undefined, dflt: boolean) => (v == null || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));

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
  };
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
