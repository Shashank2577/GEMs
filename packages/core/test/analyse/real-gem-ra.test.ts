import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPdf } from '../../src/analyse/pdf-text';
import { extractRequirementsRules } from '../../src/analyse/rules';

// Real reverse-auction documents downloaded from GeM on 2026-11-06 (public). They are a 2-page summary; the full terms
// live in the parent bid, which the API now fetches (see parentBidRef).
const load = async (n: string) => {
  const bytes = new Uint8Array(readFileSync(join(__dirname, '../fixtures/real-gem-ra', `GEM_2026_R_${n}.pdf`)));
  const pdf = await extractPdf(bytes, { maxPages: 10 });
  return extractRequirementsRules(pdf.pages, { fileName: `${n}.pdf` });
};
const keys = (r: { key: string }[]) => new Set(r.map((x) => x.key));

describe('rules on real GeM reverse-auction documents', () => {
  it('reads the header block and turnover of a services RA (765950)', async () => {
    const k = keys(await load('765950'));
    for (const key of ['ministry', 'department', 'organisation', 'contract_period', 'turnover_min', 'mse_exemption', 'startup_exemption']) expect(k.has(key), key).toBe(true);
  });
  it('reads quantity and a 108 Lakh turnover of a works RA (765946)', async () => {
    const r = await load('765946');
    expect(keys(r).has('total_quantity')).toBe(true);
    expect(JSON.stringify(r.find((x) => x.key === 'turnover_min'))).toMatch(/108|10[\s,]?800[\s,]?000|10800000/);
  });
});
