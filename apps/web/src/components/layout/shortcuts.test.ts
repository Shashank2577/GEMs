/** 002/US7 scenarios 5 and 11 (T096): G-then-key targets, "?" detection, typing guard and the dialog rows. */
import { describe, expect, it } from 'vitest';
import { NAV_MAIN, NAV_ORG } from './nav';
import { GOTO_KEYS, isHelpKey, isTypingTarget, shortcutGroups } from './shortcuts';

describe('GOTO_KEYS', () => {
  it('maps D/T/W/P/V/C/S/N to the main and organization pages', () => {
    expect(Object.fromEntries(Object.entries(GOTO_KEYS).map(([k, v]) => [k, v.to]))).toEqual({
      d: '/dashboard', t: '/tenders', w: '/watchlists', p: '/pipeline', v: '/vault', c: '/profile', s: '/settings', n: '/notifications',
    });
    const navTargets = [...NAV_MAIN, ...NAV_ORG].map((n) => n.to);
    for (const v of Object.values(GOTO_KEYS)) expect(navTargets).toContain(v.to);
  });
});

describe('isHelpKey', () => {
  it('accepts a plain "?" only', () => {
    expect(isHelpKey({ key: '?' })).toBe(true);
    expect(isHelpKey({ key: '?', ctrlKey: true })).toBe(false);
    expect(isHelpKey({ key: '?', metaKey: true })).toBe(false);
    expect(isHelpKey({ key: '?', altKey: true })).toBe(false);
    expect(isHelpKey({ key: '/' })).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it('treats inputs, textareas, selects and contenteditable as typing', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) expect(isTypingTarget({ tagName })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });
  it('lets shortcuts through elsewhere', () => {
    expect(isTypingTarget({ tagName: 'BODY' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('shortcutGroups', () => {
  it('lists ⌘K, /, ?, Esc and every G shortcut', () => {
    const groups = shortcutGroups('⌘');
    const keys = groups.flatMap((g) => g.rows.flatMap((r) => r.keys.map((seq) => seq.join(' '))));
    expect(keys).toEqual(expect.arrayContaining(['⌘ K', '/', '?', 'Esc', 'G D', 'G T', 'G W', 'G P', 'G V', 'G C', 'G S', 'G N']));
    expect(groups.find((g) => g.title === 'Go to')!.rows.find((r) => r.keys[0].join('') === 'GV')!.label).toBe('Document vault');
    expect(shortcutGroups('Ctrl')[0].rows[0].keys[0]).toEqual(['Ctrl', 'K']);
  });
});
