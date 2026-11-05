/**
 * `pnpm db:seed` — creates the demo login and loads the demo dataset (T075).
 *
 *   DATABASE_URL=postgres://… BLOB_DIR=.data/blobs pnpm db:seed
 *
 * Login: demo@tenderpilot.in / Demo@12345 (org "Aarav Technologies Pvt Ltd", role owner).
 * Idempotent: re-running refreshes tender dates and fills anything missing, never duplicates.
 * Vault PDFs are written to BLOB_DIR (default <repo>/.data/blobs — the Node server's default) in the same
 * layout as the API's filesystem blob store. On Cloudflare, seed from the app instead (POST /api/demo/seed),
 * which writes the PDFs to R2.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { createNodeDb } from './client';
import { runMigrations } from './migrate';
import { memberships, notificationPrefs, organizations, users } from './schema';
import { seedDemo, DEMO_COMPANY, type DemoBlobSink } from './demo';

export const DEMO_EMAIL = 'demo@tenderpilot.in';
export const DEMO_PASSWORD = 'Demo@12345';
export const DEMO_ORG_SLUG = 'aarav-technologies-demo';

// Same format as apps/api/src/lib/crypto.ts: pbkdf2_sha256$<iterations>$<salt b64url>$<hash b64url>
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function hashPasswordPbkdf2(password: string, iterations = 100_000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2_sha256$${iterations}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

/** Minimal filesystem sink compatible with the API's `createFsBlobStore` (file + `.meta.json` sidecar). */
export function fsBlobSink(rootDir: string): DemoBlobSink {
  const root = resolve(rootDir);
  return {
    async put(key, body, opts) {
      const p = resolve(join(root, key));
      if (!p.startsWith(root + '/')) throw new Error('Invalid blob key');
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, body);
      await writeFile(`${p}.meta.json`, JSON.stringify({ contentType: opts?.contentType ?? 'application/pdf' }));
    },
  };
}

export async function seedDemoAccount(url: string, opts: { blobDir?: string | null; now?: Date } = {}) {
  await runMigrations(url);
  const { db, close } = await createNodeDb(url);
  try {
    let [user] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL));
    if (!user) {
      [user] = await db.insert(users).values({ email: DEMO_EMAIL, name: 'Rohan Deshmukh', passwordHash: await hashPasswordPbkdf2(DEMO_PASSWORD), phone: '+919822012345' }).returning();
    }
    let [org] = await db.select().from(organizations).where(eq(organizations.slug, DEMO_ORG_SLUG));
    if (!org) {
      [org] = await db.insert(organizations).values({
        name: DEMO_COMPANY.legalName, slug: DEMO_ORG_SLUG, plan: 'pro',
        onboardingState: { company: true, categories: true, watchlist: true, documents: true, completed: true, demo: true },
      }).returning();
    }
    const [m] = await db.select().from(memberships).where(and(eq(memberships.orgId, org!.id), eq(memberships.userId, user!.id)));
    if (!m) await db.insert(memberships).values({ orgId: org!.id, userId: user!.id, role: 'owner' });
    await db.insert(notificationPrefs).values({ orgId: org!.id, userId: user!.id }).onConflictDoNothing();
    const result = await seedDemo(db, { orgId: org!.id, userId: user!.id, blobs: opts.blobDir ? fsBlobSink(opts.blobDir) : null, now: opts.now });
    return { userId: user!.id, orgId: org!.id, ...result };
  } finally {
    await close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL ?? 'postgres://tp:tp@localhost:5433/tenderpilot';
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const blobDir = process.env.BLOB_DIR ? resolve(repoRoot, process.env.BLOB_DIR) : resolve(repoRoot, '.data/blobs');
  seedDemoAccount(url, { blobDir })
    .then((r) => {
      console.log(`Demo data ready: ${r.tenders} tenders, ${r.matches} matches, ${r.analyses} analyses, ${r.workspaces} workspaces, ${r.vaultDocuments} vault documents.`);
      console.log(`Sign in with ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
