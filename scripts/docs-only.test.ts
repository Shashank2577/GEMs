import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const docsOnly = (paths: string[]) =>
  execFileSync('bash', [join(__dirname, 'docs-only.sh')], { input: paths.join('\n'), encoding: 'utf8' }).trim();

describe('docs-only path filter (scenario 7)', () => {
  it('is true for specs/**, docs/** and *.md changes', () => {
    expect(docsOnly(['specs/008-operations-scale/spec.md', 'docs/adr/0001.md', 'README.md', 'apps/web/NOTES.md', 'docs/diagram.png'])).toBe('true');
  });
  it('is false when code changes too', () => {
    expect(docsOnly(['docs/runbook.md', 'packages/core/src/index.ts'])).toBe('false');
    expect(docsOnly(['.github/workflows/ci.yml'])).toBe('false');
  });
  it('treats QA evidence (even markdown) as code', () => {
    expect(docsOnly(['qa/evidence/008/US1/VERDICT.md'])).toBe('false');
  });
  it('is false for an empty change list', () => {
    expect(docsOnly([])).toBe('false');
  });
  it('is false when code is moved into docs/ (ci/dod diff with --no-renames lists the old path)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'docs-only-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.in', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'billing.ts'), 'export const a = 1;\n'.repeat(20));
    git('add', '-A');
    git('commit', '-qm', 'base');
    mkdirSync(join(repo, 'docs'));
    git('mv', 'src/billing.ts', 'docs/billing.ts');
    git('commit', '-qm', 'move');
    const withRenames = git('diff', '--name-only', '-M', 'HEAD~1...HEAD').trim().split('\n');
    const noRenames = git('diff', '--name-only', '--no-renames', 'HEAD~1...HEAD').trim().split('\n');
    expect(withRenames).toEqual(['docs/billing.ts']);
    expect(docsOnly(withRenames)).toBe('true');
    expect(noRenames.sort()).toEqual(['docs/billing.ts', 'src/billing.ts']);
    expect(docsOnly(noRenames)).toBe('false');
  });
});
