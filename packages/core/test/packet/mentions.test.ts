/** @mention parsing (006/FR-032). */
import { describe, expect, it } from 'vitest';
import { parseMentions } from '../../src/packet/mentions';

const M = [
  { id: 'ravi', name: 'Ravi Sharma' },
  { id: 'meera', name: 'Meera Iyer' },
  { id: 'anil1', name: 'Anil Kumar' },
  { id: 'anil2', name: 'Anil Rao' },
  { id: 'single', name: 'Zoya' },
];

describe('parseMentions', () => {
  it('matches @First and @First Last, case-insensitively', () => {
    expect(parseMentions('Please check @Ravi', M)).toEqual(['ravi']);
    expect(parseMentions('cc @meera iyer, thanks', M)).toEqual(['meera']);
    expect(parseMentions('@ZOYA!', M)).toEqual(['single']);
  });
  it('de-duplicates and keeps first-seen order', () => {
    expect(parseMentions('@Meera @Ravi Sharma @ravi @MEERA IYER', M)).toEqual(['meera', 'ravi']);
  });
  it('ignores e-mail addresses and mid-word @', () => {
    expect(parseMentions('mail ravi@sharma.in or a@Ravi', M)).toEqual([]);
  });
  it('does not match a longer word', () => {
    expect(parseMentions('@Raviraj', M)).toEqual([]);
  });
  it('prefers the full-name match when a first name is shared', () => {
    expect(parseMentions('@Anil Rao please review', M)).toEqual(['anil2']);
  });
  it('notifies nobody for an ambiguous first name', () => {
    expect(parseMentions('@Anil can you look?', M)).toEqual([]);
  });
  it('returns [] for no mentions or no members', () => {
    expect(parseMentions('no mentions here', M)).toEqual([]);
    expect(parseMentions('@Ravi', [])).toEqual([]);
  });
  it('handles multiple spaces and punctuation after the name', () => {
    expect(parseMentions('(@Ravi   Sharma).', M)).toEqual(['ravi']);
  });
});
