# Implementation Plan: Analyse — Bid Documents, Eligibility Extraction & Go/No-Go Scoring

**Branch**: `004-analyse-scoring` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-analyse-scoring/spec.md`

**Note**: This plan describes the design **as built** (verified against the code on 2026-11-05) and the design of the
*(gap)* requirements. Contracts extend `specs/001-gem-tender-copilot/contracts/api.md § Analyse`.

## Summary

Analyse turns a GeM tender into an explainable Go/No-Go decision. Documents arrive by polite GeM download (shared,
public) or private upload; text is extracted per page with `unpdf` at ingest time. A deterministic, label-table rules
extractor (bilingual-label tolerant) produces requirements with page/quote provenance; an optional Claude pass adds
ATC-specific items (capped confidence, never decides). A pure scoring engine evaluates ten weighted factors against the
org's profile, past contracts, vault and weights, applies MSE/Startup exemptions and blockers, carries audited overrides
and builds a stable-id checklist. Ingested corrigenda mark analyses stale. Remaining work: label variants ported from
erenmyeager15, bid-number mismatch detection, robust run lifecycle (409 on concurrent runs, keep last good result and
overrides), richer staleness (profile/vault/weights/document changes with reasons), OEM product matching, structured
LLM output with model tiers (Sonnet enrichment, Opus OCR, optional Fable escalation), an OCR path for scanned PDFs,
checklist readiness on the tender page, and Playwright E2E with evidence per story.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 22 locally/CI, Cloudflare Workers in production

**Primary Dependencies**: Hono (API), Drizzle ORM (Postgres), zod (contracts), `unpdf` (pdf.js serverless build; text extraction on Node and Workers), `pdf-lib` (fixture generation, PDF splitting for OCR), React 18 + TanStack Query + framer-motion + Tailwind (web), Anthropic Messages API via `fetch` (`apps/api/src/adapters/llm.ts`)

**Storage**: Postgres (Neon in prod) tables `tenders`, `tender_documents`, `analyses`, `organizations.scoring_weights`, `company_profiles`, `past_contracts`, `vault_documents`, `activity_log`, `tender_events`; private blobs (R2 in prod, filesystem locally) under `tenders/<tenderId>/{gem|<orgId>}/<uuid>.pdf`

**Testing**: Vitest unit tests (`packages/core/test/analyse/*.test.ts`), API integration tests against real Postgres (`apps/api/test/analyse.test.ts`, fake LLM client), Playwright E2E (`e2e/004-analyse/US<n>-*.e2e.ts`) with mock-gem on :4011 and evidence in `qa/evidence/004/US<n>/`

**Target Platform**: Cloudflare Workers + static SPA; local Node + Postgres for dev/CI

**Project Type**: Web application (pnpm monorepo: `packages/core`, `packages/db`, `apps/api`, `apps/web`, `tools/mock-gem`)

**Performance Goals**: rules-only analysis p95 < 5 s for ≤ 10 pages; full analysis with LLM < 60 s for ≤ 40 pages; OCR of 10 scanned pages < 90 s

**Constraints**: Works with zero API keys (Constitution III); ≤ 1 GeM request/s; uploads ≤ 25 MB; Worker memory 128 MB; Claude PDF input ≤ 32 MB request / 600 pages (100 for 200K-context models); ≤ 8 LLM calls per analysis

**Scale/Scope**: ~1–5k open GeM bids/day ingested; per org tens of analyses/day; documents 2–60 pages typical

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How this feature complies | Status |
|---|---|---|
| I. Human-in-the-loop submission | Analyse only reads documents and recommends; no price, no GeM login, no submission. Overrides are human decisions. | ✅ |
| II. Polite, public-only ingestion | GeM documents fetched once per tender via `GemClient` (≤ 1 req/s, honest UA, back-off, public `/showbidDocument`); source URL + fetch time kept (`tender_documents.source_url`, `created_at`). Gap FR-008 adds a byte cap; FR-046 re-fetches only on corrigendum. | ✅ |
| III. Deterministic first, models second | Rules path produces every verdict with zero keys; LLM items carry method `LLM`, page, quote, confidence ≤ 0.9; LLM failures fall back to rules; factors and summary explain the score. OCR output is marked `source.ocr` and capped at 0.8. Escalation model (FR-050) only extracts. | ✅ |
| IV. Tenant isolation & data protection | Analyses, uploads, weights scoped by `org_id`; GeM copies are public data; downloads `private, no-store`; FR-054 forbids sending profile/vault data to the LLM. Roles enforced server-side (`requireRole`). | ✅ |
| V. Delightful, accessible UX | Loading/empty/error/stale states for every tab; 375 px and 1440 px layouts; reduced motion; aria labels; gap FR-056 adds axe scans. | ✅ (axe gate pending) |
| VI. Test-first, E2E verified | 42 core unit tests + API tests exist; E2E per story is the main open work (T025, T038, T054, T064, T070, T080, T094). | ⚠️ open — tracked |
| VII. Edge-native, serverless | `unpdf` and fetch-based Anthropic adapter run on Workers; no LLM key → `deps.llm = null` (logged no-op). OCR uses only fetch + pdf-lib. | ✅ |
| VIII. Simplicity & traceability | One schema (`packages/db/src/schema.ts`), types mirrored in `packages/core/src/analyse/types.ts`; tasks reference FR ids; ported code attributed in `NOTICE`. | ✅ (NOTICE file missing — T004) |

No violations requiring Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/004-analyse-scoring/
├── spec.md              # Feature specification (this area)
├── plan.md              # This file
└── tasks.md             # Task list (built [x] / open [ ])
```

Contracts live in `specs/001-gem-tender-copilot/contracts/api.md § Analyse` (extended by the endpoint table below);
data model in `packages/db/src/schema.ts` (single source of truth).

### Source Code (repository root)

```text
packages/core/src/
├── analyse/
│   ├── pdf-text.ts        # isPdf, extractPages (unpdf), joinPages/splitPages (\f), looksScanned
│   ├── rules.ts           # flattenText, parseIndianAmount, parseGemDateTime, LABELS table, ATC scans,
│   │                      # requirementsFromListing, combineRequirements, requirementId
│   ├── llm.ts             # buildLlmPrompt, parseLlmRequirements (zod), mergeRequirements, enrichWithLlm
│   ├── score.ts           # FACTOR_KEYS/LABELS, DEFAULT_WEIGHTS, resolveWeights, scoreTender, computeScore
│   ├── checklist.ts       # buildChecklist, ANNEXURE_KEYS, isMseProfile/isStartupProfile
│   ├── format.ts          # inr(), groupIN(), plural(), years()
│   ├── sample-bid.ts      # GeM-style fixture PDF generator (tests, mock-gem, demo)
│   ├── types.ts           # Requirement, ScoreFactor, ChecklistItem, DocType (mirror of db jsonb types)
│   └── ocr.ts             # (new, gap) splitPdfForOcr, buildOcrRequest, parseOcrPages
├── contracts/analyse.ts   # zod schemas + DTOs (override, weights, documents, AnalysisDto)
└── gem/client.ts          # GemClient.fetchBidDocument (+ byte cap, gap)
packages/core/test/analyse/ # rules, llm, score, checklist tests (+ pdf-text, ocr, bilingual corpus — new)
packages/core/test/fixtures/bids/ # go-it-services, review-hardware-oem, nogo-experience, emd-exempt-mse (+ real-layout PDFs — new)

packages/db/src/schema.ts   # tenders, tender_documents, analyses, organizations.scoring_weights …
packages/db/migrations/     # 0000_last_shocker.sql (+ 0001_analyse_stale_ocr.sql — new)

apps/api/src/
├── routes/analysis.ts      # documents, fetch, download, analyse, analysis, override, scoring-weights
├── services/analyse.ts     # upload/fetch/analyse/override/weights orchestration
├── services/ingest.ts      # corrigendum → analyses.stale = true
├── services/staleness.ts   # (new, gap) markStale(orgId?, tenderIds?, reason)
├── routes/profile.ts, routes/vault.ts  # call markStale (gap)
├── adapters/llm.ts         # Anthropic Messages client (+ structured output, usage, model tiers — gap)
├── env.ts, deps.ts         # ANTHROPIC_API_KEY, LLM_MODEL (+ LLM_OCR_MODEL, LLM_ESCALATION_MODEL — gap)
apps/api/test/analyse.test.ts (+ staleness.test.ts, ocr.test.ts — new)

apps/web/src/features/tender/
├── TenderPage.tsx  TenderHero.tsx  AnalysingState.tsx  AnalysisPanel.tsx  ChecklistCard.tsx
├── RequirementsTab.tsx  DocumentsTab.tsx  HistoryTab.tsx  labels.ts  api.ts
apps/web/src/features/settings/sections/ScoringSection.tsx
apps/web/src/features/feed/TenderCard.tsx, workspace/WorkspaceHeader.tsx, workspace/QualifyStep.tsx (stale badges)

e2e/004-analyse/US1…US7-*.e2e.ts   # (new) Playwright per story
qa/evidence/004/US<n>/             # screenshots, video, trace, VERDICT.md
tools/mock-gem/src/app.ts          # /showbidDocument/:id (+ /__admin/document-mode for scanned/oversize — new)
NOTICE                              # (new) third-party attributions
```

**Structure Decision**: Keep domain logic pure in `packages/core/src/analyse` (no I/O; LLM injected as `CompleteJson`),
orchestration in `apps/api/src/services/analyse.ts`, thin routes, UI in `apps/web/src/features/tender`. New logic follows
the same split: OCR request building/parsing in core, the network call in the API adapter; staleness marking in a new
small service used by ingest, profile, vault and analysis routes.

## API Endpoints

All under `/api`, JSON unless noted, errors `{error:{code,message,details?}}`. Roles: V = viewer+, A = analyst+, M = bid_manager+.

| Method & path | Role | Request | Success | Errors | Status |
|---|---|---|---|---|---|
| `GET /tenders/:id/documents` | V | — | 200 `{items: TenderDocumentDto[], total}` | 404 tender | built |
| `POST /tenders/:id/documents` | A | multipart `file`, `kind?` | 201 `TenderDocumentDto` (+ `warnings[]`, `bidNumberFound` — gap FR-010) | 400 `bad_request` / `validation_error`, 403, 404, 413 `payload_too_large`, 415 `unsupported_media_type`, 422 `unreadable_pdf` | built (+gap) |
| `POST /tenders/:id/fetch-documents` | A | — (gap: `?refresh=1` after corrigendum, FR-046) | 201 `{items,total,fetched:1}` / 200 `{fetched:0}` | 403, 404, 422 `no_gem_document`, 502 `gem_unavailable` (incl. > 25 MB, gap FR-008) | built (+gap) |
| `GET /tenders/:id/documents/:docId/download` | V | `?inline=1` | 200 PDF stream | 404 | built |
| `DELETE /tenders/:id/documents/:docId` | A | — | 204 | 403 (GeM doc), 404 | gap FR-009 |
| `POST /tenders/:id/documents/:docId/ocr` | A | — | 200 `TenderDocumentDto` (`textSource:'ocr'`) | 404, 409 `conflict` (has text), 502 `ocr_failed`, 503 `ocr_unavailable` | gap FR-052 |
| `POST /tenders/:id/analyse` | A | — | 201 `AnalysisDto` (with `documents`) | 403, 404, 409 `analysis_running` (gap FR-028), 422 `no_documents`, 500 `analysis_failed` | built (+gap) |
| `GET /tenders/:id/analysis` | V | — | 200 `AnalysisDto` (+ `lastAttempt`, `staleReason`, `staleAt`, `notes` — gap) | 404 | built (+gap) |
| `POST /analyses/:id/override` | M | `{factorKey, status, reason}` | 200 `AnalysisDto` | 400 `validation_error`, 403, 404, 409 `conflict` | built |
| `POST /analyses/:id/rescore` | A | — | 200 `AnalysisDto` | 403, 404, 409 (not done) | gap FR-037 |
| `GET /scoring-weights` | V | — | 200 `{weights, defaults, custom}` | — | built |
| `PUT /scoring-weights` | M | partial `{[factorKey]: 0..100}` or `{}` | 200 `{weights, defaults, custom}` | 400 `validation_error`, 403 | built |
| `GET /analysis/capabilities` | V | — | 200 `{ai, ocr, models:{enrichment?, ocr?, escalation?}}` | — | gap FR-053 |

`AnalysisDto` additions (gap): `staleReason: 'corrigendum'|'document_added'|'document_removed'|'profile_changed'|'vault_changed'|'weights_changed'|null`,
`staleAt: string|null`, `notes: string[]`, `lastAttempt?: {status:'running'|'failed', error: string|null, at: string}`.
`TenderDocumentDto` additions (gap): `textSource: 'pdf'|'ocr'`, `bidNumberFound: string|null`.

## Data Model Touch-points

| Table / column | Used for | Change |
|---|---|---|
| `tenders.gem_bid_id`, `document_url`, `source_url` | GeM document reference; `document_url` set after first fetch | — |
| `tenders.end_at`, `state`, `emd_amount`, `estimated_value`, `epbg_percent`, `category`, `title`, `items` | listing fallback requirements; time-to-close; delivery state; OEM product match (gap) | — |
| `tender_documents.{id, tender_id, org_id (null = GeM), kind, file_name, blob_key, size_bytes, page_count, text, source_url, created_at}` | documents | add `text_source text not null default 'pdf'` (gap FR-052) |
| `analyses.{id, org_id, tender_id, status, method, requirements, factors, checklist, score, confidence, verdict, summary, error, stale, created_by, created_at, updated_at}` | analysis runs | add `stale_reason text`, `stale_at timestamptz`, `notes jsonb not null default '[]'` (gap FR-043, FR-051); index `(org_id, tender_id, created_at desc)` covers latest-done query |
| `organizations.scoring_weights jsonb` | per-org weights (null = defaults) | — |
| `company_profiles.{financials, incorporation_date, mse_category, udyam_number, is_startup, dpiit_number, mii_class, local_content_pct, oem_authorizations, certifications, max_emd_capacity, operating_states}` | scoring inputs | — (mutations call `markStale`, gap) |
| `past_contracts.{value, start_date, end_date, title, category}` | experience, similar work | — (mutations call `markStale`) |
| `vault_documents.{type, title, expiry_date, tags}` | validity of Udyam/DPIIT/OEM/certificates/docs | — (mutations call `markStale`) |
| `activity_log` actions | `tender.document_uploaded`, `tender.document_fetched`, `tender.analysed`, `analysis.factor_overridden`, `org.scoring_weights_updated` (+ `tender.document_removed`, `tender.document_ocr`, `analysis.rescored` — gap) | — |
| `tender_events.kind = 'corrigendum'` | history + stale trigger | — |
| jsonb `Requirement.source` | provenance | add optional `ocr?: boolean` (mirror in `packages/core/src/analyse/types.ts` and `packages/db/src/schema.ts`) |

Migration: `pnpm --filter @tp/db drizzle-kit generate` → `packages/db/migrations/0001_*.sql` (additive, nullable/defaulted
columns; safe online).

## Key Flows

### Upload (built)

```text
Web DocumentsTab → POST /tenders/:id/documents (multipart)
  route: requireRole(analyst) → parseBody → kind default 'bid'
  service.uploadTenderDocument: getTender (404) → size/empty/magic checks → extractPages (unpdf) [422 on PdfTextError]
    → blobs.put(tenders/<t>/<org>/<id>.pdf) → insert tender_documents (text \f-joined, page_count)
    → activity tender.document_uploaded {scanned: looksScanned(pages)}
  ← 201 DTO → toast "<file> uploaded · N pages read" (+ Re-analyse action)
  (gap) → detect bid number → warnings; markStale(org, tender, 'document_added')
```

### Fetch from GeM (built)

```text
POST /tenders/:id/fetch-documents → existing GeM copy? → 200 {fetched:0}
  → ref = gem_bid_id ?? document_url (none → 422 no_gem_document)
  → GemClient.fetchBidDocument(ref) [≤1 req/s, retries 2, timeout 45 s, %PDF- check] (fail → 502 gem_unavailable)
  → extractPages → blobs.put(tenders/<t>/gem/<id>.pdf) → insert (org_id null, kind bid, source_url)
  → set tenders.document_url if empty → activity tender.document_fetched → 201 {fetched:1}
```

### Analyse (built; gaps marked)

```text
POST /tenders/:id/analyse
  → getTender → docs = listTenderDocuments(org) ; none & GeM ref → fetchGemDocuments (errors swallowed+logged)
  → none → 422 no_documents
  → (gap) running row < 2 min → 409 analysis_running
  → previous = latest analysis   (gap: latest DONE analysis, FR-029)
  → insert analyses(status running)
  → for doc in sort(kind order bid,atc,boq,other,corrigendum; created_at):
        pages = splitPages(text)   (gap: empty & OCR model → ocr first, FR-052)
        rules = extractRequirementsRules(pages, {documentId, fileName, estimatedValue})
        llm?  → enrichWithLlm(pages, rules, completeJson)  (gap: chunks ≤ 60k chars, structured output, escalation)
  → requirements = combineRequirements(perDoc, requirementsFromListing(tender))
  → company = profile, pastContracts, vault, org weights
  → result = scoreTender({... overrides: overridesOf(previous), now})
  → checklist = buildChecklist(requirements, profile)
  → update analyses(done, method, requirements, factors, checklist, score, confidence, verdict, summary, stale false)
     (gap FR-045: keep stale when stale_at > created_at)
  → activity tender.analysed → 201 AnalysisDto
  on error → update(status failed, error) → 500 analysis_failed
```

### Override & weights (built)

```text
POST /analyses/:id/override {factorKey,status,reason} → requireRole(bid_manager) → zod
  → analysis(org) 404 → status done? else 409 → factor exists? else 404
  → factors' = set/remove overridden{status,reason,by,at} → computeScore(factors') → update → activity → 200
PUT /scoring-weights → zod strict 0..100 → resolveWeights → organizations.scoring_weights → activity → 200
  (gap) → markStale(org, openTenders, 'weights_changed')
```

### Staleness (built: corrigendum; gap: everything else)

```text
ingest.upsertTender: diffTenders(prev, merged) → isCorrigendum(changes ∩ CORRIGENDUM_FIELDS)
  → tender_events(kind corrigendum) → analyses.stale = true (all orgs)  (gap: stale_reason 'corrigendum', stale_at now)
(gap) services/staleness.markStale(db, {orgId?, tenderIds? | openOnly}, reason, now)
  ← routes/profile.ts PUT /profile, POST/PATCH/DELETE /past-contracts  → 'profile_changed'
  ← routes/vault.ts POST/PATCH/PUT file/DELETE /vault                 → 'vault_changed'
  ← analysis routes upload/delete document                            → 'document_added'/'document_removed'
  ← PUT /scoring-weights                                              → 'weights_changed'
```

### OCR (gap)

```text
doc.hasText=false & deps.ocrLlm → core/ocr.splitPdfForOcr(bytes, maxPages 100, maxBytes 22 MB) (pdf-lib)
  → per part: Messages API {model: LLM_OCR_MODEL, content:[{type:'document', source:{type:'base64', media_type:'application/pdf', data}}, {type:'text', text: OCR_PROMPT}],
                            output_config:{format: json_schema {pages:[{page, text}]}}}
  → parseOcrPages → joinPages → update tender_documents.text, text_source 'ocr' → activity tender.document_ocr
  → rules/LLM extraction as usual; requirements from this doc get source.ocr=true, confidence min(c, 0.8)
```

### LLM adapter changes (gap, FR-049/050)

- Keep the dependency-free `fetch` adapter (Workers-friendly; constitution VII) but add: `output_config: {format: {type: 'json_schema', schema}}` for `completeJson`, read `stop_reason` (`refusal`, `max_tokens` → throw `LlmError`), return/log `usage` and `model`; set `anthropic-version: 2023-06-01` as today. Evaluate migrating to `@anthropic-ai/sdk` (Workers-compatible) in a separate spike task; do not mix both.
- Models from env: `LLM_MODEL` (default `claude-sonnet-5-5`), `LLM_OCR_MODEL` (default `claude-opus-5-5`), `LLM_ESCALATION_MODEL` (unset). Model ids are exact strings; no date suffixes.
- Do not send `temperature`/`top_p` (rejected on current models); no assistant prefill.
- The OCR system prompt is static, so mark it with `cache_control` when the same document is sent to both OCR and escalation calls in one analysis.

## Porting from reference repositories

| Source (licence) | What | Target | Why |
|---|---|---|---|
| `refs/erenmyeager15_india-government-tenders-scraper/src/routes.ts` `buildEligibilitySummary` (Apache-2.0) | Regexes for "MSE Relaxation for Years Of Experience (and Turnover)", "Startup Relaxation …", values "Yes \| Complete"/"No \| Complete", "Years of Past Experience Required for same/similar service", "Minimum Average Annual Turnover of the bidder (For 3 Years)" | `packages/core/src/analyse/rules.ts` `LABELS` + `yesNo` | Newer GeM PDFs use "Relaxation" labels — our table only knows "Exemption", so exemptions are silently missed (FR-018) |
| same, `mergeGemPdfDetails` | "Dated: dd-mm-yyyy" published date; "Contract Period" stop label; explicit "Corrigendum Count" regex | `rules.ts` (`bid_published_at`, `contract_period`) | Service bids need contract period; published date helps detect wrong/old PDFs (FR-019) |
| same, `inferIndianState` + `INDIAN_STATES` | State inference from PDF text | `rules.ts` `consignee_state` (scoped to the consignee block, not the whole text) | Delivery feasibility when the listing lacks a state (FR-019) |
| same, `fetchWithRetries({maxBytes})`, `isPdfBody` | Byte-capped download, PDF body check | `packages/core/src/gem/client.ts` `fetchBidDocument` | Protect Workers memory from huge/hostile responses (FR-008) |
| same, `src/pdf.test.ts` + `test/fixtures/synthetic-tender.pdf` | Pooled-Buffer byte-safety test; invalid-PDF rejection test; synthetic fixture with "Bid Opening Date/Time 31-10-2026 10:00:00" | `packages/core/test/analyse/pdf-text.test.ts`, `packages/core/test/fixtures/bids/synthetic-tender.pdf` | `extractPages` copies the buffer for pdf.js; lock this behaviour in (NFR-010) |
| `refs/Mujahid-Alam_gem-tender-pdf-extractor/gem3.py` (no licence — ideas only, no code copied) | Page-1 line-prefix field list (Bid End Date/Time, Opening, Offer Validity, Ministry/State, Department, Organisation, Office, Total Quantity, Item Category, MSE/Startup lines) | Cross-check list in `rules.test.ts` corpus assertions | Confirms our label coverage; its fixed line indexes (`text.split('\n')[18]`) are brittle — our label-to-next-label approach is kept |
| `refs/arush15june_gem-search` (MIT) | Already credited for the GeM request shape in `gem/client.ts` | — | Attribution in `NOTICE` |

All ports recorded in a new root `NOTICE` (the file is referenced from `gem/client.ts` but does not exist yet).

## Research & Decisions

- **Text extraction**: `unpdf` over `pdf-parse` (erenmyeager15) because it runs on Workers and gives per-page text, which provenance needs. Decision kept.
- **Workers budget (T052, NFR-005) — decision: cap extraction at 150 pages per PDF, with an upload warning.**
  Measured with a generated 24.65 MB / 300-page PDF (text pages padded with incompressible image streams) through
  `extractPages` alone, run under `wrangler dev --local` (workerd 1.20261103.1, offline) in a scratch Worker and sampled
  via workerd `VmRSS`:

  | run | wall | workerd RSS above its 127 MB idle baseline |
  |---|---|---|
  | all 300 pages, unpdf `extractText` (all pages in parallel) | 2.2 s | +185 MB |
  | all 300 pages, sequential per page + cleanup (now `extractPdf`) | 2.0 s | +169 MB |
  | first 150 pages, sequential | 1.3 s | +119 MB |
  | first 100 pages, sequential | 0.9 s | +131 MB |

  Node (tsx): 300 pages = 3.5 s wall / 4.6 s CPU, heap 98 MB + external 65 MB after extraction; text 1.9 MB.
  **Caveats, stated plainly:** (1) this was the extraction step only, not the full upload route (the Worker's DB is Neon over
  WebSocket, which cannot reach the local Postgres, so upload + analyse end to end was not run under workerd); the real
  upload additionally holds the multipart `File`, its `arrayBuffer`, and the blob-put body. (2) Local workerd does not enforce
  the 128 MB isolate limit or the CPU limit, so nothing "failed"; RSS includes the runtime itself, so the numbers are an
  upper-bound indicator, not an isolate-heap reading. (3) The runs are noisy (+-15 MB). The file bytes dominate
  (~4 copies of 25 MB), so a page cap trims ~30-50 MB, not more; the larger remaining risk is multiple copies of the upload.
  Because the full 300-page case measured above the 128 MB budget, the conservative response (per the task) is applied:
  `MAX_EXTRACT_PAGES = 150` (typical GeM bid + ATC are 20-100 pages) in `packages/core/src/contracts/analyse.ts`; extraction
  runs sequentially page by page (`extractPdf` in `pdf-text.ts`); an upload over the cap stores the first 150 pages, answers
  with a `pages_truncated` warning (shown as a toast) and records `totalPages` on the `tender.document_uploaded` activity.
  GeM-fetched documents are capped the same way (logged). CI-safe coverage lives in `apps/api/test/analyse-large.test.ts`
  (160-page PDF). Follow-up if production still reports memory-limit errors: avoid the extra `new Uint8Array(data)` copy by
  storing to R2 first and handing pdf.js ownership of the buffer, and stream the multipart body.
- **Label-to-next-label parsing** over line-prefix parsing (Mujahid-Alam) or single-regex-per-field (erenmyeager15): robust to bilingual labels that wrap and interleave. Kept; extend the label table instead.
- **OCR**: Claude PDF document input (vision) instead of bundling Tesseract (WASM too heavy for Workers, poor on Hindi+English mixed scans). Only when configured; otherwise a clear notice.
- **Model tiers**: Sonnet 5.5 for routine enrichment (cost/latency), Opus 5.5 for OCR transcription (vision accuracy on scans), Fable 5.1 only for escalations on blocking criteria (rare, expensive, opt-in).
- **Staleness granularity**: flag + reason per analysis instead of recomputing all analyses on every profile edit (cheap, explicit; `rescore` makes the refresh one click).

## Complexity Tracking

> No constitution violations. (Intentionally empty.)
