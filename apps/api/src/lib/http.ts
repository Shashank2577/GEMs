/** Small HTTP helpers shared by download routes. */

export type DispositionKind = 'inline' | 'attachment';

/**
 * `content-disposition` value with an ASCII `filename` fallback first (old clients, exact-match tests) and an
 * RFC 5987 / RFC 8187 `filename*=UTF-8''…` parameter carrying the real name (006/FR-059, consistent with 004/FR-006).
 *
 *   contentDisposition('attachment', 'GEM_2026_B_700001_technical_packet.pdf')
 *   → attachment; filename="GEM_2026_B_700001_technical_packet.pdf"; filename*=UTF-8''GEM_2026_B_700001_technical_packet.pdf
 */
export function contentDisposition(kind: DispositionKind, fileName: string): string {
  const name = fileName.replace(/[\r\n]/g, ' ').trim() || 'document.pdf';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).replace(/[^\w]/g, '') || 'pdf' : 'pdf';
  let ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const stem = ascii.lastIndexOf('.') > 0 ? ascii.slice(0, ascii.lastIndexOf('.')) : ascii;
  if (!/[A-Za-z0-9]/.test(stem)) ascii = `document.${ext}`;
  // encodeURIComponent leaves !'()* unescaped; RFC 5987 attr-char excludes ' ( ) * so escape them too.
  const star = encodeURIComponent(name).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
}
