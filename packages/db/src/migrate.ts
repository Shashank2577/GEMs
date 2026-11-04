import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createNodeDb } from './client';

export async function runMigrations(url: string) {
  const { db, close } = await createNodeDb(url);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  await close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL ?? 'postgres://tp:tp@localhost:5433/tenderpilot';
  runMigrations(url).then(() => console.log('migrations applied')).catch((e) => { console.error(e); process.exit(1); });
}
