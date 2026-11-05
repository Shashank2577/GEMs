# Tasks: TenderPilot — GeM Tender Co-Pilot

**Input**: `spec.md`, `plan.md`, `data-model.md`, `contracts/api.md`
**Tests**: required (Constitution VI) — unit tests next to core logic, API integration tests against real
Postgres, one Playwright E2E per user story.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Create pnpm monorepo (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`)
- [x] T002 Install dependencies for core, db, api, web, extension, mock-gem
- [x] T003 Drizzle schema `packages/db/src/schema.ts` + first migration + `scripts/local-pg.sh`
- [x] T004 Cairn spec workflow scaffold (`.cairn/workflow`, `.claude/skills/cairn-*`)

## Phase 2: Foundational (Blocking Prerequisites)

### API foundation (owner: `apps/api/src/{app,worker,node,env,deps}.ts`, `middleware/`, `adapters/`, `lib/`, `routes/auth.ts`, `routes/org.ts`, `apps/api/test/helpers.ts`, `wrangler.toml`)

- [x] T010 `createApp(deps)` Hono app with `/api` router, error handler, request id, zod validation helper, `/api/health` (FR-034)
- [x] T011 [P] Adapters: `BlobStore` (FS + R2), `LlmClient` (Anthropic via fetch + null), `Mailer` (Resend + log), `WhatsApp` (Meta Cloud API + log), `Clock` (FR-005, NFR-003)
- [x] T012 Auth: PBKDF2 hashing (WebCrypto), sessions, signup/login/logout/me/switch-org, accept-invite, API tokens (FR-030)
- [x] T013 Org & roles middleware `requireAuth`, `requireRole`, `orgScope`; members, invitations, notification prefs, activity log helper `logActivity()` (FR-031..033)
- [x] T014 Mount empty route modules for every area (tenders, watchlists, ingestion, notifications, analysis, profile, vault, workspaces, packets, assist, dashboard, demo) each exporting a Hono router
- [x] T015 `worker.ts` (fetch + scheduled → services stubs) and `node.ts` (serves API + `apps/web/dist` SPA fallback, FS blob store) + `wrangler.toml`
- [x] T016 Vitest API test harness against `tenderpilot_test` DB: migrate, truncate, `createTestApp()`, `signupAndLogin(role)` helpers; tests for auth & roles

### Web foundation (owner: `apps/web/` config, `src/components/ui/*`, `src/components/layout/*`, `src/lib/*`, `src/app/*`, `src/features/auth/*`)

- [x] T020 Vite + React + Tailwind config, design tokens (CSS variables, light/dark), Inter font, brand
- [x] T021 [P] Design-system components: Button, Input, Textarea, Label, Select, Checkbox, Switch, Badge, Card, Dialog, Sheet, Tabs, DropdownMenu, Popover, Tooltip, Table, Skeleton, EmptyState, ErrorState, PageHeader, StatTile, ScoreRing, VerdictBadge, Progress, Avatar, Kbd, toasts (FR-034)
- [x] T022 AppShell: collapsible sidebar, mobile bottom nav/drawer, top bar with search (⌘K command palette), org switcher, notifications bell slot, theme toggle, user menu
- [x] T023 API client (`fetch` wrapper, typed errors), TanStack Query setup, `useMe()` auth context, protected routes, role helper `can()`
- [x] T024 Auth pages: login, signup, accept invite — polished split-screen with product visuals
- [x] T025 Router with lazy routes for every feature folder (stub pages owned by area agents)

## Phase 3: User Story 1 — Discover & alert (P1) 🎯 MVP

Owner: `packages/core/src/gem/*`, `packages/core/src/match/*`, `packages/core/src/contracts/identify.ts`, `tools/mock-gem/*`, `apps/api/src/routes/{tenders,watchlists,ingestion,notifications}.ts`, `apps/api/src/services/{ingest,alerts}.ts`, `apps/web/src/features/{feed,watchlists,notifications}/*`

- [x] T030 [P] [US1] BidPlus listing parser + normalisers (amounts lakh/crore, IST dates, ministry/dept split, bid type) with recorded fixtures in `packages/core/test/fixtures/gem/` (FR-001)
- [x] T031 [P] [US1] `GemClient` (CSRF bootstrap, paged POST, ≤1 req/s throttle, retry/back-off, configurable base URL) (FR-001, NFR-002)
- [x] T032 [P] [US1] Watchlist matcher with reasons + relevance, unit-tested (FR-004)
- [x] T033 [US1] `tools/mock-gem` server serving `/all-bids`, `/all-bids-data` (paged, search) and `/showbidDocument/:id` (generated PDFs), with a "new bids" switch for E2E
- [x] T034 [US1] `runIngestion()` service: upsert by bid number, content hash, tender events (corrigendum/date change → analysis stale), matching, notifications per prefs (FR-002, FR-004, FR-005)
- [x] T035 [US1] `dispatchNotifications()` email/WhatsApp/digest + delivery status (FR-005)
- [x] T036 [US1] Routes: tenders list/detail/seen/dismiss with facets; watchlists CRUD + preview; ingestion run/runs; notifications (FR-003, FR-006, FR-007)
- [x] T037 [US1] Web: Tender feed (filters rail, saved views, cards/table toggle, closing countdown, match reasons, "new" dots, infinite pagination), Watchlist builder with live preview, notifications popover + page, sync-health indicator
- [x] T038 [US1] API integration tests for ingestion idempotency, matching and filters

## Phase 4: User Story 2 — Analyse & score (P1)

Owner: `packages/core/src/analyse/*`, `packages/core/src/contracts/analyse.ts`, `packages/core/test/fixtures/bids/*`, `apps/api/src/routes/analysis.ts`, `apps/api/src/services/analyse.ts`, `apps/web/src/features/tender/*`

- [x] T040 [P] [US2] Sample GeM bid-document PDF generator (realistic text: turnover, experience, EMD, ePBG, MSE/Startup exemption, MII, documents required, ATC clauses) + fixtures
- [x] T041 [P] [US2] PDF text extraction per page (`unpdf`) with page markers (FR-010)
- [x] T042 [P] [US2] Rule-based requirement extractor with quotes/pages/confidence (FR-011, FR-012)
- [x] T043 [P] [US2] LLM extractor (Claude, JSON output, merges with rules, never overrides with lower confidence) (FR-011)
- [x] T044 [P] [US2] Scoring engine: factors, weights, blockers, MSE/Startup exemptions, verdict, confidence; checklist builder (FR-013..015)
- [x] T045 [US2] Analysis service + routes (upload, fetch from GeM, analyse, override, weights) (FR-016)
- [x] T046 [US2] Web: Tender detail page — hero (bid no., buyer, countdown, EMD, value), score ring + verdict, factor breakdown with evidence quotes & page links, requirement table, document checklist, corrigendum history timeline, documents tab with upload, override dialog, "Start bid" CTA
- [x] T047 [US2] Unit tests for extractor + scorer; API test for analyse flow

## Phase 5: User Story 3 — Profile & vault (P1)

Owner: `packages/core/src/vault/*`, `packages/core/src/contracts/vault.ts`, `apps/api/src/routes/{profile,vault}.ts`, `apps/api/src/services/reminders.ts`, `apps/web/src/features/{profile,vault}/*`

- [x] T050 [P] [US3] Validators: GSTIN (with checksum), PAN, Udyam, CIN, pincode; turnover averaging helpers (FR-020)
- [x] T051 [P] [US3] Document status/expiry classifier, reminder schedule (30/7/1) (FR-021, FR-022)
- [x] T052 [US3] Routes: profile (+completeness), past contracts, vault CRUD/upload/download/summary (FR-020, FR-021)
- [x] T053 [US3] `runExpiryReminders()` service
- [x] T054 [US3] Web: Company profile (sectioned form, inline validation, completeness meter, financial-years editor, MSE/Startup/MII cards, past contracts table), Vault (grid/list, drag-and-drop upload with metadata, type filters, expiry badges & timeline, preview drawer)
- [x] T055 [US3] Tests: validators, status classifier, API vault/profile + viewer refusal

## Phase 6: User Story 4 & 5 — Packet & assisted submission (P2)

Owner: `packages/core/src/packet/*`, `packages/core/src/assist/*`, `packages/core/src/contracts/apply.ts`, `apps/api/src/routes/{workspaces,packets,assist}.ts`, `apps/api/src/services/packet.ts`, `apps/web/src/features/workspace/*`, `apps/extension/*`

- [x] T060 [P] [US4] Checklist → vault auto-mapping (type, FY recency, validity) (FR-023)
- [x] T061 [P] [US4] Annexure templates (non-blacklisting, MII self-cert, MSE declaration, EMD exemption, OEM auth request, technical compliance, authority letter) + renderer to PDF (FR-024)
- [x] T062 [P] [US4] Packet builder: cover + index page, merged docs (PDF and images), bookmarks, size warnings (FR-025)
- [x] T063 [US4] Workspace + packet routes, readiness, stage guard, overrides, comments (FR-028)
- [x] T064 [P] [US5] Assist allow-list + field mapping; price/OTP/captcha/DSC/submit always excluded (FR-026, FR-027)
- [x] T065 [US5] Assist route + MV3 extension (popup: token + workspace picker; content script: highlight & fill allowed fields on click)
- [x] T066 [US4] Web: Bid workspace — stepper (Qualify → Documents → Annexures → Packet → Submit), readiness checklist with auto-matched docs and fix actions, annexure preview/edit, packet builder with drag-to-reorder and download, Submission assistant with copy buttons + human-only steps, comments & activity
- [x] T067 [US4] Tests: mapping, packet builder (page count/order), allow-list, API stage guard

## Phase 7: User Story 6 & 7 — Dashboard, pipeline, team, onboarding (P2/P3)

Owner: `apps/api/src/routes/{dashboard,demo}.ts`, `packages/db/src/demo.ts`, `apps/web/src/features/{dashboard,pipeline,settings,onboarding,landing}/*`

- [x] T070 [US6] Dashboard API aggregates
- [x] T071 [US6] Web: Dashboard (greeting, KPI tiles, closing-soon list, matches trend chart, verdict donut, pipeline funnel, expiring docs, activity feed, setup checklist)
- [x] T072 [US6] Web: Pipeline Kanban with drag-and-drop (dnd-kit), filters, card details
- [x] T073 [US6] Web: Settings — team & roles, invitations, notification prefs (WhatsApp number), API tokens, scoring weights, org
- [x] T074 [US7] Web: Onboarding wizard (company basics → categories & states → first watchlist → key documents) + demo data option
- [x] T075 [US7] Demo seed (`packages/db/src/demo.ts`, `POST /api/demo/seed`, `pnpm db:seed`)
- [x] T076 [P] Marketing landing page at `/` for signed-out visitors (hero, how-it-works Identify/Analyse/Apply, compliance promise, pricing tiers, FAQ)

## Phase 8: Integration, E2E & Polish

- [ ] T080 Playwright config + global setup (local Postgres, migrate, mock-gem, Node server serving built SPA)
- [ ] T081 [P] E2E US1 discover & alert; [P] US2 analyse; [P] US3 vault; [P] US4 packet; [P] US5 assist; [P] US6 dashboard/pipeline; [P] US7 onboarding
  - US6 dashboard/pipeline and US7 onboarding: delivered by spec 007 (US1 dashboard, US2 pipeline, US3 guided onboarding; `e2e/007-experience-growth/`, evidence in `qa/evidence/007/`, roll-up in `qa/evidence/007/README.md`). Their E2E items are done there (007 T024/T037/T048 and the later 007 QA tasks); US1–US5 of 001 remain with their own specs (003–006).
- [ ] T082 Responsive + dark-mode + accessibility pass (axe), screenshot review of every page at 375 and 1440 px
- [ ] T083 Deployment docs: Cloudflare Worker + Neon + R2 (`docs/deploy.md`), `.dev.vars.example`, GitHub Actions CI (typecheck, unit, API, E2E)
- [ ] T084 README, NOTICE (Apache-2.0 attribution), quickstart
