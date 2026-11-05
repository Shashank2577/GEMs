/**
 * Local stub of the Anthropic Messages API for the 004/US7 E2E (T094, FR-047..FR-054). The API under test is started with
 *   ANTHROPIC_API_KEY=qa-fake LLM_BASE_URL=http://127.0.0.1:<E2E_LLM_PORT> PACKET_MAX_INPUT_BYTES=41943040
 * and every request it makes for enrichment (text prompt) or OCR (PDF `document` block) lands here. The stub records
 * each request (so a test can count them and inspect what left the API) and answers according to a per-kind mode:
 *
 *   enrichment: 'atc-item' | 'conflict' | 'empty' | 'items' | 'http-error' | 'non-json' | 'timeout' | 'refusal' | 'max-tokens'
 *   OCR:        'ok' | 'omit-page' | 'http-error'
 *
 * Same approach as the counting fake in e2e/008-operations-scale/US7-efficiency.e2e.ts (a node:http server in the test
 * process on E2E_LLM_PORT, default 4119).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { extractPdf } from '../../packages/core/src/analyse/pdf-text';

export const LLM_PORT = Number(process.env.E2E_LLM_PORT || 4119);

export type EnrichMode = 'atc-item' | 'conflict' | 'empty' | 'items' | 'http-error' | 'non-json' | 'timeout' | 'refusal' | 'max-tokens';
export type OcrMode = 'ok' | 'omit-page' | 'http-error';

export interface StubItem {
  key: string; label: string; value: string | number | boolean | null; numeric?: number | null; mandatory?: boolean;
  page: number | null; quote: string | null; confidence: number;
}

export interface LlmCall {
  n: number;
  kind: 'enrich' | 'ocr';
  at: number;
  model: string;
  /** The request body exactly as the API sent it (used for the data-protection check). */
  body: string;
  /** system + prompt characters (enrichment) — what the 008/FR-031 budget counts. */
  promptChars: number;
  /** Characters of tender-document page text in an enrichment prompt (without "=== Page N ===" markers). */
  pageTextChars: number;
  /** The "=== Page N ===" numbers in an enrichment prompt. */
  pages: number[];
  hasSchema: boolean;
  maxTokens: number;
  /** OCR: pages in the attached PDF part. */
  ocrPages?: number;
  mode: string;
  /** How the call ended on the API side: 'answered' or, for a held call, how long until the API gave up on it. */
  outcome: 'answered' | 'aborted-by-client';
  heldMs?: number;
}

/** The ESI registration item of acceptance scenario 1 (the model reports confidence 0.95; the API caps it at 0.9). */
export const ESI_ITEM: StubItem = {
  key: 'certificate', label: 'ESI registration', value: 'ESI registration', numeric: null, mandatory: true, page: 4,
  quote: 'Manpower deployed must be on the payroll of the bidder and compliant with EPF/ESI regulations.', confidence: 0.95,
};

const pdfLib = () => createRequire(join(process.cwd(), 'packages/core/package.json'))('pdf-lib') as typeof import('pdf-lib');

/** Page texts the OCR "reads" from a scanned page: pages 1, 2 and 4 of go-it-services.pdf (bid details, MII, ATC). */
let ocrSource: string[] | undefined;
async function ocrTexts(): Promise<string[]> {
  if (!ocrSource) {
    const bytes = new Uint8Array(readFileSync(join(process.cwd(), 'packages/core/test/fixtures/bids/go-it-services.pdf')));
    const { pages } = await extractPdf(bytes, { maxPages: 150 });
    ocrSource = [pages[0]!, pages[1]!, pages[3]!];
  }
  return ocrSource;
}

export interface LlmStub {
  port: number;
  calls: LlmCall[];
  enrich: EnrichMode;
  ocr: OcrMode;
  items: StubItem[];
  /** When set, 'items' mode answers with what this returns for the call (e.g. one distinct item per chunk). */
  itemsFor?: (call: LlmCall) => StubItem[];
  /** Delay before every enrichment answer (ms), for the "Analysing…" screenshot. */
  enrichDelayMs: number;
  /** How long a 'timeout' call is held before the stub answers anyway (the API aborts first). */
  holdMs: number;
  reset(): void;
  of(kind: 'enrich' | 'ocr'): LlmCall[];
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => ok(b)); });

