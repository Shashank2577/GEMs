import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFsBlobStore } from '../src/adapters/blob-fs';
import { createMemoryBlobStore } from '../src/adapters/memory-blob';
import { createAnthropicClient, parseJsonLoose } from '../src/adapters/llm';
import { createResendMailer } from '../src/adapters/mailer';
import { createMetaWhatsApp } from '../src/adapters/whatsapp';
import { createDeps } from '../src/adapters/index';
import { silentLogger } from '../src/adapters/logger';
import { hashPassword, verifyPassword, sha256Hex, randomToken } from '../src/lib/crypto';
import { slugify } from '../src/lib/slug';
import { runScheduledJobs } from '../src/lib/scheduled';
import type { BlobStore } from '../src/deps';

describe('crypto', () => {
  it('hashes and verifies passwords with PBKDF2', async () => {
    const h = await hashPassword('s3cret-pass');
    expect(h).toMatch(/^pbkdf2_sha256\$100000\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword('s3cret-pass', h)).toBe(false); // QA probe: deliberately wrong
    expect(await verifyPassword('s3cret-pasS', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await hashPassword('s3cret-pass')).not.toBe(h); // salted
  });
  it('tokens are random and hashes are stable', async () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('slugify', () => {
    expect(slugify('Shree Ganesh Traders & Co.')).toBe('shree-ganesh-traders-and-co');
    expect(slugify('!!!')).toBe('org');
  });
});

async function blobContract(store: BlobStore) {
  const meta = await store.put('org/1/vault/a.pdf', new Uint8Array([37, 80, 68, 70]));
  expect(meta).toMatchObject({ key: 'org/1/vault/a.pdf', size: 4, contentType: 'application/pdf' });
  expect(await store.head('org/1/vault/a.pdf')).toMatchObject({ size: 4, contentType: 'application/pdf' });
  const obj = await store.get('org/1/vault/a.pdf');
  expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
  await store.put('org/1/x.bin', 'hello', { contentType: 'text/plain' });
  const o2 = await store.get('org/1/x.bin');
  expect(o2!.contentType).toBe('text/plain');
  expect(await new Response(o2!.body).text()).toBe('hello');
  await store.delete('org/1/x.bin');
  await store.delete('org/1/x.bin');
  expect(await store.get('org/1/x.bin')).toBeNull();
  expect(await store.head('missing/key')).toBeNull();
}

describe('blob stores', () => {
  it('filesystem store honours the contract and rejects traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-fs-'));
    try {
      const s = createFsBlobStore(dir);
      await blobContract(s);
      await expect(s.put('../escape.txt', 'x')).rejects.toThrow(/Invalid blob key/);
      await expect(s.put('/abs.txt', 'x')).rejects.toThrow(/Invalid blob key/);
      await expect(s.get('a/../../b')).rejects.toThrow(/Invalid blob key/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('memory store honours the contract', async () => { await blobContract(createMemoryBlobStore()); });
});

const fakeFetch = (handler: (url: string, init: RequestInit) => Response) => {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : null });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe('provider adapters', () => {
  it('LLM client calls the Anthropic Messages API and parses JSON replies', async () => {
    const { f, calls } = fakeFetch(() => Response.json({
      model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Here you go:\n```json\n{"turnover": 5000000}\n```' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const llm = createAnthropicClient({ apiKey: 'k', model: 'claude-sonnet-5-5', fetch: f });
    const out = await llm.completeJson<{ turnover: number }>({ system: 'extract', prompt: 'bid text', maxTokens: 100 });
    expect(out).toEqual({ turnover: 5000000 });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(calls[0].body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'bid text' }] });
    expect(calls[0].body.system).toContain('extract');

    const failing = createAnthropicClient({ apiKey: 'k', model: 'm', fetch: fakeFetch(() => new Response('overloaded', { status: 529 })).f });
    await expect(failing.complete({ prompt: 'x' })).rejects.toThrow(/529/);
  });

  it('parseJsonLoose handles prose and arrays', () => {
    expect(parseJsonLoose('[1,2]')).toEqual([1, 2]);
    expect(parseJsonLoose('Sure! {"a":{"b":1}} hope that helps')).toEqual({ a: { b: 1 } });
    expect(() => parseJsonLoose('no json here')).toThrow();
  });

  it('Resend mailer and WhatsApp send the right payloads', async () => {
    const m = fakeFetch(() => Response.json({ id: 'em_1' }));
    const mailer = createResendMailer({ apiKey: 're_x', from: 'TP <a@b.in>', fetch: m.f, logger: silentLogger });
    expect(await mailer.send({ to: 'x@y.in', subject: 'Hi', text: 'Body' })).toEqual({ id: 'em_1' });
    expect(m.calls[0].body).toMatchObject({ from: 'TP <a@b.in>', to: ['x@y.in'], subject: 'Hi' });

    const w = fakeFetch(() => Response.json({ messages: [{ id: 'wamid.1' }] }));
    const wa = createMetaWhatsApp({ token: 't', phoneNumberId: '123', fetch: w.f });
    expect(await wa.send({ to: '+919812345678', template: { name: 'tender_alert', params: ['GEM/2026/B/1'] } })).toEqual({ id: 'wamid.1' });
    expect(w.calls[0].url).toBe('https://graph.facebook.com/v21.0/123/messages');
    expect(w.calls[0].body).toMatchObject({ to: '919812345678', type: 'template', template: { name: 'tender_alert' } });
  });

  it('createDeps degrades gracefully without keys', async () => {
    const deps = createDeps({ env: {}, db: {} as never, blobs: createMemoryBlobStore(), logger: silentLogger });
    expect(deps.llm).toBeNull();
    expect(deps.mailer.configured).toBe(false);
    expect(await deps.mailer.send({ to: 'a@b.in', subject: 's' })).toEqual({ skipped: true });
    expect(deps.whatsapp.configured).toBe(false);
    expect(await deps.whatsapp.send({ to: '+911234567890', text: 'x' })).toEqual({ skipped: true });
    expect(deps.config.llmModel).toBe('claude-sonnet-5-5');
    expect(deps.gem.baseUrl).toBe('https://bidplus.gem.gov.in');
    const withKeys = createDeps({ env: { ANTHROPIC_API_KEY: 'k', RESEND_API_KEY: 'r', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p', GEM_BASE_URL: 'http://localhost:4010/' }, db: {} as never, blobs: createMemoryBlobStore(), logger: silentLogger });
    expect(withKeys.llm?.model).toBe('claude-sonnet-5-5');
    expect(withKeys.mailer.configured).toBe(true);
    expect(withKeys.whatsapp.configured).toBe(true);
    expect(withKeys.gem.baseUrl).toBe('http://localhost:4010');
  });

  it('scheduled pipeline runs every step', async () => {
    const deps = createDeps({ env: {}, db: {} as never, blobs: createMemoryBlobStore(), logger: silentLogger });
    const report = await runScheduledJobs(deps);
    expect(report.map((r) => r.step)).toEqual(['ingestion', 'alerts', 'reminders']);
  });
});
