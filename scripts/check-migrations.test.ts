import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSql, migrationFiles } from './check-migrations';

const rules = (sql: string) => checkSql('m.sql', sql).map((v) => v.rule);

describe('check-migrations', () => {
  it('accepts additive drizzle output', () => {
    const sql = [
      'CREATE TABLE IF NOT EXISTS "usage" ("id" uuid PRIMARY KEY, "n" integer DEFAULT 0 NOT NULL);',
      '--> statement-breakpoint',
      'ALTER TABLE "orgs" ADD COLUMN "plan" text DEFAULT \'free\' NOT NULL;',
      '--> statement-breakpoint',
      'CREATE INDEX IF NOT EXISTS "usage_n_idx" ON "usage" USING btree ("n");',
      'ALTER TABLE "usage" ADD CONSTRAINT "usage_org_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE cascade;',
      'ALTER TABLE "usage" ALTER COLUMN "n" DROP NOT NULL;',
      'ALTER TABLE "usage" ALTER COLUMN "n" DROP DEFAULT;',
      'ALTER TABLE "usage" DROP CONSTRAINT "usage_org_fk";',
    ].join('\n');
    expect(rules(sql)).toEqual([]);
  });

  it.each([
    ['DROP TABLE "tenders";', 'DROP TABLE'],
    ['drop table if exists tenders cascade;', 'DROP TABLE'],
    ['ALTER TABLE "tenders" DROP COLUMN "title";', 'DROP COLUMN'],
    ['ALTER TABLE tenders DROP IF EXISTS title;', 'DROP COLUMN'],
    ['ALTER TABLE "tenders" ALTER COLUMN "qty" SET DATA TYPE bigint;', 'ALTER COLUMN TYPE'],
    ['ALTER TABLE tenders ALTER qty TYPE bigint USING qty::bigint;', 'ALTER COLUMN TYPE'],
    ['ALTER TABLE "tenders" RENAME COLUMN "a" TO "b";', 'RENAME'],
    ['ALTER TABLE "tenders" RENAME TO "bids";', 'RENAME'],
    ['ALTER TABLE "tenders" ALTER COLUMN "org_id" SET NOT NULL;', 'SET NOT NULL without DEFAULT'],
  ])('flags %s', (sql, rule) => {
    expect(rules(sql)).toContain(rule);
  });

  it('allows SET NOT NULL with a default in the same statement', () => {
    expect(rules('ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT 0, ALTER COLUMN "c" SET NOT NULL;')).toEqual([]);
  });

  it('ignores keywords inside comments and string literals', () => {
    expect(rules("-- we never DROP TABLE here\n/* RENAME */ INSERT INTO notes (t) VALUES ('drop column x; rename');")).toEqual([]);
  });

  it('honours the allow-destructive marker on line 1 only, with a reason', () => {
    expect(rules('-- tp:allow-destructive table replaced by v2 in 0007\nDROP TABLE "old";')).toEqual([]);
    expect(rules('-- tp:allow-destructive\nDROP TABLE "old";')).toEqual(['DROP TABLE']);
    expect(rules('SELECT 1;\n-- tp:allow-destructive reason\nDROP TABLE "old";')).toEqual(['DROP TABLE']);
  });

  it('reports the line of the offending statement', () => {
    const [v] = checkSql('m.sql', 'CREATE TABLE a (id int);\n--> statement-breakpoint\nDROP TABLE "b";');
    expect(v).toMatchObject({ file: 'm.sql', line: 3, rule: 'DROP TABLE', statement: 'DROP TABLE "b"' });
  });

  it('only selects migration SQL from a diff listing', () => {
    expect(migrationFiles(['packages/db/migrations/0001_x.sql', 'packages/db/migrations/meta/_journal.json', 'packages/db/src/schema.ts', ''])).toEqual([
      'packages/db/migrations/0001_x.sql',
    ]);
  });

  it('does not flag the migrations already on main', () => {
    const dir = join(__dirname, '..', 'packages', 'db', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      expect(checkSql(f, readFileSync(join(dir, f), 'utf8')), f).toEqual([]);
    }
  });
});
