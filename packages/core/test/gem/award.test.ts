/** parseBidResult — port of gem-search get_bid_result() (T032; 007/FR-030, NFR-009). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bidResultPath, parseAwardResult, parseBidResult, MAX_RESULT_HTML } from '../../src/gem/award';
import { GemClient, GemError, readTextCapped } from '../../src/gem/client';

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

  it('never lets a row without a price borrow the next row\'s price or level', () => {
    const r = parseBidResult(`<table>
      <tr><td class="productDtl">1</td><td><span>No Price Traders</span></td><td>withdrawn</td><td><strong>-</strong></td></tr>
      <tr><td class="productDtl">2</td><td><span>Priced Ltd</span></td><td><span class="bid_price">5000</span></td><td><strong>L1</strong></td></tr>
    </table>`);
    expect(r.bidders).toEqual([{ rank: 2, company: 'Priced Ltd', price: 5000, level: 'L1' }]);
    expect(r.l1Price).toBe(5000);
  });

  it('handles a 10k-row page without prices quickly, and caps very large input', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => `<tr><td class="productDtl">${i + 1}</td><td><span>Seller ${i}</span></td><td>—</td></tr>`).join('');
    const t0 = performance.now();
    expect(parseBidResult(`<table>${rows}</table>`).bidders).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(500);
    const huge = `${'x'.repeat(600 * 1024)}${html}`; // the real rows sit beyond the 512 KB cap
    expect(parseBidResult(huge).bidders).toEqual([]);
  });

  it('has no catastrophic backtracking: crafted rows finish in < 100 ms', () => {
    const many = (n: number, cell: string) => Array.from({ length: n }, () => cell).join('');
    // The reviewer's case: one ~500 KB row, 10 productDtl cells, 15,000 price spans and no level cell.
    const crafted = `<table><tr>${many(10, '<td class="productDtl">1</td><td><span>X</span></td>')}${many(15_000, '<span class="bid_price">1</span>')}</tr></table>`;
    // The same shape kept under the 16 KB row limit, so the stepwise matcher itself is exercised.
    const small = `<table><tr>${many(10, '<td class="productDtl">1</td><td><span>X</span></td>')}${many(400, '<span class="bid_price">1</span>')}</tr></table>`;
    // A single 512 KB row of repeated productDtl cells (and an under-limit variant).
    const dtl = '<td class="productDtl">1</td>   <td><span class="s">   ';
    const repeated = `<table><tr>${many(Math.ceil((512 * 1024) / dtl.length), dtl)}</tr></table>`;
    const repeatedSmall = `<table><tr>${many(Math.floor(15_000 / dtl.length), dtl)}</tr></table>`;
    for (const page of [crafted, small, repeated, repeatedSmall]) {
      const t0 = performance.now();
      expect(parseBidResult(page).bidders).toEqual([]);
      expect(performance.now() - t0).toBeLessThan(100);
    }
  });

  it('skips a row whose level cell does not follow the price', () => {
    const r = parseBidResult('<tr><td class="productDtl">1</td><td><span>A</span></td><td><span class="bid_price">10</span></td><td>pending</td></tr>');
    expect(r.bidders).toEqual([]);
  });

  it('decodes only valid code points; out-of-range and surrogate entities stay raw', () => {
    const row = (name: string) => `<tr><td class="productDtl">1</td><td><span>${name}</span></td><td><span class="bid_price">1</span></td><td><strong>L1</strong></td></tr>`;
    expect(parseBidResult(row('A &#x41; &#66; &amp; Co')).bidders[0]!.company).toBe('A A B & Co');
    expect(parseBidResult(row('Bad &#x110000; &#xD800; &#55296; &#99999999999;')).bidders[0]!.company).toBe('Bad &#x110000; &#xD800; &#55296; &#99999999999;');
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

describe('readTextCapped (result page body cap)', () => {
  it('refuses a declared content-length above the cap', async () => {
    const res = new Response('x'.repeat(10), { headers: { 'content-length': String(2 * 1024 * 1024) } });
    const err = await readTextCapped(res, 1024 * 1024).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GemError);
    expect((err as GemError).retryable).toBe(false);
  });

  it('stops reading an undeclared stream after N bytes', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) { pulled++; ctrl.enqueue(new TextEncoder().encode('a'.repeat(1000))); }, // endless
    });
    const text = await readTextCapped(new Response(stream), 4500);
    expect(text).toHaveLength(4500);
    expect(pulled).toBeLessThan(10);
  });

  it('returns small bodies whole', async () => {
    expect(await readTextCapped(new Response('<html>ok</html>'), 1024)).toBe('<html>ok</html>');
  });
});

describe('parseAwardResult (T092; 006/FR-085) — evaluation table reader', () => {
  const ra = readFileSync(join(__dirname, '../fixtures/gem/ra-result.html'), 'utf8');

  it('reads the rank/price table: L1 price and seller, every bidder, Indian digit grouping, portal tags stripped', () => {
    expect(parseAwardResult(ra)).toEqual({
      l1Price: 2_840_500,
      l1Seller: 'Kaveri Systems & Services Pvt Ltd',
      bidders: [
        { rank: 1, name: 'Kaveri Systems & Services Pvt Ltd', price: 2_840_500 },
        { rank: 2, name: 'Aarav Infotech Pvt Ltd', price: 2_950_000 },
        { rank: 3, name: 'Dhruv Traders', price: 3_125_000 },
      ],
    });
  });

  it('ignores the technical-evaluation and RA-details tables', () => {
    expect(parseAwardResult(ra)!.bidders.map((b) => b.name)).not.toContain('Northline Computers');
  });

  it('picks the trophy/winner row, else rank 1, else the first row', () => {
    const t = (rows: string) => `<table><tr><th>Rank</th><th>Seller</th><th>Price</th></tr>${rows}</table>`;
    expect(parseAwardResult(t('<tr><td>2</td><td>Beta Co</td><td>200</td></tr><tr><td>1</td><td>Alpha Co</td><td>100</td></tr>'))).toMatchObject({ l1Seller: 'Alpha Co', l1Price: 100 });
    expect(parseAwardResult(t('<tr><td>1</td><td>Alpha Co</td><td>100</td></tr><tr><td>2</td><td class="winner">Beta Co</td><td>200</td></tr>'))).toMatchObject({ l1Seller: 'Beta Co', l1Price: 200 });
    expect(parseAwardResult(t('<tr><td>Gamma Co</td><td>Rs. 1,50,000</td></tr>'))).toMatchObject({ l1Seller: 'Gamma Co', l1Price: 150_000, bidders: [{ rank: 0, name: 'Gamma Co', price: 150_000 }] });
  });

  it('a row whose only number is the rank has no price (rank is never taken as the price)', () => {
    expect(parseAwardResult('<table><tr><th>Rank</th><th>Name</th></tr><tr><td>L1</td><td>Alpha Co</td></tr></table>')).toBeNull();
  });

  it('maps columns from the header words (S.No | Seller | Price | Rank), not by position', () => {
    const r = parseAwardResult('<table><tr><th>S.No</th><th>Seller</th><th>Price</th><th>Rank</th></tr><tr><td>1</td><td>B Co</td><td>200</td><td>2</td></tr><tr><td>2</td><td>A Co</td><td>100</td><td>1</td></tr></table>');
    expect(r).toMatchObject({ l1Price: 100, l1Seller: 'A Co' });
    expect(r!.bidders).toEqual([{ rank: 2, name: 'B Co', price: 200 }, { rank: 1, name: 'A Co', price: 100 }]);
  });

  it('rejects absurd amounts and strips Rs only as a prefix or suffix', () => {
    const t = (price: string) => parseAwardResult(`<table><tr><th>Name</th><th>Price</th></tr><tr><td>Alpha Co</td><td>${price}</td></tr></table>`);
    expect(t('99999999999999')).toBeNull();
    expect(t('1e5')).toBeNull();
    expect(t('Rs. 1,50,000')).toMatchObject({ l1Price: 150_000 });
    expect(t('150000 INR')).toMatchObject({ l1Price: 150_000 });
    expect(t('15Rs0')).toBeNull();
  });

  it.each([['td', 'th'], ['th', 'td']] as const)('is linear on a hostile 512 KB header row of <%s> cells (second row <%s>)', (a, b) => {
    const tail = `</tr><tr><${b}>A Co</${b}><${b}>5</${b}></tr></table>`;
    const N = MAX_RESULT_HTML;
    for (const filler of [`<${a}>x</${a}>`.repeat((N - 100) / 10), `<${a}>`.repeat((N - 100) / 4)]) {
      const input = `<table><tr><${b}>Price</${b}>` + filler + tail;
      const t0 = performance.now();
      parseAwardResult(input);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });

  it('returns null when there is no price table (other tables, plain text, empty input)', () => {
    expect(parseAwardResult('')).toBeNull();
    expect(parseAwardResult('<p>Rank 1: Alpha 100</p>')).toBeNull();
    expect(parseAwardResult('<table><tr><th>Name</th><th>City</th></tr><tr><td>Alpha Co</td><td>Pune</td></tr></table>')).toBeNull();
  });

  it('skips rows without a seller name or a positive price', () => {
    const r = parseAwardResult('<table><tr><th>Rank</th><th>Seller</th><th>Price</th></tr><tr><td>1</td><td>Alpha Co</td><td>0</td></tr><tr><td>2</td><td>Beta Co</td><td>abc</td></tr><tr><td>3</td><td>Delta Co</td><td>5,000</td></tr></table>');
    expect(r?.bidders).toEqual([{ rank: 3, name: 'Delta Co', price: 5000 }]);
  });

  it('stays linear on hostile markup (unclosed cells, huge input)', () => {
    const t0 = Date.now();
    expect(parseAwardResult('<table><tr><th>Price</th>' + '<td'.repeat(50_000))).toBeNull();
    expect(parseAwardResult('<table><tr><th>Price</th></tr>' + '<tr><td>1</td><td>A'.repeat(MAX_RESULT_HTML / 16))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
