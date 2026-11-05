import { describe, expect, it } from 'vitest';
import {
  ALLOWED_KEYS, FIELD_CATALOG, HUMAN_STEPS, assistPayload, forbiddenReason, isFieldAllowed, isForbiddenKey, matchField, normalizeText,
  validateAssistValues,
} from '../../src/assist/allowlist';

describe('forbidden fields (Constitution I)', () => {
  const forbidden = [
    { name: 'unitPrice' }, { name: 'unit_price', label: 'Unit Price (INR)' }, { label: 'Rate per unit' }, { label: 'Total Value' },
    { id: 'bidValue' }, { label: 'Offered price' }, { label: 'Amount (₹)' }, { name: 'emd_amount' }, { label: 'Price in Rs' },
    { name: 'captcha' }, { id: 'captchaInput' }, { placeholder: 'Enter the security code' }, { label: 'Enter OTP' }, { name: 'otpCode' },
    { label: 'Sign with DSC' }, { label: 'e-Sign' }, { name: 'esign' }, { label: 'Aadhaar number' }, { type: 'password', name: 'pwd' },
    { label: 'Password' }, { tagName: 'button', label: 'Final Submit' }, { type: 'submit', name: 'go' }, { name: 'finalSubmit' },
    { label: 'Make', context: 'Unit price' }, // forbidden wins even when an allowed word is present
    { type: 'file', label: 'Upload make certificate' }, { label: 'Discount %' }, { label: 'GST amount' }, { label: 'Cost' },
  ];
  it.each(forbidden)('never allows %o', (d) => {
    expect(isFieldAllowed(d)).toBe(false);
    expect(matchField(d)).toBeNull();
  });

  it('flags price-like keys', () => {
    for (const k of ['price', 'unit_price', 'totalValue', 'bid_value', 'rate', 'otp', 'captcha', 'dsc', 'esign', 'submit', 'final_submit', 'aadhaar', 'password'])
      expect(isForbiddenKey(k), k).toBe(true);
    for (const k of ALLOWED_KEYS) expect(isForbiddenKey(k), k).toBe(false);
  });

  it('does not over-match ordinary words', () => {
    expect(forbiddenReason({ label: 'Product description' })).toBeNull(); // "dsc" inside "description"
    expect(forbiddenReason({ label: 'Corporate accurate separate' })).toBeNull(); // "rate" inside words
    expect(forbiddenReason({ label: 'Pincode' })).toBeNull();
  });
});

describe('allowed fields', () => {
  it.each([
    [{ label: 'Make' }, 'make'], [{ name: 'brandName' }, 'brand'], [{ id: 'model_no', label: 'Model' }, 'model'],
    [{ label: 'Offered Quantity' }, 'offered_quantity'], [{ label: 'Delivery Period (days)' }, 'delivery_period_days'],
    [{ label: 'Country of Origin', tagName: 'select' }, 'country_of_origin'], [{ label: 'Local Content (%)' }, 'local_content_pct'],
    [{ label: 'Are you an MSE?' }, 'mse_claim'], [{ label: 'OEM Name' }, 'oem_name'], [{ label: 'Compliance with specification' }, 'specs_compliance'],
    [{ label: 'Warranty (months)' }, 'warranty_months'],
  ])('%o → %s', (d, key) => {
    expect(matchField(d)).toBe(key);
    expect(isFieldAllowed(d)).toBe(true);
  });

  it('ignores unknown fields', () => {
    expect(isFieldAllowed({ label: 'Favourite colour' })).toBe(false);
  });

  it('normalises camelCase and separators', () => {
    expect(normalizeText('unitPrice_INR-value')).toBe('unit price inr value');
  });

  it('no allow-listed field is itself forbidden', () => {
    for (const f of FIELD_CATALOG) expect(forbiddenReason({ name: f.key, label: f.label }), f.key).toBeNull();
  });
});

describe('assistPayload', () => {
  const payload = assistPayload({
    workspace: { id: 'w1', assistValues: { model: 'Latitude 5450', price: '99999' } as Record<string, string> },
    tender: { bidNumber: 'GEM/2026/B/1', title: 'Laptops', quantity: 40, items: [{ name: 'Laptop i5' }] },
    profile: { mseCategory: 'small', miiClass: 'class_1', localContentPct: 60, oemAuthorizations: [{ oem: 'Dell' }] },
    documents: [{ title: 'Packet', fileName: 'packet.pdf', url: '/api/packets/p/download' }],
    deliveryDays: 30,
  });

  it('only contains allow-listed keys — never price', () => {
    const keys = payload.fields.map((f) => f.key);
    expect(keys).toEqual(ALLOWED_KEYS);
    expect(keys).not.toContain('price');
    expect(JSON.stringify(payload)).not.toContain('99999');
    expect(payload.noFinancials).toBe(true);
  });

  it('merges saved values over derived defaults', () => {
    const v = Object.fromEntries(payload.fields.map((f) => [f.key, [f.value, f.source]]));
    expect(v.model).toEqual(['Latitude 5450', 'saved']);
    expect(v.make).toEqual(['Dell', 'profile']);
    expect(v.offered_quantity).toEqual(['40', 'tender']);
    expect(v.delivery_period_days).toEqual(['30', 'analysis']);
    expect(v.country_of_origin).toEqual(['India', 'profile']);
    expect(v.mse_claim).toEqual(['Yes', 'profile']);
    expect(v.startup_claim).toEqual(['No', 'profile']);
    expect(v.warranty_months).toEqual(['', 'empty']);
  });

  it('lists the human-only steps (price, upload, OTP/DSC, final submit)', () => {
    expect(payload.humanSteps.map((s) => s.key)).toEqual(['price', 'upload', 'auth', 'submit']);
    expect(HUMAN_STEPS[0].detail).toMatch(/never/);
  });
});

describe('validateAssistValues', () => {
  it('rejects forbidden and unknown keys', () => {
    const e = validateAssistValues({ make: 'Dell', unit_price: '10', otp: '1234', colour: 'red' });
    expect(Object.keys(e).sort()).toEqual(['colour', 'otp', 'unit_price']);
    expect(e.unit_price).toMatch(/never stores or fills prices/);
  });
  it('accepts allowed keys', () => {
    expect(validateAssistValues({ make: 'Dell', model: 'X', delivery_period_days: '30' })).toEqual({});
  });
});
