import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Server environment a spec declares in its header (`@e2e-env KEY=value KEY2=value2`). scripts/e2e-ci.sh applies it for CI;
 * this applies it when the spec is run directly (`pnpm exec playwright test e2e/<NNN>/US<n>*`, the QA/playbook command), by
 * collecting the header line of every spec file the command-line filters select. Variables already in the environment win,
 * so CI (which exports them) and manual overrides behave as before. Without it, 008/US4 ran against a server with no fake LLM
 * and the 60 MB packet default, and sc7/sc7b/sc10b failed although no product limit had regressed (GEM-359).
 */
function specServerEnv(): Record<string, string> {
  const filters = process.argv.slice(2).filter((a) => !a.startsWith('-') && a !== 'test');
  if (filters.length === 0) return {};
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.e2e.ts') ? [join(d, e.name)] : []));
  const out: Record<string, string> = {};
  try {
    for (const f of walk('e2e').filter((f) => filters.some((x) => f.includes(x.replace(/^\.\//, ''))))) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /@e2e-env\s+(.*)$/.exec(line);
        if (!m) continue;
        for (const kv of m[1].trim().split(/\s+/)) {
          const i = kv.indexOf('=');
          if (i > 0 && process.env[kv.slice(0, i)] === undefined) out[kv.slice(0, i)] = kv.slice(i + 1);
        }
      }
    }
  } catch { /* header scan is best-effort */ }
  return out;
}
// Exported to process.env so the API webServer and the test workers (a spec may read e.g. ADMIN_TOKEN) both see them.
for (const [k, v] of Object.entries(specServerEnv())) process.env[k] = v;

/**
 * E2E + QA evidence harness. Real Postgres (scripts/local-pg.sh), real API (apps/api/src/node.ts) serving the
 * built SPA, and tools/mock-gem standing in for GeM BidPlus. Every test records video, trace and screenshots;
 * QA copies the per-story artifacts into qa/evidence/<spec>/<story>/ (see e2e/support/evidence.ts).
 */
const E2E_PORT = Number(process.env.E2E_PORT || 8788);
const GEM_PORT = Number(process.env.E2E_GEM_PORT || 4011);
export const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

// CI shards (scripts/e2e-ci.sh) run one file per invocation: E2E_RUN_TAG keeps each run's traces/videos in their own
// folder (Playwright empties outputDir at start), E2E_BLOB_DIR swaps the html/json reporters for a blob report that the
// `e2e` job merges into qa/.runs/<port>/results.json + report/.
const RUN_TAG = process.env.E2E_RUN_TAG;
const BLOB_DIR = process.env.E2E_BLOB_DIR;

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.e2e\.ts/,
  outputDir: `qa/.runs/${E2E_PORT}/artifacts` + (RUN_TAG ? `/${RUN_TAG}` : ''),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: BLOB_DIR
    ? [['list'], ['blob', { outputDir: BLOB_DIR }]]
    : [
      ['list'],
      ['html', { outputFolder: `qa/.runs/${E2E_PORT}/report`, open: 'never' }],
      ['json', { outputFile: `qa/.runs/${E2E_PORT}/results.json` }],
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
      // E2E_TEST_HOOKS=1 mounts GET /api/__test/mail; with reuseExistingServer a locally running API started without it is reused and that route 404s.
      command: 'E2E_TEST_HOOKS=1 e2e/support/start-api.sh',
      url: `http://localhost:${E2E_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
