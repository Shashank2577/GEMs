/**
 * Operational caps (spec 008 NFR-009): every limit that keeps a request inside Cloudflare Workers limits
 * (128 MB memory, CPU time, subrequests) and keeps TenderPilot polite to GeM lives here, as a named
 * constant pinned by `caps.test.ts`. Shared by apps/api (enforcement) and apps/web (messages).
 */

const MB = 1024 * 1024;

/** A tender document longer than this is rejected with 422 `document_too_long` (FR-030). */
export const MAX_TENDER_DOC_PAGES = 300;

/** Share of pages with an empty text layer at which a PDF counts as a scan (FR-030, US4 scenario 9). */
export const SCANNED_EMPTY_PAGE_RATIO = 0.8;

/** At most this many LLM calls per analysis; the rest of the documents are read by rules only (FR-031). */
export const MAX_LLM_CALLS_PER_ANALYSIS = 2;

/** Total characters sent to the LLM in one analysis (FR-031). */
export const MAX_LLM_INPUT_CHARS = 90_000;

/** Timeout of one LLM call (FR-031). */
export const LLM_CALL_TIMEOUT_MS = 60_000;

/** Wall-clock budget of one analysis; no new LLM call starts after it (FR-031). */
export const ANALYSIS_BUDGET_MS = 120_000;

/**
 * Most items in one packet (FR-032); also `packetBuildSchema.items.max`.
 * Packet input size is not a constant here: it is 006/FR-056's configurable `PACKET_MAX_INPUT_BYTES` (apps/api env),
 * which the Worker sets to 40 MB in wrangler.toml per 008/FR-032.
 */
export const PACKET_MAX_ITEMS = 40;

/** Largest JSON request body (FR-021). */
export const JSON_BODY_MAX_BYTES = 1 * MB;

/** Minutes between two manual "Sync now" runs, platform-wide (FR-026; supersedes 003 FR-013's 2 minutes). */
export const MANUAL_SYNC_COOLDOWN_MIN = 10;

/** Minimum spacing of GeM requests across every isolate/process (FR-024, NFR-002). */
export const GEM_MIN_INTERVAL_MS = 1000;

/** Longest a user-facing GeM fetch waits for its lease slot before answering 503 `gem_busy` (FR-024). */
export const GEM_LEASE_MAX_WAIT_MS = 25_000;

/**
 * Wall-clock budget of one ingestion run for waiting on GeM lease slots (FR-024); below the 15-minute stale-run
 * reaper (`RUN_LOCK_MS`) so a run never outlives its lock.
 */
export const INGESTION_RUN_BUDGET_MS = 10 * 60_000;

/** Human-readable size for cap messages: "45 MB". */
export function formatMb(bytes: number): string {
  const mb = bytes / MB;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}
