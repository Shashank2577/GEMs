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
 * arush15june/gem-search (MIT) — see NOTICE. fetchSubmittedPage / fetchBidResult (spec 003 US6) are adapted from
 * gem-search `search_bids` (bidStatusType "bidrastatus" + filter.byStatus) and `get_bid_result`.
 */
import { bidResultPath } from './award';
import { isPdfBody, readBoundedBody, SourceBodyLimitError } from './http';
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
  /**
   * Called before every HTTP attempt, retries included (008/FR-024): the API passes the cluster-wide GeM lease
   * (`lib/gem-lease.ts`) so all isolates together stay ≤ 1 request/s. A rejection aborts the request unsent.
   */
  beforeRequest?: () => Promise<void>;
}

export interface FetchPageOptions {
  page?: number;
  /** Free-text search (GeM `searchBid`, fullText). */
  search?: string;
  /** 'ongoing' (default) or 'closed' bids. */
  status?: 'ongoing' | 'closed';
  sort?: 'Bid-End-Date-Latest' | 'Bid-End-Date-Oldest' | 'Bid-Start-Date-Latest';
}

/** GeM `filter.byStatus` values for submitted (closed) bids: awarded / technically evaluated / financially evaluated. */
export type SubmittedBidStatus = 'bid_awarded' | 'tech_evaluated' | 'fin_evaluated';

export interface FetchSubmittedPageOptions {
  page?: number;
  /** Free-text search (bid number or keywords). */
  search?: string;
  /** Restrict to one evaluation stage; omitted = every submitted bid. */
  byStatus?: SubmittedBidStatus;
}

/** Machine-readable GemError causes callers branch on (status covers plain HTTP failures). */
export type GemErrorCode = 'too_large' | 'timeout';

export class GemError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false, readonly code?: GemErrorCode) {
    super(message);
    this.name = 'GemError';
  }
}

/** Upper bound on a bid-result page body; anything beyond is not read (007/T033). */
export const MAX_RESULT_BYTES = 1024 * 1024;

/**
 * Response text, reading at most `maxBytes`: a declared content-length above the cap is refused, an undeclared
 * oversized body is cut off (the stream is cancelled) and the prefix returned.
 */
export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  return (await readTextCappedInfo(res, maxBytes)).text;
}

/**
 * readTextCapped that also says whether the cap was hit (`truncated`), so a caller that must not treat a cut-off
 * page as complete (the results refresh, 003/US6) can refuse it. Reaching exactly `maxBytes` counts as truncated.
 */
