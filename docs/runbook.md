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

## Data retention and housekeeping

Spec 008 US7, FR-070, ADR-0012. The single source of truth is `RETENTION` in
[`apps/api/src/services/housekeeping.ts`](../apps/api/src/services/housekeeping.ts) (pinned by
`apps/api/test/housekeeping.test.ts`); change both together, and this table.

| Data | Rule |
|---|---|
| `sessions` | deleted 7 days after `expires_at` |
| `invitations` | deleted 30 days after acceptance, or 30 days after expiry when never accepted |
| `notifications` | `read` / `sent` / `skipped`: deleted 180 days after creation; `failed`: after 30 days; `pending` never |
| `tender_events` | deleted after 365 days, only for tenders that are no longer `open` |
| `tenders.raw` | set to `NULL` 90 days after the tender closed (`coalesce(end_at, updated_at)`), real tenders only; rows are kept |
| `rate_limits` | windows older than 1 day (the `rate-limit-cleanup` step also prunes every 30 min) |
| `packets` | the newest 5 per workspace are kept; older ones (not `building`) lose their R2 object first, then the row |
| `gem_throttle`, `activity_log`, `llm_usage` | never touched by housekeeping |

How it runs: the `housekeeping` step of `runScheduledJobs` (after `rate-limit-cleanup`) runs on the first cron tick at
or after **02:00 IST** each IST day. It claims the day in `job_runs (job='housekeeping', day)` — every other tick and
isolate that day skips. Deletes run in batches of 1,000 rows, at most 50 batches per rule per run (the rest is picked
up the next day). Packet R2 objects are deleted with R2's multi-key delete (≤ 1,000 keys per call), at most 1,000
packet objects per run. A failed R2 delete keeps those packet rows for the next run (no orphaned objects); a run that
throws deletes its claim, so the next tick retries. Every rule is idempotent (a second run deletes 0). `tenders.raw` is
only nulled on real tenders (`REAL_ONLY`): the demo marker in `raw` is what keeps demo tenders out of other orgs' feeds.

Check it ran (one JSON line per day in Workers Logs / `wrangler tail`):

```sh
wrangler tail --format json | grep '"housekeeping finished"'
# {"level":"info","msg":"housekeeping finished","job":"housekeeping","day":"2026-11-06",
#  "deleted":{"sessions":12,"invitations":0,"notifications":311,"tenderEvents":0,"tenderRaw":845,"rateLimits":0,"packets":3,"packetBlobs":3},"ms":412}
psql "$DATABASE_URL" -c "select day, started_at, finished_at, summary from job_runs where job='housekeeping' order by day desc limit 7"
```

A claim with `finished_at IS NULL` older than an hour means the run died mid-way (Worker CPU limit or eviction): the
first cron tick after that hour takes the claim over and re-runs the day by itself (`HOUSEKEEPING_STALE_CLAIM_MS`) —
nothing to do. To re-run a day on purpose, delete that day's row
(`delete from job_runs where job = 'housekeeping' and day = '<YYYY-MM-DD>'`) and the next tick runs it; there is no
manual endpoint.

### Shared LLM extraction cache (FR-072)

GeM-fetched documents (`tender_documents.org_id IS NULL`) keep the LLM's requirements in `requirements`, with
`extracted_method = 'LLM'` and `extractor_version` = `CURRENT_EXTRACTOR_VERSION` (packages/core/src/analyse/llm.ts);
every org's analysis reuses them without an LLM call. An org's own uploads are never cached. Empty or malformed LLM
replies are never cached. Bumping `CURRENT_EXTRACTOR_VERSION` re-extracts every document once, lazily. To drop one bad
entry (the next analysis of that document calls the LLM again):

```sh
psql "$DATABASE_URL" -c "update tender_documents set extractor_version = null where id = '<documentId>' and org_id is null"
```

## R2 lifecycle for packets

