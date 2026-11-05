/**
 * Mock GeM BidPlus (dev + tests + E2E). Mirrors the public endpoints TenderPilot reads:
 *
 *   GET  /all-bids                     HTML page; sets `csrf_gem_cookie` and embeds `csrf_bd_gem_nk`
 *   POST /all-bids-data                form `payload=<json>&csrf_bd_gem_nk=<token>` → Solr-style JSON (10/page)
 *   GET  /showbidDocument/:id          generated GeM-style bid document PDF (also /showradocumentPdf, /showdirectradocumentPdf)
 *
 * Admin switches for E2E (not part of GeM):
 *   POST /__admin/publish {count?}     publish N new bids (simulates fresh tenders)
 *   POST /__admin/corrigendum/:bidNumber {days?}   extend a bid's end date (bid number URL-encoded, or ?bidNumber=)
 *   POST /__admin/fail {mode:'down'|'html'|'off'}  simulate GeM outages
 *   POST /__admin/document-mode {mode:'normal'|'404'|'html'|'scanned'|'oversize'}  how /showbidDocument answers
 *                                      (404 page, HTML login page, PDF without text layer, > 25 MB stream)
 *   POST /__admin/reset                restore the recorded fixtures
 *   GET  /__admin/state                current bid numbers + counters
 *   GET  /__admin/requests             arrival log of the last 1,000 non-admin requests ({at, method, path}) — the
 *                                      load script measures GeM inter-arrival times from it (spec 008 FR-024, NFR-002)
 *
 * Fixture dates are rebased so that the fixture reference date maps to "now" at reset time.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { parseGemDate, toGemSolrDate } from '@tp/core/gem/normalize';
import { parseBidPlusDoc, type BidPlusDoc } from '@tp/core/gem/parse';
import { oversizePdfStream, renderBidPdf, renderScannedPdf } from './pdf';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/test/fixtures/gem');
const PAGE_SIZE = 10;

export const DOCUMENT_MODES = ['normal', '404', 'html', 'scanned', 'oversize'] as const;
export type DocumentMode = (typeof DOCUMENT_MODES)[number];

type Doc = BidPlusDoc & { b_id: number[]; b_bid_number: string[] };

function loadFixtures(): { docs: Doc[]; extra: Doc[]; reference: Date } {
  const meta = JSON.parse(readFileSync(join(FIXTURE_DIR, 'meta.json'), 'utf8')) as { referenceDate: string; total: number };
  const docs: Doc[] = [];
  for (let p = 1; docs.length < meta.total; p++) {
    const page = JSON.parse(readFileSync(join(FIXTURE_DIR, `page-${p}.json`), 'utf8'));
    docs.push(...page.response.response.docs);
  }
  const extra = JSON.parse(readFileSync(join(FIXTURE_DIR, 'extra-bids.json'), 'utf8')) as Doc[];
  return { docs, extra, reference: new Date(meta.referenceDate) };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function shiftDoc(doc: Doc, ms: number): Doc {
  const d = clone(doc);
  for (const k of ['final_start_date_sort', 'final_end_date_sort'] as const) {
    const parsed = parseGemDate(d[k]);
    if (parsed) d[k] = [toGemSolrDate(new Date(parsed.getTime() + ms))];
  }
  return d;
}

export interface MockGemOptions {
  /** Clock (tests). */
  now?: () => Date;
  /** CSRF token (default random per reset). */
  token?: string;
  /** Rebase fixture dates to now (default true). */
  rebase?: boolean;
}

const REQUEST_LOG_MAX = 1000;

