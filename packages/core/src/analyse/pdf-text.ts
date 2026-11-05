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

/** True when the bytes start with the PDF magic number. */
export function isPdf(bytes: Uint8Array): boolean {
  // Allow a little leading garbage (some generators emit a BOM / whitespace).
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/** Extract the text of each page (index 0 = page 1). Throws PdfTextError for unreadable files. */
export async function extractPages(bytes: Uint8Array | ArrayBuffer): Promise<string[]> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isPdf(data)) throw new PdfTextError('The file is not a PDF');
  try {
    // pdf.js transfers/detaches the buffer it is given; pass a copy so callers keep theirs.
    const pdf = await getDocumentProxy(new Uint8Array(data));
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
