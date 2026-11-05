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

// Golden values pinned to spec 005 US2 (FR-016, FR-017, FR-020) at the spec's reference instant.
describe('profileCompleteness — golden weights (spec 005 US2)', () => {
  const GOLDEN_NOW = new Date('2026-11-05T04:30:00Z');
  const ids = { legalName: 'Aarav Technologies Pvt Ltd', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F' };
  // Mirrors the demo org (packages/db/src/demo.ts) as seen on 2026-11-05.
  const demo = {
    ...ids, udyamNumber: 'UDYAM-MH-26-0123456', mseCategory: 'micro', isStartup: false, miiClass: 'class_1', incorporationDate: '2016-03-14',
    address: 'Office 402, Pride Purple Square, Baner Road, Baner, Pune', state: 'Maharashtra', pincode: '411045',
    contactEmail: 'bids@aaravtech.in', contactPhone: '+919822012345', signatoryName: 'Ananya Kulkarni', signatoryDesignation: 'Director',
    financials: [
      { fy: '2022-23', turnover: 18_230_000, netWorth: 6_490_000 },
      { fy: '2023-24', turnover: 24_610_000, netWorth: 8_640_000 },
      { fy: '2024-25', turnover: 31_840_000, netWorth: 11_260_000 },
    ],
    categories: ['Desktop Computers', 'CCTV Cameras'], hsnCodes: ['8471', '8525'], operatingStates: ['Maharashtra', 'Goa'],
    oemAuthorizations: [
      { oem: 'CP PLUS', validTill: '2027-04-19', documentId: '00000000-0000-4000-8000-000000000001' },
      { oem: 'Dell Technologies', validTill: '2026-10-31', documentId: '00000000-0000-4000-8000-000000000002' },
      { oem: 'D-Link India', documentId: '00000000-0000-4000-8000-000000000003' },
    ],
  };
  const demoDocs = [
    { type: 'gst' }, { type: 'pan' }, { type: 'udyam' }, { type: 'incorporation' }, { type: 'balance_sheet' },
    { type: 'ca_turnover_certificate', expiryDate: '2026-11-30' }, { type: 'iso', expiryDate: '2026-11-15' },
    { type: 'oem_authorization', expiryDate: '2027-04-19', title: 'OEM authorisation – CP PLUS (CCTV)' },
    { type: 'oem_authorization', expiryDate: '2026-10-31', title: 'OEM authorisation – Dell Technologies (desktops & servers)' },
  ];

  it('empty profile → 0% with 17 issues, errors first in spec order', () => {
    const r = profileCompleteness(null, [], [], GOLDEN_NOW);
    expect(r.percent).toBe(0);
    expect(r.issues).toHaveLength(17);
    expect(r.issues.slice(0, 4).map((i) => [i.severity, i.message])).toEqual([
      ['error', 'Add your legal company name exactly as registered on GeM.'],
      ['error', 'Add your GSTIN — almost every GeM bid asks for it.'],
      ['error', 'Add the PAN of the bidding entity.'],
      ['error', 'Add turnover for the last 3 financial years (2023-24, 2024-25, 2025-26) — used for turnover criteria.'],
    ]);
    const rank = { error: 0, warning: 1, info: 2 } as const;
    const ranks = r.issues.map((i) => rank[i.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ranks.filter((x) => x === 0)).toHaveLength(4);
  });
  it('legal name + GSTIN + PAN → 27%, plus a non-expired gst doc → 32%', () => {
    expect(profileCompleteness(ids, [], [], GOLDEN_NOW).percent).toBe(27);
    expect(profileCompleteness(ids, [], [{ type: 'gst' }], GOLDEN_NOW).percent).toBe(32);
    expect(profileCompleteness(ids, [], [{ type: 'gst', expiryDate: '2026-11-04' }], GOLDEN_NOW).percent).toBe(27);
  });
  it('only FY 2025-26 → warning naming the missing years, 4 of 12 points', () => {
    const r = profileCompleteness({ ...ids, financials: [{ fy: '2025-26', turnover: 60_000_000 }] }, [], [], GOLDEN_NOW);
    expect(r.issues.find((x) => x.field === 'financials' && x.severity !== 'info'))
      .toMatchObject({ severity: 'warning', message: 'Add turnover for 2024-25, 2023-24 so the 3-year average is accurate.' });
    expect(r.percent).toBe(31); // (26 + 4) / 98
  });
  it('demo-like profile with 5 contracts → 96% with the 3 warnings of scenario 10', () => {
    const r = profileCompleteness(demo, [1, 2, 3, 4, 5], demoDocs, GOLDEN_NOW);
    expect(r.percent).toBe(96);
    expect(r.issues.map((i) => i.message)).toEqual([
      'Add turnover for 2025-26 so the 3-year average is accurate.',
      'OEM authorisation from Dell Technologies has expired — request a fresh one.',
      '"OEM authorisation – Dell Technologies (desktops & servers)" in the vault has expired — upload the renewed copy.',
    ]);
    expect(r.issues.every((i) => i.severity === 'warning')).toBe(true);
  });
});

describe('profileCompleteness — OEM info issues (FR-020)', () => {
  const GOLDEN_NOW = new Date('2026-11-05T04:30:00Z');
  const linked = '00000000-0000-4000-8000-000000000001';
  const oemIssues = (oemAuthorizations: { oem: string; validTill?: string | null; documentId?: string | null }[]) =>
    profileCompleteness({ ...full, oemAuthorizations }, [{}, {}, {}], docs, GOLDEN_NOW);

  it('OEM authorisation expiring within 30 days → info, no score change', () => {
    const r = oemIssues([{ oem: 'Dell', validTill: '2026-11-25', documentId: linked }]);
    expect(r.percent).toBe(100);
    expect(r.issues).toEqual([{ field: 'oemAuthorizations.0.validTill', section: 'oem', severity: 'info', message: 'OEM authorisation from Dell expires in 20 days — ask for a renewed MAF.' }]);
  });
  it('covers the 0–30 day window only', () => {
    expect(oemIssues([{ oem: 'HP', validTill: '2026-12-05', documentId: linked }]).issues[0]!.message).toBe('OEM authorisation from HP expires in 30 days — ask for a renewed MAF.');
    expect(oemIssues([{ oem: 'HP', validTill: '2026-12-06', documentId: linked }]).issues).toEqual([]);
    expect(oemIssues([{ oem: 'HP', validTill: '2026-11-05', documentId: linked }]).issues[0]!.message).toBe('OEM authorisation from HP expires today — ask for a renewed MAF.');
    expect(oemIssues([{ oem: 'HP', validTill: '2026-11-06', documentId: linked }]).issues[0]!.message).toBe('OEM authorisation from HP expires in 1 day — ask for a renewed MAF.');
    // Expired: the warning only, never the "expires in" info.
    expect(oemIssues([{ oem: 'HP', validTill: '2026-11-04', documentId: linked }]).issues.map((i) => [i.severity, i.message])).toEqual([
      ['warning', 'OEM authorisation from HP has expired — request a fresh one.'],
    ]);
  });
  it('OEM authorisation without a linked vault document → info, no score change', () => {
    const r = oemIssues([{ oem: 'Dell', validTill: '2027-06-30' }, { oem: 'Lenovo', documentId: linked }, { oem: 'HP', documentId: null }]);
    expect(r.percent).toBe(100);
    expect(r.issues).toEqual([
      { field: 'oemAuthorizations.0.documentId', section: 'oem', severity: 'info', message: 'Link the Dell authorisation letter from the vault so packets can attach it.' },
      { field: 'oemAuthorizations.2.documentId', section: 'oem', severity: 'info', message: 'Link the HP authorisation letter from the vault so packets can attach it.' },
    ]);
  });
  it('info issues sort after errors and warnings', () => {
    const r = profileCompleteness({ ...full, gstin: null, oemAuthorizations: [{ oem: 'Dell', validTill: '2026-11-25' }] }, [{}, {}, {}], docs, GOLDEN_NOW);
    expect(r.issues.map((i) => i.severity)).toEqual(['error', 'info', 'info']);
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