export function createMockGem(opts: MockGemOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const fixtures = loadFixtures();
  const state = {
    token: '',
    docs: [] as Doc[],
    pending: [] as Doc[],
    nextSyntheticId: 7429001,
    failMode: 'off' as 'off' | 'down' | 'html',
    documentMode: 'normal' as DocumentMode,
    requests: { listing: 0, documents: 0, bootstrap: 0 },
    /** Arrival log (ms since epoch, real clock) of the last REQUEST_LOG_MAX non-admin requests. */
    requestLog: [] as { at: number; method: string; path: string }[],
  };

  const reset = () => {
    // Whole days, so printed times stay on GeM-like hours (15:00 / 18:00 IST).
    const shift = opts.rebase === false ? 0 : Math.round((now().getTime() - fixtures.reference.getTime()) / 86_400_000) * 86_400_000;
    state.token = opts.token ?? Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    state.docs = fixtures.docs.map((d) => shiftDoc(d, shift));
    state.pending = fixtures.extra.map((d) => shiftDoc(d, shift));
    state.nextSyntheticId = 7429001;
    state.failMode = 'off';
    state.documentMode = 'normal';
    state.requests = { listing: 0, documents: 0, bootstrap: 0 };
    state.requestLog = [];
  };
  reset();

  /** Publish N new bids "now": takes the queued extra bids first, then synthesises copies. */
  const publish = (count: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      let d = state.pending.shift();
      if (!d) {
        const base = clone(fixtures.docs[i % fixtures.docs.length]);
        const id = state.nextSyntheticId++;
        base.b_id = [id];
        base.id = String(id);
        base.b_bid_number = [String(base.b_bid_number[0]).replace(/\/\d+$/, `/${id - 1000000}`)];
        d = base;
      }
      // Starts now, closes in 10–20 days.
      const start = now();
      const end = new Date(start.getTime() + (10 + (Number(d.b_id[0]) % 11)) * 86_400_000);
      d.final_start_date_sort = [toGemSolrDate(start)];
      d.final_end_date_sort = [toGemSolrDate(new Date(Math.floor(end.getTime() / 3_600_000) * 3_600_000))];
      state.docs.push(d);
      out.push(String(d.b_bid_number[0]));
    }
    return out;
  };

  const findByBidNumber = (bn: string) => state.docs.find((d) => String(d.b_bid_number[0]) === bn);
  const findById = (id: string) => state.docs.find((d) => String(d.b_id[0]) === id) ?? fixtures.extra.find((d) => String(d.b_id[0]) === id);

  const app = new Hono();

  app.use('*', async (c, next) => {
    if (!c.req.path.startsWith('/__admin')) {
      state.requestLog.push({ at: Date.now(), method: c.req.method, path: c.req.path });
      if (state.requestLog.length > REQUEST_LOG_MAX) state.requestLog.splice(0, state.requestLog.length - REQUEST_LOG_MAX);
    }
    await next();
  });

  app.get('/', (c) => c.redirect('/all-bids'));

  app.get('/all-bids', (c) => {
    state.requests.bootstrap++;
    if (state.failMode === 'down') return c.text('Service Unavailable', 503);
    c.header('set-cookie', `csrf_gem_cookie=${state.token}; Path=/; HttpOnly; SameSite=Lax`);
    return c.html(`<!doctype html><html><head><title>All Bids | GeM (mock)</title></head><body>
<h1>Bids (mock BidPlus for TenderPilot development)</h1>
<script>var csrf = {'csrf_bd_gem_nk':'${state.token}'};</script>
<form><input type="hidden" name="csrf_bd_gem_nk" value="${state.token}"></form></body></html>`);
  });

  app.post('/all-bids-data', async (c) => {
    state.requests.listing++;
    if (state.failMode === 'down') return c.text('Service Unavailable', 503);
    if (state.failMode === 'html') return c.html('<html><body>Scheduled maintenance</body></html>');
    const form = await c.req.parseBody();
    const token = String(form.csrf_bd_gem_nk ?? '');
    const cookie = getCookie(c, 'csrf_gem_cookie');
    if (!token || token !== state.token || (cookie !== undefined && cookie !== state.token)) {
      return c.json({ code: 403, status: 0, message: 'Invalid CSRF token' }, 403);
    }
    let payload: { page?: number; param?: { searchBid?: string }; filter?: { sort?: string; bidStatusType?: string } } = {};
    try { payload = JSON.parse(String(form.payload ?? '{}')); } catch { return c.json({ code: 400, message: 'Bad payload' }, 400); }
    const page = Math.max(1, Number(payload.page ?? 1) || 1);
    const q = (payload.param?.searchBid ?? '').trim().toLowerCase();
    const nowMs = now().getTime();
    const closedWanted = payload.filter?.bidStatusType === 'bidrastatus';
    let list = state.docs.filter((d) => {
      const end = parseGemDate(d.final_end_date_sort)?.getTime() ?? 0;
      return closedWanted ? end < nowMs : end >= nowMs;
    });
    if (q) {
      const words = q.split(/\s+/);
      list = list.filter((d) => {
        const hay = [d.b_bid_number, d.b_category_name, d.bd_category_name, d.ba_official_details_minName, d.ba_official_details_deptName, d.ba_official_details_orgName, d.ba_official_details_officeName]
          .map((v) => (Array.isArray(v) ? v[0] : v) ?? '').join(' ').toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const sortKey = payload.filter?.sort ?? 'Bid-Start-Date-Latest';
    const key = sortKey.includes('Start') ? 'final_start_date_sort' : 'final_end_date_sort';
    const dir = sortKey.endsWith('Oldest') ? 1 : -1;
    list = [...list].sort((a, b) => dir * ((parseGemDate(a[key])?.getTime() ?? 0) - (parseGemDate(b[key])?.getTime() ?? 0)) || Number(b.b_id[0]) - Number(a.b_id[0]));
    if (!list.length) return c.json({ code: 404, status: 0, message: 'No data found', response: { response: { numFound: 0, start: 0, docs: [] } } }, 404);
    const start = (page - 1) * PAGE_SIZE;
    return c.json({
      code: 200,
      status: 1,
      message: 'Data Found',
      response: {
        responseHeader: { status: 0, QTime: 2, params: { start: String(start), rows: String(PAGE_SIZE) } },
        response: { numFound: list.length, start, numFoundExact: true, docs: list.slice(start, start + PAGE_SIZE) },
      },
    });
  });

  const servePdf = async (id: string) => {
    state.requests.documents++;
    if (state.failMode === 'down') return new Response('Service Unavailable', { status: 503 });
    const doc = findById(id);
    const notFound = () => new Response('<html><body>Bid not found</body></html>', { status: 404, headers: { 'content-type': 'text/html' } });
    if (!doc || state.documentMode === '404') return notFound();
    const pdfHeaders = { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="GeM-Bidding-${id}.pdf"`, 'cache-control': 'no-store' };
    if (state.documentMode === 'html') {
      return new Response('<!DOCTYPE html><html><body><h1>Session expired</h1><p>Please login again.</p></body></html>', { headers: { 'content-type': 'text/html; charset=UTF-8' } });
    }
    if (state.documentMode === 'scanned') return new Response((await renderScannedPdf()) as unknown as BodyInit, { headers: pdfHeaders });
    if (state.documentMode === 'oversize') return new Response(oversizePdfStream(), { headers: pdfHeaders });
    const t = parseBidPlusDoc(doc, { now: now() });
    if (!t) return new Response('Bad bid', { status: 500 });
    const bytes = await renderBidPdf(t);
    return new Response(bytes as unknown as BodyInit, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="GeM-Bidding-${id}.pdf"`,
        'cache-control': 'no-store',
      },
    });
  };
  app.get('/showbidDocument/:id', (c) => servePdf(c.req.param('id')));
  app.get('/showradocumentPdf/:id', (c) => servePdf(c.req.param('id')));
  app.get('/showdirectradocumentPdf/:id', (c) => servePdf(c.req.param('id')));

  // ───────────── admin (E2E) ─────────────
  const readJson = async (c: { req: { text(): Promise<string> } }) => {
    try { const t = await c.req.text(); return t ? JSON.parse(t) : {}; } catch { return {}; }
  };

  app.post('/__admin/publish', async (c) => {
    const body = await readJson(c);
    const count = Math.min(50, Math.max(1, Number(body.count ?? c.req.query('count') ?? 3) || 3));
    const published = publish(count);
    return c.json({ ok: true, published, total: state.docs.length });
  });

  app.post('/__admin/corrigendum/*', async (c) => {
    const body = await readJson(c);
    const fromPath = decodeURIComponent(c.req.path.replace(/^\/__admin\/corrigendum\/?/, ''));
    const bidNumber = String(body.bidNumber ?? c.req.query('bidNumber') ?? fromPath);
    const doc = findByBidNumber(bidNumber);
    if (!doc) return c.json({ ok: false, error: `Unknown bid ${bidNumber}` }, 404);
    const days = Number(body.days ?? c.req.query('days') ?? 7) || 7;
    const end = parseGemDate(doc.final_end_date_sort) ?? now();
    const newEnd = body.endAt ? new Date(String(body.endAt)) : new Date(end.getTime() + days * 86_400_000);
    doc.final_end_date_sort = [toGemSolrDate(newEnd)];
    if (body.quantity != null) doc.b_total_quantity = [Number(body.quantity)];
    return c.json({ ok: true, bidNumber, endAt: newEnd.toISOString() });
  });

  app.post('/__admin/fail', async (c) => {
    const body = await readJson(c);
    const mode = ['down', 'html', 'off'].includes(body.mode) ? body.mode : 'down';
    state.failMode = mode;
    return c.json({ ok: true, failMode: state.failMode });
  });

  app.post('/__admin/document-mode', async (c) => {
    const body = await readJson(c);
    const mode = body.mode ?? c.req.query('mode');
    if (!DOCUMENT_MODES.includes(mode)) return c.json({ ok: false, error: `mode must be one of ${DOCUMENT_MODES.join(', ')}` }, 400);
    state.documentMode = mode;
    return c.json({ ok: true, documentMode: state.documentMode });
  });

  app.post('/__admin/reset', (c) => {
    reset();
    return c.json({ ok: true, total: state.docs.length });
  });

  app.get('/__admin/requests', (c) => c.json({ items: state.requestLog }));

  app.get('/__admin/state', (c) => c.json({
    total: state.docs.length,
    pending: state.pending.length,
    failMode: state.failMode,
    documentMode: state.documentMode,
    requests: state.requests,
    bids: state.docs.map((d) => ({ bidNumber: d.b_bid_number[0], id: d.b_id[0], end: d.final_end_date_sort })),
  }));

  return { app, state, reset, publish };
}

export type MockGem = ReturnType<typeof createMockGem>;
