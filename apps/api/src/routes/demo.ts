/**
 * Demo data (T075; US7) — owned by the Experience team.
 *
 *   POST /demo/seed   bid_manager+   → DemoSeedResponse
 *   DELETE /demo      bid_manager+   → DemoRemoveResponse (007/FR-065)
 *
 * Loads the sample company "Aarav Technologies Pvt Ltd" (profile, vault with generated PDFs, watchlists,
 * GeM-like tenders, matches, analyses, pipeline) into the current org via `seedDemo` from @tp/db/demo,
 * and marks `onboardingState.demo = true`. Idempotent — safe to call repeatedly.
 * `DELETE /demo` removes it again via `removeDemo` (only demo rows; the users' own rows stay), sets
 * `onboardingState.demo = false` and logs `demo.removed` — both inside the removal transaction, so they commit or
 * roll back with the deletes. Also idempotent: a second call answers all zeros and logs nothing.
 * Seed and removal lock the same org row, so they never interleave.
 */
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { organizations } from '@tp/db';
import { nothingRemoved, removeDemo, seedDemo } from '@tp/db/demo';
import type { DemoRemoveResponse, DemoSeedResponse } from '@tp/core/contracts/experience';
import { logActivity } from '../lib/activity';
import { orgId, requireRole, userId } from '../middleware/auth';
import type { AppEnv } from '../types';

export const demoRoutes = new Hono<AppEnv>();

demoRoutes.post('/demo/seed', requireRole('bid_manager'), async (c) => {
  const { db, blobs, clock } = c.var.deps;
  const org = orgId(c);
  const result = await seedDemo(db, {
    orgId: org,
    userId: userId(c),
    now: clock.now(),
    blobs: { put: (key, body, opts) => blobs.put(key, body, opts) },
    // In the seed transaction (under the org lock); jsonb_set on the stored value so a concurrent onboarding save is not lost.
    afterSeed: async (tx) => {
      await tx.update(organizations)
        .set({ onboardingState: sql`jsonb_set(coalesce(${organizations.onboardingState}, '{}'::jsonb), '{demo}', 'true'::jsonb)` })
        .where(eq(organizations.id, org));
    },
  });
  const body: DemoSeedResponse = { ok: true, ...result };
  return c.json(body, result.created ? 201 : 200);
});

demoRoutes.delete('/demo', requireRole('bid_manager'), async (c) => {
  const { db, blobs, logger } = c.var.deps;
  const org = orgId(c);
  const removed = await removeDemo(db, {
    orgId: org,
    blobs: { delete: (key) => blobs.delete(key) },
    onBlobError: (key, error) => logger.warn('demo blob delete failed', { key, error: String(error) }),
    // In the removal transaction: a failure here rolls the deletes back instead of answering 500 with the data gone.
    afterRemove: async (tx, result) => {
      // jsonb_set on the stored value (not a spread of the request's copy) so a concurrent onboarding save is not lost.
      await tx.update(organizations)
        .set({ onboardingState: sql`jsonb_set(coalesce(${organizations.onboardingState}, '{}'::jsonb), '{demo}', 'false'::jsonb)` })
        .where(eq(organizations.id, org));
      // Not marked meta.demo: the audit entry must survive a later removal. A repeat call that removed nothing logs nothing.
      if (!nothingRemoved(result)) {
        await logActivity(tx, { orgId: org, userId: userId(c), action: 'demo.removed', entityType: 'organization', entityId: org, meta: { ...result } });
      }
    },
  });
  const body: DemoRemoveResponse = { ok: true, removed };
  return c.json(body);
});
