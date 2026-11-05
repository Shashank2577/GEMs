import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractCsrfToken, GemClient, GemError, MAX_RESULT_BYTES } from '../../src/gem/client';

const FIX = join(__dirname, '../fixtures/gem');
const page = (n: number) => readFileSync(join(FIX, `page-${n}.json`), 'utf8');
const TOKEN = '0123456789abcdef0123456789abcdef';

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

/** Scriptable fake BidPlus. */
function fakeGem(handler?: (c: Call, n: number) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = { url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body as string | undefined };
    calls.push(c);
    const custom = await handler?.(c, calls.length);
    if (custom) return custom;
    if (c.url.endsWith('/all-bids')) {
      return new Response(`<html><script>var data = {'csrf_bd_gem_nk':'${TOKEN}'};</script></html>`, {
        headers: { 'content-type': 'text/html', 'set-cookie': `csrf_gem_cookie=${TOKEN}; Path=/; HttpOnly` },
      });
    }
    if (c.url.endsWith('/all-bids-data')) {
      const form = new URLSearchParams(c.body);
      if (form.get('csrf_bd_gem_nk') !== TOKEN) return new Response('forbidden', { status: 403 });
      const payload = JSON.parse(form.get('payload')!);
      return new Response(page(payload.page), { headers: { 'content-type': 'application/json' } });
    }
    if (c.url.includes('/showbidDocument/')) return new Response(new TextEncoder().encode('%PDF-1.7 fake'), { headers: { 'content-type': 'application/pdf' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

function fakeTime() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, advance: (ms: number) => { t += ms; } };
}

describe('GemClient', () => {
  it('bootstraps CSRF from the cookie, posts a form-encoded payload and parses the page', async () => {
    const { f, calls } = fakeGem();
    const time = fakeTime();
    const gem = new GemClient(f, { baseUrl: 'http://gem.test/', minIntervalMs: 0, sleep: time.sleep, now: time.now });
    const { tenders, numFound, rawCount } = await gem.fetchTenders({ page: 2, search: 'laptop', now: new Date('2026-11-04T00:00:00Z') });
    expect(numFound).toBe(36);
    expect(rawCount).toBe(10);
    expect(tenders).toHaveLength(10);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET http://gem.test/all-bids', 'POST http://gem.test/all-bids-data']);
    const post = calls[1];
    expect(post.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(post.headers.cookie).toBe(`csrf_gem_cookie=${TOKEN}`);
    expect(post.headers['user-agent']).toMatch(/TenderPilot/);
    const payload = JSON.parse(new URLSearchParams(post.body).get('payload')!);
    expect(payload).toMatchObject({ page: 2, param: { searchBid: 'laptop', searchType: 'fullText' }, filter: { bidStatusType: 'ongoing_bids' } });
    expect(tenders[0].sourceUrl.startsWith('http://gem.test/')).toBe(true);
  });

  it('reuses the session across pages', async () => {
    const { f, calls } = fakeGem();
    const time = fakeTime();
    const gem = new GemClient(f, { minIntervalMs: 0, sleep: time.sleep, now: time.now });
    await gem.fetchPage({ page: 1 });
    await gem.fetchPage({ page: 2 });
    expect(calls.filter((c) => c.url.endsWith('/all-bids'))).toHaveLength(1);
    expect(gem.requests).toBe(3);
  });

  it('throttles to ≤ 1 request per minIntervalMs', async () => {
    const { f } = fakeGem();
    const time = fakeTime();
    const gem = new GemClient(f, { minIntervalMs: 1000, sleep: time.sleep, now: time.now });
    await Promise.all([gem.fetchPage({ page: 1 }), gem.fetchPage({ page: 2 }), gem.fetchPage({ page: 3 })]);
    // 1 bootstrap + 3 listing requests → 3 waits of 1000 ms
    expect(time.sleeps).toEqual([1000, 1000, 1000]);
  });

  it('retries 5xx with exponential back-off', async () => {
    let failures = 2;
    const { f, calls } = fakeGem((c) => {
      if (c.url.endsWith('/all-bids-data') && failures-- > 0) return new Response('busy', { status: 503 });
      return undefined;
    });
    const time = fakeTime();
    const gem = new GemClient(f, { minIntervalMs: 0, backoffMs: 500, sleep: time.sleep, now: time.now });
    const p = await gem.fetchPage({ page: 1 });
    expect(p.docs).toHaveLength(10);
    expect(time.sleeps).toEqual([500, 1000]);
    expect(calls.filter((c) => c.url.endsWith('/all-bids-data'))).toHaveLength(3);
  });

  it('honours Retry-After on 429', async () => {
    let once = true;
    const { f } = fakeGem((c) => {
      if (c.url.endsWith('/all-bids-data') && once) { once = false; return new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }); }
      return undefined;
    });
    const time = fakeTime();
    const gem = new GemClient(f, { minIntervalMs: 0, sleep: time.sleep, now: time.now });
    await gem.fetchPage();
    expect(time.sleeps).toEqual([7000]);
  });

  it('gives up after maxRetries on network errors', async () => {
    const f = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const time = fakeTime();
    const gem = new GemClient(f, { minIntervalMs: 0, maxRetries: 2, backoffMs: 100, sleep: time.sleep, now: time.now });
    await expect(gem.fetchPage()).rejects.toThrow(/unreachable/);
    expect(time.sleeps).toEqual([100, 200]);
  });

  it('re-bootstraps once on 403 (expired CSRF)', async () => {
    let n = 0;
    const { f, calls } = fakeGem((c) => {
      if (c.url.endsWith('/all-bids-data') && n++ === 0) return new Response('expired', { status: 403 });
      return undefined;
    });
    const time = fakeTime();
    const gem = new GemClient(f, { minIntervalMs: 0, sleep: time.sleep, now: time.now });
    await gem.fetchPage();
    expect(calls.filter((c) => c.url.endsWith('/all-bids'))).toHaveLength(2);
  });

  it('fails clearly when GeM returns HTML or no token', async () => {
    const time = fakeTime();
    const html = fakeGem((c) => (c.url.endsWith('/all-bids-data') ? new Response('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } }) : undefined));
    await expect(new GemClient(html.f, { minIntervalMs: 0, sleep: time.sleep, now: time.now }).fetchPage()).rejects.toThrow(/HTML/);
    const noToken = fakeGem((c) => (c.url.endsWith('/all-bids') ? new Response('<html></html>') : undefined));
    await expect(new GemClient(noToken.f, { minIntervalMs: 0, sleep: time.sleep, now: time.now }).fetchPage()).rejects.toBeInstanceOf(GemError);
  });

  it('downloads bid documents and validates PDF magic', async () => {
    const { f } = fakeGem();
    const time = fakeTime();
    const gem = new GemClient(f, { baseUrl: 'http://gem.test', minIntervalMs: 0, sleep: time.sleep, now: time.now });
    const doc = await gem.fetchBidDocument('7421001');
    expect(doc.url).toBe('http://gem.test/showbidDocument/7421001');
    expect(new TextDecoder().decode(doc.bytes.slice(0, 5))).toBe('%PDF-');
    const bad = fakeGem((c) => (c.url.includes('showbid') ? new Response('<html>login</html>') : undefined));
    await expect(new GemClient(bad.f, { minIntervalMs: 0, sleep: time.sleep, now: time.now }).fetchBidDocument('1')).rejects.toThrow(/PDF/);
  });
});

describe('GemClient submitted bids and results (spec 003 US6, FR-060)', () => {
  const RES = join(FIX, 'results');
  const mk = (handler: Parameters<typeof fakeGem>[0]) => {
    const { f, calls } = fakeGem(handler);
    const time = fakeTime();
    return { gem: new GemClient(f, { baseUrl: 'http://gem.test', minIntervalMs: 0, sleep: time.sleep, now: time.now }), calls };
  };
  const payloadOf = (c: Call) => JSON.parse(new URLSearchParams(c.body).get('payload')!);

  it('fetchSubmittedPage posts bidStatusType bidrastatus with filter.byStatus and parses the awarded page', async () => {
    const { gem, calls } = mk((c) => (c.url.endsWith('/all-bids-data') ? new Response(readFileSync(join(RES, 'bidrastatus-awarded.json'), 'utf8')) : undefined));
    const p = await gem.fetchSubmittedPage({ search: 'GEM/2026/B/6812345', byStatus: 'bid_awarded', page: 2 });
    expect(p.numFound).toBe(2);
    expect(p.docs[0]).toMatchObject({ b_buyer_status: [3] });
    expect(payloadOf(calls[1])).toMatchObject({
      page: 2,
      param: { searchBid: 'GEM/2026/B/6812345' },
      filter: { bidStatusType: 'bidrastatus', byStatus: 'bid_awarded' },
    });
  });

  it('omits byStatus when not given and handles the tech-evaluated page', async () => {
    const { gem, calls } = mk((c) => (c.url.endsWith('/all-bids-data') ? new Response(readFileSync(join(RES, 'bidrastatus-tech-evaluated.json'), 'utf8')) : undefined));
    const p = await gem.fetchSubmittedPage();
    expect(p.docs[0]).toMatchObject({ b_buyer_status: [1] });
    const filter = payloadOf(calls[1]).filter;
    expect(filter.bidStatusType).toBe('bidrastatus');
    expect('byStatus' in filter).toBe(false);
    expect(payloadOf(calls[1]).page).toBe(1);
  });

  it('fetchBidResult GETs /bidding/bid/getBidResultView/<id>; 404 -> null; 5xx -> GemError', async () => {
    const html = readFileSync(join(RES, 'bid-result-awarded.html'), 'utf8');
    const { gem, calls } = mk((c) => (c.url.includes('getBidResultView/8100037') ? new Response(html) : undefined));
    const r = await gem.fetchBidResult('8100037');
    expect(r?.url).toBe('http://gem.test/bidding/bid/getBidResultView/8100037');
    expect(r?.html).toBe(html);
    expect(r?.truncated).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(await gem.fetchBidResult('1')).toBeNull();
    const down = mk((c) => (c.url.includes('getBidResultView') ? new Response('down', { status: 503 }) : undefined));
    await expect(down.gem.fetchBidResult('2')).rejects.toBeInstanceOf(GemError);
  });

  it('fetchBidResult flags a body cut off at MAX_RESULT_BYTES as truncated; a declared oversize is a too_large GemError', async () => {
    const endless = () => new Response(new ReadableStream<Uint8Array>({ pull(ctrl) { ctrl.enqueue(new TextEncoder().encode('<tr>'.repeat(4096))); } }));
    const { gem } = mk((c) => (c.url.includes('getBidResultView') ? endless() : undefined));
    const r = await gem.fetchBidResult('8100037');
    expect(r?.truncated).toBe(true);
    expect(r?.html).toHaveLength(MAX_RESULT_BYTES);
    const declared = mk((c) => (c.url.includes('getBidResultView') ? new Response('x', { headers: { 'content-length': String(MAX_RESULT_BYTES + 1) } }) : undefined));
    const err = await declared.gem.fetchBidResult('1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GemError);
    expect((err as GemError).code).toBe('too_large');
  });

  it('spaces submitted-page and result requests by minIntervalMs (<= 1 req/s)', async () => {
    const { f } = fakeGem((c) => (c.url.endsWith('/all-bids-data') ? new Response(readFileSync(join(RES, 'bidrastatus-awarded.json'), 'utf8')) : undefined));
    const time = fakeTime();
    const gem = new GemClient(f, { baseUrl: 'http://gem.test', sleep: time.sleep, now: time.now });
    await gem.fetchSubmittedPage({ byStatus: 'bid_awarded' });
    await gem.fetchBidResult('8100037');
    expect(time.sleeps.length).toBeGreaterThanOrEqual(2);
    expect(time.sleeps.every((ms) => ms <= 1000)).toBe(true);
  });
});

describe('extractCsrfToken', () => {
  it.each([
    [`<script>{'csrf_bd_gem_nk':'${TOKEN}'}</script>`],
    [`<input type="hidden" name="csrf_bd_gem_nk" value="${TOKEN}">`],
    [`<input value="${TOKEN}" name="csrf_bd_gem_nk">`],
    [`csrf_bd_gem_nk=${TOKEN}&x=1`],
  ])('finds the token in %s', (html) => {
    expect(extractCsrfToken(html)).toBe(TOKEN);
  });
  it('returns null when absent', () => expect(extractCsrfToken('<html/>')).toBeNull());

  describe('byte-capped bid document download (FR-008)', () => {
    const pdfStream = (chunks: number, chunkBytes: number, onCancel: () => void, onPull?: () => void) => {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(c) {
          onPull?.();
          if (sent >= chunks) return c.close();
          const chunk = new Uint8Array(chunkBytes).fill(0x20);
          if (sent === 0) chunk.set(new TextEncoder().encode('%PDF-1.7'));
          sent++;
          c.enqueue(chunk);
        },
        cancel() { onCancel(); },
      });
    };

    for (const advertised of [true, false]) {
      it(`aborts above the cap with GemError code too_large, without retrying (content-length ${advertised ? 'advertised' : 'absent'})`, async () => {
        let canceled = false;
        let pulls = 0;
        const { f, calls } = fakeGem((c) => (c.url.includes('showbid')
          ? new Response(pdfStream(10, 400, () => { canceled = true; }, () => { pulls++; }), { headers: advertised ? { 'content-type': 'application/pdf', 'content-length': '4000' } : { 'content-type': 'application/pdf' } })
          : undefined));
        const time = fakeTime();
        const gem = new GemClient(f, { baseUrl: 'http://gem.test', minIntervalMs: 0, sleep: time.sleep, now: time.now, maxDocumentBytes: 1000 });
        const err = await gem.fetchBidDocument('7421001').catch((e) => e);
        expect(err).toBeInstanceOf(GemError);
        expect(err).toMatchObject({ code: 'too_large', retryable: false });
        expect(calls.filter((c) => c.url.includes('showbid'))).toHaveLength(1);
        expect(canceled).toBe(true);
        expect(pulls).toBeLessThan(10); // stopped streaming early
      });
    }

    it('accepts a document exactly at the cap and reassembles the chunks', async () => {
      const { f } = fakeGem((c) => (c.url.includes('showbid') ? new Response(pdfStream(4, 250, () => {})) : undefined));
      const time = fakeTime();
      const gem = new GemClient(f, { baseUrl: 'http://gem.test', minIntervalMs: 0, sleep: time.sleep, now: time.now, maxDocumentBytes: 1000 });
      const doc = await gem.fetchBidDocument('7421001');
      expect(doc.bytes.byteLength).toBe(1000);
      expect(new TextDecoder().decode(doc.bytes.slice(0, 8))).toBe('%PDF-1.7');
    });

    it('keeps the request deadline through the body read and cancels a trickling body (FR-005)', async () => {
      let canceled = false;
      const neverCloses = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode('%PDF-1.7')); }, // first chunk, then silence
        cancel() { canceled = true; },
      });
      const { f } = fakeGem((c) => (c.url.includes('showbid') ? new Response(neverCloses, { headers: { 'content-type': 'application/pdf' } }) : undefined));
      const time = fakeTime();
      const gem = new GemClient(f, { baseUrl: 'http://gem.test', minIntervalMs: 0, sleep: time.sleep, now: time.now, timeoutMs: 50 });
      const err = await gem.fetchBidDocument('7421001').catch((e) => e);
      expect(err).toBeInstanceOf(GemError);
      expect(err).toMatchObject({ code: 'timeout', retryable: true });
      expect(err.message).toMatch(/timed out/);
      expect(canceled).toBe(true);
    });

    it('defaults to a 25 MB cap', async () => {
      const { f } = fakeGem((c) => (c.url.includes('showbid')
        ? new Response('%PDF-1.7', { headers: { 'content-length': String(25 * 1024 * 1024 + 1) } })
        : undefined));
      const time = fakeTime();
      const gem = new GemClient(f, { baseUrl: 'http://gem.test', minIntervalMs: 0, sleep: time.sleep, now: time.now });
      await expect(gem.fetchBidDocument('1')).rejects.toMatchObject({ code: 'too_large' });
    });
  });
});
