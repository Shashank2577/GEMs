/** FR-073: the content script only obeys messages from this extension's own pages. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { makeMessageListener, type ContentActions } from '../src/listener';

const SCAN = { fillable: 1, forbidden: 0, unmatched: 0, noValue: 0, manual: 0, keys: ['make'] };
const REPORT = { filled: [], skipped: [], forbidden: 0, unmatched: 0 };

function setup(runtimeId = 'ext-id') {
  const actions: ContentActions = { scan: vi.fn(() => SCAN), fill: vi.fn(() => REPORT), clear: vi.fn() };
  // Fake chrome.runtime: register the listener the same way content.ts does.
  let listener: ReturnType<typeof makeMessageListener> | undefined;
  const fakeChrome = { runtime: { id: runtimeId, onMessage: { addListener: (l: typeof listener) => { listener = l; } } } };
  fakeChrome.runtime.onMessage.addListener(makeMessageListener(fakeChrome.runtime.id, actions));
  return { actions, send: (msg: unknown, senderId?: string) => { const respond = vi.fn(); listener!(msg as never, { id: senderId }, respond); return respond; } };
}

describe('content script sender check (FR-073)', () => {
  it('handles scan / fill / clear from the extension itself', () => {
    const { send, actions } = setup();
    expect(send({ type: 'tp:scan', fields: [] }, 'ext-id')).toHaveBeenCalledWith({ ok: true, scan: SCAN });
    expect(send({ type: 'tp:fill', fields: [] }, 'ext-id')).toHaveBeenCalledWith({ ok: true, report: REPORT });
    expect(send({ type: 'tp:clear' }, 'ext-id')).toHaveBeenCalledWith({ ok: true });
    expect(actions.clear).toHaveBeenCalledOnce();
  });

  it('ignores messages from another extension, a web page (no id) or an empty id', () => {
    const { send, actions } = setup();
    for (const id of ['other-ext', undefined, '']) {
      for (const msg of [{ type: 'tp:scan', fields: [] }, { type: 'tp:fill', fields: [] }, { type: 'tp:clear' }]) {
        expect(send(msg, id)).not.toHaveBeenCalled();
      }
    }
    expect(actions.scan).not.toHaveBeenCalled();
    expect(actions.fill).not.toHaveBeenCalled();
    expect(actions.clear).not.toHaveBeenCalled();
  });

  it('never acts when the runtime id is unknown', () => {
    const { send, actions } = setup('');
    expect(send({ type: 'tp:fill', fields: [] }, '')).not.toHaveBeenCalled();
    expect(actions.fill).not.toHaveBeenCalled();
  });

  it('reports action errors back to the extension', () => {
    const actions: ContentActions = { scan: () => { throw new Error('boom'); }, fill: vi.fn(), clear: vi.fn() };
    const respond = vi.fn();
    makeMessageListener('x', actions)({ type: 'tp:scan', fields: [] }, { id: 'x' }, respond);
    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'boom' });
  });
});

describe('manifest (FR-073)', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  it('injects the content script only on GeM over https and the localhost fixture', () => {
    const matches: string[] = manifest.content_scripts.flatMap((c: { matches: string[] }) => c.matches);
    expect(matches).toContain('https://*.gem.gov.in/*');
    expect(matches.filter((m) => !/^https:\/\/\*\.gem\.gov\.in\//.test(m))).toEqual(['http://localhost/*gem-form*', 'http://127.0.0.1/*gem-form*']);
    expect(matches.some((m) => m.startsWith('*://') || m.includes('<all_urls>'))).toBe(false);
  });
  it('requests exactly the storage and activeTab permissions (FR-067)', () => {
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'storage']);
  });
});
