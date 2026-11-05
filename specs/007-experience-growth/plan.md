# Implementation Plan: Experience & Growth — Dashboard, Pipeline, Onboarding, Landing & Demo

**Branch**: `007-experience-growth` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-experience-growth/spec.md`

**Note**: This template is filled in by the `/cairn-plan` command; its definition describes the execution workflow.

## Summary

The experience layer of TenderPilot is built (001 tasks T070–T076): one-round-trip dashboard aggregates
(`GET /api/dashboard`), a dnd-kit Kanban over `GET/PATCH /api/workspaces` with the server-side "Ready" guard, a five-step
onboarding wizard that saves as it goes and ticks `organizations.onboarding_state`, an idempotent demo seed
(`POST /api/demo/seed`, `packages/db/src/demo.ts`) and a marketing landing page with pricing. This plan keeps that
architecture and closes the gaps the spec calls out:

1. **Persona widgets** — extend `DashboardResponse` with `myWork` and `awaitingDecision` (two more org-scoped queries in
   the same `Promise.all`), render "My bids" and "Awaiting your decision" with role gating.
2. **Pipeline hardening** — "Move to…" menu (WCAG 2.5.7), "Record the result" dialog, Dropped toggle, debounced URL-synced
   search, position renumbering, corrected view-only copy.
3. **Onboarding hardening** — whitelist onboarding keys in `updateOrgInputSchema`, no duplicate watchlist on resume, tick
   retry/toast, pre-marked vault cards, `onboarding.completed` activity with duration.
4. **Demo lifecycle** — `DELETE /api/demo` + `removeDemo()` in `packages/db/src/demo.ts`, dashboard demo banner, "Sample"
   badge for demo tenders.
5. **Growth/landing** — SEO/social meta, `og.png`, `robots.txt`, `sitemap.xml`, plans config shared with the landing
   page, `?plan=` carried to sign-up, single page-title suffix.
6. **Cross-cutting quality** — stale-data banner, offline banner, web app manifest, axe + overflow E2E across 11 pages,
   `bid_workspaces(org_id, stage)` index, seven Playwright E2E specs with evidence in `qa/evidence/007/US<n>/`.

## Technical Context

**Language/Version**: TypeScript 5.x (strict) end to end; Node 22 for local/CI; Cloudflare Workers runtime in production

**Primary Dependencies**: API — Hono, Drizzle ORM, Zod; Web — React 18, React Router 6 (data router), TanStack Query 5,
Tailwind, Radix UI primitives, dnd-kit (`@dnd-kit/core` 6, `@dnd-kit/sortable` 9), Recharts 2, Framer Motion 11, sonner,
cmdk, lucide-react. New dev dependency: `@axe-core/playwright` (E2E only, pinned exact version). No new runtime web
dependency is required (NFR-008): the "Move to…" menu uses the existing `components/ui/menu.tsx` (Radix dropdown), the
result dialog uses `components/ui/dialog.tsx`.

**Storage**: Postgres (Neon in production, local Postgres for dev/CI) via `packages/db/src/schema.ts`; R2 / local blob
store for demo PDFs

**Testing**: Vitest (core unit, API integration on real Postgres via `apps/api/test/helpers.ts`), web unit tests with
Vitest (`apps/web/src/**/*.test.ts`), Playwright E2E (`e2e/007-experience-growth/US<n>-*.e2e.ts`, desktop 1440×900 +
Pixel 7 `@mobile`), axe-core audits, Lighthouse CI (landing only)

**Target Platform**: Cloudflare Worker (API + static SPA assets) and Node (`apps/api/src/node.ts`); evergreen browsers,
Android Chrome on 375–412 px phones for Owners

**Project Type**: Web application (pnpm monorepo: `packages/core`, `packages/db`, `apps/api`, `apps/web`)

**Performance Goals**: `GET /api/dashboard` < 500 ms p95 at 10k tenders / 2k matches / 200 workspaces (NFR-001);
pipeline renders 200 cards < 1 s (NFR-002); landing LCP < 2.5 s, Lighthouse mobile Perf ≥ 85 (NFR-003)

**Constraints**: Org-scoped queries only (Constitution IV); IST day boundaries; human-in-the-loop copy (Constitution I);
WCAG 2.1 AA + 2.2 2.5.7/2.5.8; no GeM traffic from the browser

**Scale/Scope**: 6 screens (landing, onboarding, dashboard, pipeline, 404/error, cross-page shell), 3 API routes touched
(`dashboard.ts`, `demo.ts`, `org.ts`) plus `workspaces.ts` hardening, 1 new endpoint (`DELETE /api/demo`), 7 user stories

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| I. Human-in-the-Loop Submission | Pipeline "Submitted" and "Won/Lost" only record what the human did on GeM; landing copy never claims auto-submission (FR-083); toasts say "TenderPilot never submits on GeM for you". The optional L1 hint (P3) only reads the public award page. | PASS |
| II. Polite, Public-Only Ingestion | No new GeM traffic from the experience layer; the optional award-result hint goes through the existing rate-limited GeM adapter and only reads public pages. | PASS |
| III. Deterministic First | Dashboard verdicts come from stored deterministic analyses; no model calls in this area. | PASS |
| IV. Tenant Isolation | Every new query (`myWork`, `awaitingDecision`, `removeDemo`) filters by `org_id`; cross-org ids → 404; API tests extended (T015, T050, T058). Demo tenders are global public-like rows; org rows stay per org. | PASS |
| V. Delightful, Accessible UX | This spec is the enforcement vehicle: states table, 375/1440 px, AA, keyboard, reduced motion, automated axe (FR-094). | PASS (gaps tracked) |
| VI. Test-First, E2E Verified | Each US gets a Playwright E2E with evidence; API tests for each new endpoint/field before the UI. | PASS |
| VII. Edge-Native | No Node-only APIs in the new code; blob deletion uses the existing `deps.blobs` abstraction (R2 / local). | PASS |
| VIII. Simplicity & Traceability | Extends existing modules instead of new packages; plans config lives in `packages/core/src/contracts`; every task references FR ids. | PASS |

## Project Structure

### Documentation (this feature)

```text
specs/007-experience-growth/
├── spec.md                    # Feature spec (this area)
├── plan.md                    # This file
├── tasks.md                   # Task list (built = [x], open = [ ])
└── checklists/
    └── requirements.md        # Spec quality checklist
