import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
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
