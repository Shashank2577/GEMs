import { describe, expect, it } from 'vitest';
import { TEMPLATE_PLACEHOLDERS, unknownPlaceholders } from '@tp/core/packet/placeholders';
import { INSERTABLE_PLACEHOLDERS, placeholderLabel } from './labels';

describe('template editor palette (FR-041)', () => {
  it('lists exactly the supported placeholder paths', () => {
    expect(INSERTABLE_PLACEHOLDERS.map((p) => p.path)).toEqual(TEMPLATE_PLACEHOLDERS.map((p) => p.path));
    expect(unknownPlaceholders(INSERTABLE_PLACEHOLDERS.map((p) => `{{${p.path}}}`).join(' '))).toEqual([]);
  });

  it('labels every palette entry, keeping the profile-step wording where it exists', () => {
    for (const p of INSERTABLE_PLACEHOLDERS) expect(placeholderLabel(p.path)).not.toBe(p.path);
    expect(placeholderLabel('offer.make')).toBe('Make (Submit step)');
    expect(placeholderLabel('tender.bidNumber')).toBe('Bid number');
    expect(placeholderLabel('company.gstn')).toBe('company.gstn');
  });
});
