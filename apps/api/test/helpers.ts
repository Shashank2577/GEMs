/**
 * API integration-test harness (real Postgres, FS blobs, no external providers).
 *
 *   const ctx = await createTestContext();          // migrate + truncate + build app
 *   const owner = await signup(ctx.app);             // { cookie, me, email, password }
 *   const analyst = await signup(ctx.app, { role: 'analyst', ownerCookie: owner.cookie });
 *   const res = await request(ctx.app, 'GET', '/api/auth/me', { cookie: owner.cookie });
 *   expect(res.status).toBe(200); res.body.user.email …
 *   afterAll(() => ctx.close());
 *
 * Uses TEST_DATABASE_URL (default postgres://tp:tp@localhost:5433/tenderpilot_test). Run
 * `scripts/local-pg.sh` first. Each test FILE should call createTestContext() once in beforeAll
 * (it truncates every table), or per test with `beforeEach` when isolation matters more than speed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { createNodeDb, type Db, type Role } from '@tp/db';
import { runMigrations } from '@tp/db/migrate';
import type { Me } from '@tp/core/contracts/auth';
import { createApp, type App } from '../src/app';
import type { AppDeps, GemLease, LlmClient } from '../src/deps';
import { loadConfig, loadGemConfig } from '../src/env';
import { createFsBlobStore } from '../src/adapters/blob-fs';
import { createFixedClock } from '../src/adapters/clock';
import { silentLogger } from '../src/adapters/logger';
import { createLogMailer } from '../src/adapters/mailer';
import { createLogWhatsApp } from '../src/adapters/whatsapp';
import { noopGemLease } from '../src/adapters/index';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://tp:tp@localhost:5433/tenderpilot_test';
export const TEST_APP_URL = 'http://tp.test';

const migrated = new Map<string, Promise<void>>();

/** Run migrations once per process per database, serialised across processes by an advisory lock. */
export function ensureMigrated(url = TEST_DATABASE_URL): Promise<void> {
  let p = migrated.get(url);
  if (!p) {
    p = (async () => {
      const { db, close } = await createNodeDb(url);
      // A dedicated connection holds the lock while the migrator runs on its own pool.
      const pool = (db as unknown as { $client: { connect(): Promise<{ query(q: string): Promise<unknown>; release(): void }> } }).$client;
      const client = await pool.connect();
      try {
        await client.query('select pg_advisory_lock(727001)');
        await runMigrations(url);
      } finally {
        await client.query('select pg_advisory_unlock(727001)').catch(() => {});
        client.release();
        await close();
      }
    })();
    migrated.set(url, p);
  }
  return p;
}

/** TRUNCATE every table in the public schema. */
export async function truncateAll(db: Db): Promise<void> {
  const res = await db.execute(sql`select tablename from pg_tables where schemaname = 'public'`);
  const rows = (res as unknown as { rows: { tablename: string }[] }).rows;
  if (!rows.length) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await db.execute(sql.raw(`truncate table ${list} restart identity cascade`));
}

export interface TestContextOptions {
  /** Provide an LLM fake (default null = rules-only mode). */
  llm?: LlmClient | null;
  /** Initial clock time (default: real now). The clock only moves when you call set/advance. */
  now?: Date | string;
  /** Skip truncation (e.g. a second context on the same DB). */
  keepData?: boolean;
  gemBaseUrl?: string;
  fetch?: typeof fetch;
  databaseUrl?: string;
  /** TRUST_PROXY for client-IP rate limiting (default unset = no trusted proxy, IP limits skipped). */
  trustProxy?: 'cloudflare' | 'xff';
  /** Cluster-wide GeM lease (008/FR-024). Default: never waits. Lease tests pass `(db) => createPgGemLease(db, …)`. */
  gemLease?: GemLease | ((db: Db) => GemLease);
  /** Extra env vars for loadConfig/loadGemConfig (e.g. `MANUAL_SYNC_COOLDOWN_MIN`). */
  env?: Record<string, string>;
}

export async function createTestContext(opts: TestContextOptions = {}) {
  const url = opts.databaseUrl ?? TEST_DATABASE_URL;
  await ensureMigrated(url);
  const { db, close } = await createNodeDb(url);
  if (!opts.keepData) await truncateAll(db);
  const blobDir = await mkdtemp(join(tmpdir(), 'tp-blobs-'));
  const clock = createFixedClock(opts.now ?? new Date());
  const mailer = createLogMailer(silentLogger);
  const whatsapp = createLogWhatsApp(silentLogger);
  const env = { APP_URL: TEST_APP_URL, NODE_ENV: 'test', GEM_BASE_URL: opts.gemBaseUrl ?? 'http://127.0.0.1:4010', GEM_MIN_INTERVAL_MS: '0', TRUST_PROXY: opts.trustProxy, ...opts.env };
  const deps: AppDeps = {
    db,
    blobs: createFsBlobStore(blobDir),
    llm: opts.llm ?? null,
    mailer,
    whatsapp,
    gem: loadGemConfig(env),
    clock,
    config: loadConfig(env),
    logger: silentLogger,
    fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
    gemLease: typeof opts.gemLease === 'function' ? opts.gemLease(db) : opts.gemLease ?? noopGemLease,
  };
  const app = createApp(deps);
  return {
    app, db, deps, clock, mailer, whatsapp, blobDir,
    async close() {
      await close();
      await rm(blobDir, { recursive: true, force: true });
    },
  };
}
export type TestContext = Awaited<ReturnType<typeof createTestContext>>;

