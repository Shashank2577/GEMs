/// <reference types="chrome" />
/**
 * Content script for GeM pages (*.gem.gov.in). It does nothing until the user acts in the popup:
 *  - "Highlight fields": outlines fillable fields (dashed indigo), forbidden ones (red) and adds a
 *    small "TP" chip next to each fillable field — clicking a chip fills just that field;
 *  - "Fill allowed fields": fills every allow-listed, empty, non-forbidden field.
 * It never fills prices, never touches CAPTCHA / OTP / DSC / e-Sign, never clicks or submits anything.
 */
import { collectControls, toTarget } from './dom';
import { fillAll, fillOne, plan, type PayloadField, type PlanEntry } from './fill';
import { makeMessageListener } from './listener';
import type { ScanSummary } from './messages';

const CHIP_CLASS = 'tp-fill-chip';
const MANUAL_CLASS = 'tp-manual-chip';

function clearChips() {
  document.querySelectorAll(`.${CHIP_CLASS}, .${MANUAL_CLASS}`).forEach((n) => n.remove());
  document.querySelectorAll<HTMLElement>('[data-tp-state]').forEach((el) => {
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.removeAttribute('data-tp-state');
  });
}

function chipFor(entry: PlanEntry, el: HTMLElement) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = CHIP_CLASS;
  chip.textContent = 'TP';
  chip.title = `Fill “${entry.field!.label}” with: ${entry.field!.value}`;
  chip.setAttribute('aria-label', chip.title);
  Object.assign(chip.style, {
    marginLeft: '6px', padding: '1px 6px', font: '600 10px/16px system-ui, sans-serif', color: '#fff', background: '#4f46e5',
    border: 'none', borderRadius: '999px', cursor: 'pointer', verticalAlign: 'middle',
  } satisfies Partial<CSSStyleDeclaration>);
  chip.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const r = fillOne(entry, { overwrite: true });
    chip.textContent = r.ok ? '✓' : '!';
    chip.style.background = r.ok ? '#059669' : '#e11d48';
    chip.title = r.ok ? 'Filled — please verify' : `Not filled: ${r.reason}`;
  });
  el.insertAdjacentElement('afterend', chip);
}

/** Radio / checkbox question: show the prepared answer in the chip title, never click anything (FR-077). */
function manualChipFor(entry: PlanEntry, el: HTMLElement) {
  const chip = document.createElement('span');
  chip.className = MANUAL_CLASS;
  chip.textContent = 'TP';
  chip.title = `Left for you — “${entry.field!.label}”: choose “${entry.field!.value}” yourself`;
  chip.setAttribute('role', 'note');
  chip.setAttribute('aria-label', chip.title);
  Object.assign(chip.style, {
    marginLeft: '6px', padding: '1px 6px', font: '600 10px/16px system-ui, sans-serif', color: '#fff', background: '#b45309',
    borderRadius: '999px', verticalAlign: 'middle',
  } satisfies Partial<CSSStyleDeclaration>);
  el.insertAdjacentElement('afterend', chip);
}

function scan(fields: PayloadField[]): ScanSummary {
  clearChips();
  const controls = collectControls(document);
  const entries = plan(controls.map(toTarget), fields);
  const summary: ScanSummary = { fillable: 0, forbidden: 0, unmatched: 0, noValue: 0, manual: 0, keys: [] };
  entries.forEach((e, i) => {
    if (e.status === 'forbidden') { summary.forbidden++; e.target.mark('blocked', `TenderPilot never fills this (${e.reason}) — you do it on GeM`); return; }
    if (e.status === 'unmatched') { summary.unmatched++; return; }
    if (e.status === 'manual') {
      summary.manual++;
      e.target.mark('manual', `TenderPilot leaves this to you: ${e.field!.label} — prepared answer “${e.field!.value}”`);
      manualChipFor(e, controls[i]);
      return;
    }
    if (e.status !== 'fillable') { summary.noValue++; return; }
    summary.fillable++;
    summary.keys.push(e.field!.key);
    e.target.mark('available', `TenderPilot can fill: ${e.field!.label}`);
    chipFor(e, controls[i]);
  });
  return summary;
}

chrome.runtime.onMessage.addListener(
  makeMessageListener(chrome.runtime.id, {
    scan,
    fill: (msg) => fillAll(collectControls(document).map(toTarget), msg.fields, { keys: msg.keys, overwrite: msg.overwrite }),
    clear: clearChips,
  }),
);
