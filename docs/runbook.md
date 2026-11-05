# TenderPilot operations runbook

## Deploy & rollback

TenderPilot runs on the Cloudflare **Workers Paid** plan (the Free plan's 10 ms CPU cannot parse PDFs or build
packets; `wrangler.toml` sets `[limits] cpu_ms = 120000`) with Neon Postgres and R2 (spec 008 US2, FR-007…FR-012,
ADR-0013).

| | Production | Staging |
|---|---|---|
| Worker | `tenderpilot` (top level of `wrangler.toml`) | `tenderpilot-staging` (`[env.staging]`) |
| URL | `https://app.tenderpilot.in` (Worker custom domain) | `https://staging.tenderpilot.in` (Worker custom domain) |
| `workers.dev` / preview URLs | disabled (`workers_dev = false` → 404; `preview_urls = false`) | disabled |
| Neon branch | `main` (production) | `staging` |
| R2 bucket | `tenderpilot-blobs` | `tenderpilot-blobs-staging` |
| Cron | `*/30 * * * *` | `*/30 * * * *` |
| GitHub environment | `production` (required reviewer; `main` only) | `staging` (no reviewer; `main` only) |
| Email / WhatsApp | real (`RESEND_API_KEY`, `WHATSAPP_*`) | **none** (or sandbox + allow-list), see § Staging must never message customers |

### Normal release

1. A PR merges into `main`. `ci.yml` runs; when `ci-gate` is green its `deploy` job calls
   `.github/workflows/deploy.yml` with the pushed SHA. A red `ci` never deploys.
2. Job `staging`: `pnpm --filter @tp/web build` → `pnpm db:migrate (staging)` (`DATABASE_URL` =
   `secrets.STAGING_DATABASE_URL`) → `wrangler deploy --env staging` (`--var APP_VERSION:<sha7>`) → `smoke (staging)`
   (`scripts/smoke.sh https://staging.tenderpilot.in <sha7>`).
3. Job `production` waits for approval: open the run → **Review deployments** → tick `production` → **Approve and
   deploy**. Check the staging smoke transcript in the run summary first.
4. Job `production`: `pnpm --filter @tp/web build` → `pnpm db:migrate (production)` (`secrets.PROD_DATABASE_URL`) →
   `wrangler deploy` (`--var APP_VERSION:<sha7>`) → `smoke (production)`.

Any failed step stops every later step and the production job. Concurrency is one group per environment,
`deploy-staging` and `deploy-production`, both `cancel-in-progress: false`: at most one deploy per environment runs at
a time and none is cancelled mid-flight. A production job waiting for approval does not block the next staging
deploy. Within a group GitHub keeps only the newest pending job, so when a newer run reaches production, the older
run's un-approved production job is cancelled (the newer commit contains it). Rejecting the approval ends the run;
the next merge starts a new one.

**Why not `workflow_run`**: it only fires for workflow files on the repository's default branch, which is currently
`claude/gem-tender-automation-om9hyj`, not `main`. `ci.yml` therefore calls `deploy.yml` as a reusable workflow
(`workflow_call`, `secrets: inherit`), from its `deploy` job, which runs only after `ci-gate` succeeded on a push to
`main`.

**Migrations** are generated only by `drizzle-kit generate` and applied only by `pnpm db:migrate` (FR-011); the
Worker never runs DDL. They are additive-only (ci `migrations-additive`), so the previous Worker keeps working in the
minute between migrate and deploy, and after a rollback.

### Verify a release

```sh
scripts/smoke.sh https://app.tenderpilot.in <sha7>          # health+version, SPA shell, JSON 404, FR-013 headers
curl -sI https://app.tenderpilot.in/ | grep -iE 'strict-transport|content-security|nosniff|referrer|permissions'
curl -sI https://app.tenderpilot.in/api/health | grep -iE 'strict-transport|nosniff|referrer|permissions'
curl -s -o /dev/null -w '%{http_code}\n' https://tenderpilot.<account-subdomain>.workers.dev/   # expect 404 (disabled)
```

`smoke.sh` also runs against the local Node stack (`scripts/smoke.sh http://localhost:8787 0.1.0`); over plain http it
skips the HSTS check, because HSTS is only sent over https.

### Manual redeploy of a commit

```sh
gh workflow run deploy.yml --ref main -f sha=$(git rev-parse <commit>)   # the FULL 40-character SHA
```

