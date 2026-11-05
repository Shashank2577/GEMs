import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { cloudflareHeadersFile, spaCspFor } from '../../packages/core/src/security/headers';

const apiTarget = process.env.API_PROXY ?? 'http://localhost:8787';

/**
 * 002/FR-050: write `dist/_headers` (Cloudflare static assets) with the security headers and a CSP whose script hash
 * is computed from the built index.html, so the inline theme script can change without the CSP drifting.
 * The Node server (apps/api/src/node.ts) computes the same CSP from the same file at runtime.
 */
function securityHeadersFile(): Plugin {
  let outDir = 'dist';
  return {
    name: 'tp-security-headers',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir.startsWith('/') ? c.build.outDir : join(c.root, c.build.outDir); },
    async closeBundle() {
      const html = readFileSync(join(outDir, 'index.html'), 'utf8');
      writeFileSync(join(outDir, '_headers'), cloudflareHeadersFile(await spaCspFor(html)));
    },
  };
}

export default defineConfig({
  plugins: [react(), securityHeadersFile()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, proxy: { '/api': { target: apiTarget, changeOrigin: true } } },
  preview: { port: 4173, proxy: { '/api': { target: apiTarget, changeOrigin: true } } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          radix: ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-popover', '@radix-ui/react-tooltip', '@radix-ui/react-select', '@radix-ui/react-tabs'],
        },
      },
    },
  },
});
