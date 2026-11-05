/** Anthropic adapter (004 T085, FR-049): structured output, refusal/max_tokens failures, usage reporting. */
import { describe, expect, it } from 'vitest';
import { createAnthropicClient, LlmError, MAX_NON_STREAMING_TOKENS } from '../src/adapters/llm';
import { LLM_REQUIREMENTS_JSON_SCHEMA } from '@tp/core/analyse/llm';
import type { Logger } from '../src/deps';

interface Sent { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function fakeFetch(reply: unknown, status = 200) {
  const sent: Sent[] = [];
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status });
  }) as unknown as typeof fetch;
  return { f, sent };
}

const message = (over: Record<string, unknown> = {}) => ({
  model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
  content: [{ type: 'text', text: '{"requirements":[]}' }],
  usage: { input_tokens: 120, output_tokens: 7 }, ...over,
});

describe('createAnthropicClient', () => {
  it('sends output_config.format with the schema, and no sampling parameters', async () => {
    const { f, sent } = fakeFetch(message());
    const llm = createAnthropicClient({ apiKey: 'sk-test', model: 'claude-sonnet-5-5', fetch: f });
    const out = await llm.completeJson({ system: 'S', prompt: 'P', jsonSchema: LLM_REQUIREMENTS_JSON_SCHEMA });
    expect(out).toEqual({ requirements: [] });
    const body = sent[0].body;
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema: LLM_REQUIREMENTS_JSON_SCHEMA } });
    expect(body.system).toBe('S');
    for (const k of ['temperature', 'top_p', 'top_k', 'budget_tokens', 'thinking']) expect(body).not.toHaveProperty(k);
    expect(sent[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0].headers['x-api-key']).toBe('sk-test');
  });

  it('without a schema it asks for bare JSON in the system prompt and parses tolerantly', async () => {
    const { f, sent } = fakeFetch(message({ content: [{ type: 'text', text: 'Here:\n```json\n{"a":1}\n```' }] }));
    const llm = createAnthropicClient({ apiKey: 'k', model: 'm', fetch: f });
    expect(await llm.completeJson({ prompt: 'P' })).toEqual({ a: 1 });
    expect(sent[0].body).not.toHaveProperty('output_config');
    expect(String(sent[0].body.system)).toContain('single valid JSON');
  });

  it('reports model and usage, and logs model / stop_reason / usage without the key or the text', async () => {
    const { f } = fakeFetch(message());
    const lines: { msg: string; meta?: Record<string, unknown> }[] = [];
    const logger: Logger = { info: (msg, meta) => lines.push({ msg, meta }), warn() {}, error() {} };
    const llm = createAnthropicClient({ apiKey: 'sk-secret', model: 'm', fetch: f, logger });
    const seen: unknown[] = [];
    await llm.completeJson({ prompt: 'SECRET PROMPT', jsonSchema: {} }, { onUsage: (r) => seen.push(r) });
    expect(seen).toEqual([{ model: 'claude-sonnet-5-5', usage: { inputTokens: 120, outputTokens: 7 } }]);
    expect(lines).toHaveLength(1);
    expect(lines[0].meta).toEqual({ model: 'claude-sonnet-5-5', stopReason: 'end_turn', inputTokens: 120, outputTokens: 7 });
    expect(JSON.stringify(lines)).not.toMatch(/sk-secret|SECRET PROMPT/);
  });

  it('complete() returns text, model, stopReason and usage', async () => {
    const { f } = fakeFetch(message({ stop_reason: 'max_tokens' }));
    const r = await createAnthropicClient({ apiKey: 'k', model: 'm', fetch: f }).complete({ prompt: 'P' });
    expect(r).toEqual({ text: '{"requirements":[]}', model: 'claude-sonnet-5-5', stopReason: 'max_tokens', usage: { inputTokens: 120, outputTokens: 7 } });
  });

  it.each(['refusal', 'max_tokens'])('stop_reason %s is an LlmError, but its usage is still reported', async (stop) => {
    const { f } = fakeFetch(message({ stop_reason: stop }));
    const llm = createAnthropicClient({ apiKey: 'k', model: 'm', fetch: f });
    const seen: unknown[] = [];
    await expect(llm.completeJson({ prompt: 'P', jsonSchema: {} }, { onUsage: (r) => seen.push(r) })).rejects.toBeInstanceOf(LlmError);
    expect(seen).toHaveLength(1);
  });

  it('HTTP errors and invalid JSON are LlmErrors', async () => {
    const http = createAnthropicClient({ apiKey: 'k', model: 'm', fetch: fakeFetch({ error: 'x' }, 529).f });
    await expect(http.completeJson({ prompt: 'P' })).rejects.toMatchObject({ name: 'LlmError', status: 529 });
    const bad = createAnthropicClient({ apiKey: 'k', model: 'm', fetch: fakeFetch(message({ content: [{ type: 'text', text: 'no json' }] })).f });
    await expect(bad.completeJson({ prompt: 'P' })).rejects.toBeInstanceOf(LlmError);
  });

  it('OCR (T091): document blocks go before the prompt text in one user message; max_tokens is capped for non-streaming', async () => {
    const { f, sent } = fakeFetch(message({ content: [{ type: 'text', text: '{"pages":[]}' }] }));
    const llm = createAnthropicClient({ apiKey: 'k', model: 'claude-opus-5-5', fetch: f });
    const doc = { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: 'JVBERi0=' } };
    await llm.completeJson({ system: 'OCR', prompt: 'Transcribe', documents: [doc], maxTokens: 64_000, jsonSchema: {} });
    expect(sent[0].body.messages).toEqual([{ role: 'user', content: [doc, { type: 'text', text: 'Transcribe' }] }]);
    expect(sent[0].body.max_tokens).toBe(MAX_NON_STREAMING_TOKENS);
    expect(MAX_NON_STREAMING_TOKENS).toBeLessThanOrEqual(21_000);
    for (const k of ['temperature', 'top_p', 'top_k', 'stream']) expect(sent[0].body).not.toHaveProperty(k);
    // Without documents the content stays a plain string.
    await llm.completeJson({ prompt: 'P', maxTokens: 100 });
    expect(sent[1].body.messages).toEqual([{ role: 'user', content: 'P' }]);
    expect(sent[1].body.max_tokens).toBe(100);
  });

  it('a per-request timeoutMs overrides the client timeout', async () => {
    const hang = (async (_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
    const llm = createAnthropicClient({ apiKey: 'k', model: 'm', fetch: hang, timeoutMs: 60_000 });
    await expect(llm.complete({ prompt: 'P', timeoutMs: 20 })).rejects.toBeInstanceOf(LlmError);
  });

  it('the structured-output schema is strict and mirrors the item fields', () => {
    const item = (LLM_REQUIREMENTS_JSON_SCHEMA as any).properties.requirements.items;
    expect(LLM_REQUIREMENTS_JSON_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false });
    expect(item.additionalProperties).toBe(false);
    expect(Object.keys(item.properties).sort()).toEqual(['confidence', 'key', 'label', 'mandatory', 'numeric', 'page', 'quote', 'value']);
    expect(item.properties.key.enum).toContain('turnover_min');
    expect(JSON.stringify(item)).not.toMatch(/minLength|maxLength|minimum|maximum/);
  });
});

