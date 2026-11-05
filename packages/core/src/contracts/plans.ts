/**
 * Plans, one file for both specs:
 *  - 008 (FR-034, FR-035, FR-038, NFR-009): `PLAN_LIMITS`, trial length, the plan-expired allow-list — the single source
 *    of truth for what each plan allows (API enforcement, `/org/usage`, the web meters);
 *  - 007 (FR-086): the `PLANS` pricing/display config at the bottom (landing page, sign-up, Settings).
 */

import { z } from 'zod';

export const PLAN_KEYS = ['trial', 'starter', 'pro', 'enterprise'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const isPlanKey = (v: unknown): v is PlanKey => typeof v === 'string' && (PLAN_KEYS as readonly string[]).includes(v);

/** Free trial length from sign-up (FR-035). */
export const TRIAL_DAYS = 14;

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * Every org's hard cap on watchlists (003/FR-027 → 409 `watchlist_limit`), whatever its plan. A plan's
 * `watchlists: null` means "no plan limit"; this cap still applies (FR-034 note).
 */
export const WATCHLIST_LIMIT = 50;

/** Numeric limits; `null` = no plan limit (watchlists stay capped at `WATCHLIST_LIMIT`, see `effectiveLimit`). */
export interface PlanLimits {
  /** Members + pending invitations. */
  seats: number | null;
  watchlists: number | null;
  /** Analyses created in the IST calendar month. */
  analysesPerMonth: number | null;
  /** Analyses that used the LLM in the IST calendar month; beyond it analyses run rules-only (FR-037). */
  llmAnalysesPerMonth: number | null;
  /** Vault storage (current files + kept versions). */
  vaultBytes: number | null;
  /** Packets built in the IST calendar month. */
  packetsPerMonth: number | null;
  whatsapp: boolean;
}

export type PlanLimitKey = Exclude<keyof PlanLimits, 'whatsapp'>;

/** FR-034 launch defaults. */
export const PLAN_LIMITS: Readonly<Record<PlanKey, Readonly<PlanLimits>>> = {
  trial: { seats: 10, watchlists: null, analysesPerMonth: 10, llmAnalysesPerMonth: 10, vaultBytes: 1 * GB, packetsPerMonth: 10, whatsapp: true },
  starter: { seats: 3, watchlists: 5, analysesPerMonth: 100, llmAnalysesPerMonth: 50, vaultBytes: 2 * GB, packetsPerMonth: 30, whatsapp: false },
  pro: { seats: 10, watchlists: null, analysesPerMonth: 500, llmAnalysesPerMonth: 250, vaultBytes: 10 * GB, packetsPerMonth: 200, whatsapp: true },
  enterprise: { seats: null, watchlists: null, analysesPerMonth: null, llmAnalysesPerMonth: null, vaultBytes: null, packetsPerMonth: null, whatsapp: true },
};

/** The cap that actually applies to a metered quantity: the plan limit, or the 003/FR-027 cap for watchlists. */
export function effectiveLimit(key: PlanLimitKey, planMax: number | null): number | null {
  if (key === 'watchlists') return planMax == null ? WATCHLIST_LIMIT : Math.min(planMax, WATCHLIST_LIMIT);
  return planMax;
}

/** Limits of a stored plan string; unknown values are treated as `trial`. */
export const limitsFor = (plan: string | null | undefined): Readonly<PlanLimits> => PLAN_LIMITS[isPlanKey(plan) ? plan : 'trial'];

/** Short plan names used in messages and badges. */
export const PLAN_NAMES: Record<PlanKey, string> = { trial: 'Free trial', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' };

// ───────────── IST calendar month (monthly counters reset at 00:00 IST on the 1st) ─────────────

const IST_OFFSET_MS = 330 * 60_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `[start, end)` of the IST calendar month containing `now`, as UTC instants. */
export function istMonthPeriod(now: Date): { start: Date; end: Date } {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS),
    end: new Date(Date.UTC(y, m + 1, 1) - IST_OFFSET_MS),
  };
}

