import { describe, expect, it, vi } from 'vitest';
import { buildLlmPrompt, enrichWithLlm, LLM_MAX_CONFIDENCE, mergeRequirements, parseLlmRequirements, promptChars } from '../../src/analyse/llm';
import type { Requirement } from '../../src/analyse/types';

const rule = (key: string, value: Requirement['value'], numeric: number | null = null, confidence = 0.95): Requirement => ({
  key, label: key, value, numeric, mandatory: true, source: { page: 1, quote: 'q' }, method: 'RULE', confidence,
});

describe('LLM extractor (T043)', () => {
  it('builds a prompt with page markers and the rule results', () => {
    const p = buildLlmPrompt(['first page', 'second page'], [rule('emd', '50,000', 50_000)]);
    expect(p.prompt).toContain('=== Page 1 ===\nfirst page');
    expect(p.prompt).toContain('=== Page 2 ===');
    expect(p.prompt).toContain('- emd: 50,000');
    expect(p.system).toMatch(/GeM/);
  });

  it('validates replies, drops junk, caps confidence and maps unknown keys to other', () => {
    const out = parseLlmRequirements({
      requirements: [
        { key: 'certificate', label: 'PSARA licence', value: 'PSARA', page: 4, quote: 'valid PSARA licence', confidence: 0.99 },
        { key: 'labour_licence', label: 'Labour licence under CLRA', mandatory: true },
        { nope: true },
        'string',
      ],
    }, { documentId: 'd1' });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ key: 'certificate', method: 'LLM', confidence: LLM_MAX_CONFIDENCE, source: { documentId: 'd1', page: 4, quote: 'valid PSARA licence' } });
    expect(out[1]).toMatchObject({ key: 'other', confidence: 0.6 });
    expect(parseLlmRequirements('garbage')).toEqual([]);
  });

  it('merge: never replaces a RULE with lower confidence; adds missing and multi-valued items', () => {
    const rules = [rule('turnover_min', '50 Lakh', 5_000_000), rule('similar_work', '40%', null, 0.7), rule('certificate', 'ISO 9001')];
    const llm: Requirement[] = [
      { ...rule('turnover_min', '5 Crore', 50_000_000, 0.9), method: 'LLM' },
      { ...rule('similar_work', '₹19.2 L', 1_920_000, 0.85), method: 'LLM' },
      { ...rule('certificate', 'ISO 9001:2015', null, 0.8), method: 'LLM' },
      { ...rule('certificate', 'CMMI Level 3', null, 0.8), method: 'LLM' },
      { ...rule('oem_auth', true, null, 0.8), method: 'LLM' },
    ];
    const merged = mergeRequirements(rules, llm);
    expect(merged.find((r) => r.key === 'turnover_min')).toMatchObject({ numeric: 5_000_000, method: 'RULE' });
    expect(merged.find((r) => r.key === 'similar_work')).toMatchObject({ numeric: 1_920_000, method: 'LLM' });
    expect(merged.filter((r) => r.key === 'certificate').map((r) => r.value)).toEqual(['ISO 9001', 'CMMI Level 3']);
    expect(merged.find((r) => r.key === 'oem_auth')!.method).toBe('LLM');
  });

  it('enrichWithLlm uses the injected completion and falls back on errors', async () => {
    const rules = [rule('emd', '50,000', 50_000)];
    const fake = vi.fn(async () => ({ requirements: [{ key: 'certificate', label: 'BIS', value: 'BIS', confidence: 0.8 }] }));
    const ok = await enrichWithLlm(['text'], rules, fake);
    expect(ok.used).toBe(true);
    expect(ok.requirements).toHaveLength(2);
    expect(fake).toHaveBeenCalledOnce();
    const bad = await enrichWithLlm(['text'], rules, async () => { throw new Error('rate limited'); });
    expect(bad).toEqual({ requirements: rules, used: false, error: 'rate limited', inputChars: expect.any(Number) });
    expect((await enrichWithLlm(['text'], rules, null)).used).toBe(false);
  });
});

// ───────────── 008/FR-031: per-analysis character budget ─────────────

describe('LLM prompt character cap (008/FR-031)', () => {
  const page = 'x'.repeat(10_000);
  it('includes at most maxChars of document text', () => {
    const capped = buildLlmPrompt([page, page, page], [], 5_000);
    expect(capped.prompt).toContain('x'.repeat(5_000));
    expect(capped.prompt).not.toContain('x'.repeat(5_001));
    expect(capped.prompt.match(/=== Page \d+ ===/g)).toEqual(['=== Page 1 ===']);
  });
  it('never exceeds the 60k per-document default and reports the characters sent', async () => {
    const r = await enrichWithLlm([page.repeat(10)], [], async () => ({ requirements: [] }), {}, { maxChars: 1_000_000 });
    expect(r.inputChars).toBe(promptChars(buildLlmPrompt([page.repeat(10)])));
    expect(r.inputChars).toBeLessThan(65_000);
    expect((await enrichWithLlm(['text'], [], null)).inputChars).toBe(0);
  });
});
