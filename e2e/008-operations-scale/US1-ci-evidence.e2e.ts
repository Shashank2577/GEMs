/**
 * QA for spec 008 US1 (#356): "Every change is proven by CI with QA evidence before it can merge".
 *
 * Proves, from outside the author's frame:
 *  - the evidence helpers (evidence008 / saveTranscript / collectRunArtifacts) write png + txt + webm into qa/evidence/008/US1/
 *  - scripts/e2e-summary.ts parses a Playwright results.json (committed fixture AND a real nested flaky run, scenario 5)
 *  - the structure of .github/workflows/ci.yml + dod.yml matches scenarios 1, 2, 4, 7
 *  - real CI data captured through the GitHub API (us1-ci-capture.json: green run, artifact listing, red `dod`,
 *    red-api probe PR) is rendered to HTML and screenshotted (GitHub UI pages need a login, so they are not used).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, evidence008, saveTranscript, collectRunArtifacts } from '../support/fixtures';
import { summarize, formatSummary, type PwReport } from '../../scripts/e2e-summary';

const STORY = 'US1';
const EVIDENCE_DIR = join('qa', 'evidence', '008', STORY);
const ROOT = process.cwd();

interface CapturedJob { name: string; conclusion: string | null; started?: string; completed?: string; steps?: { name: string; conclusion: string | null }[] }
interface Capture {
  green: { runId: number; sha: string; url: string; startedAt: string; completedAt: string; jobs: CapturedJob[] };
  apiLog: string;
  e2eLog: string;
  uploadLog: string;
  artifacts: { id: number; name: string; size_in_bytes: number; expired: boolean; created_at: string; expires_at: string }[];
  dodLog: string;
  round2?: { runId: number; sha: string; url: string; jobs: CapturedJob[] };
  probe?: { pr: number; runId: number; url: string; sha: string; jobs: CapturedJob[]; apiLog: string; ciGateLog: string };
}
const capture: Capture = JSON.parse(readFileSync(join('e2e', '008-operations-scale', 'us1-ci-capture.json'), 'utf8'));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const CSS = `
  body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#1f2328;background:#fff;width:1100px}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:18px 0 6px} .sub{color:#57606a;margin-bottom:14px}
  table{border-collapse:collapse;width:100%} th,td{border:1px solid #d0d7de;padding:5px 9px;text-align:left;vertical-align:top}
  th{background:#f6f8fa} .ok{color:#1a7f37;font-weight:600} .bad{color:#cf222e;font-weight:600} .skip{color:#6e7781;font-weight:600}
  pre{background:#0d1117;color:#e6edf3;padding:12px;border-radius:6px;white-space:pre-wrap;font:12px/1.4 ui-monospace,Menlo,monospace}
  .red{color:#ff7b72} .green{color:#7ee787}`;
async function render(page: import('@playwright/test').Page, title: string, sub: string, body: string) {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${CSS}</style><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div>${body}`);
}
const cls = (c: string | null) => (c === 'success' ? 'ok' : c === 'failure' || c === 'cancelled' ? 'bad' : 'skip');
const dur = (a?: string, b?: string) => (a && b ? `${Math.round((Date.parse(b) - Date.parse(a)) / 1000)}s` : '');
const colourLog = (s: string) =>
  esc(s).split('\n').map((l) => (/FAIL|failed|##\[error\]|AssertionError|✗|×|FAILED/.test(l) ? `<span class="red">${l}</span>` : /passed|PASS|✓|success/.test(l) ? `<span class="green">${l}</span>` : l)).join('\n');

// ---------- workflow YAML structure (no yaml dependency in the repo: indentation-based reader) ----------
interface JobDef { name: string; needs: string[]; timeout?: number; runsOn?: string; ifExpr?: string; block: string }
function readJobs(file: string): Record<string, JobDef> {
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l === 'jobs:');
  const jobs: Record<string, JobDef> = {};
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (!cur) return;
    const block = buf.join('\n');
    const needsLine = block.match(/^ {4}needs:\s*(.+)$/m);
    const needs = needsLine ? needsLine[1].replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean) : [];
    jobs[cur] = {
      name: cur,
      needs,
      timeout: Number(block.match(/^ {4}timeout-minutes:\s*(\d+)/m)?.[1]) || undefined,
      runsOn: block.match(/^ {4}runs-on:\s*(\S+)/m)?.[1] ?? (/^ {4}uses:\s*(\S+)/m.test(block) ? 'reusable workflow' : undefined),
      ifExpr: block.match(/^ {4}if:\s*(.+)$/m)?.[1],
      block,
    };
  };
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (m) { flush(); cur = m[1]; buf = []; } else buf.push(l);
  }
  flush();
  return jobs;
}
const ci = readJobs('.github/workflows/ci.yml');
const dodJobs = readJobs('.github/workflows/dod.yml');

test.describe.serial('008/US1 CI gate evidence', () => {
  test.afterEach(async ({ page }) => { await collectRunArtifacts('008', STORY, page); });

  // ---- Scenario 1 ----
  test('S1 ci workflow jobs, dependency order, runner, Node 22, frozen lockfile, timeouts', async ({ page }) => {
    const ciText = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ciText).toMatch(/pull_request:\s*\n\s+branches: \[main\]/);
    expect(ciText).toMatch(/NODE_VERSION: '22'/);

    const timeouts: Record<string, number> = { typecheck: 10, unit: 10, api: 15, e2e: 30 };
    for (const [job, t] of Object.entries(timeouts)) {
      expect(ci[job], `job ${job} exists`).toBeTruthy();
      expect(ci[job].timeout, `${job} timeout-minutes`).toBe(t);
    }
    // The `deploy` job (round 2) is a caller of a reusable workflow and has no runs-on of its own.
    for (const j of Object.values(ci).filter((x) => x.name !== 'deploy')) expect(j.runsOn, `${j.name} runs-on`).toBe('ubuntu-latest');
    // typecheck and unit are parallel (neither needs the other); api after unit; e2e after api.
    expect(ci.typecheck.needs).toEqual([]);
    expect(ci.unit.needs).not.toContain('typecheck');
    expect(ci.api.needs).toContain('unit');
    expect(ci.e2e.needs).toContain('api');
    // every job that installs does so with --frozen-lockfile and Node from NODE_VERSION
    for (const j of ['typecheck', 'unit', 'api', 'e2e']) {
      expect(ci[j].block, `${j} pnpm install --frozen-lockfile`).toContain('pnpm install --frozen-lockfile');
      expect(ci[j].block, `${j} setup-node`).toContain('node-version: ${{ env.NODE_VERSION }}');
    }

    const rows = Object.values(ci).map((j) => `<tr><td><b>${j.name}</b></td><td>${j.needs.join(', ') || '-'}</td><td>${j.timeout ?? '-'} min</td><td>${j.runsOn}</td><td><code>${esc(j.ifExpr ?? '')}</code></td></tr>`).join('');
    await render(page, 'ci.yml jobs (parsed from .github/workflows/ci.yml)', 'Scenario 1: dependency order, runner, timeouts. Node 22 via env.NODE_VERSION; pnpm install --frozen-lockfile in typecheck/unit/api/e2e.',
      `<table><tr><th>job</th><th>needs</th><th>timeout</th><th>runs-on</th><th>if</th></tr>${rows}</table>`);
    await evidence008(page, STORY, 'S1-ci-jobs-needs-timeouts');
    saveTranscript(STORY, 'S1-ci-jobs', Object.values(ci).map(({ block: _b, ...rest }) => rest));

    // Live confirmation from the real run: the jobs ran in this order.
    const byName = Object.fromEntries(capture.green.jobs.map((j) => [j.name, j]));
    for (const n of ['typecheck', 'unit', 'api', 'e2e']) expect(byName[n]?.conclusion, `${n} in run ${capture.green.runId}`).toBe('success');
    expect(Date.parse(byName.api.started!)).toBeGreaterThanOrEqual(Date.parse(byName.unit.completed!));
    expect(Date.parse(byName.e2e.started!)).toBeGreaterThanOrEqual(Date.parse(byName.api.completed!));
    expect(Math.abs(Date.parse(byName.typecheck.started!) - Date.parse(byName.unit.started!))).toBeLessThan(15_000);
  });

  // ---- Scenario 2 ----
  test('S2 api job: postgres:16 tp/tp on 5433, TEST_DATABASE_URL, >=145 tests passed in the real log', async ({ page }) => {
    const api = ci.api.block;
    expect(api).toContain('image: postgres:16');
    expect(api).toContain('POSTGRES_USER: tp');
    expect(api).toContain('POSTGRES_PASSWORD: tp');
    expect(api).toMatch(/- 5433:5432/);
    expect(api).toContain('TEST_DATABASE_URL: postgres://tp:tp@localhost:5433/tenderpilot_test');
    expect(capture.apiLog).toMatch(/Test Files\s+\d+ passed/);
    const tests = Number(capture.apiLog.match(/Tests\s+(\d+) passed/)?.[1]);
    expect(tests).toBeGreaterThanOrEqual(145);
    expect(capture.apiLog).not.toMatch(/\d+ failed/);
    saveTranscript(STORY, 'S2-api-job-log-run-green', capture.apiLog);
    await render(page, `api job log, run ${capture.green.runId}`, 'Scenario 2: postgres:16 service on :5433, TEST_DATABASE_URL set, Test Files / Tests lines', `<pre>${colourLog(capture.apiLog)}</pre>`);
    await evidence008(page, STORY, 'S2-api-log-150-passed');
  });

  // ---- Scenario 3 ----
  test('S3 PR with a failing API test: api red, e2e skipped, ci-gate red (live probe PR)', async ({ page }) => {
    test.skip(!capture.probe, 'probe not captured');
    const p = capture.probe!;
    const by = Object.fromEntries(p.jobs.map((j) => [j.name, j]));
    expect(by.api.conclusion).toBe('failure');
    expect(by.e2e.conclusion).toBe('skipped');
    expect(by['ci-gate'].conclusion).toBe('failure');
    expect(p.apiLog).toMatch(/failed/);
    saveTranscript(STORY, 'S3-probe-api-job-log-red', p.apiLog);
    saveTranscript(STORY, 'S3-probe-ci-gate-log', p.ciGateLog);
    saveTranscript(STORY, 'S3-probe-jobs', p.jobs);
    const rows = p.jobs.map((j) => `<tr><td><b>${j.name}</b></td><td class="${cls(j.conclusion)}">${j.conclusion}</td><td>${dur(j.started, j.completed)}</td></tr>`).join('');
    await render(page, `Probe PR #${p.pr} (draft, closed after capture): workflow ci run ${p.runId}`,
      'Scenario 3: one deliberately wrong assertion in apps/api/test/foundation.test.ts. api is red, e2e is skipped, ci-gate (the aggregator) is red.',
      `<table><tr><th>job</th><th>conclusion</th><th>duration</th></tr>${rows}</table><h2>api job log (tail)</h2><pre>${colourLog(p.apiLog)}</pre><h2>ci-gate log</h2><pre>${colourLog(p.ciGateLog)}</pre>`);
    await evidence008(page, STORY, 'S3-red-api-e2e-skipped');
  });

  test('S3b merge blocking is documented, not verifiable from this session', async ({ page }) => {
    const rb = readFileSync('docs/runbook.md', 'utf8');
    expect(rb).toContain('Required statuses must pass before merging');
    expect(rb).toContain('"contexts": ["typecheck", "unit", "api", "e2e", "migrations-additive", "dod", "ci-gate"]');
    expect(ci['ci-gate'].ifExpr).toBe('always()');
    const probe = spawnSync('gh', ['api', 'repos/Shashank2577/GEMs/branches/main/protection'], { encoding: 'utf8' });
    const out = `exit=${probe.status}\n${probe.stdout}${probe.stderr}`;
    saveTranscript(STORY, 'S3b-branch-protection-probe', `$ gh api repos/Shashank2577/GEMs/branches/main/protection\n${out}\n(403: this session has no admin scope, so branch protection can be neither read nor applied; the setting is documented in docs/runbook.md § CI)`);
    await render(page, 'Branch protection on main: documented, not observable', 'Scenario 3, last clause. Runbook text vs the API answer from this session.',
      `<h2>docs/runbook.md § Branch protection</h2><pre>${esc(rb.slice(rb.indexOf('### Branch protection'), rb.indexOf('### Branch protection') + 600))}</pre><h2>gh api .../branches/main/protection</h2><pre>${colourLog(out)}</pre>`);
    await evidence008(page, STORY, 'S3b-branch-protection-unverifiable');
  });

  // ---- Scenario 4 ----
  test('S4 e2e artifact e2e-evidence-<run_id> (qa/evidence/** + qa/.runs/**, 30 days) and summary step', async ({ page }) => {
    const e2e = ci.e2e.block;
    expect(e2e).toContain('name: e2e-evidence-${{ github.run_id }}');
    expect(e2e).toContain('qa/evidence/**');
    expect(e2e).toContain('qa/.runs/**');
    expect(e2e).toContain('retention-days: 30');
    expect(e2e).toMatch(/- name: Upload QA evidence\n\s+if: always\(\)/);
    expect(e2e).toMatch(/E2E job summary[^\n]*\n\s+if: always\(\)\n\s+run: pnpm exec tsx scripts\/e2e-summary\.ts qa\/\.runs\/8788\/results\.json/);
    const pw = readFileSync('playwright.config.ts', 'utf8');
    expect(pw).toContain("['json', { outputFile: `qa/.runs/${E2E_PORT}/results.json` }]");
    expect(pw).toContain("['html', { outputFolder: `qa/.runs/${E2E_PORT}/report`");
    expect(pw).toContain("trace: 'on'");
    expect(pw).toContain("video: 'on'");

    const art = capture.artifacts.find((a) => a.name === `e2e-evidence-${capture.green.runId}`);
    expect(art, 'artifact named e2e-evidence-<run_id> exists on the green run').toBeTruthy();
    expect(art!.expired).toBe(false);
    const days = (Date.parse(art!.expires_at) - Date.parse(art!.created_at)) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    expect(capture.uploadLog).toMatch(/there will be \d+ files uploaded/);
    saveTranscript(STORY, 'S4-artifact-listing', capture.artifacts);
    saveTranscript(STORY, 'S4-e2e-job-log-excerpt', `${capture.e2eLog}\n\n--- upload step ---\n${capture.uploadLog}`);
    const rows = capture.artifacts.map((a) => `<tr><td>${a.id}</td><td><b>${a.name}</b></td><td>${(a.size_in_bytes / 1048576).toFixed(1)} MiB</td><td>${a.created_at}</td><td>${a.expires_at}</td><td>${Math.round((Date.parse(a.expires_at) - Date.parse(a.created_at)) / 86_400_000)} days</td><td>${a.expired ? 'expired' : 'available'}</td></tr>`).join('');
    await render(page, `Artifacts of ci run ${capture.green.runId}`, 'Scenario 4: artifact name, size, retention (created_at to expires_at) from the GitHub API; upload step log below.',
      `<table><tr><th>id</th><th>name</th><th>size</th><th>created</th><th>expires</th><th>retention</th><th>state</th></tr>${rows}</table><h2>e2e job: Playwright result + upload step</h2><pre>${colourLog(`${capture.e2eLog}\n...\n${capture.uploadLog}`)}</pre>`);
    await evidence008(page, STORY, 'S4-artifact-listing');
  });

  test('S4 e2e-summary parses a results.json (fixture) and the job summary lists passed/failed/flaky', async ({ page }) => {
    const fixture = JSON.parse(readFileSync('scripts/fixtures/e2e-results.json', 'utf8')) as PwReport;
    const s = summarize(fixture);
    expect(s).toMatchObject({ total: 5, passed: 2, failed: 1, flaky: 1, skipped: 1 });
    const md = formatSummary(s, 'scripts/fixtures/e2e-results.json');
    expect(md).toContain('flaky: 1');
    // And the CLI itself, as CI invokes it.
    const cli = execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e-summary.ts', 'scripts/fixtures/e2e-results.json'], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
    expect(cli).toContain('total: 5 · passed: 2 · failed: 1 · flaky: 1 · skipped: 1');
    saveTranscript(STORY, 'S4-e2e-summary-cli-output', `$ pnpm exec tsx scripts/e2e-summary.ts scripts/fixtures/e2e-results.json\n${cli}`);
    await render(page, 'scripts/e2e-summary.ts on a Playwright results.json', 'Scenario 4: the job summary lists passed / failed / flaky.', `<pre>${esc(cli)}</pre>`);
    await evidence008(page, STORY, 'S4-e2e-summary-output');
  });

  // ---- Scenario 5 ----
  test('S5 a test that fails then passes on retry is "flaky: 1" and the failed attempt trace is kept', async ({ page }) => {
    const dir = join('qa', '.runs', 'us1-flaky-probe');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'flaky.probe.ts'), `import { test, expect } from '@playwright/test';
test('fails on the first attempt, passes on retry', async ({ page }) => {
  await page.setContent('<h1>probe</h1>');
  expect(test.info().retry, 'first attempt fails on purpose').toBeGreaterThan(0);
});
`);
    writeFileSync(join(dir, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: /flaky\\.probe\\.ts/, retries: 1, workers: 1,
  outputDir: './artifacts',
  reporter: [['json', { outputFile: './results.json' }]],
  use: { trace: 'on', video: 'on' },
});
`);
    const run = spawnSync('pnpm', ['exec', 'playwright', 'test', '-c', join(dir, 'playwright.config.ts')], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, CI: '1', PW_TEST_HTML_REPORT_OPEN: 'never' } });
    expect(existsSync(join(dir, 'results.json')), `nested run produced results.json\n${run.stdout}\n${run.stderr}`).toBe(true);
    const summaryOut = execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e-summary.ts', join(dir, 'results.json')], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
    expect(summaryOut).toContain('flaky: 1');
    expect(summaryOut).toContain('failed: 0');
    const traces: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.zip')) traces.push(p); } };
    walk(join(dir, 'artifacts'));
    const retryTrace = traces.filter((t) => /-retry1\//.test(t));
    const firstAttemptTrace = traces.filter((t) => !/-retry1\//.test(t));
    expect(firstAttemptTrace.length, `trace of the FAILED first attempt kept in outputDir: ${traces.join(', ')}`).toBeGreaterThanOrEqual(1);
    expect(retryTrace.length).toBeGreaterThanOrEqual(1);
    // outputDir of the real config sits under qa/.runs, which the upload step includes.
    expect(readFileSync('playwright.config.ts', 'utf8')).toContain('outputDir: `qa/.runs/${E2E_PORT}/artifacts`');
    const listing = `$ pnpm exec tsx scripts/e2e-summary.ts qa/.runs/us1-flaky-probe/results.json\n${summaryOut}\n\ntrace files kept under outputDir (retries: 1, trace: 'on'):\n${traces.map((t) => `  ${t}`).join('\n')}\n`;
    saveTranscript(STORY, 'S5-flaky-probe', listing);
    await render(page, 'Flaky probe: fails attempt 0, passes attempt 1', 'Scenario 5: summary reports flaky: 1 and both the failed attempt and the retry have a trace.zip in outputDir (uploaded via qa/.runs/**).', `<pre>${colourLog(listing)}</pre>`);
    await evidence008(page, STORY, 'S5-flaky-1-with-failed-attempt-trace');
  });

  // ---- Scenario 6 ----
  test('S6 dod: the real red check on this PR (Missing QA verdict) and the rule names', async ({ page }) => {
    expect(capture.dodLog).toContain('Missing QA verdict: qa/evidence/008/US1/VERDICT.md');
    expect(capture.dodLog).toContain('Definition of Done: FAILED');
    const src = readFileSync('scripts/dod-check.ts', 'utf8');
    expect(src).toContain('Missing QA verdict');
    expect(src).toContain('QA verdict is not approved');
    expect(src).toContain('not met');
    expect(dodJobs.dod.ifExpr).toBe('always()');
    saveTranscript(STORY, 'S6-dod-red-check-log', capture.dodLog);
    await render(page, 'dod check on this PR before the verdict existed (red)', 'Scenario 6: fails with "Missing QA verdict: qa/evidence/008/US1/VERDICT.md". The "not approved" and "not met" branches are covered by scripts/dod-check.test.ts (run separately, see S6 transcript).', `<pre>${colourLog(capture.dodLog)}</pre>`);
    await evidence008(page, STORY, 'S6-dod-red-missing-verdict');
  });

  test('S6 repo tooling tests: dod-check / docs-only / e2e-summary / check-migrations', async ({ page }) => {
    const r = spawnSync('pnpm', ['test:scripts', '--reporter=verbose'], { encoding: 'utf8', cwd: ROOT });
    const text = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    expect(r.status, text).toBe(0);
    for (const n of ['fails with "Missing QA verdict', 'fails with "QA verdict is not approved"', 'fails when any criterion row is "not met"', 'reports a test that failed then passed on retry as flaky']) expect(text).toContain(n);
    saveTranscript(STORY, 'S6-scripts-tests', text);
    const picked = text.split('\n').filter((l) => /✓|Test Files|Tests /.test(l) && /Missing QA|not approved|not met|flaky|docs-only|Test Files|Tests |docs\/\*\*|moved into docs/.test(l)).join('\n');
    await render(page, 'pnpm test:scripts (vitest, verbose; selected rows)', 'Scenarios 5, 6, 7 logic as unit tests.', `<pre>${colourLog(picked)}</pre>`);
    await evidence008(page, STORY, 'S6-scripts-tests-selected');
  });

  // ---- Scenario 7 ----
  test('S7 docs-only PR: path filter result and which jobs are gated', async ({ page }) => {
    const docsOnly = (paths: string[]) => execFileSync('scripts/docs-only.sh', { input: paths.join('\n'), encoding: 'utf8' }).trim();
    const cases: [string, string[], string][] = [
      ['specs + docs + md', ['specs/008-operations-scale/spec.md', 'docs/runbook.md', 'README.md'], 'true'],
      ['code change', ['docs/runbook.md', 'apps/api/src/app.ts'], 'false'],
      ['md under qa/evidence counts as code', ['qa/evidence/008/US1/VERDICT.md'], 'false'],
      ['code moved into docs/ (old path listed, --no-renames)', ['docs/x.ts', 'apps/api/src/x.ts'], 'false'],
      ['empty list', [], 'false'],
    ];
    const results = cases.map(([label, paths, want]) => ({ label, paths, want, got: docsOnly(paths) }));
    for (const r of results) expect(r.got, r.label).toBe(r.want);
    // typecheck always runs; unit/migrations are gated by changes.code; api/e2e by needs chain; ci-gate treats skipped as ok
    expect(ci.typecheck.needs).toEqual([]);
    expect(ci.typecheck.ifExpr).toBeUndefined();
    expect(ci.unit.ifExpr).toBe("needs.changes.outputs.code == 'true'");
    expect(ci['migrations-additive'].ifExpr).toBe("needs.changes.outputs.code == 'true'");
    expect(ci.api.needs).toEqual(['unit']);
    // e2e runs as e2e-shard ×N after api, then the `e2e` merge job (skipped unless api passed)
    expect(ci['e2e-shard'].needs).toEqual(['api']);
    expect(ci.e2e.needs).toEqual(['api', 'e2e-shard']);
    expect(ci.e2e.ifExpr).toContain("needs.api.result == 'success'");
    expect(ci['ci-gate'].block).toContain("grep -Eq '\"(failure|cancelled)\"'");
    expect(dodJobs.dod.block).toContain('Docs-only PR: Definition-of-Done check skipped.');
    expect(dodJobs.dod.block).toContain("steps.gate.outputs.run == 'true'");
    const g = Object.fromEntries(capture.green.jobs.map((j) => [j.name, j]));
    const typecheckSeconds = (Date.parse(g.typecheck.completed!) - Date.parse(g.changes.started!)) / 1000;
    expect(typecheckSeconds, 'changes + typecheck wall time in the green run').toBeLessThan(300);
    saveTranscript(STORY, 'S7-docs-only-cases', results);
    const rows = results.map((r) => `<tr><td>${esc(r.label)}</td><td><code>${esc(r.paths.join(' '))}</code></td><td>${r.got}</td></tr>`).join('');
    await render(page, 'Docs-only path filter (scripts/docs-only.sh) and job gating', `Scenario 7. In the green run changes + typecheck took ${typecheckSeconds.toFixed(0)}s (limit 5 min). Live docs-only PR NOT run (inferred from logic + unit tests).`,
      `<table><tr><th>case</th><th>changed paths</th><th>docs-only?</th></tr>${rows}</table><h2>gating</h2><ul><li>typecheck: no needs, no if (always runs)</li><li>unit, migrations-additive: if needs.changes.outputs.code == 'true'</li><li>api needs unit, e2e needs api (skipped when their dependency is skipped)</li><li>ci-gate: if always(); only failure/cancelled fail it</li><li>dod: always runs, prints "Docs-only PR: Definition-of-Done check skipped." and skips all steps</li></ul>`);
    await evidence008(page, STORY, 'S7-docs-only-filter');
  });

  // ---- CI step summaries / job list from the real green run ----
  test('Green PR run: job list with durations and step summaries (real data, run via API)', async ({ page }) => {
    saveTranscript(STORY, 'S1-green-run-jobs', capture.green);
    const rows = capture.green.jobs.map((j) => `<tr><td><b>${j.name}</b></td><td class="${cls(j.conclusion)}">${j.conclusion}</td><td>${dur(j.started, j.completed)}</td><td>${(j.steps ?? []).map((s) => `<span class="${cls(s.conclusion)}">${s.conclusion === 'success' ? '✓' : s.conclusion}</span> ${esc(s.name)}`).join('<br>')}</td></tr>`).join('');
    await render(page, `ci run ${capture.green.runId} on ${capture.green.sha.slice(0, 7)} (PR #475)`, `${capture.green.url} · started ${capture.green.startedAt}, finished ${capture.green.completedAt}`,
      `<table><tr><th>job</th><th>result</th><th>time</th><th>key steps</th></tr>${rows}</table>`);
    await evidence008(page, STORY, 'S1-green-run-jobs-and-steps');
  });

  // ---- Scenario 8 ----
  test('S8 push to main: deploy needs ci-gate success (structure); skipped on the PR run (live)', async ({ page }) => {
    const ciText = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ciText).toMatch(/push:\s*\n\s+branches: \[main\]/);
    expect(ciText).not.toMatch(/^\s*workflow_run:/m);
    const d = ci.deploy;
    expect(d, 'ci.yml has a deploy job').toBeTruthy();
    expect(d.needs).toEqual(['ci-gate']);
    expect(d.ifExpr).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.ci-gate.result == 'success'");
    expect(d.block).toContain('uses: ./.github/workflows/deploy.yml');
    // a red ci can never reach deploy: ci-gate fails on any failure/cancelled and deploy requires ci-gate == success
    expect(ci['ci-gate'].needs).not.toContain('deploy');
    const dep = readFileSync('.github/workflows/deploy.yml', 'utf8');
    expect(dep).toMatch(/workflow_call:/);
    expect(dep).not.toMatch(/^\s*workflow_run:/m);
    expect(dep).toContain('T036');
    let live = '';
    if (capture.round2) {
      const by = Object.fromEntries(capture.round2.jobs.map((j) => [j.name, j]));
      expect(by.deploy.conclusion, 'deploy is skipped on a pull_request run').toBe('skipped');
      live = `live pull_request run ${capture.round2.runId} (${capture.round2.sha.slice(0, 7)}): ${capture.round2.jobs.map((j) => `${j.name}=${j.conclusion}`).join(', ')}`;
    }
    const info = `ci.yml deploy job: needs ci-gate; if ${d.ifExpr}; uses ./.github/workflows/deploy.yml (placeholder until US2 T036)\nci-gate does not need deploy\nno workflow_run anywhere (default branch is not main)\n${live}\nNOT observable here: a real push to main (QA never pushes to main); positive path is structural + scripts/workflows.test.ts.`;
    saveTranscript(STORY, 'S8-deploy-handoff', info);
    await render(page, 'Scenario 8: push to main -> deploy only after ci-gate succeeds', 'Round 2: ci.yml deploy job calling reusable deploy.yml', `<pre>${esc(info)}</pre>`);
    await evidence008(page, STORY, 'S8-deploy-handoff-state');
  });

  // ---- evidence helper contract (last: needs the earlier tests' videos) ----
  test('evidence helpers wrote png, webm and txt into qa/evidence/008/US1/', async ({ page }) => {
    await page.setContent('<h1>helper probe</h1>');
    const png = await evidence008(page, STORY, 'helper-probe');
    const txt = saveTranscript(STORY, 'helper-probe', 'plain text transcript');
    const json = saveTranscript(STORY, 'helper-probe-json', { ok: true });
    expect(png.endsWith('.png') && existsSync(png)).toBe(true);
    expect(txt.endsWith('.txt') && existsSync(txt)).toBe(true);
    expect(json.endsWith('.json') && existsSync(json)).toBe(true);
    const files = readdirSync(EVIDENCE_DIR);
    expect(files.filter((f) => f.endsWith('.png')).length).toBeGreaterThanOrEqual(8);
    expect(files.some((f) => f.endsWith('.txt'))).toBe(true);
    // webm files are copied by collectRunArtifacts in afterEach, i.e. for every test that ran before this one.
    const webm = files.filter((f) => f.endsWith('.webm'));
    expect(webm.length, `webm in ${files.join(', ')}`).toBeGreaterThanOrEqual(5);
  });
});
