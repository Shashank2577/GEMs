/**
 * Plan limits on the web (spec 008 FR-041): a tiny store behind the global `PlanLimitDialog` (opened by any 402) and
 * pure helpers for the trial banner and the Plan & usage meters. No React components here, so `lib/api.ts` and the
 * toaster can import it without cycles.
 */
import { useSyncExternalStore } from 'react';
import {
  PLAN_EXPIRED_MESSAGE, PLAN_NAMES, USAGE_LABELS, effectiveLimit, isPlanKey, isTrialExpired, planDateIST, trialDaysLeft,
  type PlanLimitKey,
} from '@tp/core/contracts/plans';

export const SALES_MAILTO = 'mailto:sales@tenderpilot.in?subject=TenderPilot%20plan';

// ───────────── dialog store ─────────────

export interface PlanLimitDialogState {
  code: 'plan_limit_reached' | 'plan_expired';
  title: string;
  message: string;
  /** "10 / 10 analyses this month"; null when the error carries no usage (e.g. plan_expired). */
  usage: string | null;
}

/** Minimal shape of an `ApiError` (avoids importing lib/api). */
export interface PaymentRequiredLike { status: number; code: string; message: string; details?: unknown }

let current: PlanLimitDialogState | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function isPaymentRequired(err: unknown): err is PaymentRequiredLike {
  return !!err && typeof err === 'object' && (err as PaymentRequiredLike).status === 402;
}

/** Dialog content for a 402 error. */
export function planLimitDialogContent(err: PaymentRequiredLike): PlanLimitDialogState {
  const expired = err.code === 'plan_expired';
  const d = (err.details ?? {}) as { limit?: unknown; used?: unknown; max?: unknown };
  const limit = typeof d.limit === 'string' && d.limit in USAGE_LABELS ? (d.limit as PlanLimitKey) : null;
  const usage = !expired && limit && typeof d.used === 'number' && typeof d.max === 'number'
    ? `${formatUsageValue(limit, d.used)} / ${formatUsageValue(limit, d.max)} ${USAGE_UNIT[limit]}`
    : null;
  return {
    code: expired ? 'plan_expired' : 'plan_limit_reached',
    title: expired ? 'Your trial has ended' : 'Plan limit reached',
    message: err.message,
    usage,
  };
}

/** Open the plan dialog for a 402 (`plan_limit_reached` / `plan_expired`). */
export function showPlanLimit(err: PaymentRequiredLike): void {
  current = planLimitDialogContent(err);
  emit();
}

export function closePlanLimit(): void {
  current = null;
  emit();
}

export function usePlanLimitDialog(): PlanLimitDialogState | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => current, () => null);
}

/** True while the dialog shows `message` — call sites' error toasts with the same text are suppressed. */
export function isShownInPlanDialog(message: unknown): boolean {
  return current !== null && typeof message === 'string' && message === current.message;
}

// ───────────── expired trial (FR-038 on the client) ─────────────

export interface PlanOrg { plan: string; trialEndsAt?: string | null }

export function planExpired(org: PlanOrg | null | undefined, now = new Date()): boolean {
  return !!org && isTrialExpired({ plan: org.plan, trialEndsAt: org.trialEndsAt ?? null }, now);
}

/** The 402 the server would answer, built locally so write buttons open the dialog without calling the API. */
export function localPlanExpiredError(org: PlanOrg): PaymentRequiredLike & { details: { plan: 'trial'; trialEndsAt: string } } {
  const trialEndsAt = new Date(org.trialEndsAt!).toISOString();
  return { status: 402, code: 'plan_expired', message: PLAN_EXPIRED_MESSAGE(trialEndsAt), details: { plan: 'trial', trialEndsAt } };
}

// ───────────── trial banner (US5 scenarios 7–8) ─────────────

export type TrialBanner =
  | { kind: 'expired'; text: string }
  | { kind: 'ending'; text: string; dismissKey: string }
  | null;

export const TRIAL_BANNER_DAYS = 7;
export const EXPIRED_BANNER_TEXT = 'Your free trial has ended. TenderPilot is read-only until you choose a plan.';
const HIDDEN_ON = /^\/(login|signup|onboarding)?(\/|$)/;

