import { describe, expect, it } from 'vitest';
import { isUnreadFilter } from './filter';

describe('isUnreadFilter', () => {
  it('honours ?unread=1', () => expect(isUnreadFilter(new URLSearchParams('unread=1'))).toBe(true));
  it('keeps ?tab=unread working', () => expect(isUnreadFilter(new URLSearchParams('tab=unread'))).toBe(true));
  it('defaults to all', () => {
    expect(isUnreadFilter(new URLSearchParams(''))).toBe(false);
    expect(isUnreadFilter(new URLSearchParams('unread=0&tab=all'))).toBe(false);
  });
});
