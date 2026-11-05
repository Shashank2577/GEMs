import { describe, expect, it } from 'vitest';
import { ANNEXURE_KEYS, buildChecklist } from '../../src/analyse/checklist';
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
