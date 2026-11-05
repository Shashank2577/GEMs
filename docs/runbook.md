# TenderPilot operations runbook

## CI

Every PR into `main` and every push to `main` runs `.github/workflows/ci.yml`; story PRs also run
`.github/workflows/dod.yml` (spec 008 US1, FR-001..FR-006).

| Check (job name) | Workflow | What it proves | Timeout |
|---|---|---|---|
| `typecheck` | ci | `pnpm typecheck` + `pnpm typecheck:scripts` (scripts/, e2e/); `pnpm audit --prod --audit-level high` (advisory, see below) | 10 min |
| `unit` | ci | `pnpm -r --filter '!@tp/api' run test` (core, web, extension) + `pnpm test:scripts` | 10 min |
| `api` | ci | `pnpm --filter @tp/api test` against a `postgres:16` service on `:5433` (`TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test`); runs after `unit` | 15 min |
| `e2e` | ci | `CI=1 pnpm e2e` (real API + SPA + mock-gem, `E2E_DATABASE_URL=…/tenderpilot_e2e`), job summary from `scripts/e2e-summary.ts`, artifact `e2e-evidence-<run_id>` with `qa/evidence/**` + `qa/.runs/**` (30 days, uploaded even on failure); runs after `api` | 30 min |
| `migrations-additive` | ci | `scripts/check-migrations.ts` over migrations added/changed vs the PR base, then `pnpm --filter @tp/db generate` must leave no diff (schema drift) | 10 min |
| `ci-gate` | ci | Aggregator (`if: always()`, needs every job above plus `changes`): fails if any of them failed or was cancelled, or if the `changes` path filter itself did not succeed | 5 min |
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
- **Deploy gating (US2)**: `workflow_run` triggers only fire for workflow files on the repository's **default branch**.
  The default branch is currently not `main`, so a deploy workflow must not rely on `workflow_run: workflows: [ci]`
  unless the default branch is switched to `main`; otherwise run the deploy as a job in `ci.yml` with
  `needs: ci-gate` (on push to `main`) or have it verify the commit's `ci-gate` check before deploying.
- **Run locally**: `pnpm typecheck && pnpm typecheck:scripts`, `pnpm -r --filter '!@tp/api' run test`, `pnpm test:scripts`,
  `TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test pnpm --filter @tp/api test`, `pnpm e2e`,
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
