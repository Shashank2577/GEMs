import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPIRED_BANNER_TEXT, closePlanLimit, formatUsageValue, isShownInPlanDialog, istDay, localPlanExpiredError, meter,
  planExpired, planLimitDialogContent, resetLine, showPlanLimit, trialBanner, trialLine,
} from './plan-limit';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const END = '2026-11-19T04:30:00.000Z'; // 19 Nov 2026 10:00 IST
const trial = { plan: 'trial', trialEndsAt: END };

describe('PlanLimitDialog content (008/FR-041b)', () => {
  it('shows "Plan limit reached", the server message and used / max', () => {
    const c = planLimitDialogContent({
      status: 402, code: 'plan_limit_reached', message: "Your Free trial includes 10 analyses a month. You've used 10.",
      details: { limit: 'analysesPerMonth', used: 10, max: 10, plan: 'trial', resetsAt: '2026-11-30T18:30:00.000Z' },
    });
    expect(c).toEqual({ code: 'plan_limit_reached', title: 'Plan limit reached', message: "Your Free trial includes 10 analyses a month. You've used 10.", usage: '10 / 10 analyses this month' });
    expect(planLimitDialogContent({ status: 402, code: 'plan_limit_reached', message: 'm', details: { limit: 'vaultBytes', used: 9.99 * GB, max: 10 * GB } }).usage)
      .toBe('9.99 GB / 10 GB vault storage');
  });

  it('titles an expired trial "Your trial has ended" without a usage line', () => {
    const e = localPlanExpiredError(trial);
    expect(e.message).toBe('Your free trial ended on 19 Nov 2026. Your data is safe and read-only — talk to us to choose a plan.');
    expect(planLimitDialogContent(e)).toMatchObject({ title: 'Your trial has ended', usage: null });
  });

  afterEach(() => closePlanLimit());
  it('suppresses duplicate toasts only while the dialog shows the same message', () => {
    expect(isShownInPlanDialog('x')).toBe(false);
    showPlanLimit({ status: 402, code: 'plan_limit_reached', message: 'x' });
    expect(isShownInPlanDialog('x')).toBe(true);
    expect(isShownInPlanDialog('y')).toBe(false);
    closePlanLimit();
    expect(isShownInPlanDialog('x')).toBe(false);
  });
});

describe('planExpired (FR-038 on the client)', () => {
  it('is true only for trials past their end', () => {
    expect(planExpired(trial, new Date('2026-11-19T04:31:00Z'))).toBe(true);
    expect(planExpired(trial, new Date('2026-11-19T04:29:00Z'))).toBe(false);
    expect(planExpired({ plan: 'starter', trialEndsAt: null }, new Date('2027-01-01T00:00:00Z'))).toBe(false);
    expect(planExpired(null)).toBe(false);
  });
});

describe('trialBanner (scenarios 7–8)', () => {
  const at = (iso: string, over: Partial<Parameters<typeof trialBanner>[0]> = {}) =>
    trialBanner({ org: trial, role: 'owner', pathname: '/dashboard', now: new Date(iso), dismissedDay: null, ...over });

  it('shows nothing with more than 7 days left', () => {
    expect(at('2026-11-05T04:30:00Z')).toBeNull();
    expect(at('2026-11-11T04:30:00Z')).toBeNull(); // 8 days
  });

  it('"5 days left in your free trial" for Owners and Bid Managers only', () => {
    expect(at('2026-11-14T04:30:00Z')).toEqual({ kind: 'ending', text: '5 days left in your free trial', dismissKey: '2026-11-14' });
    expect(at('2026-11-14T04:30:00Z', { role: 'bid_manager' })?.kind).toBe('ending');
    expect(at('2026-11-14T04:30:00Z', { role: 'analyst' })).toBeNull();
    expect(at('2026-11-14T04:30:00Z', { role: 'viewer' })).toBeNull();
  });

  it('"Your trial ends today" in the last day', () => {
    expect(at('2026-11-18T10:00:00Z')?.text).toBe('Your trial ends today');
    expect(at('2026-11-19T04:00:00Z')?.text).toBe('Your trial ends today');
  });

  it('stays dismissed for the rest of the IST day only', () => {
    const day = istDay(new Date('2026-11-14T04:30:00Z'));
    expect(at('2026-11-14T17:00:00Z', { dismissedDay: day })).toBeNull(); // 22:30 IST same day
    expect(at('2026-11-14T18:31:00Z', { dismissedDay: day })?.kind).toBe('ending'); // 00:01 IST next day
  });

  it('expired: non-dismissible, every role, wins over the countdown', () => {
    for (const role of ['owner', 'bid_manager', 'analyst', 'viewer']) {
      expect(at('2026-11-20T04:30:00Z', { role, dismissedDay: '2026-11-20' })).toEqual({ kind: 'expired', text: EXPIRED_BANNER_TEXT });
    }
    expect(EXPIRED_BANNER_TEXT).toBe('Your free trial has ended. TenderPilot is read-only until you choose a plan.');
  });

  it('never shows on /, /login, /signup, /onboarding or for paid plans', () => {
    for (const pathname of ['/', '/login', '/signup', '/onboarding']) expect(at('2026-11-20T04:30:00Z', { pathname })).toBeNull();
    expect(at('2026-11-20T04:30:00Z', { org: { plan: 'pro', trialEndsAt: null } })).toBeNull();
  });
});

describe('meters (scenario 9)', () => {
  it('formats counts, bytes and Unlimited', () => {
    expect(meter('analysesPerMonth', 7, 10)).toMatchObject({ label: 'Analyses this month', text: '7 / 10', pct: 70, tone: 'ok' });
    expect(meter('llmAnalysesPerMonth', 7, 10).label).toBe('AI analyses this month');
    expect(meter('watchlists', 2, null)).toMatchObject({ text: '2 / Unlimited', tone: 'unlimited', pct: 0 });
    expect(meter('seats', 1, 10).text).toBe('1 / 10');
    expect(meter('vaultBytes', 120 * MB, GB).text).toBe('120 MB / 1 GB');
    expect(meter('packetsPerMonth', 0, 10).text).toBe('0 / 10');
    expect(formatUsageValue('vaultBytes', 0)).toBe('0 MB');
  });

  it('is amber from 80 %, red at 100 %, capped and labelled when over the limit', () => {
    expect(meter('analysesPerMonth', 7, 10).tone).toBe('ok');
    expect(meter('analysesPerMonth', 8, 10).tone).toBe('warning');
    expect(meter('analysesPerMonth', 10, 10).tone).toBe('danger');
    expect(meter('watchlists', 12, 5)).toMatchObject({ tone: 'danger', pct: 100, text: '12 / 5 — over plan limit' });
  });

  it('writes the trial and reset lines in IST', () => {
    expect(trialLine(END, new Date('2026-11-05T04:30:00Z'))).toBe('Trial ends 19 Nov 2026 (in 14 days)');
    expect(trialLine(END, new Date('2026-11-20T04:30:00Z'))).toBe('Trial ended on 19 Nov 2026');
    expect(resetLine('2026-11-30T18:30:00.000Z')).toBe('Usage resets on 1 Dec 2026');
  });
});
