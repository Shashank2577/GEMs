/**
 * Optional LLM requirement extractor (T043, FR-011). The model only ADDS requirements the rules
 * missed (typically ATC-specific documents and conditions) or enriches a rule result that had
 * lower confidence; it never decides the verdict (Constitution III). The completion function is
 * injected so this module stays I/O-free and testable with a fake.
 */
import { z } from 'zod';
import type { Requirement } from './types';
import { MULTI_KEYS, requirementId } from './rules';

/** Matches `LlmClient.completeJson` in apps/api (`deps.llm`). */
export type CompleteJson = (req: { system?: string; prompt: string; maxTokens?: number; jsonSchema?: Record<string, unknown> }) => Promise<unknown>;

/** The LLM's confidence is capped so a clean RULE match (0.95) is never displaced. */
export const LLM_MAX_CONFIDENCE = 0.9;
const MAX_CHARS = 60_000;

export const LLM_REQUIREMENT_KEYS = [
  'turnover_min', 'oem_turnover', 'experience_years', 'similar_work', 'past_performance', 'emd', 'epbg',
  'mii', 'mse_exemption', 'startup_exemption', 'oem_auth', 'certificate', 'document', 'undertaking',
  'delivery_days', 'bid_end', 'evaluation_method', 'estimated_value', 'other',
] as const;

const SYSTEM = `You are an expert Indian public-procurement analyst reading a Government e-Marketplace (GeM) bid document,
its Additional Terms & Conditions (ATC), corrigenda and BOQ. Extract the seller ELIGIBILITY requirements and the documents
a bidder must upload. Be literal: only report what the text states. Amounts are integer rupees (1 lakh = 100000,
1 crore = 10000000). Years, days and percentages are plain numbers. Never invent requirements. Pages are marked
"=== Page N ===". Ignore financial price bids.`;

export interface LlmPrompt { system: string; prompt: string; maxTokens: number; jsonSchema: Record<string, unknown> }

/**
 * JSON Schema of the reply (`output_config.format`, FR-049), mirroring `llmItemSchema`. Structured outputs accept no
 * numeric/length bounds, so ranges stay in zod, which still validates every item.
 */
export const LLM_REQUIREMENTS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['requirements'],
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'label', 'value', 'numeric', 'mandatory', 'page', 'quote', 'confidence'],
        properties: {
          key: { type: 'string', enum: [...LLM_REQUIREMENT_KEYS] },
          label: { type: 'string' },
          value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] },
          numeric: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          mandatory: { type: 'boolean' },
          page: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

/**
 * `maxChars` caps the document text included (default 60,000); an analysis passes what is left of its overall
 * 90,000-character budget (008/FR-031).
 */
export function buildLlmPrompt(pages: string[], known: Requirement[] = [], maxChars = MAX_CHARS): LlmPrompt {
  let budget = Math.max(0, Math.min(MAX_CHARS, maxChars));
  const parts: string[] = [];
  pages.forEach((p, i) => {
    if (budget <= 0) return;
    const text = p.replace(/[ \t]+/g, ' ').trim().slice(0, budget);
    budget -= text.length;
    parts.push(`=== Page ${i + 1} ===\n${text}`);
  });
  const knownList = known
    .filter((r) => r.method === 'RULE')
    .map((r) => `- ${r.key}: ${typeof r.value === 'string' ? r.value : JSON.stringify(r.value)}`)
    .join('\n');
  const prompt = `Already extracted by deterministic rules (do not repeat these unless you find a DIFFERENT value):
${knownList || '(none)'}

Return JSON of the form:
{"requirements":[{"key":"<one of ${LLM_REQUIREMENT_KEYS.join('|')}>","label":"short human label","value":"string|number|boolean","numeric":number|null,"mandatory":true|false,"page":number,"quote":"exact supporting text, max 200 chars","confidence":0..1}]}

Focus on: ATC-specific documents and certificates (e.g. ISO, BIS, CMMI, PSARA, labour licence, ESI/EPF registration),
similar-work value conditions, OEM authorisation, local content / Make in India, MSE / Startup exemption conditions,
non-blacklisting or other undertakings, delivery or completion period, and anything else that could disqualify a bidder.

Document text:
${parts.join('\n\n')}`;
  return { system: SYSTEM, prompt, maxTokens: 4096, jsonSchema: LLM_REQUIREMENTS_JSON_SCHEMA };
}

const llmItemSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]).optional(),
  numeric: z.number().finite().nullable().optional(),
  mandatory: z.boolean().optional(),
  page: z.number().int().min(1).max(10_000).nullable().optional(),
  quote: z.string().max(1000).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/** Validate and normalise an LLM reply. Invalid items are dropped, never thrown. */
export function parseLlmRequirements(reply: unknown, src: { documentId?: string; fileName?: string } = {}): Requirement[] {
  const arr = Array.isArray(reply) ? reply : (reply as { requirements?: unknown } | null)?.requirements;
  if (!Array.isArray(arr)) return [];
  const known = new Set<string>(LLM_REQUIREMENT_KEYS);
  const out: Requirement[] = [];
  for (const raw of arr) {
    const p = llmItemSchema.safeParse(raw);
    if (!p.success) continue;
    const it = p.data;
    const key = known.has(it.key) ? it.key : 'other';
    out.push({
      key,
      label: it.label.trim(),
      value: it.value ?? null,
      numeric: it.numeric ?? null,
      mandatory: it.mandatory ?? true,
      source: {
        ...(src.documentId ? { documentId: src.documentId } : {}),
        ...(src.fileName ? { fileName: src.fileName } : {}),
        ...(it.page ? { page: it.page } : {}),
        ...(it.quote ? { quote: it.quote.slice(0, 240) } : {}),
      },
      method: 'LLM',
      confidence: Math.min(LLM_MAX_CONFIDENCE, it.confidence ?? 0.6),
    });
  }
  return out;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Merge LLM results into rule results. Rules are kept unless the LLM item for the same single-valued
 * key has STRICTLY higher confidence; multi-valued items (documents, certificates…) are added when
 * not already present (fuzzy label match).
 */
export function mergeRequirements(rules: Requirement[], llm: Requirement[]): Requirement[] {
  const out = [...rules];
  const index = new Map<string, number>();
  out.forEach((r, i) => index.set(requirementId(r), i));
  const multiSeen = new Set(out.filter((r) => MULTI_KEYS.has(r.key)).map((r) => `${r.key}|${norm(r.value ?? r.label)}`));
  for (const r of llm) {
    if (MULTI_KEYS.has(r.key)) {
      const a = norm(r.value ?? r.label);
      const prefix = `${r.key}|`;
      const dup = !a || [...multiSeen].some((s) => s.startsWith(prefix) && (s.slice(prefix.length).includes(a) || a.includes(s.slice(prefix.length))));
      if (dup) continue;
      multiSeen.add(prefix + a);
      out.push(r);
      continue;
    }
    const i = index.get(r.key);
    if (i === undefined) {
      index.set(r.key, out.length);
      out.push(r);
    } else if (r.confidence > out[i].confidence && out[i].method !== 'MANUAL') {
      out[i] = r;
    }
  }
  return out;
}

/** Characters sent for one prompt (system + user text) — what the 008/FR-031 budget counts. */
export const promptChars = (p: Pick<LlmPrompt, 'system' | 'prompt'>) => p.system.length + p.prompt.length;

export interface LlmExtractResult {
  requirements: Requirement[];
  used: boolean;
  error?: string;
  /** Characters sent to the LLM (0 when not called). */
  inputChars: number;
}

/** Run the LLM extractor and merge; on any failure, fall back to the rule results. */
export async function enrichWithLlm(
  pages: string[],
  rules: Requirement[],
  completeJson: CompleteJson | null | undefined,
  src: { documentId?: string; fileName?: string } = {},
  opts: { maxChars?: number } = {},
): Promise<LlmExtractResult> {
  if (!completeJson || !pages.length) return { requirements: rules, used: false, inputChars: 0 };
  const prompt = buildLlmPrompt(pages, rules, opts.maxChars);
  const inputChars = promptChars(prompt);
  try {
    const reply = await completeJson(prompt);
    const llm = parseLlmRequirements(reply, src);
    return { requirements: mergeRequirements(rules, llm), used: true, inputChars };
  } catch (e) {
    return { requirements: rules, used: false, error: (e as Error).message, inputChars };
  }
}