/** "19 Nov 2026" in IST; with `year: false` → "1 Dec". */
export function planDateIST(d: Date | string, opts: { year?: boolean } = {}): string {
  const t = new Date(new Date(d).getTime() + IST_OFFSET_MS);
  const base = `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
  return opts.year === false ? base : `${base} ${t.getUTCFullYear()}`;
}

/** Trial end for an org signed up at `createdAt` (FR-035: created + 14 × 24 h). */
export const trialEndsAtFor = (createdAt: Date): Date => new Date(createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

/** FR-038: the workspace is read-only when a trial's end has passed. Never for paid plans. */
export function isTrialExpired(org: { plan: string; trialEndsAt: Date | string | null | undefined }, now: Date): boolean {
  if (org.plan !== 'trial' || !org.trialEndsAt) return false;
  return new Date(org.trialEndsAt).getTime() < now.getTime();
}

/** Whole IST days left until `trialEndsAt` (0 on the last day, negative once ended). */
export function trialDaysLeft(trialEndsAt: Date | string, now: Date): number {
  const day = (d: Date) => Math.floor((d.getTime() + IST_OFFSET_MS) / 86_400_000);
  return day(new Date(trialEndsAt)) - day(now);
}

// ───────────── 402 messages (FR-036, FR-038) ─────────────

export const PLAN_EXPIRED_MESSAGE = (trialEndsAt: Date | string) =>
  `Your free trial ended on ${planDateIST(trialEndsAt)}. Your data is safe and read-only — talk to us to choose a plan.`;

export interface PlanLimitDetails {
  limit: PlanLimitKey;
  used: number;
  max: number;
  plan: PlanKey;
  /** End of the IST month for monthly limits. */
  resetsAt?: string;
}

const fmtBytes = (n: number) => (n >= GB ? `${+(n / GB).toFixed(2)} GB` : `${Math.round(n / MB)} MB`);

export function planLimitMessage(d: PlanLimitDetails): string {
  const plan = `Your ${PLAN_NAMES[d.plan]}${d.plan === 'trial' ? '' : ' plan'}`;
  const wait = d.resetsAt ? `, or wait until ${planDateIST(d.resetsAt, { year: false })}` : '';
  switch (d.limit) {
    case 'analysesPerMonth':
      return `${plan} includes ${d.max} analyses a month. You've used ${d.used}. Talk to us to upgrade${wait}.`;
    case 'llmAnalysesPerMonth':
      return `${plan} includes ${d.max} AI analyses a month. You've used ${d.used}. Talk to us to upgrade${wait}.`;
    case 'packetsPerMonth':
      return `${plan} includes ${d.max} packets a month. You've used ${d.used}. Talk to us to upgrade${wait}.`;
    case 'watchlists':
      return `${plan} includes ${d.max} watchlists. You have ${d.used}. Talk to us to upgrade, or delete a watchlist you no longer need.`;
    case 'seats':
      return `${plan} includes ${d.max} seats (members and pending invitations). You're using ${d.used}. Talk to us to upgrade, or remove a member or invitation.`;
    case 'vaultBytes':
      return `${plan} includes ${fmtBytes(d.max)} of vault storage. You're using ${fmtBytes(d.used)} and this file doesn't fit. Talk to us to upgrade, or delete old documents.`;
  }
}

/** Human labels of the six usage meters (Settings → Plan & usage). */
export const USAGE_LABELS: Record<PlanLimitKey, string> = {
  analysesPerMonth: 'Analyses this month',
  llmAnalysesPerMonth: 'AI analyses this month',
  watchlists: 'Watchlists',
  seats: 'Seats',
  vaultBytes: 'Vault storage',
  packetsPerMonth: 'Packets this month',
};

// ───────────── Expired-trial allow-list (FR-038) ─────────────

/**
 * Writes still allowed while a trial is expired. Paths are relative to `/api` (no prefix).
 * Beyond FR-038's original list (all documented in FR-038 and contracts/api.md): `POST /tenders/:id/seen` (a read
 * receipt, like notifications read), `/admin/*` (operator token, its own auth), and the two writes that only reduce
 * usage — `DELETE /org/members/me` (leave the org) and `DELETE /org/invitations/:id` (revoke a pending invitation).
 */
