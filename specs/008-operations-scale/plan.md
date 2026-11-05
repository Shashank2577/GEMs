# Implementation Plan: Operations & Scale — Deployment, CI/CD, Security, Reliability, Observability, Plan Limits & QA Evidence

**Branch**: `008-operations-scale` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-operations-scale/spec.md`

**Note**: This plan follows the `/cairn-plan` workflow. Architecture input: `docs/architecture.md` and
`docs/adr/0001…0014` (recommendations ARCH-01…ARCH-26). Contracts and data model of the built system live in
`specs/001-gem-tender-copilot/{contracts/api.md,data-model.md}`; additions from this plan are folded back there
(task T008).

## Summary

TenderPilot's application features are built and green, but the operational envelope is not ready for paying
customers: there is no CI, deploys and migrations run from laptops, demo data leaks across tenants, there is no rate
limiting, no plan enforcement, the GeM throttle is per-isolate, hot queries have no fitting indexes, Workers limits are
defaults, and nobody is paged when ingestion stops. The technical approach keeps the single-Worker monolith
(ADR-0001) and Postgres as the only stateful system: every new coordination primitive (rate limits, GeM lease, single
running ingestion, usage metering) is a small Postgres table behind an `AppDeps` interface so the Node/CI path and the
Worker path stay identical (Constitution VII). CI/CD is GitHub Actions: `ci.yml` (typecheck, unit, API on a Postgres
service, Playwright E2E with evidence upload, additive-migration check), `dod.yml` (QA verdict + trailers), and
`deploy.yml` (staging migrate → deploy → smoke → approval → production migrate → deploy → smoke).

## Technical Context

**Language/Version**: TypeScript 5.6, Node 22 (CI + local), Cloudflare Workers runtime (`compatibility_date
2025-09-01`, `nodejs_compat`).

**Primary Dependencies**: Hono 4 (`apps/api`), Drizzle ORM 0.36 + drizzle-kit 0.28 (`packages/db`), `pg` 8 (Node) and
`@neondatabase/serverless` 0.10 (Worker, removed by FR-075), Vite + React (`apps/web`), Playwright 1.63, Vitest 2,
Wrangler 4. New (optional, SHOULD): `@sentry/cloudflare`, `@sentry/node` (exact versions pinned when added).

**Storage**: Neon Postgres 16 (pooled endpoint → Hyperdrive later), R2 bucket `tenderpilot-blobs`
(`tenderpilot-blobs-staging` for staging). Local/CI: Postgres 16 on port 5433 (`scripts/local-pg.sh` or CI service),
FS blob store.

**Testing**: Vitest (core unit, API integration on real Postgres via `apps/api/test/helpers.ts`), Playwright E2E
(`playwright.config.ts`, mock-gem :4011, API+SPA :8788), load scripts (`scripts/load/*.sh`, `autocannon`-free: `curl`
+ `xargs -P` for portability), `EXPLAIN (FORMAT JSON)` assertions in API tests for index use.

**Target Platform**: Cloudflare Workers (Paid) + static assets + Cron Triggers + R2; Neon (Launch+); GitHub Actions
`ubuntu-latest`.

**Project Type**: Web service + SPA monorepo (pnpm workspaces).

**Performance Goals**: feed/dashboard p95 < 300 ms server time at 500k tenders; `/api/health` p50 < 150 ms; GeM
≤ 1 req/s cluster-wide; CI PR feedback < 10 min.

**Constraints**: Worker CPU 120 s (`[limits] cpu_ms`), 128 MB memory per isolate, 1,000 subrequests per invocation
(Paid), no in-memory state shared across isolates, Neon direct endpoint ~112 connections (pooled ~10k client
connections), Resend batch ≤ 100 emails.

**Scale/Scope**: launch: ≤ 200 orgs, ≤ 2,000 users, 10^5–10^6 tenders (30k open), ≤ 10k analyses/month; this plan
targets 10× headroom without architecture change.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Result |
|---|---|---|
| I. Human-in-the-loop | Nothing here submits bids or touches GeM accounts. | PASS |
| II. Polite, public-only ingestion | FR-024 makes the ≤ 1 req/s limit cluster-wide; FR-026 removes click-driven re-crawls; honest UA unchanged. | PASS (strengthens) |
| III. Deterministic first | LLM caps/quotas fall back to rules-only with a visible warning (FR-031, FR-037); never block a verdict on the LLM. | PASS |
| IV. Tenant isolation | FR-016 fixes the demo leak and turns isolation into a CI gate; plan limits and usage are org-scoped; admin endpoint is token-gated and logged. | PASS (strengthens) |
| V. Delightful, accessible UX | New UI (Plan & usage, banners, dialog, cooldown) specified with 375 px/desktop, states and a11y (NFR-011). | PASS |
| VI. Test-first, E2E verified | Every story has API tests and a Playwright QA task with evidence; CI enforces it; DoD check enforces verdicts. | PASS |
| VII. Edge-native, runs locally | All new primitives are Postgres tables behind `AppDeps`; Sentry/monitor optional no-ops; Node path unchanged. | PASS |
| VIII. Simplicity & traceability | No new services (no Redis/KV/Durable Objects); limits are constants in one module each; tasks reference FR ids. | PASS |
| Constraint: licences in NOTICE | Ports from Apache-2.0/MIT repos recorded in NOTICE (task T006). | PASS |

Re-check after design: PASS — the only added runtime dependency is optional Sentry; Hyperdrive *removes* a driver.

## Project Structure

### Documentation (this feature)

```text
specs/008-operations-scale/
├── plan.md              # This file
├── spec.md              # Feature specification
└── tasks.md             # Task list (/cairn-tasks)
docs/
├── architecture.md      # Built (input)
├── adr/0001…0014        # Built (input)
└── runbook.md           # NEW (FR-048)
```

### Source Code (repository root)

```text
.github/workflows/
├── ci.yml                         # NEW  typecheck · unit · api(pg service) · e2e(+evidence) · migrations-additive
├── dod.yml                        # NEW  QA verdict + trailer check (ported from ai-sdlc dod-check pattern)
├── deploy.yml                     # NEW  staging → approval → production, migrate before deploy, smoke
├── project-board.yml              # built
└── wiki-sync.yml                  # built (already publishes "Spec 008 Operations")
wrangler.toml                      # [limits], [env.staging], routes/custom_domain, workers_dev=false, (later) [[hyperdrive]]
scripts/
├── local-pg.sh                    # built
├── smoke.sh                       # NEW  FR-008
├── check-migrations.ts            # NEW  FR-006
└── load/{feed.sh,gem-fetch.sh}    # NEW  FR-033
packages/core/src/
├── contracts/plans.ts             # NEW  PLAN_LIMITS, TRIAL_DAYS (+ 007's PLANS display config)
├── contracts/caps.ts              # NEW  MAX_TENDER_DOC_PAGES, MAX_LLM_*, PACKET_MAX_*, MANUAL_SYNC_COOLDOWN_MIN
├── gem/client.ts                  # + beforeRequest hook (FR-024)
├── gem/http.ts                    # NEW  bounded fetch + retry classification (ported, Apache-2.0)
└── match/matcher.ts               # + compileCriteria (FR-074)
packages/db/src/
├── schema.ts                      # + gem_throttle, rate_limits, llm_usage, subscriptions, organizations.trial_ends_at,
│                                  #   partial indexes, tender_documents cache cols, tenders.search
├── client.ts                      # createNeonDb removed (FR-075)
├── demo.ts                        # source:'demo'
├── fixtures/bulk-tenders.ts       # NEW  500k fixture (FR-033)
└── migrations/0001_…sql …         # generated, additive
apps/api/src/
├── worker.ts                      # await scheduled; errors reporter; (later) Hyperdrive
├── app.ts                         # health v2 (FR-044); middleware order
├── deps.ts                        # + rateLimiter, errors, gemLease
├── env.ts                         # + ADMIN_TOKEN, SENTRY_DSN, LOG_LEVEL, TRUST_PROXY, HEALTH_INGESTION_MAX_AGE_MIN,
│                                  #   MANUAL_SYNC_COOLDOWN_MIN
├── adapters/{logger.ts,errors.ts,index.ts}   # JSON logger + redaction; Sentry/no-op reporter
├── lib/{errors.ts,rate-limit.ts,rate-limit-rules.ts,gem-lease.ts,plan.ts,tender-scope.ts,client-ip.ts,scheduled.ts}
├── middleware/{request.ts,rate-limit.ts,body-limit.ts,plan.ts,error.ts}
├── routes/{tenders,watchlists,dashboard,ingestion,analysis,vault,packets,org,demo,admin}.ts
└── services/{ingest,analyse,packet,alerts,housekeeping}.ts
apps/api/test/
├── isolation.test.ts              # NEW  (extends 002 T052, contract-driven)
├── ops-limits.test.ts             # NEW  rate limits, body limits, caps
├── plan.test.ts                   # NEW  402s, trial expiry, usage, admin
├── health.test.ts                 # NEW  health v2, JSON logs, reporter
├── gem-lease.test.ts              # NEW  throttle, single-running, cooldown
├── perf-indexes.test.ts           # NEW  EXPLAIN assertions on bulk fixture (tagged, runs in CI api job with small N)
└── housekeeping.test.ts           # NEW  (US7)
apps/web/
├── public/_headers                # NEW  static security headers + CSP (FR-013)
└── src/
    ├── features/settings/sections/UsageSection.tsx   # NEW  Plan & usage
    ├── components/layout/{TrialBanner,PlanLimitDialog}.tsx  # NEW
    ├── lib/api.ts                 # + isPaymentRequired / isRateLimited / retryAfter
    └── features/feed/SyncHealth.tsx, settings/sections/SyncSection.tsx  # cooldown UI
e2e/008-operations-scale/US1…US7-*.e2e.ts                 # NEW
qa/evidence/008/US1…US7/                                   # NEW (screenshots, video, trace, transcripts, VERDICT.md)
docs/runbook.md                                            # NEW
NOTICE                                                     # + ported files
```

**Structure Decision**: Keep the existing pnpm monorepo layout (`packages/core`, `packages/db`, `apps/api`, `apps/web`,
`e2e/`, `qa/`). Ops code lives in `apps/api/src/{lib,middleware}` behind `AppDeps`; constants live in
`packages/core/src/contracts/{plans,caps}.ts` so web and API share them; CI/CD lives in `.github/workflows/` and
`scripts/`.

## API Endpoints

All under `/api`, error shape `{error:{code,message,details?}}`. New/changed only.

| Method & path | Auth | Body | Success | Errors |
|---|---|---|---|---|
| `GET /health` (changed) | none | — | 200 `{ok:true, db:true, version, ingestion:{lastSuccessAt, ageMinutes, lastStatus, state}, alerts:{pendingOlderThan30m}, reasons:[]}` | 503 same shape with `ok:false`, `reasons ⊆ [db_unreachable, ingestion_stale, alerts_backlog]` |
| `GET /org/usage` (new) | any member | — | 200 `{plan, trialEndsAt, period:{start,end}, usage:{seats, watchlists, analysesThisMonth, llmAnalysesThisMonth, vaultBytes, packetsThisMonth, llmTokensThisMonth:{input,output}}, limits}` | 401 |
| `GET /auth/me`, `GET /org` (changed) | session/token | — | `org.trialEndsAt` added | — |
| `POST /admin/orgs/:id/plan` (new) | `Bearer ADMIN_TOKEN` | `{plan:'trial'\|'starter'\|'pro'\|'enterprise', note:string(1..500), trialEndsAt?:ISO}` | 200 `{org:{id, plan, trialEndsAt}, subscriptionId}` | 404 (no/invalid token or unknown org — indistinguishable), 400 `validation_error` |
| `POST /ingestion/run` (changed) | bid_manager+ | `{pages?, search?}` | 200 `IngestionRunDto` | 409 `ingestion_running`; **429 `sync_cooldown`** `details.retryAt`; 402 `plan_expired` |
| `POST /tenders/:id/analyse` (changed) | analyst+ | — | 201 `AnalysisDto` (+ `warnings[]` incl. `llm_budget_exhausted`, `llm_quota_reached`) | **402 `plan_limit_reached`** (`analysesPerMonth`), 402 `plan_expired`, **422 `scanned_document`**, 429 `rate_limited` |
| `POST /tenders/:id/documents` (changed) | analyst+ | multipart ≤ 25 MB | 201 | **413** pre-read, **422 `document_too_long`**, 429, 402 `plan_expired` |
| `POST /tenders/:id/fetch-documents` (changed) | analyst+ | — | 201 | **503 `gem_busy`**, 422 `document_too_long`, 429 `rate_limited` |
| `POST /vault`, `PUT /vault/:id/file` (changed) | analyst+ | multipart ≤ 20 MB | 201 | 413 (built), **402 `plan_limit_reached`** (`vaultBytes`), 429 |
| `POST /watchlists` (changed) | bid_manager+ | as built | 201 | **402** (`watchlists`) |
| `POST /watchlists/preview` (changed) | analyst+ | criteria | 200 | **429** `watchlist.preview.user` |
| `POST /org/invitations` (changed) | owner/bid_manager | as built | 201 | **402** (`seats`) |
| `POST /workspaces/:id/packets` (changed) | analyst+ | `{items ≤ 40}` | 201 | **413 `packet_too_large`**, **402** (`packetsPerMonth`), 429 |
| `POST /auth/login`, `/auth/signup`, `/auth/accept-invite`, `/me/password`, `/auth/forgot-password` (changed) | — | as built / 002 | as built | **429 `rate_limited`** + `Retry-After`; 503 when limiter unavailable (auth rules fail closed) |
| any cookie-auth write (changed, 002 FR-028) | session | — | — | 403 `bad_origin` |
| any write when trial expired (changed) | session/token | — | — | **402 `plan_expired`** (allow-list FR-038) |

Response headers on every `/api/*` response: `x-request-id`, `cache-control: no-store` (built), `x-content-type-options`,
`referrer-policy`, `permissions-policy`, HSTS on HTTPS; 429 adds `Retry-After`.

## Data Model Touch-points

All changes are additive (FR-006). Existing tables from `packages/db/src/schema.ts`.

| Table / column | Change | Migration notes |
|---|---|---|
| `tenders.source` | values `gem` \| `demo`; demo rows converted | data-fix: `update tenders set source='demo' where bid_number in (<demo set>) or raw->>'demo'='true'`; then delete `tender_matches`/`notifications` (dedupe key `tender:<id>:<org>`) for orgs where `onboarding_state->>'demo'` is not true. `demo.ts` sets `raw.demo = true` going forward. |
| `tenders` indexes | `tenders_open_{created,end,value,state,ministry,category}_idx … WHERE status='open'` | `CREATE INDEX CONCURRENTLY` is not available inside drizzle's transaction → indexes created in a separate migration file marked `-- tp:non-transactional`; migrate script runs such files outside a transaction (task T047). |
| `tenders.search` (SHOULD) | `tsvector GENERATED ALWAYS AS (...) STORED` + GIN `tenders_search_gin` | rewrite of `tenders` on add → schedule off-peak; documented in runbook. |
| `analyses` | `analyses_org_tender_created_idx (org_id, tender_id, created_at desc)` | — |
| `notifications` | `notifications_pending_idx (created_at) WHERE status='pending' AND channel IN ('email','whatsapp')` | — |
| `ingestion_runs` | `ingestion_runs_one_running_uq ON ((true)) WHERE status='running'` | pre-step reaps duplicates so the index can build. |
| `gem_throttle` (new) | `id text pk`, `next_slot_at timestamptz not null default now()` | seed row `('gem', now())`. |
| `rate_limits` (new) | `key text`, `window_start timestamptz`, `count int not null default 0`, pk `(key, window_start)` | pruned daily (FR-070). |
| `organizations.trial_ends_at` (new) | `timestamptz null` | backfill trials: `greatest(created_at + 14 d, now() + 7 d)`. |
| `subscriptions` (new) | `id uuid pk`, `org_id fk cascade`, `plan text`, `status text`, `started_at`, `ends_at null`, `note text`, `created_by text`, `created_at`; idx `(org_id, created_at desc)` | — |
| `llm_usage` (new) | `id uuid pk`, `org_id fk cascade`, `analysis_id fk set null`, `kind text`, `model text`, `input_tokens int`, `output_tokens int`, `created_at`; idx `(org_id, created_at)` | — |
| `tender_documents` (SHOULD) | `requirements jsonb`, `extractor_version text`, `extracted_at timestamptz`, `extracted_method text` | nullable. |
| `notifications.attempts` | owned by spec 003 (T077) | referenced only. |
| `activity_log` | new action `org.plan_changed` | no schema change. |

## Key Flows

### 1. Pull request → CI → evidence → DoD (US1)

```text
PR opened ──► ci.yml
   ├─ typecheck ─┐
   ├─ unit ──────┼─► api (services: postgres:16 :5433; TEST_DATABASE_URL) ─► e2e
   │             │                                                         ├─ playwright install chromium
   │             │                                                         ├─ E2E_DATABASE_URL=…/tenderpilot_e2e pnpm e2e
   │             │                                                         ├─ summary from qa/.runs/8788/results.json
   │             │                                                         └─ upload-artifact e2e-evidence-<run_id> (always)
   └─ migrations-additive (scripts/check-migrations.ts + drizzle-kit drift check)
PR with Work-Item → dod.yml → VERDICT.md exists & approved & no "not met" & media present & trailers ok
```

`start-api.sh` already drops/creates the E2E DB through `scripts/local-pg.sh`; in CI `E2E_DATABASE_URL` is set so the
script skips local Postgres and the job creates the DB with `psql` first (task T013).

### 2. Release (US2)

```text
main green ─► deploy.yml(workflow_run)
  staging:    web build → db:migrate(STAGING_DATABASE_URL) → wrangler deploy --env staging --var APP_VERSION:<sha>
              → scripts/smoke.sh https://staging.<domain> <sha>
  production: [environment approval] → db:migrate(PROD_DATABASE_URL) → wrangler deploy --var APP_VERSION:<sha>
              → scripts/smoke.sh https://<APP_DOMAIN> <sha>
rollback: wrangler rollback (code only); schema rolls forward (additive-only policy)
```

### 3. Request pipeline on the Worker (US3/US5/US6)

```text
fetch(/api/*) → withDeps (pooled DB, R2, reporter)
  → injectDeps + requestId + JSON request log (+ security headers)            middleware/request.ts
  → bodyLimit(route cap) → 413 before body read                               middleware/body-limit.ts
  → rateLimit(api.ip | api.user) → 429 + Retry-After                          middleware/rate-limit.ts
  → auth (session/bearer) → bad_origin (002)                                  middleware/auth.ts
  → requireActivePlan (writes) → 402 plan_expired                             middleware/plan.ts
  → route: rateLimit(rule) → assertWithinPlan → handler                       lib/plan.ts
  → errorHandler: HttpError → JSON; unknown → 500 + errors.capture(rid,org)   middleware/error.ts
```

### 4. GeM lease (US4, FR-024)

```text
GemClient.request() → beforeRequest() = acquireGemSlot(db, 1000, maxWait)
  UPDATE gem_throttle SET next_slot_at = greatest(now(), next_slot_at) + interval '1000 ms'
   WHERE id='gem' RETURNING next_slot_at - interval '1000 ms' AS my_slot, now() AS db_now
  wait = my_slot - db_now; if wait > maxWait → (user path) 503 gem_busy (slot is "wasted", acceptable)
  sleep(wait) → fetch → existing retry/back-off (each retry re-acquires a slot)
```

### 5. Ingestion single-flight + cooldown (US4)

```text
POST /ingestion/run → cooldown: last manual run finishedAt > now-10min ? 429 sync_cooldown(retryAt) : continue
runIngestion: tx { reap running rows older than 15 min; INSERT running } — unique violation → IngestionBusyError → 409
cron: same path; IngestionBusyError → log "ingestion skipped: already running" (not a failure)
```

### 6. Analyse with caps, quota and metering (US4/US5)

```text
POST /tenders/:id/analyse
  rateLimit(analyse.user) → requireActivePlan
  tx { SELECT org FOR UPDATE; count analyses this IST month; ≥ max → 402; INSERT analyses(running) }
  docs: reject >300 pages (422) / scanned (422)
  llmAllowed = llm && llmAnalysesThisMonth < max (else warning llm_quota_reached)
  for doc in docs: rules; if llmAllowed && calls < 2 && chars+len ≤ 90k && elapsed < 120 s → LLM (60 s timeout)
                    → INSERT llm_usage(tokens) ; else warning llm_budget_exhausted
  score → UPDATE analyses(done)
```

### 7. Health (US6)

```text
GET /health → parallel (3 s timeout each): select 1; last success run; count pending email/whatsapp older than 30 min
  reasons = [db_unreachable?, ingestion_stale (age > 120)?, alerts_backlog (>0)?]; state 'never' when no success yet
  200 if reasons empty else 503
```

### 8. Housekeeping (US7)

```text
runScheduledJobs: … → housekeeping (only if no run today after 02:00 IST; marker in activity-free table `job_runs` or
ingestion_runs-like row) → for each RETENTION rule: delete in batches of 1,000 (R2 first for packets) → JSON summary
```

## What to Port from the Reference Repos

The user explicitly approved copying whichever works best. Licences checked in each repo; everything copied is
recorded in `NOTICE` (task T006) with the target file.

| Source (in `/home/user/refs/…`) | Licence | Target | What and why |
|---|---|---|---|
| `erenmyeager15_india-government-tenders-scraper/src/http.ts` (`SourceHttpError`, `SourceBodyLimitError`, `canRetrySource`, `waitForSourceDelay`, `fetchBoundedResource`, `isPdfBody`) | Apache-2.0 | `packages/core/src/gem/http.ts`, used by `packages/core/src/gem/client.ts` and `apps/api/src/services/analyse.ts` | Streaming byte-capped download (aborts at 25 MB instead of buffering an unbounded GeM PDF into a 128 MB isolate), correct retry classification (never retry 4xx except 408), abort-aware delay. Directly serves FR-021/FR-030 and NFR-002. |
| `erenmyeager15_…/.github/workflows/ci.yml` | Apache-2.0 | `.github/workflows/ci.yml` (structure) | Minimal-permission (`contents: read`), `timeout-minutes`, a production-dependency audit step (`pnpm audit --prod --audit-level high`) — adapted to pnpm and our four jobs. |
| `erenmyeager15_…/src/monitoring.ts` (`RETENTION_DAYS`, bounded state constants pattern) | Apache-2.0 | `apps/api/src/services/housekeeping.ts` (pattern only) | Named, test-pinned retention/bounds constants (NFR-009). |
| `ai-sdlc-pilot/.github/workflows/dod-check.yml` (ai-sdlc, already attributed in NOTICE §3) | MIT | `.github/workflows/dod.yml` | PR-time Definition-of-Done check with pinned control-plane script and trailer verification; we inline our own `scripts/dod-check.ts` (verdict file rules from `.aisdlc/qa/verdict-comment.md`) instead of fetching a remote script, to keep CI self-contained. |
| `ai-sdlc-pilot/statuspage.py` (ai-sdlc) | MIT | `docs/runbook.md` § Monitors (idea) | "A status page that silently drops a service is worse than one that fails" → health returns explicit `reasons[]` and `state:'never'` rather than omitting checks. Pattern only, no code. |
| `Giridar33_gem-tender-tracker/.github/workflows/pipeline.yml` | none found | — | Pattern only (secrets vs `vars` for tunables like `MAX_PAGES`, `REQUEST_DELAY`): we expose `GEM_MAX_PAGES`, `GEM_MIN_INTERVAL_MS`, `MANUAL_SYNC_COOLDOWN_MIN` as Worker vars. No code copied (no licence). |
| `arush15june_gem-search` | MIT | — | Already ported for parsing (NOTICE §2); nothing operational to port. |
| Others (`PranavTamada_Tender_Scraper`, `IshanMaheshwari-777_GEM-SCRAPER`, `Mujahid-Alam_gem-tender-pdf-extractor`, `Giri-Aayush_gem`, `rounittxx_gem-bid-scraper`) | — | — | No CI, monitoring or ops code of value (scripts/notebooks); not ported. |

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Partial-index migration locks `tenders` on a large table | `CREATE INDEX CONCURRENTLY` in a non-transactional migration, run off-peak; runbook step. |
| GeM lease row becomes a hot spot | One `UPDATE` per GeM request (≤ 1/s by design) — negligible. |
| Rate-limit table write per request adds latency | Only `api.user`/`api.ip` are global; single upsert ≈ 1–2 ms on pooled connection; fail-open. Re-evaluate with Workers Rate Limiting binding if p95 grows (ADR-0014). |
| Trial backfill locks out existing early users | Backfill gives at least 7 more days; operator can extend via admin endpoint. |
| CSP breaks the theme bootstrap script or Google Fonts | Hash computed by test from `index.html`; fonts allow-listed; E2E smoke checks no CSP console errors. |
| E2E in CI is slow/flaky | `workers: 1`, `retries: 1` in CI (built), evidence uploaded on failure, flaky count in summary. |
| Sentry adds bundle size/CPU to the Worker | Optional; loaded only when `SENTRY_DSN` is set. |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| New Postgres tables for coordination (`gem_throttle`, `rate_limits`) instead of KV/Durable Objects | Cluster-wide state must be shared by all isolates and by the Node path | KV is eventually consistent (cannot count reliably); Durable Objects break the "runs locally with plain Node" principle and add a second stateful system. |
| Non-transactional migration files | `CREATE INDEX CONCURRENTLY` cannot run in a transaction | Plain `CREATE INDEX` would block writes to `tenders` during ingestion. |
