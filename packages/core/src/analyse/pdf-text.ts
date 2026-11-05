/**
 * PDF text extraction per page (T041, FR-010). Uses `unpdf` (pdf.js serverless build), which runs
 * on Node and Cloudflare Workers. Pages are joined with a form feed (`\f`) for storage in
 * `tender_documents.text`.
 */
import { getDocumentProxy } from 'unpdf';

export const PAGE_SEPARATOR = '\f';

export class PdfTextError extends Error {
  constructor(message: string) { super(message); this.name = 'PdfTextError'; }
}

/** True when the bytes start with the PDF magic number. */
export function isPdf(bytes: Uint8Array): boolean {
  // Allow a little leading garbage (some generators emit a BOM / whitespace).
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

export interface ExtractedPdf {
  /** Text of the first `pages.length` pages (index 0 = page 1). */
  pages: string[];
  /** Page count of the PDF itself; > pages.length when `maxPages` truncated the extraction. */
  totalPages: number;
}

/**
 * Extract the text of each page, one page at a time (pdf.js releases a page's resources before the
 * next is parsed, which keeps peak memory well below unpdf's all-pages-in-parallel `extractText`;
 * see specs/004-analyse-scoring/plan.md "Workers budget"). `maxPages` caps the pages read.
 * Throws PdfTextError for unreadable files.
 */
export async function extractPdf(bytes: Uint8Array | ArrayBuffer, opts: { maxPages?: number } = {}): Promise<ExtractedPdf> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isPdf(data)) throw new PdfTextError('The file is not a PDF');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    // pdf.js transfers/detaches the buffer it is given; pass a copy so callers keep theirs.
    pdf = await getDocumentProxy(new Uint8Array(data));
    const totalPages = pdf.numPages;
    const take = Math.min(totalPages, opts.maxPages ?? totalPages);
    const pages: string[] = [];
    for (let n = 1; n <= take; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items.filter((i) => 'str' in i && i.str != null).map((i) => ('str' in i ? i.str : '') + ('hasEOL' in i && i.hasEOL ? '\n' : '')).join('')
        .replace(/\r\n?/g, '\n').replace(/\f/g, ' '));
      page.cleanup();
    }
    return { pages, totalPages };
  } catch (e) {
    throw new PdfTextError(`Could not read the PDF: ${(e as Error).message}`);
  } finally {
    await pdf?.destroy().catch(() => undefined);
  }
}

/** Extract the text of every page (index 0 = page 1). Throws PdfTextError for unreadable files. */
export async function extractPages(bytes: Uint8Array | ArrayBuffer): Promise<string[]> {
  return (await extractPdf(bytes)).pages;
}

export const joinPages = (pages: string[]) => pages.join(PAGE_SEPARATOR);
export const splitPages = (text: string | null | undefined) => (text ? text.split(PAGE_SEPARATOR) : []);

/** True when the document has (almost) no extractable text — likely a scan that needs OCR. */
export function looksScanned(pages: string[]): boolean {
  const chars = pages.reduce((n, p) => n + p.replace(/\s+/g, '').length, 0);
  return pages.length > 0 && chars / pages.length < 40;
}
