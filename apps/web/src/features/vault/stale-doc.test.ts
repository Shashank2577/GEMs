import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { DOC_NOT_FOUND_MESSAGE, isStaleDocLink } from './api';

describe('?doc=<id> not found (T039; FR-040)', () => {
  const notFound = new ApiError(404, 'not_found', 'Document not found');
  it('uses the spec copy', () => expect(DOC_NOT_FOUND_MESSAGE).toBe('That document could not be found. It may have been deleted.'));
  it('fires only for a 404 on an id that is not in the loaded list', () => {
    expect(isStaleDocLink('abc', false, notFound)).toBe(true);
    expect(isStaleDocLink('abc', true, notFound)).toBe(false);
    expect(isStaleDocLink(null, false, notFound)).toBe(false);
    expect(isStaleDocLink('abc', false, new ApiError(500, 'internal', 'boom'))).toBe(false);
    expect(isStaleDocLink('abc', false, null)).toBe(false);
  });
});