// ───────────── HTTP helpers ─────────────

export interface RequestOptions {
  cookie?: string;
  /** API token (`tp_…`) sent as `Authorization: Bearer`. */
  bearer?: string;
  json?: unknown;
  /** multipart/form-data body: a FormData, or a record (Blob/File values become file parts). */
  form?: FormData | Record<string, string | Blob>;
  headers?: Record<string, string>;
}

export interface TestResponse<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
  /** `tp_session=…` cookie pair when the response set one. */
  cookie: string | null;
  res: Response;
}

/** Issue a request against the app. Paths without a leading `/api` are prefixed with it. */
export async function request<T = any>(app: App, method: string, path: string, opts: RequestOptions = {}): Promise<TestResponse<T>> {
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.bearer) headers.set('authorization', `Bearer ${opts.bearer}`);
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    if (opts.form instanceof FormData) body = opts.form;
    else {
      const fd = new FormData();
      for (const [k, v] of Object.entries(opts.form)) fd.append(k, v as string | Blob);
      body = fd;
    }
  }
  const url = `${TEST_APP_URL}${path.startsWith('/api') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`}`;
  const res = await app.request(url, { method, headers, body });
  const text = res.status === 204 ? '' : await res.clone().text();
  let parsed: unknown = text;
  if ((res.headers.get('content-type') ?? '').includes('application/json') && text) parsed = JSON.parse(text);
  return { status: res.status, body: parsed as T, text, headers: res.headers, cookie: sessionCookieFrom(res), res };
}

export function sessionCookieFrom(res: Response): string | null {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  for (const c of all) {
    const m = c.match(/(?:^|,\s*)(tp_session=[^;]*)/);
    if (m && m[1] !== 'tp_session=') return m[1];
  }
  return null;
}

// ───────────── Account helpers ─────────────

let seq = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}.${Date.now().toString(36)}.${++seq}@example.in`;
export const TEST_PASSWORD = 'correct-horse-42';

export interface SignupOptions {
  /** Role in the org. Non-owner roles are created by invitation from an owner. */
  role?: Role;
  name?: string;
  email?: string;
  password?: string;
  orgName?: string;
  /** Join this owner's org instead of creating a fresh one (for non-owner roles). */
  ownerCookie?: string;
}

export interface SignedUp {
  cookie: string;
  me: Me;
  email: string;
  password: string;
  /** Cookie of the owner who invited this user (non-owner roles). */
  ownerCookie: string;
}

/** Sign up a user (owner of a new org), or — with a non-owner `role` — invite them into an org and accept. */
export async function signup(app: App, opts: SignupOptions = {}): Promise<SignedUp> {
  const role = opts.role ?? 'owner';
  const email = opts.email ?? uniqueEmail(role);
  const password = opts.password ?? TEST_PASSWORD;
  const name = opts.name ?? `Test ${role.replace('_', ' ')}`;

  if (role === 'owner' && !opts.ownerCookie) {
    const r = await request<Me>(app, 'POST', '/api/auth/signup', { json: { name, email, password, orgName: opts.orgName ?? `Acme Traders ${seq}` } });
    if (r.status !== 201 || !r.cookie) throw new Error(`signup failed: ${r.status} ${r.text}`);
    return { cookie: r.cookie, me: r.body, email, password, ownerCookie: r.cookie };
  }

  const ownerCookie = opts.ownerCookie ?? (await signup(app, { orgName: opts.orgName })).cookie;
  const inv = await request(app, 'POST', '/api/org/invitations', { cookie: ownerCookie, json: { email, role } });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${inv.text}`);
  const token = String(inv.body.inviteUrl).split('/invite/')[1];
  const acc = await request<Me>(app, 'POST', '/api/auth/accept-invite', { json: { token, name, password } });
  if (acc.status !== 200 || !acc.cookie) throw new Error(`accept-invite failed: ${acc.status} ${acc.text}`);
  return { cookie: acc.cookie, me: acc.body, email, password, ownerCookie };
}

/** One org with a user per role. */
export async function seedOrgWithRoles(app: App, orgName?: string) {
  const owner = await signup(app, { orgName });
  const [bidManager, analyst, viewer] = await Promise.all(
    (['bid_manager', 'analyst', 'viewer'] as const).map((role) => signup(app, { role, ownerCookie: owner.cookie })),
  );
  return { owner, bidManager, analyst, viewer, orgId: owner.me.org.id };
}
