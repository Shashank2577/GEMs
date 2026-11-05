import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, type PDFRef, StandardFonts } from 'pdf-lib';
import { buildPacket, indexPagesFor, readOutline, sniff, type BuildItem } from '../../src/packet/build';
import { extractPages } from '../../src/analyse/pdf-text';

const now = new Date('2026-11-04T06:00:00Z');
const tender = { bidNumber: 'GEM/2026/B/7654321', title: 'Supply of Desktop Computers', organisation: 'NIC', ministry: 'MeitY', endAt: '2026-11-25T09:30:00Z' };
const company = { legalName: 'Sharma Infotech Pvt Ltd', gstin: '27AABCS1234F1Z5', pan: 'AABCS1234F', address: 'Mumbai', state: 'Maharashtra' };

async function pdf(label: string, pages: number): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) d.addPage([595, 842]).drawText(`${label} page ${i + 1}`, { x: 50, y: 700, size: 14, font: f });
  return d.save();
}

// 1×1 PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

describe('buildPacket', () => {
  it('assembles cover + index + documents in order with bookmarks and page numbers', async () => {
    const files: Record<string, Uint8Array> = {
      cover_letter: await pdf('COVERLETTER', 1),
      gst: await pdf('GSTDOC', 2),
      bs: await pdf('BALANCESHEET', 3),
      photo: PNG,
    };
    const items: BuildItem[] = [
      { kind: 'cover', title: 'Cover & index' },
      { kind: 'annexure', refId: 'cover_letter', title: 'Covering letter' },
      { kind: 'vault', refId: 'gst', title: 'GST certificate' },
      { kind: 'vault', refId: 'bs', title: 'Balance sheet FY 2024-25' },
      { kind: 'vault', refId: 'photo', title: 'Site photo' },
    ];
    const r = await buildPacket({ items, loadBytes: async (i) => files[i.refId!] ?? null, company, tender, now });
    expect(r.warnings).toEqual([]);
    // cover (1) + index (1) + 1 + 2 + 3 + 1
    expect(r.pageCount).toBe(9);
    expect(r.items.map((i) => [i.title, i.startPage, i.pages])).toEqual([
      ['Cover & index', 1, 2], ['Covering letter', 3, 1], ['GST certificate', 4, 2], ['Balance sheet FY 2024-25', 6, 3], ['Site photo', 9, 1],
    ]);
    expect(await readOutline(r.bytes)).toEqual(['Cover', 'Index', 'Covering letter', 'GST certificate', 'Balance sheet FY 2024-25', 'Site photo']);

    const pages = await extractPages(r.bytes);
    expect(pages[0]).toContain('TECHNICAL BID PACKET');
    expect(pages[0]).toContain('Prepared with TenderPilot');
    expect(pages[0]).toContain('27AABCS1234F1Z5');
    expect(pages[1]).toContain('Index of documents');
    expect(pages[1]).toMatch(/Balance sheet FY 2024-25[\s\S]*3[\s\S]*6/);
    expect(pages[2]).toContain('COVERLETTER page 1');
    expect(pages[3]).toContain('GSTDOC page 1');
    expect(pages[7]).toContain('BALANCESHEET page 3');
    expect(pages[8]).toContain('Page 9 of 9');
  });

  it('respects a user-chosen order', async () => {
    const files: Record<string, Uint8Array> = { a: await pdf('AAA', 1), b: await pdf('BBB', 1) };
    const r = await buildPacket({
      items: [{ kind: 'vault', refId: 'b', title: 'B' }, { kind: 'cover', title: 'Cover' }, { kind: 'vault', refId: 'a', title: 'A' }],
      loadBytes: async (i) => files[i.refId!], company, tender, now,
    });
    const pages = await extractPages(r.bytes);
    expect(pages[2]).toContain('BBB');
    expect(pages[3]).toContain('AAA');
  });

  it('works without a cover page', async () => {
    const r = await buildPacket({ items: [{ kind: 'vault', refId: 'a', title: 'A' }], loadBytes: async () => pdf('ONLY', 2), company, tender, now });
    expect(r.pageCount).toBe(2);
    expect(await readOutline(r.bytes)).toEqual(['A']);
  });

  it('skips missing, corrupt and unsupported files with warnings instead of failing', async () => {
    const files: Record<string, Uint8Array | null> = {
      ok: await pdf('OK', 1),
      corrupt: new TextEncoder().encode('%PDF-1.7\nthis is not really a pdf'),
      text: new TextEncoder().encode('hello world'),
      gone: null,
    };
    const r = await buildPacket({
      items: [{ kind: 'cover', title: 'Cover' }, ...Object.keys(files).map((k) => ({ kind: 'vault' as const, refId: k, title: k }))],
      loadBytes: async (i) => files[i.refId!] ?? null, company, tender, now,
    });
    expect(r.pageCount).toBe(3);
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings.join(' ')).toMatch(/"corrupt" is damaged/);
    expect(r.warnings.join(' ')).toMatch(/"text" is not a PDF, PNG or JPG/);
    expect(r.warnings.join(' ')).toMatch(/"gone" is missing/);
    expect(r.items.filter((i) => !i.included).map((i) => i.title)).toEqual(['corrupt', 'text', 'gone']);
  });

  it('warns when the packet exceeds the upload size limit (US4 scenario 4)', async () => {
    const r = await buildPacket({ items: [{ kind: 'cover', title: 'Cover' }], loadBytes: async () => null, company, tender, now, maxBytes: 1000 });
    expect(r.warnings.some((w) => /above the 0\.0 MB upload limit/.test(w))).toBe(true);
  });

  it('adds index pages for long packets', async () => {
    expect(indexPagesFor(10)).toBe(1);
    expect(indexPagesFor(27)).toBe(2);
    const one = await pdf('X', 1);
    const items: BuildItem[] = [{ kind: 'cover', title: 'Cover' }, ...Array.from({ length: 30 }, (_, i) => ({ kind: 'vault' as const, refId: String(i), title: `Doc ${i + 1}` }))];
    const r = await buildPacket({ items, loadBytes: async () => one, company, tender, now });
    expect(r.pageCount).toBe(1 + 2 + 30);
    expect(r.items[1].startPage).toBe(4);
  });

  it('sniffs file types by magic bytes', () => {
    expect(sniff(PNG)).toBe('png');
    expect(sniff(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniff(new TextEncoder().encode('%PDF-1.4'))).toBe('pdf');
    expect(sniff(new TextEncoder().encode('nope'))).toBeNull();
  });
});

