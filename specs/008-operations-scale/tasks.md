---

description: "Task list for 008 Operations & Scale — deployment, CI/CD, security, reliability, observability, plan limits & QA evidence"
---

# Tasks: Operations & Scale — Deployment, CI/CD, Security, Reliability, Observability, Plan Limits & QA Evidence

**Input**: Design documents from `/specs/008-operations-scale/`

**Prerequisites**: plan.md (required), spec.md (required for user stories); architecture input `docs/architecture.md`,
`docs/adr/0001…0014`; contracts/data model of the built system in `specs/001-gem-tender-copilot/{contracts/api.md,data-model.md}`

**Tests**: Requested. API changes get integration tests on real Postgres (`apps/api/test/*.test.ts`); pure logic gets
Vitest unit tests next to the module; every user story gets a Playwright E2E (or, for CI/deploy stories, an
evidence-producing verification script) with screenshots, video, trace and transcripts in `qa/evidence/008/US<n>/`
plus a QA `VERDICT.md`. Review uses the cairn review workflow (`cairn-reviewer`); ai-sdlc conventions in
`CONVENTIONS.md` are for review/QA only.

**Organization**: Tasks are grouped by user story. `- [x]` = already implemented, verified by reading the code on
2026-11-05; `- [ ]` = remaining work (gaps, hardening, missing tests, QA). Each open task is sized at ≤ 1 day.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1…US7)
- File paths are repo-relative to `/home/user/GEMs`

## Path Conventions

- CI/CD: `.github/workflows/{ci,dod,deploy}.yml`, `scripts/{smoke.sh,check-migrations.ts,dod-check.ts,load/}`, `wrangler.toml`
- Constants: `packages/core/src/contracts/{plans,caps}.ts`
- Schema/migrations: `packages/db/src/schema.ts`, `packages/db/migrations/`
- API: `apps/api/src/{lib,middleware,routes,services,adapters}/`, tests `apps/api/test/*.test.ts`
- Web: `apps/web/src/{features/settings/sections,components/layout,lib}/`, `apps/web/public/_headers`
- E2E: `e2e/008-operations-scale/US<n>-*.e2e.ts`, evidence `qa/evidence/008/US<n>/`
- Ops docs: `docs/runbook.md`, `NOTICE`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Harness, attribution, docs and contracts every story relies on

