/** Annexures & packet API (T061–T063, T067; FR-024, FR-025, US4 acceptance 2–4). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { packets, vaultDocuments } from '@tp/db';
import { extractPages } from '@tp/core/analyse/pdf-text';
import { readOutline } from '@tp/core/packet/build';
import { createTestContext, request, signup, type TestContext } from './helpers';
import { assertPacketItemCount, assertPacketSize, packetInputBytes } from '../src/services/packet';
import { NOW, seedApply } from './workspace-fixtures';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof seedApply>>;
let wsId: string;

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW });
  s = await seedApply(ctx);
  wsId = (await request(ctx.app, 'POST', `/tenders/${s.tender.id}/workspace`, { cookie: s.org.analyst.cookie })).body.id;
});
afterAll(() => ctx?.close());

describe('annexure templates', () => {
  it('lists the 8 system templates', async () => {
    const r = await request(ctx.app, 'GET', '/annexure-templates', { cookie: s.org.viewer.cookie });
    expect(r.status).toBe(200);
    expect(r.body.items.map((t: any) => t.key)).toEqual([
      'non_blacklisting', 'mii_self_cert', 'mse_declaration', 'emd_exemption', 'oem_auth_request', 'technical_compliance', 'authority_letter', 'bid_cover_letter',
    ]);
    expect(r.body.items.every((t: any) => t.custom === false)).toBe(true);
  });

  it('only bid managers can customise; the override is per org and can be reset', async () => {
    const body = { title: 'Non-blacklisting declaration (Sharma)', body: 'We {{company.legalName}} declare we are not blacklisted for bid {{tender.bidNumber}}. Custom clause XYZ.' };
    expect((await request(ctx.app, 'PUT', '/annexure-templates/non_blacklisting', { cookie: s.org.analyst.cookie, json: body })).status).toBe(403);
    const r = await request(ctx.app, 'PUT', '/annexure-templates/non_blacklisting', { cookie: s.org.bidManager.cookie, json: body });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key: 'non_blacklisting', custom: true, title: body.title });
    const pdf = await ctx.app.request(`http://tp.test/api/workspaces/${wsId}/annexures/non_blacklisting.pdf`, { headers: { cookie: s.org.viewer.cookie } });
    expect(pdf.status).toBe(200);
    const text = (await extractPages(await bytesOf(pdf))).join('\n');
    expect(text.replace(/\s+/g, ' ')).toContain('Custom clause XYZ');
    expect(text).toContain('Sharma Infotech Pvt Ltd');
    // other org still sees the system template
    const other = await signup(ctx.app);
    const o = await request(ctx.app, 'GET', '/annexure-templates', { cookie: other.cookie });
    expect(o.body.items.find((t: any) => t.key === 'non_blacklisting').custom).toBe(false);
    const reset = await request(ctx.app, 'DELETE', '/annexure-templates/non_blacklisting', { cookie: s.org.bidManager.cookie });
    expect(reset.body.custom).toBe(false);
    expect((await request(ctx.app, 'PUT', '/annexure-templates/unknown_key', { cookie: s.org.bidManager.cookie, json: body })).status).toBe(404);
  });

  it('renders annexure PDFs filled with company & tender data (alias keys accepted)', async () => {
    const res = await ctx.app.request(`http://tp.test/api/workspaces/${wsId}/annexures/mii_self_certificate.pdf?download=1`, { headers: { cookie: s.org.viewer.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="mii_self_cert_GEM_2026_B_700001.pdf"/);
    const text = (await extractPages(await bytesOf(res))).join('\n');
    expect(text).toContain('SHARMA INFOTECH PVT LTD');
    expect(text).toContain('GEM/2026/B/700001');
    expect(text).toContain('62%');
    expect(text).toContain('Class-I local supplier');
    expect(text).toContain('Ravi Sharma');
  });

  it('previews a draft template without saving it', async () => {
    const r = await ctx.app.request(`http://tp.test/api/workspaces/${wsId}/annexures/authority_letter/preview`, {
      method: 'POST', headers: { cookie: s.org.analyst.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Authority', body: 'Draft body for {{tender.bidNumber}} — preview only, not saved.' }),
    });
    expect(r.status).toBe(200);
    expect((await extractPages(await bytesOf(r))).join(' ')).toContain('preview only');
  });

  it('refuses unknown placeholders on save and preview, after the length check (FR-041)', async () => {
    const typo = { title: 'Non-blacklisting', body: 'We, {{company.legalName}} (GSTIN {{company.gstn}}), undertake that we are not blacklisted.' };
    const put = await request(ctx.app, 'PUT', '/annexure-templates/non_blacklisting', { cookie: s.org.bidManager.cookie, json: typo });
    expect(put.status).toBe(400);
    expect(put.body.error).toEqual({ code: 'unknown_placeholder', message: 'Unknown placeholder {{company.gstn}} — use one from the list.', details: { unknown: ['company.gstn'] } });
    const list = await request(ctx.app, 'GET', '/annexure-templates', { cookie: s.org.bidManager.cookie });
    expect(list.body.items.find((t: any) => t.key === 'non_blacklisting').body).not.toContain('company.gstn');

    const prev = await request(ctx.app, 'POST', `/workspaces/${wsId}/annexures/non_blacklisting/preview`, {
      cookie: s.org.analyst.cookie, json: { title: 'Draft', body: 'Draft {{tender.bidNo}} and {{ foo }} and {{tender.bidNumber}} text.' },
    });
    expect(prev.status).toBe(400);
    expect(prev.body.error.code).toBe('unknown_placeholder');
    expect(prev.body.error.details).toEqual({ unknown: ['tender.bidNo', 'foo'] });

    const short = await request(ctx.app, 'PUT', '/annexure-templates/non_blacklisting', { cookie: s.org.bidManager.cookie, json: { title: 'Short', body: '{{company.gstn}}' } });
    expect(short.status).toBe(400);
    expect(short.body.error.message).toContain('The template body is too short');
  });
});

describe('packets', () => {
  let packetId: string;

  it('builds the default packet: cover + index + annexures + mapped documents, with warnings for expired docs (US4 #2, #3)', async () => {
    const r = await request(ctx.app, 'POST', `/workspaces/${wsId}/packets`, { cookie: s.org.analyst.cookie, json: {} });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('ready');
    // cover(1)+index(1) + cover letter(1) + non_blacklisting(1) + mii(1) + gst(1) + pan(1) + bs 2024(3) + maf(1)
    expect(r.body.pageCount).toBe(11);
    expect(r.body.items.map((i: any) => [i.title, i.startPage])).toEqual([
      ['Cover page & index', 1], ['Covering Letter for Technical Bid', 3], ['Undertaking regarding Non-Blacklisting / Non-Debarment', 4],
      ['Self-Certificate of Local Content (Make in India)', 5], ['GST registration certificate', 6], ['PAN card of the firm', 7],
      ['Audited balance sheets — last 3 financial years', 8], ['OEM authorisation certificate (MAF) for this bid', 11],
    ]);
    expect(r.body.warnings.join(' ')).toMatch(/OEM authorisation certificate .*expired/);
    expect(r.body.downloadUrl).toBe(`/api/packets/${r.body.id}/download`);
    packetId = r.body.id;
    const [row] = await ctx.db.select().from(packets).where(eq(packets.id, packetId));
    expect(row.blobKey).toBe(`org/${s.org.orgId}/packets/${packetId}/GEM_2026_B_700001_technical_packet.pdf`);
  });

  it('moved the bid to "Preparing" and logged it', async () => {
    const r = await request(ctx.app, 'GET', `/workspaces/${wsId}`, { cookie: s.org.viewer.cookie });
    expect(r.body.workspace.stage).toBe('preparing');
    expect(r.body.packets).toHaveLength(1);
    expect(r.body.activity.map((a: any) => a.action)).toEqual(expect.arrayContaining(['workspace.packet_built', 'workspace.stage_changed']));
  });

  it('downloads the merged PDF with bookmarks in order', async () => {
    const res = await ctx.app.request(`http://tp.test/api/packets/${packetId}/download`, { headers: { cookie: s.org.viewer.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment/);
    const bytes = await bytesOf(res);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(11);
    const outline = await readOutline(bytes);
    expect(outline.slice(0, 4)).toEqual(['Cover', 'Index', 'Covering Letter for Technical Bid', 'Undertaking regarding Non-Blacklisting / Non-Debarment']);
    const pages = await extractPages(bytes);
    expect(pages[0]).toContain('Prepared with TenderPilot');
    expect(pages[5]).toContain('GST page 1');
    expect(pages[7]).toContain('BS-2024 page 1');
  });

  it('honours a custom order and validates references', async () => {
    const items = [
      { kind: 'vault', refId: s.docs.pan.id, title: 'PAN' },
      { kind: 'cover', title: 'Cover' },
      { kind: 'annexure', refId: 'emd_exemption', title: 'EMD exemption' },
    ];
    const r = await request(ctx.app, 'POST', `/workspaces/${wsId}/packets`, { cookie: s.org.analyst.cookie, json: { items } });
    expect(r.status).toBe(201);
    expect(r.body.pageCount).toBe(4);
    expect(r.body.items.map((i: any) => i.title)).toEqual(['Cover', 'PAN', 'EMD exemption']);
    const other = await signup(ctx.app);
    const bad = await request(ctx.app, 'POST', `/workspaces/${wsId}/packets`, { cookie: s.org.analyst.cookie, json: { items: [{ kind: 'vault', refId: '00000000-0000-4000-8000-000000000000', title: 'Ghost' }] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/Ghost/);
    // isolation: other org can neither build nor download
    expect((await request(ctx.app, 'POST', `/workspaces/${wsId}/packets`, { cookie: other.cookie, json: {} })).status).toBe(404);
    expect((await ctx.app.request(`http://tp.test/api/packets/${packetId}/download`, { headers: { cookie: other.cookie } })).status).toBe(404);
  });

  it('viewers cannot build packets', async () => {
    expect((await request(ctx.app, 'POST', `/workspaces/${wsId}/packets`, { cookie: s.org.viewer.cookie, json: {} })).status).toBe(403);
  });

  it('lists packet history', async () => {
    const r = await request(ctx.app, 'GET', `/workspaces/${wsId}/packets`, { cookie: s.org.viewer.cookie });
    expect(r.body.total).toBe(2);
    expect(r.body.items[0].createdBy.name).toBe('Test analyst');
  });
});

// ───────────── 008/US4 packet pre-flight (T076; FR-032, US4 scenario 10) ─────────────

describe('packet pre-flight (008/FR-032)', () => {
  const MB = 1024 * 1024;
  const packetCount = async () => (await ctx.db.select({ id: packets.id }).from(packets)).length;
  const blobCount = async () => {
    const { readdir } = await import('node:fs/promises');
    return (await readdir(ctx.blobDir, { recursive: true })).length;
  };

  it('45 MB of selected items → 413 packet_too_large before any packets row or blob is written', async () => {
    // Stored sizes drive the pre-flight, so no 45 MB of real files is needed (nor loaded into memory).
    await ctx.db.update(vaultDocuments).set({ sizeBytes: 25 * MB }).where(eq(vaultDocuments.id, s.docs.gst.id));
    await ctx.db.update(vaultDocuments).set({ sizeBytes: 20 * MB }).where(eq(vaultDocuments.id, s.docs.pan.id));
    const [rows, blobs] = [await packetCount(), await blobCount()];
    try {
      const items = [{ kind: 'vault', refId: s.docs.gst.id, title: 'GST' }, { kind: 'vault', refId: s.docs.pan.id, title: 'PAN' }];
      const r = await request(ctx.app, 'POST', `/workspaces/${wsId}/packets`, { cookie: s.org.analyst.cookie, json: { items } });
      expect(r.status).toBe(413);
      expect(r.body.error).toEqual({
        code: 'packet_too_large', message: 'This packet would be 45 MB (limit 40 MB). Deselect large attachments and try again.',
        details: { bytes: 45 * MB, maxBytes: 40 * MB },
      });
      expect(await packetCount()).toBe(rows);
      expect(await blobCount()).toBe(blobs);
    } finally {
      await ctx.db.update(vaultDocuments).set({ sizeBytes: 100 }).where(eq(vaultDocuments.id, s.docs.gst.id));
      await ctx.db.update(vaultDocuments).set({ sizeBytes: 100 }).where(eq(vaultDocuments.id, s.docs.pan.id));
    }
  });

  it('41 items → 413 packet_too_large "41 items (limit 40)" (not a 400), nothing written', async () => {
    const rows = await packetCount();
    const items = Array.from({ length: 41 }, (_, i) => ({ kind: 'cover', title: `Item ${i + 1}` }));
    const r = await request(ctx.app, 'POST', `/workspaces/${wsId}/packets`, { cookie: s.org.analyst.cookie, json: { items } });
    expect(r.status).toBe(413);
    expect(r.body.error).toEqual({
      code: 'packet_too_large', message: 'This packet has 41 items (limit 40). Deselect some items and try again.', details: { items: 41, maxItems: 40 },
    });
    expect(await packetCount()).toBe(rows);
  });

  it('counts generated pages at 512 KB and stops exactly above the limits', () => {
    const sizes: Record<string, number> = { a: 39 * MB };
    const bytes = packetInputBytes([{ kind: 'vault', refId: 'a', title: 'A' }, { kind: 'cover', title: 'Cover' }, { kind: 'annexure', refId: 'x', title: 'X', pages: 1 }],
      (it) => sizes[it.refId ?? '']);
    expect(bytes).toBe(40 * MB);
    expect(() => assertPacketSize(bytes)).not.toThrow();
    expect(() => assertPacketSize(bytes + 1)).toThrow(/limit 40 MB/);
    expect(() => assertPacketItemCount(40)).not.toThrow();
    expect(() => assertPacketItemCount(41)).toThrow(/41 items \(limit 40\)/);
  });
});
