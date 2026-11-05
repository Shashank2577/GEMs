import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBidPlusDoc, parseBidPlusResponse } from '../../src/gem/parse';
import { compileCriteria, hasPositiveCriteria, keywordRegex, matchTender, matchWatchlists, type MatchableTender } from '../../src/match/matcher';

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

describe('matchTender with malformed stored items', () => {
  it('treats a non-array items value (jsonb object / scalar) as no items instead of throwing', () => {
    const asObject = { ...laptop, title: 'Stationery', category: null, items: { name: 'Laptop' } as unknown as MatchableTender['items'] };
    expect(() => matchTender(asObject, { keywords: ['laptop'] }, { now: NOW })).not.toThrow();
    expect(matchTender(asObject, { keywords: ['laptop'] }, { now: NOW }).matched).toBe(false);
    const asScalar = { ...laptop, items: 'laptop' as unknown as MatchableTender['items'] };
    expect(matchTender(asScalar, { keywords: ['laptop'] }, { now: NOW }).matched).toBe(true); // title still matches
    const holes = { ...laptop, title: 'x', category: null, items: [null, { name: 'Laptop bag' }] as unknown as MatchableTender['items'] };
    expect(matchTender(holes, { keywords: ['laptop'] }, { now: NOW }).matched).toBe(true);
  });
});

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

  it('review R2-S1: a combining mark belongs to its word — it is never a word boundary (Hindi matras, decomposed accents)', () => {
    // Hindi: "ताब" is the tail of "किताब" (book) after the matra ि — not a separate word.
    expect(keywordRegex('ताब').test('किताब की आपूर्ति')).toBe(false);
    expect(keywordRegex('किताब').test('किताब की आपूर्ति')).toBe(true);
    // "सोलर" (solar) on its own matches; a base letter followed by its vowel sign / virama does not.
    expect(keywordRegex('सोलर').test('सोलर स्ट्रीट लाइट')).toBe(true);
    expect(keywordRegex('सोलर लाइट').test('सोलर-लाइट 12W')).toBe(true);
    expect(keywordRegex('स').test('सोलर')).toBe(false); // स followed by the vowel sign ो
    expect(keywordRegex('क').test('क्षमता')).toBe(false); // क followed by the virama ्
    // Decomposed Latin: "cafe" + U+0301 is "café", not "cafe".
    expect(keywordRegex('cafe').test('Café chairs')).toBe(false);
    expect(keywordRegex('café').test('Café chairs')).toBe(true);
    expect(keywordRegex('e').test('é')).toBe(false);
    // Invisible format characters (Cf) still separate words for the matcher; the FTS column maps them to spaces.
    expect(keywordRegex('street').test('solar​street light')).toBe(true);
    expect(keywordRegex('lamp').test('LED­lamp')).toBe(true);
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

describe('compileCriteria (008/FR-074, US7 scenario 4)', () => {
  const STATES = ['Maharashtra', 'Karnataka', 'Delhi', 'Tamil Nadu', 'Gujarat'];
  const WORDS = ['laptop', 'cctv camera', 'ups', 'office chair', 'printer', 'led light', 'water purifier', 'diesel generator', 'a4 paper', 'network switch'];
  const tenders: MatchableTender[] = Array.from({ length: 500 }, (_, i) => ({
    title: `Supply of ${WORDS[i % WORDS.length]} lot ${i}`,
    items: [{ name: `${WORDS[(i * 3) % WORDS.length]} accessories` }],
    category: WORDS[(i * 7) % WORDS.length], ministry: i % 2 ? 'Ministry of Defence' : 'Ministry of Railways',
    department: `Department ${i % 13}`, organisation: `Org ${i % 31}`, state: STATES[i % STATES.length],
    hsnCodes: [String(84710000 + (i % 50))], estimatedValue: i % 9 ? 100_000 * (i % 200) : null,
    endAt: new Date(NOW.getTime() + (1 + (i % 30)) * 86_400_000), bidType: i % 4 ? 'bid' : 'ra', status: 'open',
  }));
  const watchlists = Array.from({ length: 1000 }, (_, i) => ({
    id: `w${i}`,
    criteria: {
      keywords: [WORDS[i % WORDS.length]!, WORDS[(i + 3) % WORDS.length]!],
      excludeKeywords: i % 5 === 0 ? ['refurbished'] : [],
      states: i % 3 === 0 ? [STATES[i % STATES.length]!] : [],
      ministries: i % 7 === 0 ? ['Defence'] : [],
      hsnCodes: i % 11 === 0 ? ['8471'] : [],
      minValue: i % 4 === 0 ? 1_000_000 : null,
      minDaysToClose: i % 6 === 0 ? 5 : null,
    },
  }));

  it('gives exactly the same results as matching the raw criteria', () => {
    for (const w of watchlists.slice(0, 100)) {
      const c = compileCriteria(w.criteria);
      for (const t of tenders.slice(0, 100)) expect(matchTender(t, c, { now: NOW })).toEqual(matchTender(t, w.criteria, { now: NOW }));
    }
  });

  it('a compiled watchlist is reused as is: its regexes are built once and are stateless (no g flag)', () => {
    const c = compileCriteria({ keywords: ['laptop', 'cctv camera'], excludeKeywords: ['refurbished'] });
    const before = [...c.keywords.map((k) => k.re), ...c.exclude];
    for (const t of tenders) matchTender(t, c, { now: NOW });
    expect([...c.keywords.map((k) => k.re), ...c.exclude]).toEqual(before);
    expect(before.every((re) => !re.global)).toBe(true);
    expect(compileCriteria({ keywords: ['  '], states: [] }).positive).toBe(false);
  });

  it('benchmark: 1,000 watchlists × 500 tenders, compiled once per run, finish in < 5 s', () => {
    const t0 = performance.now();
    const compiled = watchlists.map((w) => ({ w, c: compileCriteria(w.criteria) }));
    let hits = 0;
    for (const t of tenders) for (const { c } of compiled) if (matchTender(t, c, { now: NOW }).matched) hits++;
    const ms = performance.now() - t0;
    console.log(JSON.stringify({ benchmark: 'match 1000 watchlists x 500 tenders', pairs: 500_000, hits, ms: Math.round(ms) }));
    expect(hits).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(5000);
  });
});
