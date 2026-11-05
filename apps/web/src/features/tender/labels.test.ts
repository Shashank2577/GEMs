import { describe, expect, it } from 'vitest';
import { STALE_REASON_COPY, staleReasonCopy } from './labels';

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
