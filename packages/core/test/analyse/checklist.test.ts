import { describe, expect, it } from 'vitest';
import { ANNEXURE_KEYS, buildChecklist, checklistReadiness } from '../../src/analyse/checklist';
import type { ChecklistItem } from '../../src/analyse/types';
import { generateBidPdf, getSampleBidSpec } from '../../src/analyse/sample-bid';
import { extractPages } from '../../src/analyse/pdf-text';
import { extractRequirementsRules } from '../../src/analyse/rules';
import { baseProfile } from './profiles';

const reqsFor = async (key: string) => extractRequirementsRules(await extractPages(await generateBidPdf(getSampleBidSpec(key)!)));
const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('buildChecklist (FR-015)', () => {
  it('go-it-services for an MSE: identity, turnover, experience, Udyam + generated annexures', async () => {
    const items = buildChecklist(await reqsFor('go-it-services'), baseProfile);
    expect(ids(items)).toEqual(expect.arrayContaining([
      'gst', 'pan', 'balance_sheets', 'ca_turnover_certificate', 'experience_proof', 'similar_work_proof',
      'cert_iso_9001', 'udyam', 'emd_exemption', 'mii_self_cert', 'non_blacklisting', 'mse_declaration',
    ]));
    const udyam = items.find((i) => i.id === 'udyam')!;
    expect(udyam).toMatchObject({ docType: 'udyam', mandatory: true });
    expect(items.find((i) => i.id === 'emd_exemption')).toMatchObject({ generated: ANNEXURE_KEYS.emdExemption, docType: null });
    expect(items.find((i) => i.id === 'mii_self_cert')!.generated).toBe('mii_self_cert');
    expect(items.find((i) => i.id === 'non_blacklisting')!.mandatory).toBe(true);
    expect(items.find((i) => i.id === 'cert_iso_9001')!.docType).toBe('iso');
    expect(new Set(ids(items)).size).toBe(items.length); // unique, stable ids
  });

  it('a non-MSE pays EMD itself (informational item, no Udyam)', async () => {
    const items = buildChecklist(await reqsFor('emd-exempt-mse'), { mseCategory: null, udyamNumber: null });
    expect(ids(items)).not.toContain('udyam');
    expect(items.find((i) => i.id === 'emd_payment')).toMatchObject({ mandatory: false, docType: null });
    expect(items.find((i) => i.id === 'emd_payment')!.label).toContain('₹67,500');
  });

  it('hardware bid adds OEM authorisation, OEM turnover, BIS and the technical compliance sheet', async () => {
    const items = buildChecklist(await reqsFor('review-hardware-oem'), baseProfile);
    expect(items.find((i) => i.id === 'oem_authorization')).toMatchObject({ docType: 'oem_authorization', mandatory: true });
    expect(ids(items)).toEqual(expect.arrayContaining(['oem_turnover_certificate', 'cert_bis', 'technical_compliance', 'past_performance_proof']));
    expect(items.find((i) => i.id === 'technical_compliance')!.generated).toBe('technical_compliance');
  });

  it('ids are stable across runs', async () => {
    const r = await reqsFor('nogo-experience');
    expect(ids(buildChecklist(r, baseProfile))).toEqual(ids(buildChecklist(r, baseProfile)));
  });

  it('empty requirements still ask for GST and PAN', () => {
    expect(ids(buildChecklist([], null))).toEqual(['gst', 'pan', 'non_blacklisting']);
  });
});

describe('checklistReadiness (FR-040)', () => {
  const item = (id: string, docType: ChecklistItem['docType'], generated?: string): ChecklistItem => ({ id, label: id, docType, mandatory: true, reason: '', generated });
  const now = new Date('2026-03-10T10:00:00+05:30');
  const items = [item('gst', 'gst'), item('iso', 'iso'), item('udyam', 'udyam'), item('pan', 'pan'), item('emd_exemption', null, 'emd_exemption'), item('gem', null), item('bs', 'balance_sheet')];
  const r = checklistReadiness(items, [
    { type: 'gst' },
    { type: 'iso', expiryDate: '2026-03-20' },
    { type: 'udyam', expiryDate: '2026-03-09' },
    { type: 'balance_sheet', expiryDate: '2027-01-01' },
  ], now);

  it('maps each item', () => {
    expect(r.gst).toEqual({ status: 'ready' });
    expect(r.iso).toEqual({ status: 'expiring', days: 10 });
    expect(r.udyam).toEqual({ status: 'expired' });
    expect(r.pan).toEqual({ status: 'missing' });
    expect(r.bs).toEqual({ status: 'ready' });
  });
  it('is n/a for generated and non-vault items', () => {
    expect(r.emd_exemption).toEqual({ status: 'n/a' });
    expect(r.gem).toEqual({ status: 'n/a' });
  });
  it('shares the scoring rule: valid through 23:59:59 IST on the expiry date', () => {
    const at = (iso: string) => checklistReadiness([item('g', 'gst')], [{ type: 'gst', expiryDate: '2026-03-10' }], new Date(iso)).g;
    expect(at('2026-03-10T23:59:00+05:30')).toEqual({ status: 'expiring', days: 0 });
    expect(at('2026-03-11T00:00:01+05:30')).toEqual({ status: 'expired' });
  });
  it('prefers a valid document over an expired one of the same type', () => {
    const res = checklistReadiness([item('g', 'gst')], [{ type: 'gst', expiryDate: '2020-01-01' }, { type: 'gst', expiryDate: '2030-01-01' }], now);
    expect(res.g).toEqual({ status: 'ready' });
  });
});
