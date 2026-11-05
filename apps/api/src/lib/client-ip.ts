/**
 * Client IP for per-IP rate limits (008/FR-022, 002/FR-010).
 *
 * - `cloudflare` (the Worker always runs with this): `cf-connecting-ip`, which Cloudflare sets and the client cannot forge.
 * - `xff` (`TRUST_PROXY=1` on Node behind a reverse proxy): the first `x-forwarded-for` hop.
 * - otherwise the socket address of the Node server (`@hono/node-server` passes `{incoming}` as the env).
 *
 * Headers of proxies we do not trust are ignored. A loopback socket address is treated as unknown: it is a local
 * dev/E2E client or a same-host proxy without `TRUST_PROXY`, and putting every such client into one bucket would
 * lock them all out together. Null means "unknown": callers skip per-IP limits (per-email/user limits still apply).
 */
import type { Context } from 'hono';
import type { TrustProxy } from '../env';

const clean = (v: string | undefined | null) => v?.trim().slice(0, 64) || null;

const LOOPBACK = /^(127\.|::1$|::ffff:127\.|localhost$)/i;

/** Remote address of the TCP connection on Node; undefined on Workers and in `app.request()` tests. */
export function socketAddress(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const addr = clean(env?.incoming?.socket?.remoteAddress);
  return addr && !LOOPBACK.test(addr) ? addr : null;
}

export function clientIp(c: Context, trust: TrustProxy): string | null {
  if (trust === 'cloudflare') return clean(c.req.header('cf-connecting-ip')) ?? socketAddress(c);
  if (trust === 'xff') return clean(c.req.header('x-forwarded-for')?.split(',')[0]) ?? socketAddress(c);
  return socketAddress(c);
}