describe('model tiers (T086, FR-050)', () => {
  it('config: OCR defaults to claude-opus-5-5, escalation is off, both come from env', async () => {
    const { loadConfig } = await import('../src/env');
    expect(loadConfig({})).toMatchObject({ llmModel: 'claude-sonnet-5-5', llmOcrModel: 'claude-opus-5-5', llmEscalationModel: null });
    expect(loadConfig({ LLM_OCR_MODEL: 'o', LLM_ESCALATION_MODEL: ' claude-fable-5-1 ', LLM_MODEL: 'm' }))
      .toMatchObject({ llmModel: 'm', llmOcrModel: 'o', llmEscalationModel: 'claude-fable-5-1' });
  });

  it('createDeps.llmFor: no key → every purpose is null; key → enrichment + ocr; escalation only when set', async () => {
    const { createDeps } = await import('../src/adapters');
    const base = { db: {} as never, blobs: {} as never };
    const none = createDeps({ ...base, env: { NODE_ENV: 'test' } });
    expect([none.llm, none.llmFor('enrichment'), none.llmFor('ocr'), none.llmFor('escalation')]).toEqual([null, null, null, null]);
    const keyed = createDeps({ ...base, env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'k' } });
    expect(keyed.llmFor('enrichment')).toBe(keyed.llm);
    expect(keyed.llmFor('enrichment')?.model).toBe('claude-sonnet-5-5');
    expect(keyed.llmFor('ocr')?.model).toBe('claude-opus-5-5');
    expect(keyed.llmFor('escalation')).toBeNull();
    const full = createDeps({ ...base, env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'k', LLM_ESCALATION_MODEL: 'claude-fable-5-1', LLM_OCR_MODEL: 'claude-sonnet-5-5' } });
    expect(full.llmFor('escalation')?.model).toBe('claude-fable-5-1');
    expect(full.llmFor('ocr')?.model).toBe('claude-sonnet-5-5');
    expect(full.llmFor('ocr')).toBe(full.llmFor('ocr'));
  });
});
