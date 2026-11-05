import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { OCR_JSON_SCHEMA, OCR_MAX_BYTES_PER_CALL, OCR_MAX_PAGES_PER_CALL, OcrSplitError, buildOcrRequest, parseOcrPages, splitPdfForOcr, toBase64 } from '../../src/analyse/ocr';

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
  });

  it('keeps the longer text of a repeated page; accepts a bare array; unusable replies give all-empty pages', () => {
    expect(parseOcrPages({ pages: [{ page: 1, text: 'a' }, { page: 1, text: 'abc' }] }, 1).pages).toEqual(['abc']);
    expect(parseOcrPages([{ page: 1, text: 'x' }], 1).pages).toEqual(['x']);
    expect(parseOcrPages('garbage', 2)).toEqual({ pages: ['', ''], missing: [1, 2] });
    expect(parseOcrPages({ pages: [{ page: 'one', text: 1 }] }, 1).missing).toEqual([1]);
  });
});
