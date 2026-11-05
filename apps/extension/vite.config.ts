/**
 * Two builds into dist/ (MV3 content scripts cannot be ES modules):
 *   vite build                 → popup.html + popup bundle + public/ (manifest, icons)
 *   TARGET=content vite build  → content.js as a single IIFE
 */
import { defineConfig, type UserConfig } from 'vite';

const content: UserConfig = {
  publicDir: false,
  build: {
    outDir: 'dist', emptyOutDir: false, sourcemap: false, minify: true,
    lib: { entry: 'src/content.ts', formats: ['iife'], name: 'TenderPilotContent', fileName: () => 'content.js' },
  },
};

const popup: UserConfig = {
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: { popup: 'popup.html' } } },
};

export default defineConfig(process.env.TARGET === 'content' ? content : popup);
