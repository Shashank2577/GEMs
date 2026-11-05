/**
 * Anthropic Messages API client over plain fetch (works on Workers and Node).
 * LLMs only extract/enrich/explain — they never decide a verdict (Constitution III).
 */
import type { LlmClient, LlmRequest, LlmResult } from '../deps';

export class LlmError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) { super(message); this.name = 'LlmError'; }
}

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Request timeout in ms (default 90s). */
  timeoutMs?: number;
}

/** Extract the first JSON value from a model reply (handles ```json fences and surrounding prose). */
export function parseJsonLoose<T = unknown>(text: string): T {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], trimmed];
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c.trim()) as T; } catch { /* try next */ }
    const start = c.search(/[[{]/);
    if (start >= 0) {
      const open = c[start]; const close = open === '{' ? '}' : ']';
      const end = c.lastIndexOf(close);
      if (end > start) { try { return JSON.parse(c.slice(start, end + 1)) as T; } catch { /* next */ } }
    }
  }
  throw new LlmError('Model reply was not valid JSON');
}

export function createAnthropicClient(opts: AnthropicOptions): LlmClient {
  const f = opts.fetch ?? fetch;
  const base = (opts.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');

  async function complete(req: LlmRequest): Promise<LlmResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 90_000);
    try {
      const res = await f(`${base}/v1/messages`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: req.maxTokens ?? 2048,
          ...(req.system ? { system: req.system } : {}),
          messages: [{ role: 'user', content: req.prompt }],
        }),
      });
      const raw = await res.text();
      if (!res.ok) throw new LlmError(`Anthropic API error ${res.status}`, res.status, raw.slice(0, 2000));
      const data = JSON.parse(raw) as {
        model?: string; stop_reason?: string | null;
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      return {
        text,
        model: data.model ?? opts.model,
        stopReason: data.stop_reason ?? null,
        usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 },
      };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      throw new LlmError(`Anthropic request failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    model: opts.model,
    complete,
    async completeJson<T = unknown>(req: LlmRequest): Promise<T> {
      const system = [req.system, 'Respond with a single valid JSON value only. No prose, no markdown fences.'].filter(Boolean).join('\n\n');
      const r = await complete({ ...req, system });
      return parseJsonLoose<T>(r.text);
    },
  };
}
