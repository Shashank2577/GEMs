/** Consistent API errors: `{ error: { code, message, details? } }` (contracts/api.md). */
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Extra response headers (e.g. `Retry-After` on 429). */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) } };
  }
}

export const badRequest = (message = 'Bad request', details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const validationError = (message: string, details?: unknown) => new HttpError(400, 'validation_error', message, details);
export const unauthorized = (message = 'Please sign in to continue') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);

// ───────────── Ops / plan errors (008/FR-018, FR-021, FR-040) ─────────────

/** 402 — plan limits (`plan_limit_reached`, `plan_expired`). */
export const paymentRequired = (code: string, message: string, details?: unknown) => new HttpError(402, code, message, details);

/**
 * "Try again in N seconds/minutes." Auth rules (`auth.*`) always speak in minutes ("Too many attempts…", 002/FR-010);
 * other rules use seconds below two minutes and minutes above.
 */
export function rateLimitMessage(rule: string, retryAfterSec: number): string {
  const secs = Math.max(1, Math.ceil(retryAfterSec));
  const minutes = Math.max(1, Math.ceil(secs / 60));
  const inMinutes = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (rule.startsWith('auth.')) return `Too many attempts. Try again in ${inMinutes}.`;
  return secs < 120 ? `Too many requests. Try again in ${secs} second${secs === 1 ? '' : 's'}.` : `Too many requests. Try again in ${inMinutes}.`;
}

/** 429 `rate_limited` with `details: {rule, retryAfter}` and a `Retry-After` header (008/FR-018). */
export function tooManyRequests(rule: string, retryAfterSec: number, message?: string): HttpError {
  const retryAfter = Math.max(1, Math.ceil(retryAfterSec));
  return new HttpError(429, 'rate_limited', message ?? rateLimitMessage(rule, retryAfter), { rule, retryAfter }, { 'Retry-After': String(retryAfter) });
}

/** 413 `payload_too_large` (008/FR-021). */
export const payloadTooLarge = (message = 'The request is too large.', details?: unknown) => new HttpError(413, 'payload_too_large', message, details);

/** 422 with a specific code (`document_too_long`, `scanned_document`, …). */
export const unprocessable = (code: string, message: string, details?: unknown) => new HttpError(422, code, message, details);

/** 503 with a specific code (`service_unavailable`, `gem_busy`, …). */
export const serviceUnavailable = (code = 'service_unavailable', message = 'Service temporarily unavailable. Please try again in a minute.', details?: unknown) =>
  new HttpError(503, code, message, details);