const EXPIRED_ALLOWED: { method: string | '*'; re: RegExp }[] = [
  { method: '*', re: /^\/auth(\/|$)/ },
  { method: 'PATCH', re: /^\/me$/ },
  { method: 'POST', re: /^\/me\/password$/ },
  { method: '*', re: /^\/me\/sessions(\/|$)/ },
  { method: 'DELETE', re: /^\/me\/api-tokens\/[^/]+$/ },
  { method: 'POST', re: /^\/notifications\/[^/]+\/read$/ },
  { method: 'POST', re: /^\/notifications\/read-all$/ },
  { method: 'PUT', re: /^\/me\/notification-prefs$/ },
  { method: 'DELETE', re: /^\/demo$/ },
  { method: 'POST', re: /^\/tenders\/[^/]+\/seen$/ },
  { method: '*', re: /^\/admin(\/|$)/ },
  { method: 'DELETE', re: /^\/org\/members\/me$/ },
  { method: 'DELETE', re: /^\/org\/invitations\/[^/]+$/ },
];

/** True when `method path` may run on an expired trial. `path` may include the `/api` prefix and a query string. */
export function allowedWhenExpired(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const p = path.split('?')[0]!.replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/';
  return EXPIRED_ALLOWED.some((a) => (a.method === '*' || a.method === m) && a.re.test(p));
}

// ───────────── GET /org/usage (FR-039) ─────────────

export interface OrgUsage {
  seats: number;
  watchlists: number;
  analysesThisMonth: number;
  llmAnalysesThisMonth: number;
  vaultBytes: number;
  packetsThisMonth: number;
  llmTokensThisMonth: { input: number; output: number };
}

export interface OrgUsageResponse {
  plan: PlanKey;
  trialEndsAt: string | null;
  period: { start: string; end: string };
  usage: OrgUsage;
  limits: PlanLimits;
}

/** Which usage field a limit is measured against. */
export const USAGE_FIELD: Record<PlanLimitKey, keyof Omit<OrgUsage, 'llmTokensThisMonth'>> = {
  seats: 'seats',
  watchlists: 'watchlists',
  analysesPerMonth: 'analysesThisMonth',
  llmAnalysesPerMonth: 'llmAnalysesThisMonth',
  vaultBytes: 'vaultBytes',
  packetsPerMonth: 'packetsThisMonth',
};

export const MONTHLY_LIMITS: readonly PlanLimitKey[] = ['analysesPerMonth', 'llmAnalysesPerMonth', 'packetsPerMonth'];

// ───────────── POST /admin/orgs/:id/plan (FR-042) ─────────────

export const adminPlanInputSchema = z.object({
  plan: z.enum(PLAN_KEYS),
  note: z.string().trim().min(1, 'Add a note (e.g. the invoice number)').max(500),
  /** Only for `trial`: when the (extended) trial ends. Ignored for paid plans, whose trial end is cleared. */
  trialEndsAt: z.string().datetime({ offset: true }).optional(),
});
export type AdminPlanInput = z.infer<typeof adminPlanInputSchema>;

export interface AdminPlanResponse {
  org: { id: string; plan: PlanKey; trialEndsAt: string | null };
  subscriptionId: string;
}

// ───────────── Pricing display config (007/FR-086) ─────────────
//
// The landing page renders its Pricing section from `PLANS`; the sign-up page reads `signupPlan()` for the trial note.
// Prices are monthly, in INR, excluding GST. Card limits are what the card shows; enforcement uses `PLAN_LIMITS` above
// (plans.test.ts checks the two agree).

/** Plans sold on the pricing page (the trial is not a priced plan). */
export type PricedPlanKey = Exclude<PlanKey, 'trial'>;

