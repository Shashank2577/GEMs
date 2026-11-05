import { describe, expect, it } from 'vitest';
import {
  averageTurnoverLastN, fyLabelForDate, fyStartYear, gstinCheckChar, gstinPan, gstinState, lastCompletedFys, normalizeFy, panEntityType,
  toE164IndianMobile, UDYAM_STATE_CODES, udyamState, validateCin, validateDpiit, validateGstin, validateIfsc, validatePan, validatePincode, validateUdyam,
} from '../../src/vault/validators';

// Real-format GSTINs whose check characters were computed with the mod-36 algorithm
// (27AAPFU0939F1ZV is the widely published GSTN sample).
const VALID_GSTINS = ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '07AAACI1681G1ZR', '33AABCT1332L1ZL', '09AAACH7409R1ZZ', '36AAACI1195H1ZN'];

describe('GSTIN', () => {
  it.each(VALID_GSTINS)('accepts %s', (g) => expect(validateGstin(g)).toBeNull());
  it('computes the check character', () => {
    for (const g of VALID_GSTINS) expect(gstinCheckChar(g.slice(0, 14))).toBe(g[14]);
  });
  it('normalises case and spaces', () => expect(validateGstin(' 27aapfu0939f1zv ')).toBeNull());
  it('rejects a wrong check character', () => expect(validateGstin('27AAPFU0939F1ZA')).toMatch(/check character/));
  it('rejects a single-character typo', () => expect(validateGstin('27AAPFU0939F1ZV'.replace('0939', '0938'))).toMatch(/check character/));
  it('rejects wrong length', () => expect(validateGstin('27AAPFU0939F1Z')).toMatch(/15 characters/));
  it('rejects invalid state codes', () => {
    const body = '40AAPFU0939F1Z';
    expect(validateGstin(body + gstinCheckChar(body))).toMatch(/state code/);
  });
  it('accepts state codes 97 and 99', () => {
    for (const sc of ['97', '99', '38']) { const b = `${sc}AAPFU0939F1Z`; expect(validateGstin(b + gstinCheckChar(b))).toBeNull(); }
  });
  it('rejects an invalid embedded PAN', () => {
    const b = '27AAPXU0939F1Z';
    expect(validateGstin(b + gstinCheckChar(b))).toMatch(/PAN inside/);
  });
  it('rejects a missing Z', () => expect(validateGstin('27AAPFU0939F1YV')).toMatch(/format/));
  it('derives state and PAN', () => {
    expect(gstinState('27AAPFU0939F1ZV')).toBe('Maharashtra');
    expect(gstinState('29AAGCB7383J1Z4')).toBe('Karnataka');
    expect(gstinPan('27AAPFU0939F1ZV')).toBe('AAPFU0939F');
  });
});

describe('PAN', () => {
  it('accepts valid PANs', () => {
    expect(validatePan('AAPFU0939F')).toBeNull();
    expect(validatePan('abcpe1234f')).toBeNull();
  });
  it('rejects bad entity type and formats', () => {
    expect(validatePan('AAPXU0939F')).toMatch(/4th character/);
    expect(validatePan('AAPF0939F')).toMatch(/10 characters/);
    expect(validatePan('AAPFU09391')).toMatch(/format/);
  });
  it('reports holder type', () => {
    expect(panEntityType('AAACI1681G')).toBe('Company');
    expect(panEntityType('ABCPE1234F')).toBe('Individual');
    expect(panEntityType('bad')).toBeNull();
  });
});