/** "2026-11-14" — the IST calendar day, used to remember a dismissal until the next IST day. */
export function istDay(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * Which banner to show. Expired wins and shows to every role; the "N days left" banner shows to Owners and Bid
 * Managers only, in the last 7 days, unless dismissed today (IST).
 */
export function trialBanner(input: {
  org: PlanOrg | null | undefined; role: string | null | undefined; pathname: string; now: Date; dismissedDay: string | null;
}): TrialBanner {
  const { org, role, pathname, now } = input;
  if (!org || org.plan !== 'trial' || !org.trialEndsAt || HIDDEN_ON.test(pathname)) return null;
  if (planExpired(org, now)) return { kind: 'expired', text: EXPIRED_BANNER_TEXT };
  if (role !== 'owner' && role !== 'bid_manager') return null;
  const msLeft = new Date(org.trialEndsAt).getTime() - now.getTime();
  const days = trialDaysLeft(org.trialEndsAt, now);
  if (days > TRIAL_BANNER_DAYS) return null;
  if (input.dismissedDay === istDay(now)) return null;
  const text = msLeft <= 24 * 60 * 60 * 1000 ? 'Your trial ends today' : `${days} day${days === 1 ? '' : 's'} left in your free trial`;
  return { kind: 'ending', text, dismissKey: istDay(now) };
}

// ───────────── Plan & usage meters (scenario 9) ─────────────

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PLAN_BADGE: Record<string, { label: string; tone: 'accent' | 'neutral' | 'primary' | 'success' }> = {
  trial: { label: PLAN_NAMES.trial, tone: 'accent' },
  starter: { label: PLAN_NAMES.starter, tone: 'neutral' },
  pro: { label: PLAN_NAMES.pro, tone: 'primary' },
  enterprise: { label: PLAN_NAMES.enterprise, tone: 'success' },
};
export const planBadge = (plan: string) => PLAN_BADGE[isPlanKey(plan) ? plan : 'trial']!;

const USAGE_UNIT: Record<PlanLimitKey, string> = {
  analysesPerMonth: 'analyses this month',
  llmAnalysesPerMonth: 'AI analyses this month',
  watchlists: 'watchlists',
  seats: 'seats',
  vaultBytes: 'vault storage',
  packetsPerMonth: 'packets this month',
};

/** "120 MB", "1 GB", "2.5 GB"; counts as plain numbers. */
export function formatUsageValue(limit: PlanLimitKey, n: number): string {
  if (limit !== 'vaultBytes') return n.toLocaleString('en-IN');
  if (n >= GB) return `${+(n / GB).toFixed(n % GB === 0 ? 0 : 2)} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  if (n > 0) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return '0 MB';
}

export type MeterTone = 'ok' | 'warning' | 'danger' | 'unlimited';

export interface Meter {
  key: PlanLimitKey;
  label: string;
  used: number;
  max: number | null;
  /** 0–100, capped. */
  pct: number;
  tone: MeterTone;
  /** "7 / 10", "2 / Unlimited", "2 / 50" (watchlists without a plan limit), "12 / 5 — over plan limit". */
  text: string;
}

/** Meter order on the page (FR-041c). */
export const METER_ORDER: PlanLimitKey[] = ['analysesPerMonth', 'llmAnalysesPerMonth', 'watchlists', 'seats', 'vaultBytes', 'packetsPerMonth'];

/** `max` is the plan limit (`null` = none); watchlists are shown against the 003/FR-027 cap of 50 then (review S5). */
export function meter(key: PlanLimitKey, used: number, planMax: number | null): Meter {
  const label = USAGE_LABELS[key];
  const max = effectiveLimit(key, planMax);
  if (max == null) return { key, label, used, max, pct: 0, tone: 'unlimited', text: `${formatUsageValue(key, used)} / Unlimited` };
  const ratio = max > 0 ? used / max : used > 0 ? Infinity : 0;
  const tone: MeterTone = ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warning' : 'ok';
  const over = used > max ? ' — over plan limit' : '';
  return { key, label, used, max, pct: Math.min(100, Math.round(ratio * 100)), tone, text: `${formatUsageValue(key, used)} / ${formatUsageValue(key, max)}${over}` };
}

/** "Trial ends 19 Nov 2026 (in 14 days)" / "Trial ends today" / "Trial ended on 19 Nov 2026". */
export function trialLine(trialEndsAt: string, now: Date): string {
  if (new Date(trialEndsAt).getTime() < now.getTime()) return `Trial ended on ${planDateIST(trialEndsAt)}`;
  const days = trialDaysLeft(trialEndsAt, now);
  if (days <= 0) return `Trial ends today (${planDateIST(trialEndsAt)})`;
  return `Trial ends ${planDateIST(trialEndsAt)} (in ${days} day${days === 1 ? '' : 's'})`;
}

/** "Usage resets on 1 Dec 2026". */
export const resetLine = (periodEnd: string) => `Usage resets on ${planDateIST(periodEnd)}`;
