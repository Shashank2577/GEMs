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
    expect(bad).toEqual({ requirements: rules, used: false, error: 'rate limited', inputChars: expect.any(Number), llmItems: [] });
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

// ───────────── 004/FR-051: page-aligned chunks ─────────────

import { applyEscalation, buildEscalationPrompt, chunkPages, escalateWithLlm, escalationCandidates, MAX_LLM_CHUNKS_PER_DOCUMENT, unreadPagesNote } from '../../src/analyse/llm';

describe('chunkPages (T087, FR-051)', () => {
  const page = (n: number) => 'x'.repeat(n);
  it('a document within 60k characters is one chunk', () => {
    expect(chunkPages([page(1000), page(1000)])).toEqual({ chunks: [{ startPage: 1, pages: [page(1000), page(1000)] }] });
  });
  it('splits at page boundaries, each chunk ≤ 60,000 characters, numbered from the document page', () => {
    const pages = Array.from({ length: 7 }, () => page(25_000));
    const { chunks, unreadFromPage } = chunkPages(pages);
    expect(chunks.map((c) => [c.startPage, c.pages.length])).toEqual([[1, 2], [3, 2], [5, 2], [7, 1]]);
    expect(unreadFromPage).toBeUndefined();
    for (const c of chunks) expect(c.pages.join('').length).toBeLessThanOrEqual(60_000);
  });
  it('reads at most 4 chunks and reports where the unread rest starts', () => {
    const pages = Array.from({ length: 12 }, () => page(25_000));
    const r = chunkPages(pages);
    expect(r.chunks).toHaveLength(MAX_LLM_CHUNKS_PER_DOCUMENT);
    expect(r.unreadFromPage).toBe(9);
    expect(r.chunks.flatMap((c) => c.pages)).toHaveLength(8);
  });
  it('an oversize page gets a chunk of its own; empty input gives no chunk', () => {
    expect(chunkPages([page(10), page(70_000), page(10)]).chunks.map((c) => c.startPage)).toEqual([1, 2, 3]);
    expect(chunkPages([])).toEqual({ chunks: [] });
  });
  it('later chunks keep the real page numbers in the prompt, and the note reads like the spec', () => {
    expect(buildLlmPrompt(['a', 'b'], [], 60_000, 181).prompt).toContain('=== Page 182 ===\nb');
    expect(unreadPagesNote('X.pdf', 181, 240)).toBe('Pages 181–240 of X.pdf were not read by AI');
    expect(unreadPagesNote('X.pdf', 5, 5)).toBe('Page 5 of X.pdf was not read by AI');
  });
});

// ───────────── 004/FR-050: escalation ─────────────

