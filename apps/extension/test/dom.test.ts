// @vitest-environment jsdom
/** DOM adapter under jsdom (T083; FR-069, FR-071, FR-077). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectControls, descriptorOf, toTarget } from '../src/dom';
import { fillAll, plan, type PayloadField } from '../src/fill';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const mount = (html: string) => { document.body.innerHTML = html; };

const FIELDS: PayloadField[] = [
  { key: 'make', label: 'Make', value: 'Dell', selectorHints: ['\\bmake\\b'] },
  { key: 'model', label: 'Model', value: 'Latitude 5450', selectorHints: ['\\bmodel\\b'] },
  { key: 'country_of_origin', label: 'Country of origin', value: 'India', selectorHints: ['country of origin'] },
  { key: 'mse_claim', label: 'MSE', value: 'Yes', selectorHints: ['\\bmse\\b'] },
  { key: 'offered_quantity', label: 'Qty', value: '40', selectorHints: ['\\bquantity\\b'] },
];

beforeEach(() => { document.body.innerHTML = ''; });

describe('labels (FR-069)', () => {
  it('reads <label for>', () => {
    mount('<label for="a">Make</label><input id="a" name="x1" />');
    expect(descriptorOf($('a') as HTMLInputElement).label).toBe('Make');
  });
  it('reads a wrapping label', () => {
    mount('<label>Offered Model <input id="a" name="x1" /></label>');
    expect(descriptorOf($('a') as HTMLInputElement).label).toContain('Offered Model');
  });
  it('reads aria-labelledby', () => {
    mount('<span id="l1">Country of</span> <span id="l2">Origin</span><input id="a" aria-labelledby="l1 l2" />');
    expect(descriptorOf($('a') as HTMLInputElement).label).toBe('Country of Origin');
  });
  it('keeps name, id, placeholder and aria-label', () => {
    mount('<input id="a" name="offeredMake" placeholder="e.g. Dell" aria-label="Make field" />');
    expect(descriptorOf($('a') as HTMLInputElement)).toMatchObject({ name: 'offeredMake', id: 'a', placeholder: 'e.g. Dell', ariaLabel: 'Make field', type: 'text' });
  });
});

describe('table context (FR-069)', () => {
  it('uses the previous cell and the column header', () => {
    mount('<table><tr><th>Item</th><th>Make</th></tr><tr><td>Laptop</td><td><input id="a" name="f1" /></td></tr></table>');
    const ctx = descriptorOf($('a') as HTMLInputElement).context;
    expect(ctx).toContain('Laptop');
    expect(ctx).toContain('Make');
  });
  it('uses the previous sibling text outside tables', () => {
    mount('<div><span>Brand</span><input id="a" name="f1" /></div>');
    expect(descriptorOf($('a') as HTMLInputElement).context).toBe('Brand');
  });
});

describe('collectControls (FR-071)', () => {
  it('excludes hidden, display:none, visibility:hidden, files, passwords, buttons and submit', () => {
    mount(`<input id="ok" name="a"/><input id="h1" hidden/><input id="h2" style="display:none"/><input id="h3" style="visibility:hidden"/>
      <input type="hidden" id="h4"/><input type="file" id="f"/><input type="password" id="p"/><input type="submit" id="s"/><input type="button" id="b"/>
      <textarea id="ta"></textarea><select id="se"><option>x</option></select>`);
    expect(collectControls(document).map((e) => e.id)).toEqual(['ok', 'ta', 'se']);
  });
  it('collects one entry per radio group plus checkboxes', () => {
    mount('<input type="radio" name="g" id="r1"/><input type="radio" name="g" id="r2"/><input type="checkbox" id="c1"/>');
    expect(collectControls(document).map((e) => e.id)).toEqual(['r1', 'c1']);
  });
});

describe('writing values (FR-071)', () => {
  it('select: picks the matching option and dispatches input + change', () => {
    mount('<select id="s" name="countryOfOrigin"><option value="">--</option><option value="IN">India</option><option value="CN">China</option></select>');
    const el = $<HTMLSelectElement>('s');
    const events: string[] = [];
    el.addEventListener('input', () => events.push('input'));
    el.addEventListener('change', () => events.push('change'));
    expect(toTarget(el).setValue('India')).toBe(true);
    expect(el.value).toBe('IN');
    expect(events).toEqual(['input', 'change']);
  });
  it('select: yes/no synonyms and no match', () => {
    mount('<select id="s"><option value="">--</option><option value="Y">Yes</option><option value="N">No</option></select>');
    const t = toTarget($<HTMLSelectElement>('s'));
    expect(t.setValue('Yes')).toBe(true);
    expect($<HTMLSelectElement>('s').value).toBe('Y');
    expect(t.setValue('Maybe')).toBe(false);
    expect($<HTMLSelectElement>('s').value).toBe('Y');
  });
  it('select: getValue is empty on the placeholder option', () => {
    mount('<select id="s"><option value="">--</option><option value="Y">Yes</option></select>');
    expect(toTarget($<HTMLSelectElement>('s')).getValue()).toBe('');
  });
  it('number input rejects text and fires nothing', () => {
    mount('<input id="n" type="number" name="qty"/>');
    const el = $<HTMLInputElement>('n');
    const spy = vi.fn();
    el.addEventListener('input', spy);
    const t = toTarget(el);
    expect(t.setValue('forty')).toBe(false);
    expect(el.value).toBe('');
    expect(spy).not.toHaveBeenCalled();
    expect(t.setValue('40')).toBe(true);
    expect(el.value).toBe('40');
    expect(spy).toHaveBeenCalledOnce();
  });
  it('text input: native setter, bubbling input and change events', () => {
    mount('<form id="f"><input id="t" name="offeredMake"/></form>');
    const seen: string[] = [];
    $('f').addEventListener('input', (e) => seen.push(`input:${(e.target as HTMLInputElement).value}`));
    $('f').addEventListener('change', (e) => seen.push(`change:${(e.target as HTMLInputElement).value}`));
    toTarget($<HTMLInputElement>('t')).setValue('Dell');
    expect(seen).toEqual(['input:Dell', 'change:Dell']);
  });
  it('mark() outlines and titles, and none clears it', () => {
    mount('<input id="t" name="offeredMake"/>');
    const el = $<HTMLInputElement>('t');
    const t = toTarget(el);
    t.mark('available', 'note');
    expect(el.getAttribute('data-tp-state')).toBe('available');
    expect(el.title).toBe('note');
    t.mark('none');
    expect(el.hasAttribute('data-tp-state')).toBe(false);
  });
});

describe('radio / checkbox questions are left for the user (FR-077)', () => {
  const QUESTION = `<fieldset><legend>Do you want to avail MSE purchase preference?</legend>
    <label><input type="radio" name="mse" id="yes" value="Y"/> Yes</label><label><input type="radio" name="mse" id="no" value="N"/> No</label></fieldset>
    <table><tr><td>Country of Origin</td><td><input type="checkbox" id="coo" name="c1"/></td></tr></table>
    <label><input type="checkbox" id="declare" name="d"/> I confirm final submission</label>`;

  it('plans a matched radio group as manual, a forbidden checkbox as forbidden', () => {
    mount(QUESTION);
    const entries = plan(collectControls(document).map(toTarget), FIELDS);
    expect(entries.map((e) => e.status)).toEqual(['manual', 'manual', 'forbidden']);
    expect(entries[0].field?.key).toBe('mse_claim');
    expect(entries[1].field?.key).toBe('country_of_origin');
  });

  it('fillAll never clicks or changes radios / checkboxes and reports them as left for you', () => {
    mount(QUESTION);
    const clicks = vi.fn();
    document.querySelectorAll('input').forEach((i) => { i.addEventListener('click', clicks); i.addEventListener('change', clicks); });
    const report = fillAll(collectControls(document).map(toTarget), FIELDS);
    expect(clicks).not.toHaveBeenCalled();
    expect(document.querySelectorAll('input:checked')).toHaveLength(0);
    expect(report.filled).toEqual([]);
    expect(report.skipped.map((s) => s.key)).toEqual(['mse_claim', 'country_of_origin']);
    expect(report.skipped[0].reason).toContain('left for you');
    expect(report.skipped[0].reason).toContain('Yes');
    expect(report.forbidden).toBe(1);
  });

  it('setValue on a choice target is a no-op', () => {
    mount('<fieldset><legend>MSE preference</legend><input type="radio" name="mse" id="yes" value="Y"/></fieldset>');
    const el = $<HTMLInputElement>('yes');
    expect(toTarget(el).setValue('Y')).toBe(false);
    expect(el.checked).toBe(false);
  });
});
