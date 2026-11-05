/** Global keyboard shortcuts (002/FR-046): "G then key" targets, the "?" help key and the list shown in the dialog. */

export const GOTO_KEYS: Record<string, { to: string; label: string }> = {
  d: { to: '/dashboard', label: 'Dashboard' },
  t: { to: '/tenders', label: 'Tenders' },
  w: { to: '/watchlists', label: 'Watchlists' },
  p: { to: '/pipeline', label: 'Pipeline' },
  v: { to: '/vault', label: 'Document vault' },
  c: { to: '/profile', label: 'Company profile' },
  s: { to: '/settings', label: 'Settings' },
  n: { to: '/notifications', label: 'Notifications' },
};

/** Window in which the second key of a "G then key" sequence counts. */
export const GOTO_WINDOW_MS = 1200;

/** True when the key event comes from somewhere the user is typing text (shortcuts must not fire there). */
export function isTypingTarget(t: { tagName?: string; isContentEditable?: boolean } | null | undefined) {
  return !!t && (!!t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(String(t.tagName).toUpperCase()));
}

/** "?" (Shift+/ on most layouts) without Ctrl/⌘/Alt opens the shortcuts dialog. */
export function isHelpKey(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) {
  return e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey;
}

export interface ShortcutRow { keys: string[][]; label: string }

/** Rows for the "Keyboard shortcuts" dialog. `keys` is a list of alternatives, each a key sequence. */
export function shortcutGroups(mod: string): { title: string; rows: ShortcutRow[] }[] {
  return [
    {
      title: 'General',
      rows: [
        { keys: [[mod, 'K'], ['/']], label: 'Open the command palette' },
        { keys: [['?']], label: 'Show keyboard shortcuts' },
        { keys: [['Esc']], label: 'Close a dialog, menu or the palette' },
      ],
    },
    {
      title: 'Go to',
      rows: Object.entries(GOTO_KEYS).map(([k, v]) => ({ keys: [['G', k.toUpperCase()]], label: v.label })),
    },
  ];
}

export const OPEN_SHORTCUTS_EVENT = 'tp:open-shortcuts';
export const openShortcuts = () => window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT));
