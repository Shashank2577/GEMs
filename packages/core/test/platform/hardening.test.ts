import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PASSWORD_RESET_TTL_MINUTES, resetTtlText } from '../../src/contracts/auth';
import { BASE_SECURITY_HEADERS, cloudflareHeadersFile, inlineScriptHashes, inlineScripts, spaCsp, spaCspFor } from '../../src/security/headers';

describe('resetTtlText (002/FR-011 copy)', () => {
  it('follows PASSWORD_RESET_TTL_MINUTES', () => {
    expect(PASSWORD_RESET_TTL_MINUTES).toBe(60);
    expect(resetTtlText()).toBe('1 hour');
    expect(resetTtlText(120)).toBe('2 hours');
    expect(resetTtlText(90)).toBe('90 minutes');
    expect(resetTtlText(1)).toBe('1 minute');
  });
});

describe('security headers / CSP (002/FR-050)', () => {
  const theme = "\n(function(){document.documentElement.classList.add('dark')})();\n";
  const html = `<html><head><script>${theme}</script><script type="module" src="/assets/a.js"></script>`
    + `<SCRIPT >x()</SCRIPT></head></html>`;

  it('finds inline scripts only (not src= scripts), byte-exact', () => {
    expect(inlineScripts(html)).toEqual([theme, 'x()']);
  });

  it('hashes inline scripts as the browser does (sha256, base64)', async () => {
    const b64 = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64');
    expect(await inlineScriptHashes(html)).toEqual([`'sha256-${b64(theme)}'`, `'sha256-${b64('x()')}'`]);
    expect(await inlineScriptHashes('<p>no scripts</p>')).toEqual([]);
  });

  it('CSP: scripts self + hashes only; no unsafe-eval; the app cannot be framed', async () => {
    const csp = await spaCspFor(html);
    expect(csp).toBe(spaCsp(await inlineScriptHashes(html)));
    const dirs = Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
    expect(dirs['script-src'][0]).toBe("'self'");
    expect(dirs['script-src'].slice(1).every((s: string) => s.startsWith("'sha256-"))).toBe(true);
    expect(dirs['default-src']).toEqual(["'self'"]);
    expect(dirs['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(dirs['frame-ancestors']).toEqual(["'none'"]);
    expect(csp).not.toContain('unsafe-eval');
  });

  it('the Cloudflare _headers file carries every header for all paths', () => {
    const file = cloudflareHeadersFile("default-src 'self'");
    expect(file).toContain('\n/*\n');
    for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) expect(file).toContain(`  ${k}: ${v}\n`);
    expect(file).toContain('  Referrer-Policy: no-referrer\n');
    expect(file).toContain('  Strict-Transport-Security: max-age=31536000; includeSubDomains\n');
    expect(file).toContain("  Content-Security-Policy: default-src 'self'\n");
  });
});
