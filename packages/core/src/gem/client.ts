/**
 * GemClient — polite, public-only BidPlus client (FR-001, NFR-002, Constitution II).
 *
 *   const gem = new GemClient(fetch, { baseUrl: 'https://bidplus.gem.gov.in' });
 *   const page = await gem.fetchPage({ page: 1, search: 'laptop' });
 *   const pdf = await gem.fetchBidDocument('7654321');
 *
 * Protocol (public all-bids page): GET /all-bids sets the `csrf_gem_cookie` session cookie (the
 * token also appears in the page as `csrf_bd_gem_nk`), then POST /all-bids-data form-encoded
 * `payload=<json>&csrf_bd_gem_nk=<token>`. Requests are serialised and spaced ≥ minIntervalMs apart,
 * retried with exponential back-off on network errors / 429 / 5xx, and identify themselves honestly.
 * The session is re-bootstrapped once on 403/419 (expired CSRF).
 *
 * Request shape adapted from erenmyeager15/india-government-tenders-scraper (Apache-2.0) and
 * arush15june/gem-search (MIT) — see NOTICE.
 */
import { parseBidPlusDoc, parseBidPlusResponse, type BidPlusPage, type NormalizedTender } from './parse';

export interface GemClientOptions {
  baseUrl?: string;
  userAgent?: string;
  /** Minimum delay between two requests (default 1000 ms → ≤ 1 req/s). */
  minIntervalMs?: number;
  /** Retries after the first attempt (default 3). */
  maxRetries?: number;
  /** First back-off delay; doubles each retry (default 1000 ms). */
  backoffMs?: number;
  /** Per-request timeout (default 30 s). */
  timeoutMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Largest bid document accepted by fetchBidDocument (default 25 MB, FR-008). */
  maxDocumentBytes?: number;
}

export interface FetchPageOptions {
  page?: number;
  /** Free-text search (GeM `searchBid`, fullText). */
  search?: string;
  /** 'ongoing' (default) or 'closed' bids. */
  status?: 'ongoing' | 'closed';
  sort?: 'Bid-End-Date-Latest' | 'Bid-End-Date-Oldest' | 'Bid-Start-Date-Latest';
}

/** Machine-readable GemError causes callers branch on (status covers plain HTTP failures). */
export type GemErrorCode = 'too_large';

export class GemError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false, readonly code?: GemErrorCode) {
    super(message);
    this.name = 'GemError';
  }
}

/** Default cap for a downloaded bid document — same as the upload limit (FR-008). */
export const MAX_GEM_DOCUMENT_BYTES = 25 * 1024 * 1024;

export const DEFAULT_USER_AGENT = 'TenderPilot/0.1 (+https://tenderpilot.in/bot; public BidPlus listings only)';

export class GemClient {
  readonly baseUrl: string;
  private readonly ua: string;
  private readonly minInterval: number;
  private readonly maxRetries: number;
  private readonly backoff: number;
  private readonly timeout: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxDocumentBytes: number;
  private csrf: string | null = null;
  private session: Promise<void> | null = null;
  private cookies = new Map<string, string>();
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** Number of HTTP requests made (for health metrics / tests). */
  requests = 0;

  constructor(private readonly fetchImpl: typeof fetch, opts: GemClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://bidplus.gem.gov.in').replace(/\/+$/, '');
    this.ua = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.minInterval = Math.max(0, opts.minIntervalMs ?? 1000);
    this.maxRetries = Math.max(0, opts.maxRetries ?? 3);
    this.backoff = Math.max(0, opts.backoffMs ?? 1000);
    this.timeout = opts.timeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.maxDocumentBytes = opts.maxDocumentBytes ?? MAX_GEM_DOCUMENT_BYTES;
  }

  // ───────────── public API ─────────────

