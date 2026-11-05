import { describe, expect, it } from 'vitest';
import {
  DOC_TYPES, GEM_SELLER_DOC_LABELS, daysUntilExpiry, docStatus, docTypeInfo, guessDocType, guessFinancialYear, istDate, nextReminder, reminderCopy, reminderDue, suggestExpiry,
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

describe('nextReminder (FR-053)', () => {
  it('null without an expiry date', () => {
    expect(nextReminder(null, null, NOW)).toBeNull();
    expect(nextReminder(undefined, 30, NOW)).toBeNull();
  });
  it('far expiry → 30 days before expiry, on expiry − 30', () => {
    expect(nextReminder('2027-06-01', null, NOW)).toEqual({ days: 30, date: '2027-05-02' });
  });
  it('after the 30-day reminder → 7 days before (acceptance 10)', () => {
    expect(nextReminder('2026-11-14', 30, NOW)).toEqual({ days: 7, date: '2026-11-07' });
  });
  it('a crossed but unsent threshold is due today (IST)', () => {
    expect(nextReminder('2026-11-14', null, NOW)).toEqual({ days: 30, date: '2026-11-04' });
    expect(nextReminder('2026-11-09', null, NOW)).toEqual({ days: 7, date: '2026-11-04' }); // 5 days left → 7 only
    expect(nextReminder('2026-11-11', 30, NOW)).toEqual({ days: 7, date: '2026-11-04' }); // exactly 7 days left
  });
  it('after the 7-day reminder → 1 day before', () => {
    expect(nextReminder('2026-11-09', 7, NOW)).toEqual({ days: 1, date: '2026-11-08' });
  });
  it('after the 1-day reminder → expiry notice (days 0) the day after expiry', () => {
    expect(nextReminder('2026-11-05', 1, NOW)).toEqual({ days: 0, date: '2026-11-06' });
    expect(nextReminder('2026-11-04', 1, NOW)).toEqual({ days: 0, date: '2026-11-05' }); // expires today
  });
  it('expiry notice due now (expired within 30 days, not yet sent) → today', () => {
    expect(nextReminder('2026-11-03', 1, NOW)).toEqual({ days: 0, date: '2026-11-04' });
    expect(nextReminder('2026-10-10', null, NOW)).toEqual({ days: 0, date: '2026-11-04' });
  });
  it('all reminders sent / too old → null', () => {
    expect(nextReminder('2026-11-03', 0, NOW)).toBeNull();
    expect(nextReminder('2026-10-01', null, NOW)).toBeNull(); // expired > 30 days ago
  });
  it('uses the IST calendar day of now', () => {
    // 5 Nov 2026 01:30 IST — 30 days to 2026-12-05 in IST (29 by the UTC date).
    expect(nextReminder('2026-12-05', null, new Date('2026-11-04T20:00:00Z'))).toEqual({ days: 30, date: '2026-11-05' });
    expect(nextReminder('2026-12-06', null, new Date('2026-11-04T20:00:00Z'))).toEqual({ days: 30, date: '2026-11-06' });
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
  // Held-out names as sellers actually save them: underscored, abbreviated, Hindi / mixed, camera and
  // scanner defaults. None is a verbatim GEM_SELLER_DOC_LABELS label (that is covered by the round-trip test).
  const CORPUS: [string, string][] = [
    ['GST_REG06_2023.pdf', 'gst'],
    ['gstin_cert_aarav.pdf', 'gst'],
    ['GST Registration (Form REG-06).pdf', 'gst'],
    ['जीएसटी पंजीकरण प्रमाणपत्र.pdf', 'gst'],
    ['PAN_Card_Company.jpg', 'pan'],
    ['company-pan-copy.pdf', 'pan'],
    ['पैन कार्ड.jpg', 'pan'],
    ['Udyam_Registration_Certificate.pdf', 'udyam'],
    ['MSME_cert_2024.pdf', 'udyam'],
    ['UDYAM-MH-26-0012345.pdf', 'udyam'],
    ['उद्यम प्रमाणपत्र.pdf', 'udyam'],
    ['DPIIT_Startup_Recog.pdf', 'startup_dpiit'],
    ['COI_AaravTech.pdf', 'incorporation'],
    ['Partnership Deed (notarised).pdf', 'incorporation'],
    ['MOA_AOA.pdf', 'incorporation'],
    ['Audited_BS_FY2023-24.pdf', 'balance_sheet'],
    ['BS FY24-25.pdf', 'balance_sheet'],
    ['P&L_2023-24.pdf', 'balance_sheet'],
    ['Fin Statements 2022-23.pdf', 'balance_sheet'],
    ['ITR_AY2024-25.pdf', 'itr'],
    ['ITR-V_ack_AY23-24.pdf', 'itr'],
    ['CA_Turnover_Cert_UDIN.pdf', 'ca_turnover_certificate'],
    ['Avg_Annual_TO_3yrs_CA.pdf', 'ca_turnover_certificate'],
    ['Turnover certificate last 3 FY.pdf', 'ca_turnover_certificate'],
    ['Dell_MAF_2026.pdf', 'oem_authorization'],
    ['HP_OEM_Auth_Letter.pdf', 'oem_authorization'],
    ['Lenovo Authorisation Letter.pdf', 'oem_authorization'],
    ['Acer_Dealership_Cert.pdf', 'oem_authorization'],
    ['CRAC_NIC_2024.pdf', 'crac'],
    ['Performance_Cert_CPWD.pdf', 'crac'],
    ['Completion Cert - Railways.pdf', 'crac'],
    ['Satisfactory_Report_ONGC.pdf', 'crac'],
    ['WO_BSNL_2023.pdf', 'work_order'],
    ['PO 4500012345 IOCL.pdf', 'work_order'],
    ['GeM_Contract_GEMC-511687712345678.pdf', 'work_order'],
    ['Supply_Order_DRDO.pdf', 'work_order'],
    ['ISO_9001_2015.pdf', 'iso'],
    ['ISO27001 certificate.pdf', 'iso'],
    ['BIS_CRS_Registration.pdf', 'bis'],
    ['MII_Declaration_Class1.pdf', 'mii_certificate'],
    ['Make in India self cert.pdf', 'mii_certificate'],
    ['EMD_Exemption.pdf', 'emd_exemption'],
    ['Cancelled_Cheque_HDFC.jpg', 'bank_details'],
    ['Board Resolution - Authorised Signatory.pdf', 'power_of_attorney'],
    ['POA_Ravi_Sharma.pdf', 'power_of_attorney'],
    ['Latitude_5440_Datasheet.pdf', 'product_catalogue'],
    ['NABL_Test_Report_Cable.pdf', 'test_report'],
    ['scan0001.pdf', 'other'],
    ['IMG_20240312_101522.jpg', 'other'],
    ['WhatsApp Image 2024-05-02 at 10.15.32.jpeg', 'other'],
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