FR-071 asks for an R2 lifecycle rule expiring packet PDFs after 365 days as defence in depth for the packet rule
above. **Constraint (spec conflict, raised on the US7 PR):** R2 lifecycle rules match a literal key **prefix** only;
packet keys are `org/<orgId>/packets/<packetId>/<file>.pdf` (pinned by spec 006 tests), so `org/*/packets/` cannot be
expressed, and a rule on `org/` would also expire **vault** files (customer data, never lifecycle-expired). Until the
architect decides between (a) moving new packets under a top-level `packets/` prefix (offboarding then purges both
prefixes) or (b) one rule per org — tracked in #552 — the DB-driven housekeeping is the only packet expiry. **No
lifecycle rule is configured today.** If a packet's object is ever missing (lifecycle, manual purge), its download answers
404, never 500 (`apps/api/test/packet.test.ts`). Per-org rule (b), at most
1,000 rules per bucket:

```sh
wrangler r2 bucket lifecycle add tenderpilot-blobs "packets-<orgId>" "org/<orgId>/packets/" --expire-days 365
wrangler r2 bucket lifecycle add tenderpilot-blobs-staging "packets-<orgId>" "org/<orgId>/packets/" --expire-days 365
wrangler r2 bucket lifecycle list tenderpilot-blobs      # verify
```

With option (a) the single rule would be
`wrangler r2 bucket lifecycle add tenderpilot-blobs packets-365d "packets/" --expire-days 365`.

## Offboarding

Deleting an organisation on a confirmed request (ADR-0012 §3; FR-048, FR-071). Tenant data is deleted within 30 days
of the confirmed request; public tender data (`tenders`, GeM-fetched `tender_documents`) is kept.

1. Export first if the customer asked for it: vault files (`org/<orgId>/vault/…` in R2) and a JSON of profile,
   analyses and workspaces (`GET /api/org`, `/api/profile`, `/api/vault`, … with an owner token).
2. Record the request (who asked, when, ticket) in the incident/ops log.
3. Delete the org — every org-owned table cascades on `organizations.id`:

   ```sh
   psql "$DATABASE_URL" -c "begin; select id, name from organizations where id = '<orgId>';
     delete from organizations where id = '<orgId>'; commit;"
   ```

   Users who belonged only to this org keep their `users` row (they can sign in and create or join another org);
   delete them separately on request (`delete from users where id = …` cascades their sessions).
4. Purge the org's R2 prefix (vault files, packets, uploaded tender documents live under `org/<orgId>/` and
   `tenders/<tenderId>/<orgId>/`):

   ```sh
   # list, then delete every object under the org prefix (rclone with the R2 S3 endpoint, or the dashboard)
   rclone ls  r2:tenderpilot-blobs/org/<orgId>/
   rclone purge r2:tenderpilot-blobs/org/<orgId>/
   # uploaded tender documents: keys tenders/<tenderId>/<orgId>/<docId>.pdf
   rclone lsf -R r2:tenderpilot-blobs/tenders/ --include "*/<orgId>/*" | xargs -I{} rclone deletefile r2:tenderpilot-blobs/tenders/{}
   ```

5. Verify: `select count(*) from memberships where org_id = '<orgId>'` is 0 and `rclone ls …/org/<orgId>/` is empty.
   Neon point-in-time history still holds the data until it ages out of the retention window (≥ 7 days, ADR-0013).

## Hyperdrive

FR-075, ADR-0002. The Worker connects with one driver (`pg`): `createNodeDb(url, { max: 5 })`, where `url` is the
`HYPERDRIVE` binding's `connectionString` when the binding exists, else the `DATABASE_URL` secret (Neon pooled
`-pooler` URL — also what `pnpm db:migrate` uses). The pool fails a connection attempt after 10 s
(`connectionTimeoutMillis`).

**Current state: the binding is NOT enabled.** `wrangler.toml` ships the `[[hyperdrive]]` table commented out, because
it needs a real config id that only an operator can create; until then production runs on `DATABASE_URL` (exactly the
pre-FR-075 connection path, minus the second driver) and `wrangler deploy` needs no Hyperdrive config.