describe('other identifiers', () => {
  it('Udyam', () => {
    expect(validateUdyam('UDYAM-MH-26-0123456')).toBeNull();
    expect(validateUdyam('udyam-mh-26-0123456')).toBeNull();
    expect(validateUdyam('UDYAM-MH-260123456')).toMatch(/UDYAM-XX/);
    expect(validateUdyam('UAM-MH-26-0123456')).not.toBeNull();
  });
  it('Udyam state code (FR-015)', () => {
    expect(Object.keys(UDYAM_STATE_CODES)).toHaveLength(36);
    for (const sc of ['MH', 'DL', 'TS', 'OD', 'LA', 'DN']) expect(validateUdyam(`UDYAM-${sc}-01-0000001`)).toBeNull();
    expect(validateUdyam('UDYAM-XX-26-0123456')).toBe('"XX" is not a valid state code in a Udyam number');
    expect(validateUdyam('udyam-zz-26-0123456')).toBe('"ZZ" is not a valid state code in a Udyam number');
  });
  it('Udyam accepts alias state codes DD → DN and TG → TS, but not prototype keys', () => {
    expect(validateUdyam('UDYAM-DD-01-0000001')).toBeNull();
    expect(validateUdyam('UDYAM-TG-02-0000001')).toBeNull();
    expect(udyamState('DD')).toBe(udyamState('DN'));
    expect(udyamState('tg')).toBe('Telangana');
    expect(Object.keys(UDYAM_STATE_CODES)).not.toContain('DD');
    expect(udyamState('constructor')).toBeNull();
    expect(udyamState('__proto__')).toBeNull();
  });
  it('CIN year bound uses an injectable now (FR-015)', () => {
    const now = new Date('2026-11-05T00:00:00Z');
    expect(validateCin('U72200MH2027PTC123456', now)).toBeNull();
    expect(validateCin('U72200MH2028PTC123456', now)).toMatch(/Incorporation year 2028/);
    expect(validateCin('U72200MH2028PTC123456', new Date('2027-06-01T00:00:00Z'))).toBeNull();
    expect(validateCin('U72200MH1850PTC123456', now)).toBeNull();
    expect(validateCin('U72200MH1849PTC123456', now)).toMatch(/year/);
  });
  it('CIN', () => {
    expect(validateCin('U72200MH2015PTC123456')).toBeNull();
    expect(validateCin('L17110MH1973PLC019786')).toBeNull();
    expect(validateCin('X72200MH2015PTC123456')).toMatch(/format/);
    expect(validateCin('U72200MH2015PTC12345')).toMatch(/21 characters/);
    expect(validateCin('U72200MH1700PTC123456')).toMatch(/year/);
  });
  it('IFSC', () => {
    expect(validateIfsc('HDFC0001234')).toBeNull();
    expect(validateIfsc('SBIN0ABC123')).toBeNull();
    expect(validateIfsc('HDFC1001234')).not.toBeNull();
  });
  it('pincode', () => {
    expect(validatePincode('400001')).toBeNull();
    expect(validatePincode('040001')).not.toBeNull();
    expect(validatePincode('40001')).not.toBeNull();
  });
  it('Indian mobile → E.164', () => {
    expect(toE164IndianMobile('98123 45678')).toBe('+919812345678');
    expect(toE164IndianMobile('+91-98123-45678')).toBe('+919812345678');
    expect(toE164IndianMobile('09812345678')).toBe('+919812345678');
    expect(toE164IndianMobile('919812345678')).toBe('+919812345678');
    expect(toE164IndianMobile('5812345678')).toBeNull();
    expect(toE164IndianMobile('981234567')).toBeNull();
  });
});

describe('financial years', () => {
  it('labels dates in IST', () => {
    expect(fyLabelForDate(new Date('2024-04-01T00:00:00+05:30'))).toBe('2024-25');
    expect(fyLabelForDate(new Date('2025-03-31T23:59:00+05:30'))).toBe('2024-25');
    // 31 Mar 2025 20:00 UTC is already 1 Apr in India
    expect(fyLabelForDate(new Date('2025-03-31T20:00:00Z'))).toBe('2025-26');
    expect(fyLabelForDate(new Date('2099-12-01T00:00:00Z'))).toBe('2099-00');
  });
  it('parses and normalises labels', () => {
    expect(fyStartYear('2024-25')).toBe(2024);
    expect(normalizeFy('FY 2024-2025')).toBe('2024-25');
    expect(normalizeFy('fy24-25')).toBe('2024-25');
    expect(normalizeFy('2024/25')).toBe('2024-25');
    expect(normalizeFy('2024-26')).toBeNull();
    expect(normalizeFy('2024')).toBeNull();
  });
  it('lists the last completed FYs', () => {
    expect(lastCompletedFys(new Date('2026-11-04T10:00:00Z'))).toEqual(['2025-26', '2024-25', '2023-24']);
    expect(lastCompletedFys(new Date('2026-03-15T10:00:00Z'), 2)).toEqual(['2024-25', '2023-24']);
  });
  it('averages the latest N years with figures', () => {
    const fin = [
      { fy: '2021-22', turnover: 10_00_00_000 },
      { fy: '2024-25', turnover: 3_00_00_000 },
      { fy: 'FY 2023-24', turnover: 2_00_00_000 },
      { fy: '2022-23', turnover: 1_00_00_000 },
    ];
    expect(averageTurnoverLastN(fin, 3)).toEqual({ avg: 2_00_00_000, years: ['2024-25', '2023-24', '2022-23'] });
    expect(averageTurnoverLastN(fin, 1)).toEqual({ avg: 3_00_00_000, years: ['2024-25'] });
    expect(averageTurnoverLastN([], 3)).toBeNull();
    expect(averageTurnoverLastN([{ fy: 'junk', turnover: 5 }], 3)).toBeNull();
  });
  it('spec 005 US2 average: ₹6 Cr, ₹4.5 Cr, ₹3 Cr → ₹4,50,00,000 over the 3 latest FYs', () => {
    const fin = [{ fy: '2025-26', turnover: 6_00_00_000 }, { fy: '2024-25', turnover: 4_50_00_000 }, { fy: '2023-24', turnover: 3_00_00_000 }];
    expect(averageTurnoverLastN(fin, 3)).toEqual({ avg: 45_000_000, years: ['2025-26', '2024-25', '2023-24'] });
  });
  it('de-duplicates FYs (first row per normalised FY wins)', () => {
    const fin = [{ fy: '2024-25', turnover: 100 }, { fy: 'FY 2024-2025', turnover: 900 }, { fy: '2023-24', turnover: 300 }];
    expect(averageTurnoverLastN(fin, 3)).toEqual({ avg: 200, years: ['2024-25', '2023-24'] });
  });
  it('uses at most 3 years by default and fewer when fewer have figures', () => {
    const fin = ['2025-26', '2024-25', '2023-24', '2022-23', '2021-22'].map((fy, i) => ({ fy, turnover: (i + 1) * 100 }));
    expect(averageTurnoverLastN(fin)).toEqual({ avg: 200, years: ['2025-26', '2024-25', '2023-24'] });
    expect(averageTurnoverLastN([{ fy: '2025-26', turnover: 7 }])).toEqual({ avg: 7, years: ['2025-26'] });
  });
  it('ignores negative and non-finite turnovers', () => {
    const fin = [{ fy: '2025-26', turnover: -1 }, { fy: '2024-25', turnover: Number.NaN }, { fy: '2023-24', turnover: 300 }, { fy: '2022-23', turnover: 0 }];
    expect(averageTurnoverLastN(fin, 3)).toEqual({ avg: 150, years: ['2023-24', '2022-23'] });
    expect(averageTurnoverLastN([{ fy: '2025-26', turnover: -5 }], 3)).toBeNull();
  });
});

