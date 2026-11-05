import { describe, expect, it } from 'vitest';
import {
  DOC_TYPES, GEM_SELLER_DOC_LABELS, daysUntilExpiry, docStatus, docTypeInfo, guessDocType, guessFinancialYear, istDate, reminderCopy, reminderDue, suggestExpiry,
} from '../../src/vault/status';

// 4 Nov 2026, 10:00 IST
const NOW = new Date('2026-11-04T04:30:00Z');

describe('docStatus', () => {
  it('no expiry → valid (acceptance 1: GST with no expiry)', () => expect(docStatus(null, NOW)).toEqual({ status: 'valid', daysToExpiry: null }));
  it('expiring in 10 days → expiring (acceptance 2)', () => expect(docStatus('2026-11-14', NOW)).toEqual({ status: 'expiring', daysToExpiry: 10 }));
  it('boundaries', () => {
    expect(docStatus('2026-12-04', NOW).status).toBe('expiring'); // 30 days
    expect(docStatus('2026-12-05', NOW).status).toBe('valid'); // 31 days
    expect(docStatus('2026-11-04', NOW)).toEqual({ status: 'expiring', daysToExpiry: 0 }); // valid through its expiry date
    expect(docStatus('2026-11-03', NOW)).toEqual({ status: 'expired', daysToExpiry: -1 });
  });
  it('uses the IST calendar day', () => {
    const lateUtc = new Date('2026-11-03T20:00:00Z'); // already 4 Nov in India
    expect(istDate(lateUtc)).toBe('2026-11-04');
    expect(daysUntilExpiry('2026-11-03', lateUtc)).toBe(-1);
  });
  it('ignores invalid dates', () => expect(docStatus('not-a-date', NOW).status).toBe('valid'));
});

describe('reminderDue', () => {
  const doc = (expiryDate: string | null, lastReminderDays: number | null = null) => ({ expiryDate, lastReminderDays });
  it('nothing for far or missing expiry', () => {
    expect(reminderDue(doc(null), NOW)).toBeNull();
    expect(reminderDue(doc('2027-06-01'), NOW)).toBeNull();
  });
  it('30 / 7 / 1 thresholds', () => {
    expect(reminderDue(doc('2026-12-04'), NOW)).toBe(30);
    expect(reminderDue(doc('2026-11-20'), NOW)).toBe(30);
    expect(reminderDue(doc('2026-11-11'), NOW)).toBe(7);
    expect(reminderDue(doc('2026-11-05'), NOW)).toBe(1);
    expect(reminderDue(doc('2026-11-04'), NOW)).toBe(1);
  });
  it('is idempotent: same or more urgent reminder already sent', () => {
    expect(reminderDue(doc('2026-11-20', 30), NOW)).toBeNull();
    expect(reminderDue(doc('2026-11-11', 30), NOW)).toBe(7);
    expect(reminderDue(doc('2026-11-11', 7), NOW)).toBeNull();
    expect(reminderDue(doc('2026-11-05', 7), NOW)).toBe(1);
  });
  it('skips straight to the most urgent threshold', () => expect(reminderDue(doc('2026-11-06', null), NOW)).toBe(7));
  it('one "expired" reminder within 30 days of expiry', () => {
    expect(reminderDue(doc('2026-11-03', 1), NOW)).toBe(0);
    expect(reminderDue(doc('2026-11-03', 0), NOW)).toBeNull();
    expect(reminderDue(doc('2026-08-01', null), NOW)).toBeNull();
  });
  it('copy', () => {
    expect(reminderCopy(7, 5)).toBe('expires in 5 days');
    expect(reminderCopy(1, 1)).toBe('expires in 1 day');
    expect(reminderCopy(1, 0)).toBe('expires today');
    expect(reminderCopy(0, -1)).toBe('expired 1 day ago');
  });
});

describe('catalog & guessing', () => {
  it('has unique types with complete metadata', () => {
    expect(new Set(DOC_TYPES.map((d) => d.type)).size).toBe(DOC_TYPES.length);
    for (const d of DOC_TYPES) expect(d.label && d.icon && d.description && d.category).toBeTruthy();
    expect(docTypeInfo('iso').expires).toBe(true);
    expect(docTypeInfo('gst').expires).toBe(false);
    expect(docTypeInfo('nope').type).toBe('other');
  });
  it.each([
    ['GST_REG06_Certificate.pdf', 'gst'],
    ['pan-card.jpg', 'pan'],
    ['Udyam Registration Certificate.pdf', 'udyam'],
    ['ISO 9001-2015 cert.pdf', 'iso'],
    ['Balance_Sheet_FY2023-24.pdf', 'balance_sheet'],
    ['CA turnover certificate UDIN.pdf', 'ca_turnover_certificate'],
    ['Dell OEM MAF.pdf', 'oem_authorization'],
    ['CRAC_NIC_2024.pdf', 'crac'],
    ['scan0001.pdf', 'other'],
  ])('%s → %s', (name, type) => expect(guessDocType(name)).toBe(type));
  it('guesses FY from filename', () => {
    expect(guessFinancialYear('Balance_Sheet_FY2023-24.pdf')).toBe('2023-24');
    expect(guessFinancialYear('bs 2022-2023.pdf')).toBe('2022-23');
    expect(guessFinancialYear('iso.pdf')).toBeNull();
  });
  it('suggests expiry from typical validity', () => {
    expect(suggestExpiry('iso', '2024-01-15')).toBe('2027-01-14');
    expect(suggestExpiry('gst', '2024-01-15')).toBeNull();
  });
});

