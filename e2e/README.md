# E2E & QA evidence

`pnpm e2e` (or `pnpm exec playwright test e2e/<spec>/<story>.e2e.ts`) starts mock-gem (:4011) and the API + built SPA (:8788)
against `tenderpilot_e2e` on local Postgres. Specs live in `e2e/<spec>/US<n>-*.e2e.ts`, tag mobile checks with `@mobile`.

Evidence per story goes to `qa/evidence/<spec>/<story>/`: named screenshots (`evidence()`), the video (`collectRunArtifacts()`),
and the QA verdict `VERDICT.md` (template `.aisdlc/qa/verdict-comment.md`). Raw run output (HTML report, traces) is in `qa/.runs/` (git-ignored).

## Shared helpers (`e2e/support/fixtures.ts`)

Import `test`, `expect` and the helpers from `../support/fixtures`. `test` is extended with an auto-fixture that closes
every context opened by `inviteAs()` after each test, pass or fail.

| Helper | Use |
|---|---|
| `signupViaApi`, `uniqueUser`, `loginViaUi`, `seedDemo`, `mockGem` | Account setup, demo seed (`POST /api/demo/seed`) and mock-gem control (all specs) |
| `evidence(page, spec, story, name)` | Full-page screenshot to `qa/evidence/<spec>/<story>/<name>.png` |
| `evidence007(page, story, name)` | 007 shortcut: `qa/evidence/007/<US1…US7>/<name>.png` (`evidence005` is the 005 equivalent) |
| `resetGem`, `publishOnGem(request, count)`, `gemCorrigendum(request, bidNumber, {days?, endAt?, quantity?, emd?})`, `gemCancel(request, bidNumber)`, `gemFail(request, mode)` | 003. Mock-GeM admin wrappers (`/__admin/*`): restore fixtures + outage off, publish new bids, amend a bid (end date, quantity, EMD), cancel a bid, simulate an outage (`down`/`html`/`off`) |
| `syncNow(request, data?)` | 003. `POST /api/ingestion/run`; waits out a short manual-sync cooldown (429 `sync_cooldown`, `details.retryAt`) and retries, failing fast if the wait exceeds 60 s (default cooldown is 10 min: age earlier runs in SQL); returns the response |
| `resetIngestionData(request)` | 003. `truncate tenders, ingestion_runs, notifications, watchlists cascade` on the e2e database (refuses a name without `e2e`) + `resetGem`. The 003 specs call it from `test.beforeAll` (desktop project only), so every spec file starts clean even on a shared DB |
| `evidence003(page, story, name)` | 003 shortcut: `qa/evidence/003/<US1…US6>/<name>.png` |
| `inviteAs(request, role)` | 007. Invites a new member (`bid_manager`, `analyst` or `viewer`) into the org of an Owner/Bid Manager session and accepts the invite. Returns `{user, role, api, storageState, newContext(browser), newPage(browser)}` for role-gated checks |
| `a11y(page, name, opts?)` (also `a11y(page, spec, story, name)`) | axe WCAG 2.1 A/AA audit. Saves `<name>-<project>.axe.json` next to the evidence (spec and story default to the test file path, e.g. `e2e/007-…/US1-…` gives `007`/`US1`) and fails on any serious or critical violation. `checkA11y` is the same check without an evidence file |
| `noHorizontalOverflow(page)` | Asserts `scrollWidth <= innerWidth` (SC-004) and returns the metrics |
| `atPhone(page)` | Resizes the page to 375 × 812 for mobile checks |
| `seedDemoAndGetWorkspaces(request)` | Seeds the demo dataset and returns the seed response plus the org's workspace cards (`GET /api/workspaces`) |
| `collectRunArtifacts(spec, story, page)` | Copies the recorded video next to the evidence |
| `putProfile`, `addPastContract`, `uploadVaultDoc`, `makePdf`, `makePng` | 005 profile and vault fixtures |

Layout for 007: `e2e/007-experience-growth/US<n>-*.e2e.ts`, evidence in `qa/evidence/007/US<n>/` with the roll-up in
`qa/evidence/007/README.md`.

## Running the 003 specs (Identify, Ingestion & Alerts)

