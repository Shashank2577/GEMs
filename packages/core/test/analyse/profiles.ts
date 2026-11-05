/** Shared company fixtures for analyse tests. "Today" is 2026-11-04 (IST). */
import type { ScorePastContract, ScoreProfile, ScoreVaultDoc } from '../../src/analyse/score';

export const NOW = new Date('2026-11-04T10:00:00+05:30');

/** Sharma Infotech: small MSE, avg turnover ₹2 Cr, ~4.4 years of experience, Class-I, ISO 9001. */
export const baseProfile: ScoreProfile = {
  mseCategory: 'small',
  udyamNumber: 'UDYAM-DL-08-0012345',
  isStartup: false,
  financials: [
    { fy: '2023-24', turnover: 16_000_000 },
    { fy: '2024-25', turnover: 20_000_000 },
    { fy: '2025-26', turnover: 24_000_000 },
    { fy: '2021-22', turnover: 1_000_000 }, // older than the last 3 FYs — ignored
  ],
  incorporationDate: '2022-04-01',
  miiClass: 'class_1',
  localContentPct: 62,
  oemAuthorizations: [],
  certifications: ['ISO 9001:2015'],
  maxEmdCapacity: 500_000,
  operatingStates: ['Delhi', 'Haryana', 'Uttar Pradesh', 'Madhya Pradesh'],
};

export const basePastContracts: ScorePastContract[] = [
  { title: 'IT helpdesk for DGFT', value: 2_500_000, startDate: '2022-06-01', endDate: '2023-05-31' },
  { title: 'AMC of desktops, NDMC', value: 1_200_000, startDate: '2024-01-15', endDate: '2025-01-14' },
];

export const baseVault: ScoreVaultDoc[] = [
  { type: 'gst', title: 'GST certificate' },
  { type: 'pan', title: 'PAN card' },
  { type: 'udyam', title: 'Udyam registration' },
  { type: 'balance_sheet', title: 'Balance sheet FY 2025-26' },
  { type: 'ca_turnover_certificate', title: 'CA turnover certificate' },
  { type: 'crac', title: 'CRAC — DGFT helpdesk' },
  { type: 'iso', title: 'ISO 9001:2015 certificate', expiryDate: '2027-08-31' },
];

/** A brand-new account: MSE + Class-I + Dell authorisation, but no financials or past contracts yet. */
export const sparseProfile: ScoreProfile = {
  mseCategory: 'micro', udyamNumber: 'UDYAM-HR-05-0099999', miiClass: 'class_1',
  oemAuthorizations: [{ oem: 'Dell', products: 'Desktops' }], certifications: [], financials: [],
};
