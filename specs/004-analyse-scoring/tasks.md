---

description: "Task list for 004 Analyse — bid documents, eligibility extraction & Go/No-Go scoring"
---

# Tasks: Analyse — Bid Documents, Eligibility Extraction & Go/No-Go Scoring

**Input**: Design documents from `/specs/004-analyse-scoring/` (`spec.md`, `plan.md`); contracts in `specs/001-gem-tender-copilot/contracts/api.md § Analyse` (extended in `plan.md § API Endpoints`)

**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: REQUIRED (Constitution VI): unit tests next to core logic in `packages/core/test/analyse/`, API integration tests against real Postgres in `apps/api/test/`, and one Playwright E2E per user story with evidence (screenshots, video, trace) in `qa/evidence/004/US<n>/`.

**Organization**: Tasks are grouped by user story. `[x]` = verified as implemented in the code on 2026-11-05 (file paths given);
`[ ]` = remaining work (gaps, hardening, missing tests, QA). Every open task is sized ≤ 1 day.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 … US7)
- Each task names exact file paths and the requirement ids it implements

## Path Conventions

- Core (pure): `packages/core/src/analyse/`, tests `packages/core/test/analyse/`, fixtures `packages/core/test/fixtures/bids/`
- API: `apps/api/src/`, tests `apps/api/test/`
- Web: `apps/web/src/features/tender/`, `apps/web/src/features/settings/sections/`
- Schema: `packages/db/src/schema.ts`, migrations `packages/db/migrations/`
- E2E: `e2e/004-analyse/`, evidence `qa/evidence/004/US<n>/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [x] T001 Analyse module barrel and domain types mirrored from the schema in `packages/core/src/analyse/index.ts`, `packages/core/src/analyse/types.ts` FR-015 FR-021
- [x] T002 Tables `tender_documents` and `analyses` (+ `organizations.scoring_weights`) with jsonb `Requirement`, `ScoreFactor`, `ChecklistItem` types in `packages/db/src/schema.ts`, `packages/db/migrations/0000_last_shocker.sql` FR-001 FR-025 FR-034
- [x] T003 GeM-style sample bid PDF generator and four fixtures (`go-it-services`, `review-hardware-oem`, `nogo-experience`, `emd-exempt-mse`) in `packages/core/src/analyse/sample-bid.ts`, `packages/core/test/fixtures/bids/generate.ts`, `packages/core/test/fixtures/bids/*.pdf` FR-011 SC-001
- [x] T004 [P] Create root `NOTICE` listing third-party code reused (arush15june/gem-search MIT and erenmyeager15 Apache-2.0 for `gem/client.ts`; erenmyeager15 label regexes, byte-cap download, state list and `synthetic-tender.pdf` fixture for this spec; Mujahid-Alam noted as "ideas only — no licence, no code copied") with licence texts or links in `NOTICE` NFR-009 (#175)
- [x] T005 [P] E2E scaffolding for this spec: helpers `uploadFixture(page, tenderId, fixture, kind)`, `openTargetTender(page)` (first open mock-gem tender closing ≥ 3 days out), `setProfile(request, partial)` and `analyse(request, tenderId)` in `e2e/004-analyse/support.ts` (re-using `e2e/support/fixtures.ts` `evidence()`/`collectRunArtifacts()`) NFR-010 SC-007 (#177)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T006 Analyse contracts: `overrideFactorInputSchema`, `scoringWeightsSchema`, `tenderDocKindSchema`, `MAX_TENDER_DOC_BYTES`, `TenderDocumentDto`, `AnalysisDto` in `packages/core/src/contracts/analyse.ts` FR-001 FR-032 FR-034
- [x] T007 Anthropic Messages adapter over `fetch` (timeout 90 s, `completeJson` with loose JSON parsing) and `deps.llm = null` without `ANTHROPIC_API_KEY`; `LLM_MODEL` default `claude-sonnet-5-5` in `apps/api/src/adapters/llm.ts`, `apps/api/src/adapters/index.ts`, `apps/api/src/env.ts`, `apps/api/src/deps.ts` FR-047
- [x] T008 Analyse routes mounted at `/api` with role guards (viewer / analyst / bid_manager) in `apps/api/src/routes/analysis.ts`, `apps/api/src/app.ts` FR-001 FR-002 FR-005 FR-006 FR-025 FR-026 FR-032 FR-034
- [x] T009 Migration: add `tender_documents.text_source text not null default 'pdf'`, `analyses.stale_reason text`, `analyses.stale_at timestamptz`, `analyses.notes jsonb not null default '[]'`; add optional `ocr?: boolean` to `Requirement.source` in both type mirrors; expose `staleReason`, `staleAt`, `notes`, `textSource` in DTOs/mappers in `packages/db/src/schema.ts`, `packages/db/migrations/0001_*.sql`, `packages/core/src/analyse/types.ts`, `packages/core/src/contracts/analyse.ts`, `apps/api/src/services/analyse.ts` FR-043 FR-051 FR-052 (#178)
- [x] T010 Staleness service `markStale(db, {orgId?, tenderIds?, openOnly?}, reason, now)` setting `stale=true, stale_reason, stale_at` (only on `done` analyses) with unit-level API test in `apps/api/src/services/staleness.ts`, `apps/api/test/staleness.test.ts` FR-043 FR-044 (#180)

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Get the bid documents into TenderPilot (Priority: P1) 🎯 MVP

**Goal**: Fetch the public GeM bid document or upload PDFs (bid/ATC/corrigendum/BOQ/other), extract text per page, list/view/download with tenant isolation.

**Independent Test**: Upload `go-it-services.pdf` as analyst → listed with 4 pages, viewable; viewer can download; other org gets 404; Fetch from GeM adds the shared copy once.

### Built

- [x] T011 [P] [US1] `isPdf` (magic in first 1 KiB), `extractPages` via `unpdf` with buffer copy, `joinPages`/`splitPages` (`\f`), `looksScanned` (< 40 chars/page) in `packages/core/src/analyse/pdf-text.ts` FR-003
- [x] T012 [US1] `uploadTenderDocument` (empty 400, > 25 MB 413, non-PDF 415, unreadable 422, private blob key, safe file name, activity with `scanned`) in `apps/api/src/services/analyse.ts` FR-002 FR-003 FR-004
- [x] T013 [US1] `fetchGemDocuments` (once per tender, `org_id` null, polite `GemClient`, 422 `no_gem_document`, 502 `gem_unavailable` with 404-specific copy, sets `tenders.document_url`) in `apps/api/src/services/analyse.ts`, `packages/core/src/gem/client.ts` FR-005
- [x] T014 [US1] List / upload / fetch / download routes (inline flag, RFC 5987 file name, `private, no-store`, `nosniff`, org-scoped visibility) in `apps/api/src/routes/analysis.ts` FR-001 FR-006 FR-007
- [x] T015 [US1] Documents tab: list rows (kind badge, From GeM/Uploaded, pages, size, relative time, "No text — scanned?"), View/Download, Fetch from GeM (analyst+), type select + dropzone, viewer fallback card, toasts in `apps/web/src/features/tender/DocumentsTab.tsx`, `apps/web/src/features/tender/api.ts` FR-001 FR-002 FR-005
- [x] T016 [US1] API tests: upload + text, non-PDF/missing/viewer rejections, download, cross-org isolation, GeM fetch once + reuse, auto-fetch, GeM failure 502 in `apps/api/test/analyse.test.ts` FR-002 FR-005 FR-006 FR-007

### Remaining

- [x] T017 [P] [US1] Port erenmyeager15 `src/pdf.test.ts` (pooled-Buffer slice not corrupted across two extractions; invalid `%PDF-1.7` bytes rejected with `PdfTextError`) and its `synthetic-tender.pdf` fixture; add BOM-prefixed PDF case in `packages/core/test/analyse/pdf-text.test.ts`, `packages/core/test/fixtures/bids/synthetic-tender.pdf` FR-003 NFR-009 (#182)
- [x] T018 [P] [US1] Byte-capped GeM download: stream the body and abort above 25 MB with `GemError('too_large')`, mapped to 502 `gem_unavailable` "The GeM document is larger than 25 MB — download it from GeM and upload it here."; unit test with a fake fetch in `packages/core/src/gem/client.ts`, `packages/core/test/gem/client.test.ts`, `apps/api/src/services/analyse.ts` FR-008 (#183)
- [x] T019 [P] [US1] `detectBidNumber(pages)` (first `GEM/\d{4}/[A-Z]/\d+` on page 1 header/footer) with unit tests in `packages/core/src/analyse/rules.ts`, `packages/core/test/analyse/rules.test.ts` FR-010 (#185)
- [x] T020 [US1] Upload response `warnings:[{code:'bid_number_mismatch', found}]` and DTO `bidNumberFound` (computed from stored text at list time, no schema change) + API test in `apps/api/src/services/analyse.ts`, `apps/api/src/routes/analysis.ts`, `packages/core/src/contracts/analyse.ts`, `apps/api/test/analyse.test.ts` FR-010 (#187)
- [x] T021 [US1] Web: warning toast "This PDF looks like <found>, not <bid number>" and "Different bid?" row badge with tooltip in `apps/web/src/features/tender/DocumentsTab.tsx` FR-010 (#189)
- [x] T022 [US1] `DELETE /tenders/:id/documents/:docId` (analyst+, own uploads only, 403 for GeM docs, blob delete, activity `tender.document_removed`, `markStale(..., 'document_removed')`) + API tests in `apps/api/src/routes/analysis.ts`, `apps/api/src/services/analyse.ts`, `apps/api/test/analyse.test.ts` FR-009 FR-044 (#190)
- [x] T023 [US1] Web: row "Remove" action (own uploads, analyst+) with confirm dialog "Remove <file>? The next analysis will no longer use it." in `apps/web/src/features/tender/DocumentsTab.tsx`, `apps/web/src/features/tender/api.ts` FR-009 (#192)
- [x] T024 [P] [US1] mock-gem admin switch `POST /__admin/document-mode {mode:'normal'|'404'|'html'|'scanned'|'oversize'}` so E2E can exercise 404/HTML/scanned/oversize GeM documents in `tools/mock-gem/src/app.ts`, `tools/mock-gem/src/pdf.ts` FR-005 FR-008 (#194)
- [ ] T025 [US1] QA: Playwright E2E for US1 with evidence (screenshots, video, trace) in qa/evidence/004/US1/ — empty state, upload `go-it-services.pdf` (201, "4 pages read"), 415/413/422 errors, Fetch from GeM 201 then 200 "already here", `down` mode 502 toast, viewer read-only card, cross-org 404 via API, inline view headers, scanned badge, mismatch badge, remove; desktop + `@mobile` in `e2e/004-analyse/US1-documents.e2e.ts`, `qa/evidence/004/US1/VERDICT.md` FR-001..FR-010 (#196)

**Checkpoint**: Documents can be brought in and inspected independently.

---

## Phase 4: User Story 2 - Deterministic eligibility extraction with page-level evidence (Priority: P1)

**Goal**: Rules extract every standard GeM requirement with document/page/quote provenance, combine documents (corrigendum wins), fall back to listing, and show it in the Requirements tab.

**Independent Test**: Analyse `go-it-services.pdf` without an LLM key → 32 requirements (30 + `bid_published_at`, `consignee_state` from FR-019) with the values/pages in spec US2 #1, page chips open the right page.

### Built

- [x] T026 [P] [US2] `flattenText` (Devanagari/zero-width removal, dash/quote/nbsp normalisation), `parseIndianAmount`, `parseGemDateTime` (IST), days/months/%/int/yes-no/text parsers in `packages/core/src/analyse/rules.ts` FR-011 FR-012
- [x] T027 [US2] Label table (26 labels + boundary labels), label-to-next-label value reading, document-list split into `document` items in `packages/core/src/analyse/rules.ts` FR-011 FR-013 FR-015
- [x] T028 [US2] ATC scans: similar work (% → rupees via estimated value; absolute), experience in prose (number words), certificates (ISO list, BIS, CMMI, NABL, STQC, PSARA), OEM authorisation with guard, non-blacklisting in `packages/core/src/analyse/rules.ts` FR-014
- [x] T029 [US2] `requirementsFromListing` (0.7, "GeM BidPlus listing data"), `requirementId`, `combineRequirements` (later doc wins for single keys, union for multi keys) and kind ordering bid→atc→boq→other→corrigendum in `packages/core/src/analyse/rules.ts`, `apps/api/src/services/analyse.ts` FR-016 FR-017
- [x] T030 [US2] Requirements tab: count line, filter, groups, page chip deep link `#page=N`, method badge, confidence bar, mandatory dot, empty states in `apps/web/src/features/tender/RequirementsTab.tsx`, `apps/web/src/features/tender/AnalysisPanel.tsx` (`PageChip`), `apps/web/src/features/tender/labels.ts` FR-020
- [x] T031 [US2] Unit tests: amounts, dates, bilingual/wrapped labels, document list split, per-fixture extraction, provenance on every item, ATC prose, corrigendum supersedes in `packages/core/test/analyse/rules.test.ts` FR-011..FR-017

### Remaining

- [x] T032 [P] [US2] Port erenmyeager15 "MSE Relaxation…/Startup Relaxation for Years Of Experience (and Turnover)" labels and "Yes | Complete"/"No | Complete" value parsing; tests on text snippets in `packages/core/src/analyse/rules.ts`, `packages/core/test/analyse/rules.test.ts` FR-018 (#198)
- [x] T033 [P] [US2] Labels `contract_period` ("Contract Period N Year(s)/Month(s)/Day(s)" → months) and `bid_published_at` ("Dated: dd-mm-yyyy"), experience label variant "…for same/similar service"; tests in `packages/core/src/analyse/rules.ts`, `packages/core/test/analyse/rules.test.ts` FR-019 (#200)
- [x] T034 [US2] `consignee_state` from the consignee/reporting-officer block using an Indian state list (ported from erenmyeager15 `INDIAN_STATES`/`inferIndianState`, scoped to the consignee section); delivery factor uses it when `tender.state` is null; tests in `packages/core/src/analyse/rules.ts`, `packages/core/src/analyse/score.ts`, `packages/core/test/analyse/rules.test.ts`, `packages/core/test/analyse/score.test.ts` FR-019 FR-022 (#202)
- [x] T035 [US2] Real-layout extraction corpus: add ≥ 3 anonymised bilingual GeM bid PDFs (goods, service with contract period, RA) with expected-value JSON and a corpus test asserting ≥ 95 % field accuracy (value + page) and Mujahid-Alam's page-1 field list as a coverage checklist in `packages/core/test/fixtures/bids/real-*.pdf`, `packages/core/test/fixtures/bids/real-*.expected.json`, `packages/core/test/analyse/corpus.test.ts` SC-001 (#204)
- [x] T036 [US2] Analysis summary prefix "Check documents: <file> is for <bid no>." and Requirements-tab warning callout when any analysed document's detected bid number mismatches; API test in `apps/api/src/services/analyse.ts`, `apps/web/src/features/tender/RequirementsTab.tsx`, `apps/api/test/analyse.test.ts` FR-010 (#206)
- [x] T037 [P] [US2] Group/label/format entries for new keys (`contract_period`, `bid_published_at`, `consignee_state`) in `apps/web/src/features/tender/labels.ts` FR-020 (#208)
- [ ] T038 [US2] QA: Playwright E2E for US2 with evidence (screenshots, video, trace) in qa/evidence/004/US2/ — rules-only analysis of `go-it-services.pdf` (assert 32 requirements and key values/pages via API + UI), header counts, groups, page chip opens `#page=4`, filter + "Nothing matches", corrigendum upload supersedes end date, listing fallback row, 422 `no_documents` toast with Upload PDF action, auto-fetch from GeM; desktop + `@mobile` card layout in `e2e/004-analyse/US2-extraction.e2e.ts`, `qa/evidence/004/US2/VERDICT.md` FR-011..FR-020 (#210)

**Checkpoint**: Extraction is verifiable on its own (Requirements tab).

---

## Phase 5: User Story 3 - Explainable Go/No-Go score with exemptions and blockers (Priority: P1)

**Goal**: Ten weighted factors, exemptions, blockers, verdict, confidence, summary; Analysis tab with evidence.

**Independent Test**: Demo company + `go-it-services.pdf` → "Go · 100/100" with the exact factor sentences; weak profile + `nogo-experience.pdf` → No-Go 58 blocked by experience.

### Built

- [x] T039 [P] [US3] Factor engine (turnover, experience, similar work, EMD, MII, OEM, certificates, documents, delivery, time to close), `averageTurnover`, `experienceYears`, `resolveWeights`, validity rule (expiry 23:59:59 IST) in `packages/core/src/analyse/score.ts` FR-021 FR-022
- [x] T040 [P] [US3] `computeScore` (weights × values, `na` excluded, blockers → No-Go, thresholds 70/40, confidence, summary) and `effectiveStatus` in `packages/core/src/analyse/score.ts` FR-023
- [x] T041 [US3] MSE/Startup exemptions (bid allows + profile qualifies + valid Udyam/DPIIT), GFR 170 EMD exemption, renewal/upload hints in `packages/core/src/analyse/score.ts`, `packages/core/src/analyse/checklist.ts` (`isMseProfile`, `isStartupProfile`) FR-024
- [x] T042 [US3] `analyseTender` orchestration (auto-fetch, 422, running→done/failed, overrides carried, activity `tender.analysed`, 500 `analysis_failed`) and `latestAnalysis` in `apps/api/src/services/analyse.ts` FR-025 FR-026
- [x] T043 [US3] Analysis tab: score card (ring with aria label, verdict, Rules only/AI-assisted, overridden/outdated badges, summary, blocker callout, confidence, counts, Re-analyse), factor rows (sorting, help tooltip, badges, evidence toggle, weight bar, Override), Not-applicable collapsible, failed state in `apps/web/src/features/tender/AnalysisPanel.tsx`, `apps/web/src/components/ui/verdict.tsx` FR-027
- [x] T044 [US3] Tender page: breadcrumb, tabs with `?tab=`, analyse mutation with ≥ 2.4 s "Analysing…" steps, success/no_documents toasts, empty "Should you bid on this tender?" state, skeletons, 404/error states in `apps/web/src/features/tender/TenderPage.tsx`, `apps/web/src/features/tender/AnalysingState.tsx`, `apps/web/src/features/tender/api.ts` FR-027 FR-031 FR-055
- [x] T045 [US3] Hero with Analyse/Re-analyse (disabled when closed and never analysed), compact score ring, Start bid, Open on GeM, Dismiss in `apps/web/src/features/tender/TenderHero.tsx` FR-031 FR-055
- [x] T046 [US3] Tests: factor branches and verdict maths in `packages/core/test/analyse/score.test.ts`; API Go/No-Go/MSE-exempt/no-documents scenarios in `apps/api/test/analyse.test.ts` FR-021..FR-026

### Remaining

- [x] T047 [US3] Reject concurrent analyses: 409 `analysis_running` when a `running` row < 2 min exists for org+tender; older `running` rows marked `failed` ("timed out"); API test in `apps/api/src/services/analyse.ts`, `apps/api/test/analyse.test.ts` FR-028 (#213)
- [x] T048 [US3] `latestDoneAnalysis` + `lastAttempt` on `GET …/analysis`; carry overrides from the latest done analysis (fixes overrides lost after a failed attempt); API tests (failed re-analysis keeps previous result and overrides) in `apps/api/src/services/analyse.ts`, `apps/api/src/routes/analysis.ts`, `packages/core/src/contracts/analyse.ts`, `apps/api/test/analyse.test.ts` FR-029 (#215)
- [x] T049 [US3] Web: warning "The last re-analysis failed: <reason>. Showing the previous result from <time>." with Try again; "Analysis in progress…" state polling every 3 s when `lastAttempt.status === 'running'`; disable Analyse buttons on 409 in `apps/web/src/features/tender/TenderPage.tsx`, `apps/web/src/features/tender/AnalysisPanel.tsx`, `apps/web/src/features/tender/api.ts` FR-028 FR-029 (#217)
- [x] T050 [P] [US3] OEM product match: significant-word overlap between valid authorisations (oem, products, vault tags/title) and tender title/category/items; `unknown` with "None of your valid OEM authorisations (…) mention <category> — confirm one covers this product."; pass `tender.title/category/items` into `ScoreTender`; tests in `packages/core/src/analyse/score.ts`, `packages/core/test/analyse/score.test.ts`, `apps/api/src/services/analyse.ts` FR-030 (#218)
- [x] T051 [P] [US3] Stage timing logs (`extract_ms`, `llm_ms`, `score_ms`, `total_ms`, pages, docs) on `tender.analysed` meta and logger; perf smoke asserting rules-only < 5 s on the 4 fixtures in `apps/api/src/services/analyse.ts`, `apps/api/test/analyse-perf.test.ts` NFR-001 SC-002 (#220)
- [x] T052 [US3] Workers budget check: run upload + analyse of a 25 MB / 300-page generated PDF under `wrangler dev` (or Miniflare) and record memory/CPU; if over limits, cap pages extracted at upload with a warning and document the decision in `apps/api/test/analyse-large.test.ts`, `specs/004-analyse-scoring/plan.md` NFR-005 (#222)
- [x] T053 [US3] Accessibility: axe scans of Analysis, Requirements, Documents, History tabs and Override dialog in light/dark at 375/1440 px; fix serious/critical findings in `e2e/004-analyse/a11y.e2e.ts`, `apps/web/src/features/tender/*` FR-056 NFR-006 (#225)
- [x] T054 [US3] QA: Playwright E2E for US3 with evidence (screenshots, video, trace) in qa/evidence/004/US3/ — demo company + `go-it-services.pdf` Go 100 with exact factor sentences and evidence toggle; weak profile + `nogo-experience.pdf` No-Go 58 blocker callout; `review-hardware-oem.pdf` Go 82; no-profile Review 46; viewer read-only; cross-org 404; 409 on double click; failed re-analysis keeps previous; desktop + `@mobile` in `e2e/004-analyse/US3-scoring.e2e.ts`, `qa/evidence/004/US3/VERDICT.md` FR-021..FR-031 (#227)

**Checkpoint**: MVP (US1–US3) delivers a defensible Go/No-Go with evidence.

---

## Phase 6: User Story 4 - Override a factor with a reason and tune scoring weights (Priority: P2)

**Goal**: Audited overrides that survive re-analysis; org-level weights.

**Independent Test**: Override experience on the No-Go analysis → Go 82, audit entry in History; save EMD weight 30 → next analysis uses it.

### Built

- [x] T055 [US4] `overrideFactor` (bid_manager+, org scope 404, done-only 409, set/remove override, `computeScore`, activity with from/to/reason/score/verdict) and route in `apps/api/src/services/analyse.ts`, `apps/api/src/routes/analysis.ts` FR-032 FR-033
- [x] T056 [US4] Override dialog (computed status, segmented New status, reason with 3-char validation, "Same as computed" note, success toast with new score) and Overridden badge/note on factor rows in `apps/web/src/features/tender/AnalysisPanel.tsx`, `apps/web/src/features/tender/api.ts` FR-032
- [x] T057 [US4] Weights API (`GET` viewer+, `PUT` bid_manager+, strict partial 0..100, `{}` reset, activity) in `apps/api/src/services/analyse.ts` (`weightsResponse`, `saveWeights`), `apps/api/src/routes/analysis.ts` FR-034
- [x] T058 [US4] Settings → Scoring weights section (total, share %, help, Default/Custom badge, Reset/Save, read-only footer) in `apps/web/src/features/settings/sections/ScoringSection.tsx` FR-035
- [x] T059 [US4] Tests: override role/reason validation, re-score + audit + survives re-analysis; weights defaults/validation/persistence in `apps/api/test/analyse.test.ts` FR-032..FR-034
- [x] T060 [US4] History tab renders `analysis.factor_overridden` entries ("<factor>: from → to — “reason”") in `apps/web/src/features/tender/HistoryTab.tsx` FR-032

### Remaining

- [x] T061 [P] [US4] Slider range 0–100 (step 1) to match the API; keep share % display; unit/RTL check in `apps/web/src/features/settings/sections/ScoringSection.tsx` FR-036 (#229)
- [x] T062 [US4] `POST /analyses/:id/rescore` (analyst+): recompute factors/checklist from stored requirements with current profile, vault, weights; keep overrides; clear stale; activity `analysis.rescored`; API tests in `apps/api/src/services/analyse.ts`, `apps/api/src/routes/analysis.ts`, `apps/api/test/analyse.test.ts` FR-037 (#230)
- [x] T063 [US4] Web: **Re-score** button in the stale banner when the reason is profile/vault/weights (no document re-read), toast "Re-scored · S/100" in `apps/web/src/features/tender/TenderPage.tsx`, `apps/web/src/features/tender/api.ts` FR-037 FR-043 (#231)
- [x] T064 [US4] QA: Playwright E2E for US4 with evidence (screenshots, video, trace) in qa/evidence/004/US4/ — override dialog validation, experience → Pass flips No-Go 58 to Go 82 with toast and badges, History audit line, removing override, analyst sees no Override (API 403), weights page defaults, save EMD 30 → next analysis "Weight 30", reset to `{}`, total 0 disables Save, viewer read-only; desktop + `@mobile` in `e2e/004-analyse/US4-override-weights.e2e.ts`, `qa/evidence/004/US4/VERDICT.md` FR-032..FR-037 (#232)

---

## Phase 7: User Story 5 - Required-documents checklist from the bid (Priority: P2)

**Goal**: Stable-id checklist of uploads and generated annexures per analysis.

**Independent Test**: Demo company + `go-it-services.pdf` → 13 mandatory items, 4 generated, in the documented order.

### Built

- [x] T065 [P] [US5] `buildChecklist` with stable ids (identity, turnover, experience, listed documents mapping, past performance, similar work, certificates, OEM, EMD branches, MSE/Startup, MII, undertakings, LLM "other" documents) and `ANNEXURE_KEYS` in `packages/core/src/analyse/checklist.ts` FR-038
- [x] T066 [US5] Checklist card (count, generated count, workspace hint, rows with reason and Generated/vault-type/"Action on GeM" badges, Optional & informational collapsible, sticky xl, empty state) in `apps/web/src/features/tender/ChecklistCard.tsx` FR-039
- [x] T067 [US5] Unit tests for checklist mapping and id stability in `packages/core/test/analyse/checklist.test.ts` FR-038

### Remaining

- [x] T068 [P] [US5] `checklistReadiness(items, vaultDocs, now)` → per item `ready | expiring(days) | expired | missing | n/a` sharing the scoring validity rule (export `isValidDoc` from score.ts); unit tests in `packages/core/src/analyse/checklist.ts`, `packages/core/src/analyse/score.ts`, `packages/core/test/analyse/checklist.test.ts` FR-040 (#235)
- [x] T069 [US5] Web: readiness chips "In vault" / "Expires in N days" / "Expired" / "Missing" on checklist rows using the vault list query, with text + icon (not colour only) in `apps/web/src/features/tender/ChecklistCard.tsx`, `apps/web/src/features/tender/AnalysisPanel.tsx` FR-040 NFR-006 (#236)
- [x] T070 [US5] QA: Playwright E2E for US5 with evidence (screenshots, video, trace) in qa/evidence/004/US5/ — 13 items/4 generated order for demo + `go-it-services.pdf`, reasons with page refs, non-MSE EMD optional item, "Certificates requested in the ATC", workspace hint switch after Start bid, ids stable after ATC re-analysis (API), readiness chips (ISO 9001 "Expires in 10 days"); desktop + `@mobile` in `e2e/004-analyse/US5-checklist.e2e.ts`, `qa/evidence/004/US5/VERDICT.md` FR-038..FR-040 (#238)

---

## Phase 8: User Story 6 - Know when an analysis is outdated and re-analyse (Priority: P2)

**Goal**: Corrigenda and company/document/weight changes mark analyses stale with a reason; UI prompts re-analysis.

**Independent Test**: Analyse a mock-gem tender, `POST /__admin/corrigendum/<bid> {days:7}`, Sync now → banner/badges; Re-analyse clears.

### Built

- [x] T071 [US6] Ingestion marks all analyses of a tender stale when a corrigendum (CORRIGENDUM_FIELDS) is detected in `apps/api/src/services/ingest.ts`, `packages/core/src/gem/parse.ts` FR-041
- [x] T072 [US6] Stale UI: "Re-analysis needed" banner (role status, Re-analyse now for analyst+), "Outdated" badge, feed "Re-check" badge, workspace header/Qualify badges; History corrigendum entry with "Re-check eligibility" in `apps/web/src/features/tender/TenderPage.tsx`, `apps/web/src/features/tender/AnalysisPanel.tsx`, `apps/web/src/features/feed/TenderCard.tsx`, `apps/web/src/features/workspace/WorkspaceHeader.tsx`, `apps/web/src/features/workspace/QualifyStep.tsx`, `apps/web/src/features/tender/HistoryTab.tsx` FR-042
- [x] T073 [US6] API test: corrigendum updates end date, records history and marks analyses stale in `apps/api/test/ingest.test.ts` FR-041

### Remaining

- [x] T074 [US6] Ingest uses `markStale(…, 'corrigendum')` (sets `stale_reason`, `stale_at`); analysis completion keeps `stale` when `stale_at` >= its `created_at`; API tests in `apps/api/src/services/ingest.ts`, `apps/api/src/services/analyse.ts`, `apps/api/test/ingest.test.ts`, `apps/api/test/staleness.test.ts` FR-043 FR-045 (#240)
- [x] T075 [P] [US6] Profile & past-contract mutations (`PUT /profile`, `POST/PATCH/DELETE /past-contracts`) call `markStale({orgId, openOnly}, 'profile_changed')`; API test in `apps/api/src/routes/profile.ts`, `apps/api/test/staleness.test.ts` FR-044 (#242)
- [x] T076 [P] [US6] Vault mutations (`POST /vault`, `PATCH /vault/:id`, `PUT /vault/:id/file`, `DELETE /vault/:id`) call `markStale({orgId, openOnly}, 'vault_changed')`; API test in `apps/api/src/routes/vault.ts`, `apps/api/test/staleness.test.ts` FR-044 (#244)
- [x] T077 [P] [US6] Document upload → `markStale({orgId, tenderIds:[id]}, 'document_added')`; weights save → `markStale({orgId, openOnly}, 'weights_changed')`; API tests in `apps/api/src/services/analyse.ts`, `apps/api/test/staleness.test.ts` FR-044 (#246) — _Note: the document-upload `markStale(..., 'document_added')` part was delivered in US1 (#167 / PR #478); the weights part remains._
- [x] T078 [US6] Corrigendum GeM re-fetch: when a `corrigendum` event changed `documentUrl` after the GeM copy's `created_at`, `fetchGemDocuments` (and analyse auto-fetch) downloads the new document as kind `corrigendum` and keeps the old; `?refresh=1` forces it (analyst+); API test with mock-gem in `apps/api/src/services/analyse.ts`, `apps/api/src/routes/analysis.ts`, `apps/api/test/analyse.test.ts` FR-046 NFR-004 (#247)
- [x] T079 [US6] Web: reason-specific banner copy ("A corrigendum changed this bid…", "Your company profile changed…", "Your document vault changed…", "A document was added/removed…", "Scoring weights changed…") with "since <relative time>" in `apps/web/src/features/tender/TenderPage.tsx`, `apps/web/src/features/tender/labels.ts` FR-043 (#249)
- [ ] T080 [US6] QA: Playwright E2E for US6 with evidence (screenshots, video, trace) in qa/evidence/004/US6/ — analyse mock-gem tender, `/__admin/corrigendum` + Sync now, banner + Outdated + feed Re-check + History corrigendum, viewer banner without button, Re-analyse clears, second org also stale, profile edit → profile_changed banner, vault upload → vault_changed, Re-score; desktop + `@mobile` in `e2e/004-analyse/US6-stale.e2e.ts`, `qa/evidence/004/US6/VERDICT.md` FR-041..FR-046 (#250)

---

## Phase 9: User Story 7 - AI enrichment and OCR for scanned documents with Claude (Priority: P3)

**Goal**: Optional Claude enrichment (capped, merged, never decides), structured output, model tiers, chunking, OCR for scans, privacy guarantees.

**Independent Test**: Fake LLM client adds an ATC item ("AI" badge, "AI-assisted"); throwing client → identical rules-only result.

### Built

- [x] T081 [P] [US7] `buildLlmPrompt` (pages "=== Page N ===", 60k-char budget, known RULE items), `parseLlmRequirements` (zod, unknown key → other, confidence cap 0.9), `mergeRequirements` (strictly-higher confidence, never over MANUAL, fuzzy multi dedupe), `enrichWithLlm` (fallback on error) in `packages/core/src/analyse/llm.ts` FR-047 FR-048
- [x] T082 [US7] Per-document enrichment in `analyseTender` with `method: 'rules+llm'` and warning log on failure in `apps/api/src/services/analyse.ts` FR-047
- [x] T083 [US7] UI: "AI-assisted" badge + tooltip, "AI" method badge, "by AI" count, toast "Rules + AI analysis complete", empty-state "Works without AI keys" line in `apps/web/src/features/tender/AnalysisPanel.tsx`, `apps/web/src/features/tender/RequirementsTab.tsx`, `apps/web/src/features/tender/TenderPage.tsx` FR-047
- [x] T084 [US7] Tests: prompt/parse/merge/fallback in `packages/core/test/analyse/llm.test.ts`; fake-client API test (ATC items with method LLM, `rules+llm`, failure falls back) in `apps/api/test/analyse.test.ts` FR-047 FR-048

### Remaining

- [ ] T085 [US7] Adapter: structured output (`output_config.format` JSON schema mirroring `llmItemSchema`) for `completeJson`; treat `stop_reason` `refusal`/`max_tokens` as `LlmError`; return and log `model`, `stop_reason`, `usage`; no sampling params; unit tests with a fake fetch in `apps/api/src/adapters/llm.ts`, `apps/api/test/llm-adapter.test.ts` FR-049 NFR-007 (#254)
- [ ] T086 [P] [US7] Model tiers from env: `LLM_OCR_MODEL` (default `claude-opus-5-5`), `LLM_ESCALATION_MODEL` (unset); `deps.llmFor(purpose)`; document in `.dev.vars.example`/README in `apps/api/src/env.ts`, `apps/api/src/deps.ts`, `apps/api/src/adapters/index.ts` FR-050 (#256)
- [ ] T087 [US7] Chunked enrichment: page-aligned chunks ≤ 60k chars, max 4 per document, merged; remaining pages recorded in `analyses.notes`; ≤ 8 calls per analysis; tests in `packages/core/src/analyse/llm.ts`, `packages/core/test/analyse/llm.test.ts`, `apps/api/src/services/analyse.ts` FR-051 NFR-007 (#257)
- [ ] T088 [US7] Escalation: when a blocking key (`turnover_min`, `experience_years`, `oem_auth`, `emd`) has rule confidence < 0.75 or rule/LLM values conflict and an escalation model is set, ask it to adjudicate with quotes; result merged as an LLM item; tests with fake client in `packages/core/src/analyse/llm.ts`, `apps/api/src/services/analyse.ts`, `packages/core/test/analyse/llm.test.ts` FR-050 FR-048 (#260)
- [ ] T089 [P] [US7] `GET /analysis/capabilities` → `{ai, ocr, models}`; web hook `useAnalysisCapabilities`; pass `withAi` to `AnalysingState` in `apps/api/src/routes/analysis.ts`, `apps/web/src/features/tender/api.ts`, `apps/web/src/features/tender/TenderPage.tsx` FR-053 (#262)
- [ ] T090 [P] [US7] Core OCR helpers: `splitPdfForOcr(bytes, {maxPages:100, maxBytes:22MB})` with pdf-lib, `buildOcrRequest` (document block + transcription prompt + page JSON schema), `parseOcrPages`; unit tests in `packages/core/src/analyse/ocr.ts`, `packages/core/test/analyse/ocr.test.ts` FR-052 (#264)
- [ ] T091 [US7] OCR service + endpoint `POST /tenders/:id/documents/:docId/ocr` (409 has text, 503 `ocr_unavailable`, 502 `ocr_failed`), auto-OCR in analyse for `hasText:false` docs, `text_source='ocr'`, `source.ocr=true`, confidence cap 0.8, activity `tender.document_ocr`; API tests with fake client in `apps/api/src/services/analyse.ts`, `apps/api/src/routes/analysis.ts`, `apps/api/src/adapters/llm.ts`, `apps/api/test/ocr.test.ts` FR-052 (#266)
- [ ] T092 [US7] Web: "Read with AI (OCR)" row action, "Text via OCR" badge, OCR tooltip on requirements, notice "We couldn't read text from <file>. Upload a text PDF or ask your admin to enable AI OCR." in `apps/web/src/features/tender/DocumentsTab.tsx`, `apps/web/src/features/tender/RequirementsTab.tsx`, `apps/web/src/features/tender/AnalysisPanel.tsx` FR-052 (#268)
- [ ] T093 [P] [US7] Data-protection test: capture every fake-LLM request during analyse/OCR and assert no profile, financial, past-contract or vault values are present in `apps/api/test/llm-privacy.test.ts` FR-054 NFR-003 (#270)
- [ ] T094 [US7] QA: Playwright E2E for US7 with evidence (screenshots, video, trace) in qa/evidence/004/US7/ — API started with a fake/recorded LLM (`LLM_BASE_URL` → local stub) adds an ATC item (AI badge, "AI-assisted", "Rules + AI analysis complete"), stub error → rules-only identical score, scanned mock-gem document (`/__admin/document-mode scanned`) → OCR action and "Text via OCR", OCR unavailable notice without key; desktop + `@mobile` in `e2e/004-analyse/US7-ai-ocr.e2e.ts`, `e2e/004-analyse/llm-stub.ts`, `qa/evidence/004/US7/VERDICT.md` FR-047..FR-054 (#272)

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T035a [US2] Follow-up to T035: replace/augment the corpus with real anonymised GeM PDFs (SC-001) — synthesised corpus only so far

- [ ] T095 [P] Update `specs/001-gem-tender-copilot/contracts/api.md § Analyse` with the new endpoints (`DELETE …/documents/:docId`, `…/ocr`, `/analyses/:id/rescore`, `/analysis/capabilities`), new fields (`staleReason`, `staleAt`, `notes`, `lastAttempt`, `textSource`, `bidNumberFound`, `warnings`) and error codes (`analysis_running`, `ocr_unavailable`, `ocr_failed`) FR-009 FR-028 FR-037 FR-043 FR-052 FR-053 (#273)
- [ ] T096 [P] Experience basis hint: when contracts give fewer years than the incorporation date, append "(incorporated N years ago — add older contracts as proof)" to the experience detail; tests in `packages/core/src/analyse/score.ts`, `packages/core/test/analyse/score.test.ts` FR-022 (#275)
- [ ] T097 Run `/cairn-analyze` on `specs/004-analyse-scoring/` and resolve spec/plan/tasks inconsistencies (#277)
- [ ] T098 Run `/cairn-taskstoissues` to create GitHub issues for the 7 stories and every open task (labels `spec:004`, `area:analyse`, `type`, `priority`, `role`) on the project board per `CONVENTIONS.md` (#279)
- [ ] T099 `cairn-reviewer` review of each 004 PR (ai-sdlc review conventions; no Codex), findings recorded on the issue, no blocking findings open per `CONVENTIONS.md` (#281)
- [ ] T100 QA sign-off: aggregate `qa/evidence/004/US1..US7/VERDICT.md` into `qa/evidence/004/SUMMARY.md` with pass/fail per acceptance scenario and links to screenshots, videos and traces SC-007 (#283)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T004, T005 have no dependencies.
- **Foundational (Phase 2)**: T009 (migration) blocks T020, T036, T048, T074–T079, T087, T091; T010 (`markStale`) blocks T022, T074–T077, T062/T063.
- **User Stories (Phases 3–9)**: built parts exist; remaining tasks of each story can proceed in parallel after Phase 2.
- **Polish (Phase 10)**: after the stories' remaining tasks; T097 → T098 → T099; T100 last.

### User Story Dependencies

- **US1 (P1)**: none.
- **US2 (P1)**: uses US1 documents; T036 depends on T019/T020.
- **US3 (P1)**: uses US2 requirements; T050 independent; T049 depends on T047/T048.
- **US4 (P2)**: uses US3 analyses; T063 depends on T062 and T079.
- **US5 (P2)**: uses US3 checklist; T069 depends on T068.
- **US6 (P2)**: depends on T009/T010; T078 depends on T024 for E2E.
- **US7 (P3)**: T085 before T087/T088/T091; T090 before T091 → T092; T094 after T089–T092.

### Within Each User Story

- Core (pure) changes and their unit tests first, then service/route + API tests, then web, then the QA E2E task.

### Parallel Opportunities

- T004, T005 together; T017, T018, T019, T024 together; T032, T033, T037 together; T050, T051 together; T061 alone; T068 alone; T075, T076, T077 together after T010; T086, T089, T090, T093 together.

---

## Parallel Example: User Story 6

```bash
# After T009 + T010:
Task: "T075 Profile & past-contract mutations call markStale in apps/api/src/routes/profile.ts"
Task: "T076 Vault mutations call markStale in apps/api/src/routes/vault.ts"
Task: "T077 Document upload / weights save call markStale in apps/api/src/services/analyse.ts"
```

---

## Implementation Strategy

### MVP First (P1 stories)

1. Phase 1–2 open items (NOTICE, E2E helpers, migration, `markStale`).
2. US1 hardening (T017–T024) → QA T025.
3. US2 label ports + corpus (T032–T037) → QA T038.
4. US3 run lifecycle + OEM match + a11y (T047–T053) → QA T054.
5. **STOP and VALIDATE**: P1 E2E green with evidence.

### Incremental Delivery

1. US4 (rescore, sliders) → QA T064.
2. US5 (readiness) → QA T070.
3. US6 (staleness reasons) → QA T080.
4. US7 (structured output, tiers, chunking, OCR) → QA T094.
5. Polish T095–T100.

### Notes

- [P] tasks = different files, no dependencies.
- Never commit secrets; LLM keys only in `.dev.vars` / environment.
- Keep `packages/core` free of I/O; the LLM and OCR calls stay in `apps/api/src/adapters/llm.ts`.
- Commit after each task or logical group; each commit references the task id and FR ids.
