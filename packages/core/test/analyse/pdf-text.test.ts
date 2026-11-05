/**
 * pdf-text byte-safety and rejection tests (T017, FR-003, NFR-009).
 *
 * The first two cases and `test/fixtures/bids/synthetic-tender.pdf` are ported from
 * erenmyeager15/india-government-tenders-scraper `src/pdf.test.ts` + `test/fixtures/synthetic-tender.pdf`
 * (Apache-2.0, commit 46925c6; see NOTICE), adapted from node:test to vitest and to our `extractPages`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPages, isPdf, joinPages, looksScanned, PdfTextError } from '../../src/analyse/pdf-text';

const fixture = readFileSync(new URL('../fixtures/bids/synthetic-tender.pdf', import.meta.url));

describe('extractPages (ported from erenmyeager15 pdf.test.ts)', () => {
  it('reads a small bid PDF from a pooled Buffer slice without corrupting the source bytes, twice', async () => {
    // A Buffer.allocUnsafe() slice shares a larger pooled ArrayBuffer at a non-zero offset;
    // pdf.js detaches what it is given, so extractPages must copy exactly the slice.
    const pooled = Buffer.allocUnsafe(fixture.length + 73);
    fixture.copy(pooled, 73);
    const bytes = pooled.subarray(73);
    expect(bytes.byteOffset).toBeGreaterThan(0);
    const original = Buffer.from(bytes);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const text = joinPages(await extractPages(bytes));
      expect(text).toMatch(/Synthetic procurement fixture/);
      expect(text).toMatch(/Bid Opening Date\/Time 31-10-2026 10:00:00/);
      expect(Buffer.from(bytes).equals(original)).toBe(true);
      expect(bytes.byteLength).toBe(original.byteLength); // not detached
    }
  });

  it('rejects invalid bytes behind a %PDF-1.7 header with PdfTextError', async () => {
    const bad = Buffer.from('%PDF-1.7\ninvalid fixture');
    expect(isPdf(bad)).toBe(true);
    await expect(extractPages(bad)).rejects.toBeInstanceOf(PdfTextError);
  });
});

describe('extractPages (TenderPilot cases)', () => {
  it('accepts a PDF prefixed with a UTF-8 BOM and leading whitespace', async () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('\r\n  '), fixture]);
    expect(isPdf(bom)).toBe(true);
    const pages = await extractPages(bom);
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(joinPages(pages)).toMatch(/Bid Opening Date\/Time 31-10-2026 10:00:00/);
    expect(looksScanned(pages)).toBe(false);
  });

  it('accepts an ArrayBuffer and leaves it attached', async () => {
    const ab = new Uint8Array(fixture).buffer;
    const pages = await extractPages(ab);
    expect(joinPages(pages)).toMatch(/Synthetic procurement fixture/);
    expect(ab.byteLength).toBe(fixture.length);
  });

  it('rejects non-PDF bytes before parsing', async () => {
    await expect(extractPages(new TextEncoder().encode('PK\u0003\u0004 docx'))).rejects.toThrow('not a PDF');
    expect(isPdf(Buffer.concat([Buffer.alloc(1100, 0x20), Buffer.from('%PDF-1.7')]))).toBe(false);
  });
});