```

Contracts and the data model for the built parts remain in `specs/001-gem-tender-copilot/{contracts/api.md,data-model.md}`;
the additions below are reflected there by task T005.

### Source Code (repository root)

```text
packages/core/src/contracts/
├── experience.ts            # DashboardResponse, DemoSeedResponse (+ MyWorkItem, DecisionItem, DemoRemoveResponse)  [extend]
├── auth.ts                  # updateOrgInputSchema.onboardingState → whitelisted keys                               [extend]
├── apply.ts                 # PIPELINE_STAGES, STAGES, STAGE_LABELS, workspaceUpdateSchema, WorkspaceCard           [read]
└── plans.ts                 # PLANS (Starter/Pro/Enterprise)                                                         [new]
packages/core/src/gem/award.ts   # parseBidResult(html) ported from arush15june/gem-search (MIT)                      [new, P3]
packages/db/src/
├── schema.ts                # bid_workspaces index (org_id, stage)                                                   [extend]
├── demo.ts                  # seedDemo (built) + removeDemo()                                                        [extend]
└── migrations/              # drizzle-kit generated migration for the index                                          [new]
apps/api/src/routes/
├── dashboard.ts             # + myWork, awaitingDecision                                                             [extend]
├── demo.ts                  # + DELETE /demo                                                                          [extend]
├── org.ts                   # PATCH /org whitelist via schema                                                        [read]
└── workspaces.ts            # renumber on precision exhaustion                                                       [extend]
apps/api/test/
├── dashboard.test.ts        # + persona fields, stale/IST cases                                                      [extend]
├── demo.test.ts             # + DELETE /demo                                                                          [extend]
└── workspace.test.ts        # + renumber, dropped                                                                     [extend]
apps/web/
├── index.html               # SEO/social meta, manifest link                                                         [extend]
├── public/                  # og.png, robots.txt, sitemap.xml, manifest.webmanifest, icons                           [new]
└── src/
    ├── app/router.tsx, NotFoundPage.tsx                                                                               [read]
    ├── components/layout/{AppShell,RouteErrorBoundary,nav}.tsx                                                        [extend: offline banner]
    ├── components/ui/{states,stat-tile,menu,dialog}.tsx                                                               [read/extend]
    ├── lib/hooks.ts         # useDocumentTitle (no double suffix), useOnline                                         [extend]
    └── features/
        ├── dashboard/{DashboardPage,api,activity,charts}.tsx  + MyBidsCard.tsx, DecisionsCard.tsx, DemoBanner.tsx     [extend/new]
        ├── pipeline/{PipelinePage,api,position}.ts(x) + MoveToMenu.tsx, OutcomeDialog.tsx                              [extend/new]
        ├── onboarding/OnboardingPage.tsx                                                                              [extend]
        ├── landing/LandingPage.tsx                                                                                    [extend]
        └── auth/SignupPage.tsx  # ?plan= note                                                                         [extend]
