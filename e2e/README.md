# E2E & QA evidence

`pnpm e2e` (or `pnpm exec playwright test e2e/<spec>/<story>.e2e.ts`) starts mock-gem (:4011) and the API + built SPA (:8788)
against `tenderpilot_e2e` on local Postgres. Specs live in `e2e/<spec>/US<n>-*.e2e.ts`, tag mobile checks with `@mobile`.

Evidence per story goes to `qa/evidence/<spec>/<story>/`: named screenshots (`evidence()`), the video (`collectRunArtifacts()`),
and the QA verdict `VERDICT.md` (template `.aisdlc/qa/verdict-comment.md`). Raw run output (HTML report, traces) is in `qa/.runs/` (git-ignored).

## Database: local vs CI

- **Local (default)**: `e2e/support/start-api.sh` starts Postgres via `scripts/local-pg.sh` and recreates `tenderpilot_e2e`
  (`E2E_DB_NAME` overrides the name) on `:5433`.
- **CI / any external Postgres**: set `E2E_DATABASE_URL`, e.g.
  `E2E_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_e2e pnpm e2e`. `scripts/local-pg.sh` is not called; the
  database named in the URL is dropped and recreated with `psql` through the same server's `postgres` maintenance
  database (override with `E2E_ADMIN_DATABASE_URL`). As a safety net the name (also `E2E_DB_NAME` locally) must
  have an `e2e`/`test` segment (`(^|_)(e2e|test)(_|$)`, e.g. `tenderpilot_e2e`) and the host must be `localhost` or
  `127.0.0.1` (`E2E_ALLOW_ANY_DB=1` overrides both). `psql` must be on `PATH` (it is on GitHub's `ubuntu-latest`).
- The `e2e` job in `.github/workflows/ci.yml` runs `CI=1 pnpm e2e` this way against a `postgres:16` service, writes a
  pass/fail/flaky summary with `scripts/e2e-summary.ts`, and uploads `qa/evidence/**` + `qa/.runs/**` as artifact
  `e2e-evidence-<run_id>` (30 days).

## Spec 008 helpers

`e2e/support/fixtures.ts` also exports `evidence008(page, story, name)`, `saveTranscript(story, name, textOrJson)`
(`.txt` for strings, `.json` otherwise, into `qa/evidence/008/<story>/`), `atPhone(page)` (375×812) and
`noHorizontalOverflow(page)`. Spec 008 E2E files live in `e2e/008-operations-scale/US<n>-*.e2e.ts`.