export interface PlanCardLimits {
  /** Team members; null = unlimited. */
  members: number | null;
  /** Watchlists; null = unlimited. */
  watchlists: number | null;
  /** Document vault storage in GB; null = not capped on the card. */
  vaultGb: number | null;
}

export interface Plan {
  key: PricedPlanKey;
  name: string;
  /** Monthly price in INR excluding GST; null = "Custom" (talk to sales). */
  monthlyInr: number | null;
  blurb: string;
  features: readonly string[];
  limits: PlanCardLimits;
  cta: string;
  featured: boolean;
}

// Monthly caps on the cards come from PLAN_LIMITS, so the published numbers are the enforced ones (review S6).
const capLine = (k: PlanKey) => `${PLAN_LIMITS[k].analysesPerMonth} analyses a month (${PLAN_LIMITS[k].llmAnalysesPerMonth} AI-assisted)`;
const packetLine = (k: PlanKey) => `${PLAN_LIMITS[k].packetsPerMonth} bid packets a month`;

export const PLANS: readonly Plan[] = [
  {
    key: 'starter', name: 'Starter', monthlyInr: 2999, featured: false, cta: 'Start free trial',
    blurb: 'For a founder-led MSME bidding a few times a month.',
    features: ['3 team members', '5 watchlists', capLine('starter'), packetLine('starter'), 'Email & in-app alerts', 'Go / No-Go scoring', 'Document vault (2 GB)', 'Bid packet builder'],
    limits: { members: 3, watchlists: 5, vaultGb: 2 },
  },
  {
    key: 'pro', name: 'Pro', monthlyInr: 7999, featured: true, cta: 'Start free trial',
    blurb: 'For growing teams bidding every week.',
    features: ['10 team members', `Up to ${WATCHLIST_LIMIT} watchlists`, capLine('pro'), packetLine('pro'), 'WhatsApp alerts & daily digest', 'AI-assisted bid reading', 'Annexure templates', 'Chrome co-pilot', 'Pipeline & win-rate analytics'],
    limits: { members: 10, watchlists: null, vaultGb: null },
  },
  {
    key: 'enterprise', name: 'Enterprise', monthlyInr: null, featured: false, cta: 'Talk to sales',
    blurb: 'For OEMs, distributors and consultants with many entities.',
    features: ['Unlimited members & orgs', 'SSO & audit exports', 'Custom scoring rules', 'Dedicated success manager', 'Priority support (IST)'],
    limits: { members: null, watchlists: null, vaultGb: null },
  },
];

export const GST_PERCENT = 18;
export const SALES_MAILTO = 'mailto:sales@tenderpilot.in?subject=TenderPilot%20Enterprise';
/** The trial is its own plan (PLAN_LIMITS.trial): name its caps rather than promising "Pro" (review S6). */
export const PRICING_NOTE = `Prices exclude ${GST_PERCENT}% GST. Every plan starts with a ${TRIAL_DAYS}-day free trial — ${PLAN_LIMITS.trial.analysesPerMonth} analyses and ${PLAN_LIMITS.trial.vaultBytes! / GB} GB of vault included.`;

/** Plans a visitor can start a self-serve trial from (`/signup?plan=<key>`). */
export const TRIAL_PLAN_KEYS = ['starter', 'pro'] as const satisfies readonly PricedPlanKey[];
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

/**
 * Sign-up trial note for a known plan, e.g. "You’re starting a 14-day free trial of Pro — no card needed. The trial
 * includes 10 analyses and 1 GB of vault; Pro’s limits apply once you move to it." The first sentence is 007 US6
 * scenario 11's wording; the second says the org gets the trial's own limits (PLAN_LIMITS.trial), not the chosen
 * plan's (review NIT-d).
 */
export function trialNote(plan: Pick<Plan, 'name'>): string {
  const t = PLAN_LIMITS.trial;
  return `You’re starting a ${TRIAL_DAYS}-day free trial of ${plan.name} — no card needed. `
    + `The trial includes ${t.analysesPerMonth} analyses and ${t.vaultBytes! / GB} GB of vault; ${plan.name}’s limits apply once you move to it.`;
}
