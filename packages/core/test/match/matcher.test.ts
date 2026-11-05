import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBidPlusDoc, parseBidPlusResponse } from '../../src/gem/parse';
import { hasPositiveCriteria, keywordRegex, matchTender, matchWatchlists, type MatchableTender } from '../../src/match/matcher';

const NOW = new Date('2026-11-04T04:30:00.000Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

const laptop: MatchableTender = {
  title: 'Laptop - Notebook',
  items: [{ name: 'Laptop - Notebook (Q2)' }],
  category: 'Laptop - Notebook',
  ministry: 'Maharashtra',
  department: 'School Education and Sports Department',
  buyerOffice: 'Directorate of School Education, Pune',
  state: 'Maharashtra',
  hsnCodes: ['84713010'],
  estimatedValue: 9_600_000,
  endAt: inDays(14),
  bidType: 'bid',
  status: 'open',
};

describe('keywordRegex', () => {
  it('reuses one compiled, stateless regex per keyword (hot path when scanning 50k tenders)', () => {
    const re = keywordRegex('patient monitor');
    expect(keywordRegex('patient monitor')).toBe(re);
    expect(re.global).toBe(false);
    expect(re.test('Patient-Monitor, 5 para')).toBe(true);
    expect(re.test('Patient monitors')).toBe(true); // no lastIndex carry-over between calls
  });

  it('matches whole words, case-insensitive, with simple plurals', () => {
    expect(keywordRegex('laptop').test('LAPTOPS for schools')).toBe(true);
    expect(keywordRegex('cctv').test('CCTV Camera (V2)')).toBe(true);
    expect(keywordRegex('cab').test('Cabinet, steel')).toBe(false);
    expect(keywordRegex('a4 paper').test('Copier A4-paper reams')).toBe(true);
    expect(keywordRegex('ups').test('Line Interactive UPS with AVR')).toBe(true);
    expect(keywordRegex('c++ (beta)').test('c++ (beta)')).toBe(true);
  });
});

describe('matchTender', () => {
  it('acceptance #1: laptop in Maharashtra matches with reasons', () => {
    const r = matchTender(laptop, { keywords: ['laptop'], states: ['Maharashtra'] }, { now: NOW });
    expect(r.matched).toBe(true);
    expect(r.reasons).toEqual(['Keyword “laptop”', 'State: Maharashtra']);
    expect(r.relevance).toBeGreaterThan(0.5);
  });

  it('keywords are OR-ed and also searched in items, category and buyer', () => {
    expect(matchTender({ ...laptop, title: 'Item bundle', category: null }, { keywords: ['notebook', 'printer'] }, { now: NOW }).reasons).toEqual(['Keyword “notebook”']);
    expect(matchTender(laptop, { keywords: ['school education'] }, { now: NOW }).matched).toBe(true);
    expect(matchTender(laptop, { keywords: ['printer', 'scanner'] }, { now: NOW }).matched).toBe(false);
  });

  it('title hits rank higher than item-only hits', () => {
    const a = matchTender(laptop, { keywords: ['laptop'] }, { now: NOW });
    const b = matchTender({ ...laptop, title: 'Computer hardware' }, { keywords: ['laptop'] }, { now: NOW });
    expect(a.relevance).toBeGreaterThan(b.relevance);
  });

  it('exclude keywords veto', () => {
    expect(matchTender(laptop, { keywords: ['laptop'], excludeKeywords: ['notebook'] }, { now: NOW }).matched).toBe(false);
  });

  it('states, ministries (ministry/department/organisation), categories', () => {
    expect(matchTender(laptop, { keywords: ['laptop'], states: ['Gujarat'] }, { now: NOW }).matched).toBe(false);
    expect(matchTender(laptop, { ministries: ['school education'] }, { now: NOW }).reasons).toEqual(['Buyer: school education']);
    expect(matchTender({ ...laptop, ministry: 'Ministry of Defence', department: 'DMA', organisation: 'Indian Army' }, { ministries: ['Indian Army'] }, { now: NOW }).matched).toBe(true);
    expect(matchTender(laptop, { categories: ['laptop - notebook'] }, { now: NOW }).reasons).toEqual(['Category: laptop - notebook']);
    expect(matchTender(laptop, { categories: ['Furniture'] }, { now: NOW }).matched).toBe(false);
  });

  it('HSN prefix matching works both ways', () => {
    expect(matchTender(laptop, { hsnCodes: ['8471'] }, { now: NOW }).reasons).toEqual(['HSN 8471']);
    expect(matchTender(laptop, { hsnCodes: ['9403'] }, { now: NOW }).matched).toBe(false);
    expect(matchTender({ ...laptop, hsnCodes: [] }, { hsnCodes: ['8471'] }, { now: NOW }).matched).toBe(false);
  });

  it('value range; unknown value passes with a flag', () => {
    expect(matchTender(laptop, { keywords: ['laptop'], minValue: 10_000_000 }, { now: NOW }).matched).toBe(false);
    expect(matchTender(laptop, { keywords: ['laptop'], maxValue: 5_000_000 }, { now: NOW }).matched).toBe(false);
    expect(matchTender(laptop, { keywords: ['laptop'], minValue: 5_000_000, maxValue: 10_000_000 }, { now: NOW }).reasons).toContain('Value ₹96 L');
    expect(matchTender({ ...laptop, estimatedValue: null }, { keywords: ['laptop'], minValue: 1 }, { now: NOW }).reasons).toContain('Value not published');
  });

  it('minDaysToClose and bid types', () => {
    expect(matchTender(laptop, { keywords: ['laptop'], minDaysToClose: 20 }, { now: NOW }).matched).toBe(false);
    expect(matchTender(laptop, { keywords: ['laptop'], minDaysToClose: 7 }, { now: NOW }).matched).toBe(true);
    expect(matchTender(laptop, { keywords: ['laptop'], bidTypes: ['ra'] }, { now: NOW }).matched).toBe(false);
    expect(matchTender(laptop, { keywords: ['laptop'], bidTypes: ['bid', 'ra'] }, { now: NOW }).matched).toBe(true);
  });

  it('never matches closed/expired bids or empty criteria', () => {
    expect(matchTender({ ...laptop, status: 'closed' }, { keywords: ['laptop'] }, { now: NOW }).matched).toBe(false);
    expect(matchTender({ ...laptop, endAt: inDays(-1) }, { keywords: ['laptop'] }, { now: NOW }).matched).toBe(false);
    expect(matchTender(laptop, { keywords: [], excludeKeywords: ['x'] }, { now: NOW }).matched).toBe(false);
    expect(hasPositiveCriteria({ minDaysToClose: 3 })).toBe(false);
  });
});

describe('matchWatchlists over fixtures', () => {
  const docs = ['page-1.json', 'page-2.json', 'page-3.json', 'page-4.json']
    .flatMap((f) => parseBidPlusResponse(JSON.parse(readFileSync(join(__dirname, '../fixtures/gem', f), 'utf8'))).docs);
  const tenders = docs.map((d) => parseBidPlusDoc(d, { now: NOW })!);
  const lists = [
    { id: 'it', criteria: { keywords: ['laptop', 'desktop', 'server'] } },
    { id: 'cctv-mh', criteria: { keywords: ['cctv'], states: ['Maharashtra', 'Karnataka'] } },
    { id: 'services', criteria: { bidTypes: ['service'], minValue: 10_000_000 } },
    { id: 'defence', criteria: { ministries: ['Ministry of Defence'] } },
  ];

  it('finds the expected tenders per watchlist', () => {
    const hits = (id: string) => tenders.filter((t) => matchWatchlists(t, lists, { now: NOW }).some((m) => m.watchlist.id === id)).map((t) => t.bidNumber);
    expect(hits('it').length).toBeGreaterThanOrEqual(7);
    // NVR/CCTV supply in Bengaluru + CCTV AMC for Western Railway, Mumbai
    expect(hits('cctv-mh')).toEqual(['GEM/2026/B/6421002', 'GEM/2026/B/6421022']);
    expect(hits('services').length).toBeGreaterThanOrEqual(5);
    expect(hits('defence').sort()).toEqual(['GEM/2026/B/6421004', 'GEM/2026/B/6421016', 'GEM/2026/R/6421034']);
  });
});
