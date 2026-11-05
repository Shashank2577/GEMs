/**
 * Client IP for per-IP rate limits (008/FR-022, 002/FR-010).
 *
 * - `cloudflare` (only on the Worker; `worker.ts` sets it and the Node server refuses it): `cf-connecting-ip`, which
 *   Cloudflare sets and the client cannot forge.
 * - `xff` (`TRUST_PROXY=1` on Node behind ONE reverse proxy): the RIGHT-most `x-forwarded-for` hop — the address
 *   our proxy appended. Hops to its left are supplied by the client and can be forged.
 * - otherwise the socket address of the Node server (`@hono/node-server` passes `{incoming}` as the env).
 *
 * Headers of proxies we do not trust are ignored. A loopback socket address is treated as unknown: it is a local
 * dev/E2E client or a same-host proxy without `TRUST_PROXY`, and putting every such client into one bucket would
 * lock them all out together (in production this is logged once, as it means IP limits are off).
 * IPv6 addresses are bucketed by /64 (one subscriber usually owns a whole /64).
 * Null means "unknown": callers skip per-IP limits (per-email/user limits still apply).
 */
import type { Context } from 'hono';
import type { TrustProxy } from '../env';
import type { AppEnv } from '../types';

const clean = (v: string | undefined | null) => v?.trim().slice(0, 64) || null;

const LOOPBACK = /^(127\.|::1$|::ffff:127\.|localhost$)/i;

/** `2001:db8:1:2:aa::5` → `2001:db8:1:2::/64`; IPv4 and IPv4-mapped IPv6 come back as the IPv4 address. */
export function ipBucket(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!ip.includes(':')) return ip;
  const addr = ip.split('%')[0]!.toLowerCase();
  const [head, tail] = addr.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (groups.length < 4 || groups.slice(0, 4).some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return addr;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

let warnedLoopback = false;
/** Test hook. */
export function resetClientIpWarning(): void { warnedLoopback = false; }

/** Remote address of the TCP connection on Node; undefined on Workers and in `app.request()` tests. */
export function socketAddress(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const addr = clean(env?.incoming?.socket?.remoteAddress);
  if (addr && LOOPBACK.test(addr)) {
    const deps = (c as Context<AppEnv>).var?.deps;
    if (!warnedLoopback && deps?.config.environment === 'production' && deps.config.trustProxy === 'none') {
      warnedLoopback = true;
      deps.logger.warn('client_ip_unknown: requests arrive from a loopback socket and TRUST_PROXY is unset, so per-IP rate limits are off. Behind a reverse proxy set TRUST_PROXY=1.');
    }
    return null;
  }
  return addr;
}

export function clientIp(c: Context, trust: TrustProxy): string | null {
  let ip: string | null;
  if (trust === 'cloudflare') ip = clean(c.req.header('cf-connecting-ip')) ?? socketAddress(c);
  else if (trust === 'xff') ip = clean(c.req.header('x-forwarded-for')?.split(',').map((h) => h.trim()).filter(Boolean).pop()) ?? socketAddress(c);
  else ip = socketAddress(c);
  return ip ? ipBucket(ip) : null;
}
