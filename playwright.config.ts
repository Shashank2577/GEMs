import { defineConfig, devices } from '@playwright/test';

/**
 * E2E + QA evidence harness. Real Postgres (scripts/local-pg.sh), real API (apps/api/src/node.ts) serving the
 * built SPA, and tools/mock-gem standing in for GeM BidPlus. Every test records video, trace and screenshots;
 * QA copies the per-story artifacts into qa/evidence/<spec>/<story>/ (see e2e/support/evidence.ts).
 */
const E2E_PORT = Number(process.env.E2E_PORT || 8788);
const GEM_PORT = Number(process.env.E2E_GEM_PORT || 4011);
export const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.e2e\.ts/,
  outputDir: 'qa/.runs/artifacts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'qa/.runs/report', open: 'never' }],
    ['json', { outputFile: 'qa/.runs/results.json' }],
  ],
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'on',
    video: 'on',
    screenshot: 'on',
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: [
    {
      command: `PORT=${GEM_PORT} pnpm --filter @tp/mock-gem start`,
      url: `http://127.0.0.1:${GEM_PORT}/all-bids`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'e2e/support/start-api.sh',
      url: `http://localhost:${E2E_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
