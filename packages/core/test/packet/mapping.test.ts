import { describe, expect, it } from 'vitest';
import { autoMap, bestDocFor, readiness, resolveMapping, type MappableDoc } from '../../src/packet/mapping';
import type { ChecklistItem } from '../../src/analyse/types';

const now = new Date('2026-11-04T06:00:00Z');
const item = (id: string, docType: ChecklistItem['docType'], extra: Partial<ChecklistItem> = {}): ChecklistItem =>
  ({ id, label: id.replace(/_/g, ' '), docType, mandatory: true, reason: 'test', ...extra });

const docs: MappableDoc[] = [
  { id: 'gst-1', type: 'gst', title: 'GST REG-06', expiryDate: null, createdAt: '2025-01-01' },
  { id: 'pan-1', type: 'pan', title: 'PAN card', expiryDate: null },
  { id: 'bs-22', type: 'balance_sheet', title: 'Balance sheet FY 2022-23', financialYear: '2022-23' },
  { id: 'bs-24', type: 'balance_sheet', title: 'Balance sheet FY 2024-25', financialYear: '2024-25' },
  { id: 'bs-23', type: 'balance_sheet', title: 'Balance sheet FY 2023-24', financialYear: '2023-24' },
  { id: 'iso-old', type: 'iso', title: 'ISO 9001 old', expiryDate: '2026-01-01' },
  { id: 'iso-new', type: 'iso', title: 'ISO 9001:2015', expiryDate: '2028-01-01' },
  { id: 'iso-27001', type: 'iso', title: 'ISO 27001 ISMS', expiryDate: '2027-06-30', tags: ['27001'] },
  { id: 'oem-exp', type: 'oem_authorization', title: 'HP MAF', expiryDate: '2026-10-01' },
  { id: 'wo-1', type: 'work_order', title: 'Supply order NIC', expiryDate: null },
  { id: 'other-fire', type: 'other', title: 'Fire NOC certificate', tags: ['fire', 'noc'] },
];

describe('autoMap', () => {
  it('matches identity documents by type (US4 scenario 1)', () => {
    const m = autoMap([item('gst', 'gst'), item('pan', 'pan')], docs, now);
    expect(m).toEqual({ gst: 'gst-1', pan: 'pan-1' });
  });

  it('prefers the latest financial year for financial documents', () => {
    expect(autoMap([item('balance_sheets', 'balance_sheet')], docs, now).balance_sheets).toBe('bs-24');
  });

  it('prefers a valid document over an expired one of the same type', () => {
    expect(bestDocFor(item('cert_iso_9001', 'iso', { label: 'ISO 9001 certificate' }), docs, now)?.id).toBe('iso-new');
  });

  it('uses title/tag relevance between valid documents of the same type', () => {
    expect(bestDocFor(item('cert_iso_27001', 'iso', { label: 'ISO 27001 certificate' }), docs, now)?.id).toBe('iso-27001');
  });

  it('falls back to related types (CRAC ← work order)', () => {
    expect(autoMap([item('experience_proof', 'crac')], docs, now).experience_proof).toBe('wo-1');
  });

  it('maps "other" items only when title/tags clearly match', () => {
    const m = autoMap([item('doc_fire_noc', 'other', { label: 'Fire NOC' }), item('doc_trade_licence', 'other', { label: 'Trade licence' })], docs, now);
    expect(m.doc_fire_noc).toBe('other-fire');
    expect(m.doc_trade_licence).toBeNull();
  });

  it('never maps generated annexures or items without a doc type', () => {
    const m = autoMap([item('non_blacklisting', null, { generated: 'non_blacklisting' }), item('emd_payment', null)], docs, now);
    expect(m).toEqual({ non_blacklisting: null, emd_payment: null });
  });

  it('returns null when nothing in the vault fits', () => {
    expect(autoMap([item('udyam', 'udyam')], docs, now).udyam).toBeNull();
  });
});

describe('resolveMapping', () => {
  it('treats absent keys as automatic and explicit null as "none"', () => {
    const r = resolveMapping([item('gst', 'gst'), item('pan', 'pan')], { pan: null }, docs, now);
    expect(r.gst).toEqual({ docId: 'gst-1', auto: true });
    expect(r.pan).toEqual({ docId: null, auto: false });
  });

  it('drops a mapping to a deleted document', () => {
    expect(resolveMapping([item('gst', 'gst')], { gst: 'deleted' }, docs, now).gst).toEqual({ docId: null, auto: false });
  });
});

describe('readiness', () => {
  const checklist = [
    item('gst', 'gst'),
    item('oem_authorization', 'oem_authorization'),
    item('udyam', 'udyam'),
    item('non_blacklisting', null, { generated: 'non_blacklisting' }),
    item('cert_iso_9001', 'iso', { mandatory: false, label: 'ISO 9001 certificate' }),
    item('optional_brochure', 'product_catalogue', { mandatory: false }),
  ];

  it('derives states, percent and blockers', () => {
    const r = readiness(checklist, {}, docs, [], now);
    const st = Object.fromEntries(r.items.map((i) => [i.item.id, i.state]));
    expect(st).toEqual({
      gst: 'ready', oem_authorization: 'expired', udyam: 'missing', non_blacklisting: 'generated',
      cert_iso_9001: 'ready', optional_brochure: 'missing',
    });
    expect(r.blockers.map((b) => b.itemId)).toEqual(['oem_authorization', 'udyam']);
    expect(r.canMarkReady).toBe(false);
    // 4 mandatory items, 2 covered (gst + generated)
    expect(r.total).toBe(4);
    expect(r.percent).toBe(50);
    expect(r.warnings.map((w) => w.itemId)).toEqual(['optional_brochure']);
  });

  it('marks expiring documents (≤ 30 days) as covered with a warning', () => {
    const r = readiness([item('iso', 'iso')], { iso: 'x' }, [{ id: 'x', type: 'iso', title: 'ISO', expiryDate: '2026-11-20' }], [], now);
    expect(r.items[0].state).toBe('expiring');
    expect(r.items[0].daysToExpiry).toBe(16);
    expect(r.canMarkReady).toBe(true);
    expect(r.warnings).toHaveLength(1);
  });

  it('a manager override clears a blocker (US4 scenario 2)', () => {
    const ov = [{ itemId: 'oem_authorization', reason: 'Renewed MAF arriving tomorrow', by: 'u1', at: now.toISOString() }];
    const r = readiness(checklist.slice(0, 2), {}, docs, ov, now);
    expect(r.items[1].state).toBe('overridden');
    expect(r.items[1].override?.reason).toMatch(/Renewed/);
    expect(r.canMarkReady).toBe(true);
    expect(r.percent).toBe(100);
  });

  it('is 100% for an empty checklist', () => {
    expect(readiness([], {}, docs, [], now)).toMatchObject({ percent: 100, canMarkReady: true, total: 0 });
  });
});
