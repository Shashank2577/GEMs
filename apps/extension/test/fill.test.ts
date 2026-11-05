/**
 * Extension fill logic (T065, T067; FR-027, US5 acceptance 1, Constitution I).
 * Fake targets mirror test/fixtures/gem-form.html field by field.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assistPayload, type FieldDescriptor } from '@tp/core/assist/allowlist';
import { fillAll, fillOne, pickOption, plan, skipReasonText, type FillTarget, type MarkState, type PayloadField } from '../src/fill';

interface Fake extends FillTarget { value: string; state: MarkState; writes: number; options?: { value: string; text: string }[] }

function fake(descriptor: FieldDescriptor, opts: { kind?: FillTarget['kind']; value?: string; options?: { value: string; text: string }[]; disabled?: boolean } = {}): Fake {
  const t: Fake = {
    descriptor, kind: opts.kind ?? 'input', disabled: opts.disabled, value: opts.value ?? '', state: 'none', writes: 0, options: opts.options,
    getValue: () => t.value,
    setValue(v) {
      t.writes++;
      if (t.options) { const o = pickOption(t.options, v); if (o == null) return false; t.value = o; return true; }
      t.value = v;
      return true;
    },
    mark(s) { t.state = s; },
  };
  return t;
}

const YESNO = [{ value: '', text: '--' }, { value: 'Y', text: 'Yes' }, { value: 'N', text: 'No' }];

/** The controls on gem-form.html as the DOM adapter would describe them. */
function gemForm() {
  return {
    make: fake({ tagName: 'input', type: 'text', name: 'offeredMake', id: 'make', label: 'Make' }),
    model: fake({ tagName: 'input', type: 'text', name: 'offeredModel', id: 'model', label: 'Model' }),
    brand: fake({ tagName: 'input', type: 'text', name: 'brandName', context: 'Brand' }),
    qty: fake({ tagName: 'input', type: 'number', name: 'offeredQty', id: 'qty', label: 'Offered Quantity' }),
    delivery: fake({ tagName: 'input', type: 'number', name: 'deliveryDays', id: 'delivery', label: 'Delivery Period (days)' }),
    coo: fake({ tagName: 'select', type: 'select', name: 'countryOfOrigin', id: 'coo', label: 'Country of Origin' }, { kind: 'select', options: [{ value: '', text: '-- Select --' }, { value: 'IN', text: 'India' }, { value: 'CN', text: 'China' }] }),
    lc: fake({ tagName: 'input', type: 'number', name: 'localContent', id: 'lc', label: 'Local Content (%)' }),
    mse: fake({ tagName: 'select', type: 'select', name: 'mseClaim', id: 'mse', label: 'Do you want to avail MSE purchase preference?' }, { kind: 'select', options: YESNO }),
    spec: fake({ tagName: 'select', type: 'select', name: 'specCompliance', id: 'spec', label: 'Compliance with technical specification' }, { kind: 'select', options: [{ value: '', text: '--' }, { value: '1', text: 'Yes, Complied' }, { value: '0', text: 'Not complied' }] }),
    remarks: fake({ tagName: 'textarea', type: 'textarea', name: 'remarks', id: 'remarks', label: 'Seller remarks' }, { kind: 'textarea' }),
    unitPrice: fake({ tagName: 'input', type: 'number', name: 'unitPrice', id: 'unitPrice', label: 'Unit Price (INR, incl. GST)' }),
    totalValue: fake({ tagName: 'input', type: 'number', name: 'totalValue', id: 'totalValue', label: 'Total Bid Value' }),
    rate: fake({ tagName: 'input', type: 'text', name: 'ratePerUnit', id: 'rate', label: 'Rate per unit' }),
    captcha: fake({ tagName: 'input', type: 'text', name: 'captcha', id: 'captcha', label: 'Enter the characters shown' }),
    otp: fake({ tagName: 'input', type: 'text', name: 'otp', id: 'otp', label: 'Enter OTP sent to Aadhaar-linked mobile' }),
    dsc: fake({ tagName: 'input', type: 'password', name: 'dscPin', id: 'dsc', label: 'DSC PIN' }),
  };
}

const payload = assistPayload({
  workspace: { id: 'w1', assistValues: { model: 'Latitude 5450', warranty_months: '36' } },
  tender: { bidNumber: 'GEM/2026/B/700001', title: 'Supply of Laptops', quantity: 40, items: [{ name: 'Laptop' }] },
  profile: { mseCategory: 'small', miiClass: 'class_1', localContentPct: 62, oemAuthorizations: [{ oem: 'Dell' }] },
  documents: [],
  deliveryDays: 30,
});
const fields: PayloadField[] = payload.fields.map((f) => ({ key: f.key, label: f.label, value: f.value, selectorHints: f.selectorHints }));

describe('fixture page', () => {
  it('contains the price, captcha, OTP, DSC and final-submit controls the tests rely on', () => {
    const html = readFileSync(new URL('./fixtures/gem-form.html', import.meta.url), 'utf8');
    for (const id of ['unitPrice', 'totalValue', 'captcha', 'otp', 'dsc', 'final-submit', 'make', 'model', 'coo', 'mse']) expect(html).toContain(`id="${id}"`);
  });
});

