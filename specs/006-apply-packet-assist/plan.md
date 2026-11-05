# Implementation Plan: Apply — Bid Workspace, Annexures, Packet & Assisted Submission

**Branch**: `006-apply-packet-assist` | **Date**: 2026-11-05 | **Spec**: [`spec.md`](./spec.md)

**Input**: Feature specification from `/specs/006-apply-packet-assist/spec.md`

**Note**: This template is filled in by the `/cairn-plan` command; its definition describes the execution workflow.

## Summary

The Apply area turns an analysed tender into a bid that a human can upload and submit on GeM. It is **largely built**
(delivered as 001 tasks T060–T066): the pure domain logic lives in `@tp/core` (`packet/mapping.ts` auto-mapping and
readiness, `packet/templates.ts` 8 annexure templates + PDF renderer, `packet/build.ts` merged/bookmarked packet,
`assist/allowlist.ts` the non-financial allow-list and payload), the API is three thin Hono routers over
`services/packet.ts`, the web app has a 5-step workspace page, and an MV3 extension pre-fills allow-listed fields on the
user's click. This plan describes the built design precisely (so QA and reviewers can trace every requirement) and the
remaining work: stage-transition rules (FR-008), honest readiness when not analysed (FR-009), override/comment hardening
(FR-027, FR-032, FR-033), template placeholder validation and role gating (FR-041, FR-043), shared packet order, input
cap and stuck-build recovery (FR-055–FR-057), RFC 5987 filenames (FR-059), extension hardening and read-only tokens
(FR-073–FR-075, FR-077), submission/outcome extras incl. a GeM-result parser ported from a reference repo (FR-084,
FR-085), unsaved-change guards (FR-092), and Playwright E2E with evidence for all 7 stories.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 20+ / Cloudflare Workers runtime; Chrome MV3 for the extension

**Primary Dependencies**: Hono (API), Drizzle ORM, Zod (contracts in `packages/core/src/contracts/apply.ts`), `pdf-lib`
(annexure rendering, packet merge, outline/links), React 18 + React Router 6 + TanStack Query 5 + Tailwind + Radix UI kit,
`@dnd-kit/core` + `@dnd-kit/sortable` (packet reorder), framer-motion, Vite (web + extension builds), `@types/chrome`,
Vitest, Playwright (+ `@axe-core/playwright`, added by spec 005 T003)

**Storage**: Postgres tables `bid_workspaces`, `comments`, `annexure_templates`, `packets` (+ reads of `analyses`,
`vault_documents`, `company_profiles`, `tenders`, `tender_documents`, `memberships`, `users`, `notifications`,
`activity_log`, `api_tokens`); packet PDFs in R2 (Worker) / filesystem (Node) behind `BlobStore` at
`org/<orgId>/packets/<packetId>/<BID>_technical_packet.pdf`

**Testing**: Vitest — `packages/core/test/packet/{mapping,templates,build}.test.ts`, `packages/core/test/assist/allowlist.test.ts`,
`apps/extension/test/fill.test.ts`; API integration on real Postgres — `apps/api/test/{workspace,packet,assist}.test.ts`
(fixture `workspace-fixtures.ts`); real-browser extension smoke — `apps/extension/test/smoke.e2e.mjs`; Playwright E2E
`e2e/006-apply-packet-assist/US<n>-*.e2e.ts` (to be written) with evidence in `qa/evidence/006/US<n>/`

**Target Platform**: Cloudflare Worker (API + SPA) and Node (`apps/api/src/node.ts`); Chrome/Edge desktop for the extension

**Project Type**: Web application (pnpm monorepo) + browser extension

**Performance Goals**: NFR-001 detail p95 < 600 ms (40 items, 500 docs); NFR-002 30-doc/120-page packet < 15 s; annexure
render < 500 ms

**Constraints**: Constitution I (no submit/price/OTP/DSC/CAPTCHA automation — enforced in three places), IV (org scoping,
404 across orgs), VII (same code on Worker and Node; pdf-lib is pure JS; Worker memory 128 MB → input cap FR-056)

