import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  OCR_CALL_TIMEOUT_MS, OCR_DOCUMENT_BUDGET_MS, OCR_JSON_SCHEMA, OCR_MAX_BYTES_PER_CALL, OCR_MAX_CALLS_PER_ANALYSIS, OCR_MAX_CALLS_PER_DOCUMENT, OCR_MAX_CONFIDENCE,
  OCR_MAX_OUTPUT_TOKENS, OCR_MAX_PAGES_PER_CALL, OCR_PAGES_PER_CALL, OcrSplitError, buildOcrRequest, markOcrRequirements, openPdfForOcr, parseOcrPages,
  splitPdfForOcr, toBase64,
} from '../../src/analyse/ocr';

async function pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([595, 842]).drawText(`Scanned page ${i}`, { x: 40, y: 780, size: 10, font });
  return doc.save();
}
const pageCount = async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount();

describe('splitPdfForOcr (T090, FR-052)', () => {
  it('defaults are 100 pages and 22 MB per call', () => {
    expect([OCR_MAX_PAGES_PER_CALL, OCR_MAX_BYTES_PER_CALL]).toEqual([100, 22 * 1024 * 1024]);
  });

  it('a PDF within the limits is one part, unchanged', async () => {
    const bytes = await pdf(5);
    const parts = await splitPdfForOcr(bytes);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ firstPage: 1, lastPage: 5 });
    expect(parts[0]!.bytes).toBe(bytes);
  });

  it('splits by page count into ordered, contiguous parts', async () => {
    const parts = await splitPdfForOcr(await pdf(5), { maxPages: 2 });
    expect(parts.map((p) => [p.firstPage, p.lastPage])).toEqual([[1, 2], [3, 4], [5, 5]]);
    expect(await Promise.all(parts.map((p) => pageCount(p.bytes)))).toEqual([2, 2, 1]);
  });

  it('halves a part that is over the byte limit; a single page over the limit is an OcrSplitError', async () => {
    const bytes = await pdf(6);
    const one = await splitPdfForOcr(bytes, { maxPages: 1 });
    const maxBytes = Math.max(...one.map((p) => p.bytes.length)) + 50;
    const parts = await splitPdfForOcr(bytes, { maxPages: 100, maxBytes: Math.min(bytes.length - 1, maxBytes) });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.bytes.length <= maxBytes)).toBe(true);
    expect(parts.map((p) => p.firstPage)[0]).toBe(1);
    expect(parts.at(-1)!.lastPage).toBe(6);
    parts.reduce((next, p) => { expect(p.firstPage).toBe(next); return p.lastPage + 1; }, 1);
    await expect(splitPdfForOcr(bytes, { maxBytes: 10 })).rejects.toBeInstanceOf(OcrSplitError);
  });

  it('builds parts lazily, one per request, and only up to the page limit (review S6)', async () => {
    const src = await openPdfForOcr(await pdf(9));
    expect(src.totalPages).toBe(9);
    const it = src.parts({ maxPages: 2, pageLimit: 5 });
    const first = await it.next();
    expect(first.value).toMatchObject({ firstPage: 1, lastPage: 2 });
    const rest: [number, number][] = [];
    for await (const p of it) rest.push([p.firstPage, p.lastPage]);
    // Pages 6–9 are never copied into a part.
    expect(rest).toEqual([[3, 4], [5, 5]]);
    // A page limit below the page count never returns the original bytes, even when the PDF would fit in one part.
    const cut = await splitPdfForOcr(await pdf(4), { pageLimit: 3 });
    expect(cut.map((p) => [p.firstPage, p.lastPage])).toEqual([[1, 3]]);
    expect(await pageCount(cut[0]!.bytes)).toBe(3);
  });

  it('a consumer that stops early never builds the later parts', async () => {
    const src = await openPdfForOcr(await pdf(6));
    const create = vi.spyOn(PDFDocument, 'create');
    try {
      let seen = 0;
      for await (const _p of src.parts({ maxPages: 1 })) { seen++; if (seen === 2) break; }
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      create.mockRestore();
    }
  });

  it('rejects bytes that are not a PDF', async () => {
    await expect(splitPdfForOcr(new TextEncoder().encode('not a pdf'))).rejects.toBeInstanceOf(OcrSplitError);
  });
});

