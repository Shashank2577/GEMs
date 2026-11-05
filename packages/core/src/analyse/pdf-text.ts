/**
 * PDF text extraction per page (T041, FR-010). Uses `unpdf` (pdf.js serverless build), which runs
 * on Node and Cloudflare Workers. Pages are joined with a form feed (`\f`) for storage in
 * `tender_documents.text`.
 */
import { extractText, getDocumentProxy } from 'unpdf';

export const PAGE_SEPARATOR = '\f';

export class PdfTextError extends Error {
  constructor(message: string) { super(message); this.name = 'PdfTextError'; }
}

/** The PDF has more pages than the caller accepts (008/FR-030); thrown before any text is extracted. */
export class PdfPageLimitError extends Error {
  constructor(readonly pages: number, readonly maxPages: number) {
    super(`The PDF has ${pages} pages (limit ${maxPages})`);
    this.name = 'PdfPageLimitError';
  }
}

export interface ExtractOptions {
  /** Reject documents with more pages than this (PdfPageLimitError) after reading only the page count. */
  maxPages?: number;
}

/** True when the bytes start with the PDF magic number. */
export function isPdf(bytes: Uint8Array): boolean {
  // Allow a little leading garbage (some generators emit a BOM / whitespace).
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/** Extract the text of each page (index 0 = page 1). Throws PdfTextError for unreadable files. */
export async function extractPages(bytes: Uint8Array | ArrayBuffer, opts: ExtractOptions = {}): Promise<string[]> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isPdf(data)) throw new PdfTextError('The file is not a PDF');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js transfers/detaches the buffer it is given; pass a copy so callers keep theirs.
    pdf = await getDocumentProxy(new Uint8Array(data));
  } catch (e) {
    throw new PdfTextError(`Could not read the PDF: ${(e as Error).message}`);
  }
  // Page cap first: extracting 1,000 pages of text is what blows a Worker's CPU/memory budget.
  if (opts.maxPages !== undefined && pdf.numPages > opts.maxPages) {
    try { await pdf.destroy(); } catch { /* best effort */ }
    throw new PdfPageLimitError(pdf.numPages, opts.maxPages);
  }
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return pages.map((p) => (p ?? '').replace(/\r\n?/g, '\n').replace(/\f/g, ' '));
  } catch (e) {
    throw new PdfTextError(`Could not read the PDF: ${(e as Error).message}`);
  }
}

export const joinPages = (pages: string[]) => pages.join(PAGE_SEPARATOR);
export const splitPages = (text: string | null | undefined) => (text ? text.split(PAGE_SEPARATOR) : []);

/** True when the document has (almost) no extractable text — likely a scan that needs OCR. */
export function looksScanned(pages: string[]): boolean {
  const chars = pages.reduce((n, p) => n + p.replace(/\s+/g, '').length, 0);
  return pages.length > 0 && chars / pages.length < 40;
}

/** A page whose text layer has fewer non-blank characters than this counts as empty (a page number is not text). */
export const EMPTY_PAGE_MAX_CHARS = 10;

/** Share of pages (0..1) whose text layer is empty. */
export function emptyPageRatio(pages: string[]): number {
  if (!pages.length) return 1;
  return pages.filter((p) => p.replace(/\s+/g, '').length < EMPTY_PAGE_MAX_CHARS).length / pages.length;
}

/**
 * 008/FR-030: a document is a scan for analysis when `looksScanned()` is true or its text layer is empty on
 * ≥ `minEmptyRatio` of its pages (default 80 %).
 */
export function isScannedDocument(pages: string[], minEmptyRatio = 0.8): boolean {
  return looksScanned(pages) || emptyPageRatio(pages) >= minEmptyRatio;
}