**Scale/Scope**: ≤ 200 active workspaces/org, ≤ 40 checklist items, ≤ 60 packet items typical (200 max), ≤ 50 builds listed

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence / design decision |
|---|---|---|
| I. Human-in-the-loop (NON-NEGOTIABLE) | PASS (hardening gaps) | `FORBIDDEN_PATTERNS` + `FORBIDDEN_INPUT_TYPES` in `assist/allowlist.ts`; API rejects price-like assist keys (400 `forbidden_field`); payload has `noFinancials: true`; `fill.ts` re-checks before every write and never clicks; `/submitted` only records the human's action after 3 confirmations. Gaps: content-script sender check (FR-073), read-only token scope (FR-074). |
| II. Polite, public-only ingestion | PASS | No GeM fetching here. FR-085 parses a page the **user** saved; no login, no crawling. |
| III. Deterministic first | PASS | Mapping/readiness/rendering/packet layout are pure with injected `now`; no LLM in this area. |
| IV. Tenant isolation & data protection | PASS | Every query filters `org_id`; UUID pre-check → 404; packet download checks org + `ready`; blobs under `org/<orgId>/`; `private, no-store` + `nosniff`. |
| V. Delightful, accessible UX | PASS (gaps) | Skeleton/empty/error states, 375 px layouts, keyboard DnD, live regions. Gaps: Edit-template role gating (FR-043), unsaved-change guard (FR-092), axe scans in E2E. |
| VI. Test-first, E2E verified | PARTIAL | Unit + API + extension smoke green; **no Playwright E2E for this area** → one QA task per story. |
| VII. Edge-native | PASS (gap) | pdf-lib on Workers; packet builds hold all inputs in memory → FR-056 input cap + FR-057 stuck-build recovery. |
| VIII. Simplicity & traceability | PASS | Thin routes over one service; shared contracts; code comments cite FR/T ids; NOTICE attribution for ports. |
| Constraints: licences | PASS with rule | The user explicitly approved copying from the listed reference repos; every port is recorded in root `NOTICE` (source path, licence or "no licence file — copied with the user's approval"). |

No violations requiring Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/006-apply-packet-assist/
├── spec.md              # Feature spec (this area, 7 stories)
├── plan.md              # This file
└── tasks.md             # Task list (/cairn-tasks)
# Contracts and data model for the built parts: specs/001-gem-tender-copilot/{contracts/api.md,data-model.md} (Apply sections)
```

### Source Code (repository root)

```text
packages/core/src/
├── contracts/apply.ts          # STAGES, STAGE_LABELS, Zod inputs (workspaceUpdate, mapping, override, comment, template,
│                               #   packetBuild, assistValues, submitted, outcome) + DTOs (WorkspaceDto/Detail/Card, PacketDto …)
├── packet/
│   ├── mapping.ts              # relevance, bestDocFor, autoMap, resolveMapping, readiness   (FR-013..FR-017)
│   ├── templates.ts            # TEMPLATE_KEYS/aliases, SYSTEM_TEMPLATES, buildTemplateContext, renderTemplate,
│   │                           #   placeholdersOf, missingPlaceholders, renderAnnexurePdf     (FR-034..FR-039)
│   ├── build.ts                # sniff, indexPagesFor, buildPacket, drawCover/Index, addOutline, readOutline (FR-045..FR-052)
│   └── pdf-utils.ts            # A4, sanitize, wrap, embedFonts, text helpers, dateIST
├── assist/allowlist.ts         # FIELD_CATALOG, FORBIDDEN_*, forbiddenReason, matchField, assistPayload,
│                               #   deriveAssistDefaults, validateAssistValues, HUMAN_STEPS (FR-061..FR-065)
└── gem/award.ts                # NEW (FR-085): parseAwardResult(html) — ported RA-result table heuristics

