import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Server environment a spec declares in its header (`@e2e-env KEY=value KEY2=value2`). scripts/e2e-ci.sh applies it for CI;
 * this applies it when the spec is run directly (`pnpm exec playwright test e2e/<NNN>/US<n>*`, the QA/playbook command).
 * The command-line filters are matched the way Playwright matches them (regex over the absolute path; a trailing
 * `:line[:col]` and option values such as `--grep x` are not filters), and the header is applied only when it is
 * unambiguous: the selected spec files that declare `@e2e-env` must not disagree on a key (otherwise nothing is applied and
 * one warning names the key and files, since e.g. US4 and US7 each serve their fake LLM on a different port).
 * Merge is per key: a variable already in the environment wins (CI exports every key first, so nothing changes there; a
 * hand-set value overrides only that key). Specs read their fake-LLM port from `E2E_LLM_PORT`, but the header hard-codes
 * :4114/:4115/:4119, so overriding E2E_LLM_PORT alone also needs a matching LLM_BASE_URL. `E2E_DEBUG=1` logs the scan.
 * Without this, 008/US4 ran against a server with no fake LLM and the 60 MB packet default, and sc7/sc7b/sc10b failed
 * although no product limit had regressed (GEM-359).
 */
const VALUE_OPTIONS = new Set([
  '-c', '--config', '-g', '--grep', '--grep-invert', '-j', '--workers', '--project', '--reporter', '--shard', '--retries',
  '--timeout', '--repeat-each', '--max-failures', '--output', '--trace', '--tsconfig', '--global-timeout', '--browser',
  '--ui-host', '--ui-port',
]);

/** Pure: the file filters of a `playwright test …` command line (positional args, minus option values and `:line[:col]`). */
export function fileFilters(args: string[]): string[] {
  const out: string[] = [];
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!positional && a === '--') { positional = true; continue; }
    if (!positional && a.startsWith('-')) { if (VALUE_OPTIONS.has(a)) i++; continue; }
    if (a === 'test' && out.length === 0 && i === 0) continue;
    out.push(a.replace(/:\d+(?::\d+)?$/, ''));
  }
  return out.filter(Boolean);
}

function specServerEnv(): Record<string, string> {
  const debug = (m: string) => { if (process.env.E2E_DEBUG) console.error(`[playwright.config] ${m}`); };
  const filters = fileFilters(process.argv.slice(2));
  if (filters.length === 0) return {};
  const root = dirname(fileURLToPath(import.meta.url));
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.e2e.ts') ? [join(d, e.name)] : []));
  const matchers = filters.map((f) => {
    const pat = /^\.{1,2}\//.test(f) ? resolve(f) : f;
    try { return new RegExp(pat, 'i'); } catch { return new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  });
  const declared = new Map<string, Record<string, string>>(); // selected spec file -> its header vars
  try {
    for (const f of walk(join(root, 'e2e')).filter((f) => matchers.some((m) => m.test(f.split(sep).join('/'))))) {
      const vars: Record<string, string> = {};
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /@e2e-env\s+(.*)$/.exec(line);
        if (!m) continue;
        for (const kv of m[1].trim().split(/\s+/)) {
          const i = kv.indexOf('=');
          if (i > 0) vars[kv.slice(0, i)] = kv.slice(i + 1);
        }
      }
      if (Object.keys(vars).length) declared.set(relative(root, f), vars);
    }
  } catch (e) { debug(`header scan failed: ${e instanceof Error ? e.message : String(e)}`); return {}; }
  const out: Record<string, string> = {};
  for (const [file, vars] of declared) {
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] !== undefined) continue;
      if (k in out && out[k] !== v) {
        const files = [...declared].filter(([, o]) => k in o).map(([n]) => n).join(', ');
        console.warn(`[playwright.config] @e2e-env ${k} differs between ${files}; applying no spec environment (run one spec per command)`);
        return {};
      }
      out[k] = v;
    }
    debug(`@e2e-env from ${file}`);
  }
  debug(`applying: ${Object.keys(out).join(' ') || 'nothing'}`);
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
