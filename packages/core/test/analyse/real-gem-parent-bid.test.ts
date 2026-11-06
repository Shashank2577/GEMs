import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPdf } from '../../src/analyse/pdf-text';
import { extractRequirementsRules } from '../../src/analyse/rules';

// Real GeM parent bids (public), downloaded 2026-11-06 via a reverse auction's b_id_parent.
const load = async (n: string) => {
  const bytes = new Uint8Array(readFileSync(join(__dirname, '../fixtures/real-gem-b', `${n}.pdf`)));
  const pdf = await extractPdf(bytes, { maxPages: 60 });
  return extractRequirementsRules(pdf.pages, { fileName: `${n}.pdf` });
};
const get = (r: { key: string }[], k: string) => r.find((x) => x.key === k) as { numeric: number | null; value: string } | undefined;

describe('rules on real GeM parent bids', () => {
  it('766359 (goods, 14 pp): EMD 261824, ePBG 5%, 14 months, turnover 27 Lakh, past performance 30%', async () => {
    const r = await load('766359');
    expect(get(r, 'emd')?.numeric).toBe(261824);
    expect(get(r, 'epbg')?.numeric).toBe(5);
    expect(get(r, 'epbg_duration')?.numeric).toBe(14);
    expect(get(r, 'turnover_min')?.numeric).toBe(2_700_000);
    expect(get(r, 'past_performance')?.numeric).toBe(30);
    expect(r.filter((x) => x.key === 'document').length).toBeGreaterThan(0);
  });
  it('766334: "EMD Detail … Required No" and "ePBG Detail … Required No" are recorded as 0, not missing', async () => {
    const r = await load('766334');
    expect(get(r, 'emd')).toMatchObject({ numeric: 0, value: 'Not required' });
    expect(get(r, 'epbg')).toMatchObject({ numeric: 0, value: 'Not required' });
  });
});
