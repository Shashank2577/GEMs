/**
 * Demo data (T075; US7) — owned by the Experience team.
 *
 *   POST /demo/seed   bid_manager+   → DemoSeedResponse
 *
 * Loads the sample company "Aarav Technologies Pvt Ltd" (profile, vault with generated PDFs, watchlists,
 * GeM-like tenders, matches, analyses, pipeline) into the current org via `seedDemo` from @tp/db/demo,
 * and marks `onboardingState.demo = true`. Idempotent — safe to call repeatedly.
 */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { organizations } from '@tp/db';
import { seedDemo } from '@tp/db/demo';
import type { DemoSeedResponse } from '@tp/core/contracts/experience';
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
  });
  await db.update(organizations)
    .set({ onboardingState: { ...(c.var.org.onboardingState ?? {}), demo: true } })
    .where(eq(organizations.id, org));
  const body: DemoSeedResponse = { ok: true, ...result };
  return c.json(body, result.created ? 201 : 200);
});
