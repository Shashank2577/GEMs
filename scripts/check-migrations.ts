/**
 * Additive-migration gate (spec 008 FR-006). Fails when a new/changed `packages/db/migrations/*.sql` contains a
 * destructive statement — DROP TABLE, DROP COLUMN, ALTER COLUMN … TYPE, RENAME, SET NOT NULL without a DEFAULT in the
 * same statement — unless the file's first line is `-- tp:allow-destructive <reason>`.
 *
 *   pnpm exec tsx scripts/check-migrations.ts <file.sql>...        check the given files
 *   pnpm exec tsx scripts/check-migrations.ts --base <git-ref>     check migrations added/modified vs <ref>
 *
 * Existing migrations that did not change vs the base are never checked.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface Violation { file: string; line: number; rule: string; statement: string }

export const ALLOW_MARKER = /^\s*--\s*tp:allow-destructive\s+\S/;
export const MIGRATION_PATH = /^packages\/db\/migrations\/[^/]+\.sql$/;

/** Keywords that may follow `DROP` inside ALTER TABLE without meaning "drop a column". */
const NON_COLUMN_DROPS = new Set([
  'constraint', 'default', 'not', 'identity', 'expression', 'index', 'table', 'view', 'type', 'schema', 'sequence',
  'policy', 'trigger', 'function', 'extension', 'materialized', 'rule', 'owned',
]);

/** Blank out comments and string literals (keeping offsets/newlines) so keywords inside them are ignored. */
export function maskSql(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineAt(sql: string, offset: number) {
  return sql.slice(0, offset).split('\n').length;
}

/** Pure: destructive statements in one migration's SQL (empty when allowed by the first-line marker). */
export function checkSql(file: string, sql: string): Violation[] {
  const firstLine = sql.split('\n', 1)[0] ?? '';
  if (ALLOW_MARKER.test(firstLine)) return [];
  const masked = maskSql(sql);
  const out: Violation[] = [];
  let start = 0;
  for (const piece of masked.split(';')) {
    const lead = piece.length - piece.trimStart().length;
    const stmt = piece.trim().replace(/\s+/g, ' ');
    const at = start + lead;
    start += piece.length + 1;
    if (!stmt) continue;
    const add = (rule: string) =>
      out.push({ file, line: lineAt(sql, at), rule, statement: stmt.length > 160 ? `${stmt.slice(0, 157)}...` : stmt });

    if (/\bDROP\s+TABLE\b/i.test(stmt)) add('DROP TABLE');
    if (/^ALTER\s+TABLE\b/i.test(stmt)) {
      for (const m of stmt.matchAll(/\bDROP\s+(COLUMN\s+)?(?:IF\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)/gi)) {
        // `ALTER COLUMN x DROP DEFAULT|NOT NULL|…` and `DROP CONSTRAINT` are not column drops.
        if (m[1] || m[2].startsWith('"') || !NON_COLUMN_DROPS.has(m[2].toLowerCase())) {
          add('DROP COLUMN');
          break;
        }
      }
      if (/\bALTER\s+(?:COLUMN\s+)?(?:"[^"]+"|[A-Za-z_][\w$]*)\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(stmt)) add('ALTER COLUMN TYPE');
      if (/\bSET\s+NOT\s+NULL\b/i.test(stmt) && !/\bDEFAULT\b/i.test(stmt)) add('SET NOT NULL without DEFAULT');
    }
    if (/\bRENAME\b/i.test(stmt)) add('RENAME');
  }
  return out;
}

/** Pure: keep only migration SQL paths from a `git diff --name-only` listing. */
export function migrationFiles(paths: string[]): string[] {
  return paths.map((p) => p.trim()).filter((p) => MIGRATION_PATH.test(p));
}

export function formatViolations(vs: Violation[]): string {
  return vs.map((v) => `${v.file}:${v.line}: ${v.rule} — ${v.statement}`).join('\n');
}

function main(argv: string[]) {
  let files: string[];
  const baseIdx = argv.indexOf('--base');
  if (baseIdx >= 0) {
    const base = argv[baseIdx + 1];
    if (!base) throw new Error('--base needs a git ref');
    const diff = execFileSync('git', ['diff', '--name-only', '--diff-filter=AMR', `${base}...HEAD`, '--', 'packages/db/migrations'], { encoding: 'utf8' });
    files = migrationFiles(diff.split('\n'));
  } else {
    files = argv.filter((a) => a.endsWith('.sql'));
  }
  if (!files.length) {
    console.log('check-migrations: no new or changed migrations');
    return 0;
  }
  const violations = files.filter((f) => existsSync(f)).flatMap((f) => checkSql(f, readFileSync(f, 'utf8')));
  if (violations.length) {
    console.error(`check-migrations: destructive statements found (add "-- tp:allow-destructive <reason>" as line 1 to accept):\n${formatViolations(violations)}`);
    return 1;
  }
  console.log(`check-migrations: ${files.length} migration(s) additive: ${files.join(', ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