e2e/
├── support/fixtures.ts      # + evidence007, a11y(), noHorizontalOverflow(), inviteAs()                              [extend]
└── 007-experience-growth/US1-dashboard.e2e.ts … US7-a11y-responsive.e2e.ts                                           [new]
qa/evidence/007/US1 … US7/   # screenshots, video, trace, axe JSON, VERDICT.md                                          [new]
```

**Structure Decision**: Web application inside the existing pnpm monorepo. Shared types live in
`packages/core/src/contracts`, schema in `packages/db/src/schema.ts`, routes in `apps/api/src/routes`, UI in
`apps/web/src/features/<area>`. No new package or service.

## API Endpoints

All endpoints are under `/api`, JSON, cookie session or bearer API token. Errors: `{ error: { code, message, details? } }`.

| Method | Path | Role | Request | Response | Errors | Status |
|---|---|---|---|---|---|---|
| GET | `/dashboard` | viewer+ | — | `DashboardResponse` (tiles, stats, closingSoon[≤8], pipeline, pipelineValue, verdicts, matchesByDay[14], recentMatches[≤6], expiringDocuments[≤6], activity[≤15], setup[6], setupComplete, demo, generatedAt) | 401 | Built |
| GET | `/dashboard` (+fields) | viewer+ | — | adds `myWork: MyWorkItem[≤5]` `{id, tenderId, title, bidNumber, stage, dueAt, endAt, readiness:{percent, blockers}}` and `awaitingDecision: DecisionItem[≤5]` `{id, tenderId, title, bidNumber, endAt, analysis:{score, verdict}}` | 401 | Gap (FR-070) |
| GET | `/workspaces` | viewer+ | `?stage=a,b&mine=1&q=` | `{ items: WorkspaceCard[], total, byStage }` | 400 `validation_error` (unknown stage), 401 | Built |
| PATCH | `/workspaces/:id` | analyst+ | `{ stage?, position?, ownerId?, assigneeIds?, dueAt?, outcome? }` (strict) | `WorkspaceDto` | 400, 401, 403, 404, 409 `conflict` (`reason: not_analysed`), 409 `not_ready` (`details.blockers`) | Built (+ renumber gap FR-033) |
| PATCH | `/org` | bid_manager+ | `{ name?, onboardingState?: Partial<Record<OnboardingKey, boolean>>, scoringWeights? }` | `MeOrg` | 400 (gap: unknown key / > 16 keys), 401, 403 | Built (+ whitelist gap FR-048) |
| POST | `/demo/seed` | bid_manager+ | — | `DemoSeedResponse { ok, created, tenders, watchlists, matches, analyses, workspaces, vaultDocuments, pastContracts }` | 401, 403 | Built (201 / 200) |
| DELETE | `/demo` | bid_manager+ | — | `DemoRemoveResponse { ok: true, removed: { workspaces, analyses, matches, comments, notifications, activity, pastContracts, vaultDocuments, watchlists, profileReset: boolean } }` | 401, 403 | Gap (FR-065) |
| POST | `/watchlists` | analyst+ | onboarding step 3 | `WatchlistDto` 201 | 400, 403 | Built (003) |
| PUT | `/profile` | analyst+ | onboarding steps 1–2 | `ProfileResponse` | 400 `details.fields` | Built (005) |
| POST | `/vault` | analyst+ | multipart (onboarding step 4) | `VaultDocumentDto` 201 | 400, 413, 415 | Built (005) |
| GET | `/tenders/:id/result-hint` | analyst+ | — | `{ bidders: [{rank, level, price}], l1Price } \| { available: false }` | 404 | Gap (P3, optional, FR-030 helper) |

Activity actions written in this area: `workspace.stage_changed`, `workspace.outcome_recorded`, `demo.seeded`,
*(gap)* `demo.removed`, *(gap)* `onboarding.completed {durationSec}`.

## Data Model Touch-points

| Table | Columns used | Change |
|---|---|---|
| `organizations` | `onboarding_state` (jsonb, keys company/categories/watchlist/documents/skipped/completed/demo), `plan` (`trial`), `created_at` (for onboarding duration) | none (validation only) |
| `bid_workspaces` | `org_id`, `tender_id`, `stage`, `position` (real), `owner_id`, `assignee_ids` (jsonb), `due_at`, `outcome` (jsonb), `submitted_at`, `updated_at` | **add index** `bid_workspaces_org_stage_idx (org_id, stage)` |
| `tender_matches` | `org_id`, `tender_id`, `watchlist_id`, `dismissed`, `seen`, `reasons`, `created_at` (idx `org_id, created_at`) | none |
| `tenders` | `status`, `end_at`, `emd_amount`, `estimated_value`, `organisation/department/ministry`, `state`, `raw.demo` | none |
| `analyses` | `org_id`, `tender_id`, `status`, `score`, `verdict`, `created_at` | none |
| `vault_documents` | `org_id`, `expiry_date`, `title`, `type`, `blob_key` | none (removeDemo deletes demo rows + blobs) |
| `activity_log` | `org_id`, `action`, `entity_type`, `entity_id`, `meta.demo`, `created_at` (idx `org_id, created_at`) | none |
| `watchlists`, `memberships`, `invitations`, `company_profiles`, `past_contracts`, `comments`, `notifications` | counts for setup checklist; demo provenance for removal | none |

**Demo provenance for `removeDemo()`**: demo rows are identified without a new column — workspaces/analyses/matches whose
`tender_id` belongs to a tender with `raw.demo = true`; watchlists by `DEMO_WATCHLISTS` names *and* `created_by` = seeding
user *and* creation time = seed time − 16 d marker; vault documents and past contracts by the seeded titles/blob key
prefix `demo/`; activity and notifications by `meta.demo = true` / `dedupe_key LIKE 'demo:%'`. If this proves brittle in
review, fall back to adding a nullable `demo boolean` column to the affected org tables (decision recorded in T053).

## Key Flows

### 1. Dashboard load (built; gaps FR-012, FR-070)

```text
Browser /dashboard ──(TanStack Query, refetch 120 s)──► GET /api/dashboard
  requireAuth → orgId(c)
  Promise.all [ match counts (IST today/yesterday) | 14-day trend | pipeline by stage (+value, EMD) | latest verdicts |
                closing counts | closing rows (≤8) | recent matches (20 → 6 distinct) | expiring docs (≤ today+30) |
                activity (15) | profile | setup counts | open tenders | (gap) myWork | (gap) awaitingDecision ]
  tenderRefs() batch → analysis + workspace per tender ; enrichActivity() batch → target labels/links
  ◄── DashboardResponse
