import { describe, expect, it } from 'vitest';
import { contentHash, stableStringify } from '../../src/gem/hash';
import { cleanText, parseAmount, parseGemDate, splitItems, tidyTitle, toGemSolrDate, unwrap } from '../../src/gem/normalize';
import { canonicalState, deriveLocation } from '../../src/gem/states';

describe('parseAmount (Indian formats)', () => {
  it.each([
    ['₹ 5 Lakh', 500_000],
    ['5 lakhs', 500_000],
    ['1.2 Crore', 12_000_000],
    ['INR 3.5 Cr', 35_000_000],
    ['12,34,567', 1_234_567],
    ['Rs. 25,000/-', 25_000],
    ['₹1,23,45,678.40', 12_345_678],
    ['2.4 Lakh', 240_000],
    ['45 L', 4_500_000],
    ['50 Thousand', 50_000],
    [150000, 150_000],
    [['96 Lakh'], 9_600_000],
    ['0', 0],
  ])('%s → %d', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['N/A'], ['Not applicable']])('%s → null', (input) => {
    expect(parseAmount(input)).toBeNull();
  });
});

describe('parseGemDate (IST → UTC)', () => {
  it('treats Solr "Z" timestamps as IST wall clock', () => {
    // 3 PM IST = 09:30 UTC
    expect(parseGemDate(['2026-11-20T15:00:00Z'])?.toISOString()).toBe('2026-11-20T09:30:00.000Z');
  });
  it('can read real UTC when asked', () => {
    expect(parseGemDate('2026-11-20T15:00:00Z', { assumeIstWallClock: false })?.toISOString()).toBe('2026-11-20T15:00:00.000Z');
  });
  it('respects explicit offsets', () => {
    expect(parseGemDate('2026-11-20T15:00:00+05:30')?.toISOString()).toBe('2026-11-20T09:30:00.000Z');
  });
  it('parses bid-document style DD-MM-YYYY HH:mm:ss', () => {
    expect(parseGemDate('20-11-2026 18:00:00')?.toISOString()).toBe('2026-11-20T12:30:00.000Z');
    expect(parseGemDate('05/01/2027 11:00 AM')?.toISOString()).toBe('2027-01-05T05:30:00.000Z');
    expect(parseGemDate('05-01-2027')?.toISOString()).toBe('2027-01-04T18:30:00.000Z');
  });
  it('rejects garbage', () => {
    expect(parseGemDate('tomorrow')).toBeNull();
    expect(parseGemDate('2026-13-40T00:00:00Z')).toBeNull();
    expect(parseGemDate(null)).toBeNull();
  });
  it('round-trips with toGemSolrDate', () => {
    const d = new Date('2026-12-01T12:30:00.000Z');
    expect(parseGemDate(toGemSolrDate(d))?.toISOString()).toBe(d.toISOString());
  });
});

describe('text helpers', () => {
  it('unwraps Solr arrays and cleans whitespace', () => {
    expect(unwrap(['a'])).toBe('a');
    expect(cleanText(['  Laptop \n  Notebook  '])).toBe('Laptop Notebook');
    expect(cleanText([''])).toBeNull();
  });
  it('splits item lists without breaking parentheses', () => {
    expect(splitItems('Network Video Recorder (NVR) (Q2), CCTV Camera (V2) (Q2), PoE Switch (Q2)')).toEqual([
      'Network Video Recorder (NVR) (Q2)', 'CCTV Camera (V2) (Q2)', 'PoE Switch (Q2)',
    ]);
    expect(splitItems('Toner (a, b), Paper')).toEqual(['Toner (a, b)', 'Paper']);
  });
  it('tidies shouty titles but keeps normal ones', () => {
    expect(tidyTitle('SUPPLY OF DESKTOP COMPUTERS')).toBe('Supply Of Desktop Computers');
    expect(tidyTitle('CCTV Camera (V2)')).toBe('CCTV Camera (V2)');
  });
});

describe('states', () => {
  it('canonicalises names and aliases', () => {
    expect(canonicalState('maharashtra')).toBe('Maharashtra');
    expect(canonicalState('Orissa')).toBe('Odisha');
    expect(canonicalState('Ministry of Defence')).toBeNull();
  });
  it('derives state and city from office text', () => {
    expect(deriveLocation('Group Centre CRPF, Bengaluru')).toEqual({ state: 'Karnataka', city: 'Bengaluru' });
    expect(deriveLocation('NTPC Korba, Chhattisgarh')).toEqual({ state: 'Chhattisgarh', city: null });
    expect(deriveLocation('Directorate of Education, GNCTD, New Delhi').state).toBe('Delhi');
    expect(deriveLocation('Department of Military Affairs')).toEqual({ state: null, city: null });
    expect(deriveLocation(null, undefined, 'Command Hospital (Southern Command), Pune')).toEqual({ state: 'Maharashtra', city: 'Pune' });
  });
});

describe('content hash', () => {
  it('is stable regardless of key order and changes with values', () => {
    expect(stableStringify({ b: 1, a: [new Date('2026-01-01T00:00:00Z'), null] })).toBe('{"a":["2026-01-01T00:00:00.000Z",null],"b":1}');
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash('x')).toMatch(/^[0-9a-f]{16}$/);
  });
});
