/** 008/US3 T056: 429 handling in the web client (FR-018, FR-041d). */
import { describe, expect, it } from 'vitest';
import { ApiError, formatRetryAfter, tooManyAttemptsMessage } from './api';
import { previewPausedMessage, previewRetry, previewRetryDelay } from '../features/watchlists/api';

const limited = (retryAfter?: number, message = 'Too many attempts. Try again in 14 minutes.', rule = 'auth.fail.email') =>
  new ApiError(429, 'rate_limited', message, retryAfter === undefined ? { rule } : { rule, retryAfter });

describe('ApiError rate-limit helpers', () => {
  it('exposes isRateLimited, retryAfter and the rule from details', () => {
    const e = limited(840);
    expect(e.isRateLimited).toBe(true);
    expect(e.retryAfter).toBe(840);
    expect(e.rateLimitRule).toBe('auth.fail.email');
    const other = new ApiError(400, 'validation_error', 'Bad', { fields: {} });
    expect(other.isRateLimited).toBe(false);
    expect(other.retryAfter).toBeNull();
    expect(other.rateLimitRule).toBeNull();
    expect(limited(undefined).retryAfter).toBeNull();
  });

  it('formats Retry-After as seconds below two minutes, else minutes', () => {
    expect(formatRetryAfter(1)).toBe('1 s');
    expect(formatRetryAfter(42.2)).toBe('43 s');
    expect(formatRetryAfter(119)).toBe('119 s');
    expect(formatRetryAfter(840)).toBe('14 min');
    expect(formatRetryAfter(0)).toBe('1 s');
  });
});

describe('auth forms (login, sign-up, forgot password)', () => {
  it('show the server text for a 429, rebuilt from retryAfter when the message is generic', () => {
    expect(tooManyAttemptsMessage(limited(840))).toBe('Too many attempts. Try again in 14 minutes.');
    expect(tooManyAttemptsMessage(limited(60, 'Too Many Requests'))).toBe('Too many attempts. Try again in 1 minute.');
    expect(tooManyAttemptsMessage(limited(1790, ''))).toBe('Too many attempts. Try again in 30 minutes.');
    expect(tooManyAttemptsMessage(new ApiError(401, 'invalid_credentials', 'Incorrect email or password'))).toBeNull();
    expect(tooManyAttemptsMessage(new Error('x'))).toBeNull();
  });
});

describe('watchlist preview', () => {
  it('a 429 pauses the preview with the wait in seconds', () => {
    const e = new ApiError(429, 'rate_limited', 'Too many requests. Try again in 50 seconds.', { rule: 'watchlist.preview.user', retryAfter: 50 });
    expect(previewPausedMessage(e)).toBe('Preview paused — try again in 50 s');
    expect(previewPausedMessage(new ApiError(500, 'internal_error', 'x'))).toBeNull();
  });

  it('refetches by itself after Retry-After (N7), and never retries other errors', () => {
    const e = new ApiError(429, 'rate_limited', 'x', { rule: 'watchlist.preview.user', retryAfter: 12 });
    expect(previewRetry(0, e)).toBe(true);
    expect(previewRetry(3, e)).toBe(false);
    expect(previewRetryDelay(0, e)).toBe(12_000);
    expect(previewRetry(0, new ApiError(400, 'validation_error', 'x'))).toBe(false);
    expect(previewRetryDelay(0, new ApiError(429, 'rate_limited', 'x'))).toBe(5_000);
  });
});
