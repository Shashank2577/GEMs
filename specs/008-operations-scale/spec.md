# Feature Specification: Operations & Scale — Deployment, CI/CD, Security, Reliability, Observability, Plan Limits & QA Evidence

**Feature Branch**: `008-operations-scale`

**Created**: 2026-11-05

**Status**: In Progress

**Input**: User description: "Operations area of TenderPilot in detail: Cloudflare Worker + static assets + Cron + R2 + Neon
deployment, CI/CD (GitHub Actions: typecheck, unit, API tests with a Postgres service, Playwright E2E with evidence
upload), environments, secrets, migrations, scalability & reliability, security hardening, observability, plan limits /
billing readiness, backups, QA evidence process (qa/evidence) and Definition of Done enforcement. Base the stories on
the architecture review (docs/architecture.md, docs/adr/0001–0014, recommendations ARCH-01…ARCH-26); MUST-before-
paying-customers items are P1."

**Parent spec**: [`specs/001-gem-tender-copilot/spec.md`](../001-gem-tender-copilot/spec.md) — NFR-001 (feed/dashboard
< 2 s p95), NFR-002 (≤ 1 request/s to GeM), NFR-003 (isolation), NFR-005 (graceful degradation), NFR-006 (edge
deployable, runs locally), NFR-007 (E2E per story). Architecture input: [`docs/architecture.md`](../../docs/architecture.md)
and [`docs/adr/`](../../docs/adr/README.md). This spec describes what is **built today** (verified against the code on
2026-11-05) and adds requirements for the gaps that matter before the first paying customer. Requirements and
scenarios marked *(gap)* are not implemented yet; everything else is implemented.

**Ownership boundaries** (to avoid duplicate work across specs):

| Recommendation | Owned by | This spec's role |
|---|---|---|
| ARCH-12 password reset (002 FR-011), `bad_origin` (002 FR-028), invite email binding (002 FR-018) | spec 002 | Release gate: 002 scenarios must pass before paid launch (FR-023) |
| ARCH-13 isolation sweep test (002 T052) | spec 002 | Extended here to every route in `contracts/api.md` and made a CI gate (FR-016) |
| ARCH-11 auth failure limits (002 FR-010) | spec 002 (rules) | Generic limiter infrastructure + all non-auth rules live here (FR-017…FR-022) |
| ARCH-19 notification retries (003 `notifications.attempts`, T077) | spec 003 | Only the pending-notifications index (FR-029) and Resend batch (FR-074) live here |
| ARCH-03 manual-sync cooldown (003 FR-013, 2 min) | spec 003 (contract `429 sync_cooldown`) | This spec **raises the cooldown to 10 minutes** and makes it cluster-wide (FR-026) |
| Pricing display `PLANS` (007 FR-082, T067) | spec 007 | `PLAN_LIMITS` is added to the same `packages/core/src/contracts/plans.ts` (FR-034) |

## Personas affected

| Persona | Role | What they need from this area |
|---|---|---|
| **Owner (MSME founder, paying customer)** | `owner` | The app is up every morning, alerts arrive on time, their company data never shows up for another org, they understand their plan, usage and when the trial ends; a clear message when a limit is reached. |
| **Bid Manager / Analyst / Viewer** | `bid_manager` / `analyst` / `viewer` | Fast feed and dashboard; analyses that finish or fail with an honest message instead of a timeout; sensible "try again in N seconds" when they click too often. |
| **Operator / on-call engineer (TenderPilot team)** | none (GitHub + Cloudflare + Neon access) | A one-command, ordered, audited release (tests → migrate → deploy); a health endpoint and an external monitor that page them when ingestion stalls; JSON logs filterable by request/org; a runbook; restore drills. |
| **Developer (contributor, incl. AI agents)** | none (GitHub) | CI that runs typecheck, unit, API (real Postgres) and E2E tests on every PR; additive-only migrations; one place for limits and caps. |
| **QA engineer** | none (GitHub) | Every story has a Playwright run whose screenshots, video and trace land in `qa/evidence/<spec>/US<n>/` and are attached to the CI run; a verdict file per story that the Definition-of-Done check enforces. |
| **GeM (BidPlus) as a third party** | n/a | TenderPilot stays a polite, public-only client: ≤ 1 request/second cluster-wide, honest User-Agent, back-off (Constitution II). |

Role hierarchy: `owner` > `bid_manager` > `analyst` > `viewer`. API errors always have the shape
`{ "error": { "code", "message", "details?" } }` (`apps/api/src/lib/errors.ts`). Every API response carries an
`x-request-id` header (`apps/api/src/middleware/request.ts`).

## What is built today (baseline, verified 2026-11-05)

- **One Worker** (`wrangler.toml`, `apps/api/src/worker.ts`): `/api/*` → Hono app (`apps/api/src/app.ts`); everything
  else → static SPA assets (`[assets] directory = "apps/web/dist"`, `not_found_handling = "single-page-application"`,
  `run_worker_first = ["/api/*"]`). R2 binding `BLOBS` (`tenderpilot-blobs`). Cron `*/30 * * * *` → `runScheduledJobs`
  (ingestion → alerts → reminders, each step isolated; `apps/api/src/lib/scheduled.ts`). `[observability] enabled = true`.
  `APP_URL = "https://tenderpilot.workers.dev"`. No `[limits]`, no `[env.staging]`, no custom domain, no Hyperdrive.
- **DB access on Workers**: `createNeonDb(DATABASE_URL)` opens a new `@neondatabase/serverless` `Pool` per request and
  closes it in `ctx.waitUntil` (`packages/db/src/client.ts`). Node/CI uses `createNodeDb` (`pg`, `max: 10`).
- **Scheduled handler** wraps the job in `ctx.waitUntil(...)` instead of awaiting it.
- **Node entry** (`apps/api/src/node.ts`): same app, FS blob store, `AUTO_MIGRATE=1`, optional in-process cron
  (`CRON_INTERVAL_MS`), static SPA with immutable `/assets/*` caching.
- **Migrations**: Drizzle, one file `packages/db/migrations/0000_last_shocker.sql`; `pnpm db:migrate`
  (`packages/db/src/migrate.ts`). Deploy is `pnpm deploy` from a laptop (web build + `wrangler deploy`).
- **Health**: `GET /api/health` → `{ ok, db, version }`, 200 or 503 when `select 1` fails. No ingestion staleness.
- **Logging**: `consoleLogger` prints `[tp] <msg> {json}` (not JSON lines); one line per request with `rid` only.
  `errorHandler` logs unhandled errors with `rid`, path and 6 stack lines and returns 500 `internal_error` with
  `details.requestId`.
- **Security**: session cookie `httpOnly`, `SameSite=Lax`, `Secure` on HTTPS (`apps/api/src/lib/session.ts`);
  `cache-control: no-store` on API responses; vault upload `content-length` pre-check (20 MB, 413) and tender-doc
  upload 25 MB cap (413). **No** HSTS/CSP/nosniff headers, **no** rate limiting, **no** Origin check.
- **GeM politeness**: `GemClient` serialises and spaces requests ≥ `GEM_MIN_INTERVAL_MS` (default 1000) — but only
  **within one client instance**; ingestion single-flight is a read-then-insert check on `ingestion_runs` (racy) with
  a 15-minute stale-run reaper. `POST /api/ingestion/run` (bid_manager+) has no cooldown.
- **Indexes**: `tenders` has only `(source,bid_number)` unique, `(end_at)`, `(state)`; `analyses (org_id, tender_id)`;
  `notifications (org_id,user_id,created_at)` and dedupe unique; nothing for `status='pending'` or `status='open'`.
- **Demo data**: `packages/db/src/demo.ts` upserts 40 fake tenders into the **global** `tenders` table with
  `source: 'gem'` — visible to and matched for every organisation (ARCH-01 defect).
- **Plans**: `organizations.plan` (`trial|starter|pro|enterprise`, default `trial`) is displayed in Settings →
  Organization ("Free trial — All Pro features for 14 days. No card needed.") but never enforced; there is no trial
  end date; landing and sign-up promise a "14-day free trial".
- **Testing/QA**: 247 core unit tests, 145 API tests on real Postgres (`TEST_DATABASE_URL`, default
  `postgres://tp:tp@localhost:5433/tenderpilot_test`), Playwright harness (`playwright.config.ts`: desktop 1440×900 +
  Pixel 7 `@mobile`, video/trace/screenshot always on, IST/en-IN, mock-gem on :4011, API+SPA on :8788) with
  `evidence()` / `collectRunArtifacts()` helpers writing to `qa/evidence/<spec>/<story>/`; one smoke E2E
  (`e2e/000-smoke/smoke.e2e.ts`). GitHub Actions has only `project-board.yml` and `wiki-sync.yml` — **no CI test
  workflow and no deploy workflow**.

## User Scenarios & Testing *(mandatory)*

> QA conventions: API scenarios run against the Node server (`pnpm --filter @tp/api start`) or the E2E stack (`pnpm e2e`,
> API + built SPA on :8788, fresh `tenderpilot_e2e` DB, mock-gem on :4011, time zone `Asia/Kolkata`, locale `en-IN`).
> "Fresh org" = `signupViaApi()` (Owner, plan `trial`). Scenarios needing a controlled clock use the API test harness
> (`apps/api/test/helpers.ts`, fixed `deps.clock`). Scenarios tagged **[staging]** are verified on the staging Worker
> (`tenderpilot-staging`) with `curl` and screenshots of the Cloudflare/Neon/GitHub consoles attached as evidence.
> Phone checks use a 375 × 812 viewport. Evidence for story n goes to `qa/evidence/008/US<n>/`.

