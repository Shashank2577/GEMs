## QA verdict — APPROVED

**Work item:** cross-cutting HARDEN tasks T005 (#302), T079 (#352), T080 (#353), T081 (#354), epic #291 (no story issue) · **PR:** #548 · **Reviewer:** qa (claude-code/Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mHKg4iL9ojV8hxLAhc

Head tested: `bd664972a82090166e0c3f877db738c420faeb6f`. Evidence: `qa/evidence/007/harden/`.

### Acceptance criteria

| # | Criterion (HARDEN tasks, specs/007-experience-growth/tasks.md) | Verdict | Evidence |
|---|---|---|---|
| T005 | Document `myWork`, `awaitingDecision`, `DELETE /demo`, onboarding key whitelist, `bid_workspaces_org_stage_idx` in 001 contracts/api.md and data-model.md | met | Real API+SPA on :8788 with mock-gem :4011, demo seeded, responses compared to the docs: [api-exercise.txt](harden/api-exercise.txt), [isdemo-detail.txt](harden/isdemo-detail.txt). `GET /dashboard` keys equal the documented list (`generatedAt, tiles, stats, closingSoon, pipeline, pipelineValue, verdicts, matchesByDay, recentMatches, expiringDocuments, activity, setup[{key,label,description,done,href}], setupComplete, demo, myWork, awaitingDecision`). `myWork` item = `{workspaceId,tenderId,bidNumber,title,stage,dueAt,endAt,readiness:{percent,blockers,analysed}}`; `awaitingDecision` is flat `{workspaceId,tenderId,bidNumber,title,score,verdict,endAt}` (no nested `analysis`); both `[]` before demo. `POST /demo/seed` 201 `created:true`, repeat 200 `created:false`, with documented counters; `onboardingState.demo=true` afterwards. `PATCH /org` unknown key 400 `details.fields.onboardingState="Unknown onboarding key: bogus"`; non-boolean 400; valid keys merged (company, categories, then watchlist all kept alongside `demo`). `DELETE /demo` 200 `{ok,removed:{…,profileReset:true}}` (`profileReset` inside `removed`), repeat all zeros/`false`, dashboard `demo:false`, lists empty after; unauthenticated 401. `isDemo:true` on list items and tender detail; org without demo sees 0 tenders. Index: `bid_workspaces_org_stage_idx` present in schema (docs-only claim, not load-tested) |
| T079 | `e2e/README.md` documents `evidence007`, `inviteAs`, `a11y`, `noHorizontalOverflow`; 001 T081 US6/US7 marked delivered by 007 | met | Every helper named in the README table exists in `e2e/support/fixtures.ts` with the documented shape: `evidence007(page, story, name)`; `inviteAs(request, role: bid_manager\|analyst\|viewer)` returning `{user, role, api, storageState, newContext, newPage}`; `a11y` overloads `(page, name, opts?)` and `(page, spec, story, name)`, writing `<name>-<project>.axe.json` for the first form; `noHorizontalOverflow(page)` returns `{scrollWidth, innerWidth}`; `atPhone` 375x812; `seedDemoAndGetWorkspaces`; `collectRunArtifacts`; `putProfile`, `addPastContract`, `uploadVaultDoc`, `makePdf`, `makePng` (re-exports). The auto-dispose fixture on `test` exists. `specs/001-gem-tender-copilot/tasks.md` line 104 under T081 states US6/US7 delivered by 007 |
| T080 | "As delivered" notes in spec.md/plan.md are accurate and do not silently weaken requirements | met | `git diff dca373e..bd66497` on spec.md has no removed requirement text (only the Status line changed, plus additive notes). Notes checked against code and live API: flat `DecisionItem` and `workspaceId` (live dashboard output), `myWork` excludes `submitted` (`apps/api/src/routes/dashboard.ts:33-34`), `superRefine`+`ONBOARDING_KEYS` (`packages/core/src/contracts/experience.ts:57`) with the documented error path (live), `profileReset` inside `removed` (live), `networkMode:'always'` (`apps/web/src/lib/api.ts:218`), canonical host `tenderpilot.in` in `apps/web/index.html` vs `wrangler.toml APP_URL` (assumption flagged). Real gaps are stated as PARTIAL/deviation with issues: FR-067 badge missing on dashboard lists and pipeline cards (#523 item 1), FR-065 `removeDemo` deleting user activity about demo rows (#523 item 2), SC-001 production median open. The PR body lists 14 analyze findings with Constitution I and IV checked |
| T081 | `qa/evidence/007/README.md` links each story's VERDICT.md, video, trace and screenshots, and the SC-001…SC-008 measurements | met | Link script: [readme-links.txt](harden/readme-links.txt) -> 28 relative links checked, 0 missing (2 external issue links not fetched); backticked evidence paths (`US1/SC-002-ground-truth.json`, `US1/SC-008-…mobile.png/json`, `US3/US3-IT-timing.json`, `US4/US4-10-removal.json`, `US6/lighthouse/summary.json`, `US7/us7-9-pipeline-inner-scroll.json`, axe JSONs) all exist. Numbers vs VERDICT.md: passed counts for US1 (20, dashboard 13), US2 (25, 44), US3 (26 = 21+5; core 379/api 443/web 177), US4 (20 = 17+3; api 555), US5 (17 = 13+4; api 562/web 209), US6 (18 = 16+2; 428/606/249), US7 (59 desktop / 25 mobile; api 646/web 279) all match. Per-story video counts match the folders (3, 6, 26, 17, 5, 16, 15). SC-006 matches `summary.json` (93/100/96/100, LCP 905, CLS 0); SC-001 56.6 s (VERDICT) vs 53.87 s (JSON) both disclosed; SC-003 86 axe files, 0 violations of any impact; SC-008 six tiles in view per `SC-008-first-viewport-mobile.json`. Traces correctly stated as not committed. Videos are not one per test, as the README says. Unmeasured items (production median, CI run, NFR-001/002) are disclosed |

### Gate (head bd66497)

| Command | Result | Evidence |
|---|---|---|
| `pnpm -r typecheck` | exit 0 | [typecheck.txt](harden/typecheck.txt) |
| `pnpm --filter @tp/core exec vitest run` | 26 files, **481 passed** | [vitest-core.txt](harden/vitest-core.txt) |
| `TEST_DATABASE_URL=… pnpm --filter @tp/api exec vitest run` | 40 files passed, 2 skipped; **769 passed, 2 skipped** | [vitest-api.txt](harden/vitest-api.txt) |
| `pnpm --filter @tp/web exec vitest run` | 42 files, **295 passed** | [vitest-web.txt](harden/vitest-web.txt) |

### Findings

1. **minor** — contracts/api.md says violations answer `"Unknown onboarding key: <first bad key>"` *or* `"At most 16 onboarding keys"` in `details.fields.onboardingState`. With 17 unknown keys the field shows only the first message; the 16-key message appears only in `details.issues`. Only unknown keys can exceed 16 (7 valid keys exist), so the "at most 16" text is effectively reachable only via `issues`.
   - Observed: PATCH 17 keys -> 400, `fields.onboardingState = "Unknown onboarding key: k0"`, `issues` holds both messages.
   - Where: `specs/001-gem-tender-copilot/contracts/api.md` § `PATCH /org`
2. **observation** — e2e/README.md does not state that the positional `a11y(page, spec, story, name)` form writes `axe-<name>.json` (the other form writes `<name>-<project>.axe.json`). Cosmetic.
3. **observation** — `qa/evidence/007/US*/VERDICT.md` link to story branches that are deleted after merge (pre-existing; not in HARDEN scope). The README's own links are relative and resolve.
4. **observation** — PR body DoD says "web vitest 295 passed", which matches; the QA re-run confirms. The DoD line "cairn re-review / QA" is unticked pending this verdict.

### Not checked

- Role gating (viewer/analyst 403 on `DELETE /demo`) was not re-run live; only the unauthenticated 401 was. The roles-matrix API test passes in the 769.
- Playwright E2E suites were not re-run (docs-only change; not in the HARDEN criteria).
- `bid_workspaces_org_stage_idx` performance (NFR-001) was not benchmarked.
- GitHub issue links in the README were not fetched.

An approval covers what is in the table above. It is not a statement that the change is free of defects.

### Bug issues filed

- none

### Verdict

`qa:approved` equivalent — T005, T079, T080 and T081 are met, evidence above. No labels applied (cross-cutting PR, no story issue).
