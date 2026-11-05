// Cases adapted from erenmyeager15/india-government-tenders-scraper src/http.test.ts (Apache-2.0, see NOTICE):
// node:test → vitest, Buffer → Uint8Array, plus the beforeAttempt hook and readBoundedBody.
import { describe, expect, it } from 'vitest';
import {
  canRetrySource, fetchBoundedResource, isPdfBody, readBoundedBody, SourceBodyLimitError, SourceHttpError, waitForSourceDelay,
} from './http';

const endpoint = 'https://example.invalid/search';
const noDelay = async () => {};
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('fetchBoundedResource', () => {
  it('downloads the bounded body and keeps the response headers', async () => {
    const result = await fetchBoundedResource(endpoint, {}, {
      fetcher: async () => new Response('real-shaped fixture', { headers: { 'set-cookie': 'fixture=value; Path=/' } }),
    });
    expect(text(result.body)).toBe('real-shaped fixture');
    expect(result.status).toBe(200);
    expect(result.headers.get('set-cookie')).toContain('fixture=value');
  });

  for (const status of [401, 403, 404, 429]) {
    it(`surfaces HTTP ${status} after one request without downloading or retrying the rejection`, async () => {
      let calls = 0;
      let canceled = false;
      const err = await fetchBoundedResource(`${endpoint}?token=do-not-log`, {}, {
        fetcher: async () => { calls += 1; return new Response(new ReadableStream({ cancel() { canceled = true; } }), { status }); },
        delay: noDelay,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(SourceHttpError);
      expect((err as SourceHttpError).status).toBe(status);
      expect((err as Error).message).not.toContain('do-not-log');
      expect(calls).toBe(1);
      expect(canceled).toBe(true);
    });
  }

  it('recovers from a transient server failure within the attempt cap', async () => {
    let calls = 0;
    const result = await fetchBoundedResource(endpoint, {}, {
      fetcher: async () => { calls += 1; return new Response(calls === 1 ? 'unavailable' : 'ok', { status: calls === 1 ? 503 : 200 }); },
      delay: noDelay,
    });
    expect(calls).toBe(2);
    expect(text(result.body)).toBe('ok');
  });

  it('stops a persistent server failure at the attempt cap', async () => {
    let calls = 0;
    await expect(fetchBoundedResource(endpoint, {}, { fetcher: async () => { calls += 1; return new Response('', { status: 500 }); }, delay: noDelay }))
      .rejects.toThrow(/HTTP 500/);
    expect(calls).toBe(3);
  });

  it('includes a stalled response body in the deadline', async () => {
    let calls = 0;
    let canceled = false;
    const started = performance.now();
    await expect(fetchBoundedResource(endpoint, {}, {
      timeoutMs: 25, attempts: 1,
      fetcher: async () => { calls += 1; return new Response(new ReadableStream({ cancel() { canceled = true; } })); },
    })).rejects.toThrow(/connection\/body deadline/);
    expect(calls).toBe(1);
    expect(canceled).toBe(true);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('cancels a late response after the header deadline', async () => {
    let canceled = false;
    await expect(fetchBoundedResource(endpoint, {}, {
      timeoutMs: 5, attempts: 1,
      fetcher: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return new Response(new ReadableStream({ cancel() { canceled = true; } }));
      },
    })).rejects.toThrow(/deadline/);
    await new Promise((r) => setTimeout(r, 50));
    expect(canceled).toBe(true);
  });

  it('cancels advertised and streamed oversize bodies without retrying', async () => {
    for (const advertised of [true, false]) {
      let calls = 0;
      let canceled = false;
      await expect(fetchBoundedResource(endpoint, {}, {
        maxBytes: 3,
        fetcher: async () => {
          calls += 1;
          return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4)); }, cancel() { canceled = true; } }),
            { headers: advertised ? { 'content-length': '4' } : {} });
        },
        delay: noDelay,
      })).rejects.toBeInstanceOf(SourceBodyLimitError);
      expect(calls).toBe(1);
      expect(canceled).toBe(true);
    }
  });

  it('lets a caller deadline abort a stalled body without another attempt', async () => {
    const controller = new AbortController();
    const reason = new Error('synthetic run deadline');
    let calls = 0;
    const work = fetchBoundedResource(endpoint, {}, {
      signal: controller.signal,
      fetcher: async () => { calls += 1; return new Response(new ReadableStream()); },
    });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort(reason);
    await expect(work).rejects.toBe(reason);
    expect(calls).toBe(1);
  });

  it('makes no request once the deadline has expired and cancels retry back-off', async () => {
    const signal = AbortSignal.abort(new Error('expired'));
    let calls = 0;
    await expect(fetchBoundedResource(endpoint, {}, { signal, fetcher: async () => { calls += 1; return new Response(); } })).rejects.toThrow(/expired/);
    expect(calls).toBe(0);
    await expect(waitForSourceDelay(10_000, signal)).rejects.toThrow(/expired/);
  });

  it('calls beforeAttempt before every attempt, including retries (FR-024)', async () => {
    const log: string[] = [];
    let calls = 0;
    await fetchBoundedResource(endpoint, {}, {
      beforeAttempt: async () => { log.push('lease'); },
      fetcher: async () => { calls += 1; log.push('fetch'); return new Response('x', { status: calls === 1 ? 502 : 200 }); },
      delay: noDelay,
    });
    expect(log).toEqual(['lease', 'fetch', 'lease', 'fetch']);
  });

  it('propagates a beforeAttempt failure without fetching', async () => {
    let calls = 0;
    await expect(fetchBoundedResource(endpoint, {}, {
      beforeAttempt: async () => { throw new Error('gem busy'); },
      fetcher: async () => { calls += 1; return new Response('x'); },
    })).rejects.toThrow('gem busy');
    expect(calls).toBe(0);
  });
});

describe('readBoundedBody', () => {
  it('reassembles chunks up to exactly the cap', async () => {
    const res = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } }));
    expect([...await readBoundedBody(res, 3)]).toEqual([1, 2, 3]);
  });

  it('returns an empty array for a body-less response', async () => {
    expect((await readBoundedBody(new Response(null), 10)).byteLength).toBe(0);
  });
});

describe('canRetrySource', () => {
  it('retries network errors, 408 and 5xx but not 4xx or oversize bodies', () => {
    expect(canRetrySource(new TypeError('fetch failed'))).toBe(true);
    expect(canRetrySource(new SourceHttpError(408, endpoint))).toBe(true);
    expect(canRetrySource(new SourceHttpError(503, endpoint))).toBe(true);
    expect(canRetrySource(new SourceHttpError(404, endpoint))).toBe(false);
    expect(canRetrySource(new SourceHttpError(429, endpoint))).toBe(false);
    expect(canRetrySource(new SourceBodyLimitError())).toBe(false);
  });
});

describe('isPdfBody', () => {
  it('keeps empty and HTML bodies away from the PDF parser', () => {
    const enc = new TextEncoder();
    expect(isPdfBody(new Uint8Array(0))).toBe(false);
    expect(isPdfBody(enc.encode('<html>not a PDF</html>'))).toBe(false);
    expect(isPdfBody(enc.encode('%PDF-1.7\nfixture'))).toBe(true);
    expect(isPdfBody(enc.encode('﻿  %PDF-1.4\n'))).toBe(true);
  });
});
