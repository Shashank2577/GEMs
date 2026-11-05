import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for repo tooling in scripts/ (CI helpers). Run with `pnpm test:scripts`.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['scripts/**/*.test.ts'],
    environment: 'node',
  },
});
