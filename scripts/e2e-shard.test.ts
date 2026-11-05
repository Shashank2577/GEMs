import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { assignShards, weightOf } from './e2e-shard';

describe('e2e-shard', () => {
  it('weighs a file by its test declarations (min 1)', () => {
    expect(weightOf("test('a', async () => {});\ntest.skip('b', () => {});\n  test ('c', () => {});")).toBe(3);
    expect(weightOf("test.describe('x', () => { test.beforeAll(() => {}); });")).toBe(1);
    expect(weightOf("latest('x'); contest(1); test.describe.serial('s', () => { test('a', () => {}); });")).toBe(1);
  });

  it('puts every file in exactly one shard and balances by weight', () => {
    const files = [
      { path: 'e2e/a.e2e.ts', weight: 10 }, { path: 'e2e/b.e2e.ts', weight: 9 }, { path: 'e2e/c.e2e.ts', weight: 5 },
      { path: 'e2e/d.e2e.ts', weight: 4 }, { path: 'e2e/e.e2e.ts', weight: 1 },
    ];
    const shards = assignShards(files, 2);
    expect(shards.flat().sort()).toEqual(files.map((f) => f.path));
    const w = shards.map((s) => s.reduce((n, p) => n + files.find((f) => f.path === p)!.weight, 0));
    expect(Math.abs(w[0] - w[1])).toBeLessThanOrEqual(1);
  });

  it('is deterministic regardless of input order, and allows more shards than files', () => {
    const files = [{ path: 'x', weight: 2 }, { path: 'y', weight: 2 }, { path: 'z', weight: 1 }];
    expect(assignShards(files, 2)).toEqual(assignShards([...files].reverse(), 2));
    expect(assignShards(files, 5).filter((s) => s.length === 0)).toHaveLength(2);
    expect(() => assignShards(files, 0)).toThrow();
  });

  it('CLI: the shards of the real suite partition every e2e/**/*.e2e.ts file', () => {
    const run = (s: number) => execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e-shard.ts', String(s), '3'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const all = [1, 2, 3].flatMap(run);
    const listed = execFileSync('git', ['ls-files', '--', 'e2e/*.e2e.ts', 'e2e/**/*.e2e.ts'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(all.sort()).toEqual([...new Set(listed)].sort());
  });
});
