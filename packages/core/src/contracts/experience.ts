/**
 * Experience-module contracts (T070, T075; US6/US7): dashboard aggregates and demo seed.
 * See specs/001-gem-tender-copilot/contracts/api.md § Dashboard & demo.
 */
import type { ActivityItem } from './auth';

export type DashboardStage = 'identified' | 'analysing' | 'go' | 'preparing' | 'ready' | 'submitted' | 'won' | 'lost' | 'dropped';
export type DashboardVerdict = 'go' | 'review' | 'no_go';

export interface DashboardTiles {
  /** Distinct tenders matched since IST midnight (not dismissed). */
  newMatchesToday: number;
  /** Matched or in-pipeline open tenders closing within 7 days. */
  closingThisWeek: number;
  /** Workspaces not won / lost / dropped. */
  activeBids: number;
  /** Sum of EMD (₹) on active bids. */
  emdAtStake: number;
  /** won / (won + lost) × 100, rounded; null until an outcome is recorded. */
  winRate: number | null;
  /** Vault documents expired or expiring within 30 days. */
  expiringDocs: number;
}

export interface DashboardTenderRef {
  id: string;
  bidNumber: string;
  title: string;
  buyer: string | null;
  state: string | null;
  endAt: string | null;
  emdAmount: number | null;
  estimatedValue: number | null;
  analysis: { score: number | null; verdict: DashboardVerdict | null } | null;
  workspace: { id: string; stage: DashboardStage } | null;
}

export interface DashboardMatch extends DashboardTenderRef {
  watchlistName: string;
  reasons: string[];
  matchedAt: string;
  isNew: boolean;
}

export interface DashboardExpiringDoc {
  id: string; title: string; type: string; expiryDate: string; daysToExpiry: number; status: 'expiring' | 'expired';
}

export interface DashboardActivity extends ActivityItem {
  /** Human label + in-app link for the entity, resolved server-side when possible. */
  target: { label: string; href: string } | null;
}

export interface SetupStep { key: string; label: string; description: string; done: boolean; href: string }

/** Keys allowed in `organizations.onboarding_state` (FR-048). */
export const ONBOARDING_KEYS = ['company', 'categories', 'watchlist', 'documents', 'skipped', 'completed', 'demo'] as const;
export type OnboardingKey = (typeof ONBOARDING_KEYS)[number];

/** A bid assigned to the signed-in user, shown in "My work" (FR-065). */
export interface MyWorkItem {
  workspaceId: string;
  tenderId: string;
  bidNumber: string;
  title: string;
  stage: DashboardStage;
  dueAt: string | null;
  endAt: string | null;
}

/** A bid waiting on a Go / No-go decision (FR-065). */
export interface DecisionItem {
  tenderId: string;
  workspaceId: string | null;
  bidNumber: string;
  title: string;
  score: number | null;
  verdict: DashboardVerdict | null;
  endAt: string | null;
}

/** Rows removed by `DELETE /api/demo` (007/FR-065). All zeros (and `profileReset: false`) when there was nothing left. */
export interface DemoRemovedCounts {
  workspaces: number;
  analyses: number;
  matches: number;
  comments: number;
  notifications: number;
  activity: number;
  pastContracts: number;
  vaultDocuments: number;
  watchlists: number;
  /** True when the company profile still held the demo company and was reset to empty (US4-14). */
  profileReset: boolean;
}

/** Result of removing the demo dataset: `DELETE /api/demo` (007/FR-065). Demo tenders are global and stay. */
export interface DemoRemoveResponse {
  ok: true;
  removed: DemoRemovedCounts;
}

export interface DashboardResponse {
  generatedAt: string;
  tiles: DashboardTiles;
  /** Extra numbers behind the tiles (for deltas and hints). */
  stats: {
    newMatchesYesterday: number;
    closingToday: number;
    won: number;
    lost: number;
    expiredDocs: number;
    analysesThisWeek: number;
    openTenders: number;
  };
  closingSoon: DashboardTenderRef[];
  pipeline: Record<DashboardStage, number>;
  /** Sum of estimated value (₹) per stage. */
  pipelineValue: Record<DashboardStage, number>;
  verdicts: Record<DashboardVerdict, number>;
  /** Last 14 IST days, oldest first, `date` = YYYY-MM-DD. */
  matchesByDay: { date: string; count: number }[];
  recentMatches: DashboardMatch[];
  expiringDocuments: DashboardExpiringDoc[];
  activity: DashboardActivity[];
  setup: SetupStep[];
  setupComplete: boolean;
  /** True when the org loaded the demo dataset. */
  demo: boolean;
  /** Bids assigned to the signed-in user (FR-065). */
  myWork?: MyWorkItem[];
  /** Bids awaiting a Go / No-go decision (FR-065). */
  awaitingDecision?: DecisionItem[];
}

export interface DemoSeedResponse {
  ok: true;
  created: boolean;
  tenders: number;
  watchlists: number;
  matches: number;
  analyses: number;
  workspaces: number;
  vaultDocuments: number;
  pastContracts: number;
}
