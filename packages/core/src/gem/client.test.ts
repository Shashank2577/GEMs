// 008/FR-024: GemClient takes a cluster-wide lease slot (beforeRequest) before EVERY HTTP attempt, retries included.
// The rest of GemClient's behaviour is covered in packages/core/test/gem/client.test.ts.
import { describe, expect, it } from 'vitest';
import { GemClient, GemError } from './client';

const TOKEN = '0123456789abcdef0123456789abcdef';

function fakeGem(statusFor: (url: string, n: number) => number = () => 200) {
  const log: string[] = [];
  let n = 0;
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    n++;
    log.push(`fetch ${new URL(url).pathname}`);
    const status = statusFor(url, n);
    if (status !== 200) return new Response('busy', { status });
    if (url.endsWith('/all-bids')) {
      return new Response(`<html>'csrf_bd_gem_nk':'${TOKEN}'</html>`, { headers: { 'set-cookie': `csrf_gem_cookie=${TOKEN}; Path=/` } });
    }
    if (url.endsWith('/all-bids-data')) return new Response(JSON.stringify({ response: { response: { numFound: 0, docs: [] } } }));
    return new Response(new TextEncoder().encode('%PDF-1.7 fake'), { headers: { 'content-type': 'application/pdf' } });
  }) as typeof fetch;
  return { f, log };
}

const noSleep = { sleep: async () => {}, minIntervalMs: 0, backoffMs: 0 };

describe('GemClient beforeRequest hook (008/FR-024)', () => {
  it('is awaited before every request of a listing (bootstrap + data)', async () => {
    const { f, log } = fakeGem();
    const gem = new GemClient(f, { ...noSleep, baseUrl: 'http://gem.test', beforeRequest: async () => { log.push('lease'); } });
    await gem.fetchPage({ page: 1 });
    expect(log).toEqual(['lease', 'fetch /all-bids', 'lease', 'fetch /all-bids-data']);
  });

  it('is awaited again before each retry', async () => {
    const { f, log } = fakeGem((_url, n) => (n <= 2 ? 503 : 200));
    const gem = new GemClient(f, { ...noSleep, baseUrl: 'http://gem.test', maxRetries: 3, beforeRequest: async () => { log.push('lease'); } });
    await gem.fetchBidDocument('42');
    expect(log).toEqual(['lease', 'fetch /showbidDocument/42', 'lease', 'fetch /showbidDocument/42', 'lease', 'fetch /showbidDocument/42']);
  });

  it('waits for the hook to resolve before sending', async () => {
    const { f, log } = fakeGem();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gem = new GemClient(f, { ...noSleep, baseUrl: 'http://gem.test', beforeRequest: () => gate });
    const p = gem.fetchBidDocument('7');
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual([]);
    release();
    await p;
    expect(log).toEqual(['fetch /showbidDocument/7']);
  });

  it('sends nothing when the hook rejects, and propagates its error', async () => {
    const { f, log } = fakeGem();
    const busy = new Error('gem_busy');
    const gem = new GemClient(f, { ...noSleep, baseUrl: 'http://gem.test', beforeRequest: async () => { throw busy; } });
    await expect(gem.fetchBidDocument('7')).rejects.toBe(busy);
    expect(log).toEqual([]);
    expect(gem.requests).toBe(0);
  });

  it('still caps a document with the ported bounded reader', async () => {
    const f = (async () => new Response(new Uint8Array(20), { headers: { 'content-length': '20' } })) as typeof fetch;
    const gem = new GemClient(f, { ...noSleep, baseUrl: 'http://gem.test', maxDocumentBytes: 10 });
    const err = await gem.fetchBidDocument('1').catch((e) => e);
    expect(err).toBeInstanceOf(GemError);
    expect((err as GemError).code).toBe('too_large');
  });
});