describe('quoted examples are themselves valid (FR-004)', () => {
  // Every "e.g. …" in a validator message (and the matching UI placeholder/hint) must pass its own validator.
  const exampleIn = (msg: string | null, re: RegExp) => { expect(msg).not.toBeNull(); const m = msg!.match(re); expect(m).not.toBeNull(); return m![1]!; };
  it.each([
    ['GSTIN', validateGstin, '27AAPFU0939F1Z', /e\.g\. (\w+)/],
    ['PAN', validatePan, 'AAPF', /e\.g\. (\w+)/],
    ['Udyam', validateUdyam, 'UDYAM-1', /e\.g\. ([\w-]+)/],
    ['CIN', validateCin, 'U72200MH2015PTC12345', /e\.g\. (\w+)/],
    ['IFSC', validateIfsc, 'HDFC1', /e\.g\. (\w+)/],
    ['DPIIT', validateDpiit, 'X1', /like (\w+)/],
  ] as const)('%s', (_name, validator, bad, re) => {
    const example = exampleIn((validator as (v: string) => string | null)(bad), re);
    expect((validator as (v: string) => string | null)(example)).toBeNull();
  });
  it('GSTIN example is 27AAPCS1234K1Z2 and embeds the PAN example', () => {
    expect(validateGstin('27AAPCS1234K1Z5')).not.toBeNull();
    expect(exampleIn(validateGstin('1'), /e\.g\. (\w+)/)).toBe('27AAPCS1234K1Z2');
    expect(gstinPan('27AAPCS1234K1Z2')).toBe(exampleIn(validatePan('1'), /e\.g\. (\w+)/));
  });
  it('PIN placeholder used in the UI (411001) is valid', () => expect(validatePincode('411001')).toBeNull());
});

describe('quoted examples are themselves valid (FR-004)', () => {
  // Every "e.g. …" in a validator message (and the matching UI placeholder/hint) must pass its own validator.
  const exampleIn = (msg: string | null, re: RegExp) => { expect(msg).not.toBeNull(); const m = msg!.match(re); expect(m).not.toBeNull(); return m![1]!; };
  it.each([
    ['GSTIN', validateGstin, '27AAPFU0939F1Z', /e\.g\. (\w+)/],
    ['PAN', validatePan, 'AAPF', /e\.g\. (\w+)/],
    ['Udyam', validateUdyam, 'UDYAM-1', /e\.g\. ([\w-]+)/],
    ['CIN', validateCin, 'U72200MH2015PTC12345', /e\.g\. (\w+)/],
    ['IFSC', validateIfsc, 'HDFC1', /e\.g\. (\w+)/],
    ['DPIIT', validateDpiit, 'X1', /like (\w+)/],
  ] as const)('%s', (_name, validator, bad, re) => {
    const example = exampleIn((validator as (v: string) => string | null)(bad), re);
    expect((validator as (v: string) => string | null)(example)).toBeNull();
  });
  it('GSTIN example is 27AAPCS1234K1Z2 and embeds the PAN example', () => {
    expect(validateGstin('27AAPCS1234K1Z5')).not.toBeNull();
    expect(exampleIn(validateGstin('1'), /e\.g\. (\w+)/)).toBe('27AAPCS1234K1Z2');
    expect(gstinPan('27AAPCS1234K1Z2')).toBe(exampleIn(validatePan('1'), /e\.g\. (\w+)/));
  });
  it('PIN placeholder used in the UI (411001) is valid', () => expect(validatePincode('411001')).toBeNull());
});
