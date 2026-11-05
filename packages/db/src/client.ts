import type { Logger } from 'drizzle-orm/logger';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export type Db = ReturnType<typeof drizzlePg<typeof schema>>;
export { schema };

/**
 * The one database factory (008/FR-075, ADR-0002): node-postgres `pg` Pool, used by Node (local, CI, E2E) and by the
 * Cloudflare Worker, where `url` is the Hyperdrive binding's `connectionString` (pg runs under `nodejs_compat`).
 * `max` is the pool size: 10 for the long-lived Node server; the Worker opens a small per-request pool (5) because
 * Hyperdrive, not the isolate, owns the pool of origin connections to Neon.
 * `logger` sees every query (e.g. query counting in tests, 002/NFR-001).
 */
export async function createNodeDb(url: string, opts: { logger?: Logger; max?: number } = {}): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: url, max: opts.max ?? 10 });
  const db = drizzlePg(pool, { schema, logger: opts.logger });
  return { db, close: () => pool.end() };
}
