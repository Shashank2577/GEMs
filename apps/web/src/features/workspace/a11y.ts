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

/**
 * Screen-reader announcements for packet reordering (dnd-kit `accessibility.announcements`; 006/NFR-006).
 * `ids` is the current order of the sortable ids, `titleOf` maps an id to the document title. Positions are 1-based.
 */
export interface ReorderAnnouncers {
  onDragStart(e: { active: { id: string | number } }): string;
  onDragOver(e: { active: { id: string | number }; over: { id: string | number } | null }): string;
  onDragEnd(e: { active: { id: string | number }; over: { id: string | number } | null }): string;
  onDragCancel(e: { active: { id: string | number } }): string;
}

export function packetReorderAnnouncements(ids: readonly string[], titleOf: (id: string) => string): ReorderAnnouncers {
  const total = ids.length;
  const title = (id: string | number) => titleOf(String(id));
  const pos = (id: string | number) => ids.indexOf(String(id)) + 1;
  return {
    onDragStart: ({ active }) => `Picked up ${title(active.id)}. Position ${pos(active.id)} of ${total}.`,
    onDragOver: ({ active, over }) => over
      ? `${title(active.id)} moved to position ${pos(over.id)} of ${total}.`
      : `${title(active.id)} is no longer over a position in the packet.`,
    onDragEnd: ({ active, over }) => over
      ? `Dropped ${title(active.id)}. Position ${pos(over.id)} of ${total}.`
      : `Dropped ${title(active.id)}. Position ${pos(active.id)} of ${total}, unchanged.`,
    onDragCancel: ({ active }) => `Reordering cancelled. ${title(active.id)} returned to position ${pos(active.id)} of ${total}.`,
  };
}
