/**
 * Security headers (spec 008 FR-013), shared by the API middleware (middleware/request.ts) and the Node static
 * server (node.ts). Static/SPA headers live in `apps/web/public/_headers` (Cloudflare format); the Node server parses
 * the built copy with `parseHeadersFile` so local, CI and Cloudflare send the same headers.
 */

/** Sent on every response (API and static). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

/** Only on HTTPS (browsers ignore it over plain HTTP; never sent on the local http stack). */
export const HSTS = 'max-age=31536000; includeSubDomains';

/** File streams (PDF preview/download): may be framed by the app itself, nobody else. */
export const FILE_FRAME_CSP = "frame-ancestors 'self'";

/** True when the request reached us over HTTPS (directly, or via a trusted proxy's `x-forwarded-proto`). */
export function isHttpsRequest(url: string, forwardedProto: string | undefined, trustProxy: boolean): boolean {
  if (new URL(url).protocol === 'https:') return true;
  return trustProxy && (forwardedProto ?? '').split(',')[0]!.trim().toLowerCase() === 'https';
}

export interface HeaderRule { pattern: string; headers: [string, string][] }

/**
 * Parse a Cloudflare `_headers` file: an unindented line is a URL pattern (`/*`, `/assets/*`), indented
 * `Name: value` lines below it are its headers; `#` lines are comments.
 */
export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ pattern: raw.trim(), headers: [] });
      continue;
    }
    const rule = rules[rules.length - 1];
    const i = raw.indexOf(':');
    if (!rule || i < 0) continue;
    rule.headers.push([raw.slice(0, i).trim().toLowerCase(), raw.slice(i + 1).trim()]);
  }
  return rules;
}

/** Path-only patterns with `*` splats (enough for this repo's `_headers`). */
function matches(pattern: string, pathname: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(pathname);
}

/** Headers for a static path; later rules override earlier ones; HSTS dropped unless HTTPS. */
export function staticHeadersFor(rules: HeaderRule[], pathname: string, https: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules) if (matches(r.pattern, pathname)) for (const [k, v] of r.headers) out[k] = v;
  if (!https) delete out['strict-transport-security'];
  return out;
}