### Enable Hyperdrive (operator, once per environment; Cloudflare API token with Hyperdrive edit)

```sh
wrangler hyperdrive create tenderpilot-db --connection-string="$NEON_POOLED_URL" --caching-disabled
wrangler hyperdrive get <id>            # caching.disabled must be true
# wrangler.toml: uncomment the [[hyperdrive]] table and paste <id>; deploy staging first, then production
wrangler deploy --dry-run | grep HYPERDRIVE   # the bindings table lists env.HYPERDRIVE
```

Staging (spec 008 US2 owns `[env.staging]`; bindings are not inherited by environments): once `[env.staging]` exists,
add to it

```toml
[[env.staging.hyperdrive]]
binding = "HYPERDRIVE"
id = "<id from: wrangler hyperdrive create tenderpilot-db-staging --connection-string=$NEON_STAGING_POOLED_URL --caching-disabled>"
```

— never as a bare `[[env.staging.hyperdrive]]` table without the rest of `[env.staging]` (that silently creates a
staging environment with no vars and no R2 bucket).

Caching stays **disabled**: Hyperdrive's query cache would serve stale reads right after writes (correctness first).

### Staging verification (T111, operator — not runnable from CI)

Proves FR-075 / NFR-003 on staging after the binding is deployed. Record the transcript in
`qa/evidence/008/US7/hyperdrive-staging.txt`.

```sh
# 1. The deployed Worker uses the binding (the bindings table lists env.HYPERDRIVE)
wrangler deploy --env staging --dry-run | grep HYPERDRIVE
# 2. 50 concurrent feed requests → 0 non-2xx / 0 connection errors
N=200 C=50 P95_BUDGET_MS=300 scripts/load/feed.sh https://staging.tenderpilot.in | tee -a qa/evidence/008/US7/hyperdrive-staging.txt
wrangler tail --env staging --format json | grep -iE 'too many connections|ECONNRESET|connection terminated' # expect nothing
# 3. Health latency: p50 < 150 ms, p95 < 400 ms (NFR-003)
for i in $(seq 100); do curl -s -o /dev/null -w '%{time_total}\n' https://staging.tenderpilot.in/api/health; done \
  | sort -n | awk '{a[NR]=$1} END {print "p50", a[int(NR*0.5)]*1000, "ms  p95", a[int(NR*0.95)]*1000, "ms"}' | tee -a qa/evidence/008/US7/hyperdrive-staging.txt
```

Rollback: remove the `[[hyperdrive]]` table (or deploy the previous version with `wrangler rollback`); the Worker then
uses `DATABASE_URL`.

## Full-text search migration

FR-073 adds the generated column `tenders.search` and the indexes `tenders_search_gin` / `tenders_bid_number_prefix_idx`
(`packages/db/migrations/*_tenders_search.sql`, `-- tp:non-transactional`). Adding a STORED generated column
**rewrites `tenders` under an ACCESS EXCLUSIVE lock** (≈ 1 minute at 500k rows): reads and ingestion block meanwhile.
Run `pnpm db:migrate` for this release **off-peak** (before 07:00 IST), then deploy. The indexes are built
`CONCURRENTLY` (no write lock). The column and indexes are deliberately not in the Drizzle schema (they would leak into
`select *` rows); `drizzle-kit` never drops them because it diffs its own snapshots, not the database — never run
`drizzle-kit push` against production.

The watchlist pre-filter is designed to be a superset of the keyword matcher: ASCII punctuation and the invisible
characters U+00AD, U+200B–U+200D, U+2060, U+FEFF become spaces on both the column and every query, and the matcher never
splits a word at a combining mark. Known, accepted gaps (case folding differs between JS and Postgres): Greek final sigma
(σ/ς) and micro sign vs mu (µ/μ) — a keyword written with one form may miss text written with the other.

## LATER triggers

Deferred decisions, each with the measurable trigger that reopens it (FR-076). Check these at the monthly ops review.

