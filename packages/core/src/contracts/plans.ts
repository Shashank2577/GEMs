/**
 * Plans config (007/FR-086): the single source of truth for what TenderPilot sells. The landing page renders its
 * Pricing section from `PLANS`; the sign-up page reads `signupPlan()` for the trial note. Prices are monthly, in INR,
 * excluding GST. Limits are marketing limits shown on the card (enforcement lives with billing, not here).
 */

export type PlanKey = 'starter' | 'pro' | 'enterprise';

export interface PlanLimits {
  /** Team members; null = unlimited. */
  members: number | null;
  /** Watchlists; null = unlimited. */
  watchlists: number | null;
  /** Document vault storage in GB; null = not capped on the card. */
  vaultGb: number | null;
}

export interface Plan {
  key: PlanKey;
  name: string;
  /** Monthly price in INR excluding GST; null = "Custom" (talk to sales). */
  monthlyInr: number | null;
  blurb: string;
  features: readonly string[];
  limits: PlanLimits;
  cta: string;
  featured: boolean;
}

export const PLANS: readonly Plan[] = [
  {
    key: 'starter', name: 'Starter', monthlyInr: 2999, featured: false, cta: 'Start free trial',
    blurb: 'For a founder-led MSME bidding a few times a month.',
    features: ['3 team members', '5 watchlists', 'Email & in-app alerts', 'Go / No-Go scoring', 'Document vault (2 GB)', 'Bid packet builder'],
    limits: { members: 3, watchlists: 5, vaultGb: 2 },
  },
  {
    key: 'pro', name: 'Pro', monthlyInr: 7999, featured: true, cta: 'Start free trial',
    blurb: 'For growing teams bidding every week.',
    features: ['10 team members', 'Unlimited watchlists', 'WhatsApp alerts & daily digest', 'AI-assisted bid reading', 'Annexure templates', 'Chrome co-pilot', 'Pipeline & win-rate analytics'],
    limits: { members: 10, watchlists: null, vaultGb: null },
  },
  {
    key: 'enterprise', name: 'Enterprise', monthlyInr: null, featured: false, cta: 'Talk to sales',
    blurb: 'For OEMs, distributors and consultants with many entities.',
    features: ['Unlimited members & orgs', 'SSO & audit exports', 'Custom scoring rules', 'Dedicated success manager', 'Priority support (IST)'],
    limits: { members: null, watchlists: null, vaultGb: null },
  },
];

export const TRIAL_DAYS = 14;
export const GST_PERCENT = 18;
export const SALES_MAILTO = 'mailto:sales@tenderpilot.in?subject=TenderPilot%20Enterprise';
export const PRICING_NOTE = `Prices exclude ${GST_PERCENT}% GST. Every plan starts with a ${TRIAL_DAYS}-day free trial of Pro.`;

/** Plans a visitor can start a self-serve trial from (`/signup?plan=<key>`). */
export const TRIAL_PLAN_KEYS = ['starter', 'pro'] as const satisfies readonly PlanKey[];
export type TrialPlanKey = (typeof TRIAL_PLAN_KEYS)[number];

/** `₹2,999` (en-IN grouping) or `Custom`. */
export function formatPlanPrice(plan: Pick<Plan, 'monthlyInr'>): string {
  return plan.monthlyInr == null ? 'Custom' : `₹${plan.monthlyInr.toLocaleString('en-IN')}`;
}

/** Where a plan's CTA goes: `/signup?plan=starter|pro`, or the sales mailto for Enterprise. */
export function planCtaHref(plan: Pick<Plan, 'key'>): string {
  return plan.key === 'enterprise' ? SALES_MAILTO : `/signup?plan=${plan.key}`;
}

/** Validate a `?plan=` value; unknown / missing / enterprise → null (ignored). */
export function signupPlan(value: string | null | undefined): Plan | null {
  if (!value) return null;
  const key = value.toLowerCase();
  if (!(TRIAL_PLAN_KEYS as readonly string[]).includes(key)) return null;
  return PLANS.find((p) => p.key === key) ?? null;
}

/** Sign-up trial note for a known plan, e.g. "You’re starting a 14-day free trial of Pro — no card needed." */
export function trialNote(plan: Pick<Plan, 'name'>): string {
  return `You’re starting a ${TRIAL_DAYS}-day free trial of ${plan.name} — no card needed.`;
}
