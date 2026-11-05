import { describe, expect, it } from 'vitest';
import { profileCompleteness } from '../../src/vault/completeness';
import { profileInputSchema } from '../../src/contracts/vault';

const NOW = new Date('2026-11-04T04:30:00Z');

const full = {
  legalName: 'Sharma Infotech Pvt Ltd', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F', address: '12 MG Road', state: 'Maharashtra', pincode: '411001',
  incorporationDate: '2015-06-01', udyamNumber: 'UDYAM-MH-26-0123456', mseCategory: 'small', isStartup: false, miiClass: 'class_1',
  financials: [{ fy: '2025-26', turnover: 5e7, netWorth: 1e7 }, { fy: '2024-25', turnover: 4e7 }, { fy: '2023-24', turnover: 3e7 }],
  categories: ['Laptops'], hsnCodes: ['8471'], operatingStates: ['Maharashtra'], signatoryName: 'Ravi Sharma', signatoryDesignation: 'Director',
  contactEmail: 'bids@sharma.in', contactPhone: '+919812345678',
};
const docs = [{ type: 'gst' }, { type: 'pan' }, { type: 'ca_turnover_certificate' }, { type: 'udyam' }];

describe('profileCompleteness', () => {
  it('empty profile scores low with errors first', () => {
    const r = profileCompleteness(null, [], [], NOW);
    expect(r.percent).toBeLessThan(10);
    expect(r.issues[0]!.severity).toBe('error');
    expect(r.issues.map((i) => i.field)).toEqual(expect.arrayContaining(['legalName', 'gstin', 'pan', 'financials', 'pastContracts']));
  });
  it('complete profile scores 100 with no issues', () => {
    const r = profileCompleteness(full, [{}, {}, {}], docs, NOW);
    expect(r.percent).toBe(100);
    expect(r.issues).toEqual([]);
  });
  it('flags missing FYs by name', () => {
    const r = profileCompleteness({ ...full, financials: [{ fy: '2025-26', turnover: 1 }] }, [{}, {}, {}], docs, NOW);
    const i = r.issues.find((x) => x.field === 'financials')!;
    expect(i.message).toContain('2024-25');
    expect(r.percent).toBeLessThan(100);
  });
  it('expired docs do not count and are flagged', () => {
    const r = profileCompleteness(full, [{}, {}, {}], [...docs.filter((d) => d.type !== 'udyam'), { type: 'udyam', expiryDate: '2026-01-01', title: 'Udyam' }], NOW);
    expect(r.issues.some((i) => i.field === 'vault.udyam')).toBe(true);
    expect(r.issues.some((i) => i.field === 'vault.expired' && i.message.includes('Udyam'))).toBe(true);
  });
  it('startup needs DPIIT', () => {
    const r = profileCompleteness({ ...full, isStartup: true }, [{}, {}, {}], docs, NOW);
    expect(r.issues.map((i) => i.field)).toEqual(expect.arrayContaining(['dpiitNumber', 'vault.startup_dpiit']));
  });
});

describe('profileInputSchema', () => {
  it('normalises ids, phone and FY labels', () => {
    const r = profileInputSchema.parse({ gstin: ' 27aapfu0939f1zv', pan: 'aapfu0939f', contactPhone: '98123 45678', financials: [{ fy: 'FY 2024-2025', turnover: '1200000' }], tradeName: '' });
    expect(r.gstin).toBe('27AAPFU0939F1ZV');
    expect(r.contactPhone).toBe('+919812345678');
    expect(r.financials![0]).toEqual({ fy: '2024-25', turnover: 1200000 });
    expect(r.tradeName).toBeNull();
  });
  it('explains invalid fields per path', () => {
    const r = profileInputSchema.safeParse({ gstin: '27AAPFU0939F1ZA', pan: 'AAPXU0939F', udyamNumber: 'UDYAM-1', pincode: '012345', financials: [{ fy: '2024-25', turnover: 1 }, { fy: '2024-2025', turnover: 2 }] });
    expect(r.success).toBe(false);
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['gstin', 'pan', 'udyamNumber', 'pincode', 'financials.1.fy']));
  });
  it('checks GSTIN/PAN consistency and MII local content', () => {
    const r = profileInputSchema.safeParse({ gstin: '27AAPFU0939F1ZV', pan: 'AAACI1681G', miiClass: 'class_1', localContentPct: 30 });
    expect(r.success).toBe(false);
    const msgs = r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(msgs.some((m) => m.startsWith('gstin:') && m.includes('AAPFU0939F'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('localContentPct:'))).toBe(true);
  });
});
