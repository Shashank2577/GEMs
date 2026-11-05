/** Adapts real page controls to the pure `FillTarget` interface used by fill.ts. */
import type { FieldDescriptor } from '@tp/core/assist/allowlist';
import { pickOption, type FillTarget, type MarkState } from './fill';

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const TEXT_TYPES = new Set(['', 'text', 'number', 'email', 'tel', 'search', 'url']);

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

function labelFor(el: Control): string {
  const parts: string[] = [];
  if ('labels' in el && el.labels) for (const l of Array.from(el.labels)) parts.push(l.textContent ?? '');
  const by = el.getAttribute('aria-labelledby');
  if (by) for (const id of by.split(/\s+/)) parts.push(el.ownerDocument.getElementById(id)?.textContent ?? '');
  const wrap = el.closest('label');
  if (wrap) parts.push(wrap.textContent ?? '');
  return clean(parts.join(' '));
}

/** Nearby text: previous table cell / previous sibling / column header (GeM uses tables heavily). */
function contextFor(el: Control): string {
  const parts: string[] = [];
  const cell = el.closest('td,th');
  if (cell) {
    const prev = cell.previousElementSibling;
    if (prev) parts.push(prev.textContent ?? '');
    const row = cell.parentElement;
    const table = cell.closest('table');
    const idx = row ? Array.from(row.children).indexOf(cell) : -1;
    const head = table?.querySelector('thead tr, tr');
    if (head && head !== row && idx >= 0) parts.push(head.children[idx]?.textContent ?? '');
  }
  const prevSib = el.previousElementSibling;
  if (prevSib && !/^(INPUT|SELECT|TEXTAREA)$/.test(prevSib.tagName)) parts.push(prevSib.textContent ?? '');
  return clean(parts.join(' '));
}

function visible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return true;
}

function setNative(el: Control, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const MARK_STYLE: Record<MarkState, string> = {
  available: '2px dashed #6366f1',
  filled: '2px solid #10b981',
  blocked: '2px solid #f43f5e',
  none: '',
};

export function descriptorOf(el: Control): FieldDescriptor {
  return {
    tagName: el.tagName.toLowerCase(),
    type: el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase(),
    name: el.getAttribute('name'), id: el.id || null, label: labelFor(el), placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'), context: contextFor(el),
  };
}

export function toTarget(el: Control): FillTarget {
  return {
    descriptor: descriptorOf(el),
    kind: el instanceof HTMLSelectElement ? 'select' : el instanceof HTMLTextAreaElement ? 'textarea' : 'input',
    disabled: el.disabled,
    readOnly: 'readOnly' in el ? el.readOnly : false,
    getValue: () => (el instanceof HTMLSelectElement ? (el.selectedIndex > 0 ? el.value : '') : el.value),
    setValue(v) {
      if (el instanceof HTMLSelectElement) {
        const opt = pickOption(Array.from(el.options).map((o) => ({ value: o.value, text: o.text })), v);
        if (opt == null) return false;
        setNative(el, opt);
        return true;
      }
      if (el instanceof HTMLInputElement && el.type === 'number' && Number.isNaN(Number(v))) return false;
      setNative(el, v);
      return true;
    },
    mark(state, note) {
      el.style.outline = MARK_STYLE[state];
      el.style.outlineOffset = state === 'none' ? '' : '2px';
      if (state === 'none') { el.removeAttribute('data-tp-state'); el.removeAttribute('title'); return; }
      el.setAttribute('data-tp-state', state);
      if (note) el.setAttribute('title', note);
    },
  };
}

/** Every visible text-like input, textarea and select in the document (never buttons / files / passwords). */
export function collectControls(root: ParentNode): Control[] {
  const els = Array.from(root.querySelectorAll<Control>('input, textarea, select'));
  return els.filter((el) => {
    if (el instanceof HTMLInputElement && !TEXT_TYPES.has(el.type)) return false;
    return visible(el);
  });
}
