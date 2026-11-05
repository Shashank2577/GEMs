# ADR-0008: LLM cost control — metering, per-org quotas, and a shared extraction cache for public documents

**Status**: Proposed
**Date**: 2026-11-05
**Priority**: MUST (metering + quota) · SHOULD (shared cache)

## Context

When `ANTHROPIC_API_KEY` is set, every analysis sends every document to the model (`services/analyse.ts` →
`enrichWithLlm`), ~15k input tokens per 60k-char chunk, 4,096 max output. There is no record of token usage, no
per-org limit, and the extraction is repeated for every org that analyses the same public GeM PDF — although the
LLM step depends only on the document text (and `tender.estimatedValue`), not on the org. Scoring
(`scoreTender`) is the org-specific part and is pure/cheap.

Any analyst can trigger analyses without limit; spend is unbounded and invisible until the provider invoice.

## Decision

1. **Meter every call (MUST)**. New table
   `llm_usage (id, org_id, user_id, analysis_id null, model, input_tokens, output_tokens, latency_ms, ok bool, created_at)`
   with index `(org_id, created_at)`. `adapters/llm.ts` already returns `usage`; `services/analyse.ts` inserts one row
   per call (also on failure with `ok=false`). `GET /org/usage` (ADR-0010) exposes month-to-date counts.
2. **Per-org quota by plan (MUST)**. `PLAN_LIMITS[plan].analysesPerMonth` (ADR-0010); `analyseTender` checks
   `count(analyses where org_id=$org and created_at >= month_start)` before starting and throws 402
   `plan_limit_reached` with `details: { limit, used, resetsAt }`. The rules-only path still runs when the LLM quota
   is exhausted but the plan allows analyses: expose `PLAN_LIMITS[plan].llmAnalysesPerMonth` separately so trial
   orgs get rules+LLM for N analyses, then rules-only with a visible "AI enrichment paused" note (Constitution III).
3. **Shared extraction cache (SHOULD)**. Add to `tender_documents`: `requirements jsonb`, `extractor_version text`,
   `extracted_at timestamptz`, `extracted_method text ('rules'|'rules+llm')`. In `analyseTender`, for documents with
   `org_id IS NULL` (public GeM docs): if `extractor_version === CURRENT_EXTRACTOR_VERSION`, reuse `requirements`;
   otherwise extract (rules + LLM within the ADR-0007 budget) and store. Org-uploaded documents are cached the same
   way but are only visible to that org anyway. `CURRENT_EXTRACTOR_VERSION` lives in `packages/core/src/analyse/rules.ts`
   and is bumped whenever rules or the prompt change, so a prompt fix invalidates the cache deterministically.
   Corrigenda already mark analyses `stale`; a new document version is a new row, so cache keys stay valid.
4. Keep `LLM_MODEL` configurable; log model + tokens with `rid` so cost per request is greppable.

## Consequences

- Spend becomes bounded per org per month and attributable to a plan; invoices can be reconciled against `llm_usage`.
- The first org to analyse a tender pays the extraction once; the 2nd–Nth analyses of the same GeM document are
  rules-fast and free. This also cuts analysis latency for most users (popular tenders are analysed by many).
- `tender_documents` rows grow by one jsonb per document (a few KB) — negligible next to `text`.
- Changing the prompt or rules requires a version bump; forgetting it means stale cached requirements — covered by a
  unit test that pins `CURRENT_EXTRACTOR_VERSION` to a hash of the rules file + prompt text.

## Acceptance

- API test: fake LLM returns `usage {100, 50}` → one `llm_usage` row per call with the right org; `/org/usage`
  reports it.
- Trial org with limit 10: 11th analysis in the month → 402 `plan_limit_reached`; rules-only fallback behaves as
  specified.
- Two orgs analyse the same GeM document: the fake LLM is called once; the second analysis has `method` reflecting
  the cached method and completes without an LLM call.
