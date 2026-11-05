/**
 * Migration runner (`pnpm db:migrate`). Same bookkeeping as drizzle's node-postgres migrator
 * (`drizzle.__drizzle_migrations`, hash + journal `when`), so existing databases continue where they are, with one
 * addition (008/FR-027, T067): a migration file whose first line is `-- tp:non-transactional` runs statement by
 * statement OUTSIDE a transaction — required for `CREATE INDEX CONCURRENTLY`. Such files must be idempotent
 * (`IF NOT EXISTS`): when one fails, it is not recorded and the whole file re-runs next time.
 *
 * Consecutive ordinary migrations still run together in one transaction (drizzle's behaviour).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';

export const NON_TRANSACTIONAL_MARKER = '-- tp:non-transactional';

/** True when the migration's SQL starts with the `-- tp:non-transactional` marker line. */
export function isNonTransactional(m: Pick<MigrationMeta, 'sql'>): boolean {
  return (m.sql[0] ?? '').trimStart().startsWith(NON_TRANSACTIONAL_MARKER);
}

export interface MigrateOptions {
  migrationsFolder?: string;
  /** Bookkeeping schema (default `drizzle`, as drizzle-kit). Tests use a scratch schema. */
  migrationsSchema?: string;
  log?: (msg: string) => void;
}

const DEFAULT_FOLDER = () => fileURLToPath(new URL('../migrations', import.meta.url));
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  connect(): Promise<void>;
}

/** Apply pending migrations; returns the journal tags applied, in order. */
export async function runMigrations(url: string, opts: MigrateOptions = {}): Promise<{ applied: string[] }> {
  const pg = await import('pg');
  const client = new pg.default.Client({ connectionString: url }) as unknown as PgClient;
  await client.connect();
  try {
    return await applyMigrations(client, opts);
  } finally {
    await client.end();
  }
}

async function applyMigrations(client: PgClient, opts: MigrateOptions): Promise<{ applied: string[] }> {
  const folder = opts.migrationsFolder ?? DEFAULT_FOLDER();
  const table = `${ident(opts.migrationsSchema ?? 'drizzle')}."__drizzle_migrations"`;
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const tagOf = journalTags(folder, migrations);

  await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident(opts.migrationsSchema ?? 'drizzle')}`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
  const { rows } = await client.query(`select created_at from ${table} order by created_at desc limit 1`);
  const last = rows[0] ? Number(rows[0].created_at) : null;
  const pending = migrations.filter((m) => last === null || last < m.folderMillis);

  const record = (m: MigrationMeta) => client.query(`insert into ${table} ("hash", "created_at") values ($1, $2)`, [m.hash, m.folderMillis]);
  const run = async (m: MigrationMeta) => { for (const stmt of m.sql) if (stmt.trim()) await client.query(stmt); };
  const applied: string[] = [];
  let batch: MigrationMeta[] = [];
  const flush = async () => {
    if (!batch.length) return;
    await client.query('BEGIN');
    try {
      for (const m of batch) { await run(m); await record(m); }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
    applied.push(...batch.map(tagOf));
    batch = [];
  };

  for (const m of pending) {
    if (!isNonTransactional(m)) { batch.push(m); continue; }
    await flush();
    opts.log?.(`migration ${tagOf(m)}: running outside a transaction`);
    await run(m);
    await record(m);
    applied.push(tagOf(m));
  }
  await flush();
  return { applied };
}

/** Journal tag of each migration (readMigrationFiles keeps journal order); falls back to the timestamp. */
function journalTags(folder: string, migrations: MigrationMeta[]): (m: MigrationMeta) => string {
  const tags = new Map<MigrationMeta, string>();
  try {
    const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    migrations.forEach((m, i) => { const tag = journal.entries[i]?.tag; if (tag) tags.set(m, tag); });
  } catch { /* tags are cosmetic */ }
  return (m) => tags.get(m) ?? String(m.folderMillis);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL ?? 'postgres://tp:tp@localhost:5433/tenderpilot';
  runMigrations(url, { log: (m) => console.log(m) })
    .then(({ applied }) => console.log(applied.length ? `migrations applied: ${applied.join(', ')}` : 'migrations applied (none pending)'))
    .catch((e) => { console.error(e); process.exit(1); });
}
