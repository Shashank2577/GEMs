import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
});
