/**
 * Which tenders an org may see (008/FR-016, Constitution IV).
 *
 * `tenders` is global public data, except the demo dataset (`source = 'demo'`, packages/db/src/demo.ts), which only
 * orgs that loaded the demo (`onboarding_state.demo = true`) may see. Every tender read path that lists or counts
 * tenders adds `visibleTenderSource(org)`; platform-wide counts use `GEM_ONLY`.
 */
import { eq, inArray, type SQL } from 'drizzle-orm';
import { tenders } from '@tp/db';

export const GEM_SOURCE = 'gem';
export const DEMO_SOURCE = 'demo';

/** Only real (ingested) GeM tenders: platform-wide counts and watchlist matching. */
export const GEM_ONLY: SQL = eq(tenders.source, GEM_SOURCE);

/** True when the org loaded the demo dataset. */
export const orgHasDemo = (org: { onboardingState?: Record<string, boolean> | null } | null | undefined): boolean =>
  org?.onboardingState?.demo === true;

/** `source = 'gem'`, plus `source = 'demo'` for orgs that loaded the demo. */
export function visibleTenderSource(org: { onboardingState?: Record<string, boolean> | null } | null | undefined): SQL {
  return orgHasDemo(org) ? inArray(tenders.source, [GEM_SOURCE, DEMO_SOURCE]) : GEM_ONLY;
}

/** Same rule for one loaded row (detail routes). */
export function canSeeTender(org: { onboardingState?: Record<string, boolean> | null } | null | undefined, t: { source: string }): boolean {
  return t.source === GEM_SOURCE || (t.source === DEMO_SOURCE && orgHasDemo(org));
}