/**
 * SC-007 / T041: ≥ 80% of 50 realistic Indian bid-document file names get the right type, including names
 * copied from GeM "Document required from seller" labels (vocabulary attributed in NOTICE).
 */
describe('guessDocType corpus (SC-007)', () => {
  const CORPUS: [string, string][] = [
    ['GST_REG06_2023.pdf', 'gst'],
    ['GSTIN Certificate Aarav Tech.pdf', 'gst'],
    ['Form GST REG-06.pdf', 'gst'],
    ['PAN_Card_Company.jpg', 'pan'],
    ['Company PAN.pdf', 'pan'],
    ['Udyam_Registration_Certificate.pdf', 'udyam'],
    ['MSME Certificate.pdf', 'udyam'],
    ['UDYAM-MH-26-0012345.pdf', 'udyam'],
    ['MSE_Relaxation_Proof.pdf', 'udyam'],
    ['DPIIT_Startup_Recognition.pdf', 'startup_dpiit'],
    ['Startup Relaxation document.pdf', 'startup_dpiit'],
    ['Certificate_of_Incorporation.pdf', 'incorporation'],
    ['Partnership Deed.pdf', 'incorporation'],
    ['MOA_AOA.pdf', 'incorporation'],
    ['Audited_Balance_Sheet_FY2023-24.pdf', 'balance_sheet'],
    ['BS_FY2024-25.pdf', 'balance_sheet'],
    ['Profit and Loss Account 2023-24.pdf', 'balance_sheet'],
    ['Financial Statements 2022-23.pdf', 'balance_sheet'],
    ['ITR_AY2024-25.pdf', 'itr'],
    ['ITR-V Acknowledgement.pdf', 'itr'],
    ['CA_Turnover_Certificate_UDIN.pdf', 'ca_turnover_certificate'],
    ['Bidder_Turnover_Last_3_Years.pdf', 'ca_turnover_certificate'],
    ['Minimum Average Annual Turnover.pdf', 'ca_turnover_certificate'],
    ['Average_Annual_Turnover_FY22-25.pdf', 'ca_turnover_certificate'],
    ['Dell_MAF_2026.pdf', 'oem_authorization'],
    ['HP OEM Authorization Certificate.pdf', 'oem_authorization'],
    ['Manufacturer Authorisation Form Lenovo.pdf', 'oem_authorization'],
    ['Acer Dealership Certificate.pdf', 'oem_authorization'],
    ['CRAC_NIC_2024.pdf', 'crac'],
    ['Performance Certificate CPWD.pdf', 'crac'],
    ['Past_Performance_Proof.pdf', 'crac'],
    ['Completion Certificate Railways.pdf', 'crac'],
    ['Satisfactory Performance Letter.pdf', 'crac'],
    ['Work_Order_BSNL.pdf', 'work_order'],
    ['Purchase Order 4500012345.pdf', 'work_order'],
    ['GeM Contract GEMC-511687712345678.pdf', 'work_order'],
    ['Experience_Criteria_Documents.pdf', 'work_order'],
    ['Years of Past Experience Required.pdf', 'work_order'],
    ['ISO_9001_2015_Certificate.pdf', 'iso'],
    ['ISO 27001 cert.pdf', 'iso'],
    ['BIS Licence IS 13252.pdf', 'bis'],
    ['Make_in_India_Declaration.pdf', 'mii_certificate'],
    ['MII Local Content Certificate Class-I.pdf', 'mii_certificate'],
    ['EMD Exemption Letter.pdf', 'emd_exemption'],
    ['Cancelled Cheque HDFC.jpg', 'bank_details'],
    ['Board_Resolution_Authorised_Signatory.pdf', 'power_of_attorney'],
    ['Power of Attorney.pdf', 'power_of_attorney'],
    ['Technical Datasheet Latitude 5440.pdf', 'product_catalogue'],
    ['Compliance of BoQ specification and supporting document.pdf', 'product_catalogue'],
    ['NABL Test Report.pdf', 'test_report'],
  ];

  it('has 50 names', () => expect(CORPUS).toHaveLength(50));

  it('guesses at least 80% correctly', () => {
    const wrong = CORPUS.filter(([name, type]) => guessDocType(name) !== type).map(([name, type]) => `${name}: expected ${type}, got ${guessDocType(name)}`);
    const accuracy = (CORPUS.length - wrong.length) / CORPUS.length;
    expect(accuracy, wrong.join('\n')).toBeGreaterThanOrEqual(0.8);
  });

  it('maps every GeM seller-document label to a catalog type that guessDocType recognises', () => {
    const types = new Set(DOC_TYPES.map((d) => d.type));
    for (const [label, type] of Object.entries(GEM_SELLER_DOC_LABELS)) {
      expect(types.has(type), label).toBe(true);
      expect(guessDocType(`${label.replace(/ /g, '_')}.pdf`), label).toBe(type);
    }
  });
});
