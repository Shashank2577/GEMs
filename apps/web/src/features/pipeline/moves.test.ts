import { describe, expect, it } from 'vitest';
import { adjacentStage, emptyKind, moveTargets, outcomePayload, parseRupees } from './moves';
import { PIPELINE_STAGES } from '@tp/core/contracts/apply';

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

describe('moveTargets by role (#527: Go/No-Go is Bid Manager+)', () => {
  const byStage = (role: 'analyst' | 'bid_manager' | 'owner', from: 'identified' | 'go' = 'identified') =>
    Object.fromEntries(moveTargets(from, role).map((t) => [t.stage, t]));
  it('disables Go and Dropped with the tooltip for an Analyst, everything else stays available', () => {
    const t = byStage('analyst');
    expect(t.go).toMatchObject({ disabled: true, reason: 'Only a Bid Manager can make the Go/No-Go call' });
    expect(t.dropped).toMatchObject({ disabled: true, reason: 'Only a Bid Manager can make the Go/No-Go call' });
    expect(t.go!.hint).toBe('Bid Manager only');
    expect(t.analysing!.disabled).toBe(false);
    expect(t.preparing!.disabled).toBe(false);
  });
  it('leaves Go and Dropped open for Bid Manager and Owner', () => {
    for (const r of ['bid_manager', 'owner'] as const) {
      expect(byStage(r).go).toMatchObject({ disabled: false });
      expect(byStage(r).dropped!.reason).toBeUndefined();
    }
  });
  it('lets an Analyst move a bid OUT of Go', () => {
    expect(byStage('analyst', 'go').identified!.disabled).toBe(false);
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
    expect(r).toEqual({ ok: false, errors: { l1: expect.any(String), notes: 'Keep notes to 2000 characters or fewer' } });
  });
});

describe('adjacentStage (keyboard drag, FR-022)', () => {
  it('moves exactly one visible column per press, from the card\'s current column', () => {
    expect(adjacentStage(PIPELINE_STAGES, 'identified', 1)).toBe('analysing');
    expect(adjacentStage(PIPELINE_STAGES, adjacentStage(PIPELINE_STAGES, 'identified', 1), 1)).toBe('go'); // two presses → two columns
    expect(adjacentStage(PIPELINE_STAGES, 'go', -1)).toBe('analysing');
  });
  it('stops at the edges and ignores hidden columns', () => {
    expect(adjacentStage(PIPELINE_STAGES, 'identified', -1)).toBeNull();
    expect(adjacentStage(PIPELINE_STAGES, 'lost', 1)).toBeNull();
    expect(adjacentStage([...PIPELINE_STAGES, 'dropped'], 'lost', 1)).toBe('dropped');
    expect(adjacentStage(PIPELINE_STAGES, 'dropped', 1)).toBeNull();
    expect(adjacentStage(PIPELINE_STAGES, null, 1)).toBeNull();
  });
});

describe('emptyKind (FR-027, US2-15)', () => {
  it('only says "pipeline empty" without filters', () => {
    expect(emptyKind(0, false)).toBe('pipeline');
    expect(emptyKind(0, true)).toBe('filtered');
    expect(emptyKind(3, true)).toBeNull();
  });
});
