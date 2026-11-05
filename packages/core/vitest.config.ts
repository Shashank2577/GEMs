import { defineConfig } from 'vitest/config';

// Shared by every core module: pure unit tests, no database.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
