# TenderPilot runbook

## Launch checklist

### Release gate: spec 002 auth hardening (008/FR-023)

No paid plan may be activated (no `POST /api/admin/orgs/:id/plan` to `starter`/`pro`, no invoice) until every MUST row
below reads **pass**. A row passes only when its spec 002 acceptance scenarios have a QA verdict `qa:approved` in
`qa/evidence/002/US<n>/VERDICT.md` with every criterion `met`, and the implementing tasks are ticked in
`specs/002-platform-tenancy/tasks.md`. SHOULD rows are recorded but do not block.

Last checked: 2026-11-05, against `main` at `78ccfe4` (after 002/US2 #487, 002/US3 #495 and 002/US5 #502 merged), by
008/US3 (T057, review round 2). Sources are repository files only (QA verdicts and task ticks); re-check them before each paid
activation and update this table.

| 002 requirement | Level | Spec 002 scenarios | Implementing tasks (issue) | QA verdict | Gate |
|---|---|---|---|---|---|
| FR-010 auth failure limits (10/email, 30/IP per 15 min, 429 + `Retry-After`) | MUST | US1 scenario 14 | T024–T027 ticked | [`qa/evidence/002/US1/VERDICT.md`](../qa/evidence/002/US1/VERDICT.md) `qa:approved`, rows 14a–14c met | **pass** |
| FR-011 password reset (single-use 60-min link, 3/email and 20/IP per hour) | MUST | US1 scenario 15 | T028–T029 ticked | [`qa/evidence/002/US1/VERDICT.md`](../qa/evidence/002/US1/VERDICT.md) `qa:approved`, rows 15a–15c met (15b by API test only) | **pass** |
| FR-018 invite email binding (403 `invite_email_mismatch`) | MUST | US2 scenario 12 | T042 (#23), QA T045 (#26) ticked | [`qa/evidence/002/US2/VERDICT.md`](../qa/evidence/002/US2/VERDICT.md) `qa:approved` (round 2), rows 12a–12b met | **pass** |
| FR-028 `bad_origin` (cookie POST with foreign `Origin` → 403; Bearer exempt) | MUST | US3 scenario 11 (also 008/US3 scenario 9) | T055 (#31), QA T057 (#33) ticked | [`qa/evidence/002/US3/VERDICT.md`](../qa/evidence/002/US3/VERDICT.md) `qa:approved` (round 2), rows 11a–11c met | **pass** |
| FR-012 session list / revoke | SHOULD | US1 scenario 16 | T030–T032 ticked | [`qa/evidence/002/US1/VERDICT.md`](../qa/evidence/002/US1/VERDICT.md) `qa:approved`, rows 16a–16c met | pass |
| FR-037 API token expiry, hint, 10-token cap | SHOULD | US5 | T074–T077 (#39–#42), QA T078 (#43) ticked | [`qa/evidence/002/US5/VERDICT.md`](../qa/evidence/002/US5/VERDICT.md) `qa:approved` | pass |

**Gate status: PASS** — every MUST row (FR-010, FR-011, FR-018, FR-028) and both SHOULD rows (FR-012, FR-037) have
approved QA verdicts.

How to re-check:

1. `ls qa/evidence/002/` — each story that implements a row above must have `VERDICT.md` ending in `qa:approved`
   with no `not met` row for the listed scenarios.
2. `grep -nE "T042|T055|T074|T075|T076|T077" specs/002-platform-tenancy/tasks.md` — the lines must read `- [x]`.
3. Run the API suite (`pnpm --filter @tp/api exec vitest run`); `rate-limit.test.ts`, `password-reset.test.ts`,
   `ops-limits.test.ts`, `isolation-contract.test.ts` (008 contract/app-route sweep, demo tenders) and
   `isolation.test.ts` (002 resource sweep) must pass.
4. Update the table and the "Last checked" line above in the release PR.

### Before running migration 0010 (demo data-fix, 008/FR-016)

`packages/db/migrations/0010_demo_source_datafix.sql` deletes data. Before migrating any environment that has had
demo data loaded:

1. Create a Neon branch (or snapshot) of the database and note its name in the release PR; it is the rollback path.
2. Optionally count what will go: demo-marked tenders (`raw->>'demo' = 'true'` or `content_hash = 'demo-' || bid_number`)
   and, for orgs without `onboarding_state.demo = true`, their `tender_matches`, `notifications`, `analyses`,
   `bid_workspaces` (with comments and packets) and org-uploaded `tender_documents` on those tenders.
3. Run `db:migrate`. What it does: converts those tenders to `source = 'demo'` (a demo-marked `gem` row whose bid number
   already exists as `demo` is a duplicate and is deleted, with its cascades); for non-demo orgs deletes the matches
   and alerts they produced and any analyses, workspaces (comments, packets cascade) and uploaded documents built on
   them (bids on tenders that do not exist on GeM). Demo orgs keep everything. Blobs of deleted packets/documents stay
   in R2 unreferenced.

### Abuse and isolation controls in place (008/US3)

- Demo tenders are `source = 'demo'` and visible only to orgs with `onboarding_state.demo = true` (every tender read
  path, every `/tenders/:id*` route); rows still marked `raw.demo = true` are hidden from everyone else even if stored
  as `gem`. Watchlists in demo orgs match demo tenders silently (no alerts); other orgs never match them.
- Rate-limit rules: `apps/api/src/lib/rate-limit-rules.ts` (429 `rate_limited` + `Retry-After`). Generic rules fail
  open with a `rate_limit_unavailable` warn log; `auth.*` rules fail closed with 503 `service_unavailable`.
- Body caps (413 `payload_too_large` before the body is read): JSON 1 MB, vault 20 MB, tender documents 25 MB.
- Body caps are chosen by route: the three upload routes (`POST /api/vault`, `PUT /api/vault/:id/file`,
  `POST /api/tenders/:id/documents`) get their file cap; everything else is 1 MB whatever the content type.
- Client IP (`TRUST_PROXY`):
  - Worker: `cf-connecting-ip`; `worker.ts` sets `TRUST_PROXY=cloudflare`. Do not set it anywhere else: the Node server
    refuses to start with `TRUST_PROXY=cloudflare` because a client could send that header directly.
  - Node behind exactly one reverse proxy: `TRUST_PROXY=1`; the right-most `x-forwarded-for` hop (the one the proxy
    appended) is used. Behind a chain of proxies only the last one's view is used.
  - Node without `TRUST_PROXY`: the socket address. A loopback socket counts as unknown (per-IP rules off) and
    production logs `client_ip_unknown` once — set `TRUST_PROXY=1` in that case.
  - IPv6 clients are limited per /64.
- Fixed windows: a client can burst up to twice a limit across a window boundary. A limiter call slower than 300 ms is
  treated as unavailable (fail-open, `rate_limit_unavailable` logged at most once per rule per 10 s).

## Monitors

Source of truth: `GET https://<APP_DOMAIN>/api/health` (008/FR-044). No auth; no org data. Example:

```json
{ "ok": false, "db": true, "version": "0.1.0",
  "ingestion": { "lastSuccessAt": "2026-06-01T08:55:00.000Z", "ageMinutes": 185, "lastStatus": "failed", "state": "stale" },
  "alerts": { "pendingOlderThan30m": 0 }, "reasons": ["ingestion_stale"] }
```

| Field | Meaning |
|---|---|
| `ingestion.state` | `ok` (last success within `HEALTH_INGESTION_MAX_AGE_MIN`, default 120), `stale` (older, or no success ever although the first run started more than the threshold ago), `never` (no success yet and no run older than the threshold; HTTP 200 so a fresh stack is not paged). While `db` is false the ingestion and alert fields are placeholders. |
| `ingestion.lastStatus` | status of the most recent run (`success`, `partial`, `failed`, `running`). A `failed` latest run does not page by itself; staleness does. |
| `alerts.pendingOlderThan30m` | email/WhatsApp notifications still `pending` 30 minutes after creation (the dispatcher runs every cron tick; in-app rows are excluded). Daily-digest `tender_match` rows are held until 08:00 IST on purpose and count only once that slot is more than 30 minutes past. |
| `reasons[]` | `db_unreachable`, `ingestion_stale`, `alerts_backlog`. HTTP 503 whenever non-empty. Each query has a 3 s timeout, so a hung database answers 503 rather than hanging the monitor. |

External uptime monitor (FR-047; the vendor and account are set up by the operator, see T099 in the spec tasks):

- Production: poll `https://<APP_DOMAIN>/api/health` every 5 minutes, alert the on-call email/phone after 2 consecutive
  non-200 results. Detection: about 10 minutes for `db_unreachable` and `alerts_backlog`; for an ingestion stall the
  health check only turns red once the last success is older than `HEALTH_INGESTION_MAX_AGE_MIN` (default 120), so
  it is **not** the 15-minute path of SC-009 on its own. Cron failures inside that window are caught by Sentry: every
  failed cron step is reported immediately with tag `job` (`ingestion`, `alerts`, `reminders`, ...). Configure a Sentry
  alert rule "any event with tag `job`" that notifies on-call; together with the monitor that meets SC-009.
- Staging: a separate monitor on the staging URL that alerts only the team channel.
- Keyword check (optional): response contains `"ok":true`.

Logs and errors:

- Logs are JSON lines (`ts`, `level`, `msg`, fields). `LOG_LEVEL` = `debug|info|warn|error` (default `info`). Keys named
  like `password|token|secret|cookie|authorization|api_key|dsn|database_url` are redacted, and string values have URL
  passwords (`://user:pass@`), `Bearer …` and `tp_…` tokens scrubbed. Health polls log at `debug` only.
- Every API response carries `x-request-id`; the same value is the `rid` field on the request log line and on Sentry events.
- Sentry is active only when `SENTRY_DSN` is set (`SENTRY_ENVIRONMENT` = `production|staging|development`; release is
  `APP_VERSION`). The Worker always runs with `NODE_ENV=production`, so the **staging deploy must set
  `SENTRY_ENVIRONMENT=staging`** or its events are tagged `production`. Unhandled API errors, Worker bootstrap failures
  and failed cron steps (tag `job`) are reported; expected `HttpError`s are not. Events carry only `rid`, `orgId`,
  `userId`, the route pattern and the path: request headers, cookies, body and query string are stripped before
  sending, and no trace headers are added to outbound calls.

## First 10 minutes

Start with `curl -s https://<APP_DOMAIN>/api/health`, note the time, and look at `reasons`.

### `db_unreachable`

1. Check the database provider status page and the Neon console (branch up? compute suspended? connection limit?).
2. Workers Logs: filter `msg:"health: database unreachable"`; the `error` field says timeout vs refused vs auth.
3. If `DATABASE_URL` changed recently, `wrangler secret list` and redeploy with the right secret.
4. Still down after 10 minutes: escalate (below). Do not run migrations or restore while diagnosing.

### `ingestion_stale`

1. Look at the latest runs:
   ```sql
   select id, trigger, status, started_at, finished_at, pages_fetched, tenders_seen, listing_stop, left(error, 200) as error
   from ingestion_runs order by started_at desc limit 5;
   ```
2. A row stuck in `running` older than 15 minutes is reaped by the next run; if no new rows appear at all the cron is
   not firing: check the Cloudflare dashboard, Worker, Triggers, Cron (`*/30 * * * *`) and Workers Logs for
   `msg:"scheduled run finished"`.
3. `failed` rows: read `error`. HTML instead of JSON, 403 or 429 means GeM is blocking us, see "GeM 403/429".
4. After the cause is fixed, run **Sync now** from Settings (2-minute cooldown after the last manual run) or wait for
   the next tick; `/api/health` returns 200 once a `success` or `partial` run finishes.

### `alerts_backlog`

1. Find what is stuck:
   ```sql
   select channel, kind, count(*), min(created_at) from notifications
   where status = 'pending' and created_at < now() - interval '30 minutes' group by 1, 2;
   ```
2. Workers Logs: `msg:"scheduled step failed: alerts"` or mailer/WhatsApp warnings (`Resend`, `WhatsApp`). A bad
   `RESEND_API_KEY`/`WHATSAPP_TOKEN` keeps rows pending or failed; fix the secret and the next cron tick drains them.
3. If the cron itself is not running, treat it as `ingestion_stale` step 2.

### 5xx spike

1. Workers Logs: filter `level:"error"` and `msg:"unhandled error"`; group by `path`. Each line has `rid`.
2. Take a `rid` from a failing user report or a Sentry event (same value as the `x-request-id` response header) and filter
   Workers Logs by `rid:"<value>"` to see that request line (`status`, `ms`, `orgId`, `userId`) and its error.
3. To scope the blast radius filter by `orgId:"<uuid>"`; one org only usually means bad data, all orgs means a deploy.
4. Started right after a deploy: `wrangler rollback` (never roll back migrations; roll forward).

### GeM 403/429

1. `select status, left(error, 200), started_at from ingestion_runs where status = 'failed' order by started_at desc limit 5;`
   Messages such as `GeM returned HTML instead of JSON` or HTTP 403/429 mean the portal is throttling or blocking us.
2. Do not increase the request rate. The GeM request rate is capped (spec 008 NFR-002: 1 request per second cluster-wide); leave the
   cron to retry on its next tick and keep the manual cooldown. Never bypass CAPTCHA or authentication.
3. If blocking persists for more than a day, tell customers the feed is delayed (sync health already shows
   "Delayed"/"Last run failed") and escalate.

### Escalation

1. Minute 0 to 10: the on-call person works the section above. Post findings in the team channel with the `rid` or SQL
   output used.
2. Not resolved at minute 10, or customer data may be affected: page the owner of the area (database: platform lead;
   GeM: ingestion lead) and open an incident issue with the timeline.
3. Anything that looks like data exposure (a log line with a secret, cross-org data): stop, rotate the secret, and
   follow the secret-rotation procedure (FR-048). That section is not written yet (task T039); until then rotate with
   `wrangler secret put <NAME>`, redeploy, and revoke the old credential at the provider.

## Monitor configuration and fire-drill record

Filled in by the operator (T099). Story #361 stays open until this table and the QA evidence (T100) are complete.

| Item | Production | Staging |
|---|---|---|
| Vendor / account | _TBD_ | _TBD_ |
| URL monitored | `https://<APP_DOMAIN>/api/health` | `https://<STAGING_DOMAIN>/api/health` |
| Interval / failures before alert | 5 min / 2 | 5 min / 2 |
| Alert routing | _TBD (on-call email + phone)_ | _TBD (team channel only)_ |
| Sentry `job` alert rule | _TBD_ | _TBD_ |
| Fire drill date | n/a | _TBD_ |
| Drill method | n/a | _TBD (stop cron, or point `GEM_BASE_URL` at a dead host)_ |
| Measured detection time (failure to notification) | n/a | _TBD (SC-009: at most 15 min)_ |

## CI

Every PR into `main` and every push to `main` runs `.github/workflows/ci.yml`; story PRs also run
`.github/workflows/dod.yml` (spec 008 US1, FR-001..FR-006).

| Check (job name) | Workflow | What it proves | Timeout |
|---|---|---|---|
| `typecheck` | ci | `pnpm typecheck` + `pnpm typecheck:scripts` (scripts/, e2e/); `pnpm audit --prod --audit-level high` (advisory, see below) | 10 min |
| `unit` | ci | `pnpm -r --filter '!@tp/api' run test` (core, web, extension) + `pnpm test:scripts` | 10 min |
| `api` | ci | `pnpm --filter @tp/api test` against a `postgres:16` service on `:5433` (`TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test`); runs after `unit` | 15 min |
| `e2e` | ci | Runs after `api` as `e2e-shard-1..8` (matrix, 30 min each, not required checks): `scripts/e2e-ci.sh <n> 8` runs every spec file of its shard (`scripts/e2e-shard.ts`, balanced by test count) as its own Playwright invocation on a freshly recreated `E2E_DATABASE_URL=…/tenderpilot_e2e` (specs assume a fresh DB); real API + SPA + mock-gem; extra server env from a spec's `@e2e-env KEY=value` header line. The required `e2e` job (skipped unless `api` passed) merges the shard blob reports into `qa/.runs/8788/results.json` + HTML report, writes the job summary from `scripts/e2e-summary.ts`, uploads artifact `e2e-evidence-<run_id>` with `qa/evidence/**` + `qa/.runs/**` (30 days, also on failure) and fails unless every shard passed | 30 min |
| `migrations-additive` | ci | `scripts/check-migrations.ts` over migrations added/changed vs the PR base, then `pnpm --filter @tp/db generate` must leave no diff (schema drift) | 10 min |
| `ci-gate` | ci | Aggregator (`if: always()`, needs every job above plus `changes`): fails if any of them failed or was cancelled, or if the `changes` path filter itself did not succeed | 5 min |
| `deploy` | ci → deploy.yml | Push to `main` only, after `ci-gate` succeeded: calls the reusable deploy workflow (see below). Not a required check | 5 min |
| `dod` | dod | `scripts/dod-check.ts`: `qa/evidence/<nnn>/US<n>/VERDICT.md` exists and is approved (`## QA verdict — APPROVED`, `qa:approved` or `Verdict: approved`; any REJECTED / `qa:rejected` wins), every criterion row's Verdict cell is `met` (`not met`, `unverifiable`, blank fail), ≥ 1 `.png` and ≥ 1 `.webm` present and linked, every PR commit carries `Work-Item`/`Requirement`/`Agent-Role`/`Harness`. Always runs; fails if `dod-changes` errors | 5 min |

- **Docs-only PRs** (every changed path under `specs/**`, `docs/**` or `*.md`, none under `qa/evidence/**`; see
  `scripts/docs-only.sh`; the diff uses `--no-renames`, so moving code into `docs/` is not docs-only) run only
  `typecheck`; `unit`, `api`, `e2e` and `migrations-additive` are skipped, `ci-gate` passes, and `dod` passes with a
  "docs-only" note. Skipped jobs count as passing for required checks, which is why the required checks are the
  always-running `ci-gate` and `dod` rather than the individual (skippable) jobs.
- **Story resolution in `dod`**: PR title `[<NNN>/US<n>] …`, else `Closes #<issue>` / `Work-Item:` issue numbers mapped
  through the `(#issue)` references in `specs/<NNN>-*/spec.md` and `tasks.md`, else label `spec:<NNN>` + `US<n>` in the
  title/body. PRs with no story (hardening) pass with a note; a `type:story` PR with no resolvable story fails.
- **Destructive migrations**: `DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN … TYPE`, `RENAME`, `SET NOT NULL` without a
  `DEFAULT` for that column in the same statement, `ADD COLUMN … NOT NULL` without `DEFAULT`, `DROP TYPE`,
  `DROP SCHEMA` and `TRUNCATE` fail `migrations-additive` unless line 1 of the file is
  `-- tp:allow-destructive <reason>`. Deleting or renaming an existing migration file always fails.
- **Dependency audit**: `pnpm audit --prod --audit-level high` reported 17 advisories on `main` when the gate was added
  (6 moderate, 10 high, 1 critical), tracked in Shashank2577/GEMs#479, so the step is `continue-on-error: true`
  (visible as a warning, not a red check). Make it blocking by removing that line when #479 is closed.
- **Deploy hand-off (scenario 8, FR-007)**: job `deploy` in `ci.yml` has `needs: ci-gate` and
  `if: github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.ci-gate.result == 'success'`, and calls
  the reusable `.github/workflows/deploy.yml` (`on: workflow_call` + `workflow_dispatch`, `secrets: inherit`). A green
  push to `main` starts a deploy; a red `ci` (any job failed or cancelled, hence `ci-gate` failed) never does. On PRs the
  `deploy` job is skipped; `ci-gate` does not need it, so that never affects the gate. `deploy.yml` holds
  `concurrency: deploy` (no cancel) on its job, not on the caller, which would deadlock on the same group. Until US2
  task T036 it is a placeholder that only prints the SHA. `workflow_run` is deliberately not used: it only fires for
  workflow files on the repository's **default branch**, which is currently not `main`. Manual redeploys use
  `workflow_dispatch` (`gh workflow run deploy.yml --ref main`); note that GitHub only lists/dispatches workflows that
  also exist on the default branch.
- **Run locally**: `pnpm typecheck && pnpm typecheck:scripts`, `pnpm -r --filter '!@tp/api' run test`, `pnpm test:scripts`,
  `TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test pnpm --filter @tp/api test`, `pnpm e2e` (or one CI shard: `CI=1 scripts/e2e-ci.sh 1 8`),
  `pnpm exec tsx scripts/check-migrations.ts --base origin/main`,
  `PR_TITLE='[008/US1] …' BASE_SHA=origin/main pnpm exec tsx scripts/dod-check.ts`.

### Branch protection on `main`

Required status checks (FR-003): `typecheck`, `unit`, `api`, `e2e`, `migrations-additive`, `dod`, plus the
aggregator `ci-gate` (branch must be up to date). A skipped job counts as passing for branch protection, so `ci-gate`
closes the gap where the path filter itself errors and every gated job is skipped;
force pushes and branch deletion disabled; applies to admins. The workflows must already exist on `main` for the
checks to be selectable. Apply (repo admin, from a clone of the repo):

```sh
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -H "Accept: application/vnd.github+json" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["typecheck", "unit", "api", "e2e", "migrations-additive", "dod", "ci-gate"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Verify:

```sh
gh api repos/:owner/:repo/branches/main/protection \
  --jq '{checks: .required_status_checks.contexts, strict: .required_status_checks.strict, force_push: .allow_force_pushes.enabled}'
```

A red required check (or a pending one) shows "Required statuses must pass before merging" and disables the merge button.
