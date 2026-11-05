/**
 * 008/FR-027 (T067): migrations whose first line is `-- tp:non-transactional` run outside a transaction, so
 * `CREATE INDEX CONCURRENTLY` works; ordinary migrations stay transactional. Runs against TEST_DATABASE_URL in a
 * scratch schema, then checks the repo's own capacity indexes (T068, T069) are present and valid.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createNodeDb, type Db } from '@tp/db';
import { concurrentIndexTarget, isNonTransactional, NON_TRANSACTIONAL_MARKER, runMigrations } from '@tp/db/migrate';
import { ensureMigrated, TEST_DATABASE_URL } from './helpers';

const tag = `mig_${Date.now().toString(36)}`;
const data = `${tag}_data`;
let dir: string;
let db: Db;
let close: () => Promise<void>;

const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q) as unknown as { rows: T[] }).rows;

async function writeMigrations(files: { name: string; body: string }[]) {
  await mkdir(join(dir, 'meta'), { recursive: true });
  const entries = files.map((f, i) => ({ idx: i, version: '7', when: 1_700_000_000_000 + i, tag: f.name, breakpoints: true }));
  await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }));
  for (const f of files) await writeFile(join(dir, `${f.name}.sql`), f.body);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tp-migrations-'));
  ({ db, close } = await createNodeDb(TEST_DATABASE_URL));
});
afterAll(async () => {
  await db.execute(sql.raw(`drop schema if exists "${tag}" cascade; drop schema if exists "${data}" cascade`));
  await db.execute(sql.raw(`drop schema if exists "${tag}_inv" cascade; drop schema if exists "${data}_inv" cascade`));
  await db.execute(sql.raw(`drop schema if exists "${tag}_lock" cascade; drop schema if exists "${data}_lock" cascade`));
  await close();
  await rm(dir, { recursive: true, force: true });
});

describe('non-transactional migrations (T067)', () => {
  it('detects the marker on the first line only', () => {
    expect(isNonTransactional({ sql: [`${NON_TRANSACTIONAL_MARKER}\nCREATE INDEX CONCURRENTLY x ON y (z);`] })).toBe(true);
    expect(isNonTransactional({ sql: ['CREATE TABLE a (id int);', `${NON_TRANSACTIONAL_MARKER}`] })).toBe(false);
    expect(isNonTransactional({ sql: ['-- tp:transactional please\nselect 1'] })).toBe(false);
  });

  it('runs CREATE INDEX CONCURRENTLY outside a transaction and records each migration once', async () => {
    await writeMigrations([
      { name: '0000_table', body: `CREATE SCHEMA IF NOT EXISTS "${data}";--> statement-breakpoint\nCREATE TABLE "${data}".t (id int, v text);` },
      { name: '0001_concurrent', body: `${NON_TRANSACTIONAL_MARKER}\n-- comment line\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_v_idx ON "${data}".t (v);--> statement-breakpoint\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_id_idx ON "${data}".t (id) WHERE id > 0;` },
      { name: '0002_after', body: `ALTER TABLE "${data}".t ADD COLUMN w int;` },
    ]);
    const first = await runMigrations(TEST_DATABASE_URL, { migrationsFolder: dir, migrationsSchema: tag });
    expect(first.applied).toEqual(['0000_table', '0001_concurrent', '0002_after']);
    const idx = await rows<{ name: string; valid: boolean }>(sql.raw(
      `select indexrelid::regclass::text as name, indisvalid as valid from pg_index where indrelid = '"${data}".t'::regclass order by 1`));
    expect(idx).toEqual([{ name: `${data}.t_id_idx`, valid: true }, { name: `${data}.t_v_idx`, valid: true }]);
    expect((await runMigrations(TEST_DATABASE_URL, { migrationsFolder: dir, migrationsSchema: tag })).applied).toEqual([]);
    const recorded = await rows<{ n: number }>(sql.raw(`select count(*)::int as n from "${tag}".__drizzle_migrations`));
    expect(recorded[0].n).toBe(3);
  });

  it('keeps ordinary migrations transactional: a failure rolls the whole file back and records nothing', async () => {
    await writeMigrations([
      { name: '0000_table', body: `CREATE SCHEMA IF NOT EXISTS "${data}";--> statement-breakpoint\nCREATE TABLE "${data}".t (id int, v text);` },
      { name: '0001_concurrent', body: `${NON_TRANSACTIONAL_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_v_idx ON "${data}".t (v);` },
      { name: '0002_after', body: `ALTER TABLE "${data}".t ADD COLUMN w int;` },
      { name: '0003_broken', body: `CREATE TABLE "${data}".half (id int);--> statement-breakpoint\nSELECT no_such_function();` },
    ]);
    await expect(runMigrations(TEST_DATABASE_URL, { migrationsFolder: dir, migrationsSchema: tag })).rejects.toThrow(/no_such_function/);
    expect(await rows(sql.raw(`select 1 from pg_tables where schemaname = '${data}' and tablename = 'half'`))).toEqual([]);
    const recorded = await rows<{ n: number }>(sql.raw(`select count(*)::int as n from "${tag}".__drizzle_migrations`));
    expect(recorded[0].n).toBe(3);
  });

  it('a CONCURRENTLY statement inside a transaction would fail (why the marker exists)', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS t_w_idx ON "${data}".t (w)`));
    })).rejects.toThrow(/cannot run inside a transaction block/);
  });
});

describe('INVALID indexes and concurrent runs (review S1)', () => {
  it('parses the index and table of a CREATE INDEX CONCURRENTLY statement', () => {
    expect(concurrentIndexTarget(`${NON_TRANSACTIONAL_MARKER}\n-- c\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "My_Idx" ON "s".t USING btree (v);`))
      .toEqual({ index: 'My_Idx', table: '"s".t' });
    expect(concurrentIndexTarget('create index concurrently Foo_idx on ONLY bar (x)')).toEqual({ index: 'foo_idx', table: 'bar' });
    expect(concurrentIndexTarget('CREATE INDEX foo ON bar (x)')).toBeNull();
  });

  it('drops an INVALID index left by a failed CONCURRENTLY build instead of skipping it via IF NOT EXISTS', async () => {
    const d = `${data}_inv`;
    const folder = await mkdtemp(join(tmpdir(), 'tp-migrations-inv-'));
    try {
      await db.execute(sql.raw(`create schema "${d}"; create table "${d}".t (v int); insert into "${d}".t values (1), (1)`));
      // Plant the INVALID index: a unique build over duplicates fails and leaves it behind.
      await expect(db.execute(sql.raw(`CREATE UNIQUE INDEX CONCURRENTLY t_v_uq ON "${d}".t (v)`))).rejects.toThrow();
      const state = async () => rows<{ valid: boolean }>(sql.raw(
        `select indisvalid as valid from pg_index where indexrelid = to_regclass('"${d}".t_v_uq')`));
      expect(await state()).toEqual([{ valid: false }]);

      const body = `${NON_TRANSACTIONAL_MARKER}\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS t_v_uq ON "${d}".t (v);`;
      await mkdir(join(folder, 'meta'), { recursive: true });
      await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries: [{ idx: 0, version: '7', when: 1_700_000_000_000, tag: '0000_uq', breakpoints: true }] }));
      await writeFile(join(folder, '0000_uq.sql'), body);
      const logs: string[] = [];
      // Still duplicates: the invalid index is dropped, the rebuild fails again, nothing is recorded.
      await expect(runMigrations(TEST_DATABASE_URL, { migrationsFolder: folder, migrationsSchema: `${tag}_inv`, log: (l) => logs.push(l) })).rejects.toThrow();
      expect(logs.some((l) => /dropping INVALID index .*t_v_uq/.test(l))).toBe(true);
      expect((await rows<{ n: number }>(sql.raw(`select count(*)::int as n from "${tag}_inv".__drizzle_migrations`)))[0].n).toBe(0);
      // Data fixed: the next run drops the new invalid leftover and builds a valid index, then records the file.
      await db.execute(sql.raw(`delete from "${d}".t where ctid = (select max(ctid) from "${d}".t)`));
      expect((await runMigrations(TEST_DATABASE_URL, { migrationsFolder: folder, migrationsSchema: `${tag}_inv` })).applied).toEqual(['0000_uq']);
      expect(await state()).toEqual([{ valid: true }]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('two runs at once (advisory lock) apply each migration exactly once', async () => {
    const d = `${data}_lock`;
    const folder = await mkdtemp(join(tmpdir(), 'tp-migrations-lock-'));
    try {
      await mkdir(join(folder, 'meta'), { recursive: true });
      const files = [
        { tag: '0000_t', body: `CREATE SCHEMA "${d}";--> statement-breakpoint\nCREATE TABLE "${d}".t (id int);` },
        { tag: '0001_idx', body: `${NON_TRANSACTIONAL_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_id_idx ON "${d}".t (id);` },
      ];
      await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries: files.map((f, i) => ({ idx: i, version: '7', when: 1_700_000_000_000 + i, tag: f.tag, breakpoints: true })) }));
      for (const f of files) await writeFile(join(folder, `${f.tag}.sql`), f.body);
      const runs = await Promise.all([0, 1, 2].map(() => runMigrations(TEST_DATABASE_URL, { migrationsFolder: folder, migrationsSchema: `${tag}_lock` })));
      expect(runs.flatMap((r) => r.applied).sort()).toEqual(['0000_t', '0001_idx']);
      expect((await rows<{ n: number }>(sql.raw(`select count(*)::int as n from "${tag}_lock".__drizzle_migrations`)))[0].n).toBe(2);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe('repo capacity indexes (T064, T068, T069)', () => {
  it('are present and valid after migrating', async () => {
    await ensureMigrated();
    const names = [
      'tenders_open_created_idx', 'tenders_open_closing_idx', 'tenders_open_value_idx', 'tenders_open_state_idx', 'tenders_open_ministry_idx',
      'tenders_open_category_idx', 'analyses_org_tender_created_idx', 'notifications_pending_idx', 'ingestion_runs_one_running_uq',
    ];
    const found = await rows<{ name: string; valid: boolean; def: string }>(sql`
      select c.relname as name, i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as def
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname in (${sql.join(names.map((n) => sql`${n}`), sql`, `)}) order by 1`);
    expect(found.map((f) => f.name).sort()).toEqual([...names].sort());
    expect(found.every((f) => f.valid)).toBe(true);
    for (const f of found.filter((x) => x.name.startsWith('tenders_open_'))) expect(f.def).toMatch(/WHERE \(status = 'open'::text\)/);
    // 0019 (US4 scenario 4): state equality, then the default sort, then the "still open" expression.
    expect(found.find((f) => f.name === 'tenders_open_state_idx')?.def)
      .toMatch(/\(state, created_at DESC, COALESCE\(end_at, 'infinity'::timestamp with time zone\)\) WHERE \(status = 'open'::text\)/);
    expect(found.find((f) => f.name === 'notifications_pending_idx')?.def).toMatch(/status = 'pending'.*channel = ANY/);
    expect(found.find((f) => f.name === 'ingestion_runs_one_running_uq')?.def).toMatch(/UNIQUE INDEX .*\(true\).*WHERE \(status = 'running'::text\)/);
    const seed = await rows<{ id: string }>(sql`select id from gem_throttle`);
    expect(seed.length).toBeLessThanOrEqual(1); // seeded by 0012; other suites truncate it, the lease upserts it back
  });
});
