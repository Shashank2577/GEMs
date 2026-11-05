/**
 * Writes a Markdown summary of a Playwright JSON report (total / passed / failed / flaky / skipped + failed titles)
 * to $GITHUB_STEP_SUMMARY, or stdout when that is unset. Spec 008 FR-002.
 *
 *   pnpm exec tsx scripts/e2e-summary.ts [path/to/results.json]   (default qa/.runs/${E2E_PORT:-8788}/results.json)
 *
 * A test is "flaky" when its final attempt passed after at least one failed attempt (Playwright retries).
 * Never fails the job: a missing/unreadable report is reported in the summary and exits 0.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface PwResult { status?: string; retry?: number }
interface PwTest { projectName?: string; status?: string; results?: PwResult[] }
interface PwSpec { title: string; file?: string; line?: number; tests?: PwTest[] }
interface PwSuite { title?: string; file?: string; specs?: PwSpec[]; suites?: PwSuite[] }
export interface PwReport { suites?: PwSuite[] }

export interface E2eSummary {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  failedTitles: string[];
  flakyTitles: string[];
}

const PASSED = new Set(['passed']);

function testTitle(path: string[], spec: PwSpec, test: PwTest) {
  const parts = [...path.filter(Boolean), spec.title];
  return `${test.projectName ? `[${test.projectName}] ` : ''}${parts.join(' › ')}`;
}

/** Pure: classify every test (spec × project) of a Playwright JSON report by its final attempt. */
export function summarize(report: PwReport): E2eSummary {
  const s: E2eSummary = { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, failedTitles: [], flakyTitles: [] };
  const walk = (suite: PwSuite, path: string[]) => {
    // The top-level suite title is the file path; keep it, it is the most useful locator.
    const here = [...path, suite.title ?? ''];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        s.total += 1;
        const results = test.results ?? [];
        const final = results[results.length - 1];
        const title = testTitle(here, spec, test);
        if (!final || final.status === 'skipped' || test.status === 'skipped') {
          s.skipped += 1;
        } else if (PASSED.has(final.status ?? '')) {
          if (results.slice(0, -1).some((r) => !PASSED.has(r.status ?? '') && r.status !== 'skipped')) {
            s.flaky += 1;
            s.flakyTitles.push(title);
          } else {
            s.passed += 1;
          }
        } else {
          s.failed += 1;
          s.failedTitles.push(`${title} (${final.status})`);
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return s;
}

/** Pure: Markdown for the GitHub job summary. */
export function formatSummary(s: E2eSummary, source = 'results.json'): string {
  const state = s.failed > 0 ? 'FAILED' : s.flaky > 0 ? 'PASSED (with flaky tests)' : s.total > 0 ? 'PASSED' : 'NO TESTS';
  const lines = [
    `## E2E results: ${state}`,
    '',
    '| total | passed | failed | flaky | skipped |',
    '|---:|---:|---:|---:|---:|',
    `| ${s.total} | ${s.passed} | ${s.failed} | ${s.flaky} | ${s.skipped} |`,
    '',
    `total: ${s.total} · passed: ${s.passed} · failed: ${s.failed} · flaky: ${s.flaky} · skipped: ${s.skipped}`,
    '',
  ];
  if (s.failedTitles.length) lines.push('### Failed', '', ...s.failedTitles.map((t) => `- ${t}`), '');
  if (s.flakyTitles.length) lines.push('### Flaky (passed on retry)', '', ...s.flakyTitles.map((t) => `- ${t}`), '');
  lines.push(`_Source: \`${source}\`. Traces, videos and the HTML report are in the \`e2e-evidence-<run_id>\` artifact._`, '');
  return lines.join('\n');
}

function main() {
  const file = process.argv[2] ?? `qa/.runs/${process.env.E2E_PORT || 8788}/results.json`;
  let md: string;
  if (!existsSync(file)) {
    md = `## E2E results: NO REPORT\n\nNo Playwright report at \`${file}\` (the suite did not run or crashed before reporting).\n`;
  } else {
    try {
      md = formatSummary(summarize(JSON.parse(readFileSync(file, 'utf8')) as PwReport), file);
    } catch (err) {
      md = `## E2E results: NO REPORT\n\nCould not parse \`${file}\`: ${(err as Error).message}\n`;
    }
  }
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (out) appendFileSync(out, `${md}\n`);
  else process.stdout.write(md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
