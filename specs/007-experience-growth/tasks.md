---

description: "Task list for 007 Experience & Growth — dashboard, pipeline, onboarding, landing & demo"
---

# Tasks: Experience & Growth — Dashboard, Pipeline, Onboarding, Landing & Demo

**Input**: Design documents from `/specs/007-experience-growth/`

**Prerequisites**: plan.md (required), spec.md (required for user stories); contracts/data model of the built parts live in
`specs/001-gem-tender-copilot/{contracts/api.md,data-model.md}`

**Tests**: Requested. API changes get integration tests on real Postgres (`apps/api/test/{dashboard,demo,workspace,foundation}.test.ts`);
pure web logic gets Vitest unit tests next to the feature; every user story gets a Playwright E2E with evidence
(screenshots, video, trace) in `qa/evidence/007/US<n>/` plus a QA `VERDICT.md`. Review is done with the cairn review
workflow (ai-sdlc conventions in `CONVENTIONS.md` for review/QA only).

**Organization**: Tasks are grouped by user story. `- [x]` = already implemented and verified by reading the code on
2026-11-05 (delivered as 001 tasks T070–T076); `- [ ]` = remaining work (gaps, hardening, missing tests, QA). Each open
task is sized at ≤ 1 day.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1…US7)
- File paths are repo-relative to `/home/user/GEMs`

## Path Conventions

