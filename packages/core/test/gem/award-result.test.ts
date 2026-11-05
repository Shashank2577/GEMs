// Clean-room parseAwardResult tests (006/FR-085, T092): B1-B10 from award-parser-spec.md plus hostile-input timing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_RESULT_HTML } from '../../src/gem/award';
import { parseAwardResult } from '../../src/gem/award-result';

describe('parseAwardResult (T092; 006/FR-085) — scrape_ra_schedule table heuristics', () => {
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

describe('parseAwardResult (clean-room) — extra edge cases and hostile timing', () => {
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
});
