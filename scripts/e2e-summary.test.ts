import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSummary, summarize, type PwReport } from './e2e-summary';

const fixturePath = join(__dirname, 'fixtures', 'e2e-results.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as PwReport;

describe('e2e-summary', () => {
  it('counts every spec × project by its final attempt', () => {
    const s = summarize(fixture);
    expect(s).toMatchObject({ total: 5, passed: 2, failed: 1, flaky: 1, skipped: 1 });
  });

  it('reports a test that failed then passed on retry as flaky (scenario 5)', () => {
    const s = summarize(fixture);
    expect(s.flakyTitles).toEqual(['[desktop] 000-smoke/smoke.e2e.ts › smoke › feed loads']);
    expect(formatSummary(s)).toContain('flaky: 1');
  });

  it('lists failed test titles with their final status', () => {
    const md = formatSummary(summarize(fixture));
    expect(md).toContain('### Failed');
    expect(md).toContain('- [desktop] 008-operations-scale/US1-ci-evidence.e2e.ts › summary parses its own results (timedOut)');
    expect(md).toContain('| 5 | 2 | 1 | 1 | 1 |');
    expect(md).toMatch(/E2E results: FAILED/);
  });

  it('handles an empty report', () => {
    expect(summarize({})).toMatchObject({ total: 0, passed: 0, failed: 0, flaky: 0 });
  });

  it('appends to $GITHUB_STEP_SUMMARY and never fails on a missing report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-summary-'));
    const out = join(dir, 'summary.md');
    const run = (file: string) =>
      execFileSync('pnpm', ['exec', 'tsx', join(__dirname, 'e2e-summary.ts'), file], { env: { ...process.env, GITHUB_STEP_SUMMARY: out }, encoding: 'utf8' });
    run(fixturePath);
    run(join(dir, 'missing.json'));
    const md = readFileSync(out, 'utf8');
    expect(md).toContain('total: 5 · passed: 2 · failed: 1 · flaky: 1 · skipped: 1');
    expect(md).toContain('No Playwright report at');
  });
});
