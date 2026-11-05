/** parseBidResult — port of gem-search get_bid_result() (T032; 007/FR-030, NFR-009). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bidResultPath, parseBidResult } from '../../src/gem/award';
import { GemClient, GemError } from '../../src/gem/client';

const html = readFileSync(join(__dirname, '../fixtures/gem/bid-result.html'), 'utf8');

describe('parseBidResult', () => {
  it('extracts every bidder row with rank, company, price and level from the saved result page', () => {
    const r = parseBidResult(html);
    expect(r.bidders).toEqual([
      { rank: 1, company: 'Kaveri Systems & Services Pvt Ltd', price: 2_840_500, level: 'L1' },
      { rank: 2, company: 'Aarav Infotech Pvt Ltd', price: 2_950_000, level: 'L2' },
      { rank: 3, company: 'Northline Computers', price: 3_125_000, level: 'L3' },
    ]);
  });

  it('derives the L1 price and the categories', () => {
    const r = parseBidResult(html);
    expect(r.l1Price).toBe(2_840_500);
    expect(r.categories).toEqual(['Desktop Computers (Q2)', 'Monitor (Q2)']);
  });

  it('returns no bidders and l1Price null when the result is not published (login page, not evaluated)', () => {
    expect(parseBidResult('<html><body><h3>Bid is under technical evaluation</h3></body></html>')).toEqual({ categories: [], bidders: [], l1Price: null });
    expect(parseBidResult('')).toEqual({ categories: [], bidders: [], l1Price: null });
  });

  it('takes the lowest price when GeM lists tied L1 bidders', () => {
    const row = (n: number, name: string, price: string, level: string) =>
      `<td class="productDtl">${n}</td>\n<td><span class="x">${name}</span></td><td><span class="bid_price">${price}</span></td><td><strong>${level}</strong></td>`;
    const r = parseBidResult(`<table><tr>${row(1, 'A', '1200.50', 'L1')}</tr><tr>${row(2, 'B', '1200.00', 'L1')}</tr><tr>${row(3, 'C', '1500', 'L2')}</tr></table>`);
    expect(r.bidders.map((b) => b.level)).toEqual(['L1', 'L1', 'L2']);
    expect(r.l1Price).toBe(1200);
  });

  it('builds the public result-view path', () => {
    expect(bidResultPath('8100037')).toBe('/bidding/bid/getBidResultView/8100037');
  });
});

describe('GemClient.fetchBidResultHtml', () => {
  const client = (f: typeof fetch, sleeps: number[] = []) =>
    new GemClient(f, { baseUrl: 'http://gem.test', minIntervalMs: 0, backoffMs: 5, maxRetries: 1, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 });

  it('GETs the public result view (no session, no form post) and returns the HTML + source URL', async () => {
    const calls: { url: string; method: string; ua: string | null }[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', ua: new Headers(init?.headers).get('user-agent') });
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    const r = await client(f).fetchBidResultHtml('8100037');
    expect(r?.url).toBe('http://gem.test/bidding/bid/getBidResultView/8100037');
    expect(parseBidResult(r!.html).l1Price).toBe(2_840_500);
    expect(calls).toEqual([{ url: 'http://gem.test/bidding/bid/getBidResultView/8100037', method: 'GET', ua: expect.stringMatching(/TenderPilot/) }]);
  });

  it('404 → null; 5xx is retried with back-off, then raised as a GemError', async () => {
    expect(await client((async () => new Response('nope', { status: 404 })) as unknown as typeof fetch).fetchBidResultHtml('1')).toBeNull();
    let n = 0;
    const sleeps: number[] = [];
    const down = (async () => { n++; return new Response('down', { status: 503 }); }) as unknown as typeof fetch;
    await expect(client(down, sleeps).fetchBidResultHtml('1')).rejects.toBeInstanceOf(GemError);
    expect(n).toBe(2);
    expect(sleeps).toContain(5);
  });
});
