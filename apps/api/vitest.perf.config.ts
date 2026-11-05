import { defineConfig } from 'vitest/config';

// Opt-in performance checks (`pnpm --filter @tp/api run test:perf`); the default config only includes `*.test.ts`,
// so `*.perf.ts` files never run in CI.
export default defineConfig({
  test: {
    include: ['test/perf/**/*.perf.ts'],
    environment: 'node',
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 300_000,
    env: {
      NODE_ENV: 'test',
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://tp:tp@localhost:5433/tenderpilot_test',
    },
  },
});
