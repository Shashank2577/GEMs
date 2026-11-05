/** 008/FR-022: client IP resolution (unit). */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { TrustProxy } from '../env';
import { clientIp, ipBucket, resetClientIpWarning } from './client-ip';

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

  it('TRUST_PROXY=1: right-most x-forwarded-for hop (the one our proxy appended), trimmed', async () => {
    expect(await ipOf('xff', both)).toBe('10.0.0.1');
    expect(await ipOf('xff', { 'x-forwarded-for': '1.2.3.4, 203.0.113.9 ,' })).toBe('203.0.113.9'); // forged left hop ignored
    expect(await ipOf('xff', {})).toBeNull();
  });

  it('no trusted proxy: forged headers are ignored, the Node socket address is used', async () => {
    expect(await ipOf('none', both)).toBeNull();
    expect(await ipOf('none', both, '203.0.113.20')).toBe('203.0.113.20');
    expect(await ipOf('none', {}, '2001:db8::1')).toBe('2001:db8:0:0::/64');
    // A trusted proxy header wins over the socket (which is the proxy itself).
    expect(await ipOf('xff', both, '203.0.113.20')).toBe('10.0.0.1');
    expect(await ipOf('xff', {}, '203.0.113.20')).toBe('203.0.113.20');
  });

  it('loopback sockets are unknown (local dev/E2E, or a same-host proxy without TRUST_PROXY)', async () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(await ipOf('none', {}, addr)).toBeNull();
  });

  it('buckets IPv6 by /64 and unwraps IPv4-mapped addresses', () => {
    expect(ipBucket('2001:db8:1:2:aa::5')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipBucket('::ffff:198.51.100.4')).toBe('198.51.100.4');
    expect(ipBucket('198.51.100.4')).toBe('198.51.100.4');
  });

  it('warns once in production when the socket is loopback and no proxy is trusted', async () => {
    resetClientIpWarning();
    const warnings: string[] = [];
    const deps = { config: { environment: 'production', trustProxy: 'none' }, logger: { warn: (m: string) => warnings.push(m) } };
    const app = new Hono<{ Variables: { deps: unknown } }>()
      .use('*', async (c, next) => { c.set('deps', deps); await next(); })
      .get('/', (c) => c.json({ ip: clientIp(c as never, 'none') }));
    for (let i = 0; i < 3; i++) await app.request('/', {}, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^client_ip_unknown/);
  });

  it('caps the length of whatever it returns', async () => {
    expect((await ipOf('xff', { 'x-forwarded-for': 'a'.repeat(500) }))!.length).toBe(64);
  });
});
