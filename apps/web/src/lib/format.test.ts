import { describe, expect, it } from 'vitest';
import { countdownParts, daysUntil, formatDateIST, formatINR, formatINRCompact, relativeTime } from './format';
import { toQueryString, ApiError } from './api';
import { can, safeNext } from './auth';

describe('formatINR', () => {
  it('uses Indian digit grouping', () => {
    expect(formatINR(12345678)).toBe('₹1,23,45,678');
    expect(formatINR(999)).toBe('₹999');
    expect(formatINR(null)).toBe('—');
    expect(formatINR('4500000')).toBe('₹45,00,000');
  });
  it('compacts to lakh/crore', () => {
    expect(formatINRCompact(12000000)).toBe('₹1.2 Cr');
    expect(formatINRCompact(4500000)).toBe('₹45 L');
    expect(formatINRCompact(123456789)).toBe('₹12.3 Cr');
    expect(formatINRCompact(8500)).toBe('₹8.5 K');
    expect(formatINRCompact(950)).toBe('₹950');
    expect(formatINR(10000000, { compact: true })).toBe('₹1 Cr');
  });
});

describe('dates (IST)', () => {
  it('formats in Asia/Kolkata', () => {
    // 2026-11-04T20:00Z is 05 Nov 01:30 IST
    expect(formatDateIST('2026-11-04T20:00:00Z')).toBe('05 Nov 2026');
    expect(formatDateIST('2026-11-04T09:30:00Z', { time: true })).toBe('04 Nov 2026, 3:00 pm IST');
    expect(formatDateIST('garbage')).toBe('—');
  });
  it('daysUntil counts IST calendar days', () => {
    const now = new Date('2026-11-04T17:00:00Z'); // 22:30 IST on 4th
    expect(daysUntil('2026-11-04T19:00:00Z', now)).toBe(1); // 00:30 IST on 5th
    expect(daysUntil('2026-11-01T00:00:00Z', now)).toBe(-3);
  });
  it('relativeTime', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    expect(relativeTime('2026-11-04T09:00:00Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-11-06T12:00:00Z', now)).toBe('in 2 days');
    expect(relativeTime(now, now)).toBe('just now');
  });
  it('countdownParts', () => {
    const now = new Date('2026-11-04T00:00:00Z');
    const p = countdownParts('2026-11-06T04:00:00Z', now)!;
    expect(p.label).toBe('2d 4h');
    expect(p.urgent).toBe(false);
    expect(p.soon).toBe(true);
    expect(countdownParts('2026-11-04T05:12:00Z', now)!.label).toBe('5h 12m');
    expect(countdownParts('2026-11-04T05:12:00Z', now)!.urgent).toBe(true);
    expect(countdownParts('2026-11-03T00:00:00Z', now)!.closed).toBe(true);
  });
});

describe('roles & helpers', () => {
  it('can() respects hierarchy', () => {
    expect(can('owner', 'bid_manager')).toBe(true);
    expect(can('analyst', 'analyst')).toBe(true);
    expect(can('analyst', 'bid_manager')).toBe(false);
    expect(can('viewer', 'analyst')).toBe(false);
    expect(can(null, 'viewer')).toBe(false);
  });
  it('safeNext blocks open redirects', () => {
    expect(safeNext('/tenders?q=x')).toBe('/tenders?q=x');
    expect(safeNext('//evil.com')).toBe('/dashboard');
    expect(safeNext('https://evil.com')).toBe('/dashboard');
    expect(safeNext(null, '/onboarding')).toBe('/onboarding');
  });
  it('toQueryString skips empties and encodes arrays/booleans', () => {
    expect(toQueryString({ q: 'laptop', page: 2, empty: '', n: null, matched: true, s: ['a', 'b'] })).toBe('?q=laptop&page=2&matched=1&s=a&s=b');
    expect(toQueryString({})).toBe('');
  });
  it('ApiError exposes status helpers', () => {
    const e = new ApiError(409, 'conflict', 'x');
    expect(e.isConflict).toBe(true);
    expect(e.isUnauthorized).toBe(false);
  });
});
