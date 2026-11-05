import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasPageSearch } from './CommandPalette';

afterEach(() => { vi.unstubAllGlobals(); });

describe('hasPageSearch', () => {
  it('queries for an input registered with data-page-search', () => {
    const querySelector = vi.fn().mockReturnValue(null);
    vi.stubGlobal('document', { querySelector });
    expect(hasPageSearch()).toBe(false);
    expect(querySelector).toHaveBeenCalledWith('input[data-page-search]');
  });
  it('is true when the page registers one (feed owns "/")', () => {
    vi.stubGlobal('document', { querySelector: () => ({}) });
    expect(hasPageSearch()).toBe(true);
  });
});
