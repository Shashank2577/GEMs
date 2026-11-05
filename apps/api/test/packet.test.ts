/** Annexures & packet API (T061–T063, T067; FR-024, FR-025, US4 acceptance 2–4). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { packets, vaultDocuments } from '@tp/db';
import { loadConfig } from '../src/env';
import { contentDisposition } from '../src/lib/http';
import { extractPages } from '@tp/core/analyse/pdf-text';
import { readOutline } from '@tp/core/packet/build';
import { createTestContext, request, signup, type TestContext } from './helpers';
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

describe('packet order, input cap, recovery and download names (US5 gaps)', () => {
  const titles = (items: { title: string }[]) => items.map((i) => i.title);
  const COMPUTED_REST = [
    'Covering Letter for Technical Bid', 'Undertaking regarding Non-Blacklisting / Non-Debarment', 'Self-Certificate of Local Content (Make in India)',
    'GST registration certificate', 'Audited balance sheets — last 3 financial years', 'OEM authorisation certificate (MAF) for this bid',
  ];

  it('proposes the last ready build\'s order to every member, appending newly required items (FR-055)', async () => {
    // The last ready build is the custom one: Cover, PAN, EMD exemption.
    const r = await request(ctx.app, 'GET', `/workspaces/${wsId}`, { cookie: s.org.bidManager.cookie });
    expect(r.status).toBe(200);
    expect(titles(r.body.defaultPacketItems)).toEqual(['Cover', 'PAN', 'EMD exemption', ...COMPUTED_REST]);
    expect(r.body.defaultPacketItems[1]).toMatchObject({ kind: 'vault', refId: s.docs.pan.id });
    expect(titles(r.body.computedPacketItems)).toEqual([
      'Cover page & index', 'Covering Letter for Technical Bid', 'Undertaking regarding Non-Blacklisting / Non-Debarment',
      'Self-Certificate of Local Content (Make in India)', 'GST registration certificate', 'PAN card of the firm',
      'Audited balance sheets — last 3 financial years', 'OEM authorisation certificate (MAF) for this bid',
    ]);
    // POST {} still builds the computed default (FR-046), not the proposed order.
  });

  it('drops stale references from the last ready build and ignores newer failed builds (FR-055)', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const later = new Date(Date.now() + 60_000);
    const inserted = await ctx.db.insert(packets).values([
      {
        orgId: s.org.orgId, workspaceId: wsId, status: 'ready', createdAt: later, blobKey: 'org/x/packets/y/z.pdf', pageCount: 3,
        items: [
          { kind: 'vault', refId: ghost, title: 'Deleted doc' }, { kind: 'annexure', refId: 'retired_template', title: 'Retired annexure' },
          { kind: 'tender_doc', refId: ghost, title: 'Removed bid doc' }, { kind: 'annexure', refId: 'emd_exemption', title: 'EMD' },
          { kind: 'vault', refId: s.docs.gst.id, title: 'GST first' },
        ],
      },
      { orgId: s.org.orgId, workspaceId: wsId, status: 'failed', createdAt: new Date(later.getTime() + 1000), items: [{ kind: 'vault', refId: s.docs.pan.id, title: 'PAN only' }] },
    ]).returning();
    try {
      const r = await request(ctx.app, 'GET', `/workspaces/${wsId}`, { cookie: s.org.analyst.cookie });
      // No cover in that build → a removed cover stays removed; the rest of the computed default is appended.
      expect(titles(r.body.defaultPacketItems)).toEqual([
        'EMD', 'GST first', 'Covering Letter for Technical Bid', 'Undertaking regarding Non-Blacklisting / Non-Debarment',
        'Self-Certificate of Local Content (Make in India)', 'PAN card of the firm', 'Audited balance sheets — last 3 financial years',
        'OEM authorisation certificate (MAF) for this bid',
      ]);
    } finally {
      for (const p of inserted) await ctx.db.delete(packets).where(eq(packets.id, p.id));
    }
  });

  it('refuses inputs above the cap with 413 before loading any file and without a packet row (FR-056, NFR-003)', async () => {
    expect(ctx.deps.config.packetMaxInputBytes).toBe(60 * 1024 * 1024);
    const [doc] = await ctx.db.select().from(vaultDocuments).where(eq(vaultDocuments.id, s.docs.bsOld.id));
    await ctx.db.update(vaultDocuments).set({ sizeBytes: 72 * 1024 * 1024 }).where(eq(vaultDocuments.id, doc.id));
    const before = (await ctx.db.select().from(packets).where(eq(packets.workspaceId, wsId))).length;
    const realGet = ctx.deps.blobs.get;
    let loads = 0;
    ctx.deps.blobs.get = async (k) => { loads++; return realGet.call(ctx.deps.blobs, k); };
    try {
      const r = await request(ctx.app, 'POST', `/workspaces/${wsId}/packets`, {
        cookie: s.org.analyst.cookie, json: { items: [{ kind: 'cover', title: 'Cover' }, { kind: 'vault', refId: doc.id, title: 'Balance sheet 2023-24' }] },
      });
      expect(r.status).toBe(413);
      expect(r.body.error.code).toBe('packet_too_large');
      expect(r.body.error.message).toBe('These documents add up to 72.0 MB — remove or compress some before building (limit 60 MB).');
      expect(r.body.error.details).toMatchObject({ totalBytes: 72 * 1024 * 1024, limitBytes: 60 * 1024 * 1024, items: [{ title: 'Balance sheet 2023-24', sizeBytes: 72 * 1024 * 1024 }] });
      expect(loads).toBe(0);
      expect((await ctx.db.select().from(packets).where(eq(packets.workspaceId, wsId))).length).toBe(before);

      // Annexures count 50 KB each against a configured cap.
      ctx.deps.config.packetMaxInputBytes = 100 * 1024;
      const ann = await request(ctx.app, 'POST', `/workspaces/${wsId}/packets`, {
        cookie: s.org.analyst.cookie,
        json: { items: ['non_blacklisting', 'mii_self_cert', 'emd_exemption'].map((k) => ({ kind: 'annexure', refId: k, title: k })) },
      });
      expect(ann.status).toBe(413);
      expect(ann.body.error.message).toBe('These documents add up to 0.1 MB — remove or compress some before building (limit 0.1 MB).');
      expect(ann.body.error.details.totalBytes).toBe(3 * 50 * 1024);
    } finally {
      ctx.deps.blobs.get = realGet;
      ctx.deps.config.packetMaxInputBytes = 60 * 1024 * 1024;
      await ctx.db.update(vaultDocuments).set({ sizeBytes: doc.sizeBytes }).where(eq(vaultDocuments.id, doc.id));
    }
  });

  it('reads PACKET_MAX_INPUT_BYTES from the environment (default 60 MB)', () => {
    expect(loadConfig({}).packetMaxInputBytes).toBe(62_914_560);
    expect(loadConfig({ PACKET_MAX_INPUT_BYTES: '41943040' }).packetMaxInputBytes).toBe(41_943_040);
    expect(loadConfig({ PACKET_MAX_INPUT_BYTES: 'lots' }).packetMaxInputBytes).toBe(62_914_560);
    expect(loadConfig({ PACKET_MAX_INPUT_BYTES: '-5' }).packetMaxInputBytes).toBe(62_914_560);
  });

  it('marks builds stuck in "building" for more than 10 minutes as failed when read (FR-057)', async () => {
    const at = (min: number) => new Date(NOW.getTime() - min * 60_000);
    const [stale, fresh, stale2] = await ctx.db.insert(packets).values([
      { orgId: s.org.orgId, workspaceId: wsId, status: 'building', createdAt: at(11), createdBy: s.org.analyst.me.user.id },
      { orgId: s.org.orgId, workspaceId: wsId, status: 'building', createdAt: at(2), createdBy: s.org.analyst.me.user.id },
      { orgId: s.org.orgId, workspaceId: wsId, status: 'building', createdAt: at(45) },
    ]).returning();
    try {
      const list = await request(ctx.app, 'GET', `/workspaces/${wsId}/packets`, { cookie: s.org.viewer.cookie });
      expect(list.status).toBe(200);
      const byId = new Map(list.body.items.map((p: any) => [p.id, p]));
      expect(byId.get(stale.id)).toMatchObject({ status: 'failed', warnings: ['Build interrupted — try again.'], downloadUrl: null });
      expect(byId.get(stale2.id)).toMatchObject({ status: 'failed' });
      expect(byId.get(fresh.id)).toMatchObject({ status: 'building', warnings: [] });
      const [row] = await ctx.db.select().from(packets).where(eq(packets.id, stale.id));
      expect(row.status).toBe('failed');
      expect(row.warnings).toEqual(['Build interrupted — try again.']);

      // Reading the workspace recovers too.
      const [stale3] = await ctx.db.insert(packets).values({ orgId: s.org.orgId, workspaceId: wsId, status: 'building', createdAt: at(10.5) }).returning();
      const d = await request(ctx.app, 'GET', `/workspaces/${wsId}`, { cookie: s.org.viewer.cookie });
      expect(d.body.packets.find((p: any) => p.id === stale3.id)).toMatchObject({ status: 'failed', warnings: ['Build interrupted — try again.'] });
      await ctx.db.delete(packets).where(eq(packets.id, stale3.id));
    } finally {
      for (const p of [stale, fresh, stale2]) await ctx.db.delete(packets).where(eq(packets.id, p.id));
    }
  });

  it('sends an ASCII filename and an RFC 5987 filename* on packet and annexure downloads (FR-059)', async () => {
    const [p] = await ctx.db.select().from(packets).where(eq(packets.status, 'ready')).limit(1);
    const att = await ctx.app.request(`http://tp.test/api/packets/${p.id}/download`, { headers: { cookie: s.org.viewer.cookie } });
    expect(att.headers.get('content-disposition')).toBe(
      'attachment; filename="GEM_2026_B_700001_technical_packet.pdf"; filename*=UTF-8\'\'GEM_2026_B_700001_technical_packet.pdf',
    );
    expect(att.headers.get('cache-control')).toBe('private, no-store');
    expect(att.headers.get('x-content-type-options')).toBe('nosniff');
    const inl = await ctx.app.request(`http://tp.test/api/packets/${p.id}/download?inline=1`, { headers: { cookie: s.org.viewer.cookie } });
    expect(inl.headers.get('content-disposition')).toMatch(/^inline; filename="GEM_2026_B_700001_technical_packet\.pdf"; filename\*=UTF-8''/);
    const an = await ctx.app.request(`http://tp.test/api/workspaces/${wsId}/annexures/mii_self_cert.pdf`, { headers: { cookie: s.org.viewer.cookie } });
    expect(an.headers.get('content-disposition')).toBe(
      'inline; filename="mii_self_cert_GEM_2026_B_700001.pdf"; filename*=UTF-8\'\'mii_self_cert_GEM_2026_B_700001.pdf',
    );
  });

  it('contentDisposition keeps an ASCII fallback and percent-encodes the UTF-8 name', () => {
    expect(contentDisposition('attachment', 'Bid “₹ 5 lakh” (final).pdf')).toBe(
      'attachment; filename="Bid __ 5 lakh_ (final).pdf"; filename*=UTF-8\'\'Bid%20%E2%80%9C%E2%82%B9%205%20lakh%E2%80%9D%20%28final%29.pdf',
    );
    expect(contentDisposition('inline', 'प्रमाणपत्र.pdf')).toBe(
      "inline; filename=\"document.pdf\"; filename*=UTF-8''%E0%A4%AA%E0%A5%8D%E0%A4%B0%E0%A4%AE%E0%A4%BE%E0%A4%A3%E0%A4%AA%E0%A4%A4%E0%A5%8D%E0%A4%B0.pdf",
    );
    expect(contentDisposition('attachment', 'a"b\\c\r\n.pdf')).toBe('attachment; filename="abc  .pdf"; filename*=UTF-8\'\'a%22b%5Cc%20%20.pdf');
  });
});
