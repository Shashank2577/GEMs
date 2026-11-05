// parseAwardResult extra cases (006/FR-085, T092): review fixes B1, NB1-NB5 plus edge cases and hostile-input timing.
// The B1-B10 behaviour cases live in award.test.ts.
import { describe, expect, it } from 'vitest';
import { MAX_RESULT_HTML } from '../../src/gem/award';
import { parseAwardResult } from '../../src/gem/award-result';


describe('parseAwardResult — extra edge cases and hostile timing', () => {
  const t = (rows: string) => `<table><tr><th>Rank</th><th>Seller</th><th>Price</th></tr>${rows}</table>`;
  const time = (input: string) => {
    const t0 = performance.now();
    parseAwardResult(input);
    return performance.now() - t0;
  };

  it('amounts above 1e13 are rejected, 1e13 itself is accepted', () => {
    expect(parseAwardResult(t('<tr><td>1</td><td>A Co</td><td>10000000000001</td></tr>'))).toBeNull();
    expect(parseAwardResult(t('<tr><td>1</td><td>A Co</td><td>1,00,00,00,00,00,000</td></tr>'))?.l1Price).toBe(1e13);
  });

  it('Rs / INR / rupee affixes only as prefix or suffix, including entities', () => {
    const p = (price: string) => parseAwardResult(t(`<tr><td>1</td><td>A Co</td><td>${price}</td></tr>`))?.l1Price ?? null;
    expect(p('Rs 5,000')).toBe(5000);
    expect(p('rs.5000.50')).toBe(5000.5);
    expect(p('&#8377;&nbsp;5,000')).toBe(5000);
    expect(p('5000 &#x20B9;')).toBe(5000);
    expect(p('INR 5000')).toBe(5000);
    expect(p('5,0Rs00')).toBeNull();
    expect(p('-5000')).toBeNull();
    expect(p('1 2')).toBeNull();
    expect(p('')).toBeNull();
  });

  it('S.No | Seller | Price | Rank keeps document order with S.No ignored', () => {
    const r = parseAwardResult('<table><tr><th>S.No</th><th>Seller</th><th>Price</th><th>Rank</th></tr><tr><td>1</td><td>B Co</td><td>200</td><td>L2</td></tr><tr><td>2</td><td>A Co</td><td>100</td><td>l1</td></tr></table>');
    expect(r!.bidders.map((b) => b.rank)).toEqual([2, 1]);
    expect(r!.l1Seller).toBe('A Co');
  });

  it('class token match: not-winner is not a winner, winner among several tokens is', () => {
    expect(parseAwardResult(t('<tr><td>1</td><td>A Co</td><td>100</td></tr><tr class="x not-winner"><td>2</td><td>B Co</td><td>200</td></tr>'))!.l1Seller).toBe('A Co');
    expect(parseAwardResult(t('<tr><td>1</td><td>A Co</td><td>100</td></tr><tr class="x WINNER"><td>2</td><td>B Co</td><td>200</td></tr>'))!.l1Seller).toBe('B Co');
  });

  it('output is plain text without markup and survives odd entities', () => {
    const r = parseAwardResult(t('<tr><td>1</td><td><b>A</b> &lt;script&gt; &#xD800; &#99999999; Co<script>x()</script></td><td>5</td></tr>'));
    expect(r!.l1Seller).toBe('A <script> &#xD800; &#99999999; Co');
  });

  it('header row of td cells is never a data row; thead/tbody and uppercase tags work', () => {
    const r = parseAwardResult('<TABLE><THEAD><TR><TD>Rank</TD><TD>Seller</TD><TD>Price</TD></TR></THEAD><TBODY><TR><TD>1</TD><TD>A Co</TD><TD>100</TD></TR></TBODY></TABLE>');
    expect(r!.bidders).toEqual([{ rank: 1, name: 'A Co', price: 100 }]);
  });

  it('skips rows over 16 KB', () => {
    const r = parseAwardResult(t(`<tr><td>1</td><td>${'x'.repeat(17 * 1024)}</td><td>5</td></tr><tr><td>2</td><td>B Co</td><td>6</td></tr>`));
    expect(r!.bidders).toEqual([{ rank: 2, name: 'B Co', price: 6 }]);
  });

  it('input larger than 512 KB is truncated, not rejected', () => {
    const r = parseAwardResult(t('<tr><td>1</td><td>A Co</td><td>5</td></tr>') + 'z'.repeat(MAX_RESULT_HTML));
    expect(r!.l1Seller).toBe('A Co');
  });

  it('hostile 512 KB shapes each finish under 200 ms', () => {
    const N = MAX_RESULT_HTML;
    const shapes: Record<string, string> = {
      'header row 512KB': '<table><tr><th>Price</th>' + '<th>x</th>'.repeat(N / 11) + '</tr><tr><td>A Co</td><td>5</td></tr></table>',
      '200k th': '<table><tr>' + '<th>'.repeat(200_000) + '</tr></table>',
      '<tdx flood': '<table><tr><th>Price</th></tr>' + '<tdx'.repeat(N / 4),
      '<tdx> flood': '<table><tr><th>Price</th></tr><tr>' + '<tdx>'.repeat(N / 5),
      '< flood': '<table><tr><th>Price</th>' + '<'.repeat(N),
      '<<td flood': '<table><tr><th>Price</th>' + '<<td'.repeat(N / 4),
      'unclosed quote': '<table><tr><th>Price</th><td class="' + 'a'.repeat(N),
      'table flood': '<table>'.repeat(N / 7),
      'tr flood': '<table><tr><th>Price</th></tr>' + '<tr>'.repeat(N / 4),
      'comment flood': '<table><tr><th>Price</th>' + '<!--'.repeat(N / 4),
      'entity flood': '<table><tr><th>Price</th></tr><tr><td>' + '&'.repeat(N),
      'script unterminated': '<table><tr><th>Price</th></tr><script>' + '</scrip'.repeat(N / 7),
    };
    for (const [k, v] of Object.entries(shapes)) expect(time(v), k).toBeLessThan(200);
  });

  it('32 near-limit tables (each ~16 KB) finish under 200 ms', () => {
    const rows = '<tr><td>1</td><td>A Co</td><td>5</td></tr>'.repeat(380);
    const one = `<table><tr><th>Rank</th><th>Seller</th><th>Price</th></tr>${rows}</table>`;
    expect(time(one.repeat(32))).toBeLessThan(200);
    const unclosed = '<table><tr><th>Price</th></tr>' + '<tr><td>1</td><td>A'.repeat(800);
    expect(time(unclosed.repeat(32))).toBeLessThan(200);
  });

  it('partly labelled header: the name comes from cell contents when only rank and/or price are labelled (B1)', () => {
    const row = '<tr><td>1</td><td>Alpha Co</td><td>1,00,000</td></tr><tr><td>2</td><td>Beta Co</td><td>2,00,000</td></tr>';
    const expected = [{ rank: 1, name: 'Alpha Co', price: 100_000 }, { rank: 2, name: 'Beta Co', price: 200_000 }];
    for (const h of ['<th>Rank</th><th>Firm</th><th>Price</th>', '<th>Rank</th><th>Participant</th><th>Total Price (&#8377;)</th>', '<th>Rank</th><th>Supplier</th><th>Price</th>', '<th>Rank</th><th>Agency</th><th>Price</th>']) {
      const r = parseAwardResult(`<table><tr>${h}</tr>${row}</table>`);
      expect(r?.bidders, h).toEqual(expected);
      expect(r?.l1Seller, h).toBe('Alpha Co');
    }
    // price labelled, no rank column, no name word
    expect(parseAwardResult('<table><tr><th>Bid</th><th>Quoted Price</th></tr><tr><td>Gamma Co</td><td>500</td></tr></table>')?.bidders).toEqual([{ rank: 0, name: 'Gamma Co', price: 500 }]);
    // rank-only header
    expect(parseAwardResult('<table><tr><th>Rank</th><th>Who</th><th>What</th></tr><tr><td>L1</td><td>Alpha Co</td><td>Rs 700</td></tr></table>')?.bidders).toEqual([{ rank: 1, name: 'Alpha Co', price: 700 }]);
  });

  it('a header-path name must contain a letter', () => {
    expect(parseAwardResult(t('<tr><td>1</td><td>12345</td><td>100</td></tr>'))).toBeNull();
    expect(parseAwardResult(t('<tr><td>1</td><td>—</td><td>100</td></tr>'))).toBeNull();
    expect(parseAwardResult(t('<tr><td>1</td><td>12345</td><td>100</td></tr><tr><td>2</td><td>Real Co</td><td>200</td></tr>'))?.bidders).toEqual([{ rank: 2, name: 'Real Co', price: 200 }]);
  });

  it('block tags separate words, inline tags do not (NB1)', () => {
    expect(parseAwardResult(t('<tr><td>1</td><td>Acme<br>Traders</td><td>100</td></tr>'))?.l1Seller).toBe('Acme Traders');
    expect(parseAwardResult(t('<tr><td>1</td><td><p>Acme</p><div>Traders</div><ul><li>Pvt</li><li>Ltd</li></ul></td><td>100</td></tr>'))?.l1Seller).toBe('Acme Traders Pvt Ltd');
    expect(parseAwardResult(t('<tr><td>1</td><td>A<b>cm</b><i>e</i> Co</td><td><span>28,40,500</span><span>.00</span></td></tr>'))).toMatchObject({ l1Seller: 'Acme Co', l1Price: 2_840_500 });
  });

  it('a header cell with both a name word and a price word is the price column (NB2)', () => {
    const r = parseAwardResult('<table><tr><th>Rank</th><th>Seller</th><th>Seller Quoted Price</th></tr><tr><td>1</td><td>Alpha Co</td><td>1,000</td></tr></table>');
    expect(r?.bidders).toEqual([{ rank: 1, name: 'Alpha Co', price: 1000 }]);
  });

  it('non-string input returns null without throwing (NB3)', () => {
    for (const v of [undefined, null, 42, {}, [], Symbol('x')]) expect(parseAwardResult(v as unknown as string)).toBeNull();
  });

  it('nested tables come out in document order, so rank-1 picking follows the document (NB4)', () => {
    const inner = '<table><tr><th>Rank</th><th>Seller</th><th>Price</th></tr><tr><td>1</td><td>Inner One</td><td>10</td></tr></table>';
    const html = `<table><tr><th>Rank</th><th>Seller</th><th>Price</th></tr><tr><td>1</td><td>Outer First</td><td>30</td></tr><tr><td>2</td><td>Outer Host</td><td>20</td><td>${inner}</td></tr><tr><td>1</td><td>Outer Last</td><td>40</td></tr></table>`;
    const r = parseAwardResult(html)!;
    expect(r.bidders.map((b) => b.name)).toEqual(['Outer First', 'Outer Host', 'Inner One', 'Outer Last']);
    expect(r.l1Seller).toBe('Outer First');
  });

  it('a winner-marked row that is not rank 1 wins over rank 1 (NB5)', () => {
    const r = parseAwardResult(t('<tr><td>1</td><td>Alpha Co</td><td>100</td></tr><tr><td>3</td><td><i class="fa fa-trophy"></i> Gamma Co</td><td>300</td></tr><tr><td>2</td><td>Beta Co</td><td>200</td></tr>'));
    expect(r).toMatchObject({ l1Seller: 'Gamma Co', l1Price: 300 });
    expect(r!.bidders.map((b) => b.rank)).toEqual([1, 3, 2]);
  });

  it('block-tag floods, nested-table floods and 5000+ rows finish under 200 ms', () => {
    const N = MAX_RESULT_HTML;
    expect(time(t('<tr><td>1</td><td>' + '<br>'.repeat(N / 4) + '</td><td>5</td></tr>'))).toBeLessThan(200);
    expect(time(t('<tr><td>1</td><td>A' + '<p>'.repeat(N / 3) + '</td><td>5</td></tr>'))).toBeLessThan(200);
    const nested = '<table><tr><th>Rank</th><th>Seller</th><th>Price</th></tr>';
    expect(time(nested.repeat(30) + '<tr><td>1</td><td>A Co</td><td>5</td></tr></table>'.repeat(30))).toBeLessThan(200);
    expect(time(t('<tr><td>1</td><td>A Co</td><td>5</td></tr>'.repeat(N / 40)))).toBeLessThan(200);
  });
});
