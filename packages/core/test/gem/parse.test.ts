import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffTenders, isCorrigendum, parseBidPlusDoc, parseBidPlusResponse, type NormalizedTender } from '../../src/gem/parse';

const FIX = join(__dirname, '../fixtures/gem');
const load = (f: string) => JSON.parse(readFileSync(join(FIX, f), 'utf8'));
const NOW = new Date('2026-11-04T04:30:00.000Z');
const BASE = 'https://bidplus.gem.gov.in';

const all: NormalizedTender[] = ['page-1.json', 'page-2.json', 'page-3.json', 'page-4.json']
  .flatMap((f) => parseBidPlusResponse(load(f)).docs)
  .map((d) => parseBidPlusDoc(d, { baseUrl: BASE, now: NOW })!)
  .filter(Boolean);
const byBid = (n: string) => all.find((t) => t.bidNumber === n)!;

describe('parseBidPlusResponse', () => {
  it('reads paged responses', () => {
    const p = parseBidPlusResponse(load('page-1.json'));
    expect(p.docs).toHaveLength(10);
    expect(p.numFound).toBe(36);
    expect(p.start).toBe(0);
  });
  it('treats code 404 as no results', () => {
    expect(parseBidPlusResponse(load('no-results.json'))).toEqual({ docs: [], numFound: 0, start: 0 });
  });
  it('throws on error codes and broken shapes', () => {
    expect(() => parseBidPlusResponse({ code: 500, message: 'down' })).toThrow(/500/);
    expect(() => parseBidPlusResponse({ code: 200, response: {} })).toThrow(/incomplete/);
    expect(() => parseBidPlusResponse(null)).toThrow();
  });
});

describe('parseBidPlusDoc on recorded fixtures', () => {
  it('parses all 36 fixture bids with unique bid numbers', () => {
    expect(all).toHaveLength(36);
    expect(new Set(all.map((t) => t.bidNumber)).size).toBe(36);
    for (const t of all) {
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.endAt).toBeInstanceOf(Date);
      expect(t.sourceUrl).toMatch(/^https:\/\/bidplus\.gem\.gov\.in\//);
      expect(t.contentHash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('normalises a state-government laptop bid', () => {
    const t = byBid('GEM/2026/B/6421001');
    expect(t).toMatchObject({
      gemBidId: '7421001',
      bidType: 'bid',
      title: 'Laptop - Notebook',
      category: 'Laptop - Notebook',
      quantity: 120,
      ministry: 'Maharashtra',
      department: 'School Education and Sports Department',
      state: 'Maharashtra',
      city: 'Pune',
      emdAmount: 240_000,
      estimatedValue: 9_600_000,
      hsnCodes: ['84713010'],
      status: 'open',
      documentUrl: `${BASE}/showbidDocument/7421001`,
    });
    expect(t.items).toEqual([{ name: 'Laptop - Notebook (Q2)', quantity: 120 }]);
    // Fixture end: 14 days after reference at 15:00 IST → 09:30 UTC.
    expect(t.endAt?.toISOString()).toBe('2026-11-18T09:30:00.000Z');
  });

  it('builds multi-item titles and derives state from the office for central buyers', () => {
    const t = byBid('GEM/2026/B/6421002');
    expect(t.title).toBe('Network Video Recorder (NVR) (Q2) + 2 more items');
    expect(t.items.map((i) => i.name)).toContain('CCTV Camera (V2) (Q2)');
    expect(t.ministry).toBe('Ministry of Home Affairs');
    expect(t.state).toBe('Karnataka');
    expect(t.emdAmount).toBe(180_000);
  });

  it('classifies bid types: service, RA, direct RA, bunch', () => {
    expect(byBid('GEM/2026/B/6421003').bidType).toBe('service');
    const ra = byBid('GEM/2026/R/6421025');
    expect(ra.bidType).toBe('ra');
    expect(ra.documentUrl).toBe(`${BASE}/showradocumentPdf/7421025`);
    expect(byBid('GEM/2026/R/6421034').documentUrl).toBe(`${BASE}/showdirectradocumentPdf/7421034`);
    expect(byBid('GEM/2026/B/6421031').bidType).toBe('bunch');
  });

  it('leaves unknowns as null rather than guessing', () => {
    const t = byBid('GEM/2026/B/6421004'); // Indian Army, no office
    expect(t.state).toBeNull();
    expect(t.estimatedValue).toBeNull();
    expect(t.organisation).toBe('Indian Army');
  });

  it('covers many states and ministries', () => {
    const states = new Set(all.map((t) => t.state).filter(Boolean));
    const ministries = new Set(all.map((t) => t.ministry));
    expect(states.size).toBeGreaterThanOrEqual(15);
    expect(ministries.size).toBeGreaterThanOrEqual(20);
  });

  it('marks bids past their end date as closed', () => {
    const t = parseBidPlusDoc(load('page-1.json').response.response.docs[0], { now: new Date('2027-01-01T00:00:00Z') })!;
    expect(t.status).toBe('closed');
  });

  it('handles minimal / odd docs', () => {
    expect(parseBidPlusDoc({ b_id: [1] })).toBeNull();
    const t = parseBidPlusDoc({ b_bid_number: 'GEM/2026/B/1', bd_category_name: ['SUPPLY OF A4 PAPER REAMS'], b_is_cancelled: [1] }, { now: NOW })!;
    expect(t.title).toBe('Supply Of A4 Paper Reams');
    expect(t.status).toBe('cancelled');
    expect(t.gemBidId).toBeNull();
    expect(t.sourceUrl).toBe(`${BASE}/all-bids`);
  });

  it('content hash ignores raw-only fields but tracks real changes', () => {
    const doc = load('page-1.json').response.response.docs[0];
    const a = parseBidPlusDoc(doc, { now: NOW })!;
    const b = parseBidPlusDoc({ ...doc, is_high_value: [true], some_new_field: ['x'] }, { now: NOW })!;
    const c = parseBidPlusDoc({ ...doc, final_end_date_sort: ['2026-11-25T15:00:00Z'] }, { now: NOW })!;
    expect(b.contentHash).toBe(a.contentHash);
    expect(c.contentHash).not.toBe(a.contentHash);
    const changes = diffTenders(a, c);
    expect(Object.keys(changes)).toEqual(['endAt']);
    expect(changes.endAt).toEqual({ from: '2026-11-18T09:30:00.000Z', to: '2026-11-25T09:30:00.000Z' });
    expect(isCorrigendum(changes)).toBe(true);
    expect(isCorrigendum({ status: { from: 'open', to: 'closed' } })).toBe(false);
  });
});
