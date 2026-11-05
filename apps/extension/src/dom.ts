/** Adapts real page controls to the pure `FillTarget` interface used by fill.ts. */
import type { FieldDescriptor } from '@tp/core/assist/allowlist';
import { pickOption, type FillTarget, type MarkState } from './fill';

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const TEXT_TYPES = new Set(['', 'text', 'number', 'email', 'tel', 'search', 'url']);
const CHOICE_TYPES = new Set(['radio', 'checkbox']);

const isChoice = (el: Control): el is HTMLInputElement => el instanceof HTMLInputElement && CHOICE_TYPES.has(el.type);

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

/** Question text of a radio group / checkbox: legend, radiogroup label, table cell context or the text just before the group. */
function choiceQuestion(el: HTMLInputElement): { label: string; context: string } {
  const parts: string[] = [];
  const group = el.closest('fieldset, [role="radiogroup"], [role="group"]');
  const legend = group?.querySelector('legend')?.textContent;
  if (legend) parts.push(legend);
  const gl = group?.getAttribute('aria-label');
  if (gl) parts.push(gl);
  const by = group?.getAttribute('aria-labelledby');
  if (by) for (const id of by.split(/\s+/)) parts.push(el.ownerDocument.getElementById(id)?.textContent ?? '');
  // A lone checkbox is its own question ("I claim MSE preference"); a radio's own label is just an option ("Yes").
  const own = el.type === 'checkbox' ? labelFor(el) : '';
  const cell = el.closest('td,th');
  const context: string[] = [];
  if (cell) {
    const prev = cell.previousElementSibling;
    if (prev) context.push(prev.textContent ?? '');
  } else if (!legend && !gl && !by) {
    const holder = group ?? el.parentElement;
    const before = holder?.previousElementSibling;
    if (before && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(before.tagName)) context.push(before.textContent ?? '');
  }
  return { label: clean([own, ...parts].join(' ')), context: clean(context.join(' ')) };
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
  manual: '2px dotted #d97706',
  none: '',
};

export function descriptorOf(el: Control): FieldDescriptor {
  if (isChoice(el)) {
    const q = choiceQuestion(el);
    return { tagName: 'input', type: el.type, name: el.getAttribute('name'), id: el.id || null, label: q.label, placeholder: null, ariaLabel: el.getAttribute('aria-label'), context: q.context };
  }
  return {
    tagName: el.tagName.toLowerCase(),
    type: el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase(),
    name: el.getAttribute('name'), id: el.id || null, label: labelFor(el), placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'), context: contextFor(el),
  };
}

export function toTarget(el: Control): FillTarget {
  if (isChoice(el)) {
    // Radio / checkbox: described and reported, never clicked or changed (FR-077).
    return {
      descriptor: descriptorOf(el), kind: 'choice', disabled: el.disabled, readOnly: false,
      getValue: () => (el.checked ? el.value : ''),
      setValue: () => false,
      mark(state, note) {
        el.style.outline = state === 'manual' ? '2px dotted #d97706' : MARK_STYLE[state];
        el.style.outlineOffset = state === 'none' ? '' : '2px';
        if (state === 'none') { el.removeAttribute('data-tp-state'); el.removeAttribute('title'); return; }
        el.setAttribute('data-tp-state', state);
        if (note) el.setAttribute('title', note);
      },
    };
  }
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

/** Every visible text-like input, textarea, select and radio/checkbox question (never buttons / files); password inputs are included only so they can be marked forbidden. */
export function collectControls(root: ParentNode): Control[] {
  const els = Array.from(root.querySelectorAll<Control>('input, textarea, select'));
  const seenGroups = new Set<string>();
  return els.filter((el) => {
    // Password inputs (e.g. the DSC PIN) are collected so they get the "never filled" outline; fill.ts classifies them forbidden.
    if (el instanceof HTMLInputElement && el.type === 'password') return visible(el);
    if (el instanceof HTMLInputElement && !TEXT_TYPES.has(el.type)) {
      // Radio / checkbox questions are collected (reported as "left for you"); one entry per radio group.
      if (!isChoice(el) || !visible(el)) return false;
      if (el.type === 'radio' && el.name) {
        const gk = `${el.form ? Array.from(el.ownerDocument.forms).indexOf(el.form) : -1}:${el.name}`;
        if (seenGroups.has(gk)) return false;
        seenGroups.add(gk);
      }
      return true;
    }
    return visible(el);
  });
}
