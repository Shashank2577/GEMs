import { describe, expect, it } from 'vitest';
import type { Requirement } from '@tp/core/contracts/analyse';
import type { TenderDocumentDto } from '@tp/core/contracts/analyse';
import { OCR_REQUIREMENT_TOOLTIP, isOcrDocument, ocrActionState, unreadableDocumentNotice, unreadableDocuments, REQ_GROUPS, STALE_REASON_COPY, analysisPanelState, analysisWarningText, documentCheckPrefix, failedAttemptCopy, formatRequirementValue, friendlyAnalysisError, truncatedDocuments, isAnalysisRunning, mismatchedDocuments, staleReasonCopy, staleSinceCopy } from './labels';

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

describe('stale banner copy per reason (FR-043)', () => {
  it('opens with the spec wording for every reason', () => {
    expect(staleReasonCopy('corrigendum')).toBe('A corrigendum changed this bid after it was analysed. The score below may be outdated.');
    expect(staleReasonCopy('profile_changed')).toBe('Your company profile changed since this analysis. Re-score to update the score.');
    expect(staleReasonCopy('vault_changed')).toBe('Your document vault changed since this analysis. Re-score to update the score.');
    expect(staleReasonCopy('weights_changed')).toMatch(/^Scoring weights changed/);
  });

  it('says when it became stale, relative to now', () => {
    const now = new Date('2026-11-05T12:00:00Z');
    expect(staleSinceCopy('2026-11-05T10:00:00Z', now)).toBe('since 2 hours ago');
    expect(staleSinceCopy('2026-11-05T11:59:50Z', now)).toBe('since just now');
    expect(staleSinceCopy('2026-11-05T12:05:00Z', now)).toBe('since just now'); // clock skew: never "since in 5 minutes"
    expect(staleSinceCopy(null, now)).toBeNull();
    expect(staleSinceCopy('garbage', now)).toBeNull();
  });
});

describe('analysisWarningText (008/FR-031, FR-037)', () => {
  it('renders the spec copy', () => {
    expect(analysisWarningText({ code: 'llm_budget_exhausted', covered: 2, total: 5 }))
      .toBe('AI review covered 2 of 5 documents; the rest were checked by rules only.');
    expect(analysisWarningText({ code: 'llm_budget_exhausted', covered: 0, total: 1 }))
      .toBe('AI review covered 0 of 1 document; the rest were checked by rules only.');
    expect(analysisWarningText({ code: 'llm_quota_reached' })).toBe('Monthly AI review limit reached — this analysis used rules only.');
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
      .toBe('The last re-analysis failed: something went wrong while reading the documents. Showing the previous result from 3 hours ago.');
    expect(failedAttemptCopy({ ...done, lastAttempt: { status: 'failed', error: 'timed out', at: now.toISOString() } }, now))
      .toBe('The last re-analysis failed: it took too long and timed out. Showing the previous result from 3 hours ago.');
    expect(failedAttemptCopy({ ...done, lastAttempt: { status: 'failed', error: null, at: now.toISOString() } }, now))
      .toBe('The last re-analysis failed: something went wrong while reading the documents. Showing the previous result from 3 hours ago.');
  });

  it('analysisPanelState: a first-ever run that timed out is failed with Try again, never "in progress" (S3)', () => {
    const at = now.toISOString();
    expect(analysisPanelState({ status: 'running', error: null, lastAttempt: { status: 'failed', error: 'timed out', at } })).toEqual({ kind: 'failed', error: 'timed out' });
    expect(analysisPanelState({ status: 'failed', error: 'timed out', lastAttempt: { status: 'failed', error: 'timed out', at } })).toEqual({ kind: 'failed', error: 'timed out' });
    expect(analysisPanelState({ status: 'running', error: null, lastAttempt: { status: 'running', error: null, at } })).toEqual({ kind: 'in_progress' });
    expect(analysisPanelState({ status: 'pending', error: null })).toEqual({ kind: 'in_progress' });
    expect(analysisPanelState({ status: 'failed', error: 'boom' })).toEqual({ kind: 'failed', error: 'boom' });
    expect(analysisPanelState({ status: 'done', error: null, lastAttempt: { status: 'failed', error: 'x', at } })).toEqual({ kind: 'result' });
  });

  it('failedAttemptCopy is null without a failed attempt or without a previous result', () => {
    expect(failedAttemptCopy(done, now)).toBeNull();
    expect(failedAttemptCopy({ ...done, lastAttempt: { status: 'running', error: null, at: now.toISOString() } }, now)).toBeNull();
    expect(failedAttemptCopy({ status: 'failed', updatedAt: done.updatedAt, lastAttempt: { status: 'failed', error: 'boom', at: now.toISOString() } }, now)).toBeNull();
  });

  it('friendlyAnalysisError hides raw provider/stack text but keeps timed out friendly (S6)', () => {
    expect(friendlyAnalysisError('timed out')).toBe('it took too long and timed out');
    expect(friendlyAnalysisError('ECONNREFUSED 10.0.0.4:5432 at Object.query (/srv/db.js:12)')).toBe('something went wrong while reading the documents');
    expect(friendlyAnalysisError(null)).toBe('something went wrong while reading the documents');
  });

  it('truncatedDocuments lists only documents whose pages were capped (S1)', () => {
    expect(truncatedDocuments([
      { fileName: 'a.pdf', pageCount: 150, totalPages: 280 }, { fileName: 'b.pdf', pageCount: 20, totalPages: 20 },
      { fileName: 'c.pdf', pageCount: 5, totalPages: null }, { fileName: 'd.pdf', pageCount: 5 },
    ])).toEqual([{ fileName: 'a.pdf', analysed: 150, total: 280 }]);
    expect(truncatedDocuments(undefined)).toEqual([]);
  });
});

