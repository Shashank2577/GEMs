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

  it('IST midnight boundary: UTC date differs from IST date', () => {
    const g = (iso: string, exp: string) => checklistReadiness([item('g', 'gst')], [{ type: 'gst', expiryDate: exp }], new Date(iso)).g;
    // 2026-03-10T02:00+05:30 is still 2026-03-09 in UTC; IST day is the 10th.
    expect(g('2026-03-10T02:00:00+05:30', '2026-03-10')).toEqual({ status: 'expiring', days: 0 });
    expect(g('2026-03-10T02:00:00+05:30', '2026-03-11')).toEqual({ status: 'expiring', days: 1 });
    expect(g('2026-03-09T23:30:00Z', '2026-03-10')).toEqual({ status: 'expiring', days: 0 });
  });
  it('several valid docs of one type: the latest-expiring decides', () => {
    const g = (exps: string[]) => checklistReadiness([item('g', 'gst')], exps.map((e) => ({ type: 'gst' as const, expiryDate: e })), now).g;
    expect(g(['2026-03-15', '2027-01-01'])).toEqual({ status: 'ready' });
    expect(g(['2026-03-15', '2026-03-25'])).toEqual({ status: 'expiring', days: 15 });
    expect(g(['2026-03-15', '2026-03-25', '2020-01-01'])).toEqual({ status: 'expiring', days: 15 });
  });
  it('threshold: 30 days is expiring, 31 is ready', () => {
    const g = (exp: string) => checklistReadiness([item('g', 'gst')], [{ type: 'gst', expiryDate: exp }], now).g;
    expect(g('2026-04-09')).toEqual({ status: 'expiring', days: 30 });
    expect(g('2026-04-10')).toEqual({ status: 'ready' });
  });
  it('a no-expiry doc makes the item ready', () => {
    expect(checklistReadiness([item('g', 'gst')], [{ type: 'gst', expiryDate: '2026-03-15' }, { type: 'gst' }], now).g).toEqual({ status: 'ready' });
  });
  it('docType other (atc_/doc_/undertaking_/oem_turnover/unrecognised cert) is n/a', () => {
    const others = [item('atc_x', 'other'), item('doc_y', 'other'), item('undertaking_z', 'other'), item('oem_turnover_certificate', 'other'), item('cert_cmmi', 'other')];
    const res = checklistReadiness(others, [{ type: 'other', title: 'CMMI' }], now);
    for (const o of others) expect(res[o.id]).toEqual({ status: 'n/a' });
  });
  it('cert_* items match by title/tags like the Certificates factor (ISO 9001 vs 27001)', () => {
    const c = (id: string, label: string, t: ChecklistItem['docType']) => ({ ...item(id, t), label });
    const items2 = [c('cert_iso_9001', 'ISO 9001 certificate', 'iso'), c('cert_iso_27001', 'ISO 27001 certificate', 'iso'), c('cert_bis', 'BIS certificate', 'bis')];
    const res = checklistReadiness(items2, [
      { type: 'iso', title: 'ISO 9001:2015 Quality', expiryDate: '2027-01-01' },
      { type: 'iso', title: 'Cert', tags: ['ISO 27001'], expiryDate: '2026-03-01' },
    ], now);
    expect(res.cert_iso_9001).toEqual({ status: 'ready' });
    expect(res.cert_iso_27001).toEqual({ status: 'expired' });
    expect(res.cert_bis).toEqual({ status: 'missing' });
    const only9001 = checklistReadiness(items2, [{ type: 'iso', title: 'ISO 9001', expiryDate: '2027-01-01' }], now);
    expect(only9001.cert_iso_27001).toEqual({ status: 'missing' });
  });
});
