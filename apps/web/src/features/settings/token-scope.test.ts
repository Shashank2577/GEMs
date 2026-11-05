import { describe, expect, it } from 'vitest';
import { TOKEN_SCOPE_OPTIONS, initialTokenScope, tokenScopeLabel } from './token-scope';

describe('token scope (FR-074)', () => {
  it('offers Full access and Extension (read-only)', () => {
    expect(TOKEN_SCOPE_OPTIONS.map((o) => [o.value, o.label])).toEqual([['full', 'Full access'], ['read', 'Extension (read-only)']]);
  });
  it('labels summaries; unknown/legacy tokens are full access', () => {
    expect(tokenScopeLabel('read')).toBe('Read-only');
    expect(tokenScopeLabel('full')).toBe('Full access');
    expect(tokenScopeLabel(undefined)).toBe('Full access');
  });
  it('reads ?scope= from the Submit step link', () => {
    expect(initialTokenScope('?scope=read')).toBe('read');
    expect(initialTokenScope('?scope=full')).toBe('full');
    expect(initialTokenScope('?scope=admin')).toBeNull();
    expect(initialTokenScope('')).toBeNull();
  });
});