### User Story 1 - Every change is proven by CI with QA evidence before it can merge (Priority: P1) (#356)

A developer opens a pull request. GitHub Actions runs typecheck, core unit tests, API integration tests against a
Postgres 16 service container, builds the web app, and runs the Playwright E2E suite against the real API + SPA +
mock-gem. Screenshots, videos, traces and the HTML report are uploaded as a run artifact. A Definition-of-Done check
blocks merging a story PR whose `qa/evidence/<spec>/US<n>/VERDICT.md` is missing or not `approved`.

**Why this priority**: Nothing else in this spec is safe without an automated gate — today tests run only on
laptops and the constitution (VI) says a story is not done until its E2E passes. It is also what makes QA evidence
reviewable by people who never run the stack.

**Independent Test**: Open a PR that changes one line in `packages/core`; observe the `ci` workflow's four jobs and the
uploaded `e2e-evidence` artifact; then open a PR that breaks one API test and observe a red required check.

**Acceptance Scenarios**:

1. **Given** a PR against `main`, **When** it is opened or updated, **Then** workflow `ci` starts jobs `typecheck`,
   `unit`, `api`, `e2e` (in that dependency order: `unit` and `typecheck` in parallel, `api` after `unit`, `e2e` after
   `api`), all on `ubuntu-latest` with Node 22 and `pnpm install --frozen-lockfile`, and each job has `timeout-minutes`
   (typecheck 10, unit 10, api 15, e2e 30).
2. **Given** the `api` job, **When** it runs, **Then** it uses a `postgres:16` service with user/password `tp`/`tp` on
   port 5433, sets `TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test`, and the log shows
   `Test Files … passed` with ≥ 145 API tests and 0 failures.
3. **Given** a PR that makes one API test fail, **When** CI finishes, **Then** the `api` check is red, `e2e` is skipped,
   and branch protection on `main` shows "Required statuses must pass before merging" (merge button disabled).
4. **Given** the `e2e` job, **When** it finishes (pass or fail), **Then** an artifact named `e2e-evidence-<run_id>`
   is uploaded containing `qa/evidence/**` and `qa/.runs/**` (HTML report, `results.json`, traces, videos) with
   `retention-days: 30`, and the job summary lists passed/failed/flaky counts from `results.json`.
5. **Given** an E2E test that fails on the first attempt and passes on retry, **When** the summary is written,
   **Then** it is reported as "flaky: 1" and its trace from the failed attempt is in the artifact.
6. **Given** a PR whose title or body references a story (`Work-Item:` trailer / `Closes #<story issue>`) for spec
   `<nnn>` story `US<n>`, **When** the `dod` workflow runs, **Then** it fails with "Missing QA verdict:
   qa/evidence/<nnn>/US<n>/VERDICT.md" if the file is absent, fails with "QA verdict is not approved" if it does not
   contain `Verdict: approved`, and fails if any acceptance criterion row in it is `not met`; otherwise it passes.
7. **Given** a docs-only PR (only `specs/**`, `docs/**`, `*.md` outside `qa/evidence`), **When** it is opened,
   **Then** `ci` runs only `typecheck` (path filter) and finishes in < 5 minutes, and `dod` is skipped.
8. **Given** a push to `main`, **When** `ci` succeeds, **Then** the deploy workflow (US2) is allowed to start; when it
   fails, no deploy runs.

---

### User Story 2 - Ordered, audited releases to Cloudflare + Neon with staging, custom domain, secrets and backups (Priority: P1) (#357)

A merge to `main` triggers `deploy`: build → apply migrations to the staging Neon branch → deploy the staging Worker →
smoke-test staging → wait for a manual approval → apply migrations to production → deploy the production Worker →
smoke-test production. Production is served from a custom domain with HSTS. The Worker uses the pooled Neon endpoint,
has a raised CPU limit, and Neon keeps ≥ 7 days of history so any incident can be restored into a branch.

**Why this priority**: Today deploys and migrations run from a laptop in no guaranteed order; a migration applied after
a deploy, or forgotten, breaks every customer at once. `workers.dev` cannot carry HSTS or WAF rules, and the default
Neon direct endpoint caps at ~112 connections while each request opens a pool (ARCH-02, ARCH-06, ARCH-10, ARCH-21).

**Independent Test**: Merge a PR that adds a nullable column; watch the `deploy` run log show `db:migrate (staging)` →
`wrangler deploy --env staging` → smoke → approval → `db:migrate (production)` → `wrangler deploy` in that order, then
`curl -I https://app.tenderpilot.in/` shows HSTS.

**Acceptance Scenarios**:

1. **Given** a push to `main` with green `ci`, **When** `deploy` runs, **Then** its log shows, in order:
   `pnpm --filter @tp/web build`, `pnpm db:migrate` with `DATABASE_URL` = staging secret, `wrangler deploy --env
   staging`, `smoke (staging)`, a pending `production` environment approval, `pnpm db:migrate` with the production
   secret, `wrangler deploy`, `smoke (production)`; a failure in any step stops all later steps.
