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

/** 413 `payload_too_large` (008/FR-021). */
export const payloadTooLarge = (message = 'The request is too large.', details?: unknown) => new HttpError(413, 'payload_too_large', message, details);

/** 422 with a specific code (`document_too_long`, `scanned_document`, …). */
export const unprocessable = (code: string, message: string, details?: unknown) => new HttpError(422, code, message, details);

/** 503 with a specific code (`service_unavailable`, `gem_busy`, …). */
export const serviceUnavailable = (code = 'service_unavailable', message = 'Service temporarily unavailable. Please try again in a minute.', details?: unknown) =>
  new HttpError(503, code, message, details);