describe('fillAll on a GeM-like form (US5 acceptance 1)', () => {
  it('fills only technical / non-financial fields; price, captcha, OTP and DSC stay empty', () => {
    const f = gemForm();
    const report = fillAll(Object.values(f), fields);
    expect(f.make.value).toBe('Dell');
    expect(f.model.value).toBe('Latitude 5450');
    expect(f.brand.value).toBe('Dell');
    expect(f.qty.value).toBe('40');
    expect(f.delivery.value).toBe('30');
    expect(f.coo.value).toBe('IN');
    expect(f.lc.value).toBe('62');
    expect(f.mse.value).toBe('Y');
    expect(f.spec.value).toBe('1');
    for (const k of ['unitPrice', 'totalValue', 'rate', 'captcha', 'otp', 'dsc'] as const) {
      expect(f[k].value, k).toBe('');
      expect(f[k].writes, k).toBe(0);
      expect(f[k].state, k).toBe('blocked');
    }
    expect(f.remarks.value).toBe('');
    expect(report.forbidden).toBe(6);
    expect(report.unmatched).toBe(1);
    expect(report.filled.map((x) => x.key).sort()).toEqual(['brand', 'country_of_origin', 'delivery_period_days', 'local_content_pct', 'make', 'model', 'mse_claim', 'offered_quantity', 'specs_compliance']);
    expect(f.make.state).toBe('filled');
  });

  it('never fills a forbidden field even if the payload is tampered to target it', () => {
    const f = gemForm();
    const evil: PayloadField[] = [{ key: 'make', label: 'Make', value: '99999', selectorHints: ['unit price', 'captcha', 'otp', 'total', 'rate', '.*'] }];
    fillAll(Object.values(f), evil);
    for (const k of ['unitPrice', 'totalValue', 'rate', 'captcha', 'otp', 'dsc'] as const) expect(f[k].writes, k).toBe(0);
  });

  it('does not overwrite what the user already typed, unless asked', () => {
    const f = gemForm();
    f.model.value = 'User typed';
    const r = fillAll([f.model], fields);
    expect(f.model.value).toBe('User typed');
    expect(r.skipped[0].reason).toBe('already has a value');
    fillAll([f.model], fields, { overwrite: true });
    expect(f.model.value).toBe('Latitude 5450');
  });

  it('can fill a subset of keys only', () => {
    const f = gemForm();
    fillAll(Object.values(f), fields, { keys: ['model'] });
    expect(f.model.value).toBe('Latitude 5450');
    expect(f.make.value).toBe('');
  });

  it('skips disabled fields and fields without a prepared value', () => {
    const disabled = fake({ label: 'Make', type: 'text' }, { disabled: true });
    const entries = plan([disabled, fake({ label: 'Warranty' }), fake({ label: 'Startup exemption claimed' })], fields.map((x) => (x.key === 'warranty_months' ? { ...x, value: '' } : x)));
    expect(entries.map((e) => e.status)).toEqual(['disabled', 'no_value', 'fillable']);
  });

  it('reports human-readable skip reasons, never raw codes (FR-075)', () => {
    const noVal = fake({ label: 'Warranty' });
    const off = fake({ label: 'Make', type: 'text' }, { disabled: true });
    const r = fillAll([noVal, off], fields.map((x) => (x.key === 'warranty_months' ? { ...x, value: '' } : x)));
    const reasons = r.skipped.map((x) => x.reason);
    expect(reasons).toContain('no prepared value');
    expect(reasons.join(' ')).not.toMatch(/no_value/);
    for (const code of ['fillable', 'forbidden', 'unmatched', 'no_value', 'disabled', 'manual']) expect(skipReasonText(code)).not.toBe(code);
  });

  it('fillOne re-checks the descriptor before writing', () => {
    const t = fake({ label: 'Make' });
    const [entry] = plan([t], fields);
    t.descriptor = { ...t.descriptor, context: 'Unit price' }; // page changed under us
    expect(fillOne(entry)).toEqual({ ok: false, reason: 'forbidden (price)' });
    expect(t.writes).toBe(0);
  });
});

describe('pickOption', () => {
  it('matches by text, value, yes/no synonyms and prefix', () => {
    expect(pickOption([{ value: 'IN', text: 'India' }], 'india')).toBe('IN');
    expect(pickOption([{ value: '1', text: 'Yes, Complied' }, { value: '0', text: 'Not complied' }], 'Yes')).toBe('1');
    expect(pickOption(YESNO, 'No')).toBe('N');
    expect(pickOption([{ value: 'a', text: 'Bharat (India)' }], 'Narnia')).toBeNull();
    expect(pickOption([], 'x')).toBeNull();
  });
});


describe('radio / checkbox questions (T082, FR-077)', () => {
  const fields: PayloadField[] = [{ key: 'mse_claim', label: 'MSE preference claimed', value: 'Yes', selectorHints: ['\\bmse\\b'] }];
  const radio = (label: string, name = 'q1') => fake({ tagName: 'input', type: 'radio', name, label }, { kind: 'choice' });

  it('reports a matching radio as manual and never writes', () => {
    const r = radio('Do you want to avail MSE purchase preference?', 'mseClaim');
    const [e] = plan([r], fields);
    expect(e.status).toBe('manual');
    expect(e.field?.key).toBe('mse_claim');
    expect(fillOne(e, { overwrite: true })).toEqual({ ok: false, reason: 'left for you' });
    const report = fillAll([r], fields, { overwrite: true });
    expect(r.writes).toBe(0);
    expect(report.filled).toEqual([]);
    expect(report.skipped).toEqual([{ key: 'mse_claim', label: 'MSE preference claimed', reason: 'left for you — choose “Yes” yourself' }]);
  });

  it('still treats a price-like radio as forbidden and an unrelated one as unmatched', () => {
    expect(plan([radio('Quoted price includes GST?')], fields)[0].status).toBe('forbidden');
    expect(plan([radio('Preferred colour')], fields)[0].status).toBe('unmatched');
  });
});
