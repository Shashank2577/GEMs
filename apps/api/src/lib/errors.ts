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