export async function startLlmStub(port = LLM_PORT): Promise<LlmStub> {
  const stub: LlmStub = {
    port, calls: [], enrich: 'atc-item', ocr: 'ok', items: [], enrichDelayMs: 0, holdMs: 100_000,
    reset() { stub.calls.length = 0; stub.enrich = 'atc-item'; stub.ocr = 'ok'; stub.items = []; stub.itemsFor = undefined; stub.enrichDelayMs = 0; stub.holdMs = 100_000; },
    of: (kind) => stub.calls.filter((c) => c.kind === kind),
    close: () => new Promise<void>((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };

  const message = (model: string, text: string, stopReason = 'end_turn') => JSON.stringify({
    id: 'msg_qa', type: 'message', role: 'assistant', model, stop_reason: stopReason,
    content: [{ type: 'text', text }], usage: { input_tokens: 1200, output_tokens: 90 },
  });
  const send = (res: ServerResponse, status: number, body: string) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(body); };

  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let json: { model?: string; max_tokens?: number; system?: string; messages?: { content: unknown }[]; output_config?: unknown } = {};
    try { json = JSON.parse(raw); } catch { /* not JSON: recorded as an empty call */ }
    const content = json.messages?.[0]?.content;
    const docBlock = Array.isArray(content) ? (content as { type: string; source?: { data?: string } }[]).find((b) => b.type === 'document') : undefined;
    const model = json.model ?? 'unknown';
    const call: LlmCall = {
      n: stub.calls.length + 1, kind: docBlock ? 'ocr' : 'enrich', at: Date.now(), model, body: raw, promptChars: 0, pageTextChars: 0, pages: [],
      hasSchema: !!json.output_config, maxTokens: json.max_tokens ?? 0, mode: docBlock ? stub.ocr : stub.enrich, outcome: 'answered',
    };
    stub.calls.push(call);

    if (docBlock) {
      // ---- OCR: transcribe the attached PDF part page by page ----
      const part = await pdfLib().PDFDocument.load(Buffer.from(docBlock.source?.data ?? '', 'base64'));
      const count = part.getPageCount();
      call.ocrPages = count;
      if (stub.ocr === 'http-error') return send(res, 500, JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stub: OCR down' } }));
      const texts = await ocrTexts();
      const pages = Array.from({ length: count }, (_, i) => ({ page: i + 1, text: texts[i % texts.length]! }));
      const reply = stub.ocr === 'omit-page' ? pages.filter((p) => p.page !== 2) : pages;
      return send(res, 200, message(model, JSON.stringify({ pages: reply })));
    }

    // ---- enrichment ----
    const text = typeof content === 'string' ? content : '';
    call.promptChars = (json.system ?? '').length + text.length;
    const docText = text.split('Document text:\n')[1] ?? '';
    for (const m of docText.matchAll(/=== Page (\d+) ===\n([\s\S]*?)(?=\n\n=== Page \d+ ===\n|$)/g)) { call.pages.push(Number(m[1])); call.pageTextChars += m[2]!.length; }

    const answer = () => {
      switch (stub.enrich) {
        case 'atc-item': return send(res, 200, message(model, JSON.stringify({ requirements: [ESI_ITEM] })));
        case 'conflict': case 'items': return send(res, 200, message(model, JSON.stringify({ requirements: stub.itemsFor ? stub.itemsFor(call) : stub.items })));
        case 'empty': return send(res, 200, message(model, JSON.stringify({ requirements: [] })));
        case 'http-error': return send(res, 500, JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stub: upstream failure' } }));
        case 'non-json': return send(res, 200, message(model, 'Sorry, I cannot produce JSON for this document, but it looks like a standard GeM bid.'));
        case 'refusal': return send(res, 200, message(model, JSON.stringify({ requirements: [ESI_ITEM] }), 'refusal'));
        case 'max-tokens': return send(res, 200, message(model, '{"requirements":[{"key":"certificate","label":"ESI regis', 'max_tokens'));
        case 'timeout': return undefined;
      }
    };
    if (stub.enrich === 'timeout') {
      // Hold the connection: the API's own timeout (not the stub) must end this call.
      const started = Date.now();
      const timer = setTimeout(() => { call.heldMs = Date.now() - started; send(res, 200, message(model, JSON.stringify({ requirements: [ESI_ITEM] }))); }, stub.holdMs);
      res.on('close', () => { if (!res.writableEnded) { call.outcome = 'aborted-by-client'; call.heldMs = Date.now() - started; } clearTimeout(timer); });
      return;
    }
    if (stub.enrichDelayMs) await new Promise((ok) => setTimeout(ok, stub.enrichDelayMs));
    answer();
  });

  await new Promise<void>((ok, bad) => { server.once('error', bad); server.listen(port, '127.0.0.1', () => ok()); });
  return stub;
}
