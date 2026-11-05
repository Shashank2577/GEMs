/**
 * Bid packet builder (T062; FR-025). Merges documents into one bookmarked PDF for the technical
 * upload on GeM:
 *
 *   [cover page] [index page(s)] [item 1 pages] [item 2 pages] …
 *
 * - PDFs are copied page by page (pdf-lib copyPages); JPG/PNG images are placed on A4 pages,
 *   scaled to fit; anything else / corrupt files are skipped with a warning (never a crash).
 * - The index lists every item with its starting page and links to it; each item also gets an
 *   outline bookmark; every page is stamped "Bid … · Page x of N" in the footer.
 * - Warns when the result exceeds the upload size limit (GeM rejects large files).
 *
 * The packet is prepared for HUMAN review and upload — TenderPilot never uploads or submits it.
 */
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFPage, type PDFRef } from 'pdf-lib';
import { A4, BRAND, INK, MARGIN, MUTED, RULE, dateIST, dateTimeIST, embedFonts, sanitize, text, textRight, wrap, type Fonts } from './pdf-utils';

export const DEFAULT_MAX_PACKET_BYTES = 20 * 1024 * 1024;

export type BuildItemKind = 'cover' | 'annexure' | 'vault' | 'tender_doc';

export interface BuildItem {
  kind: BuildItemKind;
  refId?: string;
  title: string;
}

export interface PacketCompany { legalName?: string | null; gstin?: string | null; pan?: string | null; address?: string | null; state?: string | null }
export interface PacketTender { bidNumber: string; title: string; organisation?: string | null; ministry?: string | null; endAt?: string | Date | null }

export interface BuildPacketInput {
  items: BuildItem[];
  /** Return the file bytes for a non-cover item (null when it no longer exists). */
  loadBytes: (item: BuildItem) => Promise<Uint8Array | null>;
  company: PacketCompany | null | undefined;
  tender: PacketTender;
  now?: Date;
  /** Size warning threshold (bytes). Default 20 MB. */
  maxBytes?: number;
  /** Stamp "Page x of N" in the footer of every page (default true). */
  stampPageNumbers?: boolean;
}

export interface BuiltItem { kind: BuildItemKind; refId?: string; title: string; startPage: number; pages: number; included: boolean; error?: string }

export interface BuildPacketResult {
  bytes: Uint8Array;
  pageCount: number;
  warnings: string[];
  items: BuiltItem[];
  /** Outline titles in order (for display / tests). */
  bookmarks: { title: string; page: number }[];
}

type Src =
  | { kind: 'pdf'; doc: PDFDocument; pages: number }
  | { kind: 'image'; bytes: Uint8Array; mime: 'png' | 'jpg'; pages: 1 };

export function sniff(bytes: Uint8Array): 'pdf' | 'png' | 'jpg' | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 4 < head.length; i++) if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46) return 'pdf';
  return null;
}

const ROWS_FIRST = 26;
const ROWS_NEXT = 34;

/** Number of index pages needed for n items. */
export const indexPagesFor = (n: number) => (n <= ROWS_FIRST ? 1 : 1 + Math.ceil((n - ROWS_FIRST) / ROWS_NEXT));

const fmtMB = (b: number) => `${(b / (1024 * 1024)).toFixed(1)} MB`;

