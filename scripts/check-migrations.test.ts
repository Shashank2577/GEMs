import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSql, migrationFiles, parseNameStatus } from './check-migrations';

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
    ['ALTER TABLE "t" ALTER COLUMN "a" SET DEFAULT 0, ALTER COLUMN "b" SET NOT NULL;', 'SET NOT NULL without DEFAULT'],
    ['ALTER TABLE "t" ADD COLUMN "org_id" uuid NOT NULL;', 'ADD COLUMN NOT NULL without DEFAULT'],
    ['ALTER TABLE t ADD org_id uuid NOT NULL REFERENCES orgs(id);', 'ADD COLUMN NOT NULL without DEFAULT'],
    ['ALTER TABLE "t" ADD COLUMN "a" int DEFAULT 1 NOT NULL, ADD COLUMN "b" int NOT NULL;', 'ADD COLUMN NOT NULL without DEFAULT'],
    ['DROP TYPE "public"."plan";', 'DROP TYPE'],
    ['DROP SCHEMA legacy CASCADE;', 'DROP SCHEMA'],
    ['TRUNCATE "usage";', 'TRUNCATE'],
  ])('flags %s', (sql, rule) => {
    expect(rules(sql)).toContain(rule);
  });

  it('allows SET NOT NULL when the same column gets a DEFAULT in the same statement', () => {
    expect(rules('ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT 0, ALTER COLUMN "c" SET NOT NULL;')).toEqual([]);
  });

  it('allows NOT NULL columns with a default or generated value, and constraint additions', () => {
    expect(rules('ALTER TABLE "t" ADD COLUMN "n" integer DEFAULT 0 NOT NULL;')).toEqual([]);
    expect(rules('ALTER TABLE "t" ADD COLUMN "id2" integer GENERATED ALWAYS AS IDENTITY NOT NULL;')).toEqual([]);
    expect(rules('ALTER TABLE "t" ADD CONSTRAINT "c" CHECK ("x" IS NOT NULL);')).toEqual([]);
    expect(rules('ALTER TABLE "t" ADD COLUMN "note" text;')).toEqual([]);
    expect(rules('CREATE TABLE "t" ("id" uuid NOT NULL, "n" int NOT NULL);')).toEqual([]);
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

  it('separates deleted migrations (always a violation) from added/modified ones', () => {
    const out = 'A\tpackages/db/migrations/0002_new.sql\nM\tpackages/db/migrations/0001_x.sql\nD\tpackages/db/migrations/0000_old.sql\nM\tpackages/db/migrations/meta/_journal.json\n';
    expect(parseNameStatus(out)).toEqual({
      changed: ['packages/db/migrations/0002_new.sql', 'packages/db/migrations/0001_x.sql'],
      deleted: ['packages/db/migrations/0000_old.sql'],
    });
  });

  it('does not flag the migrations already on main', () => {
    const dir = join(__dirname, '..', 'packages', 'db', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      expect(checkSql(f, readFileSync(join(dir, f), 'utf8')), f).toEqual([]);
    }
  });
});
