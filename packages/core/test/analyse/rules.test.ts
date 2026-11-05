import { beforeAll, describe, expect, it } from 'vitest';
import { generateBidPdf, getSampleBidSpec, SAMPLE_BID_SPECS } from '../../src/analyse/sample-bid';
import { extractPages, isPdf, joinPages, looksScanned, splitPages, PdfTextError } from '../../src/analyse/pdf-text';
import {
  combineRequirements, detectBidNumber, extractRequirementsRules, flattenText, inferIndianState, INDIAN_STATES, normalizeBidNumber,
  parseGemDateTime, parseIndianAmount, requirementsFromListing, splitDocumentList,
} from '../../src/analyse/rules';
import type { Requirement } from '../../src/analyse/types';

const pagesByKey = new Map<string, string[]>();
beforeAll(async () => {
  for (const s of SAMPLE_BID_SPECS) pagesByKey.set(s.key, await extractPages(await generateBidPdf(s)));
});

const req = (rs: Requirement[], key: string) => rs.find((r) => r.key === key);

describe('normalisers', () => {
  it('parses Indian amounts', () => {
    expect(parseIndianAmount('50 Lakh (s)')).toBe(5_000_000);
    expect(parseIndianAmount('1.5 Crore (s)')).toBe(15_000_000);
    expect(parseIndianAmount('2,16,000')).toBe(216_000);
    expect(parseIndianAmount('Rs. 25,000/-')).toBe(25_000);
    expect(parseIndianAmount('3 Lacs')).toBe(300_000);
    expect(parseIndianAmount('2 Cr.')).toBe(20_000_000);
    expect(parseIndianAmount('nothing')).toBeNull();
  });
  it('parses GeM IST date-times', () => {
    expect(parseGemDateTime('28-11-2026 15:00:00')).toBe('2026-11-28T15:00:00+05:30');
    expect(new Date(parseGemDateTime('1-2-2027 09:05')!).toISOString()).toBe('2027-02-01T03:35:00.000Z');
    expect(parseGemDateTime('soon')).toBeNull();
  });
  it('strips Devanagari and collapses whitespace', () => {
    expect(flattenText('बोली समाप्ति तिथि/समय/Bid End Date/Time\n  21-11-2026  18:00:00')).toBe('/Bid End Date/Time 21-11-2026 18:00:00');
  });
  it('splits the documents-required list without breaking parentheses', () => {
    expect(splitDocumentList(' Experience Criteria,Bidder Turnover,Certificate (Requested in ATC),OEM Authorization Certificate *In case any bidder'))
      .toEqual(['Experience Criteria', 'Bidder Turnover', 'Certificate (Requested in ATC)', 'OEM Authorization Certificate']);
  });
});

describe('pdf-text', () => {
  it('extracts one string per page and detects PDFs', async () => {
    const pages = pagesByKey.get('go-it-services')!;
    expect(pages).toHaveLength(4);
    expect(pages[0]).toContain('Bid End Date/Time');
    expect(pages[3]).toContain('Buyer Added Bid Specific Terms and Conditions');
    expect(splitPages(joinPages(pages))).toEqual(pages);
    expect(looksScanned(pages)).toBe(false);
    expect(looksScanned(['', ' '])).toBe(true);
    expect(isPdf(new TextEncoder().encode('%PDF-1.7 ...'))).toBe(true);
    await expect(extractPages(new TextEncoder().encode('hello'))).rejects.toBeInstanceOf(PdfTextError);
  });
});