apps/api/src/
├── routes/workspaces.ts        # create-or-get, list, detail, PATCH (stage guard), mapping, overrides, comments,
│                               #   assist-values, submitted
├── routes/packets.ts           # annexure templates CRUD, annexure PDFs + preview, packets build/list/download
├── routes/assist.ts            # GET /assist/:workspaceId
├── services/packet.ts          # loaders, readinessFor, DTO mappers, listWorkspaceCards, templatesFor, workspaceAnnexures,
│                               #   renderAnnexure, defaultPacketItems, buildWorkspacePacket, workspaceDetail
└── middleware/auth.ts          # requireAuth / requireRole; NEW read-only token scope check (FR-074)

apps/web/src/features/workspace/
├── WorkspacePage.tsx           # step strip, step routing (?step), mobile Discussion toggle, skeleton/404/error
├── WorkspaceHeader.tsx         # bid chip, stage dropdown (409 toast), people picker, due date
├── QualifyStep.tsx  DocumentsStep.tsx  AnnexuresStep.tsx  PacketStep.tsx  SubmitStep.tsx
├── ActivityRail.tsx  labels.tsx  api.ts (TanStack Query hooks)

apps/extension/
├── public/manifest.json        # MV3: storage, activeTab, optional host perms, content script on *.gem.gov.in
├── popup.html  src/popup.ts  src/popup.css  src/api.ts  src/messages.ts
├── src/content.ts  src/fill.ts  src/dom.ts
└── test/fill.test.ts  test/fixtures/gem-form.html  test/smoke.e2e.mjs