describe('escalation (T088, FR-050, FR-048)', () => {
  const llmItem = (key: string, value: Requirement['value'], numeric: number | null, page = 3, quote = 'q'): Requirement =>
    ({ ...rule(key, value, numeric, 0.8), method: 'LLM', source: { page, quote } });
  const pages = ['p1', 'p2', 'turnover clause here', 'p4'];

  it('candidates: blocking key with rule confidence < 0.75, or a rule/LLM conflict; not when they agree or the key is not blocking', () => {
    const rules = [rule('turnover_min', '50 Lakh', 5_000_000, 0.7), rule('experience_years', '3', 3), rule('emd', '10,000', 10_000), rule('certificate', 'ISO', null, 0.5), rule('oem_auth', true, null, 0.95)];
    const llm = [llmItem('experience_years', '5', 5), llmItem('emd', '10,000', 10_000), llmItem('oem_auth', 'Yes', null)];
    expect(escalationCandidates(rules, llm).map((c) => c.key)).toEqual(['turnover_min', 'experience_years']);
    expect(escalationCandidates(rules, llm)[1]!.llm).toMatchObject({ numeric: 5 });
    expect(escalationCandidates([], llm)).toEqual([]);
  });

  it('the prompt cites the disputed requirements and only the pages involved', () => {
    const c = escalationCandidates([{ ...rule('turnover_min', '50 Lakh', 5_000_000, 0.7), source: { page: 3 } }], [llmItem('turnover_min', '5 Crore', 50_000_000, 3)]);
    const p = buildEscalationPrompt(pages, c);
    expect(p.prompt).toContain('turnover_min');
    expect(p.prompt).toContain('=== Page 3 ===\nturnover clause here');
    expect(p.prompt).not.toContain('=== Page 1 ===');
    expect(p.jsonSchema).toBeDefined();
  });

  it('the adjudicated item (with a quote) replaces the rule and stays an LLM item capped at 0.9; no quote → ignored', async () => {
    const rules = [rule('turnover_min', '50 Lakh', 5_000_000, 0.7), rule('emd', '10,000', 10_000)];
    const reply = { requirements: [{ key: 'turnover_min', label: 'Turnover', value: '5 Crore', numeric: 50_000_000, page: 3, quote: 'average annual turnover of Rs 5 Crore', confidence: 0.99 }] };
    const ok = await escalateWithLlm(pages, rules, rules, [], async () => reply);
    expect(ok.used).toBe(true);
    expect(ok.keys).toEqual(['turnover_min']);
    expect(ok.requirements.find((r) => r.key === 'turnover_min')).toMatchObject({ method: 'LLM', numeric: 50_000_000, confidence: LLM_MAX_CONFIDENCE, source: { page: 3, quote: expect.stringContaining('5 Crore') } });
    expect(ok.requirements.find((r) => r.key === 'emd')!.method).toBe('RULE');
    const noQuote = await escalateWithLlm(pages, rules, rules, [], async () => ({ requirements: [{ ...reply.requirements[0], quote: '' }] }));
    expect(noQuote.requirements).toEqual(rules);
  });

  it('a conflict is settled by the adjudicator even when the rule was confident; MANUAL is never replaced; errors and no candidates fall back', async () => {
    const rules = [rule('experience_years', '3', 3, 0.95)];
    const llm = [llmItem('experience_years', '5', 5)];
    const reply = { requirements: [{ key: 'experience_years', label: 'Experience', value: '5', numeric: 5, page: 3, quote: 'five years', confidence: 0.8 }] };
    expect((await escalateWithLlm(pages, rules, rules, llm, async () => reply)).requirements[0]).toMatchObject({ method: 'LLM', numeric: 5 });
    const manual = [{ ...rules[0]!, method: 'MANUAL' as const }];
    expect(applyEscalation(manual, parseLlmRequirements(reply), escalationCandidates(rules, llm))).toEqual(manual);
    const bad = await escalateWithLlm(pages, rules, rules, llm, async () => { throw new Error('boom'); });
    expect(bad).toMatchObject({ used: false, error: 'boom', requirements: rules });
    const fn = vi.fn();
    const none = await escalateWithLlm(pages, rules, rules, [], fn);
    expect(none.used).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect((await escalateWithLlm(pages, rules, rules, llm, null)).used).toBe(false);
  });
});

describe('shared extraction cache version (008/FR-072)', () => {
  it('CURRENT_EXTRACTOR_VERSION is pinned — changing it re-extracts every cached GeM document once; update this test only on purpose', async () => {
    const { CURRENT_EXTRACTOR_VERSION } = await import('../../src/analyse/llm');
    // v2 (004/US7): JSON-schema prompt + page-chunked reading (FR-051) changed the extraction, so v1 rows re-extract once.
    expect(CURRENT_EXTRACTOR_VERSION).toBe('llm-extract-2026-11-v2');
  });

  it('enrichWithLlm returns the LLM-only requirements (what the cache stores) next to the merged list', async () => {
    const reply = { requirements: [{ key: 'certificate', label: 'ISO 9001', value: 'ISO 9001', page: 2, quote: 'ISO 9001 certified', confidence: 0.8 }] };
    const r = await enrichWithLlm(['p1', 'p2'], [rule('emd', '50,000', 50_000)], async () => reply, { documentId: 'd1', fileName: 'bid.pdf' });
    expect(r.used).toBe(true);
    expect(r.llm).toHaveLength(1);
    expect(r.llmItems).toBe(r.llm);
    expect(r.llm![0]).toMatchObject({ key: 'certificate', method: 'LLM', source: { documentId: 'd1', page: 2 } });
    expect(r.requirements.map((x) => x.key)).toEqual(['emd', 'certificate']);
    const failed = await enrichWithLlm(['p1'], [], async () => { throw new Error('x'); });
    expect(failed.llm).toBeUndefined();
    expect(r.cacheable).toBe(true);
    expect(failed.cacheable).toBeFalsy();
  });

  it('an empty or malformed reply is used but not cacheable (review S1)', async () => {
    const good = { key: 'certificate', label: 'ISO 9001', value: 'ISO 9001', confidence: 0.8 };
    for (const reply of [{ requirements: [] }, [], { nope: 1 }, 'text', null, { requirements: [{ bogus: true }] }]) {
      const r = await enrichWithLlm(['p1'], [], async () => reply);
      expect(r.used).toBe(true);
      expect(r.cacheable, JSON.stringify(reply)).toBe(false);
    }
    expect((await enrichWithLlm(['p1'], [], async () => [good])).cacheable).toBe(true);
  });
});