- Contracts: `packages/core/src/contracts/{experience,apply,auth,plans}.ts`
- Schema/migrations/demo: `packages/db/src/{schema,demo}.ts`, `packages/db/migrations/`
- API: `apps/api/src/routes/{dashboard,demo,org,workspaces}.ts`, tests `apps/api/test/*.test.ts`
- Web: `apps/web/src/features/{dashboard,pipeline,onboarding,landing,auth}/`, shell `apps/web/src/components/layout/`
- E2E: `e2e/007-experience-growth/US<n>-*.e2e.ts`, evidence `qa/evidence/007/US<n>/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: E2E scaffolding, accessibility tooling, attribution, docs

- [x] T001 [P] Playwright harness with real API + SPA on :8788, mock-gem on :4011, desktop 1440×900 and Pixel 7 `@mobile` projects, IST/en-IN, video/trace/screenshot on, helpers `signupViaApi`, `seedDemo`, `evidence`, `collectRunArtifacts` in `playwright.config.ts`, `e2e/support/fixtures.ts`, `e2e/support/start-api.sh` NFR-007
- [x] T002 [P] E2E scaffold for this spec: create `e2e/007-experience-growth/` and add helpers `evidence007(page, story, name)` (writes `qa/evidence/007/<story>/`), `inviteAs(request, role)` (returns a logged-in context for bid_manager/analyst/viewer), `atPhone(page)` (375×812), `noHorizontalOverflow(page)` (asserts `scrollWidth ≤ innerWidth`) and `seedDemoAndGetWorkspaces(request)` in `e2e/support/fixtures.ts` NFR-007, FR-094 (#299)
- [x] T003 [P] Add `@axe-core/playwright` (exact version) to root `package.json` devDependencies and an `a11y(page, name)` helper in `e2e/support/fixtures.ts` running tags `wcag2a, wcag2aa, wcag21a, wcag21aa`, failing on serious/critical and saving JSON next to the evidence FR-094, NFR-004 (#300)
- [x] T004 [P] Create or append root `NOTICE` with the attribution for `arush15june/gem-search` (MIT, © arush15june) covering the bid-result parser ported to `packages/core/src/gem/award.ts` NFR-009 (#301)
- [x] T005 [P] Document the new/changed contracts (`myWork`, `awaitingDecision`, `DELETE /demo`, onboarding key whitelist, `bid_workspaces_org_stage_idx`) in `specs/001-gem-tender-copilot/contracts/api.md` § Dashboard & demo and `specs/001-gem-tender-copilot/data-model.md` FR-048, FR-065, FR-070 (#302)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Contracts, schema and shell every story relies on

- [x] T006 Experience contracts `DashboardResponse`, `DashboardTiles`, `DashboardTenderRef`, `DashboardMatch`, `DashboardExpiringDoc`, `DashboardActivity`, `SetupStep`, `DemoSeedResponse` in `packages/core/src/contracts/experience.ts` FR-002, FR-003, FR-060
- [x] T007 [P] Stage model `STAGES`, `STAGE_LABELS`, `PIPELINE_STAGES` (8 board columns, Dropped excluded), strict `workspaceUpdateSchema`, `WorkspaceCard`, `WorkspaceListResponse` in `packages/core/src/contracts/apply.ts` FR-020, FR-021, FR-023
- [x] T008 [P] Schema: `organizations.onboarding_state` (jsonb default `{}`), `organizations.plan` (default `trial`), `bid_workspaces` (stage, real `position`, owner, assignees, due, outcome, submitted_at; unique org+tender), `activity_log` idx `(org_id, created_at)`, `tender_matches` idx `(org_id, created_at)` in `packages/db/src/schema.ts` FR-023, FR-047
- [x] T009 [P] App shell: desktop sidebar (collapsible), mobile bottom tab bar Home/Tenders/Pipeline/Vault/More with safe-area padding, "Skip to content", focus to `#main` on navigation, command palette, org switcher in `apps/web/src/components/layout/{AppShell,nav,CommandPalette}.tsx` FR-091
- [x] T010 [P] Theme before first paint from `localStorage["tp-theme"]` in `apps/web/index.html` and `apps/web/src/lib/theme.tsx`; `RouteErrorBoundary` (chunk error → "A new version of TenderPilot is available", other → "This page hit a snag"), 404 page in `apps/web/src/components/layout/RouteErrorBoundary.tsx`, `apps/web/src/app/NotFoundPage.tsx`, lazy routes + splash in `apps/web/src/app/router.tsx` FR-090, FR-092
- [x] T011 [P] UI state primitives `EmptyState`, `ErrorState` (role=alert, "Try again"), `Skeleton`, `StatTile` (loading, delta, link), `Countdown`, `ScoreRing`, `StageBadge` in `apps/web/src/components/ui/` FR-010, FR-027
- [x] T012 Add index `bid_workspaces_org_stage_idx` on `bid_workspaces(org_id, stage)` in `packages/db/src/schema.ts` and generate the migration in `packages/db/migrations/` (drizzle-kit) NFR-001 (#303)
- [x] T013 [P] Add `ONBOARDING_KEYS` (`company, categories, watchlist, documents, skipped, completed, demo`) and `OnboardingKey`, `MyWorkItem`, `DecisionItem`, `DemoRemoveResponse` types in `packages/core/src/contracts/experience.ts`; extend `DashboardResponse` with optional `myWork`/`awaitingDecision` FR-048, FR-065, FR-070 (#304)

**Checkpoint**: Foundation ready — user stories can proceed in parallel

---

## Phase 3: User Story 1 - Owner's morning dashboard (Priority: P1) 🎯 MVP

**Goal**: One-call, org-scoped dashboard with KPI tiles, closing soon, trend, verdicts, funnel, expiring docs, matches and activity, usable on a phone.

**Independent Test**: Demo org → `/dashboard`: Active bids 13, Win rate 67% ("2 won · 1 lost"), Docs expiring 3 ("1 expired"); each tile deep-links correctly.

### Tests for User Story 1

- [x] T014 [P] [US1] API tests: `istMidnight`, 401 without session, well-formed empty org, demo aggregates (pipeline counts, activeBids 13, winRate 67, emdAtStake = SQL sum, expiringDocs 3/expired 1, closingSoon sorted ≤ 8, recentMatches 6, activity ≤ 15, setupComplete), card move updates counts + activity, dismissed matches drop out, tenant isolation in `apps/api/test/dashboard.test.ts` FR-001…FR-007, NFR-005
- [x] T015 [P] [US1] API tests for boundaries: a match created at 00:10 IST counts as today and one at 23:50 IST the previous day as yesterday; tenders with `endAt = null` never appear in `closingSoon`; 8 expiring documents → tile `expiringDocs = 8` but `expiringDocuments.length = 6`; lost-only org → `winRate = 0`, no results → `null` in `apps/api/test/dashboard.test.ts` FR-002, FR-004, FR-005 (#305)
- [x] T016 [P] [US1] Extract `greeting`, `pctDelta`, `summaryLine` and `isEmptyOrg` from `apps/web/src/features/dashboard/DashboardPage.tsx` into `apps/web/src/features/dashboard/summary.ts` and unit-test them (IST hour boundaries 04:59/05:00/11:59/12:00/16:59/17:00, delta when yesterday = 0, summary variants) plus `describeActivity`/`SELF_CONTAINED` for every action in `apps/web/src/features/dashboard/{summary,activity}.test.ts` FR-006, FR-008 (#306)
- [x] T017 [US1] Performance test: seed 10,000 tenders, 2,000 matches, 200 workspaces, 500 activity rows for one org and assert `GET /api/dashboard` p95 < 500 ms over 20 runs (skipped unless `PERF=1`) in `apps/api/test/perf/dashboard.perf.test.ts` NFR-001 (#307)

### Implementation for User Story 1

- [x] T018 [US1] `GET /dashboard` with one `Promise.all` of org-scoped aggregates (IST today/yesterday/14-day trend, pipeline by stage with value & EMD, latest verdicts, closing counts & rows, recent matches, expiring docs, activity, profile, setup counts, open tenders), `tenderRefs()` and `enrichActivity()` in `apps/api/src/routes/dashboard.ts` FR-001…FR-007
- [x] T019 [US1] Dashboard page: IST date + greeting, summary line, "Demo data" badge, "Pipeline"/"Review matches", six KPI tiles with deep links/hints/deltas and EMD tooltip, Closing soon (workspace or tender link, countdown, stage/verdict, EMD), setup card vs Go/No-Go swap, trend, expiring docs, funnel, latest matches, team activity, skeletons, empty states, error state with retry, 120 s refetch, one-time onboarding redirect in `apps/web/src/features/dashboard/{DashboardPage.tsx,api.ts}` FR-008…FR-011, FR-013
- [x] T020 [P] [US1] Charts with design tokens and text alternatives (`role="img"` + totals): `MatchesTrend`, `VerdictDonut`, `PipelineFunnel` in `apps/web/src/features/dashboard/charts.tsx` FR-093
- [x] T021 [P] [US1] Plain-English activity sentences and self-contained actions in `apps/web/src/features/dashboard/activity.ts` FR-006
- [x] T022 [US1] Stale-data banner: when `useDashboard()` has data and `isError` (background refresh failed), keep widgets and render "Couldn’t refresh — showing data from HH:MM IST" (from `generatedAt`) with "Retry"; reserve the full `ErrorState` for no-data errors, in `apps/web/src/features/dashboard/DashboardPage.tsx` and new `apps/web/src/features/dashboard/StaleBanner.tsx` FR-012 (#308)
- [x] T023 [US1] Expiring-document rows link to `/vault?status=expiring` (consistent with the tile) and the "Closing this week" count clarifies "matched or in your pipeline" in the tile tooltip, in `apps/web/src/features/dashboard/DashboardPage.tsx` FR-009 (#309)
- [x] T024 [US1] QA: Playwright E2E for US1 with evidence (screenshots, video, trace) in `qa/evidence/007/US1/` — `e2e/007-experience-growth/US1-dashboard.e2e.ts` covering scenarios US1-1…US1-15 (API checks via `page.request`, 500/503/slow routes via `page.route`, desktop + `@mobile` 375 px first-viewport check SC-008) and `qa/evidence/007/US1/VERDICT.md` FR-001…FR-013, SC-002, SC-008 (#310)

**Checkpoint**: User Story 1 fully functional and verified

---

## Phase 4: User Story 2 - Run bids on the pipeline Kanban (Priority: P1)

**Goal**: Accessible Kanban with persistent moves, "Ready" guard, filters, table view, mobile layout and non-drag alternatives.

**Independent Test**: Demo org → drag Identified → Analysing ("Moved to Analysing", counts 2/3 after reload, activity entry); drag blocked Preparing → Ready snaps back with the blocker toast.

### Tests for User Story 2

- [x] T025 [P] [US2] API tests: ready blocked while a mandatory document is expired (409), other moves logged with actor, Bid Manager override unblocks, unknown fields/stages rejected, Kanban cards with tender summary/score/owner/readiness, submitted + outcome with L1 price, isolation in `apps/api/test/workspace.test.ts` FR-020, FR-023, FR-024
- [x] T026 [P] [US2] Unit tests for `positionAt` (empty, top, middle, bottom) and `matchesClosing` windows in `apps/web/src/features/pipeline/position.test.ts` FR-023, FR-025
- [x] T027 [P] [US2] Missing API tests: Viewer `PATCH /workspaces/:id` → 403; foreign-org id → 404; `GET /workspaces?stage=archived` → 400 with `details.fields.stage`; `?stage=won,lost` → total 3 on the demo org; `?mine=1` returns only owner/assignee cards; move to Ready without analysis → 409 `reason: not_analysed`; move to Won without outcome sets `outcome.result = "won"` and `submittedAt` set on first Submitted in `apps/api/test/workspace.test.ts` FR-020, FR-023, FR-024 (#311)

### Implementation for User Story 2

- [x] T028 [US2] `GET /workspaces` (stage/mine/q, byStage) and `PATCH /workspaces/:id` (member-only owner/assignees, position, stage with Ready guard 409 `not_analysed`/`not_ready` + blockers, submittedAt/outcome defaults, `workspace.stage_changed` activity, notifications on assignment) in `apps/api/src/routes/workspaces.ts` FR-020, FR-023, FR-024
- [x] T029 [US2] Pipeline page: 8 columns with hints/counts/EMD, dnd-kit pointer/touch/keyboard sensors with announcements, optimistic moves with snapshot revert, 409 blocker toast with "Open workspace", success toasts, view-only mode, search/owner/closing filters with URL params and "Clear filters", count + EMD summary, Board/Table toggle persisted in `localStorage`, `?stage=` focus, mobile "Jump to stage" chips and snap columns, skeleton/empty/error states in `apps/web/src/features/pipeline/{PipelinePage.tsx,api.ts,position.ts}` FR-021, FR-022, FR-024…FR-028
- [x] T030 [US2] "Move to…" menu on every card (analyst+; Radix dropdown from `apps/web/src/components/ui/menu.tsx`, listing all other stages incl. Dropped) sharing the move mutation, toasts and error handling with drag-and-drop, in new `apps/web/src/features/pipeline/MoveToMenu.tsx` and `apps/web/src/features/pipeline/PipelinePage.tsx` FR-029, NFR-004 (#312)
- [x] T031 [US2] "Record the result" dialog after a successful move to Won/Lost (L1 price ₹, our price ₹, notes ≤ 2000; Save → `PATCH { outcome }`, Skip) in new `apps/web/src/features/pipeline/OutcomeDialog.tsx`, wired from `apps/web/src/features/pipeline/PipelinePage.tsx` and `apps/web/src/features/pipeline/api.ts` FR-030 (#313)
- [x] T032 [P] [US2] Port `get_bid_result()` from `refs/arush15june_gem-search/gem.py` to `parseBidResult(html)` returning `{ categories, bidders: [{rank, company, price, level}] , l1Price }` in new `packages/core/src/gem/award.ts` with a saved HTML fixture and tests in `packages/core/test/gem/award.test.ts` FR-030, NFR-009 (#314)
- [x] T033 [US2] Optional L1 hint (P3): `GET /api/tenders/:id/result-hint` (analyst+, org must have a workspace for the tender, else 404) fetching the public result page through the existing rate-limited GeM adapter and `parseBidResult`, a matching mock route in `tools/mock-gem/`, API test in `apps/api/test/workspace.test.ts`, and "Use L1 from GeM: ₹x" prefill link in `apps/web/src/features/pipeline/OutcomeDialog.tsx` FR-030 (#315)
- [x] T034 [US2] "Show dropped (N)" toggle (persisted in `localStorage["tp:pipeline-dropped"]`) adding a Dropped column, and a confirmation "Drop this bid? It leaves the active pipeline but keeps its history." for moves to Dropped, in `apps/web/src/features/pipeline/PipelinePage.tsx` FR-031 (#316)
- [x] T035 [P] [US2] Debounce search (300 ms) and sync it to `?q=` (read on load, replace on change, cleared by "Clear filters"); fix the view-only copy to "You have view-only access. Ask an Analyst, Bid Manager or Owner to move bids between stages." in `apps/web/src/features/pipeline/PipelinePage.tsx` FR-032 (#317)
- [x] T036 [US2] Renumber positions (1, 2, 3, … by current order) in one transaction when the requested position collides or neighbours differ by < 1e-9, with an API test inserting 60 cards between the same pair, in `apps/api/src/routes/workspaces.ts` and `apps/api/test/workspace.test.ts` FR-033 (#318)
- [x] T037 [US2] QA: Playwright E2E for US2 with evidence (screenshots, video, trace) in `qa/evidence/007/US2/` — `e2e/007-experience-growth/US2-pipeline.e2e.ts` covering US2-1…US2-19 (keyboard drag for determinism, one pointer drag smoke, 409 blocker toast, Viewer read-only, table view persistence, `@mobile` 375 px chips and no page overflow) and `qa/evidence/007/US2/VERDICT.md` FR-020…FR-033 (#319)

**Checkpoint**: User Stories 1 and 2 work independently

---

## Phase 5: User Story 3 - Guided onboarding to a matched feed in under 5 minutes (Priority: P1)

**Goal**: Five-step, resumable wizard that saves as it goes and leaves a setup checklist for skipped steps.

**Independent Test**: Sign up → complete steps with Aarav / `27AAJCA4721K1ZK` / Desktop computers + CCTV → create watchlist → skip docs → "Go to my feed" shows matched mock-gem bids; < 90 s.

### Tests for User Story 3

- [x] T038 [P] [US3] API tests for `PATCH /org` onboarding state: merges keys (existing keys kept), Analyst/Viewer → 403, onboarding ticks do not write `org.updated` activity; after T040: unknown key and > 16 keys → 400 `details.fields.onboardingState` in `apps/api/test/foundation.test.ts` FR-047, FR-048 (#320)
- [x] T039 [P] [US3] Extract `POPULAR_CATEGORIES`, `keywordsFor` and `initialStep(state)` from `apps/web/src/features/onboarding/OnboardingPage.tsx` into `apps/web/src/features/onboarding/steps.ts` and unit-test them (dedupe, 30-keyword cap, custom categories lower-cased, resume at first unticked step, all ticked → Done) in `apps/web/src/features/onboarding/steps.test.ts` FR-043, FR-046 (#321)

### Implementation for User Story 3

- [x] T040 [US3] Onboarding wizard: Shell with stepper, "Skip for now", theme toggle; Company basics (name required, GSTIN live validation with derived state/PAN, home state, MSE/Startup/MII toggles, `PUT /profile`); What you sell (16 chips `aria-pressed`, custom categories, states, HSN 4/6/8); First watchlist (prefilled name/keywords, 400 ms debounced live preview with 3 samples, `POST /watchlists`); Key documents (GST/PAN/Udyam cards, 20 MB check, `POST /vault`); Done (confetti respecting reduced motion, "Go to my feed", "Explore with demo data"); resume at first unfinished step; "You’re all set" for analyst/viewer, in `apps/web/src/features/onboarding/OnboardingPage.tsx` FR-040…FR-047
- [x] T041 [US3] `PATCH /org` (bid_manager+) merging `onboardingState` and skipping activity for ticks; sign-up navigates to `/onboarding` in `apps/api/src/routes/org.ts`, `apps/web/src/features/auth/SignupPage.tsx` FR-040, FR-047
- [x] T042 [US3] Setup checklist (6 steps with done rules and links) returned by the dashboard API and rendered as "Finish setting up" with progress, "k/6", highlighted next step and "Open the guided setup" in `apps/api/src/routes/dashboard.ts`, `apps/web/src/features/dashboard/DashboardPage.tsx` FR-007, FR-046
- [x] T043 [US3] Whitelist onboarding keys: `onboardingState: z.record(z.string(), z.boolean()).superRefine(...)` (key whitelist + max 16 keys) in `packages/core/src/contracts/auth.ts` (`updateOrgInputSchema`) FR-048 (#322)
- [x] T044 [US3] Do not create a second watchlist on resume: initialise `watchlistDone` from `me.org.onboardingState.watchlist` and show "Continue" in `apps/web/src/features/onboarding/OnboardingPage.tsx` FR-049 (#323)
- [x] T045 [US3] Tick resilience: `tick()` retries once after 1 s and then shows the toast "Couldn’t save your progress — your data is saved, but setup may restart at this step" without blocking navigation, in `apps/web/src/features/onboarding/OnboardingPage.tsx` FR-050 (#324)
- [x] T046 [US3] Pre-mark key-document cards already in the vault (query `GET /vault?type=gst|pan|udyam` via `apps/web/src/features/vault/api.ts`) showing the vault title and counting them in "N uploaded", in `apps/web/src/features/onboarding/OnboardingPage.tsx` FR-051 (#325)
- [x] T047 [US3] Log `onboarding.completed` with `meta.durationSec = now − organizations.created_at` when `completed` flips from false/absent to true in `PATCH /org` (`apps/api/src/routes/org.ts`), add the sentence "finished setting up TenderPilot" to `apps/web/src/features/dashboard/activity.ts`, and an API test in `apps/api/test/foundation.test.ts` FR-052, SC-001 (#326)
- [x] T048 [US3] QA: Playwright E2E for US3 with evidence (screenshots, video, trace) in `qa/evidence/007/US3/` — `e2e/007-experience-growth/US3-guided-onboarding.e2e.ts` covering US3-1…US3-17 (UI sign-up, each step's validation and save, live preview, 21 MB rejection with a generated buffer, resume after reload, skip → checklist, Analyst "You’re all set", timed run < 90 s, `@mobile` 375 px sticky footer) and `qa/evidence/007/US3/VERDICT.md` FR-040…FR-052, SC-001 (#327)

**Checkpoint**: User Stories 1–3 work independently

---

## Phase 6: User Story 4 - Explore with demo data, then remove it (Priority: P2)

**Goal**: Idempotent, tenant-safe demo seed with a one-click, safe removal.

**Independent Test**: Fresh org → "Explore with demo data" → badge, 16 cards, 15 docs; create a real watchlist; "Remove demo data" → 0 workspaces, 0 docs, 1 watchlist.

### Tests for User Story 4

- [x] T049 [P] [US4] API tests: roles (401/403/403), first seed 201 with counts (40/3/16/20/5/15, matches > 15), `onboardingState.demo`, profile values, every stage except dropped, relative dates and bid-number format, idempotent 200 `created:false`, real one-page PDFs, blocked Preparing → 409, isolation and non-overwritten profile, library use without blobs in `apps/api/test/demo.test.ts` FR-060…FR-063
- [x] T050 [US4] API tests for removal (write first): org with demo + user watchlist "My laptops" + uploaded "Real GST.pdf" + a user-created workspace on a non-demo tender → `DELETE /api/demo` 200 with counts, only demo rows gone (incl. blobs via a spy blob store), user rows intact, `onboardingState.demo = false`, `demo.removed` logged, second call all zeros, Viewer/Analyst 403, other org untouched, demo-filled profile reset vs edited profile kept, in `apps/api/test/demo.test.ts` FR-065, SC-007 (#328)

### Implementation for User Story 4

- [x] T051 [US4] `seedDemo()` dataset (Aarav Technologies profile if empty, 5 past contracts, 15 vault docs with generated PDFs incl. ISO +10 d / CA +25 d / Dell OEM −5 d, 3 watchlists, 40 tenders `raw.demo` upserted by bid number with dates relative to now, matches, 20 analyses, 16 workspaces across 8 stages, comments, in-app notifications, activity with `meta.demo`, `demo.seeded`), `demoPdf()`, `DEMO_COMPANY`, `DEMO_WATCHLISTS` in `packages/db/src/demo.ts`; `pnpm db:seed` in `packages/db/src/seed.ts` FR-060…FR-063
- [x] T052 [US4] `POST /demo/seed` (bid_manager+, 201/200, sets `onboardingState.demo`) in `apps/api/src/routes/demo.ts`; `useSeedDemo()` invalidating all queries and the entry points on the empty dashboard banner and onboarding Done step in `apps/web/src/features/dashboard/{api.ts,DashboardPage.tsx}`, `apps/web/src/features/onboarding/OnboardingPage.tsx` FR-060, FR-064
- [x] T053 [US4] `removeDemo(db, { orgId, blobs })` in `packages/db/src/demo.ts`: identify demo rows by provenance (tenders with `raw.demo` → org workspaces/analyses/matches/comments/packets; demo watchlist names + creator; vault docs and past contracts by seeded titles / `demo/` blob prefix; notifications `dedupe_key LIKE 'demo:%'`; activity `meta.demo`), delete in one transaction, delete blobs after commit, reset a still-demo profile, return counts; record the provenance-vs-column decision in a code comment FR-065 (#329)
- [x] T054 [US4] `DELETE /demo` (bid_manager+) calling `removeDemo`, setting `onboardingState.demo = false`, logging `demo.removed`, returning `DemoRemoveResponse` in `apps/api/src/routes/demo.ts`; `useRemoveDemo()` in `apps/web/src/features/dashboard/api.ts` FR-065 (#330)
- [x] T055 [US4] Demo banner on the dashboard when `demo` ("You’re exploring sample data for Aarav Technologies Pvt Ltd." + "Remove demo data" for bid_manager+, confirmation dialog "Remove all demo data? Your own watchlists, documents and bids stay.", toast "Demo data removed") in new `apps/web/src/features/dashboard/DemoBanner.tsx` and `apps/web/src/features/dashboard/DashboardPage.tsx` FR-066 (#331)
- [x] T056 [P] [US4] "Sample" badge for demo tenders: expose `isDemo` (from `raw.demo`) on tender DTOs in `packages/core/src/contracts/identify.ts` and `apps/api/src/routes/tenders.ts`, render it in `apps/web/src/features/feed/{TenderCard,TenderTable}.tsx` and `apps/web/src/features/tender/TenderPage.tsx` FR-067 (#332)
- [x] T057 [US4] QA: Playwright E2E for US4 with evidence (screenshots, video, trace) in `qa/evidence/007/US4/` — `e2e/007-experience-growth/US4-demo.e2e.ts` covering US4-1…US4-14 (seed from the dashboard banner, badge without reload, PDF download header, second seed 200, Sample badge, removal keeps user rows, Viewer has no buttons) and `qa/evidence/007/US4/VERDICT.md` FR-060…FR-067, SC-007 (#333)

**Checkpoint**: Demo lifecycle complete

---

## Phase 7: User Story 5 - Persona-aware dashboard widgets (Priority: P2)

**Goal**: "My bids" for Analysts/Bid Managers, "Awaiting your decision" with one-tap Go/Drop for Owners/Bid Managers, no 403-bound CTAs.

**Independent Test**: Assign two workspaces to an Analyst → their "My bids" lists both by due date; Owner taps "Go" on an awaiting-decision row → card moves to Go.

### Tests for User Story 5

- [x] T058 [P] [US5] API tests: `myWork` (owner or assignee, active stages only, `dueAt` nulls last then `endAt`, ≤ 5, readiness fields) and `awaitingDecision` (stage `analysing` with a done analysis, oldest first, ≤ 5), both empty for another org's members, in `apps/api/test/dashboard.test.ts` FR-070, NFR-005 (#334)

### Implementation for User Story 5

- [x] T059 [US5] Add the `myWork` and `awaitingDecision` queries to the dashboard `Promise.all` (join `bid_workspaces` → `tenders`, latest done analysis, readiness via the existing readiness helper or the `WorkspaceCard` builder) in `apps/api/src/routes/dashboard.ts` FR-070 (#335)
- [x] T060 [P] [US5] "My bids" card (stage badge, "Due <date>" red when overdue, readiness bar, empty text "Nothing assigned to you — bids you own or are assigned to will appear here.") placed after the KPI tiles for analyst/bid_manager and below the first row for owners, hidden for viewers, in new `apps/web/src/features/dashboard/MyBidsCard.tsx` and `apps/web/src/features/dashboard/DashboardPage.tsx` FR-071 (#336)
- [x] T061 [P] [US5] "Awaiting your decision" card (score ring, verdict, closes-in; "Go" and "Drop" with confirmation for bid_manager+, read-only for analysts, hidden for viewers) reusing `useMoveCard()` from `apps/web/src/features/pipeline/api.ts`, in new `apps/web/src/features/dashboard/DecisionsCard.tsx` FR-072 (#337)
- [x] T062 [US5] Role-gated CTAs: hide "Create a watchlist" for viewers (show "Ask an Owner or Bid Manager to set up watchlists."), hide "Finish setting up" for analysts/viewers (show Go / No-Go), in `apps/web/src/features/dashboard/DashboardPage.tsx` FR-073 (#338)
- [x] T063 [US5] QA: Playwright E2E for US5 with evidence (screenshots, video, trace) in `qa/evidence/007/US5/` — `e2e/007-experience-growth/US5-persona-widgets.e2e.ts` logging in as Owner, Bid Manager, Analyst and Viewer (via `inviteAs`) on the demo org, covering US5-1…US5-6 including `@mobile` one-tap Go, and `qa/evidence/007/US5/VERDICT.md` FR-070…FR-073 (#339)

**Checkpoint**: Dashboard adapts per persona

---

## Phase 8: User Story 6 - Marketing landing page & pricing for prospects (Priority: P2)

**Goal**: Accurate, fast, shareable landing page that converts to a trial.

**Independent Test**: Signed-out at 375 px: menu → Pricing → FAQ via keyboard → "Start free trial" → `/signup`; signed-in `/` → `/dashboard`.

### Tests for User Story 6

- [x] T064 [P] [US6] Unit test that renders the pricing section from `PLANS` (₹2,999, ₹7,999, Custom; GST note) and a copy guard that fails if landing text matches `/auto-?submit(s|ting)? (your )?bids|we submit|enter(s)? (your )?price/i` outside the "never" sentences, in `apps/web/src/features/landing/landing.test.tsx` FR-082, FR-083, FR-086 (#340)

### Implementation for User Story 6

- [x] T065 [US6] Landing page: sticky nav + mobile menu (`aria-expanded`), hero with product mock and CTAs, Built for, How it works, Compliance promise, Metrics, Persona tabs, Pricing (Starter/Pro/Enterprise, GST note, mailto), FAQ accordion, final CTA, footer, reduced-motion reveals, in `apps/web/src/features/landing/LandingPage.tsx` FR-081…FR-083
- [x] T066 [US6] Public-only routes `/`, `/login`, `/signup` redirecting signed-in users via `safeNext()` in `apps/web/src/app/router.tsx`, `apps/web/src/lib/auth.tsx` FR-080
- [x] T067 [P] [US6] Plans config `PLANS` (key, name, monthly INR price or null, blurb, features, cta, featured) in new `packages/core/src/contracts/plans.ts`; render Pricing from it in `apps/web/src/features/landing/LandingPage.tsx` FR-086 (#341)
- [x] T068 [P] [US6] SEO & social: canonical, `og:*` (title, description, image `/og.png` 1200×630, `og:locale en_IN`, url), `twitter:card summary_large_image`, JSON-LD `SoftwareApplication` with INR offers in `apps/web/index.html`; add `apps/web/public/og.png`; stop the double title suffix by letting `useDocumentTitle` accept a full title (`{ raw: true }`) in `apps/web/src/lib/hooks.ts` and `apps/web/src/features/landing/LandingPage.tsx` FR-084 (#342)
- [x] T069 [P] [US6] `apps/web/public/robots.txt` (allow `/`, disallow app routes and `/api/`) and `apps/web/public/sitemap.xml` (`/`, `/signup`, `/login`); verify both are served by the Worker static assets and Node server FR-087 (#343)
- [x] T070 [US6] Plan CTAs link to `/signup?plan=starter|pro`; `SignupPage` shows "You’re starting a 14-day free trial of Pro — no card needed." for known plans and ignores unknown values, in `apps/web/src/features/landing/LandingPage.tsx`, `apps/web/src/features/auth/SignupPage.tsx` FR-085 (#344)
- [x] T071 [US6] Lighthouse check for `/` (mobile emulation, 3 runs, median) with thresholds Perf ≥ 85, A11y ≥ 95, BP ≥ 90, SEO ≥ 90 and median LCP < 2.5 s, CLS < 0.1, writing the report to `qa/evidence/007/US6/lighthouse/` via new `scripts/lighthouse-landing.mjs` (uses `lighthouse` dev dependency, exact version) NFR-003, SC-006 (#345)
- [x] T072 [US6] QA: Playwright E2E for US6 with evidence (screenshots, video, trace) in `qa/evidence/007/US6/` — `e2e/007-experience-growth/US6-landing.e2e.ts` covering US6-1…US6-12 (signed-out/signed-in redirects incl. `?next=//evil.com`, anchors, `@mobile` menu, pricing texts, keyboard FAQ/tabs, reduced motion via `page.emulateMedia`, head meta, robots/sitemap, `?plan=`) and `qa/evidence/007/US6/VERDICT.md` FR-080…FR-087 (#346)

**Checkpoint**: Landing ready for launch traffic

---

## Phase 9: User Story 7 - Responsive, accessible pages with honest states everywhere (Priority: P2)

**Goal**: Automated proof that every core page is responsive and accessible, plus PWA install and offline handling.

**Independent Test**: 11 pages × {375, 1440} × {light, dark}: 0 serious/critical axe violations and no horizontal overflow.

### Tests for User Story 7

- [x] T073 [US7] Accessibility & responsiveness sweep: for landing, login, signup, onboarding, dashboard, tenders, pipeline, vault, profile, settings, notifications at 375×812 and 1440×900 in light and dark, run `a11y()` and `noHorizontalOverflow()`, and check 24×24 px minimum targets for buttons/links (44×44 in the tab bar), in `e2e/007-experience-growth/US7-a11y-responsive.e2e.ts` FR-094, NFR-004, SC-003, SC-004 (#347)

### Implementation for User Story 7

- [x] T074 [US7] Built cross-page standards: tab bar/sidebar, skip link, focus management, command palette (T009); theme pre-paint, error boundary, 404, splash (T010); state primitives (T011); reduced motion in onboarding/landing; chart text alternatives (T020) in `apps/web/src/components/layout/`, `apps/web/src/components/ui/`, `apps/web/src/app/` FR-090…FR-093
- [x] T075 [US7] Fix violations found by T073 (time-boxed to 1 day; create follow-up tasks for anything larger), starting with likely hits: drag-handle and chip target sizes in `apps/web/src/features/pipeline/PipelinePage.tsx`, muted-text contrast on tinted cards in `apps/web/src/index.css`, icon-only buttons without names in `apps/web/src/components/layout/AppShell.tsx` NFR-004 (#348)
- [x] T076 [P] [US7] Web app manifest `apps/web/public/manifest.webmanifest` (name/short_name "TenderPilot", `start_url /dashboard`, `display standalone`, theme/background colours, 192/512 and maskable icons in `apps/web/public/icons/`) linked from `apps/web/index.html` with `apple-touch-icon` FR-095 (#349)
- [x] T077 [P] [US7] `useOnline()` hook in `apps/web/src/lib/hooks.ts` and an `OfflineBanner` ("You’re offline — showing the last loaded data", `role="status"`) in `apps/web/src/components/layout/AppShell.tsx`; set TanStack Query `networkMode: 'always'` for mutations (fail fast with an error toast; `'online'` would pause offline mutations), in `apps/web/src/main.tsx` FR-096 (#350)
- [x] T078 [US7] QA: Playwright E2E for US7 with evidence (screenshots, video, trace) in `qa/evidence/007/US7/` — run T073 (`e2e/007-experience-growth/US7-experience-qa.e2e.ts` + `US7-a11y-responsive.e2e.ts`) plus US7-1…US7-11 (tab bar/More sheet, sidebar collapse, skip link + focus, theme persistence without flash, chunk-error and render-error boundaries via `page.route`, 404, chart `role="img"`, manifest fetch, offline via `context.setOffline(true)`), axe JSON in `qa/evidence/007/US7/axe/` and `qa/evidence/007/US7/VERDICT.md` FR-090…FR-096, SC-003, SC-004 (#351)

**Checkpoint**: All user stories independently functional and verified

---

## Phase 10: Polish & Cross-Cutting Concerns

- [x] T079 [P] Update `e2e/README.md` with the 007 helpers (`evidence007`, `inviteAs`, `a11y`, `noHorizontalOverflow`) and mark 001 T081's US6/US7 E2E items as delivered by 007 in `specs/001-gem-tender-copilot/tasks.md` NFR-007 (#352)
- [x] T080 Run `/cairn-analyze` across `specs/007-experience-growth/{spec,plan,tasks}.md` and fix inconsistencies; cairn review of each PR against Constitution I and IV first (ai-sdlc review conventions in `CONVENTIONS.md`), recording findings in the PR NFR-007 (#353)
- [x] T081 QA roll-up: `qa/evidence/007/README.md` linking each story's `VERDICT.md`, video, trace and screenshots, and the SC-001…SC-008 measurements NFR-007 (#354)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T002/T003 block every QA task; T004 blocks T032; T005 can run any time.
- **Foundational (Phase 2)**: T012 blocks T017 and T059; T013 blocks T043, T053–T054, T058–T059.
- **User stories (Phases 3–9)**: independent after Phase 2, except US5 (T061) reuses the pipeline move mutation and US4
  removal (T055) is shown on the dashboard.
- **Polish (Phase 10)**: after the stories it summarises.

### User Story Dependencies

- **US1 (P1)**: none beyond Phase 2.
- **US2 (P1)**: none; T033 depends on T032.
- **US3 (P1)**: T043 depends on T013; T047 depends on T043 (same schema/route).
- **US4 (P2)**: T050 (tests) → T053 → T054 → T055.
- **US5 (P2)**: T058 → T059 → T060/T061 → T062.
- **US6 (P2)**: T067 before T064 and T070.
- **US7 (P2)**: T073 → T075; T076/T077 parallel.

### Within Each User Story

- API tests before the API change; API before UI; UI before the QA E2E task.

### Parallel Opportunities

- T002–T005 in parallel; T012/T013 in parallel.
- After Phase 2: US1 hardening (T015, T016, T022), US2 (T027, T030–T035), US3 (T038, T039, T044–T046) and US6 (T067–T069)
  touch different files and can run in parallel.

---

## Parallel Example: User Story 2

```bash
Task: "T027 Missing API tests in apps/api/test/workspace.test.ts"
Task: "T032 Port parseBidResult to packages/core/src/gem/award.ts"
Task: "T035 Debounce search + URL sync in apps/web/src/features/pipeline/PipelinePage.tsx"
```

---

## Implementation Strategy

### MVP First

The MVP (US1–US3) is built. Close the P1 gaps first: T022 (stale banner), T030 (Move to…), T044 (duplicate watchlist),
T043 (key whitelist), then the P1 QA tasks T024, T037, T048.

### Incremental Delivery

1. P1 hardening + QA (US1–US3) → demo-able, verified core.
2. US4 removal → safe demos for sales.
3. US5 persona widgets → Owner phone experience.
4. US6 growth items → launch-ready landing.
5. US7 sweep → accessibility proof across the app.

### Parallel Team Strategy

- Developer A: US1 + US5 (dashboard files).
- Developer B: US2 (pipeline files, award parser).
- Developer C: US3 + US4 (onboarding, demo).
- Developer D / QA: US6 + US7, then all QA tasks.

---

## Notes

- `[x]` tasks were verified by reading the code on 2026-11-05; they map to 001 tasks T070–T076.
- Do not commit QA evidence videos larger than 20 MB; keep traces in `qa/.runs/` and link them from `VERDICT.md`.
- Every open task names its FR/NFR ids for traceability (Constitution VIII).
