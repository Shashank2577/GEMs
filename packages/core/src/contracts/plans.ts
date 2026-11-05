/**
 * Plans: limits, trial length and the plan-expired allow-list (spec 008 FR-034, FR-035, FR-038, NFR-009).
 *
 * Spec 007 (FR-082) adds its `PLANS` pricing/display config to this same file; keep `PLAN_LIMITS` here as the single
 * source of truth for what each plan allows (API enforcement, `/org/usage`, the web meters).
 */

import { z } from 'zod';

export const PLAN_KEYS = ['trial', 'starter', 'pro', 'enterprise'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const isPlanKey = (v: unknown): v is PlanKey => typeof v === 'string' && (PLAN_KEYS as readonly string[]).includes(v);

/** Free trial length from sign-up (FR-035). */
export const TRIAL_DAYS = 14;

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Numeric limits; `null` = unlimited. */
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
 * Beyond FR-038: `POST /tenders/:id/seen` (a read receipt, like notifications read) and `/admin/*` (operator token).
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