export async function buildPacket(input: BuildPacketInput): Promise<BuildPacketResult> {
  const now = input.now ?? new Date();
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_PACKET_BYTES;
  const warnings: string[] = [];
  const hasCover = input.items.some((i) => i.kind === 'cover');
  const content = input.items.filter((i) => i.kind !== 'cover');

  // 1) Load every source first: page counts are needed for the index.
  const loaded: { item: BuildItem; src: Src | null; error?: string }[] = [];
  for (const item of content) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await input.loadBytes(item);
    } catch (e) {
      loaded.push({ item, src: null, error: `could not be read (${(e as Error).message})` });
      continue;
    }
    if (!bytes || bytes.length === 0) { loaded.push({ item, src: null, error: 'is missing — the file was not found' }); continue; }
    const kind = sniff(bytes);
    if (kind === 'pdf') {
      try {
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
        const pages = doc.getPageCount();
        if (!pages) { loaded.push({ item, src: null, error: 'has no pages' }); continue; }
        if (doc.isEncrypted) warnings.push(`"${item.title}" is password-protected; its pages may not display correctly. Upload an unlocked copy to the vault.`);
        loaded.push({ item, src: { kind: 'pdf', doc, pages } });
      } catch {
        loaded.push({ item, src: null, error: 'is damaged and could not be opened' });
      }
    } else if (kind === 'png' || kind === 'jpg') {
      loaded.push({ item, src: { kind: 'image', bytes, mime: kind, pages: 1 } });
    } else {
      loaded.push({ item, src: null, error: 'is not a PDF, PNG or JPG file' });
    }
  }
  for (const l of loaded) if (!l.src) warnings.push(`"${l.item.title}" ${l.error} — skipped.`);

  const good = loaded.filter((l) => l.src);
  const indexPages = hasCover ? indexPagesFor(good.length) : 0;
  const front = hasCover ? 1 + indexPages : 0;

  // 2) Page plan
  const built: BuiltItem[] = [];
  const builtSrc: (Src | null)[] = [];
  let next = front + 1;
  if (hasCover) {
    const c = input.items.find((i) => i.kind === 'cover')!;
    built.push({ kind: 'cover', refId: c.refId, title: c.title || 'Cover & index', startPage: 1, pages: front, included: true });
    builtSrc.push(null);
  }
  for (const l of loaded) {
    builtSrc.push(l.src);
    if (!l.src) { built.push({ kind: l.item.kind, refId: l.item.refId, title: l.item.title, startPage: 0, pages: 0, included: false, error: l.error }); continue; }
    built.push({ kind: l.item.kind, refId: l.item.refId, title: l.item.title, startPage: next, pages: l.src.pages, included: true });
    next += l.src.pages;
  }
  const total = next - 1;

  // 3) Assemble
  const out = await PDFDocument.create();
  out.setTitle(sanitizeMeta(`Technical bid packet — ${input.tender.bidNumber}`));
  out.setSubject(sanitizeMeta(input.tender.title));
  out.setAuthor(sanitizeMeta(input.company?.legalName || 'Bidder'));
  out.setCreator('TenderPilot');
  out.setProducer('TenderPilot (pdf-lib)');
  out.setCreationDate(now);
  const f = await embedFonts(out);

  const coverPages: PDFPage[] = [];
  if (hasCover) {
    coverPages.push(out.addPage(A4));
    for (let i = 0; i < indexPages; i++) coverPages.push(out.addPage(A4));
  }

  const firstPageOf = new Map<number, PDFPage>(); // built index → first page
  for (let bi = 0; bi < built.length; bi++) {
    const b = built[bi];
    if (b.kind === 'cover' || !b.included) continue;
    const src = builtSrc[bi]!;
    if (src.kind === 'pdf') {
      const copied = await out.copyPages(src.doc, src.doc.getPageIndices());
      copied.forEach((p, i) => { out.addPage(p); if (i === 0) firstPageOf.set(bi, p); });
    } else {
      const page = out.addPage(A4);
      try {
        const img = src.mime === 'png' ? await out.embedPng(src.bytes) : await out.embedJpg(src.bytes);
        const [W, H] = A4;
        const box = { w: W - 48, h: H - 72 };
        const scale = Math.min(box.w / img.width, box.h / img.height, 2);
        const w = img.width * scale, h = img.height * scale;
        page.drawImage(img, { x: (W - w) / 2, y: (H - h) / 2 + 6, width: w, height: h });
      } catch {
        text(page, `This image could not be embedded: ${b.title}`, MARGIN, A4[1] / 2, f.regular, 11, MUTED);
        warnings.push(`"${b.title}" image could not be embedded — a placeholder page was added.`);
      }
      firstPageOf.set(bi, page);
    }
  }

  if (hasCover) {
    drawCover(coverPages[0], f, input, now, built, total);
    drawIndex(out, coverPages.slice(1), f, input, built, firstPageOf);
  }

  // Footer stamp
  if (input.stampPageNumbers !== false) {
    const pages = out.getPages();
    pages.forEach((p, i) => {
      const { width } = p.getSize();
      const label = `${input.tender.bidNumber}  ·  Page ${i + 1} of ${pages.length}`;
      textRight(p, label, width - 18, 10, f.regular, 6.5, MUTED);
    });
  }

  // Bookmarks
  const marks: { title: string; page: PDFPage; pageNo: number }[] = [];
  if (hasCover) {
    marks.push({ title: 'Cover', page: coverPages[0], pageNo: 1 });
    marks.push({ title: 'Index', page: coverPages[1], pageNo: 2 });
  }
  built.forEach((b, bi) => {
    const p = firstPageOf.get(bi);
    if (p) marks.push({ title: b.title, page: p, pageNo: b.startPage });
  });
  addOutline(out, marks.map((m) => ({ title: m.title, ref: m.page.ref })));

  const bytes = await out.save({ useObjectStreams: true });
  if (bytes.length > maxBytes) {
    warnings.push(`The packet is ${fmtMB(bytes.length)}, above the ${fmtMB(maxBytes)} upload limit. Compress large scans in the vault or split the packet before uploading on GeM.`);
  }
  return { bytes, pageCount: out.getPageCount(), warnings, items: built, bookmarks: marks.map((m) => ({ title: m.title, page: m.pageNo })) };
}