  /** Fetch one listing page (raw docs + paging info). */
  async fetchPage(opts: FetchPageOptions = {}): Promise<BidPlusPage> {
    await this.ensureSession();
    const payload = {
      page: opts.page ?? 1,
      param: { searchBid: opts.search ?? '', searchType: 'fullText' },
      filter: {
        bidStatusType: opts.status === 'closed' ? 'bidrastatus' : 'ongoing_bids',
        byType: 'all',
        highBidValue: '',
        byEndDate: { from: '', to: '' },
        sort: opts.sort ?? 'Bid-Start-Date-Latest',
      },
    };
    const send = () => this.request('/all-bids-data', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        origin: this.baseUrl,
        referer: `${this.baseUrl}/all-bids`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload), csrf_bd_gem_nk: this.csrf ?? '' }).toString(),
    });
    let res = await send();
    if (res.status === 403 || res.status === 419) {
      // CSRF/session expired → bootstrap once more and retry.
      this.csrf = null;
      this.cookies.clear();
      await this.ensureSession();
      res = await send();
    }
    const text = await res.text();
    if (!res.ok && res.status !== 404) throw new GemError(`GeM listing failed: HTTP ${res.status}`, res.status, res.status >= 500);
    if (text.trim().startsWith('<')) throw new GemError('GeM returned HTML instead of JSON (portal changed or blocked)', res.status);
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new GemError('GeM returned invalid JSON', res.status); }
    return parseBidPlusResponse(json);
  }

  /** Fetch and normalise one listing page. Docs without a bid number are dropped. */
  async fetchTenders(opts: FetchPageOptions & { now?: Date } = {}): Promise<{ tenders: NormalizedTender[]; numFound: number; rawCount: number }> {
    const page = await this.fetchPage(opts);
    const tenders = page.docs.map((d) => parseBidPlusDoc(d, { baseUrl: this.baseUrl, now: opts.now })).filter((t): t is NormalizedTender => !!t);
    return { tenders, numFound: page.numFound, rawCount: page.docs.length };
  }

  /**
   * Download the public bid document PDF for a BidPlus `b_id` (or a full document URL). The body is
   * streamed with a byte cap (default 25 MB): an advertised or actual size above it cancels the
   * download and throws `GemError` with code `too_large` (not retried). Byte-capped streaming
   * adapted from erenmyeager15 `fetchBoundedResource({maxBytes})` (Apache-2.0, see NOTICE).
   */
  async fetchBidDocument(bidIdOrUrl: string): Promise<{ bytes: Uint8Array; contentType: string; url: string }> {
    const path = /^https?:\/\//.test(bidIdOrUrl) ? bidIdOrUrl : `/showbidDocument/${encodeURIComponent(bidIdOrUrl)}`;
    const res = await this.request(path, { method: 'GET', headers: { accept: 'application/pdf,*/*;q=0.8', referer: `${this.baseUrl}/all-bids` } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new GemError(`GeM document download failed: HTTP ${res.status}`, res.status);
    }
    const bytes = await readCapped(res, this.maxDocumentBytes);
    const contentType = res.headers.get('content-type') ?? 'application/pdf';
    if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') {
      throw new GemError('GeM did not return a PDF for this bid document', res.status);
    }
    return { bytes, contentType, url: path.startsWith('http') ? path : `${this.baseUrl}${path}` };
  }

  // ───────────── internals ─────────────

  /** Bootstrap the CSRF session once, even when several pages are requested concurrently. */
  private ensureSession(): Promise<void> {
    if (this.csrf) return Promise.resolve();
    if (!this.session) {
      this.session = this.bootstrap().finally(() => { this.session = null; });
    }
    return this.session;
  }

  private async bootstrap(): Promise<void> {
    const res = await this.request('/all-bids', { method: 'GET', headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' } });
    const html = await res.text();
    if (!res.ok) throw new GemError(`GeM all-bids page failed: HTTP ${res.status}`, res.status, res.status >= 500);
    const token = this.cookies.get('csrf_gem_cookie') ?? extractCsrfToken(html);
    if (!token) throw new GemError('GeM CSRF token not found on the all-bids page');
    this.csrf = token;
  }

  private storeCookies(res: Response): void {
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const list = h.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  private cookieHeader(): string | undefined {
    if (!this.cookies.size) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** Serialised + throttled request with retry/back-off. */
  private request(path: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
    const run = async (): Promise<Response> => {
      let attempt = 0;
      for (;;) {
        const wait = this.lastRequestAt + this.minInterval - this.now();
        if (wait > 0) await this.sleep(wait);
        this.lastRequestAt = this.now();
        this.requests++;
        let res: Response | null = null;
        let err: unknown = null;
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeout) : null;
        try {
          const cookie = this.cookieHeader();
          res = await this.fetchImpl(path.startsWith('http') ? path : `${this.baseUrl}${path}`, {
            method: init.method,
            headers: { 'user-agent': this.ua, 'accept-language': 'en-IN,en;q=0.9', ...(cookie ? { cookie } : {}), ...init.headers },
            body: init.body,
            signal: ctrl?.signal,
          });
          this.storeCookies(res);
        } catch (e) {
          err = e;
        } finally {
          if (timer) clearTimeout(timer);
        }
        const retryable = err !== null || (res !== null && (res.status === 429 || res.status >= 500));
        if (!retryable && res) return res;
        if (attempt >= this.maxRetries) {
          if (res) return res;
          throw new GemError(`GeM unreachable: ${err instanceof Error ? err.message : String(err)}`, undefined, true);
        }
        const retryAfter = Number(res?.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoff * 2 ** attempt;
        attempt++;
        await res?.body?.cancel().catch(() => {});
        await this.sleep(delay);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

/** Read a response body, cancelling it as soon as it is known to exceed `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () => new GemError(`GeM document is larger than ${maxBytes} bytes`, res.status, false, 'too_large');
  const advertised = Number(res.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** Find the CSRF token embedded in the all-bids HTML (several layouts seen in the wild). */
export function extractCsrfToken(html: string): string | null {
  return (
    html.match(/'csrf_bd_gem_nk'\s*:\s*'([^']+)'/)?.[1]
    ?? html.match(/name=["']csrf_bd_gem_nk["'][^>]*value=["']([^"']+)["']/i)?.[1]
    ?? html.match(/value=["']([^"']+)["'][^>]*name=["']csrf_bd_gem_nk["']/i)?.[1]
    ?? html.match(/csrf_bd_gem_nk["']?\s*[:=]\s*["']?([a-f0-9]{32})/i)?.[1]
    ?? null
  );
}
