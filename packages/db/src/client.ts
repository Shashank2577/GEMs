import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export type Db = ReturnType<typeof drizzlePg<typeof schema>>;
export { schema };

/** Local / CI / Node: node-postgres pool. */
export async function createNodeDb(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: url, max: 10 });
  const db = drizzlePg(pool, { schema });
  return { db, close: () => pool.end() };
}

/** Cloudflare Workers: Neon serverless Pool over WebSockets (supports transactions). */
export async function createNeonDb(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const { Pool } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-serverless');
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, close: () => pool.end() };
}
