import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors';
import { zodToHttpError } from '../lib/validate';
import type { AppEnv } from '../types';

/** app.onError handler → `{ error: { code, message, details? } }`. */
export function errorHandler(err: Error, c: Context<AppEnv>) {
  if (err instanceof HttpError) return c.json(err.toJSON(), err.status);
  if (err instanceof ZodError) {
    const e = zodToHttpError(err);
    return c.json(e.toJSON(), e.status);
  }
  if (err instanceof HTTPException) {
    const status = err.status;
    const code = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_found'
      : status === 413 ? 'payload_too_large' : status >= 500 ? 'internal_error' : 'bad_request';
    return c.json({ error: { code, message: err.message || 'Request failed' } }, status);
  }
  const logger = c.var.deps?.logger;
  const meta = { rid: c.var.requestId, path: c.req.path, error: err?.message, stack: err?.stack?.split('\n').slice(0, 6).join(' | ') };
  if (logger) logger.error('unhandled error', meta); else console.error('[tp] unhandled error', meta);
  return c.json({ error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.', details: { requestId: c.var.requestId } } }, 500);
}

export function notFoundHandler(c: Context<AppEnv>) {
  return c.json({ error: { code: 'not_found', message: `No API route for ${c.req.method} ${c.req.path}` } }, 404);
}