`deploy.yml` rejects anything other than a full 40-character SHA, and fails in "Resolve version" unless the commit is
already on `origin/main` (`git merge-base --is-ancestor HEAD origin/main`), so an unreviewed branch commit can never be
deployed. Without `-f sha` it deploys the head of the dispatched ref (which must also be on `main`).

GitHub only lists and dispatches workflows that also exist on the default branch; until `deploy.yml` is on the
default branch, re-run the last `ci` run on `main` instead (Actions → run → **Re-run all jobs**).

### Rollback

Code rolls back; **migrations never roll back** — fix forward with a new additive migration in a PR.

```sh
pnpm exec wrangler deployments list                       # production; add --env staging for staging
pnpm exec wrangler versions view <version-id>             # check its bindings, vars and APP_VERSION first
pnpm exec wrangler rollback <version-id> --message "rollback: <incident link>"   # omit the id = previous version
curl -s https://app.tenderpilot.in/api/health             # "version" shows the rolled-back sha7
```

**Warning: a rollback restores the version's stored configuration, not just its code.** Each Worker version keeps the
bindings and vars (and the secrets) as they were when it was created. Rolling back past a config change (a `DATABASE_URL`
swap after a restore, a rotated key, a changed R2 bucket or var) can bring back the old value. Run
`wrangler versions view <version-id>` before rolling back, compare it with the current version, and re-run
`wrangler secret put` for anything rotated since then. A rollback also fails if a binding that version references
(e.g. an R2 bucket) no longer exists.

A rollback is temporary: the next merge to `main` deploys again. Merge a revert (or fix) PR before approving the next
production deploy.

### Break-glass manual deploy

Only when GitHub Actions is down and production is broken. Migrate first, then deploy, then smoke, by hand:

```sh
DATABASE_URL='<prod migrate URL>' pnpm db:migrate
ALLOW_MANUAL_DEPLOY=1 pnpm deploy:manual --var APP_VERSION:$(git rev-parse --short=7 HEAD)
scripts/smoke.sh https://app.tenderpilot.in "$(git rev-parse --short=7 HEAD)"
```

`pnpm deploy:manual` refuses to run without `ALLOW_MANUAL_DEPLOY=1`. Record every manual deploy in the incident log.

## Staging must never message customers

The staging Worker runs the same cron (ingestion → alerts → reminders) as production. If its database holds real
users and it has real provider keys, it emails and WhatsApps real customers. Two rules, both required:

