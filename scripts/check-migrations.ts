/**
 * Additive-migration gate (spec 008 FR-006). Fails when a new/changed `packages/db/migrations/*.sql` contains a
 * destructive statement — DROP TABLE, DROP COLUMN, ALTER COLUMN … TYPE, RENAME, SET NOT NULL without a DEFAULT in the
 * same statement — unless the file's first line is `-- tp:allow-destructive <reason>`.
 *
 *   pnpm exec tsx scripts/check-migrations.ts <file.sql>...        check the given files
 *   pnpm exec tsx scripts/check-migrations.ts --base <git-ref>     check migrations added/modified vs <ref>
 *
 * Existing migrations that did not change vs the base are never checked; a migration deleted (or renamed) vs the base
 * always fails, because already-applied migrations must stay in the journal.
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

/** Keywords that may follow `ADD` inside ALTER TABLE without meaning "add a column". */
const NON_COLUMN_ADDS = new Set(['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude']);

const ident = (s: string) => (s.startsWith('"') ? s.slice(1, -1) : s.toLowerCase());

/** Split ALTER TABLE actions on commas outside parentheses and double quotes. */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quoted = false, cur = '';
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '(') depth++;
    else if (!quoted && ch === ')') depth--;
    if (ch === ',' && depth === 0 && !quoted) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

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
    if (/^DROP\s+TYPE\b/i.test(stmt)) add('DROP TYPE');
    if (/^DROP\s+SCHEMA\b/i.test(stmt)) add('DROP SCHEMA');
    if (/^TRUNCATE\b/i.test(stmt)) add('TRUNCATE');
    const alter = /^ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:"[^"]+"|[\w$.]+)(?:\."[^"]+")?\s+([\s\S]*)$/i.exec(stmt);
    if (alter) {
      const clauses = splitTopLevel(alter[1]);
      // Columns that get a DEFAULT in this same statement (`ALTER COLUMN c SET DEFAULT …`).
      const defaulted = new Set(
        clauses.map((c) => /^ALTER\s+(?:COLUMN\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s+SET\s+DEFAULT\b/i.exec(c)?.[1]).filter(Boolean).map((c) => ident(c!)),
      );
      const rules = new Set<string>();
      for (const clause of clauses) {
        const drop = /^DROP\s+(COLUMN\s+)?(?:IF\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)/i.exec(clause);
        // `DROP CONSTRAINT`, `DROP NOT NULL` … are not column drops (ALTER COLUMN … DROP … starts with ALTER).
        if (drop && (drop[1] || drop[2].startsWith('"') || !NON_COLUMN_DROPS.has(drop[2].toLowerCase()))) rules.add('DROP COLUMN');
        const col = /^ALTER\s+(?:COLUMN\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s+(.*)$/i.exec(clause);
        if (col && /^(?:SET\s+DATA\s+)?TYPE\b/i.test(col[2])) rules.add('ALTER COLUMN TYPE');
        if (col && /^SET\s+NOT\s+NULL\b/i.test(col[2]) && !defaulted.has(ident(col[1]))) rules.add('SET NOT NULL without DEFAULT');
        const addCol = /^ADD\s+(COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s+(.*)$/i.exec(clause);
        if (
          addCol && (addCol[1] || addCol[2].startsWith('"') || !NON_COLUMN_ADDS.has(addCol[2].toLowerCase())) &&
          /\bNOT\s+NULL\b/i.test(addCol[3]) && !/\b(DEFAULT|GENERATED)\b/i.test(addCol[3])
        ) rules.add('ADD COLUMN NOT NULL without DEFAULT');
      }
      rules.forEach(add);
    }
    if (/\bRENAME\b/i.test(stmt)) add('RENAME');
  }
  return out;
}

/** Pure: keep only migration SQL paths from a `git diff --name-only` listing. */
export function migrationFiles(paths: string[]): string[] {
  return paths.map((p) => p.trim()).filter((p) => MIGRATION_PATH.test(p));
}

/** Pure: split `git diff --name-status --no-renames` output into added/modified vs deleted migration SQL files. */
export function parseNameStatus(out: string): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const line of out.split('\n')) {
    const [status, path] = line.trim().split(/\s+/, 2);
    if (!path || !MIGRATION_PATH.test(path)) continue;
    (status === 'D' ? deleted : changed).push(path);
  }
  return { changed, deleted };
}

export function deletedViolation(file: string): Violation {
  return { file, line: 0, rule: 'DELETED MIGRATION', statement: 'migration file removed or renamed vs the base' };
}

export function formatViolations(vs: Violation[]): string {
  return vs.map((v) => `${v.file}:${v.line}: ${v.rule} — ${v.statement}`).join('\n');
}

function main(argv: string[]) {
  let files: string[];
  let deleted: string[] = [];
  const baseIdx = argv.indexOf('--base');
  if (baseIdx >= 0) {
    const base = argv[baseIdx + 1];
    if (!base) throw new Error('--base needs a git ref');
    const diff = execFileSync('git', ['diff', '--name-status', '--no-renames', '--diff-filter=AMD', `${base}...HEAD`, '--', 'packages/db/migrations'], { encoding: 'utf8' });
    const changed = parseNameStatus(diff);
    files = changed.changed;
    deleted = changed.deleted;
  } else {
    files = argv.filter((a) => a.endsWith('.sql'));
  }
  if (!files.length && !deleted.length) {
    console.log('check-migrations: no new or changed migrations');
    return 0;
  }
  const violations = [
    ...deleted.map((f) => deletedViolation(f)),
    ...files.filter((f) => existsSync(f)).flatMap((f) => checkSql(f, readFileSync(f, 'utf8'))),
  ];
  if (violations.length) {
    console.error(`check-migrations: destructive statements found (add "-- tp:allow-destructive <reason>" as line 1 to accept):\n${formatViolations(violations)}`);
    return 1;
  }
  console.log(`check-migrations: ${files.length} migration(s) additive: ${files.join(', ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
