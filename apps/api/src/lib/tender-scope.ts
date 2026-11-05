/**
 * Which tenders an org may see (008/FR-016, Constitution IV).
 *
 * `tenders` is global public data, except the demo dataset (`source = 'demo'`, packages/db/src/demo.ts), which only
 * orgs that loaded the demo (`onboarding_state.demo = true`) may see. Every tender read path that lists or counts
 * tenders adds `visibleTenderSource(org)`; platform-wide counts and matching use `REAL_ONLY` (not demo).
 */
import { and, eq, ne, or, sql, type SQL } from 'drizzle-orm';
import { tenders } from '@tp/db';

export const GEM_SOURCE = 'gem';
export const DEMO_SOURCE = 'demo';

/**
 * Only real tenders (anything that is not demo data — today `gem`): platform-wide counts and watchlist matching.
 * Rows still marked `raw.demo = true` (or carrying the seeder's `content_hash = 'demo-' || bid_number`) are excluded
 * whatever their source, so a demo row re-seeded by old code after the data-fix stays invisible.
 */
export const REAL_ONLY: SQL = and(
  ne(tenders.source, DEMO_SOURCE),
  sql`coalesce(${tenders.raw}->>'demo', '') <> 'true'`,
  // The seeder's other fingerprint (packages/db/src/demo.ts): a demo row whose raw marker was lost.
  sql`${tenders.contentHash} <> 'demo-' || ${tenders.bidNumber}`,
)!;

/** The caller's org as far as tender visibility goes (`c.var.org` satisfies it). */
export type TenderViewer = { onboardingState?: Record<string, boolean> | null };

/** True when the org loaded the demo dataset. */
export const orgHasDemo = (org: { onboardingState?: Record<string, boolean> | null } | null | undefined): boolean =>
  org?.onboardingState?.demo === true;

/** Real tenders, plus `source = 'demo'` for orgs that loaded the demo. */
export function visibleTenderSource(org: { onboardingState?: Record<string, boolean> | null } | null | undefined): SQL {
  return orgHasDemo(org) ? or(REAL_ONLY, eq(tenders.source, DEMO_SOURCE))! : REAL_ONLY;
}

/** Same rule for one loaded row (detail routes). */
export function canSeeTender(
  org: TenderViewer | null | undefined,
  t: { source: string; raw?: Record<string, unknown> | null; contentHash?: string; bidNumber?: string },
): boolean {
  if (t.source === DEMO_SOURCE) return orgHasDemo(org);
  if (t.contentHash !== undefined && t.bidNumber !== undefined && t.contentHash === `demo-${t.bidNumber}`) return false;
  return t.raw?.demo !== true && t.raw?.demo !== 'true';
}
