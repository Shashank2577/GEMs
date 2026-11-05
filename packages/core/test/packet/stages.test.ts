/** Stage transition rules (T019; 006/FR-008). */
import { describe, expect, it } from 'vitest';
import { INVALID_TRANSITION_MESSAGE, STAGES, canDecideGoNoGo, canMoveToStage, canTransition, isDecisionStage, type StageName } from '../../src/contracts/apply';

const OUTCOME_FROM: StageName[] = ['submitted', 'won', 'lost'];

describe('canTransition (FR-008)', () => {
  it.each(STAGES.filter((s) => !OUTCOME_FROM.includes(s)))('refuses won/lost from %s', (from) => {
    for (const to of ['won', 'lost'] as const) {
      expect(canTransition(from, to)).toEqual({ ok: false, code: 'invalid_transition', message: INVALID_TRANSITION_MESSAGE });
    }
  });

  it.each(OUTCOME_FROM)('allows won/lost from %s (record or correct the result)', (from) => {
    expect(canTransition(from, 'won')).toEqual({ ok: true });
    expect(canTransition(from, 'lost')).toEqual({ ok: true });
  });

  it('allows every other move, including back from won/lost and to dropped', () => {
    for (const from of STAGES) {
      for (const to of STAGES.filter((s) => s !== 'won' && s !== 'lost')) {
        expect(canTransition(from, to).ok).toBe(true);
      }
    }
  });

  it('uses the spec wording', () => {
    expect(INVALID_TRANSITION_MESSAGE).toBe('Record the submission on GeM first — a bid can only be won or lost after it was submitted.');
  });
});

describe('Go / No-Go role helpers (#527)', () => {
  it('canDecideGoNoGo: Bid Manager and Owner only', () => {
    expect(canDecideGoNoGo('owner')).toBe(true);
    expect(canDecideGoNoGo('bid_manager')).toBe(true);
    expect(canDecideGoNoGo('analyst')).toBe(false);
    expect(canDecideGoNoGo('viewer')).toBe(false);
    expect(canDecideGoNoGo(null)).toBe(false);
  });
  it('canMoveToStage gates only a move INTO go / dropped', () => {
    expect(canMoveToStage('analyst', 'identified', 'go')).toBe(false);
    expect(canMoveToStage('analyst', 'preparing', 'dropped')).toBe(false);
    expect(canMoveToStage('analyst', 'go', 'preparing')).toBe(true);
    expect(canMoveToStage('analyst', 'identified', 'analysing')).toBe(true);
    expect(canMoveToStage('analyst', 'go', 'go')).toBe(true);
    expect(canMoveToStage('bid_manager', 'identified', 'go')).toBe(true);
    expect(isDecisionStage('dropped')).toBe(true);
    expect(isDecisionStage('ready')).toBe(false);
  });
});
