/**
 * Request body caps (008/FR-021): reject oversized bodies with 413 `payload_too_large` BEFORE reading them.
 *
 *   router.post('/vault', bodyLimit(VAULT_UPLOAD_MAX_BYTES, '…20 MB…'), requireRole('analyst'), handler)
 *
 * - With `content-length`: compared up front; the body is never touched when it is too large.
 * - Without it (chunked): the body is wrapped in a counting stream that errors as soon as the cap is passed, and the
 *   response becomes the 413 even if the handler caught the read error.
 *
 * Caps: multipart uploads = file cap + 64 KB for multipart overhead; everything else (JSON) 1 MB (`bodyLimits`, app.ts).
 */
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { MAX_TENDER_DOC_BYTES } from '@tp/core/contracts/analyse';
import { VAULT_MAX_BYTES } from '@tp/core/contracts/vault';
import { HttpError, payloadTooLarge } from '../lib/errors';
import type { AppEnv } from '../types';

const MB = 1024 * 1024;
/** Multipart framing, field values and file name around the file itself. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const JSON_BODY_MAX_BYTES = 1 * MB;
export const VAULT_UPLOAD_MAX_BYTES = VAULT_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;
export const TENDER_DOC_UPLOAD_MAX_BYTES = MAX_TENDER_DOC_BYTES + MULTIPART_OVERHEAD_BYTES;

export const VAULT_TOO_LARGE = 'Files can be at most 20 MB. Compress the scan or split it and try again.';
export const TENDER_DOC_TOO_LARGE = 'The file is larger than 25 MB';
const JSON_TOO_LARGE = 'The request body is too large (at most 1 MB).';

function tooLarge(message: string, maxBytes: number): HttpError {
  return payloadTooLarge(message, { maxBytes });
}

/** Enforce `maxBytes` on the request body of this route. */
export const bodyLimit = (maxBytes: number, message = `The request body is too large (at most ${Math.round(maxBytes / MB)} MB).`) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const raw = c.req.raw;
    if (!raw.body || c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const declared = raw.headers.get('content-length');
    if (declared != null && declared.trim() !== '' && !raw.headers.has('transfer-encoding')) {
      const n = Number(declared);
      if (Number.isFinite(n) && n > maxBytes) throw tooLarge(message, maxBytes);
      return next();
    }
    // No (usable) content-length: count bytes while the handler reads the body.
    let exceeded = false;
    let seen = 0;
    const reader = raw.body.getReader();
    const counted = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const { done, value } = await reader.read();
        if (done) { ctrl.close(); return; }
        seen += value.byteLength;
        if (seen > maxBytes) {
          exceeded = true;
          ctrl.error(tooLarge(message, maxBytes));
          await reader.cancel().catch(() => {});
          return;
        }
        ctrl.enqueue(value);
      },
      cancel(reason) { return reader.cancel(reason); },
    }, { highWaterMark: 0 }); // read only as fast as the handler consumes
    c.req.raw = new Request(raw, { body: counted, duplex: 'half' } as RequestInit);
    await next();
    if (exceeded) {
      const err = tooLarge(message, maxBytes);
      c.res = new Response(JSON.stringify(err.toJSON()), { status: 413, headers: { 'content-type': 'application/json' } });
    }
  });

/**
 * Global cap for every /api request (mounted in app.ts): multipart bodies get the upload cap of their area (vault
 * 20 MB, otherwise the 25 MB tender-document cap; upload routes repeat their own cap), everything else 1 MB.
 */
export const bodyLimits = createMiddleware<AppEnv>(async (c: Context<AppEnv>, next) => {
  if (!/^multipart\/form-data/i.test(c.req.header('content-type') ?? '')) return bodyLimit(JSON_BODY_MAX_BYTES, JSON_TOO_LARGE)(c, next);
  return /^\/api\/vault(\/|$)/.test(c.req.path)
    ? bodyLimit(VAULT_UPLOAD_MAX_BYTES, VAULT_TOO_LARGE)(c, next)
    : bodyLimit(TENDER_DOC_UPLOAD_MAX_BYTES, TENDER_DOC_TOO_LARGE)(c, next);
});
