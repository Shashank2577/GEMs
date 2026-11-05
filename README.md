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
cp .dev.vars.example .env && set -a && . ./.env && set +a
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

- **CI (planned, spec 008 US1, PR #475 not merged).** Today no CI workflow runs on pull requests; run the checks above by hand.
  Once #475 lands, `.github/workflows/ci.yml` runs typecheck, unit, API (postgres:16), E2E, migrations-additive and DoD on every PR,
  and `apply-branch-protection.yml` makes them required on `main`.
- **Deploy.** Today: `pnpm deploy` (builds the web app, then `wrangler deploy`); run `pnpm db:migrate` against the target database
  first. For rollback, use `wrangler rollback` and never roll migrations back (runbook § First 10 minutes → 5xx spike). Spec 008 US2
  (PR #492) replaces this with a CI-only deploy workflow (staging → approval → production, with a smoke test) and a guarded
  `deploy:manual`.
- **Environments.** `development` is your machine (`.dev.vars.example`, mock GeM). `production` is the top-level `wrangler.toml`
  config (today on `*.workers.dev`). A staging Worker, bucket and database, and the custom domain, arrive with US2 (#492, T030, T041).
  `APP_URL` must be exactly the origin users load (writes from another origin get 403 `bad_origin`).
- **Secrets.** Only through `wrangler secret put` (Worker) and GitHub encrypted secrets (CI). Worker: `DATABASE_URL`
  (Neon pooled host), `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `SENTRY_DSN`,
  `UNSUBSCRIBE_SECRET`, `ADMIN_TOKEN`; all but `DATABASE_URL` are optional and degrade to no-ops. The list is in
  [plan.md](specs/001-gem-tender-copilot/plan.md) (owners and rotation: runbook "Secrets", added by #492).
- **Monitoring.** `GET /api/health` returns 503 with `reasons` (`db_unreachable`, `ingestion_stale`, `alerts_backlog`)
  for the external uptime monitor (not yet configured: T099, operator); the runbook's "Monitors" and "First 10 minutes" say what to
  do for each.
- **Plans.** Trial, Starter and Pro limits are enforced by the API; an operator flips a plan with
  `POST /api/admin/orgs/:id/plan` (bearer `ADMIN_TOKEN`). Before the first paid plan flip, every P1 item in the runbook's
  "Spec 008 launch checklist" must be met.
- **Data.** Migrations are generated with `pnpm --filter @tp/db generate`, applied only by `pnpm db:migrate`, and must be
  additive (policy until #475's `check-migrations` enforces it); the Worker never runs DDL, and the local Node server applies
  migrations itself when `AUTO_MIGRATE=1`. Retention and offboarding are in the runbook; the restore drill arrives with #492.

## Working agreements

Tickets, commit trailers, review and QA follow [CONVENTIONS.md](CONVENTIONS.md) and the
[team playbook](docs/delivery/TEAM_PLAYBOOK.md).
