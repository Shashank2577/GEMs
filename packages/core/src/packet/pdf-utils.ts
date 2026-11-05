/** Small pdf-lib helpers shared by annexure rendering and the packet builder. */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export const A4: [number, number] = [595.28, 841.89];
export const MARGIN = 56;

export const INK = rgb(0.09, 0.1, 0.13);
export const MUTED = rgb(0.4, 0.42, 0.47);
export const RULE = rgb(0.82, 0.84, 0.88);
export const BRAND = rgb(0.27, 0.27, 0.78);

const REPLACEMENTS: Record<string, string> = {
  '₹': 'Rs. ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '≥': '>=', '≤': '<=', '→': '->', '✓': 'Yes', '✔': 'Yes',
  '−': '-', '‐': '-', '‑': '-',
};

/**
 * pdf-lib standard fonts only encode WinAnsi. Replace common symbols (₹ → "Rs.") and drop anything
 * the font cannot draw (e.g. Devanagari) instead of throwing.
 */
export function sanitize(text: string, font: PDFFont): string {
  const charset = new Set(font.getCharacterSet());
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const rep = REPLACEMENTS[ch];
    if (rep !== undefined) { out += rep; continue; }
    const cp = ch.codePointAt(0)!;
    if (ch === '\n' || ch === '\t') { out += ' '; continue; }
    out += charset.has(cp) ? ch : cp > 0x7f ? '' : '?';
  }
  return out.replace(/ {2,}/g, ' ');
}

/** Greedy word wrap to a max width (long words are hard-broken). */
export function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  const width = (s: string) => font.widthOfTextAtSize(s, size);
  for (let w of words) {
    while (width(w) > maxWidth) {
      let i = w.length - 1;
      while (i > 1 && width(w.slice(0, i)) > maxWidth) i--;
      if (line) { lines.push(line); line = ''; }
      lines.push(w.slice(0, i));
      w = w.slice(i);
    }
    const next = line ? `${line} ${w}` : w;
    if (width(next) <= maxWidth) line = next;
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export interface Fonts { regular: PDFFont; bold: PDFFont; italic: PDFFont }

export async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  const [regular, bold, italic] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
    doc.embedFont(StandardFonts.HelveticaOblique),
  ]);
  return { regular, bold, italic };
}

/** Draw text with sanitisation; returns the width drawn. */
export function text(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size: number, color = INK): number {
  const clean = sanitize(s, font);
  page.drawText(clean, { x, y, size, font, color });
  return font.widthOfTextAtSize(clean, size);
}

/** Right-aligned text ending at x. */
export function textRight(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size: number, color = INK) {
  const clean = sanitize(s, font);
  page.drawText(clean, { x: x - font.widthOfTextAtSize(clean, size), y, size, font, color });
}

export function textCenter(page: PDFPage, s: string, y: number, font: PDFFont, size: number, color = INK) {
  const clean = sanitize(s, font);
  const [w] = [page.getWidth()];
  page.drawText(clean, { x: (w - font.widthOfTextAtSize(clean, size)) / 2, y, size, font, color });
}

/** dd-mm-yyyy in IST. */
export function dateIST(d: Date): string {
  const t = new Date(d.getTime() + 330 * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}-${p(t.getUTCMonth() + 1)}-${t.getUTCFullYear()}`;
}

/** "12 Nov 2026, 3:00 PM IST" — lives in the neutral `time` module; re-exported for existing imports. */
export { dateTimeIST } from '../time';