- Per spec on its own fresh private database (recommended; ports must be unique per concurrent run):
  ```sh
  psql postgres://tp:tp@localhost:5433/postgres -c "create database tp_e2e_r1"
  E2E_DATABASE_URL=postgres://tp:tp@localhost:5433/tp_e2e_r1 E2E_PORT=9001 E2E_GEM_PORT=4101 \
    pnpm exec playwright test e2e/003-identify-ingestion-alerts/US1-ingestion   # desktop + mobile projects
  ```
  With `E2E_DATABASE_URL` set, `start-api.sh` drops and recreates the database named in the URL (guarded: local host, `e2e`/`test` name segment; see below).
- Whole directory on one database: `e2e/support/run-spec-dir.sh e2e/003-identify-ingestion-alerts` runs the spec files back to back (each with desktop + mobile).
  Each file's `beforeAll` calls `resetIngestionData` (the 003 specs assert an empty `tenders` table, no earlier manual syncs and a global notification count of 0).
  A single `playwright test e2e/003-identify-ingestion-alerts/` invocation also works for the desktop project, but Playwright runs project by project (all desktop, then all mobile) and the
  `@mobile` scenarios reuse the state their own file's desktop run left behind, which the next file's reset clears (US4 S2 @mobile then fails). Use the runner script.
- Manual-sync cooldown: the default is 10 minutes platform-wide (008/FR-026). Specs never wait it out: they age finished `ingestion_runs` by 10 minutes in SQL before a second sync
  (US1 `ageRuns()`, US3-US5 `syncNow`), and assert the 429 `sync_cooldown` + `details.retryAt` only in the scenario that tests it (US1 S1; HARDEN `syncNow` fail-fast).
- Locators: the app shell renders an always-mounted, usually empty `<div role="status" aria-live="polite" data-testid="offline-banner">`. Never use a bare `getByRole('status')` or `[aria-live="polite"]`;
  scope by id/testid (`#sync-cooldown-hint`) or exclude the banner (`:not([data-testid="offline-banner"])`).
- Rate limits: `watchlist.preview.user` allows 30 previews/min per user; a fast run can exhaust it, so US2 clears the `rate_limits` rows before the scenario that makes many preview calls.

## Database: local vs CI

- **Local (default)**: `e2e/support/start-api.sh` starts Postgres via `scripts/local-pg.sh` and recreates `tenderpilot_e2e`
  (`E2E_DB_NAME` overrides the name) on `:5433`.
- **CI / any external Postgres**: set `E2E_DATABASE_URL`, e.g.
  `E2E_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_e2e pnpm e2e`. `scripts/local-pg.sh` is not called; the
  database named in the URL is dropped and recreated with `psql` through the same server's `postgres` maintenance
  database (override with `E2E_ADMIN_DATABASE_URL`). As a safety net the name (also `E2E_DB_NAME` locally) must
  have an `e2e`/`test` segment (`(^|_)(e2e|test)(_|$)`, e.g. `tenderpilot_e2e`) and the host must be `localhost` or
  `127.0.0.1` (`E2E_ALLOW_ANY_DB=1` overrides both). `psql` must be on `PATH` (it is on GitHub's `ubuntu-latest`).
- CI (`.github/workflows/ci.yml`): `e2e-shard` ×8 runs `scripts/e2e-ci.sh <shard> 8` against a `postgres:16` service —
  every spec file is its own `playwright test <file>` run on a freshly recreated database (specs assume a fresh DB, as
  in `pnpm exec playwright test e2e/<NNN>/US<n>*`). A spec that needs extra **server** environment declares it in its
  header as `@e2e-env KEY=value …` (read by `scripts/e2e-ci.sh`). The `e2e` job merges the shard blob reports, writes
  a pass/fail/flaky summary with `scripts/e2e-summary.ts`, and uploads `qa/evidence/**` + `qa/.runs/**` as artifact
  `e2e-evidence-<run_id>` (30 days).

## Spec 008 helpers

`e2e/support/fixtures.ts` also exports `evidence008(page, story, name)`, `saveTranscript(story, name, textOrJson)`
(`.txt` for strings, `.json` otherwise, into `qa/evidence/008/<story>/`), `atPhone(page)` (375×812) and
`noHorizontalOverflow(page)`. Spec 008 E2E files live in `e2e/008-operations-scale/US<n>-*.e2e.ts`.