// ───────────── cover & index ─────────────

function drawCover(page: PDFPage, f: Fonts, input: BuildPacketInput, now: Date, built: BuiltItem[], total: number) {
  const [W, H] = A4;
  const width = W - MARGIN * 2;
  page.drawRectangle({ x: 0, y: H - 10, width: W, height: 10, color: BRAND });
  let y = H - 110;
  text(page, 'TECHNICAL BID PACKET', MARGIN, y, f.bold, 10, BRAND);
  y -= 30;
  for (const l of wrap(sanitize(input.tender.title, f.bold), f.bold, 22, width).slice(0, 4)) { text(page, l, MARGIN, y, f.bold, 22); y -= 28; }
  y -= 4;
  text(page, `Bid No. ${input.tender.bidNumber}`, MARGIN, y, f.regular, 13, MUTED);
  y -= 40;

  const row = (label: string, value: string | null | undefined) => {
    if (!value) return;
    text(page, label.toUpperCase(), MARGIN, y, f.bold, 7.5, MUTED);
    const lines = wrap(sanitize(value, f.regular), f.regular, 11, width - 130);
    lines.forEach((l, i) => text(page, l, MARGIN + 130, y - i * 14 + 1, f.regular, 11));
    y -= Math.max(1, lines.length) * 14 + 10;
  };
  page.drawLine({ start: { x: MARGIN, y: y + 16 }, end: { x: W - MARGIN, y: y + 16 }, thickness: 0.5, color: RULE });
  row('Buyer', [input.tender.organisation, input.tender.ministry].filter(Boolean).join(', '));
  row('Bid closes', input.tender.endAt ? dateTimeIST(input.tender.endAt) : null);
  y -= 8;
  page.drawLine({ start: { x: MARGIN, y: y + 16 }, end: { x: W - MARGIN, y: y + 16 }, thickness: 0.5, color: RULE });
  const c = input.company ?? {};
  row('Bidder', c.legalName || '—');
  row('GSTIN', c.gstin);
  row('PAN', c.pan);
  row('Address', [c.address, c.state].filter(Boolean).join(', '));
  y -= 8;
  page.drawLine({ start: { x: MARGIN, y: y + 16 }, end: { x: W - MARGIN, y: y + 16 }, thickness: 0.5, color: RULE });
  const docs = built.filter((b) => b.kind !== 'cover' && b.included).length;
  row('Contents', `${docs} document${docs === 1 ? '' : 's'}, ${total} page${total === 1 ? '' : 's'} (index on page 2)`);
  row('Prepared on', dateIST(now));

  // Disclaimer box
  const boxH = 74;
  page.drawRectangle({ x: MARGIN, y: 70, width, height: boxH, color: undefined, borderColor: RULE, borderWidth: 0.8 });
  text(page, 'Prepared with TenderPilot — for human review and upload', MARGIN + 14, 70 + boxH - 22, f.bold, 9.5);
  const note = 'Check every page before uploading it on GeM. The financial price, OTP / DSC / e-Sign authentication and the final submission are done by you on the GeM portal; TenderPilot never performs them.';
  wrap(sanitize(note, f.regular), f.regular, 8.5, width - 28).forEach((l, i) => text(page, l, MARGIN + 14, 70 + boxH - 38 - i * 11, f.regular, 8.5, MUTED));
}