describe('buildOcrRequest', () => {
  it('is a document block + transcription prompt + page schema, with base64 of the part', async () => {
    const bytes = await pdf(2);
    const r = buildOcrRequest({ bytes, firstPage: 11, lastPage: 12 });
    expect(r.content[0]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(bytes) } });
    expect(r.content[1].type).toBe('text');
    expect(r.content[1].text).toMatch(/Transcribe every page/);
    expect(r.pageCount).toBe(2);
    expect(r.jsonSchema).toBe(OCR_JSON_SCHEMA);
    expect(r.maxTokens).toBeGreaterThanOrEqual(4096);
    expect(r.system).toMatch(/Hindi/);
    expect(atob(r.content[0].source.data).startsWith('%PDF')).toBe(true);
  });

  it('toBase64 handles inputs larger than one chunk', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    const back = Uint8Array.from(atob(toBase64(big)), (c) => c.charCodeAt(0));
    expect(back).toEqual(big);
  });
});

describe('parseOcrPages', () => {
  it('maps page numbers to indexes, normalises text and lists missing pages', () => {
    const r = parseOcrPages({ pages: [{ page: 2, text: ' Bid\r\nNo. 1 ' }, { page: 1, text: 'first' }, { page: 4, text: '' }, { page: 9, text: 'out of range' }] }, 4);
    expect(r.pages).toEqual(['first', 'Bid\nNo. 1', '', '']);
    expect(r.missing).toEqual([3, 4]);
    // Page 4 came back explicitly blank; page 3 was not returned at all (review S3).
    expect(r.absent).toEqual([3]);
  });

  it('a null text counts as absent, an explicit empty string as a blank page', () => {
    expect(parseOcrPages({ pages: [{ page: 1, text: null }, { page: 2, text: '   ' }] }, 2)).toMatchObject({ missing: [1, 2], absent: [1] });
  });

  it('keeps the longer text of a repeated page; accepts a bare array; unusable replies give all-empty pages', () => {
    expect(parseOcrPages({ pages: [{ page: 1, text: 'a' }, { page: 1, text: 'abc' }] }, 1).pages).toEqual(['abc']);
    expect(parseOcrPages([{ page: 1, text: 'x' }], 1).pages).toEqual(['x']);
    expect(parseOcrPages('garbage', 2)).toEqual({ pages: ['', ''], missing: [1, 2], absent: [1, 2] });
    expect(parseOcrPages({ pages: [{ page: 'one', text: 1 }] }, 1).missing).toEqual([1]);
  });
});

describe('API OCR limits and provenance (T091, FR-052)', () => {
  it('pins the per-call, per-document and per-analysis limits', () => {
    expect([OCR_PAGES_PER_CALL, OCR_MAX_CALLS_PER_DOCUMENT, OCR_CALL_TIMEOUT_MS, OCR_DOCUMENT_BUDGET_MS, OCR_MAX_CALLS_PER_ANALYSIS])
      .toEqual([5, 30, 90_000, 600_000, 4]);
    // 30 calls of 5 pages cover the 150-page text cap; one call's output budget stays well under the non-streaming cap (16k).
    expect(OCR_PAGES_PER_CALL * OCR_MAX_CALLS_PER_DOCUMENT).toBe(150);
    expect(buildOcrRequest({ bytes: new Uint8Array([1]), firstPage: 1, lastPage: OCR_PAGES_PER_CALL }).maxTokens).toBe(7_500);
    // Even a 100-page part (the FR-052 ceiling) never asks for more than the cap.
    expect(OCR_MAX_OUTPUT_TOKENS).toBe(16_000);
    expect(buildOcrRequest({ bytes: new Uint8Array([1]), firstPage: 1, lastPage: 100 }).maxTokens).toBe(16_000);
  });

  it('markOcrRequirements sets source.ocr and caps confidence at 0.8', () => {
    const reqs: { key: string; confidence: number; source: { documentId?: string; page?: number; ocr?: boolean } }[] = [
      { key: 'emd', confidence: 0.95, source: { documentId: 'd', page: 2 } },
      { key: 'turnover_min', confidence: 0.6, source: {} },
    ];
    const out = markOcrRequirements(reqs);
    expect(out).toEqual([
      { key: 'emd', confidence: OCR_MAX_CONFIDENCE, source: { documentId: 'd', page: 2, ocr: true } },
      { key: 'turnover_min', confidence: 0.6, source: { ocr: true } },
    ]);
  });
});
