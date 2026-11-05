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

## Amendments

- **2026-11-05 — 004/US7 (PR #560, OCR and chunked reading).**
  - *Manual OCR is metered as an AI slot.* Each `POST /tenders/:id/documents/:docId/ocr` run reserves one
    `llmAnalysesPerMonth` slot under its own `analysis_ref` (no `analysis_id`), under the org row lock
    (`reserveOcrSlot`, `apps/api/src/lib/plan.ts`) → 402 `plan_limit_reached` when the slots are used up. A run whose
    calls reached the model keeps the slot even when it fails (no free retries beyond the quota and the `ocr.org` rate
    limit); a run that never reached the model gives it back. We chose the existing AI slot over a separate OCR page cap:
    it needs no new plan field, shows in `GET /org/usage`, and a 150-page OCR costs about as much as an AI analysis.
  - *Automatic OCR inside analyse* is metered under the coming analysis's id and shares its slot, which it reserves
    atomically under the org row lock (`reserveOcrSlot` with that id as `analysis_ref`) BEFORE its first call — no
    lock-free pre-check, so concurrent analyses at the quota cannot all OCR. The analysis then links the reservation and
    uses it for its enrichment calls; whether the analysis may use AI comes from that reservation, not from the quota
    re-check. If the analysis row is never inserted (409/422/402 after OCR): rows of an OCR run that stored text keep
    one slot under a fresh `analysis_ref` (every stored OCR text is paid for by a slot); otherwise the unused
    reservation is released and the rows keep their tokens but lose their `analysis_ref`. A document whose automatic OCR
    failed — for any reason, including running out of the analysis's time — is recorded (`tender.document_ocr_failed`)
    and analyse does not OCR it again until someone runs OCR on it explicitly (or the document is replaced).
  - *One OCR run per document.* Before reserving a slot, a run claims the document: a row `ocr-claim:<documentId>` in
    `rate_limits` (no migration; `window_start` = claim time, pruned with the other old rows), checked and inserted under
    a transaction-scoped advisory lock on that key and deleted when the run ends. A claim older than the OCR budget + 2
    minutes (a crashed run) is ignored. A concurrent manual run → 409 `conflict`; analyse skips the document. A
    session-level advisory lock was rejected: it would pin a pooled (Neon) connection for the minutes OCR takes.
  - *Re-OCR (`?force=1`)* is limited to the org's own uploads (bid_manager+). Shared GeM rows are read once for all
    organisations: one org cannot spend its slots replacing the text every other org analyses → 403.
  - *Abandoned reservations.* `reserveOcrSlot` first deletes, under the org lock, the org's unfilled reservations with
    no `analysis_id` older than 15 minutes (left by a process that died mid-run; a live run is bounded by the 10-minute
    OCR budget).
  - *Calls aborted in flight* (our timeout) before the provider reports usage are recorded with 0 tokens because the
    columns are NOT NULL, and a warning with `usageUnknown: true` is logged: the real count is unknown and may be billed.
  - **Cost raise — needs product sign-off before release.** 004/FR-051 raised 008/FR-031's per-analysis caps from
    2 calls / 90,000 characters to **8 calls / 480,000 characters** (automatic OCR calls count towards the 8). Worst case
    per AI analysis (≈ 4 characters per token):

    | | before | after |
    |---|---|---|
    | enrichment input | 90k chars ≈ 22.5k tokens | 8 × (60k doc + ~3k prompt) chars ≈ 126k tokens (~5.6×) |
    | enrichment output (max) | 2 × 4,096 = 8,192 tokens | 8 × 4,096 = 32,768 tokens (4×) |
    | escalation (inside the 8 calls) | — | ≤ 30k chars ≈ 7.5k input + 2,048 output tokens |
    | automatic OCR (inside the 8 calls, OCR model) | — | ≤ 4 calls × 5 pages: ≈ 30–60k input tokens (≈ 1.5–3k per PDF page), ≤ 30,000 output tokens |

    i.e. roughly **5× the worst-case token cost per AI analysis** (more when the OCR model is priced above the
    enrichment model). One manual OCR run of a 150-page scan is up to 30 calls: ≈ 225–450k input and ≤ 225,000 output
    tokens on the OCR model, for one AI slot. Typical tenders (1–3 documents of < 60k characters) still make 1–3 calls.
    Product owner to confirm the plan prices (`PLAN_LIMITS.llmAnalysesPerMonth`) still cover this, or lower the caps in
    `packages/core/src/contracts/caps.ts` / `packages/core/src/analyse/ocr.ts`.