function drawIndex(out: PDFDocument, pages: PDFPage[], f: Fonts, input: BuildPacketInput, built: BuiltItem[], firstPageOf: Map<number, PDFPage>) {
  const [W, H] = A4;
  const rows = built.map((b, bi) => ({ b, bi })).filter(({ b }) => b.kind !== 'cover' && b.included);
  let pi = 0;
  let page = pages[0];
  let y = H - MARGIN - 10;
  const header = (first: boolean) => {
    text(page, first ? 'Index of documents' : 'Index of documents (continued)', MARGIN, y, f.bold, 16);
    y -= 18;
    text(page, `Bid No. ${input.tender.bidNumber}`, MARGIN, y, f.regular, 9.5, MUTED);
    y -= 26;
    text(page, 'NO.', MARGIN, y, f.bold, 7.5, MUTED);
    text(page, 'DOCUMENT', MARGIN + 34, y, f.bold, 7.5, MUTED);
    textRight(page, 'PAGES', W - MARGIN - 60, y, f.bold, 7.5, MUTED);
    textRight(page, 'PAGE', W - MARGIN, y, f.bold, 7.5, MUTED);
    y -= 8;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: W - MARGIN, y }, thickness: 0.6, color: INK });
    y -= 16;
  };
  header(true);
  let count = 0;
  rows.forEach(({ b, bi }, i) => {
    const cap = pi === 0 ? ROWS_FIRST : ROWS_NEXT;
    if (count >= cap) {
      pi++;
      page = pages[pi];
      y = H - MARGIN - 10;
      count = 0;
      header(false);
    }
    const kindLabel = b.kind === 'annexure' ? 'Annexure' : b.kind === 'tender_doc' ? 'Bid document' : '';
    text(page, String(i + 1).padStart(2, '0'), MARGIN, y, f.regular, 10, MUTED);
    const titleW = W - MARGIN * 2 - 34 - 110;
    let title = sanitize(b.title, f.regular);
    while (f.regular.widthOfTextAtSize(title, 10) > titleW && title.length > 4) title = `${title.slice(0, -2).trimEnd()}…`;
    text(page, title, MARGIN + 34, y, f.regular, 10, INK);
    if (kindLabel) {
      const tw = f.regular.widthOfTextAtSize(title, 10);
      if (tw + 60 < titleW) text(page, kindLabel, MARGIN + 34 + tw + 8, y + 0.5, f.italic, 7.5, MUTED);
    }
    textRight(page, String(b.pages), W - MARGIN - 60, y, f.regular, 10, MUTED);
    textRight(page, String(b.startPage), W - MARGIN, y, f.bold, 10, INK);
    // dotted leader
    page.drawLine({ start: { x: MARGIN, y: y - 6 }, end: { x: W - MARGIN, y: y - 6 }, thickness: 0.3, color: RULE });
    const target = firstPageOf.get(bi);
    if (target) addLink(out, page, [MARGIN, y - 5, W - MARGIN, y + 11], target.ref);
    y -= 22;
    count++;
  });
  if (!rows.length) text(page, 'No documents were included.', MARGIN, y, f.italic, 10, MUTED);
}

// ───────────── low-level outline & links ─────────────

function addLink(out: PDFDocument, page: PDFPage, rect: [number, number, number, number], target: PDFRef) {
  const annot = out.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0],
    Dest: [target, PDFName.of('Fit')],
  });
  const ref = out.context.register(annot);
  let annots = page.node.lookup(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray)) {
    annots = out.context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  (annots as PDFArray).push(ref);
}

/** Flat outline (bookmarks) pointing at the first page of each entry. */
export function addOutline(out: PDFDocument, entries: { title: string; ref: PDFRef }[]) {
  if (!entries.length) return;
  const ctx = out.context;
  const outlinesRef = ctx.nextRef();
  const refs = entries.map(() => ctx.nextRef());
  entries.forEach((e, i) => {
    const dict = ctx.obj({
      Title: PDFHexString.fromText(e.title),
      Parent: outlinesRef,
      Dest: [e.ref, PDFName.of('Fit')],
    });
    if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
    if (i < entries.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
    ctx.assign(refs[i], dict);
  });
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: PDFNumber.of(entries.length) }));
  out.catalog.set(PDFName.of('Outlines'), outlinesRef);
  out.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

/** Read outline titles back from a PDF (used by tests and the API to verify packets). */
export async function readOutline(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const outlines = doc.catalog.lookup(PDFName.of('Outlines'));
  const titles: string[] = [];
  if (!outlines || !('lookup' in (outlines as object))) return titles;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = (outlines as any).lookup(PDFName.of('First'));
  let guard = 0;
  while (node && guard++ < 10_000) {
    const t = node.lookup(PDFName.of('Title'));
    titles.push(t && typeof t.decodeText === 'function' ? t.decodeText() : String(t));
    node = node.lookup(PDFName.of('Next'));
  }
  return titles;
}

function sanitizeMeta(s: string) {
  return s.replace(/₹/g, 'Rs.');
}