UI: success → widgets; first-load error → ErrorState; (gap) refresh error with data → StaleBanner(generatedAt) + Retry
```

### 2. Kanban move (built; gaps FR-029, FR-030)

```text
drag start → snapshot board ; drag over → optimistic column change ; drop →
  position = positionAt(siblings, index) ; PATCH /api/workspaces/:id { stage?, position }
    API: requireRole(analyst) → getWorkspace(org) (404) → stage === ready ? readinessOf() → 409 not_analysed / not_ready
         → set submittedAt / outcome → touch() → log workspace.stage_changed
  success → toast (Moved to X / Marked as won / Marked as submitted) → (gap) OutcomeDialog for won/lost
  error 409 → revert snapshot + blocker toast (Open workspace) ; other → revert + "Couldn’t move …"
  onSettled → invalidate ['workspaces'], ['workspace', id], ['dashboard']
(gap) MoveToMenu → same mutation path without drag
```

### 3. Onboarding (built; gaps FR-048…FR-052)

```text
/signup → POST /auth/signup → navigate /onboarding
initial step = first STEPS key not in me.org.onboardingState
Step1 → PUT /profile → PATCH /org {company:true} ; Step2 → PUT /profile → PATCH /org {categories:true}
Step3 → (gap: skip POST if state.watchlist) POST /watchlists → PATCH /org {watchlist:true}
Step4 → POST /vault ×≤3 → PATCH /org {documents:n>0} ; Done → PATCH /org {completed:true} (gap: + onboarding.completed activity)
Skip → PATCH /org {skipped:true} → /dashboard (setup checklist)
(gap) PATCH failure → retry once → toast
```

### 4. Demo seed and removal (seed built; removal gap FR-065)

```text
POST /demo/seed (bid_manager+) → seedDemo(db,{orgId,userId,now,blobs}) → upsert 40 tenders (raw.demo) →
  profile if empty → past contracts → vault docs + PDFs → 3 watchlists → matches → 20 analyses → 16 workspaces →
  comments, in-app notifications, activity (meta.demo) → onboardingState.demo = true → 201/200
