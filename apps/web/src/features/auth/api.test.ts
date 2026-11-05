import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import {
  INVITE_INVALID_MESSAGE, acceptInviteError, acceptInviteFieldErrors, inviteMode, isInviteInvalid, isInviteMismatch, mismatchMessage,
} from './api';

const asMe = (email: string) => ({ user: { email } });

describe('inviteMode (002/FR-019, FR-018)', () => {
  it('signed out: password-only for an existing account, name + password for a new one', () => {
    expect(inviteMode({ email: 'asha@sharma.in', existingUser: true }, null)).toBe('existing');
    expect(inviteMode({ email: 'asha@sharma.in', existingUser: false }, null)).toBe('new');
  });

  it('signed in as the invited email (any case) → accept; as someone else → mismatch', () => {
    expect(inviteMode({ email: 'asha@sharma.in', existingUser: true }, asMe('Asha@Sharma.in'))).toBe('signed-in');
    expect(inviteMode({ email: 'asha@sharma.in', existingUser: true }, asMe('ravi@sharma.in'))).toBe('mismatch');
    expect(inviteMode({ email: 'asha@sharma.in', existingUser: false }, asMe('ravi@sharma.in'))).toBe('mismatch');
  });
});

describe('accept-invite error mapping', () => {
  const invalid = new ApiError(404, 'invite_invalid', 'This invitation link is invalid, already used or has expired. Ask your admin for a new one.');
  const mismatch = new ApiError(403, 'invite_email_mismatch', mismatchMessage('asha@sharma.in'));

  it('classifies invalid and mismatch errors', () => {
    expect(isInviteInvalid(invalid)).toBe(true);
    expect(isInviteInvalid(mismatch)).toBe(false);
    expect(isInviteMismatch(mismatch)).toBe(true);
    expect(isInviteMismatch(new ApiError(403, 'forbidden', 'nope'))).toBe(false);
    expect(mismatchMessage('asha@sharma.in')).toBe('This invitation was sent to asha@sharma.in. Sign out and continue as that account.');
  });

  it('keeps the rate-limit message (002/FR-010) and server messages', () => {
    expect(acceptInviteError(new ApiError(429, 'rate_limited', 'Too many attempts. Try again in 15 minutes.'))).toBe('Too many attempts. Try again in 15 minutes.');
    expect(acceptInviteError(invalid)).toBe(INVITE_INVALID_MESSAGE);
    expect(acceptInviteError(new ApiError(500, 'http_500', 'Something went wrong on our side. Please try again.'))).toMatch(/our side/);
  });

  it('extracts field errors from details.fields', () => {
    const wrong = new ApiError(401, 'invalid_credentials', 'Enter the password for your existing TenderPilot account', { fields: { password: 'Incorrect password' } });
    expect(acceptInviteFieldErrors(wrong)).toEqual({ password: 'Incorrect password', name: undefined });
    expect(acceptInviteFieldErrors(new ApiError(400, 'bad_request', 'Your name is required', { fields: { name: 'Required' } })).name).toBe('Required');
    expect(acceptInviteFieldErrors(new Error('x'))).toEqual({});
  });
});
