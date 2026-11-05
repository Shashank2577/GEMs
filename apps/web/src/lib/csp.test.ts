/**
 * CSP drift guard (spec 008 FR-013): every inline <script> in index.html must be allowed by its sha256 in the
 * Content-Security-Policy of public/_headers. Editing the theme bootstrap script without updating the hash would
 * otherwise silently disable it in production (the browser blocks it and the page flashes the wrong theme).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../../index.html');
const headers = read('../../public/_headers');

/** Bodies of inline scripts (no `src` attribute), exactly as the browser hashes them. */
function inlineScripts(doc: string): string[] {
  return [...doc.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs!))
    .map(([, , body]) => body!);
}

const sha256 = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

/** CSP value of the `/*` rule in the Cloudflare `_headers` file. */
function csp(file: string): string {
  const lines = file.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '/*');
  expect(start, '_headers has a /* rule').toBeGreaterThanOrEqual(0);
  for (const l of lines.slice(start + 1)) {
    if (!/^\s/.test(l) && l.trim()) break;
    const m = /^\s+content-security-policy:\s*(.+)$/i.exec(l);
    if (m) return m[1]!.trim();
  }
  throw new Error('no Content-Security-Policy under /* in public/_headers');
}

const directive = (policy: string, name: string) =>
  policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `))?.split(/\s+/).slice(1) ?? [];

describe('Content-Security-Policy (008 FR-013)', () => {
  const policy = csp(headers);

  it('allows every inline script in index.html by its sha256 — and nothing else inline', () => {
    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0); // the theme bootstrap
    const scriptSrc = directive(policy, 'script-src');
    for (const s of scripts) expect(scriptSrc, `hash for inline script:\n${s.trim().slice(0, 80)}…`).toContain(sha256(s));
    const hashes = scriptSrc.filter((t) => t.startsWith("'sha256-"));
    expect(hashes.sort()).toEqual(scripts.map(sha256).sort()); // no stale hashes left behind
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it('is the FR-013 policy (Google Fonts, same-origin frames for PDF preview, no plugins)', () => {
    expect(policy).toBe(
      "default-src 'self'; script-src 'self' " + directive(policy, 'script-src').slice(1).join(' ') +
      "; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:;" +
      " img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'self'; base-uri 'self';" +
      " form-action 'self'; object-src 'none'",
    );
  });

  it('_headers also sets HSTS, nosniff, referrer and permissions policy, and immutable caching for /assets/*', () => {
    expect(headers).toMatch(/^\s+Strict-Transport-Security: max-age=31536000; includeSubDomains$/m);
    expect(headers).toMatch(/^\s+X-Content-Type-Options: nosniff$/m);
    expect(headers).toMatch(/^\s+Referrer-Policy: strict-origin-when-cross-origin$/m);
    expect(headers).toMatch(/^\s+Permissions-Policy: camera=\(\), microphone=\(\), geolocation=\(\)$/m);
    expect(headers).toMatch(/^\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable$/m);
  });

  it('the hash helper matches the browser algorithm (known vector)', () => {
    expect(sha256('')).toBe("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
  });
});
