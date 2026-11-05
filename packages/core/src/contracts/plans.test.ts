import { describe, expect, it } from 'vitest';
import {
  PLAN_KEYS, PLAN_LIMITS, TRIAL_DAYS, allowedWhenExpired, isTrialExpired, istMonthPeriod, limitsFor, planDateIST,
  planLimitMessage, PLAN_EXPIRED_MESSAGE, trialDaysLeft, trialEndsAtFor,
} from './plans';

const GB = 1024 ** 3;

describe('PLAN_LIMITS (008/FR-034 pinning)', () => {
  it('pins the launch limits per plan', () => {
    expect(PLAN_KEYS).toEqual(['trial', 'starter', 'pro', 'enterprise']);
    expect(PLAN_LIMITS).toEqual({
      trial: { seats: 10, watchlists: null, analysesPerMonth: 10, llmAnalysesPerMonth: 10, vaultBytes: 1 * GB, packetsPerMonth: 10, whatsapp: true },
      starter: { seats: 3, watchlists: 5, analysesPerMonth: 100, llmAnalysesPerMonth: 50, vaultBytes: 2 * GB, packetsPerMonth: 30, whatsapp: false },
      pro: { seats: 10, watchlists: null, analysesPerMonth: 500, llmAnalysesPerMonth: 250, vaultBytes: 10 * GB, packetsPerMonth: 200, whatsapp: true },
      enterprise: { seats: null, watchlists: null, analysesPerMonth: null, llmAnalysesPerMonth: null, vaultBytes: null, packetsPerMonth: null, whatsapp: true },
    });
    expect(TRIAL_DAYS).toBe(14);
  });

  it('treats unknown plans as trial', () => {
    expect(limitsFor('gold')).toBe(PLAN_LIMITS.trial);
    expect(limitsFor('pro')).toBe(PLAN_LIMITS.pro);
  });
});

describe('trial dates (FR-035)', () => {
  it('ends 14 × 24 h after sign-up', () => {
    // 2026-11-05 10:00 IST
    expect(trialEndsAtFor(new Date('2026-11-05T04:30:00.000Z')).toISOString()).toBe('2026-11-19T04:30:00.000Z');
  });

  it('is expired only for trials whose end has passed', () => {
    const end = '2026-11-19T04:30:00.000Z';
    expect(isTrialExpired({ plan: 'trial', trialEndsAt: end }, new Date('2026-11-19T04:29:59.000Z'))).toBe(false);
    expect(isTrialExpired({ plan: 'trial', trialEndsAt: end }, new Date('2026-11-19T04:30:00.001Z'))).toBe(true);
    expect(isTrialExpired({ plan: 'starter', trialEndsAt: end }, new Date('2027-01-01T00:00:00Z'))).toBe(false);
    expect(isTrialExpired({ plan: 'trial', trialEndsAt: null }, new Date('2027-01-01T00:00:00Z'))).toBe(false);
  });

  it('counts days left in IST calendar days', () => {
    const end = '2026-11-19T04:30:00.000Z';
    expect(trialDaysLeft(end, new Date('2026-11-05T04:30:00.000Z'))).toBe(14);
    expect(trialDaysLeft(end, new Date('2026-11-14T10:00:00.000Z'))).toBe(5);
    expect(trialDaysLeft(end, new Date('2026-11-18T19:00:00.000Z'))).toBe(0); // 00:30 IST on the 19th
    expect(trialDaysLeft(end, new Date('2026-11-20T00:00:00.000Z'))).toBe(-1);
  });
});

describe('IST month period', () => {
  it('starts at 00:00 IST on the 1st (18:30 UTC the day before)', () => {
    const p = istMonthPeriod(new Date('2026-11-05T04:30:00.000Z'));
    expect(p.start.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(p.end.toISOString()).toBe('2026-11-30T18:30:00.000Z');
  });

  it('switches month at IST midnight, not UTC midnight', () => {
    // 2026-11-30T18:29:59Z = 30 Nov 23:59:59 IST → November
    expect(istMonthPeriod(new Date('2026-11-30T18:29:59.999Z')).start.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    // 2026-11-30T18:30Z = 1 Dec 00:00 IST → December
    expect(istMonthPeriod(new Date('2026-11-30T18:30:00.000Z')).start.toISOString()).toBe('2026-11-30T18:30:00.000Z');
    // Year rollover
    expect(istMonthPeriod(new Date('2026-12-31T20:00:00.000Z')).end.toISOString()).toBe('2027-01-31T18:30:00.000Z');
  });
});

describe('messages', () => {
  it('matches the spec wording for analyses (US5 scenario 2)', () => {
    expect(planLimitMessage({ limit: 'analysesPerMonth', used: 10, max: 10, plan: 'trial', resetsAt: '2026-11-30T18:30:00.000Z' }))
      .toBe("Your Free trial includes 10 analyses a month. You've used 10. Talk to us to upgrade, or wait until 1 Dec.");
    expect(planLimitMessage({ limit: 'watchlists', used: 5, max: 5, plan: 'starter' })).toMatch(/^Your Starter plan includes 5 watchlists\./);
    expect(planLimitMessage({ limit: 'vaultBytes', used: 9.99 * GB, max: 10 * GB, plan: 'pro' })).toMatch(/10 GB of vault storage/);
  });

  it('formats the expired message (scenario 6)', () => {
    expect(PLAN_EXPIRED_MESSAGE('2026-11-19T04:30:00.000Z'))
      .toBe('Your free trial ended on 19 Nov 2026. Your data is safe and read-only — talk to us to choose a plan.');
    expect(planDateIST('2026-11-30T18:30:00.000Z', { year: false })).toBe('1 Dec');
  });
});

describe('allowedWhenExpired (FR-038)', () => {
  it.each([
    ['GET', '/api/tenders'], ['HEAD', '/api/vault/x/download'], ['POST', '/api/auth/login'], ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/switch-org'], ['POST', '/api/auth/accept-invite'], ['PATCH', '/api/me'], ['POST', '/api/me/password'],
    ['POST', '/api/me/sessions/revoke-others'], ['DELETE', '/api/me/sessions/abc'], ['DELETE', '/api/me/api-tokens/abc'],
    ['POST', '/api/notifications/abc/read'], ['POST', '/api/notifications/read-all'], ['PUT', '/api/me/notification-prefs'],
    ['DELETE', '/api/demo'], ['POST', '/tenders/abc/seen'],
  ])('allows %s %s', (m, p) => expect(allowedWhenExpired(m, p)).toBe(true));

  it.each([
    ['POST', '/api/watchlists'], ['POST', '/api/tenders/abc/analyse'], ['POST', '/api/vault'], ['POST', '/api/me/api-tokens'],
    ['PATCH', '/api/org'], ['POST', '/api/org/invitations'], ['POST', '/api/demo/seed'], ['DELETE', '/api/me'], ['POST', '/api/me'],
    ['POST', '/api/authx'], ['PUT', '/api/me/password'],
  ])('blocks %s %s', (m, p) => expect(allowedWhenExpired(m, p)).toBe(false));
});
