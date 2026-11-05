# ADR-0013: Deployment pipeline, migrations, Neon backups, custom domain and secrets handling

**Status**: Proposed
**Date**: 2026-11-05
**Priority**: MUST (CI deploy with migrations, Neon retention, custom domain) · SHOULD (staging branch, secret scanning, rotation runbook)

## Context

Deploys happen from a developer machine: `pnpm deploy` = `vite build` + `wrangler deploy`; migrations are
`pnpm db:migrate` (`packages/db/src/migrate.ts`, drizzle `migrate()` over `packages/db/migrations`) run by hand with
a `DATABASE_URL`. Nothing guarantees the order "migrate, then deploy", or that tests ran. The Worker never runs
migrations (correct — a Worker should not own DDL). There is a single migration `0000_last_shocker.sql`; future
schema changes (ADR-0004/0006/0008/0009/0010/0012) will add several.

Neon: the project's history retention (PITR window) is whatever the default is; no staging database; no branch
per PR. Secrets: `wrangler secret put`, `.dev.vars`/`.env` git-ignored, no scanning in CI, no rotation procedure.
`specs/001/plan.md` lists a `SESSION_SECRET` that the code does not use (tokens are random and hashed).

## Decision

1. **GitHub Actions deploy pipeline (MUST)** — `.github/workflows/deploy.yml` on push to `main`:
   `pnpm install` → `pnpm typecheck` → `pnpm test` (Postgres service container) → `pnpm --filter @tp/web build`
   → `pnpm db:migrate` with `DATABASE_URL` = production pooled URL (GitHub secret) → `wrangler deploy` with
   `CLOUDFLARE_API_TOKEN`. Migrations are **additive-only** by convention (new columns nullable or defaulted, no
   drops in the same release as code that stops using a column) so the old Worker keeps working during the minute
   between migrate and deploy. `drizzle-kit generate` is the only way to create migrations (`db:push` is forbidden
   by a `package.json` script that does not exist).
   **Exception — non-transactional index migrations (008/FR-027, 2026-11-05):** `CREATE INDEX CONCURRENTLY` cannot
   run in a transaction, and drizzle-kit neither emits `CONCURRENTLY` nor a way to opt out of the transaction. Such
   a migration is still generated with `drizzle-kit generate` (so the snapshot/journal stay drizzle's), then
   hand-edited: first line `-- tp:non-transactional` (`migrate.ts` runs the file statement by statement outside a
   transaction, drops an INVALID leftover of a failed build first and refuses to record an index that is still
   INVALID), `CONCURRENTLY`, `IF [NOT] EXISTS` on every statement. Hand-edited so far: `0016_gem_lease_single_run`
   (seed row, duplicate reap and `IF NOT EXISTS` added to the generated DDL), `0017_capacity_indexes`,
   `0018_open_closing_idx` (drops the index it supersedes) and `0019_open_state_created_idx`. Dropping a superseded
   index (0018) is allowed in the same release: the old Worker's
   queries stay correct, only their plan changes for the minute between migrate and deploy.
2. **Staging (SHOULD)** — a Neon branch `staging` + a second Worker environment (`[env.staging]` in `wrangler.toml`,
   `name = "tenderpilot-staging"`, its own R2 bucket and secrets) deployed from `main` first; production deploy is a
   manual approval step on the same workflow. PR preview branches on Neon are LATER.
3. **Neon retention (MUST)** — set history retention to ≥ 7 days (Launch plan or higher) so any bad migration or
   data incident can be point-in-time restored into a branch; document the restore procedure (create branch at
   timestamp → verify → swap `DATABASE_URL`) in the runbook. Weekly `pg_dump` to R2 (LATER) if a customer requires
   off-provider backups.
4. **Custom domain (MUST)** — Worker custom domain for the app (`APP_URL`), DNS on Cloudflare, HSTS (ADR-0005);
   `workers.dev` route disabled in production.
5. **Secrets (SHOULD)** — runbook section listing each secret, where it lives, who can rotate it and how
   (`DATABASE_URL`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `SENTRY_DSN`,
   `ADMIN_TOKEN`). Enable GitHub secret scanning + push protection on the repo. Remove `SESSION_SECRET` from
   `specs/001-gem-tender-copilot/plan.md`.

## Consequences

- No more "deployed before migrating"; every production change has typecheck + 392 tests behind it.
- Additive-only migrations cost a follow-up PR when a column is removed — a cheap discipline.
- A staging environment doubles Cloudflare/Neon fixed costs slightly (small computes, mostly idle) but makes the
  QA stage in CONVENTIONS.md runnable against a real edge deployment.

## Acceptance

- A PR that adds a migration deploys through the workflow; the workflow log shows `migrations applied` before
  `wrangler deploy`.
- Neon console shows history retention ≥ 7 days for the production branch; the runbook's restore drill has been
  executed once on staging.
- `https://<custom-domain>/api/health` returns 200 and `workers.dev` returns 404/disabled.
