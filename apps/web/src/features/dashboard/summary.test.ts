/** T016 — pure dashboard helpers (FR-008). Times are UTC instants; IST = UTC + 05:30. */
import { describe, expect, it } from 'vitest';
import type { DashboardResponse } from '@tp/core/contracts/experience';
import { greeting, isEmptyOrg, istHour, istTime, pctDelta, summaryLine } from './summary';

/** UTC instant for an IST wall-clock time on 4 Nov 2026. */
const ist = (hhmm: string) => new Date(`2026-11-04T${hhmm}:00+05:30`);

describe('greeting (IST hour boundaries)', () => {
  it.each([
    ['00:30', 'Working late'],
    ['04:59', 'Working late'],
    ['05:00', 'Good morning'],
    ['11:59', 'Good morning'],
    ['12:00', 'Good afternoon'],
    ['16:59', 'Good afternoon'],
    ['17:00', 'Good evening'],
    ['23:59', 'Good evening'],
  ])('%s IST → %s', (t, want) => {
    expect(greeting(ist(t))).toBe(want);
  });

  it('uses IST, not the machine timezone (09:30 IST is 04:00 UTC)', () => {
    expect(istHour(new Date('2026-11-04T04:00:00Z'))).toBe(9);
    expect(greeting(new Date('2026-11-04T04:00:00Z'))).toBe('Good morning');
  });

  it('treats IST midnight as hour 0, not 24', () => {
    expect(istHour(ist('00:00'))).toBe(0);
  });
});

describe('pctDelta', () => {
  it('is 0 when both periods are 0', () => expect(pctDelta(0, 0)).toBe(0));
  it('is null when yesterday was 0 but today is not (no baseline)', () => expect(pctDelta(5, 0)).toBeNull());
  it('computes rounded percentage change', () => {
    expect(pctDelta(15, 10)).toBe(50);
    expect(pctDelta(5, 10)).toBe(-50);
    expect(pctDelta(0, 4)).toBe(-100);
    expect(pctDelta(2, 3)).toBe(-33);
  });
});

type Sum = Pick<DashboardResponse, 'tiles' | 'stats'>;
const base = (over: { tiles?: Partial<Sum['tiles']>; stats?: Partial<Sum['stats']> } = {}): Sum => ({
  tiles: { newMatchesToday: 0, closingThisWeek: 0, activeBids: 0, emdAtStake: 0, winRate: null, expiringDocs: 0, ...over.tiles },
  stats: { newMatchesYesterday: 0, closingToday: 0, won: 0, lost: 0, expiredDocs: 0, analysesThisWeek: 0, openTenders: 0, ...over.stats },
});

describe('summaryLine', () => {
  it('lists urgent items joined by " · " (US1-6)', () => {
    expect(summaryLine(base({ stats: { closingToday: 1, expiredDocs: 1 } }))).toBe('1 bid closing today · 1 expired document.');
  });
  it('includes new matches first and pluralises', () => {
    expect(summaryLine(base({ tiles: { newMatchesToday: 3 }, stats: { closingToday: 2, expiredDocs: 2 } })))
      .toBe('3 new matches today · 2 bids closing today · 2 expired documents.');
    expect(summaryLine(base({ tiles: { newMatchesToday: 1 } }))).toBe('1 new match today.');
  });
  it('falls back to the active-bid count when nothing is urgent', () => {
    expect(summaryLine(base({ tiles: { activeBids: 13 } }))).toBe('13 active bids in your pipeline. Nothing urgent right now.');
    expect(summaryLine(base({ tiles: { activeBids: 1 } }))).toBe('1 active bid in your pipeline. Nothing urgent right now.');
  });
  it('uses the welcome line for an org with nothing going on', () => {
    expect(summaryLine(base())).toBe('Here’s what’s happening on GeM for your business.');
  });
});

describe('isEmptyOrg', () => {
  type E = Parameters<typeof isEmptyOrg>[0];
  const empty: E = {
    demo: false, tiles: base().tiles, recentMatches: [],
    setup: [{ key: 'watchlist', label: 'Create a watchlist', description: '', done: false, href: '/watchlists?new=1' }],
  };
  it('is true for a brand-new org', () => expect(isEmptyOrg(empty)).toBe(true));
  it('is false for a demo org', () => expect(isEmptyOrg({ ...empty, demo: true })).toBe(false));
  it('is false with active bids', () => expect(isEmptyOrg({ ...empty, tiles: { ...empty.tiles, activeBids: 1 } })).toBe(false));
  it('is false with matches', () => expect(isEmptyOrg({ ...empty, recentMatches: [{} as E['recentMatches'][number]] })).toBe(false));
  it('is false once a watchlist exists', () => expect(isEmptyOrg({ ...empty, setup: [{ ...empty.setup[0]!, done: true }] })).toBe(false));
});

describe('istTime', () => {
  it('formats generatedAt as 24-hour HH:MM in IST', () => {
    expect(istTime('2026-11-04T04:30:00.000Z')).toBe('10:00');
    expect(istTime('2026-11-04T13:05:00.000Z')).toBe('18:35');
    expect(istTime('2026-11-03T18:30:00.000Z')).toBe('00:00');
  });
});