| Item | Trigger (any one) | Decision record |
|---|---|---|
| Cloudflare Queues for analysis / packet builds | analysis p95 > 60 s over a week (`tender.analysed` `total_ms` in `activity_log`); an "analyse all new matches" batch feature is scheduled; a customer needs > 300-page documents | [ADR-0007 §5](adr/0007-synchronous-analysis-and-packet-with-caps.md) |
| Postgres row-level security | a second code path to the database (reporting, admin tools, BI) is planned; or a customer security questionnaire requires RLS | [ADR-0004 §3](adr/0004-tenant-isolation-application-level.md) |
| Razorpay subscriptions + webhook | ≥ 5 paying orgs (`select count(*) from organizations where plan <> 'trial'`) | [ADR-0010 §6](adr/0010-plan-limits-and-billing-readiness.md) |
| Workers Analytics Engine request metrics | a customer asks for per-org request/usage metrics that `activity_log` + `llm_usage` cannot answer | [ADR-0011 §5](adr/0011-observability.md) |
| Weekly `pg_dump` to R2 | a customer requires off-provider backups (contract / security questionnaire) | [ADR-0013 §3](adr/0013-deployment-migrations-backups-secrets.md) |
| Revisit keeping closed tenders | `tenders` reaches 5M rows | [ADR-0012](adr/0012-data-retention-and-housekeeping.md) |

## Spec 008 launch checklist (ARCH-01 to ARCH-13)

