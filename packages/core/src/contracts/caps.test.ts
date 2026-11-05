import { describe, expect, it } from 'vitest';
import * as caps from './caps';

// NFR-009: every cap is a named constant pinned here. Changing one is a product decision — update the spec too.
describe('caps (008 NFR-009)', () => {
  it('pins every value from the spec', () => {
    expect(caps.MAX_TENDER_DOC_PAGES).toBe(300);
    expect(caps.SCANNED_EMPTY_PAGE_RATIO).toBe(0.8);
    expect(caps.MAX_LLM_CALLS_PER_ANALYSIS).toBe(2);
    expect(caps.MAX_LLM_INPUT_CHARS).toBe(90_000);
    expect(caps.LLM_CALL_TIMEOUT_MS).toBe(60_000);
    expect(caps.ANALYSIS_BUDGET_MS).toBe(120_000);
    expect(caps.PACKET_MAX_BYTES).toBe(40 * 1024 * 1024);
    expect(caps.PACKET_MAX_ITEMS).toBe(40);
    expect(caps.PACKET_GENERATED_PAGE_BYTES).toBe(512 * 1024);
    expect(caps.JSON_BODY_MAX_BYTES).toBe(1024 * 1024);
    expect(caps.MANUAL_SYNC_COOLDOWN_MIN).toBe(10);
    expect(caps.GEM_MIN_INTERVAL_MS).toBe(1000);
    expect(caps.GEM_LEASE_MAX_WAIT_MS).toBe(25_000);
    expect(caps.MAX_CANDIDATE_TENDERS).toBe(2_000);
    expect(caps.INGESTION_RUN_BUDGET_MS).toBe(10 * 60_000);
  });

  it('has no unpinned numeric constant', () => {
    const pinned = new Set([
      'MAX_TENDER_DOC_PAGES', 'SCANNED_EMPTY_PAGE_RATIO', 'MAX_LLM_CALLS_PER_ANALYSIS', 'MAX_LLM_INPUT_CHARS', 'LLM_CALL_TIMEOUT_MS',
      'ANALYSIS_BUDGET_MS', 'PACKET_MAX_BYTES', 'PACKET_MAX_ITEMS', 'PACKET_GENERATED_PAGE_BYTES', 'JSON_BODY_MAX_BYTES',
      'MANUAL_SYNC_COOLDOWN_MIN', 'GEM_MIN_INTERVAL_MS', 'GEM_LEASE_MAX_WAIT_MS', 'MAX_CANDIDATE_TENDERS', 'INGESTION_RUN_BUDGET_MS',
    ]);
    const numeric = Object.entries(caps).filter(([, v]) => typeof v === 'number').map(([k]) => k);
    expect(numeric.filter((k) => !pinned.has(k))).toEqual([]);
  });

  it('formats sizes for messages', () => {
    expect(caps.formatMb(45 * 1024 * 1024)).toBe('45 MB');
    expect(caps.formatMb(40 * 1024 * 1024)).toBe('40 MB');
    expect(caps.formatMb(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});
