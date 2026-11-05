---

description: "Task list for 006 Apply — Bid Workspace, Annexures, Packet & Assisted Submission"
---

# Tasks: Apply — Bid Workspace, Annexures, Packet & Assisted Submission

**Input**: Design documents from `/specs/006-apply-packet-assist/`

**Prerequisites**: plan.md (required), spec.md (required for user stories); contracts/data model of the built parts live in
`specs/001-gem-tender-copilot/{contracts/api.md,data-model.md}` (Apply sections)

**Tests**: Requested. Core logic gets Vitest unit tests (`packages/core/test/{packet,assist,gem}/`); routes get API
integration tests on real Postgres (`apps/api/test/{workspace,packet,assist}.test.ts`, fixture `workspace-fixtures.ts`); the
extension keeps `apps/extension/test/fill.test.ts` + the real-browser `smoke.e2e.mjs`; every user story gets a Playwright E2E
with evidence (screenshots, video, trace) in `qa/evidence/006/US<n>/` plus a QA `VERDICT.md`. Review is done with the cairn
review workflow (ai-sdlc conventions in `CONVENTIONS.md` for review/QA only).

**Organization**: Tasks are grouped by user story. `- [x]` = already implemented and verified by reading the code on
2026-11-05 (delivered as 001 tasks T060–T066); `- [ ]` = remaining work (gaps, hardening, missing tests, QA). Each open
task is sized at ≤ 1 day.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1…US7)
- File paths are repo-relative to `/home/user/GEMs`

## Path Conventions

- Core logic: `packages/core/src/packet/`, `packages/core/src/assist/allowlist.ts`, contracts `packages/core/src/contracts/apply.ts`,
  tests `packages/core/test/{packet,assist,gem}/`
