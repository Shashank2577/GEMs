/** Pure accessibility helpers for the Documents step (T029; 006/NFR-006). */

/**
 * Roving-tabindex keyboard model for a horizontal tablist (WAI-ARIA APG "Tabs, automatic activation"):
 * Left/Right move to the previous/next tab and wrap, Home/End jump to the first/last. Returns the
 * index of the tab to focus and select, or null when the key is not a tab-navigation key.
 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight': return (current + 1) % count;
    case 'ArrowLeft': return (current - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/** Accessible name of the readiness ring, e.g. "Readiness 83 percent". */
export const readinessLabel = (percent: number) => `Readiness ${Math.round(percent)} percent`;
