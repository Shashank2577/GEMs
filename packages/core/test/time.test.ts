import { describe, expect, it } from 'vitest';
import { dateTimeIST } from '../src/time';
import { dateTimeIST as fromPdfUtils } from '../src/packet/pdf-utils';

describe('dateTimeIST', () => {
  it('formats the IST wall clock', () => {
    expect(dateTimeIST(new Date('2026-11-04T09:15:00Z'))).toBe('4 Nov 2026, 2:45 PM IST');
    expect(dateTimeIST('2026-11-11T18:40:00Z')).toBe('12 Nov 2026, 12:10 AM IST');
    expect(dateTimeIST(null)).toBe('');
    expect(dateTimeIST('junk')).toBe('');
  });
  it('is still exported from packet/pdf-utils', () => expect(fromPdfUtils).toBe(dateTimeIST));
});
