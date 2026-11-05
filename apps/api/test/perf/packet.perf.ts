/**
 * NFR-002 / SC-007 packet performance check (T065). NOT part of default CI: the default vitest include only matches
 * `*.test.ts`, and this file is `*.perf.ts`. Run it explicitly against the test database:
 *
 *   TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test pnpm --filter @tp/api run test:perf
 *
 * Workload: 30 vault documents, 120 pages, ~25 MB stored input (each page carries an uncompressed image so the
 * bytes are realistic for scans) → POST /api/workspaces/:id/packets must answer 201 in < 15 s; an annexure PDF
 * render (GET …/annexures/:key.pdf and renderAnnexurePdf directly) must take < 500 ms.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  PDFDocument, StandardFonts, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState,
} from 'pdf-lib';
import { renderAnnexurePdf, SYSTEM_TEMPLATE_BY_KEY } from '@tp/core/packet/templates';
import { createTestContext, request, type TestContext } from '../helpers';
import { NOW, file, seedApply } from '../workspace-fixtures';

const DOCS = 30;
const PAGES = 120;
const TARGET_BYTES = 25 * 1024 * 1024;
const IMG = 268; // 268×268 RGB = 215,472 bytes of incompressible data per page

/** A PDF of `pages` pages, each with a raw (unfiltered) random RGB image so the file size is real. */
async function heavyPdf(label: string, pages: number): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = d.addPage([595, 842]);
    const img = d.context.stream(randomBytes(IMG * IMG * 3), {
      Type: 'XObject', Subtype: 'Image', Width: IMG, Height: IMG, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    });
    const name = page.node.newXObject('Scan', d.context.register(img));
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(500, 0, 0, 500, 47, 200), drawObject(name), popGraphicsState());
    page.drawText(`${label} page ${i + 1}`, { x: 40, y: 780, size: 14, font: f });
  }
  return d.save({ useObjectStreams: false });
}

const ms = (t0: number) => Math.round(performance.now() - t0);

describe('packet build performance (NFR-002)', () => {
  let ctx: TestContext;
  let s: Awaited<ReturnType<typeof seedApply>>;
  let wsId: string;
  let items: { kind: 'vault'; refId: string; title: string }[] = [];
  let inputBytes = 0;

  beforeAll(async () => {
    ctx = await createTestContext({ now: NOW });
    s = await seedApply(ctx);
    wsId = (await request(ctx.app, 'POST', `/tenders/${s.tender.id}/workspace`, { cookie: s.org.analyst.cookie })).body.id;
    for (let k = 0; k < DOCS; k++) {
      const bytes = await heavyPdf(`PERF${k}`, PAGES / DOCS);
      inputBytes += bytes.length;
      const r = await request(ctx.app, 'POST', '/vault', {
        cookie: s.org.analyst.cookie, form: { file: file(bytes, `perf-${k}.pdf`), type: 'other', title: `Perf document ${k + 1}` },
      });
      if (r.status !== 201) throw new Error(`upload failed: ${r.status} ${r.text}`);
      items.push({ kind: 'vault', refId: r.body.id, title: `Perf document ${k + 1}` });
    }
  }, 300_000);
  afterAll(() => ctx?.close());

  it('builds a 30-document / 120-page / ~25 MB packet in < 15 s', async () => {
    expect(inputBytes).toBeGreaterThan(TARGET_BYTES * 0.9);
    expect(inputBytes).toBeLessThan(TARGET_BYTES * 1.1);
    const t0 = performance.now();
    const r = await request(ctx.app, 'POST', `/workspaces/${wsId}/packets`, {
      cookie: s.org.analyst.cookie, json: { items: [{ kind: 'cover', title: 'Cover page & index' }, ...items] },
    });
    const took = ms(t0);
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`[perf] packet build: ${took} ms, input ${(inputBytes / 1048576).toFixed(1)} MB, output ${((r.body.sizeBytes ?? 0) / 1048576).toFixed(1)} MB, ${r.body.pageCount} pages, heapUsed after ${heapMB} MB`);
    expect(r.status).toBe(201);
    expect(r.body.pageCount).toBe(PAGES + 3); // cover + 2 index pages (30 rows > 26)
    expect(took).toBeLessThan(15_000);
  }, 60_000);

  it('renders an annexure PDF in < 500 ms', async () => {
    const tpl = SYSTEM_TEMPLATE_BY_KEY.get('mii_self_cert')!;
    // warm-up (font embedding / module init), then measure
    await request(ctx.app, 'GET', `/workspaces/${wsId}/annexures/mii_self_cert.pdf`, { cookie: s.org.viewer.cookie });
    const api: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const res = await ctx.app.request(`http://tp.test/api/workspaces/${wsId}/annexures/mii_self_cert.pdf`, { headers: { cookie: s.org.viewer.cookie } });
      await res.arrayBuffer();
      api.push(ms(t0));
    }
    const ctxObj = { company: { legalName: 'Sharma Infotech Pvt Ltd' }, tender: { bidNumber: 'GEM/2026/B/700001' } };
    const direct: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await renderAnnexurePdf(tpl.title, tpl.body, ctxObj as never, { signatureRole: tpl.signatureRole });
      direct.push(ms(t0));
    }
    const max = (a: number[]) => Math.max(...a);
    console.log(`[perf] annexure render: API max ${max(api)} ms (runs ${api.join(',')}), direct max ${max(direct)} ms (runs ${direct.join(',')})`);
    expect(max(api)).toBeLessThan(500);
    expect(max(direct)).toBeLessThan(500);
  }, 60_000);
});
