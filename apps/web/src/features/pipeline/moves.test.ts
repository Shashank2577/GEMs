import { describe, expect, it } from 'vitest';
import { moveTargets, outcomePayload, parseRupees } from './moves';

describe('moveTargets (FR-029)', () => {
  it('lists every other stage including Dropped, in order', () => {
    expect(moveTargets('go').map((t) => t.label)).toEqual(['Identified', 'Analysing', 'Preparing', 'Ready to submit', 'Submitted', 'Won', 'Lost', 'Dropped']);
  });
  it('disables Won/Lost until the bid was submitted', () => {
    const fromGo = Object.fromEntries(moveTargets('go').map((t) => [t.stage, t.disabled]));
    expect(fromGo).toMatchObject({ won: true, lost: true, dropped: false, submitted: false });
    const fromSubmitted = Object.fromEntries(moveTargets('submitted').map((t) => [t.stage, t.disabled]));
    expect(fromSubmitted).toMatchObject({ won: false, lost: false });
    expect(moveTargets('won').find((t) => t.stage === 'lost')!.disabled).toBe(false);
  });
});

describe('parseRupees / outcomePayload (FR-030)', () => {
  it('parses Indian-grouped and ₹-prefixed amounts to whole rupees', () => {
    expect(parseRupees('29,50,000')).toBe(2_950_000);
    expect(parseRupees(' ₹ 1234.6 ')).toBe(1235);
    expect(parseRupees('')).toBeNull();
    expect(parseRupees('12abc')).toBeNaN();
    expect(parseRupees('-5')).toBeNaN();
  });
  it('builds the outcome body; everything optional', () => {
    expect(outcomePayload('won', { l1: '29,50,000', ours: '', notes: '  L1 by 2%  ' })).toEqual({ ok: true, outcome: { result: 'won', l1Price: 2_950_000, ourPrice: null, notes: 'L1 by 2%' } });
    expect(outcomePayload('lost', { l1: '', ours: '', notes: '' })).toEqual({ ok: true, outcome: { result: 'lost', l1Price: null, ourPrice: null, notes: null } });
  });
  it('reports field errors for bad amounts and notes over 2000 characters', () => {
    const r = outcomePayload('won', { l1: 'abc', ours: '1', notes: 'x'.repeat(2001) });
    expect(r).toEqual({ ok: false, errors: { l1: expect.any(String), notes: 'Keep notes under 2000 characters' } });
  });
});
