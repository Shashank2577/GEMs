import { defineConfig } from 'vitest/config';

// Unit tests for repo tooling in scripts/ (CI helpers). Run with `pnpm test:scripts`.
export default defineConfig({
  test: {
    root: new URL('..', import.meta.url).pathname,
    include: ['scripts/**/*.test.ts'],
    environment: 'node',
  },
});