packages/db/src/schema.ts        # bid_workspaces, comments, annexure_templates, packets (+ api_tokens.scope NEW)
e2e/006-apply-packet-assist/     # NEW Playwright specs; e2e/support/{fixtures.ts, seed-apply.ts NEW}
qa/evidence/006/US<n>/           # NEW evidence + VERDICT.md
```

**Structure Decision**: Keep the existing split — pure logic in `@tp/core` (shared by API, web and extension), thin routes,
one Apply service. New logic (award parser, transition rules, placeholder validation) goes into `@tp/core` first with unit
tests, then is wired into routes.

## API Endpoints

All paths are under `/api`. Auth = session cookie or `Authorization: Bearer tp_…`. Errors: `{ error: { code, message,
details? } }`. Cross-org or malformed ids → 404.

| Method & path | Role | Body / query | Success | Errors |
|---|---|---|---|---|
| `POST /tenders/:id/workspace` | Analyst+ | — | 201 `WorkspaceDto & {created:true}` / 200 `created:false` | 403, 404 "Tender not found" |
| `GET /workspaces` | Viewer+ | `?stage=a,b&mine=1&q=` | 200 `{ items: WorkspaceCard[], total, byStage }` | 400 unknown stage |
| `GET /workspaces/:id` | Viewer+ | — | 200 `WorkspaceDetail` | 404 |
| `PATCH /workspaces/:id` | Analyst+ | `{ stage?, ownerId?, assigneeIds?, dueAt?, position?, outcome? }` (strict) | 200 `WorkspaceDto` | 400 validation / non-member; 409 `not_ready` `{blockers}`; 409 `conflict` `{reason:"not_analysed"}`; **409 `invalid_transition` (gap FR-008)** |
| `PUT /workspaces/:id/mapping` | Analyst+ | `{ [itemId]: uuid \| null \| "auto" }` | 200 `{ workspace, readiness }` | 400 `details.fields` |
| `POST /workspaces/:id/overrides` | Bid Manager+ | `{ itemId, reason(5–500) }` | 201 `{ workspace, readiness }` | 400; 403; **409 `nothing_to_override` (gap FR-027)** |
| `DELETE /workspaces/:id/overrides/:itemId` | Bid Manager+ | — | 200 `{ workspace, readiness }` | 404 "Override not found" |
| `GET /workspaces/:id/comments` | Viewer+ | — | 200 `{ items: CommentDto[], total }` | 404 |
| `POST /workspaces/:id/comments` | Analyst+ | `{ body(1–4000) }` | 201 `CommentDto` | 400 "Write a comment" |
| `DELETE /workspaces/:id/comments/:commentId` **(gap FR-033)** | author or Bid Manager+ | — | 204 | 403, 404 |
| `PUT /workspaces/:id/assist-values` | Analyst+ | `{ [allowListedKey]: string ≤2000 }` | 200 `{ assistValues }` | 400 `forbidden_field` `{fields, forbidden}`; 400 `validation_error` |
| `POST /workspaces/:id/submitted` | Analyst+ | `{ submittedAt?, note?(≤1000) }` | 200 `WorkspaceDto` | 409 outcome recorded / dropped |
| `GET /annexure-templates` | Viewer+ | — | 200 `{ items: AnnexureTemplateDto[], total }` | — |
| `PUT /annexure-templates/:key` | Bid Manager+ | `{ title(3–200), body(20–20000) }` | 200 `AnnexureTemplateDto` | 400; 404 unknown key; **400 `unknown_placeholder` (gap FR-041)** |
| `DELETE /annexure-templates/:key` | Bid Manager+ | — | 200 `AnnexureTemplateDto` (system) | 404 |
| `GET /workspaces/:id/annexures/:key.pdf` | Viewer+ | `?download=1` | 200 `application/pdf` | 404 |
| `POST /workspaces/:id/annexures/:key/preview` | Analyst+ | `{ title, body }` | 200 `application/pdf` (inline) | 400 |
| `GET /workspaces/:id/packets` | Viewer+ | — | 200 `{ items: PacketDto[] (≤50), total }` | 404 |
| `POST /workspaces/:id/packets` | Analyst+ | `{ items?: PacketItemInput[] (≤200) }` | 201 `PacketDto` (ready) | 400 "Unknown packet item(s)"; 500 `packet_build_failed` `{packet}`; **413 `packet_too_large` (gap FR-056)** |
| `GET /packets/:id/download` | Viewer+ | `?inline=1` | 200 PDF stream | 404 (other org / not ready / missing blob) |
| `GET /assist/:workspaceId` | Viewer+ (cookie or Bearer) | — | 200 `AssistPayload & { stage, readiness:{percent,blockers}, workspaceUrl }` | 401, 404 |
| `POST /me/api-tokens` (spec 002) | any | **`{ name, scope?: "full" \| "read" }` (gap FR-074)** | 201 `{ token, …summary, scope }` | 400 |

## Data Model Touch-points

| Table (`packages/db/src/schema.ts`) | Columns used | Change |
|---|---|---|
| `bid_workspaces` | `id, org_id, tender_id, stage, owner_id, assignee_ids, due_at, doc_mapping, overrides, assist_values, outcome, submitted_at, position, created_at, updated_at`; unique `workspace_org_tender_uq (org_id, tender_id)` | none (FR-008/009 are logic-only). Optional index `(org_id, stage)` for list (NFR-001) |
| `comments` | `id, org_id, workspace_id, user_id, body, created_at` | none (delete = row delete, FR-033). Add index `comments_ws_idx (workspace_id)` |
| `annexure_templates` | `org_id (null = system), key, title, body, updated_at` | Add unique `(org_id, key)` to make the PUT upsert race-safe |
| `packets` | `id, org_id, workspace_id, status, items, warnings, blob_key, size_bytes, page_count, created_by, created_at`; idx `packets_ws_idx` | none (FR-057 uses `status='building' AND created_at < now-10min`) |
| `api_tokens` | `scope` | **NEW** `text('scope').$type<'full'\|'read'>().notNull().default('full')` (FR-074) |
| Read-only inputs | `analyses (checklist, requirements, verdict, status)`, `vault_documents (type, title, tags, file_name, expiry_date, issue_date, financial_year, page_count, size_bytes, blob_key)`, `company_profiles`, `tenders (bid_number, title, organisation, ministry, buyer_office, end_at, emd_amount, quantity, items, hsn_codes)`, `tender_documents`, `memberships`, `users`, `notifications`, `activity_log` | — |

## Key Flows

### 1. Start bid (built — FR-001, FR-002)

```text
Web "Start bid" → POST /tenders/:id/workspace
  → getTenderRow (404) → select workspace by (org, tender) → exists? 200 created:false
  → latestAnalysis + vaultRows → autoMap(checklist, docs, now) → count only (store `{}`, FR-002 amended)
  → stage = go | analysing | identified → insert … onConflictDoNothing → (lost race? select winner, 200)
  → activity workspace.created (workspace + tender) → 201 WorkspaceDto
