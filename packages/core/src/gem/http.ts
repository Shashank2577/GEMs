/**
 * Bounded HTTP helpers for GeM downloads (spec 008 FR-021, FR-030, NFR-002).
 *
 *   const { body } = await fetchBoundedResource(url, { headers }, { maxBytes: 25 * 1024 * 1024 });
 *   if (!isPdfBody(body)) …
 *
 * - Bound both connection time and body download time with one deadline; abort the stream as soon as the
 *   advertised or received size exceeds `maxBytes` (a 128 MB Worker isolate must never buffer an unbounded PDF).
 * - Never retry a request the source rejected (4xx except 408) or a body that was too large.
 * - Retry delays are abort-aware.
 *
 * Ported from erenmyeager15/india-government-tenders-scraper `src/http.ts` (Apache-2.0, see NOTICE).
 * Adaptations: Fetch API only (no undici), `Uint8Array` instead of Node `Buffer` (runs on Workers),
 * `readBoundedBody` split out so GemClient can reuse it, an optional `beforeAttempt` hook (cluster-wide
 * GeM lease, FR-024) and `status`/`url` on the result.
 */

/** The source answered with a non-2xx status. */
export class SourceHttpError extends Error {
  constructor(readonly status: number, url: string) {
    let where = url;
    try { const u = new URL(url); where = `${u.origin}${u.pathname}`; } catch { /* relative URL: keep as is */ }
    super(`HTTP ${status} from ${where}`);
    this.name = 'SourceHttpError';
  }
}

/** The response body exceeded the download size limit. */
export class SourceBodyLimitError extends Error {
  constructor(readonly maxBytes?: number) {
    super('Source response exceeded the download size limit.');
    this.name = 'SourceBodyLimitError';
  }
}

/** Retry network errors, timeouts, 408 and 5xx; never 4xx denials or oversized bodies. */
export function canRetrySource(error: unknown): boolean {
  return !(error instanceof SourceBodyLimitError)
    && !(error instanceof SourceHttpError && error.status < 500 && error.status !== 408);
}

/** Sleep `ms`, rejecting with the signal's reason as soon as it aborts. */
export async function waitForSourceDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', aborted); resolve(); }
    function aborted() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal?.reason); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/**
 * Read a response body into memory, cancelling it as soon as it is known to exceed `maxBytes`
 * (advertised `content-length` first, then the running byte count). Throws `SourceBodyLimitError`.
 * When `signal` aborts mid-read the stream is cancelled and the signal's reason is thrown.
 */
export async function readBoundedBody(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new SourceBodyLimitError(maxBytes);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let removeAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', onAbort);
    })
    : null;
  aborted?.catch(() => {}); // handled through Promise.race below
  try {
    for (;;) {
      const { value, done } = aborted ? await Promise.race([reader.read(), aborted]) : await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new SourceBodyLimitError(maxBytes);
      chunks.push(value);
    }
  } catch (e) {
    // Cancellation is best effort. A broken stream must not block the caller.
    void reader.cancel().catch(() => {});
    throw e;
  } finally {
    removeAbort?.();
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export interface ResourceOptions {
  signal?: AbortSignal;
  /** One deadline for connect + body download, per attempt (default 35 s). */
  timeoutMs?: number;
  /** Total attempts including the first (default 3). */
  attempts?: number;
  /** Largest body accepted (default 4 MB). */
  maxBytes?: number;
  fetcher?: typeof fetch;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called before every attempt (incl. retries) — e.g. take a cluster-wide GeM lease slot (FR-024). */
  beforeAttempt?: () => Promise<void>;
}

export interface BoundedResource { body: Uint8Array; headers: Headers; status: number; url: string }

/** GET/POST `url` with a per-attempt deadline, a byte cap and retry only for transient failures. */
export async function fetchBoundedResource(url: string, init: RequestInit, options: ResourceOptions = {}): Promise<BoundedResource> {
  const {
    signal, timeoutMs = 35_000, attempts = 3, maxBytes = 4 * 1024 * 1024,
    fetcher = (input, reqInit) => fetch(input, reqInit), delay = waitForSourceDelay, beforeAttempt,
  } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    if (beforeAttempt) await beforeAttempt();
    const controller = new AbortController();
    const abortParent = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abortParent, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Source request exceeded its connection/body deadline.')), timeoutMs);
    let removeAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      removeAbort = () => controller.signal.removeEventListener('abort', rejectAbort);
    });
    aborted.catch(() => {});
    const consume = async (): Promise<BoundedResource> => {
      const response = await fetcher(url, { ...init, signal: controller.signal });
      if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
      controller.signal.throwIfAborted();
      if (!response.ok) {
        // Do not download an error page, retain cookies, or try to evade a denial.
        void response.body?.cancel().catch(() => {});
        throw new SourceHttpError(response.status, url);
      }
      const body = await readBoundedBody(response, maxBytes, controller.signal);
      return { body, headers: response.headers, status: response.status, url: response.url || url };
    };
    try {
      return await Promise.race([consume(), aborted]);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw signal.reason;
      if (!canRetrySource(error) || attempt === attempts) throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortParent);
      removeAbort?.();
      controller.abort();
    }
    await delay(1000 * attempt, signal);
  }
  throw lastError;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** True when `%PDF-` appears in the first 1 KB (some generators emit a BOM or whitespace first). */
export function isPdfBody(bytes: Uint8Array): boolean {
  if (bytes.byteLength <= 5) return false;
  const end = Math.min(bytes.byteLength, 1024) - PDF_MAGIC.length;
  for (let i = 0; i <= end; i++) {
    let ok = true;
    for (let j = 0; j < PDF_MAGIC.length; j++) if (bytes[i + j] !== PDF_MAGIC[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}
