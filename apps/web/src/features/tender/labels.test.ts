import { describe, expect, it } from 'vitest';
import type { Requirement } from '@tp/core/contracts/analyse';
import type { TenderDocumentDto } from '@tp/core/contracts/analyse';
import { REQ_GROUPS, STALE_REASON_COPY, documentCheckPrefix, failedAttemptCopy, formatRequirementValue, isAnalysisRunning, mismatchedDocuments, staleReasonCopy } from './labels';

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
    expect(mismatchedDocuments({ createdAt: '2026-11-05T11:00:00Z' }, docs).map((d) => d.id)).toEqual(['old']);
    expect(mismatchedDocuments({ createdAt: '2026-11-05T11:00:00Z' }, undefined)).toEqual([]);
  });
  it('reads the summary prefix', () => {
    expect(documentCheckPrefix('Check documents: go-it-services.pdf is for GEM/2026/B/6120451. Go — 92/100 with 100% confidence.'))
      .toBe('Check documents: go-it-services.pdf is for GEM/2026/B/6120451.');
    expect(documentCheckPrefix('Check documents: a.pdf is for GEM/2026/B/1; b.pdf is for GEM/2026/B/2. Go — see GEM/2026/B/1. Done.'))
      .toBe('Check documents: a.pdf is for GEM/2026/B/1; b.pdf is for GEM/2026/B/2.');
    expect(documentCheckPrefix('Check documents: a.pdf is for GEM/2026/B/1. Go — rebid of GEM/2026/B/1. Done.'))
      .toBe('Check documents: a.pdf is for GEM/2026/B/1.');
    expect(documentCheckPrefix('Go — 92/100.')).toBeNull();
    expect(documentCheckPrefix(null)).toBeNull();
  });
});

describe('run lifecycle copy (FR-028, FR-029)', () => {
  const now = new Date('2026-11-04T10:00:00Z');
  const done = { status: 'done' as const, updatedAt: '2026-11-04T07:00:00Z' };

  it('isAnalysisRunning only when lastAttempt is running', () => {
    expect(isAnalysisRunning(null)).toBe(false);
    expect(isAnalysisRunning({})).toBe(false);
    expect(isAnalysisRunning({ lastAttempt: { status: 'failed', error: 'x', at: now.toISOString() } })).toBe(false);
    expect(isAnalysisRunning({ lastAttempt: { status: 'running', error: null, at: now.toISOString() } })).toBe(true);
  });

  it('failedAttemptCopy shows the reason and the previous result time (US3 #15)', () => {
    expect(failedAttemptCopy({ ...done, lastAttempt: { status: 'failed', error: 'LLM provider down.', at: now.toISOString() } }, now))
      .toBe('The last re-analysis failed: LLM provider down. Showing the previous result from 3 hours ago.');
    expect(failedAttemptCopy({ ...done, lastAttempt: { status: 'failed', error: null, at: now.toISOString() } }, now))
      .toBe('The last re-analysis failed: unknown error. Showing the previous result from 3 hours ago.');
  });

  it('failedAttemptCopy is null without a failed attempt or without a previous result', () => {
    expect(failedAttemptCopy(done, now)).toBeNull();
    expect(failedAttemptCopy({ ...done, lastAttempt: { status: 'running', error: null, at: now.toISOString() } }, now)).toBeNull();
    expect(failedAttemptCopy({ status: 'failed', updatedAt: done.updatedAt, lastAttempt: { status: 'failed', error: 'boom', at: now.toISOString() } }, now)).toBeNull();
  });
});
