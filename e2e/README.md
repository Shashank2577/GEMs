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
| `inviteAs(request, role)` | 007. Invites a new member (`bid_manager`, `analyst` or `viewer`) into the org of an Owner/Bid Manager session and accepts the invite. Returns `{user, role, api, storageState, newContext(browser), newPage(browser)}` for role-gated checks |
| `a11y(page, name, opts?)` (also `a11y(page, spec, story, name)`) | axe WCAG 2.1 A/AA audit. Saves `<name>-<project>.axe.json` next to the evidence (spec and story default to the test file path, e.g. `e2e/007-…/US1-…` gives `007`/`US1`) and fails on any serious or critical violation. `checkA11y` is the same check without an evidence file |
| `noHorizontalOverflow(page)` | Asserts `scrollWidth <= innerWidth` (SC-004) and returns the metrics |
| `atPhone(page)` | Resizes the page to 375 × 812 for mobile checks |
| `seedDemoAndGetWorkspaces(request)` | Seeds the demo dataset and returns the seed response plus the org's workspace cards (`GET /api/workspaces`) |
| `collectRunArtifacts(spec, story, page)` | Copies the recorded video next to the evidence |
| `putProfile`, `addPastContract`, `uploadVaultDoc`, `makePdf`, `makePng` | 005 profile and vault fixtures |

Layout for 007: `e2e/007-experience-growth/US<n>-*.e2e.ts`, evidence in `qa/evidence/007/US<n>/` with the roll-up in
`qa/evidence/007/README.md`.