```

### 2. Read workspace & readiness (built — FR-011, FR-013..FR-017; gap FR-009, FR-057)

```text
GET /workspaces/:id → getWorkspace (UUID + org) → workspaceDetail:
  tender, latestAnalysis, vaultRows, profile, templates, packets(≤?), comments, activity(50), members, tenderDocs
  readiness = readiness(checklist, docMapping, vault, overrides, now)   # absent key → bestDocFor at read time
  annexures = workspaceAnnexures(...) with missingPlaceholders(ctx)
  defaultPacketItems(readiness, annexures, docs)          # gap FR-055: prefer last ready packet's items
  [gap FR-057] packets.status=building && age>10min → update to failed
  [gap FR-009] no analysis → readiness.analysed=false, percent=0
```

### 3. Stage change with guard (built — FR-005; gap FR-008)

```text
PATCH {stage:"ready"} → readinessOf(w) → no analysis → 409 conflict(not_analysed)
                                       → blockers>0 → 409 not_ready {blockers}
  [gap] stage∈{won,lost} && w.stage∉{submitted,won,lost} → 409 invalid_transition
  → set stage, position = next in stage, submittedAt if submitted, minimal outcome if won/lost
  → activity workspace.stage_changed {from,to} → 200
Web: 409 → toast(message, blockers[0..2], action "Fix documents" → ?step=documents)
```

### 4. Build packet (built — FR-045..FR-054; gaps FR-055..FR-057)

```text
Web Packet step: order = localStorage[tp:packet-order:<ws>] ?? defaults  → POST /workspaces/:id/packets {items}
API buildWorkspacePacket:
  load tender, profile, analysis, vault, templates → ctx, readiness, annexures
  items = requested || defaultPacketItems
  validate refs (vault∈org, annexure∈SYSTEM_TEMPLATE_BY_KEY, tender_doc∈this tender & (org|public)) → 400
  [gap FR-056] Σ sizeBytes(vault, tender_doc) + 50 KB/annexure > 60 MB → 413
  insert packets(status=building)
  buildPacket({items, loadBytes, company, tender, now}):
     load+sniff each → plan pages (cover + index pages first) → copyPages / embed images
     → draw cover & index (+ link annots) → footer stamp → outline → save → size warning
  + warnings: open blockers, expired docs → blobs.put(org/<org>/packets/<id>/<BID>_technical_packet.pdf)
  update packets(status=ready, items with startPage/included, sizeBytes, pageCount, warnings)
  catch → status=failed → route 500 packet_build_failed
Route: activity packet_built|failed; ready && stage∈{identified,analysing,go} → preparing (auto)
```

### 5. Assist & extension (built — FR-061..FR-072; gaps FR-073..FR-077)

```text
Popup: Save & connect → validate URL/token → chrome.permissions.request(origin) → GET /api/auth/me → storage.local
       → GET /api/workspaces?stage=go,preparing,ready,submitted → GET /api/assist/:id
       → render values / docs / human steps
