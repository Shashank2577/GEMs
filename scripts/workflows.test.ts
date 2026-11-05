import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// No YAML parser is installed at the repo root, so these assertions use a small indentation-based reader that is
// only valid for the block-style workflow files in .github/workflows (2-space indent, one key per line).
const read = (f: string) => readFileSync(join(__dirname, '..', '.github', 'workflows', f), 'utf8');

/** Lines of a top-level (`indent` 0) or nested block `key:` until the next line at the same or lower indent. */
function block(text: string, key: string, indent = 0): string[] {
  const lines = text.split('\n');
  const pad = ' '.repeat(indent);
  const start = lines.findIndex((l) => l === `${pad}${key}:` || l.startsWith(`${pad}${key}: `));
  if (start < 0) throw new Error(`no "${key}:" at indent ${indent}`);
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() && !l.trim().startsWith('#') && l.length - l.trimStart().length <= indent) break;
    out.push(l);
  }
  return out;
}

/** Scalar (or flow list) value of `key:` directly inside a job block (4-space indent). */
function field(job: string[], key: string, indent = 4): string | undefined {
  const pad = ' '.repeat(indent);
  return job.find((l) => l.startsWith(`${pad}${key}:`))?.slice(pad.length + key.length + 1).trim();
}
const list = (v: string | undefined) => (v ?? '').replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean);

const job = (text: string, name: string) => {
  const jobs = block(text, 'jobs').join('\n');
  return block(jobs, name, 2);
};

describe('ci.yml → deploy hand-off (008 US1 scenario 8)', () => {
  const ci = read('ci.yml');
  const deploy = job(ci, 'deploy');

  it('deploys only on a push to main after ci-gate succeeded', () => {
    expect(field(deploy, 'needs')).toBe('ci-gate');
    expect(field(deploy, 'if')).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.ci-gate.result == 'success'",
    );
  });

  it('calls the reusable deploy workflow with inherited secrets and read-only contents', () => {
    expect(field(deploy, 'uses')).toBe('./.github/workflows/deploy.yml');
    expect(field(deploy, 'secrets')).toBe('inherit');
    expect(block(deploy.join('\n'), 'permissions', 4).map((l) => l.trim())).toContain('contents: read');
    // Concurrency belongs to deploy.yml's job; the same group on the caller would deadlock.
    expect(field(deploy, 'concurrency')).toBeUndefined();
  });

  it('ci-gate does not depend on deploy (a deploy skipped on PRs never affects the gate)', () => {
    const gate = job(ci, 'ci-gate');
    expect(list(field(gate, 'needs')).sort()).toEqual(['api', 'changes', 'e2e', 'e2e-shard', 'migrations-additive', 'typecheck', 'unit']);
    expect(field(gate, 'if')).toBe('always()');
  });

  it('is triggered by pull_request and push to main, without workflow_run', () => {
    const on = block(ci, 'on').map((l) => l.trim());
    expect(on).toEqual(expect.arrayContaining(['pull_request:', 'push:', 'branches: [main]']));
    expect(ci).not.toMatch(/^\s*workflow_run:/m);
  });
});

describe('deploy.yml (reusable placeholder until US2/T036)', () => {
  const dep = read('deploy.yml');

  it('is callable from ci and dispatchable, never via workflow_run', () => {
    const on = block(dep, 'on').map((l) => l.trim());
    expect(on).toEqual(expect.arrayContaining(['workflow_call:', 'workflow_dispatch:']));
    expect(dep).not.toMatch(/^\s*workflow_run:/m);
  });

  it('runs one deploy at a time and never cancels one in flight', () => {
    const j = job(dep, 'deploy');
    const conc = block(j.join('\n'), 'concurrency', 4).map((l) => l.trim());
    expect(conc).toEqual(['group: deploy', 'cancel-in-progress: false']);
  });
});

describe('ci.yml → sharded e2e (NFR-007) keeps the required `e2e` check', () => {
  const ci = read('ci.yml');

  it('runs e2e-shard as a matrix after api, one fresh-DB Playwright run per spec file', () => {
    const shard = job(ci, 'e2e-shard');
    expect(field(shard, 'needs')).toBe('api');
    expect(field(shard, 'timeout-minutes')).toBe('30');
    expect(shard.join('\n')).toContain('fail-fast: false');
    expect(shard.join('\n')).toMatch(/run: CI=1 scripts\/e2e-ci\.sh \$\{\{ matrix\.shard \}\} "\$E2E_SHARDS"/);
    const n = Number(/E2E_SHARDS: '(\d+)'/.exec(shard.join('\n'))?.[1]);
    const matrix = /shard: \[([\d, ]+)\]/.exec(shard.join('\n'))?.[1].split(',').map((x) => Number(x.trim()));
    expect(matrix).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });

  it('the `e2e` job merges every shard, publishes the evidence, and fails unless all shards passed', () => {
    const e2e = job(ci, 'e2e');
    expect(list(field(e2e, 'needs'))).toEqual(['api', 'e2e-shard']);
    expect(field(e2e, 'if')).toBe("${{ !cancelled() && needs.api.result == 'success' }}");
    const text = e2e.join('\n');
    expect(text).toContain('playwright merge-reports --reporter=json,html');
    expect(text).toContain('name: e2e-evidence-${{ github.run_id }}');
    expect(text).toMatch(/SHARDS: \$\{\{ needs\.e2e-shard\.result \}\}/);
  });
});
