import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { duplicateMessage, duplicateOf, renewDefaults, renewedMessage, renewFields, versionLine } from './renew';

describe('renewal copy and helpers (US6; FR-064, FR-066, FR-067)', () => {
  it('defaults the issue date to today in IST and suggests the expiry from the type', () => {
    // 20:00Z on 5 Nov is already 6 Nov in India.
    const now = new Date('2026-11-05T20:00:00Z');
    expect(renewDefaults({ type: 'iso', number: 'QMS-1' }, now)).toEqual({ issueDate: '2026-11-06', expiryDate: '2029-11-05', number: 'QMS-1' });
    expect(renewDefaults({ type: 'pan', number: null }, now)).toEqual({ issueDate: '2026-11-06', expiryDate: '', number: '' });
  });

  it('sends typed values, \'\' for cleared ones and omits fields that were always empty', () => {
    const initial = { issueDate: '2026-11-06', expiryDate: '2029-11-05', number: 'QMS-1' };
    expect(renewFields({ ...initial, number: ' QMS-2 ' }, initial)).toEqual({ issueDate: '2026-11-06', expiryDate: '2029-11-05', number: 'QMS-2' });
    expect(renewFields({ ...initial, number: '', issueDate: '' }, initial)).toEqual({ issueDate: '', expiryDate: '2029-11-05', number: '' });
    expect(renewFields({ issueDate: '2026-11-06', expiryDate: '', number: '' }, { issueDate: '2026-11-06', expiryDate: '', number: '' })).toEqual({ issueDate: '2026-11-06' });
  });

  it('formats the renewed toast', () => {
    expect(renewedMessage({ title: 'ISO 9001', expiryDate: '2029-11-03' })).toBe('“ISO 9001” renewed — valid till 03 Nov 2029');
    expect(renewedMessage({ title: 'PAN', expiryDate: null })).toBe('“PAN” renewed');
  });

  it('describes a version', () => {
    const v = { id: 'v', fileName: 'iso.pdf', mimeType: 'application/pdf', sizeBytes: 2048, pageCount: 1, expiryDate: '2026-11-14', replacedBy: { id: 'u', name: 'Asha' }, replacedAt: '2026-11-04T04:30:00Z', downloadUrl: '' };
    expect(versionLine(v, new Date('2026-11-04T06:30:00Z'))).toMatch(/^iso\.pdf · 2(\.0)? KB · replaced .+ by Asha$/);
    expect(versionLine({ ...v, replacedBy: null }, new Date('2026-11-04T06:30:00Z'))).not.toContain(' by ');
  });

  it('recognises the duplicate_document error and words the prompt', () => {
    const e = new ApiError(409, 'duplicate_document', 'dup', { existingId: 'abc', title: 'GST certificate' });
    expect(duplicateOf(e)).toEqual({ existingId: 'abc', title: 'GST certificate' });
    expect(duplicateOf(new ApiError(409, 'conflict', 'x'))).toBeNull();
    expect(duplicateOf(new Error('x'))).toBeNull();
    expect(duplicateMessage('GST certificate')).toBe('This file is already in your vault as “GST certificate”.');
  });
});
