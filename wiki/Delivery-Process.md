# Delivery Process

## 1. Specs — cairn spec workflow
Every area has a numbered spec folder under `specs/` written with the cairn workflow
(`/cairn-constitution`, `/cairn-specify`, `/cairn-clarify`, `/cairn-plan`, `/cairn-tasks`, `/cairn-analyze`):
`spec.md` (user stories, Given/When/Then acceptance, FR/NFR/SC), `plan.md` (design, API, data, ports from reference repos),
`tasks.md` (T-numbered tasks traced to stories and requirements). The constitution is
`.cairn/workflow/memory/constitution.md`.

## 2. Tickets — GitHub issues
`/cairn-taskstoissues` files every user story and open task as an issue:

```
#1 [Epic] TenderPilot (umbrella)
 └─ [Epic] 00N — <area>            type:epic, spec:00N, area:<slug>
     ├─ [00N/USn] <story>           type:story, priority:Pn, role:qa
     └─ [00N/Tnnn] <task>           type:task, role:developer, status:ready
```

Labels (from ai-sdlc): `status:ready → status:in-progress → status:in-review`, `qa:approved | qa:rejected`,
`needs-human`, `status:blocked`. The Projects board columns are derived from these labels, so the board can be rebuilt at any time.

## 3. Development — story branches & PRs
One branch per story ticket: `story/GEM-<issue>-<slug>` (bugs: `bug/GEM-<issue>-<slug>`), PR into `main`
with `Closes #<story>` and `Closes #<task>` for each task in it, and the Definition-of-Done checklist.
Commit trailers (see `CONVENTIONS.md`):

```
Work-Item: Shashank2577/GEMs#<issue>
Requirement: <spec>/FR-0XX
Agent-Role: developer
Harness: claude-code
```

## 4. Review — cairn-reviewer
The `cairn-reviewer` agent reviews each PR diff against the spec, history and conventions and posts a prioritised list
with a merge verdict. Blocking findings go back to the developer.

## 5. QA — ai-sdlc verdict with evidence
QA reads the acceptance criteria first, then runs Playwright E2E (`e2e/<spec>/US<n>-*.e2e.ts`) against real Postgres,
the real API and mock GeM, on desktop and mobile. Evidence — screenshots, video, trace — is committed to
`qa/evidence/<spec>/<story>/` with `VERDICT.md` (template `.aisdlc/qa/verdict-comment.md`). Every criterion is
**met / not met / unverifiable** with evidence. Exactly one of `qa:approved` / `qa:rejected` goes on the story issue.

## 6. Merge
Only PRs whose story carries `qa:approved` (and no open blocking review finding) are merged into `main`.
`qa:rejected` sends the story back to the developer (max 3 rounds, then `needs-human`).

## Models
Fable — whole-system architecture reviews. Opus — code review (merge gate) and complex tasks only (schema, security, tenancy, concurrency, escalations). Sonnet — development, QA, ticket filing and chores.