1. **No real messaging keys on staging.** Do not set `RESEND_API_KEY`, `WHATSAPP_TOKEN` or `WHATSAPP_PHONE_ID` with
   `--env staging`. Without them the dispatcher marks email/WhatsApp notifications `skipped` ("Email is not
   configured", "Channel not configured") and nothing leaves Cloudflare. If you must test delivery, use a Resend key
   restricted to a test domain and a WhatsApp test number whose recipient allow-list holds only team numbers.
2. **Anonymise the Neon `staging` branch right after creating or resetting it from `main`** (before the staging
   Worker or cron touches it), or seed it fresh (`DATABASE_URL=<staging direct URL> pnpm db:migrate && pnpm db:seed`)
   instead of branching. Run against the staging branch's **direct** URL and double-check the host is the staging
   branch, never production:

   ```sql
   begin;
   -- people: no real addresses, phone numbers, names or working passwords
   update users set email = 'user+' || id || '@staging.invalid', phone = null,
                    name = 'Staging user ' || left(id::text, 8), password_hash = 'disabled';
   update invitations set email = 'invite+' || id || '@staging.invalid';
   update company_profiles set contact_email = null, contact_phone = null, contact_name = null;
   -- nothing queued or replayable
   update notifications set status = 'skipped', error = 'staging: anonymised' where status = 'pending';
   delete from sessions; delete from api_tokens; delete from password_resets;
   commit;
   select count(*) filter (where email not like '%@staging.invalid') as real_emails,
          count(phone) as phones from users;                          -- both must be 0
   ```

   Team members then sign up fresh on staging. Re-run the script after every branch reset; the restore drill on
   staging (§ Restore drill) restores already-anonymised staging data, so it needs no extra step.

## Secrets

Secrets live only in Cloudflare Worker secrets (`wrangler secret put`) and GitHub encrypted secrets (FR-015). Never in
the repository, `wrangler.toml` `[vars]`, logs, error reports or QA evidence. Local values go in git-ignored `.env` /
`.dev.vars`. Owner = "ops lead" (the founder until an on-call rota exists), with one named backup who also holds
Cloudflare, Neon and GitHub admin.

| Secret | Where it lives | Used by | Rotation | Blast radius if leaked |
|---|---|---|---|---|
| `DATABASE_URL` | Worker secret, production and `--env staging`; **Neon pooled (`-pooler`) host** | Worker (API + cron) | Neon → Roles → reset the app role's password (or add a new role) → copy the **pooled** string → `printf '%s' "$URL" \| pnpm exec wrangler secret put DATABASE_URL [--env staging]` (deploys a new version at once) → `scripts/smoke.sh` → update `PROD_/STAGING_DATABASE_URL` if they use the same role | Read/write of every tenant's data |
| `STAGING_DATABASE_URL` | GitHub **environment** secret on `staging` | `deploy.yml` → `pnpm db:migrate (staging)` | Same as `DATABASE_URL` on the Neon `staging` branch → `gh secret set STAGING_DATABASE_URL --env staging` | Staging data; DDL on staging |
| `PROD_DATABASE_URL` | GitHub secret on the **`production` environment only** (readable only by an approved job) | `deploy.yml` → `pnpm db:migrate (production)` | Neon → reset role password → `gh secret set PROD_DATABASE_URL --env production` | Read/write + DDL on production |
| `ANTHROPIC_API_KEY` | Worker secret (prod, staging: separate keys) | LLM analysis/assist | Anthropic Console → create key → `wrangler secret put ANTHROPIC_API_KEY` → smoke an analysis → revoke the old key | LLM spend on our account (set a monthly spend limit) |
| `RESEND_API_KEY` | Worker secret | Alert, invite, reset emails | Resend → API keys → create (sending-only, domain `tenderpilot.in`) → `wrangler secret put` → revoke old | Mail sent as `tenderpilot.in` (phishing, domain reputation) |
| `WHATSAPP_TOKEN` | Worker secret | WhatsApp alerts | Meta Business → System user → generate token (`whatsapp_business_messaging`) → `wrangler secret put` → revoke old | Messages from our business number; Meta account suspension |
| `WHATSAPP_PHONE_ID` | Worker secret | WhatsApp alerts | Changes only with the phone number; `wrangler secret put` | Low (identifier, useless without the token) |
| `SENTRY_DSN` | Worker secret | Error reporter (optional) | Sentry → Client keys → new key → `wrangler secret put` → disable old | Low (event spam / quota) |
| `ADMIN_TOKEN` | Worker secret | `POST /api/admin/orgs/:id/plan` | `openssl rand -hex 32 \| pnpm exec wrangler secret put ADMIN_TOKEN [--env staging]`; store in the password manager | Change any org's plan / trial |
| `CLOUDFLARE_API_TOKEN` | GitHub **environment** secret on `staging` and on `production` (not a repo secret) | `deploy.yml` (`wrangler deploy`) | Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers" template scoped to this account + zone `tenderpilot.in` → `gh secret set CLOUDFLARE_API_TOKEN --env staging` and `--env production` → re-run a deploy → roll/delete old token | Deploy arbitrary code to production (and read every Worker secret through it) |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub **environment** secret on `staging` and on `production` | `deploy.yml` | Not secret; changes only on account move (`gh secret set CLOUDFLARE_ACCOUNT_ID --env staging` / `--env production`) | None alone |
| `NEON_API_KEY` | GitHub secret + password manager (no workflow uses it yet; reserved for restore-drill / preview-branch automation) | Operator scripts: retention, restore branches | Neon → Account → API keys → create → `gh secret set NEON_API_KEY` → revoke old | Full control of the Neon project, incl. deleting branches and data |

There is no session-signing secret: session and API tokens are random and stored hashed (`SESSION_SECRET` was removed
from `specs/001-gem-tender-copilot/plan.md`).

### Verify `DATABASE_URL` uses the pooled host (FR-010)

Worker secrets cannot be read back, so verify the value before you put it and the effect after:

```sh
printf '%s' "$URL" | grep -q -- '-pooler\.' && echo pooled || echo 'NOT POOLED - do not use'
printf '%s' "$URL" | pnpm exec wrangler secret put DATABASE_URL            # add --env staging for staging
pnpm exec wrangler secret list                                             # DATABASE_URL present
```

Then in Neon → Monitoring, "Pooler client connections" rises while you load the app (or run
`scripts/load/feed.sh` on staging) and direct connections stay flat. The pooled host stays until Hyperdrive ships
(FR-075). The migrate secrets (`STAGING_/PROD_DATABASE_URL`) may use the direct host; Neon recommends it for DDL.

### GitHub secret scanning and push protection

```sh
gh api -X PATCH repos/Shashank2577/GEMs \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
gh api repos/Shashank2577/GEMs --jq '.security_and_analysis'   # both "enabled"
```

Or Settings → Code security → Secret Protection → enable **Secret scanning** and **Push protection**. Private repos
need GitHub Secret Protection (Advanced Security). Triage alerts under Security → Secret scanning: rotate first, then
close the alert as "revoked".

## Restore drill

Neon history retention (the point-in-time restore window) MUST be **≥ 7 days** for production (FR-014, NFR-006).

- Console: Neon → project → Settings → **Instant restore / History retention** → 7 days (or more) → Save. Needs a paid
  Neon plan; the Free plan's window is shorter.
- API: `curl -sX PATCH -H "Authorization: Bearer $NEON_API_KEY" -H 'content-type: application/json'
  https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID -d '{"project":{"history_retention_seconds":604800}}'`;
  check with `curl -s -H "Authorization: Bearer $NEON_API_KEY" https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID
  | jq .project.history_retention_seconds` (≥ 604800).

### Restore procedure (create branch at a timestamp → verify counts → swap `DATABASE_URL` → redeploy)

Start a timer. Do it on staging first unless production is down.

1. Pick the timestamp `T` (UTC) just before the incident (bad migration, bad bulk write, deletion).
2. Create a branch from the affected branch at `T`: Neon → Branches → **New branch** → parent `main` (or `staging`) →
   "Past data" at `T` → name `restore-<yyyymmdd-hhmm>` with a read-write compute. API:
   ```sh
   curl -sX POST -H "Authorization: Bearer $NEON_API_KEY" -H 'content-type: application/json' \
     https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches \
     -d '{"branch":{"name":"restore-20261105-0300","parent_id":"<br-id>","parent_timestamp":"2026-11-05T03:00:00Z"},"endpoints":[{"type":"read_write"}]}'
   ```
3. Verify against the current branch (use the restore branch's **direct** URL for checks):
   ```sh
   q="select (select count(*) from tenders) tenders, (select count(*) from organizations) organizations,
             (select max(updated_at) from tenders) last_tender_update"
   psql "$CURRENT_URL" -c "$q"; psql "$RESTORE_URL" -c "$q"
   ```
   `last_tender_update` must be ≤ `T`; counts must match what you expect at `T` (the incident's rows absent, the rest
   present). Spot-check the affected org's rows.
4. Swap: copy the restore branch's **pooled** URL and
   `printf '%s' "$RESTORE_POOLED_URL" | pnpm exec wrangler secret put DATABASE_URL [--env staging]` (takes effect
   immediately as a new version), then point the migrate secret at it too
   (`gh secret set PROD_DATABASE_URL --env production` / `gh secret set STAGING_DATABASE_URL --env staging`).
5. Redeploy and smoke: `gh workflow run deploy.yml --ref main` (or, if the code is unchanged,
   `scripts/smoke.sh <url> <current sha7>`). Stop the timer when smoke is green.
6. Keep the old branch for ≥ 7 days for forensics, then delete it. Optionally set the restore branch as the project's
   default branch in Neon. Record the drill below.

### Drill log

A dated drill on staging is required before the first paid invoice (FR-014, US2 scenario 7).

| Date (IST) | Operator | Environment | Timestamp restored (UTC) | `tenders` current / restored | `organizations` current / restored | `DATABASE_URL` swap rehearsed | Minutes to restore | Notes |
|---|---|---|---|---|---|---|---|---|
| _pending operator_ | _pending operator_ | staging | | | | | | First drill, T041 (#396) |

## Release setup checklist (operator, T041)

One-time setup that needs Cloudflare, Neon and GitHub admin access (spec 008 T041, #396). Tick here and add a dated
note when done.

**Cloudflare**
- [ ] Account is on **Workers Paid**.
- [ ] Zone `tenderpilot.in` is active on this account (custom domains are created by `wrangler deploy` from
      `routes = [{ pattern = "...", custom_domain = true }]`).
- [ ] R2 buckets exist: `pnpm exec wrangler r2 bucket create tenderpilot-blobs` and `... tenderpilot-blobs-staging`.
- [ ] API token "Edit Cloudflare Workers" scoped to the account and zone `tenderpilot.in` created.
- [ ] Worker secrets for production: `DATABASE_URL` (pooled), `ANTHROPIC_API_KEY`, `RESEND_API_KEY`,
      `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `SENTRY_DSN`, `ADMIN_TOKEN` (optional ones may be omitted).
- [ ] Worker secrets for `--env staging`: `DATABASE_URL` (pooled), `ANTHROPIC_API_KEY`, `SENTRY_DSN`, `ADMIN_TOKEN`
      only. **No `RESEND_API_KEY` / `WHATSAPP_*`** (or sandbox values with an allow-list), see § Staging must never
      message customers. Verify with `pnpm exec wrangler secret list [--env staging]`.

**Neon**
- [ ] Branch `staging` created from `main` (Neon → Branches → New branch) **and anonymised immediately**, before the
      staging Worker or cron touches it (§ Staging must never message customers); or seeded fresh instead.
- [ ] Production and staging `DATABASE_URL` Worker secrets use the **`-pooler`** host (procedure in § Secrets).
- [ ] History retention ≥ 7 days (§ Restore drill); screenshot of the setting saved for QA (T042).
- [ ] API key created and stored as `NEON_API_KEY`.

**GitHub** (Settings)
- [ ] Repository secret: `NEON_API_KEY` only. Cloudflare and database secrets are **environment** secrets (below), so
      no job outside a `main`-only environment can read them; delete any repo-level copies.
- [ ] Environment `staging`: no reviewers; Deployment branches = **`main` only**; environment secrets
      `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STAGING_DATABASE_URL`; optional variable `STAGING_URL` if not
      `https://staging.tenderpilot.in`.
- [ ] Environment `production`: **Required reviewers** = ops lead + backup; Deployment branches = **`main` only**;
      environment secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `PROD_DATABASE_URL`; optional variable
      `PRODUCTION_URL` if not `https://app.tenderpilot.in`.
- [ ] Secret scanning + push protection enabled (§ Secrets).

**First release and drill**
- [ ] Merge a PR with an additive migration; the `deploy` run shows `pnpm db:migrate (staging)` →
      `wrangler deploy --env staging` → `smoke (staging)` → approval → `pnpm db:migrate (production)` →
      `wrangler deploy` → `smoke (production)`. Save the run URL and the smoke transcripts for QA (T042).
- [ ] `curl -sI https://app.tenderpilot.in/` shows HSTS + CSP; `https://tenderpilot.<account-subdomain>.workers.dev`
      returns 404.
- [ ] First restore drill on staging performed and recorded in § Drill log.

## Monitors

_To be written by T098 (#448): uptime monitor targets, thresholds and who gets paged._

## First 10 minutes

_To be written by T098 (#448): per health reason (`db_unreachable`, `ingestion_stale`, `alerts_backlog`), 5xx spike,
GeM blocking / 429s. Until then: check `/api/health`, Workers Logs (Cloudflare → Workers → `tenderpilot` → Logs),
the last `deploy` run, and roll back (§ Deploy & rollback) if the incident started with a release._

## Offboarding

_To be written by T109 (#466): org deletion cascade and R2 prefix purge (`org/<orgId>/`)._

## LATER triggers

Deferred decisions and the ADRs that hold their triggers (FR-076; measurable triggers per item are added by
T112, #469):

- Cloudflare Queues for analysis / packets — [ADR-0007](adr/0007-synchronous-analysis-and-packet-with-caps.md)
- Postgres RLS as defence in depth — [ADR-0004](adr/0004-tenant-isolation-application-level.md)
- Razorpay billing — [ADR-0010](adr/0010-plan-limits-and-billing-readiness.md)
- Analytics Engine — [ADR-0011](adr/0011-observability.md)
- Weekly `pg_dump` to R2, Neon preview branches per PR — [ADR-0013](adr/0013-deployment-migrations-backups-secrets.md)
- Hyperdrive (replaces the `-pooler` URL) — [ADR-0002](adr/0002-neon-connection-handling.md)
