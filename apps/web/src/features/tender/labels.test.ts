import { describe, expect, it } from 'vitest';
import type { Requirement } from '@tp/core/contracts/analyse';
import type { TenderDocumentDto } from '@tp/core/contracts/analyse';
import { REQ_GROUPS, STALE_REASON_COPY, documentCheckPrefix, formatRequirementValue, mismatchedDocuments, staleReasonCopy } from './labels';

describe('staleReasonCopy (FR-043)', () => {
  it('falls back to the corrigendum copy when the reason is null or missing (legacy stale analyses)', () => {
    expect(staleReasonCopy(null)).toBe(STALE_REASON_COPY.corrigendum);
    expect(staleReasonCopy(undefined)).toBe(STALE_REASON_COPY.corrigendum);
  });

  it('returns reason-specific copy', () => {
    expect(staleReasonCopy('document_added')).toMatch(/document was added/);
    expect(staleReasonCopy('document_removed')).toMatch(/document was removed/);
  });
});

const R = (key: string, value: Requirement['value'], numeric: number | null = null): Requirement => ({
  key, label: key, value, numeric, mandatory: false, source: { page: 1, quote: key }, method: 'RULE', confidence: 0.95,
});
const groupOf = (r: Requirement) => REQ_GROUPS.find((g) => g.match(r))!.label;

describe('new FR-019 requirement keys (T037)', () => {
  it('group contract period, published date and consignee state under "Bid details"', () => {
    for (const k of ['contract_period', 'bid_published_at', 'consignee_state']) expect(groupOf(R(k, 'x'))).toBe('Bid details');
    expect(groupOf(R('mse_exemption', true))).toBe('EMD, ePBG & exemptions');
  });

  it('format them', () => {
    expect(formatRequirementValue(R('contract_period', '2 years', 24))).toBe('2 years (24 months)');
    expect(formatRequirementValue(R('contract_period', '1 year 6 months', 18))).toBe('1 year 6 months');
    expect(formatRequirementValue(R('bid_published_at', '2026-11-01T00:00:00+05:30'))).toBe('01 Nov 2026');
    expect(formatRequirementValue(R('bid_end', '2026-11-28T15:00:00+05:30'))).toBe('28 Nov 2026, 3:00 pm IST');
    expect(formatRequirementValue(R('consignee_state', 'Karnataka'))).toBe('Karnataka');
  });
});

describe('document check (T036)', () => {
  const doc = (id: string, bidNumberFound: string | null, createdAt: string) => ({ id, fileName: `${id}.pdf`, bidNumberFound, createdAt }) as TenderDocumentDto;
  it('lists mismatched documents that existed when the analysis ran', () => {
    const docs = [doc('ok', null, '2026-11-05T10:00:00Z'), doc('old', 'GEM/2026/B/1', '2026-11-05T10:00:00Z'), doc('later', 'GEM/2026/B/2', '2026-11-05T12:00:00Z')];
    expect(mismatchedDocuments({ updatedAt: '2026-11-05T11:00:00Z' }, docs).map((d) => d.id)).toEqual(['old']);
    expect(mismatchedDocuments({ updatedAt: '2026-11-05T11:00:00Z' }, undefined)).toEqual([]);
  });
  it('reads the summary prefix', () => {
    expect(documentCheckPrefix('Check documents: go-it-services.pdf is for GEM/2026/B/6120451. Go — 92/100 with 100% confidence.'))
      .toBe('Check documents: go-it-services.pdf is for GEM/2026/B/6120451.');
    expect(documentCheckPrefix('Go — 92/100.')).toBeNull();
    expect(documentCheckPrefix(null)).toBeNull();
  });
});