describe('Re-score vs Re-analyse (004/FR-037)', () => {
  it('offers Re-score only for profile, vault and weights changes', async () => {
    const { canRescoreFor, staleReasonCopy } = await import('./labels');
    expect(['profile_changed', 'vault_changed', 'weights_changed'].map((r) => canRescoreFor(r as never))).toEqual([true, true, true]);
    expect(['corrigendum', 'document_added', 'document_removed', null, undefined].map((r) => canRescoreFor(r as never))).toEqual([false, false, false, false, false]);
    expect(staleReasonCopy('weights_changed')).toMatch(/^Scoring weights changed/);
    // Same set as the API, which answers 409 reanalysis_required for the others.
    const { isRescorableReason, STALE_REASONS } = await import('@tp/core/contracts/analyse');
    expect(STALE_REASONS.map((r) => canRescoreFor(r))).toEqual(STALE_REASONS.map((r) => isRescorableReason(r)));
    expect(staleReasonCopy('profile_changed')).toMatch(/Re-score to update the score\.$/);
    expect(staleReasonCopy('vault_changed')).toMatch(/Re-score to update the score\.$/);
  });
});

describe('OCR labels and decisions (004/FR-052)', () => {
  const doc = (hasText: boolean, textSource: 'pdf' | 'ocr' = 'pdf') => ({ hasText, textSource });
  const on = { ocrAvailable: true, canRun: true, running: false };

  it('offers the action only for text-less docs when OCR is configured and the user is analyst+', () => {
    expect(ocrActionState(doc(false), on)).toBe('available');
    expect(ocrActionState(doc(true), on)).toBe('hidden');
    expect(ocrActionState(doc(true, 'ocr'), on)).toBe('hidden');
    expect(ocrActionState(doc(false), { ...on, ocrAvailable: false })).toBe('hidden');
    expect(ocrActionState(doc(false), { ...on, canRun: false })).toBe('hidden');
  });

  it('shows the running state for the document being read', () => {
    expect(ocrActionState(doc(false), { ...on, running: true })).toBe('running');
  });

  it('uses the spec notice without OCR and points at the action with it', () => {
    expect(unreadableDocumentNotice('bid.pdf', false)).toBe("We couldn't read text from bid.pdf. Upload a text PDF or ask your admin to enable AI OCR.");
    expect(unreadableDocumentNotice('bid.pdf', true)).toContain('Read with AI (OCR)');
  });

  it('lists only documents without text and flags OCR text', () => {
    expect(unreadableDocuments([{ hasText: true }, { hasText: false, id: 'x' }])).toEqual([{ hasText: false, id: 'x' }]);
    expect(unreadableDocuments(undefined)).toEqual([]);
    expect(isOcrDocument({ textSource: 'ocr' })).toBe(true);
    expect(isOcrDocument({ textSource: 'pdf' })).toBe(false);
    expect(OCR_REQUIREMENT_TOOLTIP).toBe('Read by AI from a scanned page — check against the original');
  });
});
