import { describe, expect, it } from 'vitest';
import { STALE_REASON_COPY, analysisWarningText, staleReasonCopy } from './labels';

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

describe('analysisWarningText (008/FR-031, FR-037)', () => {
  it('renders the spec copy', () => {
    expect(analysisWarningText({ code: 'llm_budget_exhausted', covered: 2, total: 5 }))
      .toBe('AI review covered 2 of 5 documents; the rest were checked by rules only.');
    expect(analysisWarningText({ code: 'llm_budget_exhausted', covered: 0, total: 1 }))
      .toBe('AI review covered 0 of 1 document; the rest were checked by rules only.');
    expect(analysisWarningText({ code: 'llm_quota_reached' })).toBe('Monthly AI review limit reached — this analysis used rules only.');
  });
});