- Schema/migrations: `packages/db/src/schema.ts`, `packages/db/migrations/`
- API: `apps/api/src/routes/{workspaces,packets,assist}.ts`, `apps/api/src/services/packet.ts`, tests `apps/api/test/{workspace,packet,assist}.test.ts`
- Web: `apps/web/src/features/workspace/`
- Extension: `apps/extension/{public,src,test}/`
- E2E: `e2e/006-apply-packet-assist/US<n>-*.e2e.ts`, evidence `qa/evidence/006/US<n>/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: E2E fixture, extension test harness, attribution

- [x] T001 [P] Playwright E2E stack (`pnpm e2e`, mock-gem :4011, API + SPA :8788), `evidence()` and `collectRunArtifacts()` helpers in `e2e/support/fixtures.ts` and `e2e/support/start-api.sh` NFR-010
- [ ] T002 [P] Create `e2e/006-apply-packet-assist/` and add `seedApplyFixture(request)` in `e2e/support/seed-apply.ts` (mirror `apps/api/test/workspace-fixtures.ts::seedApply` via public API + a direct `@tp/db` insert for tender/analysis, with tender `endAt` = now + 15 d and Dell MAF expiry = now − 35 d; returns ids and per-role storage states) NFR-010 (#193)
- [ ] T003 [P] Extension E2E helper `launchWithExtension()` in `e2e/support/extension.ts` (build `apps/extension/dist` once, compute the unpacked id like `smoke.e2e.mjs`, serve `apps/extension/test/fixtures/gem-form.html` on `http://localhost:<port>/gem-form.html`, open `chrome-extension://<id>/popup.html`) NFR-010 (#195)
- [ ] T004 [P] Append to root `NOTICE` the attributions for ports in this spec: `IshanMaheshwari-777_GEM-SCRAPER/scraper.py` + `ra_page_dump.html` (no licence file — copied with the user's approval) and `erenmyeager15_india-government-tenders-scraper/src/{pdf.ts,run-budget.ts}` (Apache-2.0) NFR-009 (#197)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, contracts, shared PDF helpers and the Apply service every story relies on

- [x] T005 Tables `bid_workspaces` (unique `workspace_org_tender_uq`), `comments`, `annexure_templates`, `packets` (idx `packets_ws_idx`) in `packages/db/src/schema.ts` FR-001, FR-029, FR-036, FR-053
- [x] T006 [P] Zod contracts and DTOs (`STAGES`, `STAGE_LABELS`, `workspaceUpdateSchema`, `mappingInputSchema`, `overrideInputSchema`, `commentInputSchema`, `annexureTemplateInputSchema`, `packetBuildSchema`, `assistValuesSchema`, `submittedInputSchema`, `outcomeInputSchema`, `WorkspaceDetail`, `WorkspaceCard`, `PacketDto`, `AnnexureTemplateDto`) in `packages/core/src/contracts/apply.ts` FR-003, FR-004
- [x] T007 [P] PDF helpers (`A4`, `sanitize`, `wrap`, `embedFonts`, `text*`, `dateIST`, `dateTimeIST`) in `packages/core/src/packet/pdf-utils.ts` FR-039
- [x] T008 Apply service loaders and mappers (`getWorkspace` UUID+org 404, `latestAnalysis`, `vaultRows`, `profileRow`, `readinessFor`, `people`, `orgMembers`, `toWorkspaceDto`, `toPacketDto`, `workspaceDetail`) in `apps/api/src/services/packet.ts` FR-011, NFR-004
- [x] T009 Mount `workspacesRoutes`, `packetsRoutes`, `assistRoutes` in `apps/api/src/app.ts` FR-001
- [ ] T010 [P] Add unique index `(org_id, key)` on `annexure_templates`, index `comments_ws_idx (workspace_id)` and index `(org_id, stage)` on `bid_workspaces` in `packages/db/src/schema.ts`; generate the migration in `packages/db/migrations/` (drizzle-kit) FR-036, NFR-001 (#199)

**Checkpoint**: Foundation ready — user stories can proceed in parallel

---

## Phase 3: User Story 1 - Start a bid workspace and move it through the stages with a "Ready to submit" guard (Priority: P1) 🎯 MVP

**Goal**: One workspace per tender, a truthful stage with the Ready-to-submit guard, people and due date.

**Independent Test**: Apply fixture → `POST /api/tenders/{id}/workspace` 201 `stage: "go"`; `PATCH {stage:"ready"}` → 409 `not_ready` with `oem_authorization`.

### Built

- [x] T011 [US1] Create-or-get `POST /tenders/:id/workspace` with initial stage from analysis, owner, due = closing, empty stored mapping (auto picks resolved at read time; FR-002 amended), race handling and activity in `apps/api/src/routes/workspaces.ts` FR-001, FR-002
- [x] T012 [US1] `GET /workspaces` (stage/mine/q, byStage) and `GET /workspaces/:id` in `apps/api/src/routes/workspaces.ts` and `listWorkspaceCards` in `apps/api/src/services/packet.ts` FR-010, FR-011, FR-022
- [x] T013 [US1] `PATCH /workspaces/:id` with strict schema, member check, assignment notifications, `ready` guard (409 `not_ready` / `not_analysed`), position, `submittedAt`, minimal outcome in `apps/api/src/routes/workspaces.ts` FR-004, FR-005, FR-006, FR-012, FR-082
- [x] T014 [P] [US1] Activity sentences for `workspace.*` actions in `apps/web/src/features/workspace/labels.tsx` FR-007
- [x] T015 [P] [US1] Header: copy bid number, stage dropdown with blocker count and 409 toast + "Fix documents", people picker, due-date popover in `apps/web/src/features/workspace/WorkspaceHeader.tsx` FR-005, FR-006, FR-086
- [x] T016 [US1] Workspace page shell: breadcrumb, title, step strip with hints, `?step` routing and default step, skeleton/404/error states, reduced-motion in `apps/web/src/features/workspace/WorkspacePage.tsx` FR-023, FR-087, FR-088, FR-089, FR-090
- [x] T017 [P] [US1] Qualify step summary in `apps/web/src/features/workspace/QualifyStep.tsx` FR-091
- [x] T018 [US1] API tests: create/idempotent/404/403, detail, org isolation, guard, overrides unblock, assignment, unknown fields in `apps/api/test/workspace.test.ts` FR-001…FR-006

### Remaining

- [x] T019 [P] [US1] Add `canTransition(from, to): { ok: true } | { ok: false, code: 'invalid_transition', message }` (won/lost only from submitted/won/lost) in `packages/core/src/contracts/apply.ts` with unit tests in `packages/core/test/packet/stages.test.ts` FR-008 (#201)
- [x] T020 [US1] Enforce `canTransition` in `PATCH /workspaces/:id` (stage and outcome paths) returning 409 `invalid_transition`; API tests "won from go → 409", "won from submitted → 200" in `apps/api/src/routes/workspaces.ts`, `apps/api/test/workspace.test.ts` FR-008 (#203)
- [x] T021 [US1] Return `analysed: false`, `percent: 0` readiness when there is no analysis in `readinessFor`/`listWorkspaceCards`/`workspaceDetail` (`apps/api/src/services/packet.ts`), extend `Readiness`/`WorkspaceCard` types in `packages/core/src/packet/mapping.ts` and `packages/core/src/contracts/apply.ts`; API test in `apps/api/test/workspace.test.ts` FR-009 (#205)
- [x] T022 [P] [US1] Stage dropdown: disable Won/Lost before Submitted with hint "Mark as submitted first"; Documents hint "Not analysed" when `analysed === false` in `apps/web/src/features/workspace/WorkspaceHeader.tsx`, `apps/web/src/features/workspace/WorkspacePage.tsx` FR-008, FR-009, FR-023 (#207)
- [x] T023 [US1] QA: Playwright E2E for US1 with evidence (screenshots, video, trace) in `qa/evidence/006/US1/` — scenarios 1–15: API create 201/200/403/404, header texts (bid chip copy, "Go", score 78, EMD ₹1,50,000), dropdown order + "1 blocker", 409 toast with "Fix documents", not-analysed 409, move to Preparing + activity "moved it from Go to Preparing", owner/assignee notification, non-member 400, due date max + Clear, Viewer read-only, won-from-go 409 (after T020), desktop + `@mobile` 375 px (header stacks, step strip scrolls, no horizontal page scroll) + axe; spec `e2e/006-apply-packet-assist/US1-workspace-stages.e2e.ts`; `VERDICT.md` FR-001…FR-012, FR-087…FR-091, NFR-006, NFR-007 (#209)

**Checkpoint**: Workspace lifecycle and guard verified end-to-end

---

## Phase 4: User Story 2 - Map the checklist to vault documents and see bid readiness (Priority: P1)

**Goal**: Automatic, overridable checklist → vault mapping with an honest readiness number.

**Independent Test**: Apply fixture Documents step shows 83 %, "1 blocker before “Ready to submit”", "5 of 6 required items covered · 7 items in the checklist".

### Built

- [x] T024 [P] [US2] `relevance`, `bestDocFor` (exact type, related-type fallback, status, relevance, newest FY, dates), `autoMap`, `resolveMapping` (absent = auto, null = not available), `readiness` (states, notes, percent, blockers, warnings, canMarkReady) in `packages/core/src/packet/mapping.ts` FR-013, FR-014, FR-016, FR-017, FR-021
- [x] T025 [P] [US2] Mapping/readiness unit tests (14 cases) in `packages/core/test/packet/mapping.test.ts` FR-013…FR-017
- [x] T026 [US2] `PUT /workspaces/:id/mapping` with per-item validation, `"auto"` removal, activity in `apps/api/src/routes/workspaces.ts` FR-015, FR-020
- [x] T027 [US2] Documents step: readiness ring, blocker chips, filter tabs, checklist rows, doc picker popover (search, groups, Auto-match, Not available, Upload new), upload deep links, Viewer read-only in `apps/web/src/features/workspace/DocumentsStep.tsx`, `apps/web/src/features/workspace/labels.tsx` FR-018, FR-019, FR-024

### Remaining

- [x] T028 [P] [US2] API tests for edge cases: vault document deleted after explicit mapping → `missing`; auto item falls back to next best; a doc expiring in 12 days → `expiring`, in `warnings`, not a blocker; `other` item relevance ≥ 0.5 in `apps/api/test/workspace.test.ts` FR-013, FR-016, FR-017, FR-020 (#211)
- [x] T029 [P] [US2] Accessibility: give the Documents filter `role="tabpanel"` + `aria-controls`/`aria-labelledby`, arrow-key navigation between tabs, and an accessible name for the readiness ring ("Readiness 83 percent") in `apps/web/src/features/workspace/DocumentsStep.tsx` NFR-006 (#212)
- [x] T030 [US2] QA: Playwright E2E for US2 with evidence (screenshots, video, trace) in `qa/evidence/006/US2/` — scenarios 1–13: ring 83 % + texts, row states/badges (Auto-matched, FY 2024-25, Expired, Missing with "Upload Udyam (MSE) certificate", Generated + Preview), filter tabs 7/2/5 and empty filter, picker groups, pick other doc toast "Using “Balance sheet 2023-24”", Not available / Auto-match toasts, upload Udyam via vault → Ready + Auto-matched without mapping, 400 errors via API, `@mobile` 375 px stacking + popover ≤ 92 vw + no horizontal scroll, axe; spec `e2e/006-apply-packet-assist/US2-mapping-readiness.e2e.ts`; `VERDICT.md` FR-013…FR-024 (#214)

**Checkpoint**: Readiness is trustworthy; guard inputs verified

---

## Phase 5: User Story 3 - Override a blocking item with a reason and coordinate in comments (Priority: P2)

**Goal**: Traceable Bid Manager overrides and a team discussion with notifications.

**Independent Test**: Bid Manager overrides `oem_authorization` → 100 %; Analyst moves to Ready → 200; delete override → 1 blocker.

### Built

- [x] T031 [US3] `POST/DELETE /workspaces/:id/overrides` (Bid Manager+, reason 5–500, replace per item, readiness in response, activity) in `apps/api/src/routes/workspaces.ts` FR-025, FR-026
- [x] T032 [P] [US3] Override dialog and Remove override on mandatory missing/expired rows for Bid Manager+ in `apps/web/src/features/workspace/DocumentsStep.tsx` FR-028
- [x] T033 [US3] `GET/POST /workspaces/:id/comments` with owner/assignee notifications (dedupe per comment) in `apps/api/src/routes/workspaces.ts`, `listComments` in `apps/api/src/services/packet.ts` FR-029
- [x] T034 [P] [US3] Discussion rail (comments, Ctrl/⌘+Enter, Activity) and mobile "Bid steps | Discussion (n)" toggle in `apps/web/src/features/workspace/ActivityRail.tsx`, `apps/web/src/features/workspace/WorkspacePage.tsx` FR-030, FR-031

### Remaining

- [x] T035 [US3] Refuse overrides of items that are not missing/expired with 409 `nothing_to_override` "Only a missing or expired item can be overridden." + API test in `apps/api/src/routes/workspaces.ts`, `apps/api/test/workspace.test.ts` FR-027 (#216)
- [x] T036 [P] [US3] Pure `parseMentions(body, members): string[]` (matches `@First` / `@First Last`, case-insensitive, de-duplicated, ignores e-mail addresses) in `packages/core/src/contracts/apply.ts` (or `packages/core/src/packet/mentions.ts`) with tests in `packages/core/test/packet/mentions.test.ts` FR-032 (#219)
- [x] T037 [US3] Notify mentioned members in `POST /workspaces/:id/comments` (union with owner/assignees, minus author) + API test in `apps/api/src/routes/workspaces.ts`, `apps/api/test/workspace.test.ts` FR-032 (#221)
- [x] T038 [US3] `DELETE /workspaces/:id/comments/:commentId` (author or Bid Manager+ → 204; others 403; other org 404; activity `workspace.comment_deleted`) + API tests in `apps/api/src/routes/workspaces.ts`, `apps/api/test/workspace.test.ts` FR-033 (#223)
- [x] T039 [P] [US3] Comment delete menu ("Delete comment" with confirm) for author/Bid Manager+, `useDeleteComment` hook and activity label in `apps/web/src/features/workspace/ActivityRail.tsx`, `apps/web/src/features/workspace/api.ts`, `apps/web/src/features/workspace/labels.tsx` FR-033 (#224)
- [ ] T040 [US3] QA: Playwright E2E for US3 with evidence (screenshots, video, trace) in `qa/evidence/006/US3/` — scenarios 1–11: Analyst has no Override (403 via API), dialog copy + 5-char rule, override → "Overridden" + 100 % + activity sentence, Ready succeeds, Remove override → Expired, 400/404 via API, nothing_to_override 409 (after T035), comment post with Ctrl+Enter + notification in the owner's bell, empty/whitespace 400, Viewer no composer, `@mobile` Discussion toggle, mentions + delete (after T037/T038), axe; spec `e2e/006-apply-packet-assist/US3-overrides-comments.e2e.ts`; `VERDICT.md` FR-025…FR-033 (#226)

**Checkpoint**: Collaboration and accountability verified

---

## Phase 6: User Story 4 - Generate annexures and undertakings from editable templates (Priority: P1)

**Goal**: Letterhead annexure PDFs filled from profile/tender, org-customisable templates.

**Independent Test**: `GET /api/workspaces/{id}/annexures/non_blacklisting.pdf` contains "SHARMA INFOTECH PVT LTD", "GEM/2026/B/700001", "27AAPFU0939F1ZV", "Authorised Signatory (Seal & Signature)".

### Built

- [x] T041 [P] [US4] 8 system templates, key aliases, `buildTemplateContext`, `renderTemplate`, `placeholdersOf`, `missingPlaceholders`, `renderAnnexurePdf` (letterhead, title, lists, Subject bold, page breaks, footer, signature block, metadata) in `packages/core/src/packet/templates.ts` FR-034, FR-038, FR-039, FR-044
- [x] T042 [P] [US4] Template unit tests (9 cases) in `packages/core/test/packet/templates.test.ts` FR-034…FR-039
- [x] T043 [US4] `GET/PUT/DELETE /annexure-templates[/:key]`, `GET /workspaces/:id/annexures/:key.pdf`, `POST …/annexures/:key/preview` in `apps/api/src/routes/packets.ts`; `templatesFor`, `templateFor`, `templateContext`, `workspaceAnnexures`, `renderAnnexure` in `apps/api/src/services/packet.ts` FR-035, FR-036, FR-037, FR-040
- [x] T044 [US4] Annexures step (list with badges and blanks, profile-gaps banner, iframe preview with skeleton timeout, phone Preview PDF, template editor dialog with placeholder palette, Preview, Save, Restore default) in `apps/web/src/features/workspace/AnnexuresStep.tsx` FR-042, FR-043
- [x] T045 [US4] API tests: 8 templates, Bid-Manager-only customisation per org + reset, rendered PDFs with aliases, draft preview in `apps/api/test/packet.test.ts` FR-034…FR-040

### Remaining

- [x] T046 [P] [US4] Export `TEMPLATE_PLACEHOLDERS` (all context paths with friendly labels) and `unknownPlaceholders(body)` from `packages/core/src/packet/templates.ts`; unit tests in `packages/core/test/packet/templates.test.ts` FR-041 (#228)
- [x] T047 [US4] Reject unknown placeholders with 400 `unknown_placeholder` (`details.unknown`) in `PUT /annexure-templates/:key` and `POST …/preview` + API tests in `apps/api/src/routes/packets.ts`, `apps/api/test/packet.test.ts` FR-041 (#248)
- [x] T048 [P] [US4] Build the editor palette from `TEMPLATE_PLACEHOLDERS` (replacing the local list) and show the unknown-placeholder error inline in `apps/web/src/features/workspace/AnnexuresStep.tsx`, `apps/web/src/features/workspace/labels.tsx` FR-041, FR-043 (#233)
- [x] T049 [P] [US4] Render **Edit template** only for Bid Manager+ (`useCan('bid_manager')`) in `apps/web/src/features/workspace/AnnexuresStep.tsx` FR-043 (#234)
- [x] T050 [US4] "Discard unsaved changes?" confirm when closing the template editor with edits in `apps/web/src/features/workspace/AnnexuresStep.tsx` FR-092 (#237)
- [x] T051 [US4] QA: Playwright E2E for US4 with evidence (screenshots, video, trace) in `qa/evidence/006/US4/` — scenarios 1–11: list of 6 in order with badges, blanks badge/tooltip + profile banner (empty-profile org), iframe preview and headers via API (`content-disposition`, `no-store`, alias, 404), PDF text assertions (letterhead, Ref/Date, signature block, footer) using `pdf-lib`/`pdfjs` text extraction, Analyst 403 + no Edit button (after T049), Bid Manager edit → preview → save → other workspace uses it → Restore default, short body 400, unknown placeholder 400 (after T047), ₹/Devanagari sanitising, `@mobile` Preview PDF button, axe; spec `e2e/006-apply-packet-assist/US4-annexures.e2e.ts`; `VERDICT.md` FR-034…FR-044 (#239)

**Checkpoint**: Annexures verified on screen and in PDF bytes

---

## Phase 7: User Story 5 - Build one merged, bookmarked packet for the GeM technical upload (Priority: P1)

**Goal**: One reviewed, ordered, bookmarked PDF per bid with honest warnings.

**Independent Test**: `POST /api/workspaces/{id}/packets {}` → 201 ready, 11 pages, start pages 1,3,4,5,6,7,8,11, expired-MAF warning; outline in order.

### Built

- [x] T052 [P] [US5] `buildPacket`: load + magic-byte sniff, PDF copy, image placement, skip-with-warning, page plan with index pages (26/34 rows), cover, index with link annotations, footer stamp, flat outline + `UseOutlines`, size warning; `readOutline` in `packages/core/src/packet/build.ts` FR-047…FR-052
- [x] T053 [P] [US5] Packet unit tests (7 cases: order, custom order, no cover, skip bad files, size warning, long index, sniff) in `packages/core/test/packet/build.test.ts` FR-047…FR-052
- [x] T054 [US5] `defaultPacketItems` and `buildWorkspacePacket` (reference validation → 400, `building` row, annexure render, blob load, blocker/expired warnings, blob key, `ready`/`failed`) in `apps/api/src/services/packet.ts` FR-045, FR-046, FR-052, FR-053
- [x] T055 [US5] `GET/POST /workspaces/:id/packets`, `GET /packets/:id/download`, auto-move to Preparing, activity, 500 `packet_build_failed` in `apps/api/src/routes/packets.ts` FR-054, FR-058
- [x] T056 [US5] Packet step: contents with dnd-kit (pointer/touch/keyboard), up/down/remove, Add more, Default order, estimate panel with 20 MB bar, build progress live region, latest packet card with warnings, earlier builds in `apps/web/src/features/workspace/PacketStep.tsx` FR-060
- [x] T057 [US5] API tests: default packet (11 pages, start pages, expired warning, blob key), Preparing + activity, download with bookmarks, custom order + validation, Viewer 403, history in `apps/api/test/packet.test.ts` FR-045…FR-058

### Remaining

- [x] T058 [US5] Default the proposed order to the last `ready` packet's items (drop stale refs, append newly required annexures/documents) in `defaultPacketItems`/`workspaceDetail` (`apps/api/src/services/packet.ts`) + API test in `apps/api/test/packet.test.ts` FR-055 (#241)
- [x] T059 [P] [US5] Use the server default order; treat `tp:packet-order:<id>` only as an unsaved draft, cleared after a successful build; "Default order" resets to the computed default in `apps/web/src/features/workspace/PacketStep.tsx` FR-055 (#243)
- [x] T060 [US5] Input-size pre-check (Σ stored sizes + 50 KB per annexure) → 413 `packet_too_large` with MB message, configurable `PACKET_MAX_INPUT_BYTES` (default 60 MB) in `apps/api/src/services/packet.ts`, `apps/api/src/env.ts`; API test in `apps/api/test/packet.test.ts` FR-056, NFR-003 (#245)
- [x] T061 [US5] Lazy recovery of `building` rows older than 10 minutes → `failed` "Build interrupted — try again." when listing/reading packets in `apps/api/src/services/packet.ts`; API test with a backdated row in `apps/api/test/packet.test.ts` FR-057 (#251)
- [x] T062 [P] [US5] Shared `contentDisposition(kind, fileName)` helper emitting ASCII `filename` + RFC 5987 `filename*` for packet and annexure downloads in `apps/api/src/lib/http.ts` (new), used by `apps/api/src/routes/packets.ts`; tests in `apps/api/test/packet.test.ts` FR-059 (#252)
- [x] T063 [P] [US5] Port the "independent `Uint8Array` copy before PDF load" hardening from `erenmyeager15_india-government-tenders-scraper/src/pdf.ts` into `loadBytes` in `apps/api/src/services/packet.ts` (attribution comment + NOTICE via T004) FR-047 (#253)
- [x] T064 [P] [US5] Unit tests asserting index pages, API `startPage`, bookmarks and footer "Page x of N" agree for 1, 27 and 61 documents (incl. images and a skipped file) in `packages/core/test/packet/build.test.ts` SC-005, FR-048, FR-051 (#255)
- [x] T065 [P] [US5] Perf check: 30 documents / 120 pages / 25 MB input builds < 15 s; annexure render < 500 ms (Vitest bench, not in default CI) in `apps/api/test/perf/packet.perf.ts` NFR-002 (#258)
- [x] T066 [US5] QA: Playwright E2E for US5 with evidence (screenshots, video, trace) in `qa/evidence/006/US5/` — scenarios 1–15: default contents + counters, drag/arrow/keyboard reorder + Default order, add/remove + empty state, build progress texts, toast "Packet ready — 11 pages" + "2 warnings to review", latest card warnings, stage → Preparing + activity, download headers and PDF assertions (11 pages, outline titles, footer, cover texts) saved as `packet.pdf` in the evidence folder, 400 unknown items via API, image/corrupt-file warnings, > 20 MB red estimate, history + Viewer, team-shared order (after T058/T059), 413 (after T060), `@mobile` 375 px, axe; spec `e2e/006-apply-packet-assist/US5-packet.e2e.ts`; `VERDICT.md` FR-045…FR-060, SC-001, SC-005 (#259)

**Checkpoint**: Packet output verified page-by-page

---

## Phase 8: User Story 6 - Assisted submission: copy-ready values and the browser extension, never prices (Priority: P2)

**Goal**: Faster GeM form filling for non-financial fields only, with the human always in control.

**Independent Test**: `PUT /assist-values {"unit_price":"1000"}` → 400 `forbidden_field`; extension fills Make/Model/Country of origin on the fixture page; price/CAPTCHA/OTP/DSC stay empty; no submit.

### Built

- [x] T067 [P] [US6] Allow-list (14 fields), forbidden patterns/input types, `normalizeText`, `forbiddenReason`, `matchField` (longest hint, forbidden wins), `deriveAssistDefaults`, `assistPayload` (`noFinancials: true`), `validateAssistValues`, `HUMAN_STEPS` in `packages/core/src/assist/allowlist.ts` FR-061, FR-062, FR-065, FR-076
- [x] T068 [P] [US6] Allow-list unit tests (10 cases) in `packages/core/test/assist/allowlist.test.ts` FR-061, FR-062
- [x] T069 [US6] `PUT /workspaces/:id/assist-values` (keys checked before types, `forbidden_field`, trim, empty deletes, activity keys only) in `apps/api/src/routes/workspaces.ts` FR-063
- [x] T070 [US6] `GET /assist/:workspaceId` (cookie or Bearer; packet → vault → annexures; stage, readiness, workspaceUrl) in `apps/api/src/routes/assist.ts` FR-064
- [x] T071 [US6] Assist API tests (forbidden keys, unknown keys, save/clear, Bearer token, no price, cross-org) in `apps/api/test/assist.test.ts` FR-063, FR-064
- [x] T072 [US6] Submit step: Human-only steps, values card (groups, Not set, copy, Edit/Save/Cancel), Upload in this order, extension card in `apps/web/src/features/workspace/SubmitStep.tsx` FR-066
- [x] T073 [US6] MV3 manifest (storage, activeTab, optional host permissions, content script), popup (connect, workspace picker, values, docs, steps, Highlight/Fill), settings/API client in `apps/extension/public/manifest.json`, `apps/extension/popup.html`, `apps/extension/src/{popup,api,messages}.ts` FR-067, FR-068
- [x] T074 [US6] Content script (scan/fill/clear, TP chips, outlines), pure fill logic (`plan`, `fillOne` re-check, `fillAll`, `pickOption`), DOM adapter (labels, table context, native setter + events, visible text-like controls) in `apps/extension/src/{content,fill,dom}.ts` FR-069, FR-070, FR-071, FR-072
- [x] T075 [US6] Extension unit tests (8 cases) and real-browser smoke test with the GeM-like fixture in `apps/extension/test/{fill.test.ts,smoke.e2e.mjs,fixtures/gem-form.html}` FR-070, NFR-005
- [x] T076 [P] [US6] Extension README (build, load unpacked, token, human-only steps, safety rules) in `apps/extension/README.md` FR-078

### Remaining

- [ ] T077 [US6] Content script: ignore messages unless `sender.id === chrome.runtime.id`; manifest content-script matches `https://*.gem.gov.in/*` (+ localhost fixture) only; unit test with a fake `chrome.runtime` in `apps/extension/src/content.ts`, `apps/extension/public/manifest.json`, `apps/extension/test/content.test.ts` FR-073 (#261)
- [ ] T078 [US6] Add `api_tokens.scope` (`'full' | 'read'`, default `'full'`) in `packages/db/src/schema.ts` + migration in `packages/db/migrations/`; accept `scope` in `POST /me/api-tokens` and return it in summaries in `apps/api/src/routes/auth.ts` FR-074 (#263)
- [ ] T079 [US6] Enforce read-only tokens: `authKind === 'token' && scope === 'read' && method !== 'GET'` → 403 "This API token is read-only" in `apps/api/src/middleware/auth.ts`; API tests (GET assist OK, PUT assist-values 403, POST comments 403) in `apps/api/test/assist.test.ts` FR-074 (#265)
- [ ] T080 [P] [US6] Token scope selector ("Full access" / "Extension (read-only)", default read-only when opened from the Submit step link) in `apps/web/src/features/settings/sections/TokensSection.tsx`; update the extension card copy in `apps/web/src/features/workspace/SubmitStep.tsx` and `apps/extension/README.md` FR-074 (#267)
- [ ] T081 [P] [US6] Popup fill report (filled list + skipped with reason) and **Clear highlights** button sending `tp:clear` in `apps/extension/src/popup.ts`, `apps/extension/popup.html`, `apps/extension/src/popup.css` FR-075 (#269)
- [ ] T082 [US6] Report radio/checkbox questions matching an allow-listed key as "left for you" (status `manual`, chip title shows the prepared answer, never clicked) in `apps/extension/src/fill.ts`, `apps/extension/src/content.ts`, `apps/extension/src/dom.ts`; tests in `apps/extension/test/fill.test.ts` FR-077 (#271)
- [ ] T083 [P] [US6] DOM adapter unit tests under jsdom (`labelFor` via `<label for>`, wrapping label, `aria-labelledby`; table-column context; hidden elements excluded; select `pickOption`; number input rejects text; `input`/`change` dispatched) in `apps/extension/test/dom.test.ts` FR-069, FR-071 (#274)
- [ ] T084 [P] [US6] Extend the forbidden-key matrix to ≥ 15 spellings (`unitPrice`, `unit-rate`, `Total Bid Value`, `quoted_amount`, `GST Amount`, `₹`, `Rs`, `captchaText`, `otpCode`, `e-Sign`, `aadhaarNo`, `DSC PIN`, `password`, `finalSubmit`, `placeBid`) in `packages/core/test/assist/allowlist.test.ts` and `apps/api/test/assist.test.ts` SC-002, FR-062, FR-063 (#276)
- [ ] T085 [US6] "Discard unsaved changes?" guard for the assist-values editor (route change + tab close) in `apps/web/src/features/workspace/SubmitStep.tsx` FR-092 (#278)
- [ ] T086 [US6] QA: Playwright E2E for US6 with evidence (screenshots, video, trace) in `qa/evidence/006/US6/` — web: scenarios 1–6 (human steps, payload via API incl. 14 fields/sources and no price-like text, values card copy, edit/save "Values saved" + annexure shows Model, forbidden/unknown/non-text 400s, upload order before/after build); extension (via T003 harness): scenarios 7–12 (connect validation messages, workspace list, Highlight outlines/chips + status text, TP chip single fill, Fill allowed fields with no overwrite, forbidden fields empty, form not submitted, non-GeM tab message) plus 13–15 after T077/T079/T081; screenshots of popup and fixture page before/after; spec `e2e/006-apply-packet-assist/US6-assist-extension.e2e.ts`; `VERDICT.md` FR-061…FR-078, NFR-005, SC-002 (#280)

**Checkpoint**: Human-in-the-loop guarantees verified in a real browser

---

## Phase 9: User Story 7 - Record the submission and the outcome (Priority: P2)

**Goal**: Truthful pipeline after GeM: submitted timestamp and won/lost with L1 for analytics.

**Independent Test**: `POST /submitted {}` → 200 `submitted`; `PATCH {outcome:{result:"won", l1Price:2950000}}` → 200 `won`.

### Built

- [x] T087 [US7] `POST /workspaces/:id/submitted` (409 for won/lost/dropped, position, activity with note) in `apps/api/src/routes/workspaces.ts` FR-079
- [x] T088 [US7] Outcome via `PATCH` (`outcomeInputSchema`, `at`, stage = result, activity with L1) in `apps/api/src/routes/workspaces.ts`, `packages/core/src/contracts/apply.ts` FR-081, FR-082
- [x] T089 [US7] Submission card: "Done on GeM?", 3-checkbox confirm dialog, "Submitted on GeM", Record result dialog (Won/Lost, L1/Our price with ₹ preview and validation, notes), Bid won/lost card in `apps/web/src/features/workspace/SubmitStep.tsx`; Won/Lost badge in `apps/web/src/features/workspace/WorkspaceHeader.tsx` FR-080, FR-086
- [x] T090 [US7] API test: submission and outcome with L1 in `apps/api/test/workspace.test.ts` FR-079, FR-081

### Remaining

- [ ] T091 [US7] Show open blockers in the confirm dialog ("<n> checklist item(s) were still open: …") and log `openBlockers` in `workspace.submitted` meta in `apps/web/src/features/workspace/SubmitStep.tsx`, `apps/api/src/routes/workspaces.ts`; API test in `apps/api/test/workspace.test.ts` FR-084 (#282)
- [ ] T092 [P] [US7] Port `scrape_ra_schedule` table heuristics from `/home/user/refs/IshanMaheshwari-777_GEM-SCRAPER/scraper.py` into pure `parseAwardResult(html): { l1Price, l1Seller, bidders: {name, rank, price}[] } | null` in `packages/core/src/gem/award.ts` (DOM-free table tokenizer, Indian number parsing); fixture `packages/core/test/fixtures/gem/ra-result.html` trimmed from `ra_page_dump.html`; tests in `packages/core/test/gem/award.test.ts` FR-085 (#284)
- [ ] T093 [US7] "Suggest from GeM result" file picker in the Record result dialog (client-side parse, prefill L1 price + seller note, "No price table found in this page." when null) in `apps/web/src/features/workspace/SubmitStep.tsx` FR-085 (#285)
- [ ] T094 [P] [US7] API test: after recording an outcome with prices, `GET /assist/:id` contains neither price nor any outcome field in `apps/api/test/assist.test.ts` FR-083, NFR-005 (#286)
- [ ] T095 [US7] QA: Playwright E2E for US7 with evidence (screenshots, video, trace) in `qa/evidence/006/US7/` — scenarios 1–10: Done on GeM card, dialog with 3 checkboxes (confirm disabled until all ticked), Mark as submitted toast + card + Submit step check + activity, 409s for won/lost/dropped via API, Record result dialog validation ("Enter a number", ₹ preview), Won with L1 29,50,000 → card + header badge + activity sentence, Lost toast "Result recorded", stage-only Won stores minimal outcome, negative price 400, open-blockers notice (after T091), GeM result suggestion with the fixture HTML (after T093); desktop + `@mobile` + axe; spec `e2e/006-apply-packet-assist/US7-submission-outcome.e2e.ts`; `VERDICT.md` FR-079…FR-086 (#287)

**Checkpoint**: All Apply stories independently verified

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T096 [P] Update the Apply section of `specs/001-gem-tender-copilot/contracts/api.md` with the new errors/endpoints (`invalid_transition`, `nothing_to_override`, `unknown_placeholder`, `packet_too_large`, `DELETE …/comments/:commentId`, token `scope`) FR-008, FR-027, FR-033, FR-041, FR-056, FR-074 (#288)
- [ ] T097 [P] dnd-kit screen-reader announcements for packet reordering ("Picked up <title>. Position 3 of 8." …) in `apps/web/src/features/workspace/PacketStep.tsx` NFR-006 (#289)
- [ ] T098 Cairn review of the 006 changes (spec ↔ code traceability, Constitution I checklist) and QA summary `qa/evidence/006/SUMMARY.md` linking the seven `VERDICT.md` files SC-006 (#290)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T002/T003 before any QA task; T004 before merging T063/T092.
- **Foundational (Phase 2)**: built; T010 independent.
- **User stories (Phases 3–9)**: independent of each other; within a story, core → API → web → QA.
- **Polish (Phase 10)**: after the stories it documents.

### Within Each User Story

- Core unit tests with the core change (T019, T036, T046, T064, T092) before route wiring.
- API tests with the route change; web after the API contract is merged.
- The QA task runs last and records gaps still open as "known gap" in its `VERDICT.md`.

### Parallel Opportunities

- T002, T003, T004, T010 in parallel.
- Across stories: US1 (T019–T022), US3 (T035–T039), US4 (T046–T050), US5 (T058–T065), US6 (T077–T085), US7 (T091–T094) touch mostly different files; coordinate edits to `apps/api/src/routes/workspaces.ts` (T020, T035, T037, T038, T091) and `apps/api/src/services/packet.ts` (T021, T058, T060, T061, T063).

## Implementation Strategy

1. Setup (T002–T004) → QA for the built P1 stories (T023, T030, T051, T066) to lock current behaviour with evidence.
2. Safety hardening first: US6 T077, T078, T079, T084 (Constitution I).
3. Correctness gaps: T020, T021, T035, T047, T058, T060, T061.
4. UX gaps and P3 extras: T022, T039, T048–T050, T059, T081–T083, T085, T091–T093.
5. Remaining QA (T040, T086, T095) and polish (T096–T098).