- [x] T001 [P] Playwright harness: desktop 1440×900 + Pixel 7 `@mobile`, video/trace/screenshot always on, IST/en-IN, mock-gem :4011, API+SPA :8788, `retries: 1` on CI, JSON + HTML reporters to `qa/.runs/<port>/` in `playwright.config.ts`; `evidence()` and `collectRunArtifacts()` in `e2e/support/fixtures.ts`; `e2e/support/start-api.sh` NFR-007
- [x] T002 [P] Local/CI Postgres 16 on :5433 via `scripts/local-pg.sh`; API test harness on real Postgres with `TEST_DATABASE_URL` in `apps/api/test/helpers.ts` FR-001
- [x] T003 [P] Architecture review and ADRs 0001–0014 in `docs/architecture.md`, `docs/adr/`; wiki publishes "Spec 008 Operations" in `.github/workflows/wiki-sync.yml` FR-076
- [ ] T004 [P] E2E scaffold: create `e2e/008-operations-scale/` and helpers `evidence008(page, story, name)`, `saveTranscript(story, name, text|json)` (writes `.txt`/`.json` to `qa/evidence/008/<story>/`), `atPhone(page)` (375×812), `noHorizontalOverflow(page)` in `e2e/support/fixtures.ts` FR-005 (#363)
- [ ] T005 [P] Add `@axe-core/playwright` (exact version, shared with 007 T003 if already added) and `a11y(page, name)` helper failing on serious/critical, saving JSON next to evidence in `e2e/support/fixtures.ts` NFR-011 (#364)
- [ ] T006 [P] Port `fetchBoundedResource`, `canRetrySource`, `SourceHttpError`, `SourceBodyLimitError`, `waitForSourceDelay`, `isPdfBody` from `/home/user/refs/erenmyeager15_india-government-tenders-scraper/src/http.ts` to `packages/core/src/gem/http.ts` (fetch-API version, no undici) with unit tests `packages/core/src/gem/http.test.ts`; add NOTICE entry (Apache-2.0) naming the target file and the `ci.yml`/`dod.yml` adaptations in `NOTICE` FR-021, FR-030, NFR-010 (#365)
- [ ] T007 [P] Caps module `MAX_TENDER_DOC_PAGES=300`, `MAX_LLM_CALLS_PER_ANALYSIS=2`, `MAX_LLM_INPUT_CHARS=90_000`, `LLM_CALL_TIMEOUT_MS=60_000`, `ANALYSIS_BUDGET_MS=120_000`, `PACKET_MAX_BYTES=40 MB`, `PACKET_MAX_ITEMS=40`, `JSON_BODY_MAX_BYTES=1 MB`, `MANUAL_SYNC_COOLDOWN_MIN=10` with a test pinning each value in `packages/core/src/contracts/caps.ts`, `packages/core/src/contracts/caps.test.ts` NFR-009, FR-030, FR-031, FR-032, FR-026 (#366)
- [ ] T008 [P] Fold this spec's contract additions (402 `plan_limit_reached`/`plan_expired`, 429 `rate_limited`/`sync_cooldown`, 413 `packet_too_large`, 422 `document_too_long`/`scanned_document`, 503 `gem_busy`, `GET /org/usage`, `POST /admin/orgs/:id/plan`, health v2, `org.trialEndsAt`) into `specs/001-gem-tender-copilot/contracts/api.md` and new tables/columns/indexes into `specs/001-gem-tender-copilot/data-model.md` FR-040 (#367)
- [ ] T009 [P] Remove `SESSION_SECRET` from `specs/001-gem-tender-copilot/plan.md` and replace the secrets list with the one in spec FR-015 FR-015 (#368)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Error helpers, deps interfaces and env every story uses

**⚠️ CRITICAL**: Stories US3–US6 depend on T010–T013

- [x] T010 Consistent error shape `HttpError` + helpers (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`) in `apps/api/src/lib/errors.ts`; `errorHandler` returning 500 `internal_error` with `details.requestId` and logging `rid`/path/stack in `apps/api/src/middleware/error.ts` FR-040, FR-046
- [x] T011 [P] Request id (`x-request-id`, validated incoming or `crypto.randomUUID()`), one log line per request, `cache-control: no-store` on API in `apps/api/src/middleware/request.ts` FR-045
- [ ] T012 Add `paymentRequired(code, message, details)` (402), `tooManyRequests(rule, retryAfter, message)` (429, sets `Retry-After`), `payloadTooLarge(message)` (413), `unprocessable(code, message)` (422), `serviceUnavailable(code, message)` (503) with unit tests in `apps/api/src/lib/errors.ts`, `apps/api/test/foundation.test.ts` FR-018, FR-040 (#369)
- [ ] T013 Extend `AppDeps` with `rateLimiter: RateLimiter`, `errors: ErrorReporter`, `gemLease: GemLease` (interfaces + memory/no-op defaults for tests) and env keys `ADMIN_TOKEN`, `SENTRY_DSN`, `LOG_LEVEL`, `TRUST_PROXY`, `HEALTH_INGESTION_MAX_AGE_MIN`, `MANUAL_SYNC_COOLDOWN_MIN` in `apps/api/src/deps.ts`, `apps/api/src/env.ts`, `apps/api/src/adapters/index.ts`, `apps/api/test/helpers.ts` FR-017, FR-024, FR-046 (#370)

**Checkpoint**: Foundation ready — user stories can proceed in parallel

---

## Phase 3: User Story 1 - Every change is proven by CI with QA evidence before it can merge (Priority: P1) 🎯 MVP

**Goal**: PRs run typecheck, unit, API (Postgres service), E2E with evidence upload, migration checks and a DoD check.

**Independent Test**: Open a PR changing `packages/core`; see 4 green jobs and the `e2e-evidence-<run_id>` artifact; a
PR breaking an API test shows a red required check.

- [x] T014 [P] [US1] Root scripts `typecheck`, `test`, `e2e`, `db:migrate` and package-level `test`/`typecheck` scripts in `package.json`, `apps/api/package.json`, `packages/*/package.json` FR-001
- [x] T015 [P] [US1] QA verdict template and process docs in `.aisdlc/qa/{verdict-comment.md,issuing-a-verdict.md,reading-acceptance-criteria.md}`; DoD in `CONVENTIONS.md`; smoke E2E with evidence in `e2e/000-smoke/smoke.e2e.ts`, `qa/evidence/000-smoke/` FR-004, FR-005
- [ ] T016 [US1] Create `.github/workflows/ci.yml` jobs `typecheck` and `unit` (Node 22, pnpm 10 via `pnpm/action-setup`, store cache, `--frozen-lockfile`, `permissions: contents: read`, `concurrency` cancel-in-progress for PRs, timeouts 10 min, `pnpm audit --prod --audit-level high` step) — structure adapted from erenmyeager15 `ci.yml` FR-001, NFR-007 (#374)
- [ ] T017 [US1] Add `api` job to `.github/workflows/ci.yml`: `services.postgres` (`postgres:16`, `POSTGRES_USER/PASSWORD=tp`, port `5433:5432`, health-cmd `pg_isready`), create `tenderpilot_test`, run `pnpm --filter @tp/api test` with `TEST_DATABASE_URL`, timeout 15 min FR-001 (#375)
- [ ] T018 [US1] Make `e2e/support/start-api.sh` CI-aware: when `E2E_DATABASE_URL` is set, drop/create the database with `psql` against that server instead of calling `scripts/local-pg.sh`; document in `e2e/README.md` FR-001 (#376)
- [ ] T019 [US1] Add `e2e` job to `.github/workflows/ci.yml` (needs `api`): Postgres service, `pnpm exec playwright install --with-deps chromium`, `CI=1 pnpm e2e`, `actions/upload-artifact` `e2e-evidence-${{ github.run_id }}` with `qa/evidence/**` + `qa/.runs/**` (`if: always()`, `retention-days: 30`), timeout 30 min FR-001, FR-002 (#377)
- [ ] T020 [P] [US1] `scripts/e2e-summary.ts`: read `qa/.runs/8788/results.json` and append total/passed/failed/flaky + failed test titles to `$GITHUB_STEP_SUMMARY`; unit test with a fixture JSON in `scripts/e2e-summary.test.ts`; wire into the `e2e` job FR-002 (#378)
- [ ] T021 [P] [US1] `scripts/check-migrations.ts`: flag `DROP TABLE|DROP COLUMN|ALTER COLUMN … TYPE|RENAME|SET NOT NULL` (without default) in new/changed `packages/db/migrations/*.sql` unless line 1 is `-- tp:allow-destructive <reason>`; unit tests in `scripts/check-migrations.test.ts`; `migrations-additive` job in `ci.yml` also runs `pnpm --filter @tp/db generate` and fails on a git diff (schema drift) FR-006 (#379)
- [ ] T022 [P] [US1] Path filters: docs-only PRs (`specs/**`, `docs/**`, `**/*.md` excluding `qa/evidence/**`) run only `typecheck` in `.github/workflows/ci.yml` FR-001 (#380)
- [ ] T023 [US1] `scripts/dod-check.ts` (verdict exists for `spec:<nnn>`/`US<n>` from labels or `Work-Item:` trailer, contains `Verdict: approved`, no `not met` row, ≥ 1 `.png` and ≥ 1 `.webm` in folder, commit trailers `Work-Item`/`Requirement`/`Agent-Role`/`Harness` present) with unit tests `scripts/dod-check.test.ts` FR-004 (#381)
- [ ] T024 [US1] `.github/workflows/dod.yml` on `pull_request` (opened/synchronize/edited/labeled) running `scripts/dod-check.ts` with `GH_TOKEN` read-only, skipped for docs-only PRs — pattern adapted from ai-sdlc `dod-check.yml` FR-004 (#382)
- [ ] T025 [P] [US1] Document branch protection (required checks `typecheck`, `unit`, `api`, `e2e`, `migrations-additive`, `dod`; no force-push) and how to apply it with `gh api repos/:owner/:repo/branches/main/protection` in `docs/runbook.md` § CI FR-003 (#383)
- [ ] T026 [US1] QA: Playwright E2E for US1 with evidence (screenshots, video, trace) in `qa/evidence/008/US1/` — `e2e/008-operations-scale/US1-ci-evidence.e2e.ts` asserts the evidence helpers write png/webm/txt into `qa/evidence/008/US1/` and that `scripts/e2e-summary.ts` parses the run's own `results.json`; plus screenshots of a green PR run, a red API run with disabled merge button, the artifact listing and a failing `dod` check; `VERDICT.md` covering US1 scenarios 1–8 (#384)

**Checkpoint**: Every later story is verified by CI

---

## Phase 4: User Story 2 - Ordered, audited releases to Cloudflare + Neon with staging, custom domain, secrets and backups (Priority: P1)

**Goal**: `deploy.yml` migrates before deploying, staging precedes approved production, headers/HSTS on a custom
domain, pooled Neon URL, raised CPU limit, restore drill and secrets runbook.

**Independent Test**: Merge an additive migration; the deploy log shows staging migrate → deploy → smoke → approval →
production migrate → deploy → smoke; `curl -I` shows HSTS/CSP/nosniff.

- [x] T027 [P] [US2] Single Worker: `/api/*` → Hono with per-request DB + R2, static SPA assets with SPA fallback and `run_worker_first = ["/api/*"]`, cron `*/30 * * * *`, R2 `BLOBS`, `[observability] enabled` in `wrangler.toml`, `apps/api/src/worker.ts`; bootstrap failure → 503 `service_unavailable` FR-009
- [x] T028 [P] [US2] Drizzle migrations via `pnpm db:migrate` (`packages/db/src/migrate.ts`, folder `packages/db/migrations/`); Worker never runs DDL; Node `AUTO_MIGRATE=1` for dev/E2E in `apps/api/src/node.ts` FR-011
- [x] T029 [P] [US2] Session cookie `httpOnly`, `SameSite=Lax`, `Secure` on HTTPS in `apps/api/src/lib/session.ts` FR-013
- [ ] T030 [US2] `wrangler.toml`: `[limits] cpu_ms = 120000`; `workers_dev = false`; production `routes = [{ pattern = "app.tenderpilot.in", custom_domain = true }]`, `APP_URL = "https://app.tenderpilot.in"`; `[env.staging]` with `name = "tenderpilot-staging"`, R2 `tenderpilot-blobs-staging`, staging `APP_URL`/`GEM_BASE_URL`, same crons; update header comment (Workers Paid required) FR-009 (#385)
- [ ] T031 [US2] `scheduled()` awaits `withDeps(…runScheduledJobs…)` (pool close stays in `ctx.waitUntil`) and rethrows when every step failed; Worker unit test with a fake env in `apps/api/src/worker.ts`, `apps/api/test/worker.test.ts` FR-012 (#386)
- [ ] T032 [P] [US2] Security headers middleware: `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS when `https:`; PDF preview/download routes allow same-origin framing only (`Content-Security-Policy: frame-ancestors 'self'`); tests in `apps/api/src/middleware/request.ts`, `apps/api/test/foundation.test.ts` FR-013 (#387)
- [ ] T033 [P] [US2] Static headers for the SPA in `apps/web/public/_headers` (HSTS, nosniff, referrer, permissions, CSP from FR-013 incl. Google Fonts and `sha256` of the inline theme script; `/assets/*` immutable cache) and the same headers in the Node static server `apps/api/src/node.ts` FR-013 (#388)
- [ ] T034 [P] [US2] CSP drift test: compute sha256 of every inline `<script>` in `apps/web/index.html` and assert it appears in `apps/web/public/_headers` CSP in `apps/web/src/lib/csp.test.ts` FR-013 (#389)
- [ ] T035 [P] [US2] `scripts/smoke.sh <base-url> <version>` checking health 200 + version, `/` HTML with `<div id="root">`, `/api/nope` 404 `not_found`, and FR-013 headers; prints a transcript; exit 1 on mismatch FR-008 (#390)
- [ ] T036 [US2] `.github/workflows/deploy.yml`: `workflow_run` on `ci` success for `main` + `workflow_dispatch`; job `staging` (web build → `pnpm db:migrate` with `STAGING_DATABASE_URL` → `wrangler deploy --env staging --var APP_VERSION:${sha::7}` → smoke) and job `production` (`environment: production` with required reviewer → migrate with `PROD_DATABASE_URL` → `wrangler deploy` → smoke); `concurrency: deploy` no cancel; `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` secrets FR-007 (#391)
- [ ] T037 [US2] Replace root `deploy` script with `deploy:manual` that refuses to run unless `ALLOW_MANUAL_DEPLOY=1` and prints the runbook link in `package.json` FR-007 (#392)
- [ ] T038 [P] [US2] `docs/runbook.md` skeleton with sections Monitors, First 10 minutes, Deploy & rollback (`wrangler rollback`; migrations roll forward only), Restore drill, Secrets, Offboarding, CI, LATER triggers (links to ADRs) FR-048, FR-076 (#393)
- [ ] T039 [US2] Runbook § Secrets: table of every secret (`DATABASE_URL` pooled `-pooler` host, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `SENTRY_DSN`, `ADMIN_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STAGING_DATABASE_URL`, `PROD_DATABASE_URL`, `NEON_API_KEY`) with location, owner, rotation steps, blast radius; how to verify the pooled host; enabling GitHub secret scanning + push protection in `docs/runbook.md` FR-010, FR-015 (#394)
- [ ] T040 [US2] Runbook § Restore drill: Neon history retention ≥ 7 days setting, restore procedure (branch at timestamp → compare `tenders`/`organizations` counts → swap `DATABASE_URL` → redeploy), drill log table (date, operator, timestamp restored, minutes) in `docs/runbook.md` FR-014, NFR-006 (#395)
- [ ] T041 [US2] Operator task: set production + staging `DATABASE_URL` to the Neon `-pooler` host, set retention ≥ 7 days, create Neon `staging` branch, attach the custom domain, enable secret scanning; perform the first restore drill on staging and record it in `docs/runbook.md` FR-010, FR-014, FR-015 (#396)
- [ ] T042 [US2] QA: Playwright E2E for US2 with evidence (screenshots, video, trace) in `qa/evidence/008/US2/` — `e2e/008-operations-scale/US2-headers-smoke.e2e.ts` asserts security headers + CSP on `/` and `/api/health` against the local stack, no CSP violations in the console while loading `/`, `/login`, `/dashboard`, `/vault` (PDF preview iframe) on desktop and `@mobile`; attach `scripts/smoke.sh` transcripts for staging and production, deploy run log excerpt showing step order, Neon retention screenshot, restore-drill record; `VERDICT.md` covering US2 scenarios 1–9 (#397)

---

## Phase 5: User Story 3 - A customer's data and quota are protected from other tenants and from abuse (Priority: P1)

**Goal**: Demo data isolation, contract-driven isolation sweep, Postgres rate limiter with rule table, body limits.

**Independent Test**: Org A seeds demo; org B's feed and preview show none of it; 11th wrong-password login → 429.

- [x] T043 [P] [US3] Org scoping on every org-owned query with 404 for foreign ids (Constitution IV) across `apps/api/src/routes/*.ts`; vault upload `content-length` pre-check 413 (20 MB) in `apps/api/src/routes/vault.ts`; tender-document 25 MB cap after read in `apps/api/src/services/analyse.ts` FR-016, FR-021
- [ ] T044 [US3] Demo source: `packages/db/src/demo.ts` upserts tenders with `source: 'demo'` and `raw.demo = true`; demo unique key stays `(source, bid_number)`; update `apps/api/test/demo.test.ts` FR-016 (#398)
- [ ] T045 [US3] Shared tender scope helper `visibleTenderSource(org)` → `source = 'gem' OR (source = 'demo' AND <org has demo>)` in `apps/api/src/lib/tender-scope.ts`; apply in `routes/tenders.ts#buildFilters`, `routes/watchlists.ts#candidateTenders`, `routes/dashboard.ts`, `routes/ingestion.ts` counts (global counts use `source='gem'` only) FR-016 (#399)
- [ ] T046 [US3] Matching only `source = 'gem'` in `apps/api/src/services/ingest.ts` (`matchAndNotify`); demo matches created only by the demo seeder for the seeding org; test that org B gets 0 matches/notifications for demo tenders in `apps/api/test/demo.test.ts` FR-016 (#400)
- [ ] T047 [US3] Data-fix migration: convert existing demo tenders to `source='demo'` and delete foreign-org `tender_matches`/`notifications` referencing them in `packages/db/migrations/` (generated + hand-written SQL), with a migration test on a seeded DB in `apps/api/test/demo.test.ts` FR-016 (#401)
- [ ] T048 [US3] Contract-driven isolation sweep `apps/api/test/isolation.test.ts` (extends 002 T052): parse route list from `specs/001-gem-tender-copilot/contracts/api.md`, create one of each org-scoped resource in org A, call each route as org B with A's ids, assert 404 and unchanged rows; fail on any uncovered org-scoped route FR-016, NFR-005 (#402)
- [ ] T049 [US3] Schema `rate_limits (key, window_start, count, pk(key, window_start))` in `packages/db/src/schema.ts` + migration FR-017 (#403)
- [ ] T050 [US3] `lib/rate-limit.ts#hit(db, key, limit, windowSec, now)` (single `INSERT … ON CONFLICT DO UPDATE … RETURNING count`), memory implementation for unit tests, `resetKey()` for successful-login reset, unit + DB tests in `apps/api/src/lib/rate-limit.ts`, `apps/api/test/ops-limits.test.ts` FR-017 (#404)
- [ ] T051 [P] [US3] Client IP resolution (`cf-connecting-ip` / socket / `x-forwarded-for` only with `TRUST_PROXY=1`) in `apps/api/src/lib/client-ip.ts` with unit tests FR-022 (#405)
- [ ] T052 [US3] Rule table (all rules of FR-019) in `apps/api/src/lib/rate-limit-rules.ts` and `rateLimit(rule)` middleware producing 429 `rate_limited` + `Retry-After`, fail-open except `auth.*` fail-closed 503, `/api/health` exempt in `apps/api/src/middleware/rate-limit.ts` FR-018, FR-019, FR-020 (#406)
- [ ] T053 [US3] Wire rules: global `api.ip`/`api.user` in `apps/api/src/app.ts`; `auth.fail.*` (count only failures, reset email key on success), `auth.signup.ip` in `apps/api/src/routes/auth.ts`; `watchlist.preview.user` in `routes/watchlists.ts`; `upload.org` in `routes/vault.ts` and `routes/analysis.ts`; `gem.fetch.org`, `analyse.user` in `routes/analysis.ts`; `packet.org` in `routes/packets.ts` FR-019 (#407)
- [ ] T054 [US3] Limit+1 → 429 test for every rule (fixed clock, window rollover allows again, `Retry-After` value) and fail-open/closed tests in `apps/api/test/ops-limits.test.ts` FR-018, FR-019, FR-020 (#408)
- [ ] T055 [US3] Generic `bodyLimit(maxBytes)` middleware (content-length pre-check + streaming counter when absent) applied to `POST /tenders/:id/documents` (25 MB), `POST /vault` and `PUT /vault/:id/file` (20 MB), JSON routes (1 MB); 30 MB upload rejected < 200 ms before body read test in `apps/api/src/middleware/body-limit.ts`, `apps/api/test/ops-limits.test.ts` FR-021 (#409)
- [ ] T056 [P] [US3] Web: `ApiError.retryAfter` / `isRateLimited`; login/sign-up/forgot-password show "Too many attempts. Try again in N minutes." inline (role=alert); watchlist editor preview shows "Preview paused — try again in N s" in `apps/web/src/lib/api.ts`, `apps/web/src/features/auth/`, `apps/web/src/features/watchlists/` FR-018, NFR-011 (#410)
- [ ] T057 [US3] Release-gate check: verify spec 002 FR-010/011/018/028 scenarios pass (link 002 QA verdicts) and record the gate in `docs/runbook.md` § Launch checklist FR-023 (#411)
- [ ] T058 [US3] QA: Playwright E2E for US3 with evidence (screenshots, video, trace) in `qa/evidence/008/US3/` — `e2e/008-operations-scale/US3-isolation-abuse.e2e.ts`: two browser contexts (org A seeds demo, org B feed/dashboard/watchlist preview show no demo bid numbers), 11 wrong-password logins → inline 429 message (desktop + 375 px), preview spam → "Preview paused", 30 MB upload → 413 transcript, cookie POST with foreign `Origin` → 403 `bad_origin`; `VERDICT.md` covering US3 scenarios 1–9 (#412)

---

## Phase 6: User Story 4 - The service stays fast and inside platform limits as data grows (Priority: P1)

**Goal**: Cluster-wide GeM lease, atomic single running ingestion, 10-minute cooldown, partial indexes, lean
projections, document/LLM/packet caps.

**Independent Test**: 20 concurrent fetch-documents → mock-gem inter-arrival ≥ 1 s; 500k fixture feed p95 < 300 ms
with partial indexes in `EXPLAIN`.

- [x] T059 [P] [US4] Per-instance GeM throttle (serialised, ≥ `GEM_MIN_INTERVAL_MS`), retry with back-off, honest User-Agent in `packages/core/src/gem/client.ts`; ingestion single-flight read-check + 15-min stale-run reaper in `apps/api/src/services/ingest.ts`; 409 `ingestion_running` in `apps/api/src/routes/ingestion.ts` FR-024, FR-025
- [x] T060 [P] [US4] Scheduled steps isolated (ingestion → alerts → reminders; one failing does not stop others) with a per-step report in `apps/api/src/lib/scheduled.ts`; tender-doc 25 MB cap in `packages/core/src/contracts/analyse.ts` FR-012, FR-030
- [ ] T061 [US4] Schema `gem_throttle (id pk, next_slot_at)` + seed row migration; `lib/gem-lease.ts#acquireGemSlot(db, minIntervalMs, maxWaitMs)` using the DB clock; tests for spacing under 20 concurrent callers (Node, real Postgres) in `packages/db/src/schema.ts`, `apps/api/src/lib/gem-lease.ts`, `apps/api/test/gem-lease.test.ts` FR-024, NFR-002 (#413)
- [ ] T062 [US4] `GemClient` `beforeRequest?: () => Promise<void>` hook called before every HTTP attempt (incl. retries) in `packages/core/src/gem/client.ts` + unit test `packages/core/src/gem/client.test.ts` FR-024 (#414)
- [ ] T063 [US4] Wire the lease into `services/ingest.ts` (maxWait = run budget) and `services/analyse.ts#fetchGemDocument` (maxWait 25 s → 503 `gem_busy` "GeM is busy — we'll retry shortly"); use ported `fetchBoundedResource` for document downloads (abort at 25 MB) FR-024, FR-021 (#415)
- [ ] T064 [US4] Partial unique index `ingestion_runs_one_running_uq ON ((true)) WHERE status='running'` + migration (reap duplicates first); `runIngestion` reaps and inserts in one transaction and maps unique violation to `IngestionBusyError`; cron path logs "ingestion skipped: already running"; concurrency test in `packages/db/src/schema.ts`, `apps/api/src/services/ingest.ts`, `apps/api/test/gem-lease.test.ts` FR-025 (#416)
- [ ] T065 [US4] Manual-sync cooldown 10 min (supersedes 003 T021's 2 min; coordinate so only one implementation lands): 429 `sync_cooldown` with `details.retryAt`, 0 GeM requests; test in `apps/api/src/routes/ingestion.ts`, `apps/api/test/identify.test.ts` FR-026 (#417)
- [ ] T066 [P] [US4] Web cooldown state: Sync now disabled with "Next manual sync at HH:MM IST" tooltip/helper text from `details.retryAt` in `apps/web/src/features/feed/SyncHealth.tsx`, `apps/web/src/features/settings/sections/SyncSection.tsx` FR-026, NFR-011 (#418)
- [ ] T067 [US4] Migration support for non-transactional files (`-- tp:non-transactional` first line → run outside a transaction) in `packages/db/src/migrate.ts` with a test FR-027 (#419)
- [ ] T068 [US4] Partial open-tender indexes (`tenders_open_{created,end,value,state,ministry,category}_idx`, `CONCURRENTLY`) and `analyses_org_tender_created_idx` in `packages/db/src/schema.ts` + non-transactional migration FR-027 (#420)
- [ ] T069 [US4] `notifications_pending_idx (created_at) WHERE status='pending' AND channel IN ('email','whatsapp')` in `packages/db/src/schema.ts` + migration FR-029 (#421)
- [ ] T070 [US4] `tenderListColumns` projection used by feed, preview and dashboard lists (no `raw`, no doc text); `candidateTenders` limited to open, `end_at > now()`, ≤ 2,000 rows in `apps/api/src/routes/{tenders,watchlists,dashboard}.ts` with a query-shape test FR-028 (#422)
- [ ] T071 [P] [US4] Bulk fixture generator (N tenders, 6 % open, realistic states/ministries/values) in `packages/db/src/fixtures/bulk-tenders.ts`; `EXPLAIN (FORMAT JSON)` index-use tests for feed sorts/filters and dispatcher select on 50k rows in `apps/api/test/perf-indexes.test.ts` FR-027, FR-029, FR-033 (#423)
- [ ] T072 [P] [US4] Load scripts `scripts/load/feed.sh` (N concurrent `GET /api/tenders` variants, reports p50/p95 and non-2xx count) and `scripts/load/gem-fetch.sh` (20 concurrent fetch-documents, then reads mock-gem request log inter-arrival) FR-033, NFR-001 (#424)
- [ ] T073 [US4] Page cap 300 → 422 `document_too_long`; scanned PDF → 422 `scanned_document` on analyse; no row written; tests in `apps/api/src/services/analyse.ts`, `apps/api/test/analyse.test.ts` FR-030 (#425)
- [ ] T074 [US4] LLM budget per analysis (≤ 2 calls, ≤ 90k chars, 60 s/call timeout, 120 s overall) with rules-only fallback and warning `llm_budget_exhausted`; 5-doc test with fake LLM asserts ≤ 2 calls in `apps/api/src/services/analyse.ts`, `apps/api/test/analyse.test.ts` FR-031 (#426)
- [ ] T075 [P] [US4] Render analysis warnings `llm_budget_exhausted` ("AI review covered X of Y documents; the rest were checked by rules only.") and `llm_quota_reached` in the analysis panel in `apps/web/src/features/tender/` FR-031, FR-037 (#427)
- [ ] T076 [US4] Packet pre-flight: sum blob sizes (+512 KB per generated page) and item count; > 40 MB or > 40 items → 413 `packet_too_large` before any row/blob; `packetBuildSchema.items.max(40)`; 45 MB test in `apps/api/src/services/packet.ts`, `packages/core/src/contracts/apply.ts`, `apps/api/test/packet.test.ts` FR-032 (#428)
- [ ] T077 [US4] QA: Playwright E2E for US4 with evidence (screenshots, video, trace) in `qa/evidence/008/US4/` — `e2e/008-operations-scale/US4-capacity.e2e.ts`: Sync now twice → cooldown tooltip (desktop + 375 px) and 0 mock-gem requests; 301-page and scanned PDF uploads show the 422 messages; oversized packet shows the 413 message; 5-doc analysis shows the budget warning; attach `gem-fetch.sh` inter-arrival transcript, `feed.sh` p95 transcript and `EXPLAIN` JSON for each index; `VERDICT.md` covering US4 scenarios 1–10 (#429)

---

## Phase 7: User Story 5 - Plans, trial expiry and AI usage are metered and enforced (Priority: P1)

**Goal**: `PLAN_LIMITS`, trial end, 402 contract, `llm_usage`, `/org/usage`, Plan & usage UI, banners, admin plan flip.

**Independent Test**: Trial org → 11th analysis 402; clock +15 d → writes 402 `plan_expired`, reads 200; admin flip to
starter → writes OK.

- [x] T078 [P] [US5] `organizations.plan` (default `trial`) returned in `/auth/me` and `/org`, displayed with blurbs in Settings → Organization in `packages/db/src/schema.ts`, `apps/api/src/lib/me.ts`, `apps/web/src/features/settings/sections/OrganizationSection.tsx` FR-034
- [ ] T079 [US5] `PLAN_LIMITS` + `TRIAL_DAYS` + `PlanKey` type with a pinning test, in the same file as 007's `PLANS` display config, in `packages/core/src/contracts/plans.ts`, `packages/core/src/contracts/plans.test.ts` FR-034 (#430)
- [ ] T080 [US5] `organizations.trial_ends_at` + migration with backfill `greatest(created_at + 14 d, now() + 7 d)` for trials; set at sign-up; return `org.trialEndsAt` from `/auth/me` and `/org` in `packages/db/src/schema.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/lib/me.ts`, `apps/api/src/routes/org.ts` FR-035 (#431)
- [ ] T081 [US5] Schema `llm_usage` and `subscriptions` + migrations in `packages/db/src/schema.ts` FR-039, FR-042 (#432)
- [ ] T082 [US5] `lib/plan.ts`: `usageFor(deps, orgId)` (seats incl. pending invites, watchlists, analyses/LLM analyses/packets this IST month, vault bytes) and `assertWithinPlan(deps, orgId, limit, increment)` → 402 `plan_limit_reached` with `{limit, used, max, plan, resetsAt}`; unit tests for IST month boundaries in `apps/api/src/lib/plan.ts`, `apps/api/test/plan.test.ts` FR-036 (#433)
- [ ] T083 [US5] Enforce at watchlist create (`routes/watchlists.ts`), invitation create (`routes/org.ts`), vault upload bytes (`routes/vault.ts`), packet build (`routes/packets.ts`) with per-resource 402 tests and enterprise-never-limited tests in `apps/api/test/plan.test.ts` FR-036, FR-043 (#434)
- [ ] T084 [US5] Analyse quota: transaction with `SELECT … FOR UPDATE` on the org row, count, insert `analyses(running)`; 11th trial analysis → 402 and no row; concurrent-request test in `apps/api/src/services/analyse.ts`, `apps/api/test/plan.test.ts` FR-036 (#435)
- [ ] T085 [US5] LLM metering: insert one `llm_usage` row per LLM call (tokens from `LlmResult.usage`); `llmAnalysesPerMonth` exhausted → rules-only with warning `llm_quota_reached`; tests assert token totals equal the fake LLM's in `apps/api/src/services/analyse.ts`, `apps/api/test/plan.test.ts` FR-037, FR-039 (#436)
- [ ] T086 [US5] `requireActivePlan` middleware: expired trial → 402 `plan_expired` for writes outside the FR-038 allow-list; GETs pass; tests for every allow-listed route and a sample of blocked writes in `apps/api/src/middleware/plan.ts`, `apps/api/src/app.ts`, `apps/api/test/plan.test.ts` FR-038 (#437)
- [ ] T087 [US5] `GET /api/org/usage` (any member) returning FR-039 shape in `apps/api/src/routes/org.ts` with test FR-039 (#438)
- [ ] T088 [US5] Admin endpoint `POST /api/admin/orgs/:id/plan` (Bearer `ADMIN_TOKEN`, constant-time compare, unset → 404), writes `subscriptions`, updates plan/trial, logs `org.plan_changed`; tests incl. wrong token 404 in `apps/api/src/routes/admin.ts`, `apps/api/src/app.ts`, `apps/api/test/plan.test.ts` FR-042, FR-043 (#439)
- [ ] T089 [P] [US5] Web: global 402 handling → `PlanLimitDialog` (title, message, used/max, "Talk to sales", "Close"; bottom sheet at 375 px) in `apps/web/src/components/layout/PlanLimitDialog.tsx`, `apps/web/src/lib/api.ts`, `apps/web/src/app/` query client config FR-041, NFR-011 (#440)
- [ ] T090 [P] [US5] Web: `TrialBanner` (≤ 7 days left, dismissible per IST day for owner/bid_manager; expired non-dismissible for all, write buttons open the dialog) in `apps/web/src/components/layout/TrialBanner.tsx`, `apps/web/src/components/layout/AppShell.tsx` FR-041 (#441)
- [ ] T091 [US5] Web: Settings → Plan & usage (`/settings/usage`) with six meters (`role="progressbar"`, amber ≥ 80 %, red 100 %, "Unlimited" for null), trial line, reset date, loading/error states, responsive grid in `apps/web/src/features/settings/sections/UsageSection.tsx`, `apps/web/src/features/settings/SettingsPage.tsx`, `apps/web/src/features/settings/api.ts` FR-041, NFR-011 (#442)
- [ ] T092 [US5] QA: Playwright E2E for US5 with evidence (screenshots, video, trace) in `qa/evidence/008/US5/` — `e2e/008-operations-scale/US5-plans.e2e.ts`: Plan & usage page (desktop + 375 px + dark theme + axe), trial banner, 11th analysis → dialog (uses a test-only `E2E_TRIAL_ANALYSES` override or seeded usage), expired trial via admin endpoint `trialEndsAt` in the past → read-only banner and blocked writes while feed/vault downloads work, admin flip to starter restores writes; `VERDICT.md` covering US5 scenarios 1–12 (#443)

---

## Phase 8: User Story 6 - Operators are paged when ingestion, alerts or the API degrade (Priority: P1)

**Goal**: Health v2, JSON logs with redaction, error reporter, monitor and runbook.

**Independent Test**: Fixed clock, last success 3 h ago → 503 `ingestion_stale`; unhandled error → JSON log with `rid`,
`orgId` and reporter called once.

- [x] T093 [P] [US6] `GET /api/health` → `{ok, db, version}`, 503 when `select 1` fails in `apps/api/src/app.ts`; sync health UI (Healthy / Delayed > 2 h / Last run failed / Not synced yet) in `apps/web/src/features/feed/SyncHealth.tsx`, `apps/web/src/features/settings/sections/SyncSection.tsx`; Workers observability enabled in `wrangler.toml` FR-044, FR-047
- [ ] T094 [US6] Health v2: ingestion `lastSuccessAt/ageMinutes/lastStatus/state`, `alerts.pendingOlderThan30m`, `reasons[]`, 503 rules, 3 s per-query timeout, `HEALTH_INGESTION_MAX_AGE_MIN`; tests for healthy, stale (3 h), never, backlog, db down in `apps/api/src/app.ts` (extract to `apps/api/src/routes/health.ts`), `apps/api/test/health.test.ts` FR-044 (#444)
- [ ] T095 [US6] JSON-line logger with levels (`LOG_LEVEL`), `ts`, and key redaction (`/password|token|secret|cookie|authorization/i`) in `apps/api/src/adapters/logger.ts` + unit tests FR-045, NFR-008 (#445)
- [ ] T096 [US6] Request log `{msg:"request", rid, method, path (no query), status, ms, orgId, userId}` after auth resolves; health at `debug`; test that a login request log contains no password/cookie in `apps/api/src/middleware/request.ts`, `apps/api/test/health.test.ts` FR-045 (#446)
- [ ] T097 [US6] `ErrorReporter` adapters: no-op default, `@sentry/cloudflare` (Worker) / `@sentry/node` (Node) when `SENTRY_DSN` set, release `APP_VERSION`, environment; called from `middleware/error.ts` (unhandled only) and `lib/scheduled.ts` (step failure with `job`); tests with a fake reporter in `apps/api/src/adapters/errors.ts`, `apps/api/src/worker.ts`, `apps/api/src/node.ts`, `apps/api/test/health.test.ts` FR-046 (#447)
- [ ] T098 [US6] Runbook § Monitors and § First 10 minutes (per reason `db_unreachable`, `ingestion_stale`, `alerts_backlog`, 5xx spike, GeM 403/429) with exact queries (`select … from ingestion_runs order by started_at desc limit 5`), Workers Logs filters by `rid`/`orgId`, and escalation in `docs/runbook.md` FR-047, FR-048 (#448)
- [ ] T099 [US6] Operator task: configure the external uptime monitor (production every 5 min, alert after 2 failures; separate staging monitor), run a staging fire drill (stop cron / point `GEM_BASE_URL` at a dead host) and record detection time in `docs/runbook.md` FR-047, SC-009 (#449)
- [ ] T100 [US6] QA: Playwright E2E for US6 with evidence (screenshots, video, trace) in `qa/evidence/008/US6/` — `e2e/008-operations-scale/US6-health.e2e.ts`: health JSON on a fresh stack (`state:"never"`, 200), after a mock-gem sync (`state:"ok"`), Settings → Sync health screenshots (desktop + 375 px); attach API-test transcripts for stale/backlog/db-down 503s, a JSON log excerpt with `rid`/`orgId`, a Sentry (or fake reporter) event matching `x-request-id`, monitor configuration and fire-drill screenshots; `VERDICT.md` covering US6 scenarios 1–10 (#450)

---

## Phase 9: User Story 7 - Costs, query time and stored data stay proportional as usage grows (Priority: P2)

**Goal**: Shared extraction cache, full-text search, matcher efficiency, housekeeping/retention, Resend batch,
Hyperdrive.

**Independent Test**: Two orgs analyse the same GeM document → one LLM call; fixed-clock housekeeping deletes exactly
the expected rows/blobs.

- [x] T101 [P] [US7] Idempotent `BlobStore.delete` (missing key not an error) in `apps/api/src/deps.ts`, `apps/api/src/adapters/{blob-r2,blob-fs,memory-blob}.ts`; notification dedupe unique `(user_id, channel, dedupe_key)` in `packages/db/src/schema.ts` FR-070
- [ ] T102 [US7] Extraction cache columns on `tender_documents` + migration; `CURRENT_EXTRACTOR_VERSION` constant with pinning test; analysis reuses cached requirements for org-null documents; two-org one-LLM-call test in `packages/db/src/schema.ts`, `packages/core/src/analyse/`, `apps/api/src/services/analyse.ts`, `apps/api/test/analyse.test.ts` FR-072 (#451)
- [ ] T103 [US7] Generated `tenders.search` tsvector + `tenders_search_gin` (non-transactional migration); `websearch_to_tsquery('simple', q)` + bid-number prefix in `buildFilters` and `candidateTenders`; tests for phrase, multi-word and bid-number search in `packages/db/src/schema.ts`, `apps/api/src/routes/{tenders,watchlists}.ts`, `apps/api/test/identify.test.ts` FR-073 (#452)
- [ ] T104 [P] [US7] `compileCriteria()` precompiling keyword/exclude regexes once per watchlist per run; benchmark test 1,000 watchlists × 500 tenders < 5 s in `packages/core/src/match/matcher.ts`, `packages/core/src/match/matcher.test.ts` FR-074 (#453)
- [ ] T105 [US7] Batched match inserts (≤ 500 rows per statement) in `apps/api/src/services/ingest.ts` with test FR-074 (#454)
- [ ] T106 [US7] `Mailer.sendMany` via Resend `/emails/batch` (≤ 100 per call), used by the dispatcher; 120 emails → 2 provider calls test in `apps/api/src/adapters/mailer.ts`, `apps/api/src/services/alerts.ts`, `apps/api/test/identify.test.ts` FR-074 (#463)
- [ ] T107 [US7] `services/housekeeping.ts` with `RETENTION` table (FR-070), batch deletes of 1,000, R2-first for packets (keep newest 5 per workspace), `tenders.raw` nulling, `rate_limits` pruning; daily gating after 02:00 IST; JSON summary log FR-070 (#464)
- [ ] T108 [US7] Add `housekeeping` step to `runScheduledJobs` and a fixed-clock test that prunes exactly the expired rows/blobs and a second run deletes 0 in `apps/api/src/lib/scheduled.ts`, `apps/api/test/housekeeping.test.ts` FR-070 (#465)
- [ ] T109 [P] [US7] R2 lifecycle rule for `org/*/packets/` (365 days) documented with the `wrangler r2 bucket lifecycle add` command; offboarding procedure (org delete cascade + R2 prefix purge) in `docs/runbook.md` FR-071, FR-048 (#466)
- [ ] T110 [US7] Hyperdrive: `[[hyperdrive]]` binding (`caching.disabled = true`) in `wrangler.toml` (prod + staging), `worker.ts` uses `createNodeDb(env.HYPERDRIVE.connectionString, { max: 5 })`; delete `createNeonDb` and `@neondatabase/serverless` from `packages/db`; update `specs/001-gem-tender-copilot/plan.md` FR-075 (#467)
- [ ] T111 [US7] Staging verification of Hyperdrive: `scripts/load/feed.sh` 50 concurrent → 0 connection errors, health p50 < 150 ms; transcript in `qa/evidence/008/US7/` FR-075, NFR-003 (#468)
- [ ] T112 [P] [US7] Runbook § LATER triggers linking ADR-0004/0007/0010/0011/0013 (Queues, RLS, Razorpay, Analytics Engine, weekly `pg_dump` to R2) with the measurable trigger for each in `docs/runbook.md` FR-076 (#469)
- [ ] T113 [US7] QA: Playwright E2E for US7 with evidence (screenshots, video, trace) in `qa/evidence/008/US7/` — `e2e/008-operations-scale/US7-efficiency.e2e.ts`: two orgs analyse the same mock-gem tender (second analysis shows the same requirements; fake-LLM call count transcript = 1), feed search "solar street light" and bid-number prefix return results (desktop + 375 px); attach housekeeping test transcript, Resend batch call-count transcript, Hyperdrive load transcript; `VERDICT.md` covering US7 scenarios 1–8 (#470)

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T114 [P] Update `README.md` (Operations section: CI, deploy, environments, runbook link) and `wrangler.toml` header comment; remove stale `pnpm deploy` instructions FR-007, FR-048 (#371)
- [ ] T115 [P] Run `/cairn-analyze` on spec 008 against 002/003/007 to confirm no duplicate ownership (cooldown, retries, plans file, isolation test) and record results in `specs/008-operations-scale/checklists/requirements.md` FR-023 (#372)
- [ ] T116 Launch checklist in `docs/runbook.md` § Launch checklist: every MUST (ARCH-01…ARCH-13) mapped to its task and QA verdict; all P1 verdicts `approved` before the first plan flip to a paid plan FR-023, SC-001 (#373)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies; T006/T007 before US4 tasks that use them.
- **Foundational (Phase 2)**: T012, T013 block US3–US6.
- **US1 (Phase 3)**: independent; recommended first so every later story is verified by CI.
- **US2 (Phase 4)**: T030–T036 independent of US3–US7; T041 (operator) needs T030/T039.
- **US3 (Phase 5)**: needs T012/T013; T049 → T050 → T052 → T053 → T054; T044 → T045 → T046 → T047; T048 after T045.
- **US4 (Phase 6)**: T061 → T062 → T063; T067 → T068; T064 and T065 independent; T073/T074/T076 need T007.
- **US5 (Phase 7)**: T079 → T080/T081 → T082 → T083/T084/T085/T086/T087/T088; web T089–T091 after T087.
- **US6 (Phase 8)**: T094–T097 need T013; T098/T099 after T094.
- **US7 (Phase 9)**: T102 after T085 (shares analyse code); T103 after T067; T107 → T108; T110 → T111.
- **Polish**: after all P1 stories.

### Within Each User Story

- Schema + migration → lib → route/middleware → tests → web → QA E2E + verdict.
- QA task is last in each story and requires CI (US1) to upload its evidence.

### Parallel Opportunities

- Phase 1 T004–T009 all [P].
- US1 T020/T021/T022 in parallel after T016.
- US2 T032/T033/T034/T035/T038 in parallel.
- US3 T051 and T056 in parallel with the limiter chain; demo chain (T044–T048) parallel to limiter chain (T049–T055).
- US4 index work (T067–T072) parallel to caps (T073–T076) and lease (T061–T063).
- US5 web tasks T089/T090 in parallel.
- Different stories can be staffed in parallel after Phase 2.

## Implementation Strategy

### MVP First

1. Phase 1 + 2 → US1 (CI gate) → US3 demo isolation (T044–T047, live defect) → US2 (deploy pipeline).
2. Then US4, US5, US6 (all MUST before paying customers), each closed with its QA verdict.
3. US7 in the first paid quarter.

### Notes

- Every open task maps to FR ids; `- [x]` tasks are the built baseline and must not be re-implemented.
- Ownership: 002 owns auth hardening (T057 is a gate only), 003 owns notification retries and the cooldown contract
  (T065 changes its duration), 007 owns `PLANS` display (T079 adds `PLAN_LIMITS` alongside).
- Do not commit QA traces (large); commit screenshots, videos ≤ 10 MB and `VERDICT.md`; traces live in the CI artifact.
