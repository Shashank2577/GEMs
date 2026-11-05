import { beforeAll, describe, expect, it } from 'vitest';
import { generateBidPdf, getSampleBidSpec, SAMPLE_BID_SPECS } from '../../src/analyse/sample-bid';
import { extractPages, isPdf, joinPages, looksScanned, splitPages, PdfTextError } from '../../src/analyse/pdf-text';
import {
  combineRequirements, extractRequirementsRules, flattenText, parseGemDateTime, parseIndianAmount,
  requirementsFromListing, splitDocumentList,
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
