/**
 * Real-layout extraction corpus (T035, SC-001): field accuracy (value + page) of the rules extractor on
 * GeM-layout bid PDFs must be ≥ 95 % per document and overall.
 *
 * Honest scope: real GeM BidPlus cannot be reached from the build environment, so the three PDFs in
 * test/fixtures/bids/real-*.pdf are synthesised by test/fixtures/bids/generate-real.ts in GeM's real
 * layout — Hindi-first bilingual labels rendered with a Devanagari font (pdf.js returns the Devanagari,
 * in visual glyph order like real GeM PDFs), labels wrapping over lines, values interleaved inside wrapped
 * labels (RA bid), unextracted GeM rows between known ones, the consignee table, and header/footer bid
 * numbers with "Page n of N". Bid numbers, buyers and people are invented. The expected values in
 * real-*.expected.json are the ground truth printed into each PDF (and its page), not extractor output.
 * When genuine GeM PDFs become available, add them here with hand-written expected JSON.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractPages } from '../../src/analyse/pdf-text';
import { detectBidNumber, extractRequirementsRules, MULTI_KEYS } from '../../src/analyse/rules';
import type { Requirement } from '../../src/analyse/types';

interface ExpectedField { key: string; value: string | number | boolean; numeric?: number; page: number }
interface Expected { file: string; bidNumber: string; description: string; layout: string; fields: ExpectedField[] }
interface Doc { expected: Expected; pages: string[]; reqs: Requirement[] }

const dir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/bids');
const docs: Doc[] = [];

beforeAll(async () => {
  const files = (await readdir(dir)).filter((f) => /^real-.*\.expected\.json$/.test(f)).sort();
  for (const f of files) {
    const expected = JSON.parse(await readFile(join(dir, f), 'utf8')) as Expected;
    const pages = await extractPages(new Uint8Array(await readFile(join(dir, expected.file))));
    docs.push({ expected, pages, reqs: extractRequirementsRules(pages, { fileName: expected.file }) });
  }
});

/** Why a field does not match, or null when value (+ numeric) and page are right. */
function miss(reqs: Requirement[], f: ExpectedField): string | null {
  const cands = reqs.filter((r) => r.key === f.key && (!MULTI_KEYS.has(f.key) || r.value === f.value));
  const r = cands[0];
  if (!r) return `${f.key}: missing (want ${JSON.stringify(f.value)} p${f.page})`;
  if (r.value !== f.value) return `${f.key}: value ${JSON.stringify(r.value)} ≠ ${JSON.stringify(f.value)}`;
  if (f.numeric !== undefined && r.numeric !== f.numeric) return `${f.key}: numeric ${r.numeric} ≠ ${f.numeric}`;
  if (r.source.page !== f.page) return `${f.key}: page ${r.source.page} ≠ ${f.page}`;
  return null;
}

const accuracy = (d: Doc) => {
  const misses = d.expected.fields.map((f) => miss(d.reqs, f)).filter((m): m is string => !!m);
  return { total: d.expected.fields.length, ok: d.expected.fields.length - misses.length, misses };
};

describe('real-layout corpus (SC-001)', () => {
  it('has at least three documents: goods, service with contract period, and an RA bid', () => {
    expect(docs.length).toBeGreaterThanOrEqual(3);
    const keys = (d: Doc) => new Set(d.expected.fields.map((f) => `${f.key}=${String(f.value)}`));
    expect(docs.some((d) => keys(d).has('contract_period=2 years'))).toBe(true);
    expect(docs.some((d) => keys(d).has('bid_to_ra=true'))).toBe(true);
    expect(docs.some((d) => d.expected.layout === 'interleaved')).toBe(true);
    // The PDFs really carry Devanagari text, so the bilingual-label stripping is exercised.
    for (const d of docs) expect(d.pages[0]).toMatch(/[ऀ-ॿ]/);
  });

  it('extracts ≥ 95 % of the expected fields with the right value and page, per document and overall', () => {
    let total = 0;
    let ok = 0;
    const report: string[] = [];
    for (const d of docs) {
      const a = accuracy(d);
      total += a.total;
      ok += a.ok;
      report.push(`${d.expected.file}: ${a.ok}/${a.total}${a.misses.length ? ` — ${a.misses.join('; ')}` : ''}`);
      expect(a.ok / a.total, report.at(-1)).toBeGreaterThanOrEqual(0.95);
    }
    expect(ok / total, report.join('\n')).toBeGreaterThanOrEqual(0.95);
  });

  it('every extracted requirement carries file, page, a Devanagari-free quote ≤ 220 chars and method RULE', () => {
    for (const d of docs) {
      for (const r of d.reqs) {
        expect(r.method).toBe('RULE');
        expect(r.source.fileName).toBe(d.expected.file);
        expect(r.source.page).toBeGreaterThan(0);
        expect(r.source.quote!.length).toBeLessThanOrEqual(220);
        expect(r.source.quote).not.toMatch(/[ऀ-ॿ]/);
      }
    }
  });

  it('reads the bid number from the page-1 header of every document', () => {
    for (const d of docs) expect(detectBidNumber(d.pages)).toBe(d.expected.bidNumber);
  });

  /**
   * Mujahid-Alam/gem-tender-pdf-extractor (gem3.py) reads these page-1 lines by fixed index. Ideas only —
   * no code copied (the repository has no licence). We use its field list as a coverage checklist: every
   * one must be found by our label-to-next-label reader on page 1 of every corpus document.
   */
  it("covers Mujahid-Alam's page-1 field list on every document", () => {
    const PAGE1_FIELDS = [
      'bid_end', 'bid_opening', 'offer_validity', 'ministry', 'department', 'organisation', 'office', 'total_quantity',
      'item_category', 'mse_exemption', 'startup_exemption',
    ];
    for (const d of docs) {
      for (const k of PAGE1_FIELDS) {
        const r = d.reqs.find((x) => x.key === k);
        expect(r, `${d.expected.file}: ${k}`).toBeDefined();
        expect(r!.source.page, `${d.expected.file}: ${k}`).toBe(1);
      }
    }
  });
});
