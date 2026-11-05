import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUYER_STATUS, buyerStatusLabel, parseBidResultHtml } from '../../src/gem/result';

const FIX = join(__dirname, '../fixtures/gem/results');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');
const row = (n: number, name: string, price: string, level: string, cls = '') =>
  `<tr${cls ? ` class="${cls}"` : ''}><td class="productDtl">${n}</td><td><span>${name}</span></td><td><span class="bid_price">${price}</span></td><td><strong>${level}</strong></td></tr>`;

describe('BUYER_STATUS', () => {
  it('maps GeM b_buyer_status codes', () => {
    expect(BUYER_STATUS).toEqual({ 0: 'Not evaluated', 1: 'Technical evaluated', 2: 'Financial evaluated', 3: 'Awarded' });
    expect(buyerStatusLabel(3)).toBe('Awarded');
    expect(buyerStatusLabel('1')).toBe('Technical evaluated');
    expect(buyerStatusLabel(9)).toBe('Not evaluated');
    expect(buyerStatusLabel(undefined)).toBe('Not evaluated');
  });
});

describe('parseBidResultHtml', () => {
  it('parses the awarded fixture: categories, four bidders L1-L4, winner, no anomaly', () => {
    const r = parseBidResultHtml(read('bid-result-awarded.html'));
    if (!r.ok) throw new Error('expected ok');
    expect(r.categories).toEqual(['Desktop Computers (Q2)', 'Monitor (Q2)']);
    expect(r.bidders.map(({ rank, seller, price, level }) => ({ rank, seller, price, level }))).toEqual([
      { rank: 1, seller: 'Kaveri Systems & Services Pvt Ltd', price: 2_840_500, level: 'L1' },
      { rank: 2, seller: 'Aarav Infotech Pvt Ltd', price: 2_950_000, level: 'L2' },
      { rank: 3, seller: 'Northline Computers', price: 3_125_000, level: 'L3' },
      { rank: 4, seller: 'Deccan Office Automation LLP', price: 3_310_000, level: 'L4' },
    ]);
    expect(r.winner?.seller).toBe('Kaveri Systems & Services Pvt Ltd');
    expect(r.winner?.awarded).toBe(true);
    expect(r.lowestPrice).toBe(2_840_500);
    expect(r.anomalies).toEqual([]);
  });

  it('falls back to the L1 row as winner when no row is marked', () => {
    const r = parseBidResultHtml(`<table>${row(1, 'A', '100', 'L1')}${row(2, 'B', '120', 'L2')}</table>`);
    expect(r.ok && r.winner?.seller).toBe('A');
    expect(r.ok && r.anomalies).toEqual([]);
  });

  it('flags "winner is not the lowest price" when the awarded row is not the cheapest', () => {
    const r = parseBidResultHtml(`<table>${row(1, 'Cheap Co', '90', 'L1')}${row(2, 'Pricey Co', '120', 'L2', 'awarded')}</table>`);
    if (!r.ok) throw new Error('expected ok');
    expect(r.winner?.seller).toBe('Pricey Co');
    expect(r.anomalies).toEqual([{ code: 'winner_not_lowest_price', message: 'Winner is not the lowest price' }]);
  });

  it('tied lowest price is not an anomaly; a single bidder never is', () => {
    const tie = parseBidResultHtml(`<table>${row(1, 'A', '100', 'L1')}${row(2, 'B', '100.00', 'L1', 'awarded')}</table>`);
    expect(tie.ok && tie.anomalies).toEqual([]);
    const one = parseBidResultHtml(`<table>${row(1, 'A', '100', 'L1')}</table>`);
    expect(one.ok && one.anomalies).toEqual([]);
  });

  it('reports a not-yet-published page as not_published', () => {
    expect(parseBidResultHtml(read('bid-result-not-published.html'))).toEqual({ ok: false, reason: 'not_published' });
  });

  it('never throws and returns malformed for garbage, empty, truncated and oversized input', () => {
    for (const bad of ['', '   ', '<html><body>Session expired. Please login.</body></html>', '<tr><td class="productDtl">1</td><td><span>X', 'x'.repeat(2_000_000), '<tr'.repeat(50_000)]) {
      expect(parseBidResultHtml(bad)).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(parseBidResultHtml(undefined as unknown as string)).toEqual({ ok: false, reason: 'malformed' });
    expect(parseBidResultHtml(null as unknown as string)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('skips rows missing price or level instead of borrowing from the next row', () => {
    const broken = '<tr><td class="productDtl">1</td><td><span>No Price</span></td><td><strong>L1</strong></td></tr>';
    const r = parseBidResultHtml(`<table>${broken}${row(2, 'B', '5', 'L2')}</table>`);
    expect(r.ok && r.bidders.map((b) => b.seller)).toEqual(['B']);
  });

  it('decodes entities in seller names and rejects zero or non-numeric prices', () => {
    const r = parseBidResultHtml(`<table>${row(1, 'A &amp; B &#x43;o', '1,00,000.50', 'L1')}${row(2, 'Free', '0', 'L2')}${row(3, 'Bad', '1.2.3', 'L3')}</table>`);
    if (!r.ok) throw new Error('expected ok');
    expect(r.bidders).toHaveLength(1);
    expect(r.bidders[0]).toMatchObject({ seller: 'A & B Co', price: 100_000.5 });
  });
});
