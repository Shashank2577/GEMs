/** Shared front-end types mirroring contracts/api.md (core DTOs may replace these later). */
export type Role = 'owner' | 'bid_manager' | 'analyst' | 'viewer';
export type Verdict = 'go' | 'review' | 'no_go';
export type Stage = 'identified' | 'analysing' | 'go' | 'preparing' | 'ready' | 'submitted' | 'won' | 'lost' | 'dropped';

export interface Me {
  user: { id: string; name: string; email: string; phone: string | null };
  org: { id: string; name: string; slug: string; plan: string; onboardingState: Record<string, boolean>; trialEndsAt?: string | null };
  role: Role;
  orgs: { id: string; name: string; role: Role }[];
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  bid_manager: 'Bid manager',
  analyst: 'Analyst',
  viewer: 'Viewer',
};

export const STAGE_LABEL: Record<Stage, string> = {
  identified: 'Identified',
  analysing: 'Analysing',
  go: 'Go',
  preparing: 'Preparing',
  ready: 'Ready to submit',
  submitted: 'Submitted',
  won: 'Won',
  lost: 'Lost',
  dropped: 'Dropped',
};

export const STAGES: Stage[] = ['identified', 'analysing', 'go', 'preparing', 'ready', 'submitted', 'won', 'lost', 'dropped'];

export const VERDICT_LABEL: Record<Verdict, string> = { go: 'Go', review: 'Review', no_go: 'No-Go' };
