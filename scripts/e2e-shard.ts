/**
 * Splits the E2E spec files across CI shards (spec 008 FR-001 / NFR-007: full pipeline incl. E2E < 30 minutes).
 *
 *   pnpm exec tsx scripts/e2e-shard.ts <shard> <total>     prints this shard's spec files, one per line
 *
 * Every story's E2E was written to run on a fresh database (`pnpm exec playwright test e2e/<NNN>/US<n>*`), so
 * scripts/e2e-ci.sh runs each file as its own Playwright invocation (fresh DB + server); this module only decides
 * which files a shard gets. Weight = number of `test(` declarations (≈ run time); greedy longest-first onto the
 * lightest shard, ties broken by path, so the split is deterministic and every file lands in exactly one shard.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface SpecFile { path: string; weight: number }

/** Number of `test(` / `test.only(` / `test.skip(` … declarations, at least 1 (setup-only files still cost a boot). */
export function weightOf(source: string): number {
  return Math.max(1, (source.match(/(^|[^\w.])test(\.(only|skip|fixme|fail|slow))?\s*\(/g) ?? []).length);
}

/** Pure: assign files to `total` shards (index 0..total-1), heaviest first onto the currently lightest shard. */
export function assignShards(files: SpecFile[], total: number): string[][] {
  if (!Number.isInteger(total) || total < 1) throw new Error(`total must be a positive integer, got ${total}`);
  const shards = Array.from({ length: total }, () => ({ weight: 0, files: [] as string[] }));
  const sorted = [...files].sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
  for (const f of sorted) {
    let best = 0;
    for (let i = 1; i < total; i++) if (shards[i].weight < shards[best].weight) best = i;
    shards[best].weight += f.weight;
    shards[best].files.push(f.path);
  }
  return shards.map((s) => s.files.sort());
}

function main(argv: string[]) {
  const [shard, total] = argv.map(Number);
  if (!Number.isInteger(shard) || !Number.isInteger(total) || shard < 1 || shard > total) {
    console.error('usage: e2e-shard.ts <shard 1..total> <total>');
    return 2;
  }
  const paths = execFileSync('git', ['ls-files', '--', 'e2e/*.e2e.ts', 'e2e/**/*.e2e.ts'], { encoding: 'utf8' })
    .split('\n').map((p) => p.trim()).filter(Boolean);
  const files = [...new Set(paths)].map((path) => ({ path, weight: weightOf(readFileSync(path, 'utf8')) }));
  for (const f of assignShards(files, total)[shard - 1]) console.log(f);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
