/** 008/FR-022: client IP resolution (unit). */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { TrustProxy } from '../env';
import { clientIp } from './client-ip';

async function ipOf(trust: TrustProxy, headers: Record<string, string>, remoteAddress?: string): Promise<string | null> {
  const app = new Hono().get('/', (c) => c.json({ ip: clientIp(c, trust) }));
  // @hono/node-server passes `{ incoming, outgoing }` as the env; app.request's 3rd argument plays that role here.
  const env = remoteAddress ? { incoming: { socket: { remoteAddress } } } : undefined;
  const res = await app.request('/', { headers }, env);
  return ((await res.json()) as { ip: string | null }).ip;
}

const both = { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': ' 198.51.100.8 , 10.0.0.1' };

describe('clientIp', () => {
  it('Workers (TRUST_PROXY=cloudflare): cf-connecting-ip only', async () => {
    expect(await ipOf('cloudflare', both)).toBe('198.51.100.7');
    expect(await ipOf('cloudflare', { 'x-forwarded-for': '198.51.100.8' })).toBeNull();
  });

  it('TRUST_PROXY=1: first x-forwarded-for hop, trimmed', async () => {
    expect(await ipOf('xff', both)).toBe('198.51.100.8');
    expect(await ipOf('xff', {})).toBeNull();
  });

  it('no trusted proxy: forged headers are ignored, the Node socket address is used', async () => {
    expect(await ipOf('none', both)).toBeNull();
    expect(await ipOf('none', both, '203.0.113.20')).toBe('203.0.113.20');
    expect(await ipOf('none', {}, '2001:db8::1')).toBe('2001:db8::1');
    // A trusted proxy header wins over the socket (which is the proxy itself).
    expect(await ipOf('xff', both, '203.0.113.20')).toBe('198.51.100.8');
    expect(await ipOf('xff', {}, '203.0.113.20')).toBe('203.0.113.20');
  });

  it('loopback sockets are unknown (local dev/E2E, or a same-host proxy without TRUST_PROXY)', async () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(await ipOf('none', {}, addr)).toBeNull();
  });

  it('caps the length of whatever it returns', async () => {
    expect((await ipOf('xff', { 'x-forwarded-for': 'a'.repeat(500) }))!.length).toBe(64);
  });
});