"Highlight fields" → tabs.sendMessage(tp:scan, fields) → content.ts: collectControls → plan → mark + TP chips
"TP chip click"   → fillOne(entry, overwrite) → forbiddenReason re-check → native setter + input/change
"Fill allowed"    → tabs.sendMessage(tp:fill) → fillAll (no overwrite) → report → popup status
[gap FR-073] content.ts: if (sender.id !== chrome.runtime.id) return; manifest matches https only
[gap FR-074] middleware: authKind=token && token.scope='read' && method≠GET → 403 "This API token is read-only"
API PUT /assist-values → validateAssistValues (forbidden keys first) → 400 forbidden_field | store trimmed
```

### 6. Submission & outcome (built — FR-079..FR-083; gaps FR-084, FR-085)

```text
Submit step → dialog (3 checks) → POST /submitted {note} → stage=submitted, submittedAt → activity
Record result → dialog → PATCH {outcome:{result,l1Price,ourPrice,notes}} → stage=result → activity outcome_recorded
[gap FR-085] "Suggest from GeM result" → user picks saved HTML → (client) parseAwardResult(html) from @tp/core
             → {l1Price, l1Seller, bidders[]} → prefill dialog (user confirms)
```

## What to Port from the Reference Repos

The user explicitly approved copying whichever code works best; every port is recorded in root `NOTICE`.

| Source (in `/home/user/refs/`) | Target | Why |
|---|---|---|
| `IshanMaheshwari-777_GEM-SCRAPER/scraper.py` — `scrape_ra_schedule()` table classification (header keywords "rank/price/l1/financial/amount/total" vs "seller/vendor/bidder/technical/qualified"), winner = trophy/winner-marked row, else rank 1, else first row, `compute_status_flag()` | `packages/core/src/gem/award.ts` `parseAwardResult(html)` (pure TS, DOM-free tokenizer over `<table>`), tests in `packages/core/test/gem/award.test.ts` | FR-085: suggest L1 price/seller from a GeM RA result page the user saved. Repo has no licence file → port with attribution under the user's approval. |
| `IshanMaheshwari-777_GEM-SCRAPER/ra_page_dump.html` | `packages/core/test/fixtures/gem/ra-result.html` (synthetic: the reference dump has no evaluation table, so the fixture is hand-built to the structure the heuristics expect) | Fixture for the parser. |
| `erenmyeager15_india-government-tenders-scraper/src/pdf.ts` (Apache-2.0) — "give the PDF reader an independent plain `Uint8Array`" pattern | `apps/api/src/services/packet.ts` `loadBytes` (copy blob bytes with `Uint8Array.from` before `PDFDocument.load`) | Avoids shared-`ArrayBuffer` slice bugs when Node `Buffer`s from the FS blob store reach pdf-lib; cheap hardening for FR-047. |
| `erenmyeager15_india-government-tenders-scraper/src/run-budget.ts` (Apache-2.0) — explicit byte/time budget guard | `apps/api/src/services/packet.ts` input-size pre-check (FR-056) | Same "fail fast before work" shape for the Worker memory budget. |
| `IshanMaheshwari-777_GEM-SCRAPER/probe.py` notes on `bidplus.gem.gov.in` page structure (`showbidDocument`, `list-ra-schedules`) | `apps/extension/README.md` + `apps/extension/test/fixtures/gem-form.html` comments | Document which GeM pages the content script targets; no code. |

Not ported: scraping/login automation of any kind (Constitution I/II), Python PDF extractors (`Mujahid-Alam_gem-tender-pdf-extractor`
— the Analyse area already parses bid PDFs), Excel exporters.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| GeM renames form fields → extension matches nothing | Selector hints match label/aria/nearby-text, not ids; "unmatched" is harmless; copy panel always works. |
| A new GeM field named e.g. "Offered value" slips through | Forbidden patterns cover value/amount/price variants and win over allowed matches; unit test matrix grows with every reported label. |
| Large scans exhaust Worker memory | FR-056 input cap; vault already caps files at 20 MB; warning above 20 MB output. |
| Packet order lost across browsers | FR-055 server-side default from last build. |
| Stuck `building` rows after a crash | FR-057 lazy recovery on read. |
| Custom templates with typos print blanks | FR-041 placeholder validation + preview before save. |

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations.
