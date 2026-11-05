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
 * character budget (008/FR-031). `startPage` is the document page number of `pages[0]` (chunks after the first, FR-051).
 */
export function buildLlmPrompt(pages: string[], known: Requirement[] = [], maxChars = MAX_CHARS, startPage = 1): LlmPrompt {
  let budget = Math.max(0, Math.min(MAX_CHARS, maxChars));
  const parts: string[] = [];
  pages.forEach((p, i) => {
    if (budget <= 0) return;
    const text = p.replace(/[ \t]+/g, ' ').trim().slice(0, budget);
    budget -= text.length;
    parts.push(`=== Page ${startPage + i} ===\n${text}`);
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

/** A document is read by the model in at most this many page-aligned chunks of ≤ 60,000 characters (FR-051). */
export const MAX_LLM_CHUNKS_PER_DOCUMENT = 4;

export interface PageChunk {
  /** 1-based document page number of `pages[0]`. */
  startPage: number;
  pages: string[];
}

/** Characters of a page as `buildLlmPrompt` includes them. */
const pageChars = (p: string) => p.replace(/[ \t]+/g, ' ').trim().length;

/**
 * Split a document into page-aligned chunks of ≤ `maxChars` characters of page text (a single page longer than that gets
 * a chunk of its own and is cut by the prompt builder). At most `maxChunks` chunks are returned; `unreadFromPage` is the
 * first page of the rest (1-based), or undefined when everything fits (FR-051).
 */
export function chunkPages(pages: string[], maxChars = MAX_CHARS, maxChunks = MAX_LLM_CHUNKS_PER_DOCUMENT): { chunks: PageChunk[]; unreadFromPage?: number } {
  const chunks: PageChunk[] = [];
  let cur: string[] = [];
  let curStart = 1;
  let size = 0;
  for (let i = 0; i < pages.length; i++) {
    const n = pageChars(pages[i]!);
    if (cur.length && size + n > maxChars) {
      chunks.push({ startPage: curStart, pages: cur });
      if (chunks.length >= maxChunks) return { chunks, unreadFromPage: i + 1 };
      cur = []; curStart = i + 1; size = 0;
    }
    cur.push(pages[i]!);
    size += n;
  }
  if (cur.length) chunks.push({ startPage: curStart, pages: cur });
  return { chunks };
}

/** "Pages 181–240 of X.pdf were not read by AI" (FR-051). `from`/`to` are 1-based and inclusive. */
export function unreadPagesNote(fileName: string, from: number, to: number): string {
  return from === to
    ? `Page ${from} of ${fileName} was not read by AI`
    : `Pages ${from}–${to} of ${fileName} were not read by AI`;
}

export interface LlmExtractResult {
  requirements: Requirement[];
  used: boolean;
  error?: string;
  /** Characters sent to the LLM (0 when not called). */
  inputChars: number;
  /** The validated items the model returned, before merging (escalation compares them with the rules). */
  llmItems: Requirement[];
}

/** Run the LLM extractor and merge; on any failure, fall back to the rule results. */
export async function enrichWithLlm(
  pages: string[],
  rules: Requirement[],
  completeJson: CompleteJson | null | undefined,
  src: { documentId?: string; fileName?: string } = {},
  opts: { maxChars?: number; startPage?: number } = {},
): Promise<LlmExtractResult> {
  if (!completeJson || !pages.length) return { requirements: rules, used: false, inputChars: 0, llmItems: [] };
  const prompt = buildLlmPrompt(pages, rules, opts.maxChars, opts.startPage);
  const inputChars = promptChars(prompt);
  try {
    const reply = await completeJson(prompt);
    const llm = parseLlmRequirements(reply, src);
    return { requirements: mergeRequirements(rules, llm), used: true, inputChars, llmItems: llm };
  } catch (e) {
    return { requirements: rules, used: false, error: (e as Error).message, inputChars, llmItems: [] };
  }
}

// ───────────── Escalation (FR-050) ─────────────

/** Requirements that can turn a verdict into No-Go; an uncertain one is adjudicated by the escalation model. */
export const BLOCKING_KEYS = ['turnover_min', 'experience_years', 'oem_auth', 'emd'] as const;
/** A rule result below this confidence is uncertain. */
export const ESCALATION_CONFIDENCE = 0.75;
const ESCALATION_MAX_CHARS = 30_000;

/** Yes/No-like values compare as booleans so `true` and "Yes" are not a conflict. */
const valueKey = (r: Requirement) => {
  const v = norm(r.value ?? r.label);
  return /^(true|yes|required|mandatory)\b/.test(v) ? 'true' : /^(false|no|not required)\b/.test(v) ? 'false' : v;
};
const sameValue = (a: Requirement, b: Requirement) =>
  a.numeric != null && b.numeric != null ? a.numeric === b.numeric : valueKey(a) === valueKey(b);

/**
 * Blocking keys to adjudicate: the rules found it with confidence < 0.75, or the rule and the LLM disagree on its value.
 * Returns the rule item and, for a conflict, the LLM's competing item.
 */
export function escalationCandidates(rules: Requirement[], llmItems: Requirement[]): { key: string; rule: Requirement; llm?: Requirement }[] {
  const out: { key: string; rule: Requirement; llm?: Requirement }[] = [];
  for (const key of BLOCKING_KEYS) {
    const rule = rules.find((r) => r.key === key && r.method === 'RULE');
    if (!rule) continue;
    const llm = llmItems.find((r) => r.key === key);
    const conflict = !!llm && !sameValue(rule, llm);
    if (rule.confidence < ESCALATION_CONFIDENCE || conflict) out.push({ key, rule, ...(conflict ? { llm } : {}) });
  }
  return out;
}

const ESCALATION_SYSTEM = `You are a senior Indian public-procurement analyst adjudicating ONE disputed or uncertain eligibility requirement
of a Government e-Marketplace (GeM) bid. Decide from the document text only. Quote the exact supporting text (max 200
characters) and its page number. If the text does not state the requirement, return no item for that key. Amounts are
integer rupees (1 lakh = 100000, 1 crore = 10000000). Pages are marked "=== Page N ===".`;

export function buildEscalationPrompt(pages: string[], candidates: ReturnType<typeof escalationCandidates>): LlmPrompt {
  const cited = new Set<number>();
  for (const c of candidates) for (const r of [c.rule, c.llm]) if (r?.source.page) cited.add(r.source.page);
  // Pages the rules / the model cited, then (when nothing was cited) the start of the document.
  const order = cited.size ? [...cited].sort((a, b) => a - b).filter((n) => n >= 1 && n <= pages.length) : pages.map((_, i) => i + 1);
  let budget = ESCALATION_MAX_CHARS;
  const parts: string[] = [];
  for (const n of order) {
    if (budget <= 0) break;
    const text = pages[n - 1]!.replace(/[ \t]+/g, ' ').trim().slice(0, budget);
    budget -= text.length;
    parts.push(`=== Page ${n} ===\n${text}`);
  }
  const show = (r: Requirement | undefined) => (r ? `${typeof r.value === 'string' ? r.value : JSON.stringify(r.value ?? null)}${r.source.quote ? ` (quote: "${r.source.quote}")` : ''}` : '(none)');
  const list = candidates.map((c) => `- ${c.key}: rules found ${show(c.rule)} with confidence ${c.rule.confidence}; model found ${show(c.llm)}`).join('\n');
  const prompt = `Adjudicate these requirements:
${list}

Return JSON of the form:
{"requirements":[{"key":"<${candidates.map((c) => c.key).join('|')}>","label":"short human label","value":"string|number|boolean","numeric":number|null,"mandatory":true|false,"page":number,"quote":"exact supporting text, max 200 chars","confidence":0..1}]}

Document text:
${parts.join('\n\n')}`;
  return { system: ESCALATION_SYSTEM, prompt, maxTokens: 2048, jsonSchema: LLM_REQUIREMENTS_JSON_SCHEMA };
}

/**
 * Merge adjudicated items into `current`: for a candidate key, an item WITH a quote replaces the existing single-valued
 * requirement (never a MANUAL one) when it contradicts it or is more confident. The result stays an LLM item, capped
 * at 0.9, and is scored by the deterministic engine like any other (FR-048).
 */
export function applyEscalation(current: Requirement[], adjudicated: Requirement[], candidates: ReturnType<typeof escalationCandidates>): Requirement[] {
  const out = [...current];
  for (const c of candidates) {
    const a = adjudicated.find((r) => r.key === c.key && r.source.quote);
    if (!a) continue;
    const i = out.findIndex((r) => r.key === c.key);
    if (i < 0) { out.push(a); continue; }
    if (out[i]!.method === 'MANUAL') continue;
    if (!sameValue(out[i]!, a) || a.confidence > out[i]!.confidence) out[i] = a;
  }
  return out;
}

export interface EscalationResult { requirements: Requirement[]; used: boolean; keys: string[]; inputChars: number; error?: string }

/** Ask the escalation model to adjudicate uncertain/conflicting blocking requirements; falls back to `current` on error. */
export async function escalateWithLlm(
  pages: string[],
  current: Requirement[],
  rules: Requirement[],
  llmItems: Requirement[],
  completeJson: CompleteJson | null | undefined,
  src: { documentId?: string; fileName?: string } = {},
): Promise<EscalationResult> {
  const candidates = completeJson ? escalationCandidates(rules, llmItems) : [];
  if (!completeJson || !candidates.length || !pages.length) return { requirements: current, used: false, keys: [], inputChars: 0 };
  const prompt = buildEscalationPrompt(pages, candidates);
  const inputChars = promptChars(prompt);
  const keys = candidates.map((c) => c.key);
  try {
    const adjudicated = parseLlmRequirements(await completeJson(prompt), src).filter((r) => keys.includes(r.key));
    return { requirements: applyEscalation(current, adjudicated, candidates), used: true, keys, inputChars };
  } catch (e) {
    return { requirements: current, used: false, keys, inputChars, error: (e as Error).message };
  }
}