describe('rules: round trip generate → extract → rules', () => {
  it('go-it-services: standard fields, page + quote provenance', () => {
    const rs = extractRequirementsRules(pagesByKey.get('go-it-services')!, { documentId: 'doc-1', fileName: 'bid.pdf' });
    const t = req(rs, 'turnover_min')!;
    expect(t.numeric).toBe(5_000_000);
    expect(t.method).toBe('RULE');
    expect(t.mandatory).toBe(true);
    expect(t.source).toMatchObject({ documentId: 'doc-1', fileName: 'bid.pdf', page: 1 });
    expect(t.source.quote).toContain('Minimum Average Annual Turnover of the bidder');
    expect(t.source.quote).toContain('50 Lakh');
    expect(t.confidence).toBeGreaterThanOrEqual(0.9);
    expect(req(rs, 'experience_years')!.numeric).toBe(3);
    expect(req(rs, 'emd')!.numeric).toBe(96_000);
    expect(req(rs, 'epbg')!.numeric).toBe(3);
    expect(req(rs, 'epbg_duration')!.numeric).toBe(14);
    expect(req(rs, 'mse_exemption')!.value).toBe(true);
    expect(req(rs, 'startup_exemption')!.value).toBe(true);
    expect(req(rs, 'mii')!.value).toBe(true);
    expect(req(rs, 'bid_end')!.value).toBe('2026-11-28T15:00:00+05:30');
    expect(req(rs, 'offer_validity')!.numeric).toBe(120);
    expect(req(rs, 'estimated_value')!.numeric).toBe(4_800_000);
    expect(req(rs, 'evaluation_method')!.value).toBe('Total value wise evaluation');
    expect(req(rs, 'ministry')!.value).toBe('Ministry of Electronics and Information Technology');
    expect(req(rs, 'delivery_days')!.numeric).toBe(30);
    expect(req(rs, 'delivery_days')!.source.page).toBe(3);
    const sim = req(rs, 'similar_work')!;
    expect(sim.numeric).toBe(1_920_000);
    expect(sim.source.page).toBe(4);
    expect(rs.filter((r) => r.key === 'document').map((r) => r.value)).toEqual([
      'Experience Criteria', 'Bidder Turnover', 'Certificate (Requested in ATC)', 'Additional Doc 1 (Requested in ATC)',
    ]);
    expect(rs.filter((r) => r.key === 'certificate').map((r) => r.value)).toEqual(['ISO 9001']);
    expect(rs.some((r) => r.key === 'undertaking' && r.value === 'non_blacklisting')).toBe(true);
    expect(req(rs, 'oem_auth')).toBeUndefined();
  });

  it('review-hardware-oem: crore amounts, OEM authorisation, BIS, past performance', () => {
    const rs = extractRequirementsRules(pagesByKey.get('review-hardware-oem')!);
    expect(req(rs, 'turnover_min')!.numeric).toBe(15_000_000);
    expect(req(rs, 'oem_turnover')!.numeric).toBe(2_000_000_000);
    expect(req(rs, 'experience_years')!.numeric).toBe(2);
    expect(req(rs, 'past_performance')!.numeric).toBe(20);
    expect(req(rs, 'emd')!.numeric).toBe(216_000);
    expect(req(rs, 'bid_to_ra')!.value).toBe(true);
    expect(req(rs, 'oem_auth')).toMatchObject({ value: true, mandatory: true });
    expect(rs.filter((r) => r.key === 'certificate').map((r) => r.value)).toEqual(['BIS']);
    expect(req(rs, 'similar_work')).toBeUndefined();
  });

  it('nogo-experience: 5 years, 80% similar work, no MII / exemptions', () => {
    const rs = extractRequirementsRules(pagesByKey.get('nogo-experience')!);
    expect(req(rs, 'experience_years')!.numeric).toBe(5);
    expect(req(rs, 'experience_years')!.confidence).toBe(0.95); // from Bid Details, not the ATC sentence
    expect(req(rs, 'mse_exemption')!.value).toBe(false);
    expect(req(rs, 'mii')!.value).toBe(false);
    expect(req(rs, 'similar_work')!.numeric).toBe(2_000_000);
  });

  it('emd-exempt-mse: no ePBG, single packet, item-wise evaluation', () => {
    const rs = extractRequirementsRules(pagesByKey.get('emd-exempt-mse')!);
    expect(req(rs, 'emd')!.numeric).toBe(67_500);
    expect(req(rs, 'epbg')).toBeUndefined();
    expect(req(rs, 'bid_type')!.value).toBe('Single Packet Bid');
    expect(req(rs, 'evaluation_method')!.value).toBe('Item wise evaluation');
    expect(req(rs, 'turnover_min')!.numeric).toBe(3_000_000);
    expect(req(rs, 'mse_exemption')!.value).toBe(true);
  });

  it('every requirement carries page, quote, method and confidence', () => {
    for (const s of SAMPLE_BID_SPECS) {
      for (const r of extractRequirementsRules(pagesByKey.get(s.key)!)) {
        expect(r.method).toBe('RULE');
        expect(r.source.page).toBeGreaterThan(0);
        expect(r.source.quote?.length).toBeGreaterThan(3);
        expect(r.confidence).toBeGreaterThan(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
      }
    }
    expect(getSampleBidSpec('nope')).toBeUndefined();
  });
});

describe('rules: robustness on raw text', () => {
  it('handles bilingual labels, wrapped labels and odd spacing', () => {
    const page = [
      'बोली समाप्ति तिथि/समय/Bid End Date/Time 21-11-2026 18:00:00',
      'न्यूनतम औसत वार्षिक टर्नओवर/Minimum Average Annual Turnover of the bidder (For 3 2 Crore (s)',
      'Years)',
      'वर्षों का अनुभव/Years of Past Experience Required for same/similar 3 Year (s)',
      'service',
      'एमएसई/MSE Exemption for Years Of Experience and हाँ/Yes',
      'Turnover',
      'स्टार्टअप/Startup Exemption for Years Of Experience and नहीं/No',
      'Turnover',
      'ईएमडी राशि/EMD Amount    1,50,000',
    ].join('\n');
    const rs = extractRequirementsRules([page]);
    expect(req(rs, 'bid_end')!.value).toBe('2026-11-21T18:00:00+05:30');
    expect(req(rs, 'turnover_min')!.numeric).toBe(20_000_000);
    expect(req(rs, 'experience_years')!.numeric).toBe(3);
    expect(req(rs, 'mse_exemption')!.value).toBe(true);
    expect(req(rs, 'startup_exemption')!.value).toBe(false);
    expect(req(rs, 'emd')!.numeric).toBe(150_000);
    expect(req(rs, 'turnover_min')!.source.quote).not.toMatch(/[ऀ-ॿ]/);
  });

  it('reads experience from ATC prose and absolute similar-work values', () => {
    const rs = extractRequirementsRules([
      'Terms. The bidder should have at least three years of experience in supply of lab equipment. ' +
      'Bidder must have executed one similar work of value not less than Rs. 12 Lakh in the last 3 years.',
    ]);
    expect(req(rs, 'experience_years')).toMatchObject({ numeric: 3, confidence: 0.75 });
    expect(req(rs, 'similar_work')!.numeric).toBe(1_200_000);
  });

  it('returns nothing for unrelated text', () => {
    expect(extractRequirementsRules(['Lorem ipsum dolor sit amet.'])).toEqual([]);
  });

  it('a corrigendum supersedes single-valued keys; listing data fills gaps', () => {
    const bid = extractRequirementsRules(['Bid End Date/Time 21-11-2026 18:00:00 EMD Amount 50,000 Document required from seller Experience Criteria']);
    const corr = extractRequirementsRules(['Bid End Date/Time 28-11-2026 18:00:00 Document required from seller Bidder Turnover']);
    const listing = requirementsFromListing({ estimatedValue: 1_000_000, emdAmount: 99, endAt: new Date('2026-01-01T00:00:00Z') });
    const all = combineRequirements([bid, corr], listing);
    expect(req(all, 'bid_end')!.value).toBe('2026-11-28T18:00:00+05:30');
    expect(req(all, 'emd')!.numeric).toBe(50_000);
    expect(req(all, 'estimated_value')).toMatchObject({ numeric: 1_000_000, confidence: 0.7 });
    expect(all.filter((r) => r.key === 'document').map((r) => r.value).sort()).toEqual(['Bidder Turnover', 'Experience Criteria']);
  });
});

describe('rules: newer GeM label variants (FR-018, FR-019)', () => {
  it('reads "MSE/Startup Relaxation for Years Of Experience and Turnover" with "Yes | Complete" / "No | Complete" (US2 #11)', () => {
    const rs = extractRequirementsRules([[
      'एमएसई छूट/MSE Relaxation for Years Of Experience and Turnover Yes | Complete',
      'स्टार्टअप छूट/Startup Relaxation for Years Of Experience and Turnover No | Complete',
      'Document required from seller Experience Criteria,Bidder Turnover',
    ].join('\n')]);
    expect(req(rs, 'mse_exemption')).toMatchObject({ value: true, confidence: 0.95, method: 'RULE' });
    expect(req(rs, 'startup_exemption')).toMatchObject({ value: false });
    expect(req(rs, 'mse_exemption')!.source.quote).toContain('MSE Relaxation');
  });

  it('reads the Relaxation labels without "and Turnover" and when the label wraps around the value', () => {
    const rs = extractRequirementsRules([
      'MSE Relaxation for Years Of Experience No | Complete\nStartup Relaxation for Years Of Yes | Complete\nExperience and Turnover',
    ]);
    expect(req(rs, 'mse_exemption')!.value).toBe(false);
    expect(req(rs, 'startup_exemption')!.value).toBe(true);
  });

  it('extracts contract_period (→ months) and bid_published_at from "Dated:" (US2 #12)', () => {
    const rs = extractRequirementsRules([
      'Bid Number: GEM/2026/B/6200101 Dated: 01-11-2026 Bid Details Bid End Date/Time 21-11-2026 15:00:00 ' +
      'Item Category Security Manpower Service (Version 2.0) Contract Period 2 Year(s) Minimum Average Annual Turnover of the bidder (For 3 Years) 1 Crore (s)',
    ]);
    expect(req(rs, 'contract_period')).toMatchObject({ value: '2 years', numeric: 24, mandatory: false, confidence: 0.95 });
    expect(req(rs, 'bid_published_at')).toMatchObject({ value: '2026-11-01T00:00:00+05:30', mandatory: false });
    expect(req(rs, 'item_category')!.value).toBe('Security Manpower Service (Version 2.0)');
    expect(req(rs, 'turnover_min')!.numeric).toBe(10_000_000);
  });

  it('adds up mixed contract periods and ignores prose about "the contract period"', () => {
    const one = (t: string) => req(extractRequirementsRules([t]), 'contract_period');
    expect(one('Contract Period 1 Year(s) 6 Month(s) Item Category X')).toMatchObject({ value: '1 year 6 months', numeric: 18 });
    expect(one('Contract Period 90 Day(s)')).toMatchObject({ value: '90 days', numeric: 3 });
    expect(one('Contract Period / 6 Month(s)')).toMatchObject({ value: '6 months', numeric: 6 });
    expect(one('Rates shall remain firm during the contract period of 2 years.')).toBeUndefined();
    expect(one('Contract Period: as per ATC')).toBeUndefined();
  });

  it('reads "Dated:" only on page 1 and not from prose "dated 23.03.2012"', () => {
    const rs = extractRequirementsRules(['Order, 2012 dated 23.03.2012 issued by Ministry', 'Corrigendum Dated: 05-11-2026']);
    expect(req(rs, 'bid_published_at')).toBeUndefined();
  });

  it('treats "Years of Past Experience Required for same/similar service" as the experience label', () => {
    const rs = extractRequirementsRules(['Years of Past Experience Required for same/similar service 3 Year (s) MSE Exemption for Years Of Experience and Turnover No']);
    expect(req(rs, 'experience_years')).toMatchObject({ numeric: 3, confidence: 0.95 });
    expect(req(rs, 'experience_years')!.source.quote).toContain('for same/similar service');
  });

  it('reads delivery days from the consignee table (last column of the first row)', () => {
    const page = 'Consignees/Reporting Officer and Quantity S.No. Consignee/Reporting Officer Address Quantity Delivery Days ' +
      '1 Anil Kumar *********** 560001,MG Road, Bengaluru, Karnataka 25 30 2 Ravi S *********** 411001,Pune, Maharashtra 5 45 Buyer Added Bid Specific Terms';
    const rs = extractRequirementsRules([page]);
    expect(req(rs, 'delivery_days')).toMatchObject({ value: '30 days', numeric: 30 });
    expect(req(rs, 'consignee_state')).toMatchObject({ value: 'Karnataka', confidence: 0.8, mandatory: false });
  });
});

describe('review fixes (GEM-168)', () => {
  it('parseIndianAmount ignores durations and parenthesised text before the amount', () => {
    expect(parseIndianAmount('3 Years 50 Lakh')).toBe(5_000_000);
    expect(parseIndianAmount('(For 3 Years) 1.2 Crore (s)')).toBe(12_000_000);
    expect(parseIndianAmount('39,00,000 and 1.2 Crore')).toBe(3_900_000);
    const one = (t: string, k: string) => req(extractRequirementsRules([t]), k);
    expect(one('Minimum Average Annual Turnover of the bidder 3 Years 50 Lakh (s)', 'turnover_min')!.numeric).toBe(5_000_000);
    expect(one('OEM Average Turnover 3 years 200 Crore (s)', 'oem_turnover')!.numeric).toBe(2_000_000_000);
  });

  it('a corrigendum\'s own "Dated:" does not replace the bid publication date', () => {
    const bid = extractRequirementsRules(['Bid Number: GEM/2026/B/1 Dated: 01-11-2026 Bid End Date/Time 21-11-2026 18:00:00']);
    const corr = extractRequirementsRules(['Corrigendum Dated: 10-11-2026 Bid End Date/Time 28-11-2026 18:00:00']);
    const all = combineRequirements([bid, corr]);
    expect(req(all, 'bid_published_at')!.value).toBe('2026-11-01T00:00:00+05:30');
    expect(req(all, 'bid_end')!.value).toBe('2026-11-28T18:00:00+05:30');
    expect(req(combineRequirements([corr]), 'bid_published_at')!.value).toBe('2026-11-10T00:00:00+05:30');
  });

  it('contract_period from an ATC heading on a later page is low confidence', () => {
    const one = (pages: string[]) => req(extractRequirementsRules(pages), 'contract_period');
    expect(one(['Contract Period 2 Year(s)'])!.confidence).toBe(0.95);
    expect(one(['Bid Details', 'ATC: 4. Contract Period 3 Years extendable by one year'])).toMatchObject({ numeric: 36, confidence: 0.8 });
    expect(one(['Bid Details', 'Contract Period: 2 years from the date of award'])!.confidence).toBeLessThan(0.9);
  });

  it('delivery days survive "2 <word>" inside the first consignee address', () => {
    const rs = extractRequirementsRules(['Delivery Days 1 Anil Kumar 110001, 2 Lodhi Road, New Delhi 25 30']);
    expect(req(rs, 'delivery_days')).toMatchObject({ value: '30 days', numeric: 30 });
    const two = extractRequirementsRules(['Delivery Days 1 Anil Kumar 110001, 2 Lodhi Road, New Delhi 25 30 2 Ravi S 411001, Pune 5 45']);
    expect(req(two, 'delivery_days')!.numeric).toBe(30);
  });

  it('consignee state is the last state of the first row, not a bank name in the address', () => {
    const rs = extractRequirementsRules([
      'Consignees/Reporting Officer and Quantity S.No. Delivery Days 1 Anil Kumar 122001, Punjab National Bank Building, Sector 5, Gurugram, Haryana 25 30 ' +
      '2 Ravi S 411001, Pune, Maharashtra 5 45 Buyer Added Bid Specific Terms',
    ]);
    expect(req(rs, 'consignee_state')!.value).toBe('Haryana');
  });
});

describe('rules: values interleaved inside wrapped labels (T035 corpus findings)', () => {
  it('reads a value printed between the two lines of a wrapped English label', () => {
    const page = [
      'बिड पेशकश वैधता/Bid Offer Validity (From End 60 (Days)', 'Date)',
      'अनुमानित बिड मूल्य/Estimated Bid Value 39,00,000',
      'टर्नओवर/Minimum Average 1.2 Crore (s)', 'Annual Turnover of the bidder (For 3 Years)',
      'टर्नओवर/OEM Average 250 Crore (s)', 'Turnover (Last 3 Years)',
      'अनुभव/Years of Past 2 Year (s)', 'Experience Required for same/ similar service',
      'छूट/Startup Relaxation for No | Complete', 'Years Of Experience and Turnover',
      'बिड का प्रकार/Type of Bid Two Packet Bid',
      'समय/Time 2 Days', 'allowed for Technical Clarifications during technical evaluation',
      'मूल्यांकन पद्धति/Evaluation Method Total value wise evaluation',
    ].join('\n');
    const rs = extractRequirementsRules([page]);
    expect(req(rs, 'offer_validity')!.numeric).toBe(60);
    expect(req(rs, 'estimated_value')!.numeric).toBe(3_900_000);
    expect(req(rs, 'turnover_min')).toMatchObject({ value: '1.2 Crore (s)', numeric: 12_000_000 });
    expect(req(rs, 'turnover_min')!.source.quote).toContain('Annual Turnover of the bidder');
    expect(req(rs, 'oem_turnover')!.numeric).toBe(2_500_000_000);
    expect(req(rs, 'experience_years')!.numeric).toBe(2);
    expect(req(rs, 'startup_exemption')!.value).toBe(false);
    expect(req(rs, 'bid_type')!.value).toBe('Two Packet Bid');
    expect(req(rs, 'evaluation_method')!.value).toBe('Total value wise evaluation');
  });

  it('a label head without enough of its tail is not a label', () => {
    expect(req(extractRequirementsRules(['Time 2 Days for the vendor. Evaluation Method L1']), 'evaluation_method')!.value).toBe('L1');
    expect(req(extractRequirementsRules(['Minimum Average speed 40 km/h']), 'turnover_min')).toBeUndefined();
  });

  it('keeps "Past Performance" inside the documents list as a document', () => {
    const rs = extractRequirementsRules(['Past Performance 30 % Document required from seller Experience Criteria,Past Performance,Bidder Turnover *In case any bidder']);
    expect(req(rs, 'past_performance')!.numeric).toBe(30);
    expect(rs.filter((r) => r.key === 'document').map((r) => r.value)).toEqual(['Experience Criteria', 'Past Performance', 'Bidder Turnover']);
  });

  it('parseIndianAmount takes the first amount in the text', () => {
    expect(parseIndianAmount('39,00,000 /Minimum Average 1.2 Crore (s)')).toBe(3_900_000);
    expect(parseIndianAmount('Rs. 1.2 Crore')).toBe(12_000_000);
  });
});

describe('consignee_state (FR-019)', () => {
  it('reads the first consignee state from the consignee block of every sample bid', () => {
    const want: Record<string, string> = { 'go-it-services': 'Delhi', 'review-hardware-oem': 'Haryana', 'nogo-experience': 'Uttar Pradesh', 'emd-exempt-mse': 'Madhya Pradesh' };
    for (const s of SAMPLE_BID_SPECS) {
      const rs = extractRequirementsRules(pagesByKey.get(s.key)!, { fileName: `${s.key}.pdf` });
      const r = req(rs, 'consignee_state')!;
      expect(r.value).toBe(want[s.key]);
      expect(r.source).toMatchObject({ page: req(rs, 'delivery_days')!.source.page, fileName: `${s.key}.pdf` });
      expect(r.source.quote).toContain(want[s.key]);
    }
  });

  it('ignores states outside the consignee block (ministry, office, ATC)', () => {
    const rs = extractRequirementsRules([
      'Ministry/State Name Maharashtra Office Name Pune Consignees/Reporting Officer and Quantity 1 Officer 110003, Lodhi Road, New Delhi 1 30 ' +
      'Technical Specifications Make in Gujarat preferred',
    ]);
    expect(req(rs, 'consignee_state')!.value).toBe('Delhi');
    expect(req(extractRequirementsRules(['Ministry/State Name Maharashtra Office Name Pune']), 'consignee_state')).toBeUndefined();
  });

  it('inferIndianState: word-bounded, longest match, aliases', () => {
    expect(inferIndianState('Plot 4, Goalpara Road, Guwahati, Assam')!.state).toBe('Assam');
    expect(inferIndianState('Bhubaneswar, Orissa-751001')!.state).toBe('Odisha');
    expect(inferIndianState('Jammu & Kashmir Bank, Srinagar')!.state).toBe('Jammu and Kashmir');
    expect(inferIndianState('Dadra and Nagar Haveli and Daman and Diu')!.state).toBe('Dadra and Nagar Haveli and Daman and Diu');
    expect(inferIndianState('Andhra   Pradesh')!.state).toBe('Andhra Pradesh');
    expect(inferIndianState('Goalpara, Bengaluru')).toBeNull();
    expect(INDIAN_STATES).toHaveLength(36);
  });
});

describe('detectBidNumber (FR-010)', () => {
  it('finds the bid number printed on page 1 of every sample bid', () => {
    for (const s of SAMPLE_BID_SPECS) expect(detectBidNumber(pagesByKey.get(s.key)!)).toBe(s.bidNumber);
  });

  it('prefers the page-1 header over a bid number quoted in the body', () => {
    const body = 'x'.repeat(900);
    const page1 = `Bid Number: GEM/2026/B/6133872 Dated: 01-11-2026 ${body} supersedes earlier bid GEM/2025/B/1111111 ${body}`;
    expect(detectBidNumber([page1, 'GEM/2026/B/9999999'])).toBe('GEM/2026/B/6133872');
  });

  it('falls back to the page-1 footer and ignores later pages', () => {
    const page1 = `${'Bid Details '.repeat(100)} GEM/2026/B/6140019 | Page 1`;
    expect(detectBidNumber([page1])).toBe('GEM/2026/B/6140019');
    expect(detectBidNumber(['Additional terms and conditions', 'Bid Number: GEM/2026/B/6140019'])).toBeNull();
  });

  it('reads a header bid number straddling the header boundary in full, not truncated', () => {
    const page1 = `${'x'.repeat(790)} GEM/2026/B/6133872 ${'y'.repeat(2000)}`; // starts at 791, ends past 800
    expect(detectBidNumber([page1])).toBe('GEM/2026/B/6133872');
  });

  it('only accepts a footer match that starts inside the footer window', () => {
    const tail = ' | Page 1';
    const n = 'GEM/2026/B/6140019';
    // Starts 5 chars before the 400-char footer window: neither header nor footer.
    const outside = `${'x'.repeat(2000)} ${n}${'z'.repeat(400 - tail.length - n.length + 5)}${tail}`;
    expect(detectBidNumber([outside])).toBeNull();
    const inside = `${'x'.repeat(2000)} ${n}${tail}`;
    expect(detectBidNumber([inside])).toBe(n);
  });

  it('tolerates spacing and case and returns null without text', () => {
    expect(detectBidNumber(['Bid Number : gem / 2026 / r / 42 '])).toBe('GEM/2026/R/42');
    expect(detectBidNumber([''])).toBeNull();
    expect(detectBidNumber([])).toBeNull();
    expect(normalizeBidNumber('GEM-2026-B-1')).toBeNull();
    expect(normalizeBidNumber(null)).toBeNull();
  });
});
