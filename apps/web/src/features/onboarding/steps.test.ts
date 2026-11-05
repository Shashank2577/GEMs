/** T039 — pure onboarding helpers (FR-043, FR-046). */
import { describe, expect, it } from 'vitest';
import { POPULAR_CATEGORIES, STEPS, initialStep, keywordsFor } from './steps';

describe('keywordsFor', () => {
  it('maps popular categories to their keywords', () => {
    expect(keywordsFor(['Desktop computers', 'CCTV & surveillance'])).toEqual(['desktop', 'cctv', 'surveillance', 'network video recorder']);
  });
  it('lower-cases custom categories', () => {
    expect(keywordsFor(['Biometric Devices'])).toEqual(['biometric devices']);
  });
  it('dedupes keywords', () => {
    expect(keywordsFor(['Desktop computers', 'Desktop computers', 'DESKTOP'])).toEqual(['desktop']);
  });
  it('caps at 30 keywords', () => {
    const many = Array.from({ length: 50 }, (_, i) => `Custom ${i}`);
    expect(keywordsFor(many)).toHaveLength(30);
    expect(keywordsFor(POPULAR_CATEGORIES.map((c) => c.label)).length).toBeLessThanOrEqual(30);
  });
  it('offers 16 popular categories', () => expect(POPULAR_CATEGORIES).toHaveLength(16));
});

describe('initialStep', () => {
  it('starts at step 0 for an empty state', () => expect(initialStep({})).toBe(0));
  it('resumes at the first unticked step', () => {
    expect(initialStep({ company: true })).toBe(1);
    expect(initialStep({ company: true, categories: true })).toBe(2);
    expect(initialStep({ company: true, watchlist: true })).toBe(1);
    expect(initialStep({ company: true, categories: true, watchlist: true })).toBe(3);
  });
  it('goes to Done when every step is ticked', () => {
    expect(initialStep({ company: true, categories: true, watchlist: true, documents: true })).toBe(STEPS.length - 1);
  });
  it('treats false as unticked', () => expect(initialStep({ company: false })).toBe(0));
});
