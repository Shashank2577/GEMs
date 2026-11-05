/** Weight slider bounds (FR-036): the same 0–100 range the API accepts (`scoringWeightsSchema`). */
export const WEIGHT_SLIDER = { min: 0, max: 100, step: 1 } as const;

/** A factor's share of the normalised score, in whole percent ("12% of score"). */
export const weightShare = (weight: number, total: number) => (total ? Math.round((weight / total) * 100) : 0);