/**
 * SC-005 / FR-048 / FR-051 (T064): the page plan is exact — for 1, 27 and 61 documents (PDFs of 1–3 pages,
 * PNG images and one damaged file that is skipped) the index rows, their link targets, the API `startPage`,
 * the outline bookmarks and the "Page x of N" footer all agree with where each document really starts.
 */
describe('page plan agreement (SC-005)', () => {
  /** Resolve a `[pageRef /Fit]` destination to a 1-based page number. */
  function destPage(doc: PDFDocument, dest: unknown): number {
    const refs = doc.getPages().map((p) => p.ref);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arr = (dest instanceof PDFArray ? dest : doc.context.lookup(dest as any)) as PDFArray;
    const target = arr.get(0) as PDFRef;
    return refs.findIndex((r) => r === target || r.toString() === target.toString()) + 1;
  }

  function outlinePages(doc: PDFDocument): { title: string; page: number }[] {
    const out: { title: string; page: number }[] = [];
    const outlines = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    let node = outlines.lookupMaybe(PDFName.of('First'), PDFDict);
    while (node) {
      const t = node.lookup(PDFName.of('Title')) as PDFHexString;
      out.push({ title: t.decodeText(), page: destPage(doc, node.get(PDFName.of('Dest'))) });
      node = node.lookupMaybe(PDFName.of('Next'), PDFDict);
    }
    return out;
  }

  function linkPages(doc: PDFDocument, pageIdx: number): number[] {
    const annots = doc.getPage(pageIdx).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return [];
    return annots.asArray().map((a) => destPage(doc, (doc.context.lookup(a) as PDFDict).get(PDFName.of('Dest'))));
  }

  const label = (n: number) => `DOC${String(n).padStart(3, '0')}`;

  for (const n of [1, 27, 61]) {
    it(`agrees for ${n} document${n === 1 ? '' : 's'}`, async () => {
      // Every 4th document is an image; page counts cycle 1, 2, 3; a damaged file sits in the middle.
      const files = new Map<string, Uint8Array>();
      const items: BuildItem[] = [{ kind: 'cover', title: 'Cover & index' }];
      for (let k = 1; k <= n; k++) {
        const id = label(k);
        files.set(id, k % 4 === 0 ? PNG : await pdf(id, ((k - 1) % 3) + 1));
        items.push({ kind: k % 5 === 0 ? 'annexure' : 'vault', refId: id, title: `Document ${String(k).padStart(3, '0')}` });
        if (k === Math.ceil(n / 2)) items.push({ kind: 'vault', refId: 'broken', title: 'Damaged scan' });
      }
      files.set('broken', new TextEncoder().encode('%PDF-1.4\n%garbage that is not a pdf'));

      const r = await buildPacket({ items, loadBytes: async (i) => files.get(i.refId!) ?? null, company, tender, now });
      const doc = await PDFDocument.load(r.bytes);
      const total = doc.getPageCount();
      const indexPages = indexPagesFor(n);
      expect(indexPages).toBe(n <= 26 ? 1 : n <= 60 ? 2 : 3);

      // The skipped file is reported and left out.
      expect(r.warnings).toEqual(['"Damaged scan" is damaged and could not be opened — skipped.']);
      const skipped = r.items.find((i) => i.title === 'Damaged scan')!;
      expect(skipped).toMatchObject({ included: false, startPage: 0, pages: 0 });
      const docs = r.items.filter((i) => i.kind !== 'cover' && i.included);
      expect(docs).toHaveLength(n);

      // API plan: contiguous, after cover + index pages, covering every page exactly once.
      expect(r.items[0]).toMatchObject({ kind: 'cover', startPage: 1, pages: 1 + indexPages });
      let expected = 2 + indexPages;
      for (const d of docs) { expect(d.startPage).toBe(expected); expected += d.pages; }
      expect(expected - 1).toBe(total);
      expect(r.pageCount).toBe(total);

      const pages = await extractPages(r.bytes);
      expect(pages).toHaveLength(total);
      // Footer "Page x of N" on every page.
      pages.forEach((t, i) => expect(t).toContain(`Page ${i + 1} of ${total}`));
      // Each document really starts on its startPage (images carry no text; their page has no document text).
      docs.forEach((d, k) => {
        const id = label(k + 1);
        if ((k + 1) % 4 === 0) expect(pages[d.startPage - 1]).not.toMatch(/DOC\d{3} page/);
        else expect(pages[d.startPage - 1]).toContain(`${id} page 1`);
      });

      // Index pages: titles, page counts and start pages in order; continuation pages titled; links hit startPage.
      const indexText = pages.slice(1, 1 + indexPages);
      expect(indexText[0]).toContain('Index of documents');
      for (let p = 1; p < indexPages; p++) expect(indexText[p]).toContain('Index of documents (continued)');
      expect(pages.slice(1, 1 + indexPages).join('\n')).not.toContain('Damaged scan');
      let row = 0;
      for (let p = 0; p < indexPages; p++) {
        const cap = p === 0 ? 26 : 34;
        const onPage = docs.slice(row, row + cap);
        let cursor = 0;
        for (const [k, d] of onPage.entries()) {
          const t = indexText[p];
          const at = t.indexOf(d.title, cursor);
          expect(at, `"${d.title}" on index page ${p + 1}`).toBeGreaterThanOrEqual(0);
          const tail = t.slice(at + d.title.length, k + 1 < onPage.length ? t.indexOf(onPage[k + 1].title, at) : undefined);
          expect(tail.match(/\d+/g)!.slice(0, 2).map(Number), d.title).toEqual([d.pages, d.startPage]);
          cursor = at + d.title.length;
        }
        expect(linkPages(doc, 1 + p)).toEqual(onPage.map((d) => d.startPage));
        row += onPage.length;
      }
      expect(row).toBe(n);

      // Outline: Cover, Index, then one bookmark per included document at its startPage.
      const marks = outlinePages(doc);
      expect(marks).toEqual([
        { title: 'Cover', page: 1 }, { title: 'Index', page: 2 },
        ...docs.map((d) => ({ title: d.title, page: d.startPage })),
      ]);
      expect(r.bookmarks).toEqual(marks);
      expect(doc.catalog.get(PDFName.of('PageMode'))).toBe(PDFName.of('UseOutlines'));
    });
  }
});