Every recommendation from the architecture review's summary (`docs/architecture.md` § 7) mapped to the spec 008 tasks that
deliver it and the QA verdict that proves it (008/FR-023, SC-001, T116). This complements the spec 002 release gate at the
top of this file (that gate covers ARCH-11's auth rules and the 002 requirements).

Last checked: 2026-11-05, against `main` at `c75d2b6` (after 008/US3, US4, US5, US6 and US7 merged). Sources are repository
files only: `qa/evidence/008/US<n>/VERDICT.md`, ticked tasks in `specs/008-operations-scale/tasks.md` and the code. Re-check
before each paid activation and update the table and the date.

**Gate: no org may be moved to `starter` or `pro` (`POST /api/admin/orgs/:id/plan`, no invoice) until every P1 story has a QA
verdict `qa:approved` on `main`.** Today US3, US4, US5 and US6 are approved; **US1 (CI gate, PR #475) and US2 (releases,
secrets, backups, security headers; PR #492, `needs-human`) are not merged, so the gate is closed.**

| ARCH | Recommendation (level) | Spec 008 tasks | QA verdict | Status |
|---|---|---|---|---|
| 01 | Demo data does not leak into other tenants' feeds (MUST) | T044 to T048 (FR-016): `source = 'demo'`, `visibleTenderSource`, matching only `gem`, data-fix migration 0010, contract-driven isolation sweep | [US3](../qa/evidence/008/US3/VERDICT.md) `qa:approved` | **met** |
| 02 | Pooled Neon endpoint now; Hyperdrive + one `pg` driver next (MUST / SHOULD) | Pooled host: T041 (operator, FR-010). Hyperdrive: T110, T111 (FR-075) | US2 not merged; [US7](../qa/evidence/008/US7/VERDICT.md) `qa:approved`, criterion 7c unverifiable | **unverified**: the single `pg` driver and the commented `[[hyperdrive]]` binding are built; the pooled `DATABASE_URL` check (§ Secrets, from #492) and the staging connection test (T111, #468) are operator tasks not yet done |
| 03 | Global GeM lease, 10-minute manual-sync cooldown, atomic single ingestion (MUST) | T059 to T066 (FR-024 to FR-026) | [US4](../qa/evidence/008/US4/VERDICT.md) `qa:approved` (round 2) | **met** |
| 04 | Open-only partial feed indexes (MUST); full-text search column (SHOULD) | Indexes T067, T068, T070 (FR-027, FR-028); search T103 (FR-073) | US4 `qa:approved` (4e, p95 on production Neon, unverifiable); US7 `qa:approved` | **met** in CI-sized Postgres (500k tenders, p95 189 ms); production latency **unverified** until staging/Neon access |
| 05 | Pending-notifications partial index (MUST) | T069 (FR-029) | US4 `qa:approved` | **met** |
| 06 | Worker limits: `cpu_ms`, page, LLM and packet-size caps (MUST) | Caps T073 to T076 (FR-030 to FR-033); `[limits] cpu_ms` T030 (FR-009) | US4 `qa:approved` (8c, a real 301-page GeM document, unverifiable); US2 not merged | **partly met**: page, LLM budget and 40-item packet caps proven; `cpu_ms = 120000` waits for US2 (#492) |
| 07 | LLM metering + per-org quota (MUST); shared extraction cache (SHOULD) | T084, T085 (FR-037 to FR-039); T102 (FR-072) | [US5](../qa/evidence/008/US5/VERDICT.md) and US7 `qa:approved` | **met** |
| 08 | Plan limits, trial expiry, 402 contract, usage endpoint (MUST) | T079 to T091 (FR-034 to FR-042) | US5 `qa:approved`, every scenario met | **met** |
| 09 | Health with ingestion staleness + external monitor (MUST); Sentry (SHOULD) | T094 to T098 (FR-044 to FR-048); operator T099 (FR-047) | [US6](../qa/evidence/008/US6/VERDICT.md) `qa:approved`; criteria 10b (runbook sections owned by US2), 11 (monitor + fire drill) and 12 (SC-009) unverifiable | **partly met**: health v2, logs, Sentry and the runbook's monitor/first-10-minutes sections are proven; **the external uptime monitor and the staging fire drill (T099) are not configured**, so nobody is paged yet |
| 10 | CI deploy pipeline with migrations, Neon retention, custom domain, security headers (MUST) | US1: T016 to T026 (FR-001 to FR-006); US2: T030 to T042 (FR-007 to FR-015) | none yet (US1 PR #475, US2 PR #492) | **unverified** |
| 11 | Rate limiting for auth, uploads, preview, fetch-documents (MUST) | T049 to T056 (FR-017 to FR-022); auth rules are spec 002's (FR-010) | US3 `qa:approved`; [002/US1](../qa/evidence/002/US1/VERDICT.md) `qa:approved` | **met** |
| 12 | Cross-tenant isolation sweep test (MUST) | T048 (FR-016), extending 002 T052 | US3 `qa:approved` | **met**; becomes a CI gate with US1 (#475) |
| 13 | Matching efficiency (SHOULD) | T104, T105 (FR-074) | US7 `qa:approved` | **met** (not a gate) |

Numbering note: the spec's ownership table (spec 008 § Ownership boundaries) uses ARCH-12 for password reset and ARCH-13 for the
isolation sweep and mentions ARCH-19 to ARCH-26, while `docs/architecture.md` § 7 defines ARCH-12 as the isolation sweep, ARCH-13
as matching efficiency and stops at ARCH-18. This table follows `docs/architecture.md`; the mismatch is recorded in
`specs/008-operations-scale/checklists/requirements.md` (finding F-08).

### Before the first paid plan flip

1. US1 (#356) and US2 (#357) merged with `qa:approved` verdicts; every row above reads **met** except the explicitly
   operator-only items below. Merge order is not important; the gate is the verdict files on `main`.
2. Operator tasks done and noted in the release PR: pooled `DATABASE_URL` verified on staging and production (T041), Neon
   history retention of at least 7 days and one dated restore drill (FR-014), external uptime monitor with a staging fire
   drill (T099, FR-047), Hyperdrive decision and staging load test (T111) or a recorded decision to stay on the pooled URL.
3. `ADMIN_TOKEN` (32 characters or more) set on the Worker so the plan flip endpoint exists (it answers 404 without it).
4. Spec 002 release gate at the top of this file reads PASS.
5. Update "Last checked" and the Status column here in the release PR.