2. **Given** the smoke step, **When** it runs against an environment, **Then** it calls `GET /api/health` (expects 200 and
   `version` = the commit's `APP_VERSION`), `GET /` (expects 200 `text/html` containing `<div id="root">`), and
   `GET /api/nope` (expects 404 JSON `not_found`); any mismatch fails the job.
3. **Given** a migration file that contains `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN … TYPE`, `RENAME` or
   `SET NOT NULL` without a default, **When** `ci` runs, **Then** the `migrations-additive` check fails with the file
   name and offending statement, unless the file starts with the comment `-- tp:allow-destructive <reason>` *(gap)*.
4. **Given** production, **When** `curl -sI https://<APP_DOMAIN>/` and `curl -sI https://<APP_DOMAIN>/api/health`
   are run **[staging/prod]**, **Then** both responses include `strict-transport-security: max-age=31536000;
   includeSubDomains`, `x-content-type-options: nosniff`, `referrer-policy: strict-origin-when-cross-origin`,
   `permissions-policy: camera=(), microphone=(), geolocation=()`; the HTML response also includes the
   `content-security-policy` in FR-013, and `https://tenderpilot.<account>.workers.dev` returns 404/disabled.
5. **Given** the production `DATABASE_URL` secret, **When** an operator inspects it via the runbook procedure,
   **Then** the host contains `-pooler.` (Neon PgBouncer endpoint) and 50 concurrent `GET /api/tenders` requests from
   `scripts/load/feed.sh` complete with 0 responses ≥ 500 and `/api/health` p50 < 150 ms **[staging]**.
6. **Given** `wrangler.toml`, **When** it is read, **Then** it has `[limits] cpu_ms = 120000`, an `[env.staging]` block
   (`name = "tenderpilot-staging"`, own R2 bucket `tenderpilot-blobs-staging`, own `APP_URL`, cron identical), and the
   runbook states that Workers Paid is required.
7. **Given** Neon, **When** the operator opens project settings **[staging]**, **Then** history retention is ≥ 7 days,
   and `docs/runbook.md` § "Restore drill" records a dated drill: branch created at a timestamp, row count of
   `tenders` and `organizations` compared, `DATABASE_URL` swap rehearsed on staging, time-to-restore in minutes.
8. **Given** the repository, **When** GitHub settings are inspected, **Then** secret scanning and push protection are
   enabled and `docs/runbook.md` § "Secrets" lists every secret (`DATABASE_URL`, `ANTHROPIC_API_KEY`,
   `RESEND_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `SENTRY_DSN`, `ADMIN_TOKEN`, `CLOUDFLARE_API_TOKEN`,
   `NEON_API_KEY`), where it lives, who rotates it and how; `specs/001-gem-tender-copilot/plan.md` no longer mentions
   `SESSION_SECRET`.
9. **Given** the scheduled handler, **When** a cron tick runs, **Then** `scheduled()` **awaits** the job (no bare
   `ctx.waitUntil` wrapping), so a thrown error marks the cron invocation as failed in Cloudflare's Cron events.

---

### User Story 3 - A customer's data and quota are protected from other tenants and from abuse (Priority: P1) (#358)

Org B never sees demo tenders that org A loaded; no org-scoped route returns or mutates another org's data; and
bursts of requests — password guessing, preview spam, upload floods, GeM-facing clicks — are answered with 429 and a
`Retry-After` instead of degrading the service for everybody.

**Why this priority**: The demo-data leak is a live cross-tenant defect (fake bids appear in real customers' feeds and
trigger real alerts). Unthrottled PBKDF2 login, 5,000-row previews and 25 MB uploads let one client exhaust the
Worker and database for all paying orgs (ARCH-01, ARCH-11, ARCH-13).

**Independent Test**: Two browser profiles: org A loads demo data; org B's feed shows only real/mock-gem bids. Then
`for i in $(seq 1 11); do curl … /api/auth/login (wrong password); done` returns 429 on the 11th.

**Acceptance Scenarios**:

1. **Given** org A and org B (fresh orgs), **When** org A clicks "Load demo data" (`POST /api/demo/seed`), **Then** org
   A's `/tenders` shows the 40 demo bids, org B's `/tenders` shows "0" of them (none of the demo bid numbers), org B's
   dashboard tiles are unchanged, and `GET /api/watchlists/preview` for org B returns no demo tender *(gap)*.
2. **Given** the scenario above and an org B watchlist with keyword `laptop`, **When** the next ingestion/matching runs,
   **Then** no `tender_matches` and no `notifications` rows are created for org B referencing a demo tender *(gap)*.
3. **Given** a database that already contains demo tenders stored with `source='gem'`, **When** the data-fix migration
   runs, **Then** every tender whose `raw->>'demo' = 'true'` (or bid number in the demo set) has `source='demo'`, and
   existing `tender_matches` of non-demo orgs pointing at them are deleted *(gap)*.
4. **Given** org B's member, **When** they call every org-scoped route in `contracts/api.md` with ids belonging to org A
   (GET/PATCH/DELETE/POST), **Then** every call returns 404 `not_found` (never 200/403) and org A's rows are byte-for-
   byte unchanged — enforced by `apps/api/test/isolation.test.ts`, which fails if a route in `contracts/api.md` is
   not covered *(gap; extends 002 T052)*.
5. **Given** an email, **When** 10 wrong-password logins are made within 15 minutes and an 11th is attempted,
   **Then** the 11th returns **429** `{"error":{"code":"rate_limited","message":"Too many attempts. Try again in 14
   minutes.","details":{"rule":"auth.fail.email","retryAfter":<s>}}}` with header `Retry-After: <s>`; the login page
   shows the message under the form (role=alert) and keeps the button enabled *(gap; rule from 002 FR-010)*.
6. **Given** a signed-in analyst, **When** they call `POST /api/watchlists/preview` 31 times within 60 seconds,
   **Then** calls 1–30 return 200 and call 31 returns 429 `rate_limited` with `details.rule = "watchlist.preview.user"`
   and the watchlist editor shows "Preview paused — try again in N s" instead of the match count *(gap)*.
7. **Given** any upload route (`POST /api/vault`, `PUT /api/vault/:id/file`, `POST /api/tenders/:id/documents`), **When** a client sends a
   `content-length` of 30 MB, **Then** the API answers 413 `payload_too_large` **before reading the body** (request
   completes in < 200 ms) *(gap for the tender-document route; built for vault)*.
8. **Given** the limiter table is unreachable (DB error on the counter upsert), **When** a request hits a limited
   route, **Then** the request is allowed (fail-open), a `warn` log line `rate_limit_unavailable` with the rule is
   written, and auth-failure rules fail **closed** (503 `service_unavailable`) *(gap)*.
9. **Given** a cookie-authenticated `POST` with `Origin: https://evil.example`, **When** it reaches any route,
   **Then** it is rejected 403 `bad_origin`; the same request with `Authorization: Bearer <token>` is accepted (release
   gate on 002 FR-028).

---

### User Story 4 - The service stays fast and inside platform limits as tenders, orgs and documents grow (Priority: P1) (#359)

With 10^5–10^6 tenders, hundreds of orgs and multi-document tenders, the feed and dashboard stay under target
latency, concurrent document fetches by many orgs never exceed one request per second to GeM, overlapping cron and
manual runs never ingest twice, and large analyses or packets fail early with a clear message instead of an opaque
Cloudflare 1102 "Worker exceeded resource limits".

**Why this priority**: These are the failure modes that appear on day one of real traffic: GeM blocking our IP
(Constitution II), the Worker killed mid-analysis, and full scans on `tenders` and `notifications` (ARCH-03, ARCH-04,
ARCH-05, ARCH-06).

**Independent Test**: On a 500k-tender fixture, `scripts/load/feed.sh` reports feed p95 < 300 ms and `EXPLAIN` uses the
partial indexes; 20 concurrent `fetch-documents` calls against mock-gem show ≥ 1 s between requests in mock-gem's log.

**Acceptance Scenarios**:

1. **Given** 20 orgs that call `POST /api/tenders/:id/fetch-documents` for 20 different tenders at the same instant,
   **When** mock-gem records arrival times, **Then** consecutive GeM requests from all isolates/processes are ≥ 1,000 ms
   apart (tolerance −20 ms) and every call eventually returns 200/201 or 503 `gem_busy` "GeM is busy — we'll retry
   shortly" after waiting at most 25 s for the lease *(gap)*.
2. **Given** a cron run in progress, **When** a second cron tick and a manual "Sync now" start concurrently, **Then**
   exactly one `ingestion_runs` row has `status='running'` (enforced by the partial unique index), the manual call
   returns 409 `ingestion_running` "A GeM sync is already running — results will appear shortly.", and the second
   cron tick exits with a log line `ingestion skipped: already running` *(gap — atomicity)*.
3. **Given** a manual sync that finished at 10:00 IST, **When** a bid manager clicks **Sync now** at 10:04, **Then** the
   API returns 429 `sync_cooldown` with `details.retryAt` = 10:10 IST, mock-gem receives **0** requests, and the Sync
   now button is disabled with tooltip "Next manual sync at 10:10 IST" (cooldown 10 minutes; supersedes 003 FR-013's
   2 minutes) *(gap)*.
4. **Given** 500,000 tenders of which 30,000 are open, **When** `GET /api/tenders?sort=closing` and `?state=Maharashtra`
   and `?minValue=500000` are each called 200 times, **Then** p95 < 300 ms on the CI-sized Postgres and `EXPLAIN` shows
   `tenders_open_end_idx`, `tenders_open_state_idx` and `tenders_open_value_idx` respectively *(gap)*.
5. **Given** 1,000,000 notifications of which 500 are `pending` email/WhatsApp, **When** the dispatcher's select is
   `EXPLAIN`ed, **Then** it uses `notifications_pending_idx` and returns in < 50 ms *(gap)*.
6. **Given** the feed, watchlist preview and dashboard queries, **When** their SQL is inspected (test on the query
   builder), **Then** none selects `tenders.raw`, `tender_documents.text` or `tenders.items` beyond what the list DTO
   needs (`tenderListColumns`) *(gap)*.
7. **Given** a tender with 5 documents and an LLM configured (fake LLM in tests), **When** an analyst clicks **Analyse**,
   **Then** the analysis makes **≤ 2** LLM calls in total with ≤ 90,000 input characters overall, finishes within 120 s
   wall-clock, and if the budget is exhausted the remaining documents are rules-only and the result shows the warning
   "AI review covered 2 of 5 documents; the rest were checked by rules only." *(gap)*.
8. **Given** a tender document with 301 pages, **When** it is uploaded or fetched, **Then** the API returns 422
   `document_too_long` "This document has 301 pages. TenderPilot reads up to 300 pages — upload the bid document and
   ATC separately." and no `tender_documents` row is written *(gap)*.
9. **Given** a PDF whose text layer is empty on ≥ 80 % of pages (scanned), **When** it is analysed, **Then** the API
   returns 422 `scanned_document` "This PDF is a scan without text. Upload the text PDF from GeM or an OCR'd copy."
   *(gap; `looksScanned` exists but only annotates activity meta)*.
10. **Given** a packet build whose selected items total 45 MB or 41 items, **When** **Build packet** is clicked,
    **Then** the API returns 413 `packet_too_large` "This packet would be 45 MB (limit 40 MB). Deselect large
    attachments and try again." (or "41 items (limit 40)") **before** any `packets` row or R2 object is written *(gap)*.

---

### User Story 5 - Plans, trial expiry and AI usage are metered and enforced with honest messages (Priority: P1) (#360)

Each org has a plan with limits (seats, watchlists, analyses and AI analyses per month, vault storage, packets per
month) and a trial that ends 14 days after sign-up. Owners see usage meters and the trial countdown in Settings →
Plan & usage. Reaching a limit returns 402 with a friendly explanation; an expired trial makes the workspace
read-only (all data visible and downloadable) until the plan is changed by TenderPilot staff.

**Why this priority**: Without it a single trial org can spend unbounded LLM budget and the advertised "14-day free
trial" never ends, so no one ever needs to pay (ARCH-07, ARCH-08, ARCH-21 admin plan flip).

**Independent Test**: In a fresh trial org (API test with fixed clock), run 10 analyses → 11th returns 402
`plan_limit_reached`; advance clock 15 days → `POST /api/watchlists` returns 402 `plan_expired` while
`GET /api/tenders` returns 200; operator flips plan to `starter` via the admin endpoint → writes work again.

**Acceptance Scenarios**:

1. **Given** a new sign-up on 2026-11-05 10:00 IST, **When** `GET /api/auth/me` is called, **Then** `org.plan = "trial"`,
   `org.trialEndsAt = "2026-11-19T04:30:00.000Z"` (created + 14 × 24 h) *(gap)*.
2. **Given** a trial org with 10 analyses created this IST calendar month, **When** an analyst clicks **Analyse** on
   another tender, **Then** the API returns **402** `{"error":{"code":"plan_limit_reached","message":"Your Free trial
   includes 10 analyses a month. You've used 10. Talk to us to upgrade, or wait until 1 Dec.","details":{"limit":
   "analysesPerMonth","used":10,"max":10,"plan":"trial","resetsAt":"2026-11-30T18:30:00.000Z"}}}`, no `analyses` row
   is inserted, and the web app shows the "Plan limit reached" dialog with "Talk to sales" and "Close" *(gap)*.
3. **Given** a Starter org with 5 watchlists, **When** a bid manager saves a 6th, **Then** 402 `plan_limit_reached`
   (`limit:"watchlists"`, `max:5`); **Given** a Starter org with 3 members + pending invites, **When** an owner invites a
   4th person, **Then** 402 (`limit:"seats"`, `max:3`) *(gap)*.
4. **Given** a Pro org whose vault holds 9.99 GB, **When** a 20 MB file is uploaded, **Then** 402 (`limit:"vaultBytes"`);
   **Given** 200 packets built this month, **When** the 201st is built, **Then** 402 (`limit:"packetsPerMonth"`) *(gap)*.
5. **Given** an org on `enterprise`, **When** any of the above actions exceed the Pro numbers by 10×, **Then** none
   returns 402 *(gap)*.
6. **Given** a trial org whose `trialEndsAt` is in the past, **When** any member calls a write
   (`POST/PATCH/PUT/DELETE`) other than the allow-list in FR-038, **Then** the API returns **402** `plan_expired`
   "Your free trial ended on 19 Nov 2026. Your data is safe and read-only — talk to us to choose a plan."; **When** they
   call any `GET` (feed, analysis, vault download, packet download), **Then** it returns 200 *(gap)*.
7. **Given** an expired trial, **When** any member opens the app, **Then** a non-dismissible top banner reads "Your free
   trial has ended. TenderPilot is read-only until you choose a plan." with a "Talk to sales" link, and write buttons
   (Analyse, Save watchlist, Upload, Build packet, Invite) open the plan dialog instead of calling the API *(gap)*.
8. **Given** a trial with 5 days left, **When** an Owner opens the app, **Then** a dismissible (per day) banner reads
   "5 days left in your free trial" with "See plans"; at ≤ 1 day it reads "Your trial ends today" *(gap)*.
9. **Given** an Owner on **Settings → Plan & usage** (`/settings/usage`), **When** it loads, **Then** it shows the plan
   badge, "Trial ends 19 Nov 2026 (in 14 days)" for trials, and meters "Analyses this month 7 / 10", "AI analyses
   this month 7 / 10", "Watchlists 2 / Unlimited", "Seats 1 / 10", "Vault storage 120 MB / 1 GB", "Packets this month
   0 / 10", each a `role="progressbar"` with `aria-valuenow`/`aria-valuemax`; meters ≥ 80 % are amber, 100 % red
   *(gap)*.
10. **Given** an analysis that used the LLM, **When** it completes, **Then** one `llm_usage` row exists per LLM call with
    `org_id`, `analysis_id`, `model`, `input_tokens`, `output_tokens` equal to the fake LLM's reported usage, and
    `GET /api/org/usage` returns those totals for the month *(gap)*.
11. **Given** an org that has used all its AI analyses but not all analyses, **When** an analysis runs, **Then** it
    completes rules-only (no LLM call) and shows "Monthly AI review limit reached — this analysis used rules only."
    *(gap)*.
12. **Given** an operator with `ADMIN_TOKEN`, **When** they call `POST /api/admin/orgs/:id/plan`
    `{"plan":"starter","note":"Invoice INV-0012"}` with `Authorization: Bearer <ADMIN_TOKEN>`, **Then** the org's plan
    is `starter`, `trial_ends_at` is cleared, a `subscriptions` row is written, an `activity_log` row
    `org.plan_changed {from:"trial",to:"starter",note}` is visible in the org's activity, and writes succeed again;
    without or with a wrong token the endpoint returns 404 *(gap)*.

---

### User Story 6 - Operators are paged when ingestion, alerts or the API degrade, and can trace any request (Priority: P1) (#361)

An external uptime monitor polls `/api/health` every 5 minutes. When the last successful GeM ingestion is older than
120 minutes, the database is unreachable, or email/WhatsApp alerts have been pending for over 30 minutes, health
returns 503 with the reason and the operator is notified. Logs are JSON lines carrying request id, org and user, and
unhandled errors are reported to an error tracker with the same request id. A runbook tells the on-call engineer what
to check first.

**Why this priority**: The core promise is "new bids within 30 minutes". Today a silent cron failure is noticed only
when a customer complains, and logs cannot be filtered by org (ARCH-09, ARCH-20).

**Independent Test**: In an API test with a fixed clock, set the last successful run to 3 hours ago → `/api/health` is
503 `{"ok":false,"reasons":["ingestion_stale"]…}`; trigger an unhandled error → the log line is JSON with `rid`,
`orgId`, `userId`, `stack` and the fake error reporter received the same `rid`.

**Acceptance Scenarios**:

1. **Given** a healthy system (last success 25 min ago, no old pending alerts), **When** `GET /api/health` is called,
   **Then** it returns 200 `{"ok":true,"db":true,"version":"0.1.0","ingestion":{"lastSuccessAt":"…","ageMinutes":25,
   "lastStatus":"success"},"alerts":{"pendingOlderThan30m":0},"reasons":[]}` with `cache-control: no-store` *(gap for
   `ingestion`, `alerts`, `reasons`)*.
2. **Given** the last successful run finished 3 hours ago, **When** health is called, **Then** it returns **503** with
   `ok:false`, `reasons:["ingestion_stale"]`, `ingestion.ageMinutes: 180` *(gap)*.
3. **Given** a fresh database with no ingestion runs ever, **When** health is called, **Then** it returns 200 with
   `ingestion.lastSuccessAt: null` and `ingestion.state: "never"` (so new environments and E2E boot are healthy)
   *(gap)*.
4. **Given** 3 email notifications pending for 45 minutes, **When** health is called, **Then** it returns 503 with
   `reasons:["alerts_backlog"]` and `alerts.pendingOlderThan30m: 3` *(gap)*.
5. **Given** the database is unreachable, **When** health is called, **Then** it returns 503 with `db:false`,
   `reasons:["db_unreachable"]` within 3 s (query timeout) *(built: 503 + `db:false`; gap: `reasons`, timeout)*.
6. **Given** any API request by a signed-in user, **When** it completes, **Then** exactly one stdout line is valid JSON
   with keys `ts`, `level:"info"`, `msg:"request"`, `rid`, `method`, `path` (no query string), `status`, `ms`,
   `orgId`, `userId`; no line ever contains `password`, `cookie`, `authorization`, a session token or a request body
   *(gap)*.
7. **Given** a route throws an unexpected error, **When** the response is returned, **Then** it is 500 `internal_error`
   with `details.requestId` = `x-request-id` (built), the JSON log line has `level:"error"`, `rid`, `orgId`, `stack`,
   and `deps.errors.capture()` is called once with the same `rid`, `orgId`, route and release *(gap for JSON +
   reporter)*.
8. **Given** `SENTRY_DSN` is not set, **When** an error occurs, **Then** the reporter is a no-op and nothing crashes
   (Constitution VII) *(gap)*.
9. **Given** a scheduled run where the `alerts` step throws, **When** the run finishes, **Then** `ingestion` and
   `reminders` still ran (built), the error is reported with `job:"alerts"`, and the JSON summary line
   `scheduled run finished` lists each step's `ok`/`ms` (built, to become JSON) *(gap for reporting)*.
10. **Given** `docs/runbook.md`, **When** an on-call engineer opens it, **Then** it has sections "Monitors" (what pages
    whom: uptime monitor on `/api/health` every 5 min, alert after 2 consecutive failures), "First 10 minutes" for
    each reason (`db_unreachable`, `ingestion_stale`, `alerts_backlog`, 5xx spike, GeM blocking us), "Deploy &
    rollback" (`wrangler rollback`, migration policy), "Restore drill", "Secrets" and "Offboarding" *(gap)*.

---

### User Story 7 - Costs, query time and stored data stay proportional as usage grows (Priority: P2) (#362)

The same public GeM document is LLM-extracted once for all orgs; full-text search uses a GIN index; the matcher
compiles each watchlist once per run; old sessions, read notifications, events, raw payloads and superseded packets are
pruned daily; and the Worker talks to Postgres through Hyperdrive with a single `pg` driver. Each LATER item has a
written trigger.

**Why this priority**: Not required to take the first payment, but every item reduces either LLM spend, latency or
storage linearly with customers; they are the "first paid quarter" work (ARCH-14…ARCH-18, ARCH-19 batch, ARCH-23…26
triggers).

**Independent Test**: Two orgs analyse the same GeM document → the fake LLM records one call; the housekeeping step on
a fixed-clock fixture deletes exactly the expected rows and R2 objects.

**Acceptance Scenarios**:

1. **Given** org A analysed tender T (GeM-fetched document D, `extractor_version` = current), **When** org B analyses T,
   **Then** the fake LLM records **0** new extraction calls for D, org B's analysis lists the same requirements with
   provenance, and `tender_documents.extracted_method` is `LLM` *(gap)*.
2. **Given** `CURRENT_EXTRACTOR_VERSION` is bumped, **When** the next analysis of T runs, **Then** D is re-extracted once
   and the cache row updated *(gap)*.
3. **Given** 500,000 tenders, **When** `GET /api/tenders?q=solar street light` is called 200 times, **Then** p95 < 300 ms
   and `EXPLAIN` uses `tenders_search_gin`; `q=GEM/2026/B/12` still matches by bid-number prefix *(gap)*.
4. **Given** 1,000 active watchlists and 500 new tenders, **When** matching runs in Node, **Then** it completes in < 5 s
   and inserts matches in batches of ≤ 500 rows per statement *(gap)*.
5. **Given** the retention table (FR-070) and a fixed clock, **When** the daily housekeeping step runs, **Then** it
   deletes exactly: sessions expired > 7 days, `read`/`sent`/`skipped` notifications > 180 days, `tender_events` > 365
   days for closed tenders, nulls `tenders.raw` for tenders closed > 90 days, deletes packets beyond the newest 5 per
   workspace (row + R2 object), and logs `{job:"housekeeping", deleted:{…}}`; a second run deletes 0 *(gap)*.
6. **Given** 120 queued email notifications, **When** the dispatcher runs with Resend configured, **Then** it makes
   exactly 2 provider calls via `/emails/batch` (≤ 100 per call) *(gap)*.
7. **Given** the Worker configured with a `[[hyperdrive]]` binding, **When** typecheck and tests run, **Then**
   `@neondatabase/serverless` is no longer a dependency, `createNeonDb` is deleted, and 50 concurrent feed requests on
   staging produce 0 connection errors *(gap)*.
8. **Given** `docs/adr/README.md`, **When** read, **Then** each LATER item (Queues, RLS, Razorpay, Analytics Engine,
   weekly `pg_dump` to R2) states its trigger and the runbook links to it (built in ADRs; gap: runbook link).

---

### Edge Cases

- **Fresh environment**: no ingestion run yet → health 200 with `state:"never"`; the first cron tick creates the first
  run. A staging environment pointed at mock-gem must never page production on-call (separate monitor).
- **Cron overlaps a deploy**: an old Worker version may run a cron tick during the ~1 minute between migrate and
  deploy; additive-only migrations guarantee the old code still works.
- **Partial unique index and stale runs**: a `running` row older than 15 minutes is reaped to `failed` **in the same
  statement/transaction** that inserts the new run; the index must not block the reaper.
- **GeM lease holder dies**: the lease row has `expires_at = now + 5 s`; a crashed isolate's lease simply expires.
- **Clock skew between isolates**: the lease uses the database clock (`now()`), never `Date.now()` of the isolate.
- **Rate-limit key for unauthenticated requests behind Cloudflare**: IP is `cf-connecting-ip`; on Node it is the
  socket address; `x-forwarded-for` is only trusted when `TRUST_PROXY=1`.
- **Shared office IP** (many MSME staff behind one NAT): IP rules are generous (30 auth failures / 15 min, 20 sign-ups /
  hour) and email/user keys are the primary control.
- **Plan downgraded below current usage** (e.g. Pro → Starter with 12 watchlists): existing resources keep working;
  only creating new ones returns 402; usage meters show "12 / 5" in red.
- **Month boundary**: analyses/packets counters reset at 00:00 IST on the 1st (`resetsAt` = previous day 18:30 UTC).
- **Demo data in an expired trial**: `DELETE /api/demo` (007 FR-065, when shipped) remains allowed so customers can clean up.
- **Analysis already running when the quota is reached** by a parallel request: the quota check and the `analyses`
  insert run in one transaction with `SELECT … FOR UPDATE` on the org row, so at most `max` analyses exist.
- **LLM provider slow**: per-call timeout 60 s; the 120 s analysis budget counts wall clock including rules.
- **Packet size unknown up-front** (generated annexures): pre-flight sums known blob sizes plus 512 KB per generated
  page; the post-build size check still applies.
- **R2 object deleted but row remains** (or vice versa) after housekeeping crash: housekeeping deletes the R2 object
  first, then the row; a missing object on delete is not an error (`BlobStore.delete` is idempotent).
- **Neon restore**: restoring into a branch never overwrites production; the swap is a `DATABASE_URL` secret change +
  redeploy, recorded in the runbook.
- **CI on forks**: secrets are not available; `e2e` still runs (mock-gem, no LLM key) and deploy never runs.
- **Evidence size**: videos make artifacts large; only `qa/evidence/**` and the HTML report are uploaded on success;
  traces are always uploaded on failure.
- **Health called by the monitor every 5 min from several regions**: health uses 3 cheap queries (≤ 1 index scan each)
  and is excluded from rate limiting and from request logging at `info` (logged at `debug`).

## Requirements *(mandatory)*

### Functional Requirements

**CI, QA evidence and Definition of Done (US1)**

- **FR-001** *(gap)*: The repository MUST have `.github/workflows/ci.yml` triggered on `pull_request` and `push` to
  `main`, with jobs `typecheck` (`pnpm typecheck`), `unit` (`pnpm -r --filter ./packages/* run test`), `api`
  (`pnpm --filter @tp/api test` with a `postgres:16` service on port 5433, `TEST_DATABASE_URL` set) and `e2e`
  (`pnpm exec playwright install --with-deps chromium` + `pnpm e2e` with `E2E_DATABASE_URL` pointing at the service
  DB), `permissions: contents: read`, `concurrency` cancelling superseded PR runs, Node 22, pnpm 10 store cache.
- **FR-002** *(gap)*: The `e2e` job MUST upload `qa/evidence/**` and `qa/.runs/**` as artifact `e2e-evidence-<run_id>`
  (`if: always()`, 30-day retention) and write a job summary with total/passed/failed/flaky from
  `qa/.runs/<port>/results.json`.
- **FR-003** *(gap)*: Branch protection on `main` MUST require `typecheck`, `unit`, `api`, `e2e`, `migrations-additive`
  and `dod` checks; force-push disabled. (Configured in GitHub; documented in `docs/runbook.md`.)
- **FR-004** *(gap)*: A `dod` workflow MUST, for PRs labelled `type:story` or carrying a `Work-Item:` trailer that maps to
  `spec:<nnn>` + story `US<n>`, verify `qa/evidence/<nnn>/US<n>/VERDICT.md` exists, contains `Verdict: approved`, has
  no acceptance-criterion row marked `not met`, links at least one screenshot and one video present in the same folder,
  and that commits carry the trailers from `CONVENTIONS.md`. It reports each failing rule by name.
- **FR-005** *(gap)*: E2E specs for this feature MUST live in `e2e/008-operations-scale/US<n>-*.e2e.ts` and write evidence
  via `evidence(page, '008', 'US<n>', name)` and `collectRunArtifacts('008', 'US<n>', page)`; API-only evidence
  (curl transcripts, `EXPLAIN` output, CI log excerpts) is saved as `.txt`/`.json` in the same folder.
- **FR-006** *(gap)*: CI MUST run a `migrations-additive` check (`scripts/check-migrations.ts`) over new files in
  `packages/db/migrations/*.sql` that fails on `DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN … TYPE`, `RENAME`,
  `SET NOT NULL` (without a default in the same statement) unless the file's first line is
  `-- tp:allow-destructive <reason>`; it also fails when `schema.ts` changed but `drizzle-kit generate` produces a diff
  (schema/migration drift).

**Deployment, environments, secrets and backups (US2)**

- **FR-007** *(gap)*: `.github/workflows/deploy.yml` MUST run on `push` to `main` after `ci` succeeds — as a reusable
  workflow (`workflow_call`) invoked by the `deploy` job of `ci.yml`, which needs `ci-gate` and runs only when it
  succeeded on a push to `main` — and on `workflow_dispatch` (full 40-char SHA of a commit already on `main`). It does
  not use `workflow_run`, because that only fires for workflow files on the repository's default branch, which is not
  `main`. Jobs: `staging` (build web → `pnpm db:migrate` with `secrets.STAGING_DATABASE_URL`
  → `wrangler deploy --env staging` → smoke) and `production` (GitHub environment `production` with required reviewer
  → `pnpm db:migrate` with `secrets.PROD_DATABASE_URL` → `wrangler deploy` → smoke), with per-environment
  concurrency groups `deploy-staging` / `deploy-production` (no cancel). `APP_VERSION` MUST be set to the short commit
  SHA via `--var APP_VERSION:<sha>`.
- **FR-008** *(gap)*: A smoke script (`scripts/smoke.sh <base-url> <version>`) MUST assert `/api/health` 200 with the
  expected `version`, `/` 200 HTML with `<div id="root">`, `/api/nope` 404 JSON `not_found`, and the security headers
  of FR-013; exit non-zero on any mismatch.
- **FR-009** *(gap)*: `wrangler.toml` MUST declare `[limits] cpu_ms = 120000`, `[env.staging]` (name
  `tenderpilot-staging`, R2 `tenderpilot-blobs-staging`, `APP_URL` of the staging domain, `GEM_BASE_URL` configurable),
  production `routes = [{ pattern = "<APP_DOMAIN>", custom_domain = true }]`, `workers_dev = false`, and
  `APP_URL = "https://<APP_DOMAIN>"`.
- **FR-010** *(gap)*: The production and staging `DATABASE_URL` secrets MUST use the Neon pooled (`-pooler`) host until
  Hyperdrive ships (FR-075). The runbook MUST state this and how to verify it.
- **FR-011**: Migrations MUST be generated only by `drizzle-kit generate` and applied only by `pnpm db:migrate`
  (`packages/db/src/migrate.ts`); the Worker MUST never run DDL. *(built: migrate script; Node `AUTO_MIGRATE` is
  dev/E2E-only)*
- **FR-012** *(gap)*: The Worker's `scheduled()` MUST `await` `runScheduledJobs` (inside `withDeps`) so failures surface
  in Cloudflare cron events, while still closing the pool via `ctx.waitUntil`.
- **FR-013** *(gap)*: Every response (API and static) MUST carry `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
  and on HTTPS `Strict-Transport-Security: max-age=31536000; includeSubDomains`. HTML responses MUST carry
  `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-<theme-bootstrap-hash>'; style-src 'self'
  'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:
  blob:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self';
  object-src 'none'`. API responses that stream a PDF for in-app preview MUST allow same-origin framing only. Static
  headers are set via `apps/web/public/_headers`; API headers via `apps/api/src/middleware/request.ts`. A unit test
  MUST recompute the inline-script hash from `apps/web/index.html` so CSP cannot drift.
- **FR-014** *(gap)*: Neon history retention MUST be ≥ 7 days for production; `docs/runbook.md` MUST describe the
  restore procedure (create branch at timestamp → verify counts → swap `DATABASE_URL` secret → redeploy) and record at
  least one dated restore drill performed on staging before the first paid invoice.
- **FR-015** *(gap)*: Secrets MUST be managed only via `wrangler secret put` (Worker) and GitHub encrypted secrets (CI);
  `docs/runbook.md` § Secrets MUST list each secret with owner, location, rotation steps and blast radius; GitHub secret
  scanning + push protection MUST be enabled; `SESSION_SECRET` MUST be removed from
  `specs/001-gem-tender-copilot/plan.md`.

**Tenant isolation and abuse controls (US3)**

- **FR-016** *(gap)*: Demo tenders MUST be stored with `source = 'demo'`. Every tender read path
  (`routes/tenders.ts#buildFilters`, `routes/watchlists.ts#candidateTenders`, `routes/dashboard.ts`,
  `routes/ingestion.ts` counts, `services/ingest.ts` matching) MUST include only `source = 'gem'` rows, plus
  `source = 'demo'` rows when the caller's org has `onboarding_state.demo = true`; `matchAndNotify` MUST match only
  `source = 'gem'`. A data-fix migration MUST convert existing demo rows and delete their matches/notifications for
  orgs without demo. `apps/api/test/isolation.test.ts` MUST cover every org-scoped route listed in
  `specs/001-gem-tender-copilot/contracts/api.md` (it parses the contract and fails on an uncovered route), asserting
  404 and no mutation for cross-org ids.
- **FR-017** *(gap)*: The API MUST provide a Postgres-backed fixed-window rate limiter: table `rate_limits (key text,
  window_start timestamptz, count int, primary key (key, window_start))`, `lib/rate-limit.ts#hit(db, key, limit,
  windowSec)` using one `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`, exposed through
  `AppDeps.rateLimiter` (memory implementation for unit tests).
- **FR-018** *(gap)*: A `rateLimit(rule)` middleware MUST answer over-limit requests with **429**
  `{error:{code:"rate_limited", message:"Too many requests. Try again in N seconds." | "Too many attempts. Try again in
  N minutes.", details:{rule, retryAfter}}}` and header `Retry-After: <seconds>`; under-limit responses MAY carry
  `RateLimit-Remaining`.
- **FR-019** *(gap)*: The rule table (`apps/api/src/lib/rate-limit-rules.ts`) MUST contain at least:

  | Rule | Key | Limit / window | Routes |
  |---|---|---|---|
  | `auth.fail.email` | normalised email | 10 failures / 15 min | login, accept-invite (existing user), change-password (002 FR-010) |
  | `auth.fail.ip` | client IP | 30 failures / 15 min | same |
  | `auth.signup.ip` | client IP | 20 / 60 min | `POST /api/auth/signup` |
  | `auth.reset.email` | email | 3 / 60 min | `POST /api/auth/forgot-password` (002 FR-011) |
  | `watchlist.preview.user` | user | 30 / 60 s | `POST /api/watchlists/preview` |
  | `upload.org` | org | 120 / 60 min | `POST /api/vault`, `PUT /api/vault/:id/file`, `POST /api/tenders/:id/documents` |
  | `gem.fetch.org` | org | 30 / 60 min | `POST /api/tenders/:id/fetch-documents` |
  | `analyse.user` | user | 30 / 60 min | `POST /api/tenders/:id/analyse` |
  | `packet.org` | org | 30 / 60 min | `POST /api/workspaces/:id/packets` |
  | `api.user` | user or token | 600 / 60 s | all authenticated `/api/*` |
  | `api.ip` | client IP | 300 / 60 s | all unauthenticated `/api/*` except `/api/health` |

- **FR-020** *(gap)*: The limiter MUST fail open (allow + `warn` log `rate_limit_unavailable`) when the counter query
  fails, except `auth.*` rules which fail closed with 503 `service_unavailable`.
- **FR-021** *(gap)*: A generic `bodyLimit` middleware MUST reject requests whose `content-length` exceeds the route's
  cap (+64 KB multipart overhead) with 413 `payload_too_large` before reading the body; requests without
  `content-length` on upload routes MUST be read with a streaming byte counter that aborts at the cap. Caps: vault
  20 MB, tender documents 25 MB, JSON bodies 1 MB.
- **FR-022** *(gap)*: The client IP MUST come from `cf-connecting-ip` on Workers, the socket address on Node, and
  `x-forwarded-for` (first hop) only when `TRUST_PROXY=1`.
- **FR-023** *(release gate)*: Spec 002 FR-010, FR-011, FR-018, FR-028 (and FR-012, FR-037 for SHOULD) MUST be passing
  their acceptance scenarios before the first paid plan is activated.

**Reliability and capacity (US4)**

- **FR-024** *(gap)*: All requests to GeM (listing pages in `services/ingest.ts`, document fetches in
  `services/analyse.ts`) MUST acquire a cluster-wide lease from table `gem_throttle (id text primary key,
  next_slot_at timestamptz)` via `lib/gem-lease.ts#acquireGemSlot(db, minIntervalMs, maxWaitMs)`: one atomic
  `UPDATE … SET next_slot_at = greatest(now(), next_slot_at) + interval RETURNING` that yields the time to wait; the
  caller sleeps until its slot. `GemClient` MUST accept a `beforeRequest()` hook so the lease is taken per HTTP request.
  If the wait would exceed `maxWaitMs` (25 s for user-facing fetches), the call returns 503 `gem_busy`.
- **FR-025** *(gap)*: `ingestion_runs` MUST have a partial unique index `ingestion_runs_one_running_uq ON
  ((true)) WHERE status = 'running'`; `runIngestion` MUST reap stale runs and insert the new run in one transaction and
  translate a unique violation into `IngestionBusyError` (built for the read-check path).
- **FR-026** *(gap)*: `POST /api/ingestion/run` MUST return 429 `sync_cooldown` with `details.retryAt` when a manual run
  finished less than `MANUAL_SYNC_COOLDOWN_MIN` (default **10**) minutes ago — platform-wide, since ingestion is
  global — and MUST make no GeM request in that case. The web Sync now control MUST show "Next manual sync at
  HH:MM IST" while cooling down.
- **FR-027** *(gap)*: `tenders` MUST have partial indexes `WHERE status = 'open'`: `tenders_open_created_idx
  (created_at desc)`, `tenders_open_end_idx (end_at)`, `tenders_open_value_idx (estimated_value)`,
  `tenders_open_state_idx (state)`, `tenders_open_ministry_idx (ministry)`, `tenders_open_category_idx (category)`;
  `analyses` MUST have `analyses_org_tender_created_idx (org_id, tender_id, created_at desc)`.
- **FR-028** *(gap)*: Feed, watchlist preview and dashboard list queries MUST select a shared projection
  `tenderListColumns` (no `raw`, no document text); `candidateTenders` MUST be limited to open tenders with
  `end_at > now()` and a maximum of 2,000 rows.
- **FR-029** *(gap)*: `notifications` MUST have `notifications_pending_idx (created_at) WHERE status = 'pending' AND
  channel IN ('email','whatsapp')`.
- **FR-030** *(gap)*: Tender documents MUST be capped at `MAX_TENDER_DOC_PAGES = 300` (422 `document_too_long`), and
  documents where `looksScanned()` is true MUST be rejected for analysis with 422 `scanned_document`.
- **FR-031** *(gap)*: An analysis MUST make at most `MAX_LLM_CALLS_PER_ANALYSIS = 2` LLM calls, send at most
  `MAX_LLM_INPUT_CHARS = 90_000` characters in total, set a 60 s per-call timeout and a 120 s overall budget; when a
  budget is exhausted the remaining documents use rules only and the analysis carries a warning
  `llm_budget_exhausted` rendered as "AI review covered X of Y documents; the rest were checked by rules only."
- **FR-032** *(gap)*: Packet builds MUST pre-flight the total input size and item count: > 40 MB or > 40 items → 413
  `packet_too_large` before writing any row or blob; the request schema `packetBuildSchema.items.max` MUST be 40.
- **FR-033** *(gap)*: Load-test scripts (`scripts/load/feed.sh`, `scripts/load/gem-fetch.sh`) and a 500k-tender
  fixture generator (`packages/db/src/fixtures/bulk-tenders.ts`) MUST exist so FR-027/NFR-001 can be re-verified.

**Plans, trials, metering (US5)**

- **FR-034** *(gap)*: `packages/core/src/contracts/plans.ts` MUST export `PLAN_LIMITS` (null = unlimited):

  | Plan | seats | watchlists | analysesPerMonth | llmAnalysesPerMonth | vaultBytes | packetsPerMonth | whatsapp |
  |---|---|---|---|---|---|---|---|
  | `trial` | 10 | null | 10 | 10 | 1 GB | 10 | true |
  | `starter` | 3 | 5 | 100 | 50 | 2 GB | 30 | false |
  | `pro` | 10 | null | 500 | 250 | 10 GB | 200 | true |
  | `enterprise` | null | null | null | null | null | null | true |

  `TRIAL_DAYS = 14`. Seats count members + pending invitations. Monthly counters use the IST calendar month.
- **FR-035** *(gap)*: `organizations` MUST gain `trial_ends_at timestamptz` (set to `created_at + 14 days` at sign-up;
  the migration backfills existing `trial` orgs to `greatest(created_at + 14 days, migration time + 7 days)`).
  `GET /api/auth/me` and `GET /api/org` MUST return `org.trialEndsAt`.
- **FR-036** *(gap)*: `lib/plan.ts#assertWithinPlan(deps, orgId, limit, increment)` MUST be called at watchlist create,
  invitation create, analyse, vault upload (bytes) and packet build, and throw `paymentRequired('plan_limit_reached',
  …)` (402) with `details {limit, used, max, plan, resetsAt?}`. The analyse check and insert MUST be serialised per org
  (row lock) so concurrent requests cannot exceed the limit.
- **FR-037** *(gap)*: When `llmAnalysesPerMonth` is exhausted but `analysesPerMonth` is not, analysis MUST run
  rules-only and carry warning `llm_quota_reached` ("Monthly AI review limit reached — this analysis used rules only.").
- **FR-038** *(gap)*: Middleware `requireActivePlan` MUST return 402 `plan_expired` for writes when `plan = 'trial'` and
  `trial_ends_at < now()`. Allowed while expired: all `GET`/`HEAD`; `/api/auth/*` (login, logout, switch-org, accept-invite); `PATCH /api/me`,
  `POST /api/me/password`, `/api/me/sessions*` (002 FR-012), `DELETE /api/me/api-tokens/:id`;
  `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`, `PUT /api/me/notification-prefs`;
  `DELETE /api/demo` (007 FR-065, when shipped).
- **FR-039** *(gap)*: Table `llm_usage (id, org_id, analysis_id null, kind 'extract'|'assist', model, input_tokens,
  output_tokens, created_at)` MUST be written once per LLM call from `services/analyse.ts` (and any other LLM caller);
  `GET /api/org/usage` (any member) MUST return `{plan, trialEndsAt, period:{start,end}, usage:{seats, watchlists,
  analysesThisMonth, llmAnalysesThisMonth, vaultBytes, packetsThisMonth, llmTokensThisMonth:{input,output}},
  limits: PLAN_LIMITS[plan]}`.
- **FR-040** *(gap)*: `lib/errors.ts` MUST export `paymentRequired(code, message, details)` (402), and
  `specs/001-gem-tender-copilot/contracts/api.md` MUST document the 402 codes `plan_limit_reached` and `plan_expired`
  and the 429 codes `rate_limited`, `sync_cooldown`, the 413 `packet_too_large`, the 422 `document_too_long`,
  `scanned_document`, and the 503 `gem_busy`.
- **FR-041** *(gap)*: The web app MUST (a) show the trial banner and expired banner (US5 scenarios 7–8) in
  `AppShell`, (b) intercept `ApiError` 402 globally and open a `PlanLimitDialog` with the server message, usage
  "used / max" and buttons "Talk to sales" (`mailto:sales@tenderpilot.in?subject=TenderPilot%20plan`) and "Close",
  (c) add **Settings → Plan & usage** (`/settings/usage`, all roles can view) with meters per FR-039, and (d) render
  429 messages from `details.retryAfter` as "Try again in N s/min".
- **FR-042** *(gap)*: `POST /api/admin/orgs/:id/plan {plan, note, trialEndsAt?}` MUST require
  `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare; unset `ADMIN_TOKEN` → route returns 404), write a
  `subscriptions (id, org_id, plan, status 'active'|'cancelled', started_at, ends_at null, note, created_at)` row, update
  `organizations.plan`/`trial_ends_at`, and log `org.plan_changed` in `activity_log`.
- **FR-043** *(gap)*: Plan/limit enforcement MUST never apply to `enterprise`, and plan changes MUST take effect on the
  next request (no caching of plan beyond one request).

**Observability (US6)**

- **FR-044** *(gap)*: `GET /api/health` MUST return `{ok, db, version, ingestion:{lastSuccessAt, ageMinutes,
  lastStatus, state:'ok'|'stale'|'never'}, alerts:{pendingOlderThan30m}, reasons: string[]}`; status 503 when
  `db_unreachable`, `ingestion_stale` (age > `HEALTH_INGESTION_MAX_AGE_MIN`, default 120) or `alerts_backlog`
  (pendingOlderThan30m > 0); each query has a 3 s timeout; no org data is exposed.
- **FR-045** *(gap)*: `consoleLogger` MUST emit one JSON object per line (`ts`, `level`, `msg`, plus meta) and the
  request middleware MUST log `{msg:"request", rid, method, path, status, ms, orgId, userId}`; a redaction step MUST
  drop keys matching `/password|token|secret|cookie|authorization/i`. `/api/health` requests log at `debug` (suppressed
  unless `LOG_LEVEL=debug`).
- **FR-046** *(gap)*: `AppDeps.errors: ErrorReporter { capture(err, ctx: {rid?, orgId?, userId?, route?, job?}) }` MUST
  be called from `middleware/error.ts` (unhandled only, not `HttpError`) and from `runScheduledJobs` on step failure;
  implementation `@sentry/cloudflare` on Workers and `@sentry/node` on Node when `SENTRY_DSN` is set, no-op otherwise;
  release = `APP_VERSION`, environment = `production|staging|development`.
- **FR-047** *(gap)*: An external uptime monitor MUST poll `https://<APP_DOMAIN>/api/health` every 5 minutes and alert
  the on-call email/phone after 2 consecutive non-200 results; staging has its own monitor that alerts only the team
  channel. Documented in `docs/runbook.md` § Monitors.
- **FR-048** *(gap)*: `docs/runbook.md` MUST exist with sections Monitors, First 10 minutes (per health reason, 5xx
  spike, GeM blocking/429s from GeM), Deploy & rollback (`wrangler rollback`, never roll back migrations — roll forward),
  Restore drill, Secrets, Offboarding (org deletion & R2 prefix purge), LATER triggers.

**Efficiency and data lifecycle (US7, SHOULD)** — FR-049…FR-069 are reserved for follow-ups to US1–US6.

- **FR-070** *(gap)*: A `RETENTION` table in `apps/api/src/services/housekeeping.ts` MUST define: expired sessions
  +7 days; used/expired invitations 30 days; notifications `read|sent|skipped` 180 days, `failed` 30 days;
  `tender_events` 365 days for non-open tenders; `tenders.raw` nulled 90 days after close; `rate_limits` windows older
  than 1 day; `gem_throttle` untouched; packets: keep newest 5 per workspace. Housekeeping MUST run once per IST day as
  a `runScheduledJobs` step (first cron tick after 02:00 IST) and be idempotent.
- **FR-071** *(gap)*: R2 lifecycle rule on prefix `org/` for `*/packets/*` older than 365 days MUST be configured and
  documented (defence in depth for FR-070).
- **FR-072** *(gap)*: `tender_documents` MUST gain `requirements jsonb`, `extractor_version text`, `extracted_at`,
  `extracted_method`; analysis MUST reuse cached requirements for GeM-fetched (org_id null) documents when
  `extractor_version = CURRENT_EXTRACTOR_VERSION`; a test MUST pin the constant's value so changes are deliberate.
- **FR-073** *(gap)*: `tenders` MUST gain a generated `search tsvector` (simple config over bid number, title, category,
  ministry, department, organisation, buyer office, state, city, item names) with GIN index `tenders_search_gin`;
  `buildFilters` and `candidateTenders` MUST use `websearch_to_tsquery('simple', q)` plus a `bid_number ILIKE 'q%'`
  prefix match.
- **FR-074** *(gap)*: `compileCriteria()` MUST precompile keyword regexes per watchlist once per run in
  `packages/core/src/match/matcher.ts`; match rows MUST be inserted in batches (≤ 500 per statement); `Mailer.sendMany`
  MUST use Resend `/emails/batch` (≤ 100 per call).
- **FR-075** *(gap)*: The Worker MUST connect through a `[[hyperdrive]]` binding (`caching.disabled = true`) with
  `createNodeDb(env.HYPERDRIVE.connectionString, { max: 5 })`; `createNeonDb` and `@neondatabase/serverless` MUST be
  removed; `specs/001-gem-tender-copilot/plan.md` updated.
- **FR-076**: LATER items MUST stay documented with triggers in `docs/adr/` (built) and be linked from the runbook:
  Queues (p95 analysis > 60 s for a week, batch analyse, > 300-page documents), RLS (second DB code path or security
  questionnaire), Razorpay (≥ 5 paying orgs), Analytics Engine + weekly `pg_dump` to R2 (customer request).

### Non-Functional Requirements

- **NFR-001**: Feed (`GET /api/tenders`) and dashboard p95 < 300 ms server time at 500k tenders / 30k open on the
  staging Postgres size; parent NFR-001 (< 2 s p95 end-to-end) remains.
- **NFR-002**: GeM request rate ≤ 1 request/second **cluster-wide** (all isolates, cron + user fetches), honest
  User-Agent, back-off on 429/5xx (Constitution II).
- **NFR-003**: `/api/health` p50 < 150 ms, p95 < 400 ms on production.
- **NFR-004**: Availability target 99.5 % monthly for `/api/*` (measured by the uptime monitor); ingestion freshness:
  last success < 60 min for 99 % of 5-minute checks.
- **NFR-005**: Zero cross-tenant reads/writes: isolation sweep green on every CI run; demo data never visible to
  orgs without demo.
- **NFR-006**: RPO ≤ 5 minutes and RTO ≤ 60 minutes for the database (Neon PITR within ≥ 7 days); R2 objects are not
  versioned (documented accepted risk until weekly backups ship).
- **NFR-007**: CI wall-clock: PR feedback (typecheck + unit + api) < 10 minutes; full pipeline incl. E2E < 30 minutes.
- **NFR-008**: No secret in the repository, logs, error reports or evidence artifacts (evidence uses `@example.in`
  test users only).
- **NFR-009**: Every limit, cap and retention value is a named constant in one module (`plans.ts`,
  `rate-limit-rules.ts`, `caps.ts`, `housekeeping.ts#RETENTION`) and is referenced by its test.
- **NFR-010**: Every external reuse is listed in `NOTICE` with licence (Constitution constraint).
- **NFR-011**: Every UI added by this spec meets WCAG 2.1 AA, works at 375 px without horizontal scroll, in light and
  dark themes, and has loading/empty/error states (Constitution V).

## UX Specification

This area is mostly invisible; the UI surfaces are the places where operational limits meet the user.

### Screens

| Screen / element | Route / location | Content |
|---|---|---|
| **Plan & usage** *(gap)* | `/settings/usage` (Settings side-nav item "Plan & usage", icon Gauge, after "Organization") | Plan badge (Free trial / Starter / Pro / Enterprise), trial line "Trial ends 19 Nov 2026 (in 14 days)" or "Trial ended on …", six meters (FR-039), "Usage resets on 1 Dec 2026", button "Talk to sales". Read-only for all roles. |
| **Trial banner** *(gap)* | Top of `AppShell` main area, above page header | Info tone: "5 days left in your free trial · See plans" (dismiss ✕ hides it until the next IST day; Owner and Bid Manager only). Danger tone, not dismissible, all roles: "Your free trial has ended. TenderPilot is read-only until you choose a plan. Talk to sales". |
| **Plan limit dialog** *(gap)* | Modal opened by any 402 | Title "Plan limit reached" or "Your trial has ended"; server message; "used / max" line; buttons "Talk to sales" (primary) and "Close". |
| **Rate-limit feedback** *(gap)* | Inline under the form (login, sign-up, forgot-password) or as a toast elsewhere | "Too many attempts. Try again in 14 minutes." / "Preview paused — try again in 23 s." |
| **Sync now cooldown** *(gap)* | `SyncHealth` popover and Settings → Sync health | Button disabled with tooltip and helper text "Next manual sync at 10:10 IST". |
| **Analysis warnings** *(gap)* | Analysis panel warnings list (existing warnings UI) | "AI review covered 2 of 5 documents; the rest were checked by rules only." / "Monthly AI review limit reached — this analysis used rules only." |
| **Upload/packet errors** *(gap)* | Existing upload and Build packet error toasts | Server messages for 413/422 (FR-030, FR-032). |
| **Service unavailable** (built) | `ErrorState` in pages | 503 shows "Service temporarily unavailable" with "Try again". |
| **Sync health** (built) | `/settings/sync`, feed pill | Healthy / Delayed (> 2 h) / Last run failed / Not synced yet; runs table. |

### States

- **Plan & usage**: loading = 6 skeleton meter rows; error = `ErrorState` with "Try again"; enterprise = meters show
  "Unlimited" with no bar; over-limit (after downgrade) = red bar capped at 100 % and text "12 / 5 — over plan limit".
- **Banners**: never shown on `/`, `/login`, `/signup`, `/onboarding`; only one banner at a time (expired wins).
- **Dialog**: focus moves to the dialog title; Esc and "Close" return focus to the triggering button.
- **Rate-limit**: the countdown text updates every second for < 60 s, every minute otherwise; buttons stay enabled
  (server is the source of truth).

### Responsive behaviour

- **375 px**: Plan & usage meters stack one per row full width; banner wraps to two lines with the link on its own line;
  dialog is a bottom sheet with full-width buttons stacked (primary on top); no horizontal scroll.
- **≥ 1024 px**: meters in a 2-column grid (3 at ≥ 1280 px); banner single line; dialog centred 480 px wide.

### Accessibility

- Meters: `role="progressbar"`, `aria-label` = meter name, `aria-valuenow`, `aria-valuemin=0`, `aria-valuemax` (omitted
  for unlimited, with `aria-valuetext="7 used, unlimited"`); colour is never the only signal (text "80 %+" / "Limit
  reached" is shown).
- Banners: `role="status"` (info) / `role="alert"` (expired); link text is descriptive ("See plans", not "here").
- Rate-limit and 402 messages are announced via `aria-live="polite"`/`role="alert"`.
- Contrast ≥ 4.5:1 in light and dark themes; axe (wcag2a, wcag2aa, wcag21a, wcag21aa) has 0 serious/critical
  findings on `/settings/usage` and with each banner visible.

### Key Entities *(include if feature involves data)*

- **Tender source** (`tenders.source`): `gem` (public, global) or `demo` (visible only to orgs with demo on) *(gap)*.
- **GeM throttle lease** (`gem_throttle`): single row `id='gem'`, `next_slot_at` — the next time any isolate may call
  GeM *(gap)*.
- **Ingestion run** (`ingestion_runs`, built): trigger, status, counters, timestamps; at most one `running` *(gap:
  index)*.
- **Rate-limit window** (`rate_limits`): key (`<rule>:<subject>`), window start, count *(gap)*.
- **Plan limits** (`PLAN_LIMITS`, code): per plan seats, watchlists, analyses/AI analyses/packets per month, vault bytes
  *(gap)*.
- **Organization** (built + `trial_ends_at` gap): plan, trial end.
- **Subscription** (`subscriptions`): org, plan, status, start/end, note (invoice reference) *(gap)*.
- **LLM usage** (`llm_usage`): org, analysis, kind, model, input/output tokens, time *(gap)*.
- **Tender document extraction cache** (`tender_documents.requirements/extractor_version/extracted_at/
  extracted_method`) *(gap, SHOULD)*.
- **QA evidence bundle** (`qa/evidence/<spec>/US<n>/`): screenshots `*.png`, videos `*.webm`, API transcripts
  `*.txt|*.json`, `VERDICT.md` (built convention; gap: CI upload + DoD check).
- **Runbook** (`docs/runbook.md`) and **workflows** (`.github/workflows/{ci,deploy,dod}.yml`) *(gap)*.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100 % of PRs merged to `main` after this spec ships have green `typecheck`, `unit`, `api`, `e2e`,
  `migrations-additive` checks, and 100 % of story PRs have an approved `VERDICT.md` with evidence.
- **SC-002**: 100 % of production deploys run through `deploy.yml` with migrate-before-deploy; 0 laptop deploys after
  launch (audited from Cloudflare deployment history: every deployment has a CI author).
- **SC-003**: Restore drill completes in ≤ 60 minutes on staging and is repeated quarterly.
- **SC-004**: 0 demo tenders visible to orgs without demo data (verified by isolation test and a production SQL check
  `select count(*) from tender_matches m join tenders t on t.id=m.tender_id where t.source='demo' and org has no demo`
  = 0).
- **SC-005**: GeM inter-request gap ≥ 1 s in 100 % of samples under a 20-concurrent fetch test; 0 GeM 429/403 responses
  per week in production logs.
- **SC-006**: Feed p95 < 300 ms at 500k tenders; health p50 < 150 ms; 0 connection errors at 50 concurrent requests.
- **SC-007**: 0 Cloudflare 1102 (resource limit) errors per week for analyses and packets; every over-cap input gets a
  specific 413/422 message.
- **SC-008**: LLM spend per org is bounded by `llmAnalysesPerMonth`; `llm_usage` totals reconcile with the provider
  invoice within 5 % monthly.
- **SC-009**: A cron failure or ingestion stall is detected and the on-call notified within 15 minutes (2 × 5-minute
  checks + delivery) in a staging fire drill.
- **SC-010**: Every 5xx in production can be traced from the user-visible request id to a log line and an error report
  in < 2 minutes.
- **SC-011**: Trials end automatically on day 14 for 100 % of trial orgs; upgrading via the admin endpoint restores
  writes within one request.

## Assumptions

- Production runs on Cloudflare **Workers Paid** (needed for `cpu_ms = 120000`, Cron, and > 50 subrequests) and Neon
  **Launch** or higher (≥ 7 days history retention, pooled endpoint).
- The app domain is `app.tenderpilot.in` (placeholder `<APP_DOMAIN>`; DNS on Cloudflare); staging is
  `staging.tenderpilot.in`.
- The first paying customers are onboarded by invoice; plan changes are made by TenderPilot staff via the admin
  endpoint (FR-042). Self-serve checkout (Razorpay) is LATER (ARCH-25).
- Limits in FR-034 and FR-019 are launch defaults chosen to match the published plan blurbs (Starter 3 users / 5
  watchlists; Pro 10 users / unlimited watchlists / WhatsApp); they are constants and can be tuned without schema
  changes.
- The uptime monitor is an external SaaS (e.g. Better Stack / UptimeRobot free tier); its choice is an operator
  decision recorded in the runbook.
- Sentry is optional; without `SENTRY_DSN` the reporter is a no-op and Workers Logs (`[observability] enabled`) remain the
  source of truth.
- GitHub Actions minutes and artifact storage are sufficient for 30-day evidence retention; long-term evidence for
  approved stories is committed to `qa/evidence/` (screenshots + video, not traces).
- mock-gem (`tools/mock-gem`) remains the GeM stand-in for CI and staging; staging never calls the real GeM unless
  `GEM_BASE_URL` is explicitly set to it.
- Code adapted from reference repositories (see plan.md "What to port") is used under Apache-2.0/MIT and attributed in
  `NOTICE`; repositories without a licence are consulted for patterns only.
