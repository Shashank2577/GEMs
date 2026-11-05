/** 004/FR-036 (T061): the sliders cover the API's whole 0–100 range in whole steps; share % is relative to the total. */
import { describe, expect, it } from 'vitest';
import { FACTOR_KEYS, scoringWeightsSchema } from '@tp/core/contracts/analyse';
import { WEIGHT_SLIDER, weightShare } from './scoring-slider';

describe('weight slider', () => {
  it('spans 0–100 in steps of 1, exactly what PUT /scoring-weights accepts', () => {
    expect(WEIGHT_SLIDER).toEqual({ min: 0, max: 100, step: 1 });
    expect(scoringWeightsSchema.safeParse({ turnover: WEIGHT_SLIDER.max }).success).toBe(true);
    expect(scoringWeightsSchema.safeParse({ turnover: WEIGHT_SLIDER.max + 1 }).success).toBe(false);
    expect(scoringWeightsSchema.safeParse({ turnover: WEIGHT_SLIDER.min, emd: 1 }).success).toBe(true);
  });

  it('shows each factor’s share of the total, 0 when the total is 0', () => {
    expect(weightShare(30, 120)).toBe(25);
    expect(weightShare(100, 100)).toBe(100);
    expect(weightShare(0, 0)).toBe(0);
    expect(FACTOR_KEYS.length).toBe(10);
  });
});