export async function readTextCappedInfo(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    // Not retryable: the same page will be just as large next time.
    throw new GemError(`GeM response too large (${declared} bytes)`, res.status, false, 'too_large');
  }
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.length >= room) {
      chunks.push(value.subarray(0, room));
      total += room;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return { text: new TextDecoder().decode(buf), truncated };
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
  /** When the attempt that produced each response started, so body reads share its deadline. */
  private readonly attemptStartedAt = new WeakMap<Response, number>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxDocumentBytes: number;
  private readonly beforeRequest?: () => Promise<void>;
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
    this.beforeRequest = opts.beforeRequest;
  }

  // ───────────── public API ─────────────

  /** Fetch one listing page (raw docs + paging info). */
  async fetchPage(opts: FetchPageOptions = {}): Promise<BidPlusPage> {
    return this.postListing({
      page: opts.page ?? 1,
      param: { searchBid: opts.search ?? '', searchType: 'fullText' },
      filter: {
        bidStatusType: opts.status === 'closed' ? 'bidrastatus' : 'ongoing_bids',
        byType: 'all',
        highBidValue: '',
        byEndDate: { from: '', to: '' },
        sort: opts.sort ?? 'Bid-Start-Date-Latest',
      },
    });
  }

  /**
   * Search submitted (closed) bids by evaluation stage: `bidStatusType: "bidrastatus"` plus `filter.byStatus`
   * (`bid_awarded` | `tech_evaluated` | `fin_evaluated`). Read-only; same throttle, retry and CSRF handling as
   * fetchPage. Adapted from gem-search `search_bids` (MIT) — see NOTICE.
   */
  async fetchSubmittedPage(opts: FetchSubmittedPageOptions = {}): Promise<BidPlusPage> {
    return this.postListing({
      page: opts.page ?? 1,
      param: { searchBid: opts.search ?? '', searchType: 'fullText' },
      filter: {
        bidStatusType: 'bidrastatus',
        byType: 'all',
        highBidValue: '',
        byEndDate: { from: '', to: '' },
        sort: 'Bid-End-Date-Latest',
        ...(opts.byStatus ? { byStatus: opts.byStatus } : {}),
      },
    });
  }

  /**
   * Public bid-result view for a BidPlus `b_id` (`/bidding/bid/getBidResultView/<id>`), adapted from gem-search
   * `get_bid_result` (MIT). Returns the raw HTML for `parseBidResultHtml`; 404 → `null`. `truncated` is true when
   * the body hit MAX_RESULT_BYTES and was cut off — such a page must not be stored as complete.
   */
  fetchBidResult(gemBidId: string): Promise<{ html: string; url: string; truncated: boolean } | null> {
    return this.getBidResult(gemBidId);
  }

  private async postListing(payload: object): Promise<BidPlusPage> {
    await this.ensureSession();
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

  /** Fetch and normalise one listing page. Docs without a bid number are dropped (> 50 % missing already failed as format drift in parseBidPlusResponse). */
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
    // The request timer stops once headers arrive; keep the same deadline running through the body
    // read so a slowly trickling body cannot outlive the timeout (FR-005).
    const started = this.attemptStartedAt.get(res) ?? Date.now();
    const bytes = await readCapped(res, this.maxDocumentBytes, started + this.timeout);
    const contentType = res.headers.get('content-type') ?? 'application/pdf';
    if (!isPdfBody(bytes)) {
      throw new GemError('GeM did not return a PDF for this bid document', res.status);
    }
    return { bytes, contentType, url: path.startsWith('http') ? path : `${this.baseUrl}${path}` };
  }

  /**
   * Fetch the public bid-result (award) page HTML for a BidPlus `b_id` (007/T033). Read-only, same throttle and
   * back-off as every other request. 404 → `null` (no result published).
   */
  async fetchBidResultHtml(gemBidId: string): Promise<{ html: string; url: string } | null> {
    const r = await this.getBidResult(gemBidId);
    return r && { html: r.html, url: r.url };
  }

  private async getBidResult(gemBidId: string): Promise<{ html: string; url: string; truncated: boolean } | null> {
    const path = bidResultPath(gemBidId);
    const res = await this.request(path, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', referer: `${this.baseUrl}/all-bids`, 'x-requested-with': 'XMLHttpRequest' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new GemError(`GeM bid result failed: HTTP ${res.status}`, res.status, res.status >= 500);
    const { text, truncated } = await readTextCappedInfo(res, MAX_RESULT_BYTES);
    return { html: text, url: `${this.baseUrl}${path}`, truncated };
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
        // Cluster-wide slot (FR-024): taken per attempt, so a retry waits for its own slot too.
        if (this.beforeRequest) await this.beforeRequest();
        this.lastRequestAt = this.now();
        this.requests++;
        let res: Response | null = null;
        let err: unknown = null;
        const attemptStartedAt = Date.now();
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
          this.attemptStartedAt.set(res, attemptStartedAt);
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

/**
 * Read a response body with the ported bounded reader (`gem/http.ts#readBoundedBody`): cancel as soon as it is
 * known to exceed `maxBytes`, and stop a body that is still trickling in at `deadline`.
 */
async function readCapped(res: Response, maxBytes: number, deadline = Infinity): Promise<Uint8Array> {
  const ctrl = Number.isFinite(deadline) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(new Error('deadline')), Math.max(0, deadline - Date.now())) : undefined;
  try {
    return await readBoundedBody(res, maxBytes, ctrl?.signal);
  } catch (e) {
    if (e instanceof SourceBodyLimitError) throw new GemError(`GeM document is larger than ${maxBytes} bytes`, res.status, false, 'too_large');
    if (ctrl?.signal.aborted) throw new GemError('GeM unreachable: document download timed out', res.status, true, 'timeout');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
