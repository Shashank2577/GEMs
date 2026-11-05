// @vitest-environment jsdom
/** Popup fill report (T081; FR-075). */
import { describe, expect, it } from 'vitest';
import { clearFillReport, renderFillReport } from '../src/report';

describe('fill report', () => {
  it('lists filled and skipped fields with reasons, and can be cleared', () => {
    const root = document.createElement('section');
    renderFillReport(root, {
      filled: [{ key: 'make', label: 'Make', value: 'Dell' }],
      skipped: [{ key: 'model', label: 'Model', reason: 'already has a value' }, { key: 'mse_claim', label: 'MSE', reason: 'left for you — choose “Yes” yourself' }],
      forbidden: 3, unmatched: 4,
    });
    expect(root.hidden).toBe(false);
    expect(root.textContent).toContain('Filled (1)');
    expect(root.textContent).toContain('Make');
    expect(root.textContent).toContain('Dell');
    expect(root.textContent).toContain('Skipped (2)');
    expect(root.textContent).toContain('already has a value');
    expect(root.textContent).toContain('left for you');
    expect(root.textContent).toContain('3 protected field(s)');
    clearFillReport(root);
    expect(root.hidden).toBe(true);
    expect(root.children).toHaveLength(0);
  });
  it('renders values as text, never HTML', () => {
    const root = document.createElement('section');
    renderFillReport(root, { filled: [{ key: 'make', label: 'Make', value: '<img src=x onerror=alert(1)>' }], skipped: [], forbidden: 0, unmatched: 0 });
    expect(root.querySelector('img')).toBeNull();
  });
});
