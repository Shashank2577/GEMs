# TenderPilot

Find, assess and bid on Indian government (GeM) tenders. One Cloudflare Worker serves the API (`/api/*`) and the web app
(static assets), runs the cron pipeline and stores files in R2; data lives in Neon Postgres.

- `apps/api`: Hono API (Worker entry `src/worker.ts`, Node entry `src/node.ts` for local runs and CI)
- `apps/web`: React single-page app (Vite)
- `packages/core` (shared logic and zod contracts), `packages/db` (Drizzle schema, migrations, seed), `tools/mock-gem` (local GeM)
- `specs/`: one folder per feature (001 product, 002 platform, 003 identify, 004 analyse, 005 profile and vault, 006 apply, 007 experience, 008 operations and scale)
- `docs/`: architecture, ADRs, the operations [runbook](docs/runbook.md) and the delivery [team playbook](docs/delivery/TEAM_PLAYBOOK.md)
- `qa/evidence/`: QA verdicts, screenshots and videos per story; `e2e/`: Playwright specs

## Develop locally

```sh
pnpm install
scripts/local-pg.sh                       # Postgres 16 on :5433
pnpm --filter @tp/mock-gem start          # mock GeM BidPlus on :4010
cp .dev.vars.example .env && export $(grep -v '^#' .env | xargs)
pnpm --filter @tp/web build && pnpm --filter @tp/api start   # http://localhost:8787
DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot pnpm db:seed   # demo@tenderpilot.in / Demo@12345
```

Checks (run all of them before opening a PR):

```sh
pnpm -r typecheck
pnpm --filter @tp/core exec vitest run
TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test pnpm --filter @tp/api exec vitest run
pnpm --filter @tp/web exec vitest run
pnpm e2e                                  # Playwright; writes evidence under qa/evidence/
```

## Operations

Everything an operator needs is in the [runbook](docs/runbook.md); this section is the map. The requirements are in
[spec 008](specs/008-operations-scale/spec.md).

- **CI.** `.github/workflows/ci.yml` runs on every pull request and on pushes to `main`: typecheck, unit, API tests
  against a `postgres:16` service, the Playwright E2E suite (evidence uploaded as an artifact), the additive-migrations
  check and the Definition-of-Done check. `main` is protected: those checks must pass and force-pushes are blocked
  (spec 008 FR-001 to FR-006, delivered by story US1).
- **Deploy.** Releases are made only by the GitHub Actions deploy workflow, never from a laptop: build the web app,
  `pnpm db:migrate`, `wrangler deploy`, then a smoke test (`scripts/smoke.sh`), first on staging and, after approval, on
  production (spec 008 FR-007 and FR-008, story US2). There is no `pnpm deploy` any more; the break-glass procedure and
  rollback (`wrangler rollback`, never roll migrations back) are in the runbook under "Deploy & rollback".
- **Environments.** `development` is your machine (`.dev.vars.example`, mock GeM). `staging` is a separate Worker (`tenderpilot-staging`), R2 bucket
  and database (`STAGING_DATABASE_URL`) that must never message customers. `production` is the top-level `wrangler.toml` config on the custom
  domain. `APP_URL` must be exactly the origin users load (writes from another origin get 403 `bad_origin`).
- **Secrets.** Only through `wrangler secret put` (Worker) and GitHub encrypted secrets (CI). Worker: `DATABASE_URL`
  (Neon pooled host), `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `SENTRY_DSN`,
  `UNSUBSCRIBE_SECRET`, `ADMIN_TOKEN`; all but `DATABASE_URL` are optional and degrade to no-ops. Owners and rotation: runbook
  "Secrets".
- **Monitoring.** `GET /api/health` returns 503 with `reasons` (`db_unreachable`, `ingestion_stale`, `alerts_backlog`)
  for the external uptime monitor; the runbook's "Monitors" and "First 10 minutes" say what to do for each.
- **Plans.** Trial, Starter and Pro limits are enforced by the API; an operator flips a plan with
  `POST /api/admin/orgs/:id/plan` (bearer `ADMIN_TOKEN`). Before the first paid plan flip, every P1 item in the runbook's
  "Spec 008 launch checklist" must be met.
- **Data.** Migrations are generated with `pnpm --filter @tp/db generate`, applied only by `pnpm db:migrate`, and must be
  additive; the Worker never runs DDL. Retention, offboarding and the restore drill are in the runbook.

## Working agreements

Tickets, commit trailers, review and QA follow [CONVENTIONS.md](CONVENTIONS.md) and the
[team playbook](docs/delivery/TEAM_PLAYBOOK.md).