(gap) DELETE /demo (bid_manager+) → removeDemo(db,{orgId, blobs}) in one transaction:
  delete comments → packets/annexures of demo workspaces → workspaces → analyses → matches → demo watchlists →
  notifications (dedupe demo:%) → activity (meta.demo) → past contracts (seeded) → vault docs (seeded) [+ blobs after commit]
  → reset profile if still demo → onboardingState.demo = false → log demo.removed → 200 { removed }
```

### 5. Landing → trial (built; gaps FR-084…FR-087)

```text
GET / (signed out) → PublicOnly → LandingPage (lazy) ; signed in → Navigate safeNext(next)
"Start free trial" (Pro) → (gap) /signup?plan=pro → trial note → POST /auth/signup → /onboarding
Crawler → index.html <head> (gap: OG/Twitter/JSON-LD/canonical) ; /robots.txt ; /sitemap.xml
```

## What to Port from the Reference Repos

The user explicitly approved copying from the listed repositories. None of them contains UI code for dashboards,
Kanban, onboarding or landing pages in our stack (they are Python/Node scrapers, a Streamlit app and a Flask app), so
porting is limited:

| Source file | Target | Why | License / action |
|---|---|---|---|
| `refs/arush15june_gem-search/gem.py` → `get_bid_result()` regex (bidder rows: rank, company, `bid_price`, `L\d+`) | `packages/core/src/gem/award.ts` `parseBidResult(html)` + fixture test `packages/core/test/gem/award.test.ts`; used by optional `GET /api/tenders/:id/result-hint` to pre-fill L1 in the "Record the result" dialog (FR-030) | Saves users looking up L1 manually after GeM publishes results; improves win-rate analytics | MIT — port to TypeScript, keep the regex structure, attribute in `NOTICE` (T004) |
| `refs/erenmyeager15_india-government-tenders-scraper/src/routes.ts` `INDIAN_STATES` / `isIndianState()` | none (we already have `packages/core/src/gem/states.ts`) | Cross-check only: verify our state list covers the same 36 states/UTs used by onboarding chips | Apache-2.0 — no code copied |
| `refs/PranavTamada_Tender_Scraper/keywords.py` (word-boundary, hyphen/space-insensitive keyword regexes; "app" ≠ "apparel") | idea for onboarding keyword suggestions (`keywordsFor`) — avoid suggesting short ambiguous tokens | Better first-watchlist precision | No license — ideas only, no code copied |
| `refs/Giri-Aayush_gem/my_profile.yaml` (profile-driven work types/locations) | idea: onboarding categories/locations prefill | Confirms the "profile → watchlist" approach | No license — ideas only |
| `refs/PranavTamada_Tender_Scraper/dashboard.py`, `refs/Giridar33_gem-tender-tracker/streamlit_app.py` (tabs, refresh cooldown, analytics tab) | none | Our dashboard already exceeds these; the "refresh cooldown" idea is covered by sync health in 003 | No license — not copied |

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Demo removal deletes user data | Provenance rules + API test with mixed user/demo rows (T050, T053, T054); transaction; blobs deleted after commit only |
| Dashboard query count grows with persona widgets | Keep in one `Promise.all`; add `(org_id, stage)` index; perf test with 10k tenders (T017) |
| Drag-and-drop flakiness in E2E | Use keyboard sensor and "Move to…" menu in E2E for determinism; one pointer-drag smoke per run |
| SPA landing SEO limits | Static `<head>` meta + sitemap now; prerender later if organic traffic matters |
| Landing pricing drifts from reality | Single `plans.ts` config; unit test render test of prices (T064) |

## Complexity Tracking

> No constitution violations. No entries.
