/**
 * Migration runner (`pnpm db:migrate`). Same bookkeeping as drizzle's node-postgres migrator
 * (`drizzle.__drizzle_migrations`, hash + journal `when`), so existing databases continue where they are, with one
 * addition (008/FR-027, T067): a migration file whose first line is `-- tp:non-transactional` runs statement by
 * statement OUTSIDE a transaction — required for `CREATE INDEX CONCURRENTLY`. Such files must be idempotent
 * (`IF NOT EXISTS`): when one fails, it is not recorded and the whole file re-runs next time.
 *
 * A failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index behind, which `IF NOT EXISTS` would then silently
 * skip. So before each such statement an INVALID index of that name on that table is dropped (`DROP INDEX
 * CONCURRENTLY`), and after the file has run every index it names must be valid, or the file is not recorded.
 *
 * Consecutive ordinary migrations still run together in one transaction (drizzle's behaviour). The whole run holds a
 * session advisory lock (polled `pg_try_advisory_lock`), so two deploys migrating at once apply each file exactly once.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';

export const NON_TRANSACTIONAL_MARKER = '-- tp:non-transactional';
/** Key of the session advisory lock held for a whole migration run (`pg_try_advisory_lock(hashtext(key))`). */
export const MIGRATION_LOCK_KEY = 'tenderpilot:migrations';

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const CONCURRENT_INDEX = new RegExp(
  String.raw`^\s*(?:--[^\n]*\n\s*)*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON\s+(?:ONLY\s+)?(${IDENT}(?:\.${IDENT})?)`,
  'i');
const unquote = (id: string) => (id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id.toLowerCase());

/** `{ index, table }` named by a `CREATE [UNIQUE] INDEX CONCURRENTLY` statement (index unquoted, table as written). */
export function concurrentIndexTarget(stmt: string): { index: string; table: string } | null {
  const m = CONCURRENT_INDEX.exec(stmt);
  return m ? { index: unquote(m[1]!), table: m[2]! } : null;
}

/** True when the migration's SQL starts with the `-- tp:non-transactional` marker line. */
export function isNonTransactional(m: Pick<MigrationMeta, 'sql'>): boolean {
  return (m.sql[0] ?? '').trimStart().startsWith(NON_TRANSACTIONAL_MARKER);
}

export interface MigrateOptions {
  migrationsFolder?: string;
  /** Bookkeeping schema (default `drizzle`, as drizzle-kit). Tests use a scratch schema. */
  migrationsSchema?: string;
  log?: (msg: string) => void;
  /** Longest wait for another run's lock (default 15 minutes). */
  lockTimeoutMs?: number;
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
    await lockMigrations(client, opts);
    try {
      return await applyMigrations(client, opts);
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY]).catch(() => {});
    }
  } finally {
    await client.end();
  }
}

/**
 * Take the migration lock by polling `pg_try_advisory_lock`. A blocking `pg_advisory_lock` would deadlock with
 * `CREATE INDEX CONCURRENTLY`, which waits for every transaction with an older snapshot — including a second
 * migrator's statement sitting in the lock queue.
 */
async function lockMigrations(client: PgClient, opts: MigrateOptions): Promise<void> {
  const deadline = Date.now() + (opts.lockTimeoutMs ?? 15 * 60_000);
  let logged = false;
  for (;;) {
    const { rows } = await client.query('select pg_try_advisory_lock(hashtext($1)) as ok', [MIGRATION_LOCK_KEY]);
    if (rows[0]?.ok) return;
    if (Date.now() > deadline) throw new Error('another migration run holds the lock; gave up waiting');
    if (!logged) { opts.log?.('waiting for another migration run to finish'); logged = true; }
    await new Promise((r) => setTimeout(r, 200));
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

  /** Indexes of `target`'s name on its table, schema-qualified and quoted, with validity. */
  const indexesOf = async (t: { index: string; table: string }) => (await client.query(
    `select format('%I.%I', n.nspname, c.relname) as name, i.indisvalid as valid
       from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
      where c.relname = $1 and i.indrelid = to_regclass($2)`, [t.index, t.table])).rows as { name: string; valid: boolean }[];
  const runNonTransactional = async (m: MigrationMeta) => {
    const targets: { index: string; table: string }[] = [];
    for (const stmt of m.sql) {
      if (!stmt.trim()) continue;
      const t = concurrentIndexTarget(stmt);
      if (t) {
        targets.push(t);
        for (const idx of await indexesOf(t)) {
          if (idx.valid) continue;
          opts.log?.(`migration ${tagOf(m)}: dropping INVALID index ${idx.name} left by an earlier failed build`);
          await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${idx.name}`);
        }
      }
      await client.query(stmt);
    }
    for (const t of targets) {
      const found = await indexesOf(t);
      if (!found.length || found.some((i) => !i.valid)) {
        throw new Error(`migration ${tagOf(m)}: index ${t.index} on ${t.table} is missing or INVALID after the build; not recorded`);
      }
    }
  };

  for (const m of pending) {
    if (!isNonTransactional(m)) { batch.push(m); continue; }
    await flush();
    opts.log?.(`migration ${tagOf(m)}: running outside a transaction`);
    await runNonTransactional(m);
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
