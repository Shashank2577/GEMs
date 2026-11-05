/**
 * Test support for the LLM data-protection check (004 T093, FR-054, NFR-003): a real Anthropic adapter over a fake
 * `fetch` that records the exact HTTP body of every request, so the test sees what would leave the server.
 */
import { createAnthropicClient } from '../src/adapters/llm';
import type { LlmClient } from '../src/deps';

export interface CapturedRequest {
  /** Which tier made it, e.g. 'enrichment', 'escalation', 'ocr'. */
  tier: string;
  model: string;
  /** The raw JSON body that would be POSTed to the provider. */
  body: string;
}

export interface Capture {
  client: LlmClient;
  requests: CapturedRequest[];
}

/**
 * An adapter-backed client whose provider is a fake: `reply(i, body)` returns the model's JSON text for the i-th call
 * (default `{"requirements":[]}`). All requests of all captures made with the same `sink` end up in one list.
 */
export function capturingClient(
  tier: string, model: string, sink: CapturedRequest[],
  reply: (call: number, body: Record<string, unknown>) => unknown = () => ({ requirements: [] }),
): LlmClient {
  let calls = 0;
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    sink.push({ tier, model, body });
    const text = JSON.stringify(reply(calls++, JSON.parse(body) as Record<string, unknown>));
    return new Response(JSON.stringify({
      model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 50, output_tokens: 10 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  return createAnthropicClient({ apiKey: 'sk-test-not-a-real-key', model, fetch: fakeFetch });
}

/** Normalise for a numeric canary: drop thousands separators / spaces so `31,41,59,26` style formatting still matches. */
const squash = (s: string) => s.toLowerCase().replace(/[,\s_]/g, '');

/** Canary values found in any captured request (empty = clean). Each canary is matched as written and in squashed form. */
export function leaks(requests: CapturedRequest[], canaries: string[]): { tier: string; canary: string }[] {
  const out: { tier: string; canary: string }[] = [];
  for (const r of requests) {
    const raw = r.body.toLowerCase();
    const squashed = squash(r.body);
    for (const c of canaries) {
      if (raw.includes(c.toLowerCase()) || squashed.includes(squash(c))) out.push({ tier: r.tier, canary: c });
    }
  }
  return out;
}
